// End-to-end check of setting a tournament up in a real browser: the New tournament form, the
// Desk's players and seeds before the start, starting it, dropping a player, and deleting it.
// Same prerequisites as offline-pad.e2e.mjs:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/setup.e2e.mjs
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";
import postgres from "postgres";

process.loadEnvFile(".env.local");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";

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

const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", executablePath: process.env.E2E_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const seeds = () => page.locator("section[aria-labelledby=setup-heading] ol li button[title=Rename]").allTextContents();

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments`);
  await page.waitForURL("**/tournaments");
  await page.getByText("No tournaments yet").waitFor();
  check("a new organizer has no tournaments", true);

  // --- The New tournament form ---
  await page.getByRole("link", { name: "New tournament" }).click();
  await page.waitForURL("**/tournaments/new");
  await page.getByLabel("Tournament name").fill("Spring Open");
  await page.getByLabel("Format").click();
  await page.getByRole("option", { name: "Single elimination" }).click();
  check("single elimination offers a third-place match", (await page.getByLabel("Third-place match").count()) === 1);
  check("and no grand final option", (await page.getByLabel("Grand final").count()) === 0);
  await page.getByLabel("Players, in seed order").fill("Alex, Sam\nRiley\nJordan");
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/new-tournament.png`, fullPage: true });
  check("the form counts the players as they are typed", (await page.getByText("4 players. The first is seed 1.").count()) === 1);
  await page.getByRole("button", { name: "Create tournament" }).click();
  await page.waitForURL(/\/tournaments\/[0-9a-f-]{36}$/);
  const tid = page.url().split("/").pop();
  await page.getByRole("heading", { name: "BXQ Desk" }).waitFor();
  check("creating opens the Desk, not started", (await page.getByRole("button", { name: "Start tournament" }).count()) === 1);
  check("the players are listed in seed order", (await seeds()).join() === "Alex,Sam,Riley,Jordan", (await seeds()).join());
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/setup-desk.png`, fullPage: true });

  // --- Players and seeds before the start ---
  await page.getByRole("button", { name: "Move Jordan up" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("section[aria-labelledby=setup-heading] ol li button[title=Rename]")].map((b) => b.textContent).join() === "Alex,Sam,Jordan,Riley");
  check("Move up swaps two seeds", true);
  await page.getByLabel("Add players").fill("Casey, Drew");
  await page.getByRole("button", { name: "Add 2 players" }).click();
  await page.getByText("2 players added.").waitFor();
  await page.getByRole("button", { name: "Remove Drew" }).click();
  await page.getByRole("button", { name: "Remove Drew" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Sam", exact: true }).click();
  await page.getByLabel("New name for Sam").fill("Samuel");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Samuel", exact: true }).waitFor();
  check("players can be added, removed and renamed", (await seeds()).join() === "Alex,Samuel,Jordan,Riley,Casey", (await seeds()).join());
  const dup = page.getByLabel("Add players");
  await dup.fill("alex");
  await page.getByRole("button", { name: "Add player" }).click();
  await page.getByText("alex is in the list twice.").waitFor();
  check("a name already in the list is refused", true);

  // --- Start ---
  await page.getByRole("button", { name: "Start tournament" }).click();
  const dialog = page.getByRole("alertdialog");
  check("Start asks first and says players are fixed after it", (await dialog.textContent()).includes("can't be added or reseeded"));
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("heading", { name: "Queue" }).waitFor();
  await page.getByRole("button", { name: "Finish tournament" }).waitFor();
  const matches = await sql`select number, state from app.matches where tournament_id = ${tid} order by play_order`;
  check("starting builds the bracket: 5 players, 4 matches", matches.length === 4, matches.map((m) => `${m.number}:${m.state}`).join());
  check("the setup panel is gone once started", (await page.getByRole("heading", { name: /Players and seeds/ }).count()) === 0);

  // --- The tabs and the bracket ---
  const tabs = page.getByRole("navigation", { name: "Desk sections" });
  const tabNames = (await tabs.getByRole("link").allTextContents()).map((t) => t.replace(/\d+$/, ""));
  check("under the stadiums, the Desk has tabs", tabNames.join() === "Queue,Players,Completed,Bracket", tabNames.join());
  check("the queue is open first", (await tabs.locator("a[aria-current=page]").textContent()).startsWith("Queue") && (await page.getByRole("heading", { name: "Queue" }).count()) === 1);
  check("only the open tab is shown", (await page.getByRole("heading", { name: /^Players and passcodes/ }).count()) === 0);
  const queueLabels = await page.locator("main table tbody tr td:first-child").allTextContents();
  check("matches are numbered M1, M2 … with no letters", queueLabels.length > 0 && queueLabels.every((l) => /^M\d+$/.test(l.trim())), queueLabels.join());
  await tabs.getByRole("link", { name: /^Bracket/ }).click();
  await page.waitForURL(`**/tournaments/${tid}?tab=bracket`);
  await page.getByRole("heading", { name: "Bracket", level: 2 }).waitFor();
  const columns = await page.locator("main h5").allTextContents();
  check("the Bracket tab shows every round as a column, ending with the final", columns.join() === "Round 1,Round 2,Final", columns.join());
  const cards = await page.locator("main a[aria-label^='Match ']").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  check("a match with both players opens its pad", cards.length === 2, cards.join(" | "));
  check("the stadiums stay on top while another tab is open", (await page.getByRole("heading", { name: "Stadiums" }).count()) === 1);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/bracket.png`, fullPage: true });
  await page.reload();
  check("a reload keeps the open tab", (await tabs.locator("a[aria-current=page]").textContent()).startsWith("Bracket"));
  await page.goto(`${BASE}/tournaments/${tid}/bracket`);
  await page.waitForURL(`**/tournaments/${tid}?tab=bracket`);
  check("the old bracket address opens the Bracket tab", true);

  // --- Drop a player ---
  await page.getByRole("navigation", { name: "Desk sections" }).getByRole("link", { name: /^Players/ }).click();
  await page.getByRole("heading", { name: /^Players and passcodes/ }).waitFor();
  await page.getByRole("button", { name: "Drop Casey" }).click();
  await page.getByRole("button", { name: "Drop: they forfeit" }).click();
  await page.getByText("Dropped. Their matches went to their opponents.").waitFor();
  const forfeits = await sql`select number from app.matches where tournament_id = ${tid} and forfeit`;
  check("dropping a player forfeits their open match", forfeits.length === 1, forfeits.map((m) => m.number).join());
  await page.getByRole("navigation", { name: "Desk sections" }).getByRole("link", { name: /^Completed/ }).click();
  await page.getByRole("heading", { name: /^Completed/ }).waitFor();
  check("the Desk shows the forfeit", (await page.getByText("won by forfeit").count()) === 1);
  await tabs.getByRole("link", { name: /^Bracket/ }).click();
  await page.getByRole("heading", { name: "Bracket", level: 2 }).waitFor();
  check("the bracket marks the forfeit", (await page.locator("main").getByText("Forfeit", { exact: true }).count()) === 1);

  // --- Delete, at the bottom of the Players tab ---
  await page.getByRole("navigation", { name: "Desk sections" }).getByRole("link", { name: /^Players/ }).click();
  await page.getByRole("heading", { name: /^Players and passcodes/ }).waitFor();
  await page.getByText("Delete tournament", { exact: true }).first().click();
  const deleteButton = page.getByRole("button", { name: "Delete tournament" });
  check("Delete waits for the tournament's name", await deleteButton.isDisabled());
  await page.getByLabel("Type Spring Open to confirm").fill("Spring Open");
  await deleteButton.click();
  await page.waitForURL("**/tournaments");
  await page.getByText("No tournaments yet").waitFor();
  check("deleting removes the tournament and goes back to the list", (await sql`select id from app.tournaments where id = ${tid}`).length === 0);
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 300));
} finally {
  await browser.close();
  await sql`delete from app.tournaments where organizer_id = ${userId}`;
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
