// End-to-end check of light and dark mode in a real browser: the control room follows the theme
// switch, everything on it stays readable in both themes, the rule dropdowns work, and the venue
// screens stay dark. Same prerequisites as the other suites:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/theme.e2e.mjs
//
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

// --- A throwaway organizer ---
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

// --- A control room with something of every kind on it: a called match, requests waiting, rules ---
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const tid = randomUUID();
const names = ["Jordan", "Riley", "Alex", "Sam", "Quinn", "Drew"];
const pids = Object.fromEntries(names.map((name) => [name, randomUUID()]));
const pid = (name) => pids[name];
const stadiums = [1, 2].map((n) => ({ id: randomUUID(), name: `Stadium ${n}`, position: n }));
const profile = { name: "Club night", points: { spin: 1, over: 2, burst: 2, xtreme: 3 }, ownFinishPoints: null, targetPoints: 5, bestOfSets: 1, capAtTarget: false, launchErrorPenalty: null, finals: null };
// [letter, round, order, state, p1, p2, stadium index, call status]
const plan = [
  ["A", 1, 1, "open", "Jordan", "Riley", 0, "called"],
  ["B", 1, 2, "open", "Alex", "Sam", 0, "on_deck"],
  ["C", 1, 3, "open", "Quinn", "Drew", null, "none"],
  ["M", 2, 5, "pending", null, null, null, "none"],
  ["O", 3, 6, "pending", null, null, null, "none"],
];
const matchId = Object.fromEntries(plan.map(([letter]) => [letter, randomUUID()]));

const [{ id: profileId }] = await sql`insert into app.rule_profiles (organizer_id, name, config) values (${userId}, 'Club night', ${sql.json(profile)}) returning id`;
await sql`insert into app.tournaments (id, organizer_id, name, state, tournament_type, auto_call, auto_on_deck)
  values (${tid}, ${userId}, 'Theme Cup', 'underway', 'double_elimination', false, false)`;
for (const name of names) {
  await sql`insert into app.participants (id, tournament_id, name) values (${pid(name)}, ${tid}, ${name})`;
}
for (const s of stadiums) {
  await sql`insert into app.stadiums (id, tournament_id, name, position) values (${s.id}, ${tid}, ${s.name}, ${s.position})`;
}
await sql`insert into app.judge_screens (tournament_id, stadium_id, status, by_organizer, device, name, approved_at) values (${tid}, ${stadiums[0].id}, 'approved', true, 'You', 'You', now())`;
await sql`insert into app.judge_screens (tournament_id, stadium_id, status, device, name, pairing_code, token_hash) values (${tid}, ${stadiums[1].id}, 'pending', 'Safari on iPad', 'Maria', 'K7M2', ${randomUUID()})`;
await sql`insert into app.board_screens (tournament_id, pairing_code, token_hash, status, device) values (${tid}, 'X9PD', ${randomUUID()}, 'pending', 'Chrome on Windows')`;
for (const [letter, round, order, state, p1, p2, stadium, call] of plan) {
  await sql`insert into app.matches (id, tournament_id, key, number, round, play_order, state,
      player1_id, player2_id, stadium_id, call_status, called_at, call_count)
    values (${matchId[letter]}, ${tid}, ${"4" + order}, ${letter.charCodeAt(0) - 64}, ${round}, ${order}, ${state}, ${p1 ? pid(p1) : null}, ${p2 ? pid(p2) : null},
      ${stadium === null ? null : stadiums[stadium].id}, ${call}, ${call === "called" ? new Date(Date.now() - 120000) : null}, ${call === "called" ? 1 : 0})`;
}
const [{ public_slug: slug }] = await sql`select public_slug from app.tournaments where id = ${tid}`;
const tournament = async () => (await sql`select rule_preset_key, rule_profile_id from app.tournaments where id = ${tid}`)[0];

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", executablePath: process.env.E2E_EXECUTABLE, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
// A full-page capture resizes the page, which unsettles an open pop-up list: capture those as seen.
const shot = async (name, fullPage = true) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage }));
const card = (name) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });

/**
 * How readable an element's text is: the WCAG contrast ratio between its colour and the first
 * solid background behind it, plus that background's brightness (0 = black, 1 = white).
 */
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
      // Tints (a chip's 10% wash) don't decide readability; the solid surface under them does.
      if (colour.a >= 0.5) {
        background = colour;
        break;
      }
    }
    const text = luminance(parse(getComputedStyle(el).color));
    const behind = luminance(background);
    return { contrast: (Math.max(text, behind) + 0.05) / (Math.min(text, behind) + 0.05), surface: behind };
  });
const readable = async (locator) => (await legibility(locator)).contrast >= 4.5;
const brightness = async (locator) => (await legibility(locator)).surface;

const openMenu = async () => {
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).waitFor();
};
const setTheme = async (label) => {
  await openMenu();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: label }).click();
  await page.waitForFunction((theme) => document.documentElement.classList.contains(theme), label.toLowerCase());
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Navigation" }).waitFor({ state: "hidden" });
};

/** The things on the control room that use the accent or a finish colour as text. */
const accents = () => ({
  "Recall button": card("Stadium 1").getByRole("button", { name: "Recall players" }),
  "Wants to judge label": page.getByRole("region", { name: "Judges" }).getByText("Wants to judge"),
  "Wants access label": page.getByRole("region", { name: "BXQ Boards" }).getByText("Wants access").first(),
  // The link reads "Close" while the picker is open.
  "Rule profile Edit link": page.getByRole("region", { name: "Rule profile" }).getByRole("button", { name: /^(Edit|Close)$/ }),
  "Spin chip": page.getByRole("region", { name: "Rule profile" }).getByText(/^Spin \d/),
  "Over chip": page.getByRole("region", { name: "Rule profile" }).getByText(/^Over \d/),
  "Burst chip": page.getByRole("region", { name: "Rule profile" }).getByText(/^Burst \d/),
  "Xtreme chip": page.getByRole("region", { name: "Rule profile" }).getByText(/^Xtreme \d/),
  "Awaiting judge status": card("Stadium 2").getByText("Judge Asking for Approval"),
  "Called chip": card("Stadium 1").getByText("called", { exact: true }),
  "Short link": page.getByRole("region", { name: "BXQ Boards" }).getByRole("button", { name: /\/b\// }),
  "Card heading": card("Stadium 1").getByRole("heading", { name: "Stadium 1" }),
  "Muted detail text": card("Stadium 1").getByText(/Winners R1/).first(),
});
const unreadable = async () => {
  const failures = [];
  for (const [name, locator] of Object.entries(accents())) {
    const { contrast } = await legibility(locator);
    if (contrast < 4.5) failures.push(`${name} ${contrast.toFixed(1)}`);
  }
  return failures;
};

/** Opens the rule dropdown and reports on its list; leaves it open. */
const openRules = async () => {
  await page.getByRole("combobox", { name: "Use these rules" }).click();
  const list = page.getByRole("listbox");
  await list.waitFor();
  const options = list.getByRole("option");
  const texts = await options.allTextContents();
  let allReadable = true;
  for (const option of await options.all()) allReadable &&= await readable(option);
  for (const label of ["Presets", "Your profiles"]) allReadable &&= await readable(list.getByText(label, { exact: true }));
  // The list's own surface: the option under the pointer or focus is tinted.
  return { list, texts, allReadable, surface: await brightness(list) };
};

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments/${tid}`);
  await page.waitForURL(`**/tournaments/${tid}`);
  await page.getByRole("heading", { name: "BXQ Desk" }).waitFor();
  await page.getByRole("region", { name: "Judges" }).getByText("Wants to judge").waitFor();

  // ------------------------------------------------------------------------------------------
  // Dark (the default)
  // ------------------------------------------------------------------------------------------
  check("the control room starts dark", (await brightness(page.getByRole("heading", { name: "BXQ Desk" }))) < 0.05 && (await page.evaluate(() => document.documentElement.classList.contains("dark"))));
  const darkProblems = await unreadable();
  check("everything on it is readable in dark mode", darkProblems.length === 0, darkProblems.join(", "));
  await page.getByRole("region", { name: "Rule profile" }).getByRole("button", { name: "Edit" }).click();
  const darkRules = await openRules();
  check("the rule dropdown lists presets and your own profiles, readable on a dark list", darkRules.allReadable && darkRules.surface < 0.1 && ["First to 4", "First to 5", "First to 7", "Club night"].every((t) => darkRules.texts.includes(t)), darkRules.texts.join(" | "));
  await shot("theme-1-dark-dropdown", false);
  await page.keyboard.press("Escape");
  await darkRules.list.waitFor({ state: "hidden" });

  // ------------------------------------------------------------------------------------------
  // Light: the control room follows the switch
  // ------------------------------------------------------------------------------------------
  await setTheme("Light");
  check("choosing Light makes the control room light", (await brightness(page.getByRole("heading", { name: "BXQ Desk" }))) > 0.8 && (await brightness(card("Stadium 1").getByRole("heading", { name: "Stadium 1" }))) > 0.9);
  const lightProblems = await unreadable();
  check("everything on it is readable in light mode, including the accent text and finish chips", lightProblems.length === 0, lightProblems.join(", "));
  const recall = await legibility(card("Stadium 1").getByRole("button", { name: "Recall players" }));
  check("the lime accent turns dark green as text on white", recall.contrast >= 4.5 && recall.surface > 0.9, `contrast ${recall.contrast.toFixed(1)}`);
  check("filled lime buttons keep dark text on lime", await readable(page.getByRole("button", { name: /^Approve judge/ })));
  await shot("theme-2-light");

  // Menus and pop-up lists match the page.
  await page.getByRole("button", { name: "Stadium 1 actions" }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  check("the stadium menu is light too, and readable", (await brightness(menu.getByRole("menuitem").first())) > 0.9 && (await readable(menu.getByRole("menuitem", { name: "Hold", exact: true }))));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });

  const lightRules = await openRules();
  check("the rule dropdown is readable on a light list", lightRules.allReadable && lightRules.surface > 0.9, `surface ${lightRules.surface.toFixed(2)}`);
  await shot("theme-3-light-dropdown", false);

  // ------------------------------------------------------------------------------------------
  // The dropdown works
  // ------------------------------------------------------------------------------------------
  await lightRules.list.getByRole("option", { name: "First to 5" }).click();
  check("picking an option shows it in the field", (await page.getByRole("combobox", { name: "Use these rules" }).textContent()).includes("First to 5"));
  await page.getByRole("region", { name: "Rule profile" }).getByRole("button", { name: "Save" }).click();
  await page.getByText("Rules updated.").waitFor();
  check("saving a preset from the dropdown changes the tournament's rules", (await tournament()).rule_preset_key === "first-to-5" && (await tournament()).rule_profile_id === null);
  await page.getByRole("region", { name: "Rule profile" }).getByText("First to 5", { exact: true }).first().waitFor();

  await page.getByRole("combobox", { name: "Use these rules" }).click();
  await page.getByRole("listbox").getByRole("option", { name: "Club night" }).click();
  await page.getByRole("region", { name: "Rule profile" }).getByRole("button", { name: "Save" }).click();
  // The field already reads "Club night"; wait for the save itself.
  for (let i = 0; i < 40 && (await tournament()).rule_profile_id !== profileId; i++) await page.waitForTimeout(250);
  await page.getByRole("region", { name: "Rule profile" }).getByText("First to 5", { exact: true }).first().waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  check("saving one of your own profiles works too", (await tournament()).rule_profile_id === profileId && (await page.getByRole("region", { name: "Rule profile" }).textContent()).includes("Club night"));

  // Keyboard: open with Enter, move with the arrows, choose with Enter.
  const field = page.getByRole("combobox", { name: "Use these rules" });
  await field.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  check("the dropdown can be used from the keyboard", !(await field.textContent()).includes("Club night"), await field.textContent());

  // ------------------------------------------------------------------------------------------
  // Venue screens stay dark whatever the theme
  // ------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/tournaments/${tid}/matches/${matchId.A}`);
  await page.getByRole("heading", { name: "Battle log" }).waitFor();
  const padScheme = await page.getByRole("heading", { name: "Battle log" }).evaluate((el) => getComputedStyle(el).colorScheme);
  check("the judge pad stays dark in light mode, and tells the browser so", (await brightness(page.getByRole("heading", { name: "Battle log" }))) < 0.05 && padScheme === "dark", padScheme);
  const board = await context.newPage();
  await board.goto(`${BASE}/t/${slug}/board`);
  await board.getByLabel(/^Pairing code/).waitFor();
  check("the call board stays dark in light mode", (await legibility(board.getByRole("heading", { name: "BXQ Board" }))).surface < 0.05);
  await board.close();

  // ------------------------------------------------------------------------------------------
  // The rule profile form's dropdowns
  // ------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/rules/new?from=first-to-4`);
  await page.getByRole("heading", { name: "New rule profile" }).waitFor();
  const sets = page.getByRole("combobox", { name: "Sets" }).first();
  check("the form's Sets dropdown shows the current value", (await sets.textContent()).includes("Single set"));
  await sets.click();
  const setList = page.getByRole("listbox");
  await setList.waitFor();
  let setsReadable = true;
  for (const option of await setList.getByRole("option").all()) setsReadable &&= await readable(option);
  check("its list is readable in light mode", setsReadable && (await setList.getByRole("option").count()) === 4);
  await setList.getByRole("option", { name: "Best of 3 sets" }).click();
  await page.getByLabel("Profile name").fill("Theme test profile");
  await page.getByRole("button", { name: "Create profile" }).click();
  await page.waitForURL("**/rules");
  const [saved] = await sql`select config from app.rule_profiles where organizer_id = ${userId} and name = 'Theme test profile'`;
  check("the chosen number of sets is saved with the profile", saved?.config.bestOfSets === 3, JSON.stringify(saved?.config.bestOfSets));

  // ------------------------------------------------------------------------------------------
  // And back to dark
  // ------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/tournaments/${tid}`);
  await page.getByRole("heading", { name: "BXQ Desk" }).waitFor();
  check("the choice of theme is remembered between pages", (await brightness(page.getByRole("heading", { name: "BXQ Desk" }))) > 0.8);
  await setTheme("Dark");
  const backProblems = await unreadable();
  check("switching back to Dark makes the control room dark again, still readable", (await brightness(page.getByRole("heading", { name: "BXQ Desk" }))) < 0.05 && backProblems.length === 0, backProblems.join(", "));
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 900));
  await shot("theme-error").catch(() => {});
} finally {
  await browser.close();
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
