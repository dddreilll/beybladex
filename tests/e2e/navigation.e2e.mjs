// End-to-end check of the organizer layout and side navigation in a real browser.
// Same prerequisites as the other e2e suites (local Supabase + a production build on port 3100).
// Set E2E_SCREENSHOTS=<folder> to save screenshots.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const tid = randomUUID();
await sql`insert into app.tournaments (id, organizer_id, challonge_id, challonge_url, name, state, tournament_type)
  values (${tid}, ${userId}, '999', 'e2e_bracket', 'Nav Cup', 'underway', 'single elimination')`;

// A Challonge app with 46 requests used this month, so the budget meter has something to show.
const connectionId = randomUUID();
await sql`insert into app.challonge_connections (id, organizer_id, client_id, client_secret_enc, status)
  values (${connectionId}, ${userId}, 'e2e-client', 'v1.x.x.x', 'credentials_saved')`;
await sql`insert into app.api_usage (connection_id, month, count) values (${connectionId}, ${new Date().toISOString().slice(0, 7)}, 46)`;

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const shot = async (name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));
const menuButton = page.getByRole("button", { name: "Open navigation" });
const drawer = page.getByRole("dialog", { name: "Navigation" });
const openMenu = async () => {
  await menuButton.click();
  await drawer.waitFor();
};

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments`);
  await page.waitForURL("**/tournaments");
  await page.getByRole("heading", { name: "Tournaments", exact: true, level: 1 }).waitFor();

  // --- Layout: same header bar as the control room, no top navigation ---
  const headerBox = await page.locator("header").boundingBox();
  check("header bar spans the full width, like the control room's", headerBox.x === 0 && headerBox.width === 1440, `${headerBox.width}px`);
  check("there is no top navigation bar", (await page.getByRole("navigation", { name: "Main" }).count()) === 0 && (await page.getByRole("button", { name: "Sign out" }).count()) === 0);
  const menuBox = await menuButton.boundingBox();
  const titleBox = await page.getByRole("heading", { level: 1 }).boundingBox();
  check("menu button sits at the left of the header, before the title", menuBox.x < titleBox.x && menuBox.x < 40 && menuBox.width >= 44);
  check("the API budget is not in the page header", (await page.getByText("Challonge API budget").count()) === 0);
  check("side navigation is hidden by default", (await drawer.count()) === 0 && (await menuButton.getAttribute("aria-expanded")) === "false");
  await shot("nav-1-tournaments");

  // --- Opening and closing ---
  await openMenu();
  const links = await drawer.getByRole("link").allTextContents();
  check("it lists Tournaments, Rules and Challonge connection", ["Tournaments", "Rules", "Challonge connection"].every((l) => links.includes(l)), links.join(" | "));
  check("the current page is marked", (await drawer.getByRole("link", { name: "Tournaments" }).getAttribute("aria-current")) === "page" && (await drawer.getByRole("link", { name: "Rules" }).getAttribute("aria-current")) === null);
  const budget = drawer.getByRole("meter", { name: "Challonge API requests used this month" });
  check("it shows the Challonge API budget with the same meter as before", (await drawer.textContent()).includes("Challonge API budget") && (await drawer.textContent()).includes("46 / 500") && (await drawer.textContent()).includes("This month · counted by this app") && (await budget.getAttribute("aria-valuenow")) === "46");
  const budgetBox = await budget.boundingBox();
  const themeBox = await drawer.getByRole("button", { name: "Light" }).boundingBox();
  check("the budget sits above the theme switch and fits the panel", budgetBox.y < themeBox.y && budgetBox.x + budgetBox.width <= 288);
  check("it shows the account and Sign out", (await drawer.textContent()).includes(email) && (await drawer.getByRole("button", { name: "Sign out" }).count()) === 1);
  const drawerBox = await drawer.boundingBox();
  check("it opens from the left, over the page", drawerBox.x === 0 && drawerBox.height === 900 && drawerBox.width < 400);
  await shot("nav-2-open");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  check("Escape closes it and returns focus to the menu button", await menuButton.evaluate((el) => el === document.activeElement));

  await openMenu();
  await page.mouse.click(1000, 450);
  await drawer.waitFor({ state: "hidden" });
  check("clicking the dimmed page closes it", true);

  // --- Navigating ---
  await openMenu();
  await drawer.getByRole("link", { name: "Rules" }).click();
  await page.waitForURL("**/rules");
  await page.getByRole("heading", { name: "Rule profiles", level: 1 }).waitFor();
  check("picking a page navigates and closes the navigation", (await drawer.count()) === 0);
  await openMenu();
  check("the new page is now the marked one", (await drawer.getByRole("link", { name: "Rules" }).getAttribute("aria-current")) === "page");
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("heading", { name: "Rule profiles", level: 1 }).waitFor();
  check("it is hidden again after a reload", (await drawer.count()) === 0);

  // --- Sub-pages: same header, no return link; you go back through the navigation ---
  await page.goto(`${BASE}/rules/new?from=first-to-5`);
  check("a sub-page has the menu button and no return link in its header", (await menuButton.count()) === 1 && (await page.locator("header").getByRole("link").count()) === 0 && (await page.getByRole("heading", { name: "New rule profile", level: 1 }).count()) === 1);
  await openMenu();
  check("on a rule profile sub-page the navigation marks Rules", (await drawer.getByRole("link", { name: "Rules" }).getAttribute("aria-current")) === "page");
  await drawer.getByRole("link", { name: "Rules" }).click();
  await page.waitForURL("**/rules");
  check("the navigation is the way back to the rule profiles list", (await page.getByRole("heading", { name: "Rule profiles", level: 1 }).count()) === 1);
  await page.goto(`${BASE}/rules/new?from=first-to-5`);
  const formBox = await page.locator("main form").first().boundingBox();
  check("forms keep a readable width instead of stretching", formBox.width <= 680, `${Math.round(formBox.width)}px`);

  await page.goto(`${BASE}/settings/challonge`);
  check("Challonge connection uses the same header, without the budget", (await page.getByRole("heading", { name: "Challonge connection", level: 1 }).count()) === 1 && (await menuButton.count()) === 1 && (await page.getByText("Challonge API budget").count()) === 0);

  // --- Theme switch lives in the navigation ---
  await openMenu();
  await drawer.getByRole("button", { name: "Light" }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("light"));
  check("the theme switch is in the navigation and applies", (await drawer.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")) === "true");
  await page.keyboard.press("Escape");
  await shot("nav-3-light");
  await openMenu();
  await drawer.getByRole("button", { name: "Dark" }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await page.keyboard.press("Escape");

  // --- Control room ---
  await page.goto(`${BASE}/tournaments/${tid}`);
  await page.getByRole("heading", { name: "BXQ Desk" }).waitFor();
  const crMenu = await menuButton.boundingBox();
  check("control room has the menu button and no return link", crMenu.x < 40 && (await page.locator("header").getByRole("link").count()) === 0);
  if (SHOTS) await page.locator("header").screenshot({ path: path.join(SHOTS, "nav-5-control-header.png") });
  await openMenu();
  check("from the control room the navigation marks Tournaments", (await drawer.getByRole("link", { name: "Tournaments" }).getAttribute("aria-current")) === "page");
  await shot("nav-4-control-room");

  // --- Sign out from the navigation ---
  await drawer.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/auth/login");
  check("Sign out works from the navigation", true);
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 400));
  await shot("nav-error").catch(() => {});
} finally {
  await browser.close();
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
