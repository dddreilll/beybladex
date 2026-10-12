// End-to-end check of the landing page in a real browser: what it says, that its animation plays
// and reads well in dark and light mode and on a phone, that Request Early Access follows
// EARLY_ACCESS_URL, that its preview image is public, and that a signed-in organizer still goes
// straight to their tournaments. Same prerequisites as the other suites:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/landing.e2e.mjs
//
// Set E2E_SCREENSHOTS=<folder> to save screenshots.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";
import postgres from "postgres";

process.loadEnvFile(".env.local");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// --- A throwaway organizer, for the signed-in redirect ---
const status = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const secret = status.match(/^SECRET_KEY="?([^"\r\n]+)/m)?.[1] ?? status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)/m)?.[1];
if (!secret) throw new Error("Couldn't read the local Supabase secret key. Is `npm run supabase:start` running?");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, secret, { auth: { persistSession: false } });
const email = `e2e+${Date.now()}@example.test`;
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, email_confirm: true });
if (createError) throw createError;
const userId = created.user.id;
const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
if (linkError) throw linkError;
const sql = postgres(process.env.DATABASE_URL, { prepare: false });

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// As in a browser nobody has clicked in yet: audio never starts. A headless browser allows it,
// which hides a player that waits for audio before it moves.
await context.addInitScript(() => {
  for (const Ctx of [window.AudioContext, window.webkitAudioContext].filter(Boolean)) {
    Ctx.prototype.resume = () => new Promise(() => {});
    Object.defineProperty(Ctx.prototype, "state", { get: () => "suspended" });
  }
});
const page = await context.newPage();
const shot = async (name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }));

/** The WCAG contrast ratio of an element's text, and the brightness of the solid surface behind it. */
const legibility = (locator) =>
  locator.evaluate((el) => {
    const parse = (value) => {
      const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
      return { r, g, b, a };
    };
    const luminance = ({ r, g, b }) => {
      const channel = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    let background = { r: 255, g: 255, b: 255, a: 1 };
    for (let node = el; node; node = node.parentElement) {
      const colour = parse(getComputedStyle(node).backgroundColor);
      if (colour.a >= 0.5) {
        background = colour;
        break;
      }
    }
    const text = luminance(parse(getComputedStyle(el).color));
    const behind = luminance(background);
    return { contrast: (Math.max(text, behind) + 0.05) / (Math.min(text, behind) + 0.05), surface: behind };
  });

/** One of each kind of text on the page outside the animation. */
const texts = () => ({
  Headline: page.getByRole("heading", { level: 1 }),
  "Hero text": page.getByText(/^Keep Challonge as your bracket engine/),
  "Access note": page.getByText(/^Open to everyone soon/).first(),
  "Request button": page.getByRole("main").getByText("Request Early Access").first(),
  "Sign-in link": page.getByRole("link", { name: "Organizer sign in" }),
  "Section label": page.getByText("Tournament day, two ways"),
  "Without heading": page.getByRole("heading", { name: "Without BXQ" }),
  "Without line": page.getByText(/^Names yelled into a megaphone/),
  "With line": page.getByText(/^Judges tap every finish/),
  "Step number": page.getByRole("heading", { name: /The judge taps the pad/ }).locator("span"),
  "Step text": page.getByText(/^Each finish is one tap/),
  "Offline text": page.getByText(/^Every tap is saved on the pad itself/),
  "Screen audience": page.getByText("For organizers"),
  Footer: page.getByText(/not affiliated with or endorsed by/),
});
const preview = page.getByRole("img", { name: /^A judge taps Burst on the pad/ });
const player = preview.locator(".__remotion-player");
/**
 * Follows the animation through its four scenes, in order, and measures a piece of text in each.
 * A scene lasts two seconds, so each wait is for the next one to come round.
 */
const watchScenes = async () => {
  await player.waitFor();
  const seen = [];
  const failures = [];
  for (const [scene, mark, samples] of [
    ["pad", "BXQ Pad · Stadium 2", ["Jordan", "Xtreme"]],
    ["Challonge", "Sent to Challonge", ["Sent to Challonge", "Riley"]],
    ["Pass", "You're up at Stadium 2", ["You're up at Stadium 2", "vs Sam · Winners R1. Head there now."]],
    ["board", "Now calling · Stadium 2", ["Now calling · Stadium 2", "In the hole"]],
  ]) {
    await player.getByText(mark, { exact: true }).waitFor({ timeout: 12000 });
    seen.push(scene);
    for (const sample of samples) {
      const { contrast } = await legibility(player.getByText(sample, { exact: true }));
      if (contrast < 4.5) failures.push(`${sample} ${contrast.toFixed(1)}`);
    }
  }
  return { seen, failures };
};
const unreadable = async () => {
  const failures = [];
  for (const [name, locator] of Object.entries(texts())) {
    const { contrast } = await legibility(locator);
    if (contrast < 4.5) failures.push(`${name} ${contrast.toFixed(1)}`);
  }
  return failures;
};
const brightness = async (locator) => (await legibility(locator)).surface;

try {
  // ------------------------------------------------------------------------------------------
  // Signed out: what the page says
  // ------------------------------------------------------------------------------------------
  await page.goto(BASE);
  await page.getByRole("heading", { level: 1 }).waitFor();
  const copy = await page.getByRole("main").innerText();
  check("the headline is the auto-pilot line", (await page.getByRole("heading", { level: 1 }).textContent()).replace(/\s+/g, " ") === "Run your Beyblade X tournament on auto-pilot.");
  check("it says access is limited to select communities for now", copy.includes("Open to everyone soon. For now, BXQ is running with select communities."));
  check("it compares a day without BXQ and with it", (await page.getByRole("heading", { name: "Without BXQ" }).count()) === 1 && (await page.getByRole("heading", { name: "With BXQ" }).count()) === 1 && copy.includes("megaphone") && copy.includes("paper slips"));
  const flow = page.getByRole("region", { name: "One tap, and everything moves." });
  const steps = await flow.getByRole("listitem").getByRole("heading").allTextContents();
  check("the flow runs pad, Challonge, phone, board", steps.join(" | ") === "1The judge taps the pad | 2Challonge updates | 3The next player gets the call | 4The board chimes", steps.join(" | "));
  check("it says the pad is offline-first", (await flow.getByRole("heading", { name: "Offline-First by Design" }).count()) === 1 && /scoring carries on when the venue Wi-Fi drops/.test(copy));
  const screens = await page.getByRole("region", { name: "One for everyone on the floor." }).getByRole("heading", { level: 3 }).allTextContents();
  check("the four screens carry their full names", screens.join(" | ") === "BXQ Desk | BXQ Board | BXQ Pad | BXQ Pass", screens.join(" | "));
  const faq = page.getByRole("region", { name: "Questions organizers ask." });
  const questions = await faq.locator("summary").allTextContents();
  check("the FAQ asks its six questions", questions.length === 6 && !questions.some((q) => /without judges/i.test(q)) && questions[0] === "Who can use BXQ right now?" && questions[1] === "Do I still need Challonge?" && questions[5] === "What player data does BXQ keep?", questions.join(" | "));
  const challongeAnswer = faq.locator("details").nth(1).locator("p");
  const closedAtFirst = !(await challongeAnswer.isVisible());
  await faq.getByText("Do I still need Challonge?").click();
  check("an answer stays closed until its question is clicked", closedAtFirst && (await challongeAnswer.isVisible()) && /Your bracket stays on Challonge/.test(await challongeAnswer.textContent()));
  check("the answer on player data links to the Privacy Policy", (await faq.locator("details").nth(5).getByRole("link", { name: "Privacy Policy", includeHidden: true }).getAttribute("href")) === "/privacy");
  // Closed answers aren't part of the visible text, so they are read separately.
  const everything = `${await page.locator("body").innerText()} ${await faq.evaluate((el) => el.textContent)}`;
  const stale = ["Stadium Control", "control room", "call board", "judge pad", "player page", "referee"].filter((name) => everything.toLowerCase().includes(name.toLowerCase()));
  check("none of the old names appear", stale.length === 0, stale.join(", "));
  check("it doesn't talk about quotas or price", !/500|quota|free tier|pricing|\bAPI\b/i.test(everything));
  check("it says it isn't affiliated with Takara Tomy or Challonge", /not affiliated with or endorsed by Takara Tomy or Challonge/.test(everything));

  // ------------------------------------------------------------------------------------------
  // Terms of Service and Privacy Policy: linked from the footer, open to anyone
  // ------------------------------------------------------------------------------------------
  const legalLinks = await page.getByRole("contentinfo").getByRole("navigation", { name: "Legal" }).getByRole("link").evaluateAll((els) => els.map((el) => `${el.textContent} ${el.getAttribute("href")}`));
  check("the footer links to the terms and the privacy policy", legalLinks.join(" | ") === "Terms of Service /terms | Privacy Policy /privacy", legalLinks.join(" | "));
  // With a name set, both pages say who runs the site; without one, they speak of "the operator of this site".
  const operatorName = process.env.OPERATOR_NAME?.trim();
  const runBy = operatorName ? `site is run by ${operatorName}` : "the operator of this site";
  const contact = process.env.CONTACT_EMAIL?.trim();
  const legal = await context.newPage();
  for (const [route, title, phrases] of [
    ["/terms", "Terms of Service", ["governed by the laws of the Republic of the Philippines", "not affiliated with or endorsed by Takara Tomy or Challonge", runBy]],
    ["/privacy", "Privacy Policy", ["Data Privacy Act of 2012", "Many players are children", "stored encrypted", runBy]],
  ]) {
    await legal.goto(`${BASE}${route}`);
    const text = (await legal.getByRole("main").innerText()).replace(/\s+/g, " ");
    const missing = phrases.filter((phrase) => !text.includes(phrase));
    check(`${route} opens without signing in and says what it should`, new URL(legal.url()).pathname === route && (await legal.getByRole("heading", { level: 1, name: title }).count()) === 1 && missing.length === 0, missing.join(" | "));
    const oldNames = ["Stadium Control", "control room", "call board", "judge pad", "player page", "referee"].filter((name) => text.toLowerCase().includes(name.toLowerCase()));
    const contactLink = legal.getByRole("main").getByRole("link", { name: contact ?? "no contact set" });
    check(`${route} uses the current names, and gives this deployment's contact when it has one`, oldNames.length === 0 && (contact ? (await contactLink.getAttribute("href")) === `mailto:${contact}` : (await legal.getByRole("main").locator('a[href^="mailto:"]').count()) === 0), oldNames.join(", "));
  }
  await legal.getByRole("link", { name: "BXQ", exact: true }).click();
  await legal.waitForURL(`${BASE}/`);
  check("the app name on a legal page leads back home", true);
  await legal.close();

  // ------------------------------------------------------------------------------------------
  // Asking for access: a link out when this deployment has one, a disabled button when it doesn't
  // ------------------------------------------------------------------------------------------
  const requestUrl = process.env.EARLY_ACCESS_URL?.trim();
  if (requestUrl) {
    const links = page.getByRole("link", { name: "Request Early Access" });
    const hrefs = await links.evaluateAll((els) => els.map((el) => `${el.href} ${el.target} ${el.rel}`));
    check("Request Early Access opens this deployment's link in a new tab, in the hero and at the end", hrefs.length === 2 && hrefs.every((h) => h === `${new URL(requestUrl)} _blank noopener noreferrer`), hrefs.join(" | "));
  } else {
    const buttons = page.getByRole("button", { name: "Request Early Access" });
    check("with no link set, Request Early Access is disabled in the hero and at the end", (await buttons.count()) === 2 && (await buttons.first().isDisabled()) && (await buttons.last().isDisabled()) && (await page.getByRole("link", { name: "Request Early Access" }).count()) === 0);
  }
  check("Organizer sign in is a single quiet link in the header", (await page.getByRole("link", { name: "Organizer sign in" }).count()) === 1 && (await page.getByRole("banner").getByRole("link", { name: "Organizer sign in" }).count()) === 1);

  // ------------------------------------------------------------------------------------------
  // The animation, dark (the default) then light
  // ------------------------------------------------------------------------------------------
  check("the page starts dark", (await brightness(page.getByRole("heading", { level: 1 }))) < 0.05);
  const darkProblems = await unreadable();
  check("everything on it is readable in dark mode", darkProblems.length === 0, darkProblems.join(", "));
  await page.reload();
  await player.waitFor();
  await page.waitForTimeout(600);
  const firstScene = Number(await player.locator(".rounded-3xl").first().evaluate((el) => getComputedStyle(el).opacity));
  check("the animation starts at once, without waiting for sound", firstScene > 0.9, `first scene at ${firstScene.toFixed(2)} opacity after 0.6s`);
  const darkScenes = await watchScenes();
  check("the animation plays pad, Challonge, Pass, board", darkScenes.seen.join(" ") === "pad Challonge Pass board", darkScenes.seen.join(" "));
  check("its scenes are readable in dark mode", darkScenes.failures.length === 0, darkScenes.failures.join(", "));
  await player.getByText("BXQ Pad · Stadium 2", { exact: true }).waitFor({ timeout: 12000 });
  check("it loops back to the pad", true);
  check("it is one image to a screen reader, with its contents hidden", (await player.evaluate((el) => Boolean(el.querySelector("[aria-hidden='true']")))) && (await preview.count()) === 1);
  const previewBox = await preview.boundingBox();
  const h1Box = await page.getByRole("heading", { level: 1 }).boundingBox();
  check("on a desktop it sits beside the headline", previewBox.x > h1Box.x + h1Box.width - 1 && previewBox.y < h1Box.y + h1Box.height, `${Math.round(previewBox.x)},${Math.round(previewBox.y)}`);
  await shot("landing-1-dark");

  await page.evaluate(() => localStorage.setItem("theme", "light"));
  await page.reload();
  await page.waitForFunction(() => document.documentElement.classList.contains("light"));
  check("it follows the light theme", (await brightness(page.getByRole("heading", { level: 1 }))) > 0.8);
  const lightProblems = await unreadable();
  check("everything on it is readable in light mode", lightProblems.length === 0, lightProblems.join(", "));
  const lightScenes = await watchScenes();
  check("the animation's scenes are readable in light mode", lightScenes.seen.length === 4 && lightScenes.failures.length === 0, lightScenes.failures.join(", "));
  check("its board stays dark, like the real one", (await brightness(player.getByText("In the hole", { exact: true }))) < 0.05);
  await shot("landing-2-light");

  // ------------------------------------------------------------------------------------------
  // Reduced motion: a still instead of the player
  // ------------------------------------------------------------------------------------------
  const calm = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const calmPage = await calm.newPage();
  await calmPage.goto(BASE);
  await calmPage.getByRole("heading", { level: 1 }).waitFor();
  await calmPage.waitForTimeout(1500);
  const still = calmPage.getByRole("img", { name: /^A judge taps Burst on the pad/ });
  check("with reduced motion there is a still of the board and no player", (await still.locator(".__remotion-player").count()) === 0 && (await still.getByText("Now calling · Stadium 2").count()) === 1);
  const stillBox = await still.getByText("Casey vs Robin").boundingBox();
  const stillFrame = await still.boundingBox();
  check("the still fits its frame", stillBox.x + stillBox.width < stillFrame.x + stillFrame.width && stillBox.y + stillBox.height < stillFrame.y + stillFrame.height);
  if (SHOTS) await still.screenshot({ path: path.join(SHOTS, "landing-4-still.png") });
  await calm.close();
  await page.evaluate(() => localStorage.setItem("theme", "dark"));

  // ------------------------------------------------------------------------------------------
  // On a phone
  // ------------------------------------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("heading", { level: 1 }).waitFor();
  await player.waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("nothing scrolls sideways on a phone", overflow === 0, `${overflow}px`);
  const buttonBox = await page.getByRole("main").getByText("Request Early Access").first().boundingBox();
  check("Request Early Access is on the first screen of a phone", buttonBox.y + buttonBox.height < 844, `${Math.round(buttonBox.y)}px down`);
  const phonePreview = await preview.boundingBox();
  check("the animation sits under the copy and fits the screen", phonePreview.y > buttonBox.y + buttonBox.height && phonePreview.x >= 0 && phonePreview.x + phonePreview.width <= 390, `${Math.round(phonePreview.width)}px wide`);
  await player.getByText("Sent to Challonge", { exact: true }).waitFor({ timeout: 12000 });
  await shot("landing-3-phone");
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ------------------------------------------------------------------------------------------
  // The share preview
  // ------------------------------------------------------------------------------------------
  const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => null);
  check("the page names a preview image and title for shared links", Boolean(ogImage) && Boolean(ogTitle), `${ogTitle} · ${ogImage}`);
  const image = await context.request.get(new URL(new URL(ogImage).pathname + new URL(ogImage).search, BASE).toString(), { maxRedirects: 0 });
  check("the preview image is served without signing in", image.status() === 200 && image.headers()["content-type"] === "image/png", `${image.status()} ${image.headers()["content-type"]}`);

  // ------------------------------------------------------------------------------------------
  // Signing in
  // ------------------------------------------------------------------------------------------
  await page.getByRole("link", { name: "Organizer sign in" }).click();
  await page.waitForURL("**/auth/login");
  check("the header link leads to organizer sign-in", true);
  const agreement = page.getByText(/^By continuing, you agree to our/);
  const agreed = await agreement.getByRole("link").evaluateAll((els) => els.map((el) => `${el.textContent} ${el.getAttribute("href")} ${el.target}`));
  check("under the sign-in card, continuing means agreeing to the terms and the privacy policy", agreed.join(" | ") === "Terms of Service /terms _blank | Privacy Policy /privacy _blank" && (await legibility(agreement)).contrast >= 4.5, agreed.join(" | "));

  // ------------------------------------------------------------------------------------------
  // Signed in: the same page, with buttons that lead to the organizer's tournaments
  // ------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments`);
  await page.waitForURL("**/tournaments");
  await page.goto(BASE);
  await page.getByRole("heading", { level: 1 }).waitFor();
  check("a signed-in organizer can open the landing page", new URL(page.url()).pathname === "/" && (await page.getByRole("heading", { level: 1 }).textContent()).replace(/\s+/g, " ") === "Run your Beyblade X tournament on auto-pilot.");
  const dashboard = await page.getByRole("link", { name: "Go to Dashboard" }).evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  check("for them the header, hero and closing buttons read Go to Dashboard", dashboard.join(" ") === "/tournaments /tournaments /tournaments" && (await page.getByRole("banner").getByRole("link", { name: "Go to Dashboard" }).count()) === 1, dashboard.join(" "));
  check("and there is no sign-in link, access request or access note", (await page.getByRole("link", { name: "Organizer sign in" }).count()) === 0 && (await page.getByRole("button", { name: "Request Early Access" }).count()) === 0 && (await page.getByRole("link", { name: "Request Early Access" }).count()) === 0 &&(await page.getByText(/^Open to everyone soon/).count()) === 0);
  await shot("landing-5-signed-in");
  await page.getByRole("banner").getByRole("link", { name: "Go to Dashboard" }).click();
  await page.waitForURL("**/tournaments");
  await page.getByRole("heading", { name: "Tournaments", exact: true, level: 1 }).waitFor();
  check("Go to Dashboard opens their tournaments", true);
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 900));
  await shot("landing-error").catch(() => {});
} finally {
  await browser.close();
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
