// End-to-end check of the battle-by-battle scores in a real browser: the control room's
// "View battles" dialog on finished matches, and "Your matches" on the player page.
// Same prerequisites as the other e2e suites:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/battle-scores.e2e.mjs
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

// --- Three finished matches (scored here, with no battles, best of 3) and one in progress ---
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const tid = randomUUID();
const names = ["Jordan", "Riley", "Alex", "Sam", "Casey", "Morgan"];
const pids = Object.fromEntries(names.map((name) => [name, randomUUID()]));
const pid = (name) => pids[name];
const stadiumId = randomUUID();
const rules = { points: { spin: 1, over: 2, burst: 2, xtreme: 3 }, ownFinishPoints: null, targetPoints: 4, bestOfSets: 1, capAtTarget: false, launchErrorPenalty: { strikes: 2, points: 1 }, profileName: "First to 4" };
// [letter, round, order, state, p1, p2, winner, scores, rules, call status]
const plan = [
  ["Z", 1, 1, "complete", "Jordan", "Riley", "Jordan", "4-3", rules, "none"],
  ["Y", 1, 2, "complete", "Alex", "Sam", "Sam", "1-4", null, "none"],
  ["X", -1, 3, "complete", "Casey", "Morgan", "Casey", "4-0,5-0", { ...rules, bestOfSets: 3 }, "none"],
  ["A", 2, 4, "open", "Jordan", "Sam", null, null, rules, "playing"],
  ["M", 3, 6, "pending", null, null, null, null, null, "none"],
  ["O", 4, 8, "pending", null, null, null, null, null, "none"],
  ["P", 5, 9, "pending", null, null, null, null, null, "none"],
  ["V", -2, 7, "pending", null, null, null, null, null, "none"],
];
const matchId = Object.fromEntries(plan.map(([letter]) => [letter, randomUUID()]));

await sql`insert into app.tournaments (id, organizer_id, name, state, tournament_type, auto_call, auto_on_deck)
  values (${tid}, ${userId}, 'Spring Open', 'underway', 'double_elimination', false, false)`;
for (const name of names) {
  await sql`insert into app.participants (id, tournament_id, name) values (${pid(name)}, ${tid}, ${name})`;
}
await sql`insert into app.stadiums (id, tournament_id, name, position) values (${stadiumId}, ${tid}, 'Stadium 1', 1)`;
for (const [letter, round, order, state, p1, p2, winner, scores, snapshot, call] of plan) {
  // A negative round is one of the losers bracket.
  await sql`insert into app.matches (id, tournament_id, key, identifier, round, section, play_order, state,
      player1_id, player2_id, winner_id, scores, stadium_id, call_status, called_at, call_count, rule_snapshot)
    values (${matchId[letter]}, ${tid}, ${letter}, ${letter}, ${Math.abs(round)}, ${round < 0 ? "losers" : null}, ${order}, ${state}, ${p1 ? pid(p1) : null}, ${p2 ? pid(p2) : null},
      ${winner ? pid(winner) : null}, ${scores}, ${call === "none" ? null : stadiumId}, ${call}, ${call === "none" ? null : new Date()},
      ${call === "none" ? 0 : 1}, ${snapshot ? sql.json(snapshot) : null})`;
}
// Battles are read in the order they were recorded, so insert them one at a time.
const battle = (letter, kind, side, voidReason = null) =>
  sql`insert into app.battles (match_id, op_id, kind, side, created_by, voided_at, void_reason)
    values (${matchId[letter]}, ${randomUUID()}, ${kind}, ${side}, ${userId}, ${voidReason ? new Date() : null}, ${voidReason})`;
await battle("Z", "over", 1);
await battle("Z", "xtreme", 2);
await battle("Z", "burst", 2, "undo"); // the judge's mis-tap
await battle("Z", "draw", null);
await battle("Z", "launch_error", 2);
await battle("Z", "spin", 1);
await battle("Z", "spin", 1); // Jordan 4–3 Riley
for (const kind of ["xtreme", "spin", "xtreme", "over"]) await battle("X", kind, 1); // Casey 4–0, 5–0
await battle("A", "xtreme", 1); // in progress: Jordan 3–0 Sam

const [{ public_slug: slug }] = await sql`select public_slug from app.tournaments where id = ${tid}`;
const token = async (name) => (await sql`select sign_in_token from app.participants where tournament_id = ${tid} and id = ${pid(name)}`)[0].sign_in_token;

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", executablePath: process.env.E2E_EXECUTABLE, headless: true });
const organizer = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const phoneSize = { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true };
const jordanPhone = await browser.newContext(phoneSize);
const rileyPhone = await browser.newContext(phoneSize);
const page = await organizer.newPage();
const shot = async (target, name) => SHOTS && (await target.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }));
/** What a row or dialog reads as, on one line. */
const reading = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
const battleLines = async (scope) => Promise.all((await scope.getByRole("listitem").all()).map(reading));

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments/${tid}`);
  await page.waitForURL(`**/tournaments/${tid}`);
  await page.getByRole("heading", { name: "BXQ Desk" }).waitFor();

  // ------------------------------------------------------------------------------------------
  // Control room
  // ------------------------------------------------------------------------------------------
  await page.getByText("Completed").click();
  const viewButtons = page.getByRole("button", { name: /^View battles of/ });
  await viewButtons.first().waitFor();
  check("every finished match offers View battles, and only finished ones", (await viewButtons.count()) === 3 && (await page.getByRole("button", { name: /View battles of .*Jordan vs Sam/ }).count()) === 0);

  await page.getByRole("button", { name: /View battles of .*Jordan vs Riley/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("list").waitFor();
  const header = await reading(dialog.locator("div").first());
  check("the dialog names the match, the round and the result", header.includes("Jordan vs Riley") && header.includes("Winners R1") && header.includes("Jordan won 4–3"), header.slice(0, 80));
  const lines = await battleLines(dialog);
  check(
    "it lists each battle with finish, points and the running score",
    JSON.stringify(lines) ===
      JSON.stringify(["B1 Jordan Over +2 2–0", "B2 Riley Xtreme +3 2–3", "B3 Draw · replayed 2–3", "B4 Riley Launch error Strike 1 of 2 2–3", "B5 Jordan Spin +1 3–3", "B6 Jordan Spin +1 4–3"]),
    lines.join(" | "),
  );
  check("undone battles are hidden until asked for", !(await reading(dialog)).includes("Burst"));
  await shot(page, "1-dialog");

  const voidSwitch = dialog.getByRole("switch", { name: /Show undone battles \(1\)/ });
  await voidSwitch.check();
  const withUndone = await battleLines(dialog);
  check("the switch shows the undone battle in place, struck through, with the reason", withUndone.length === 7 && withUndone[2] === "— Riley Burst Undone by the judge" && (await dialog.locator("s").count()) === 1, withUndone[2]);
  check("an undone battle doesn't change the numbering or the score", withUndone[1] === "B2 Riley Xtreme +3 2–3" && withUndone[3] === "B3 Draw · replayed 2–3");
  await shot(page, "2-dialog-undone");

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  check("Escape closes the dialog", (await page.getByRole("dialog").count()) === 0);

  await page.getByRole("button", { name: /View battles of .*Alex vs Sam/ }).click();
  await dialog.getByText("No battle record for this match.").waitFor();
  const noRecord = await reading(dialog);
  check("a result without battles shows its total and says there is no record", noRecord.includes("Sam won 1–4") && (await dialog.getByRole("list").count()) === 0 && (await dialog.getByRole("switch").count()) === 0, noRecord.slice(0, 90));
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: /View battles of .*Casey vs Morgan/ }).click();
  await dialog.getByRole("list").waitFor();
  const sets = await battleLines(dialog);
  check(
    "a multi-set match is grouped by set, each with its score",
    JSON.stringify(sets) === JSON.stringify(["SET 1 4–0", "B1 Casey Xtreme +3 3–0", "B2 Casey Spin +1 4–0", "SET 2 5–0", "B3 Casey Xtreme +3 3–0", "B4 Casey Over +2 5–0"]) && (await reading(dialog)).includes("Casey won 2–0"),
    sets.join(" | "),
  );
  await shot(page, "3-dialog-sets");
  await dialog.getByRole("button", { name: "Close" }).click();

  // ------------------------------------------------------------------------------------------
  // Player page
  // ------------------------------------------------------------------------------------------
  const stranger = await rileyPhone.newPage();
  check("the battle scores need a signed-in player", (await stranger.request.get(`${BASE}/api/public/${slug}/me/matches`)).status() === 401);

  const jordan = await jordanPhone.newPage();
  await jordan.goto(`${BASE}/t/${slug}#k=${await token("Jordan")}`);
  await jordan.getByRole("heading", { name: "Your matches" }).waitFor();
  const own = jordan.getByRole("region", { name: "Your matches" });
  const rows = own.locator("details");
  check("a player sees their finished matches only, not the one in progress", (await rows.count()) === 1 && (await reading(rows.first().locator("summary"))) === "Won 4–3 vs Riley Winners R1", await reading(rows.first().locator("summary")));
  check("the match in progress still shows only its live score", (await reading(jordan.locator("main"))).includes("vs Sam · 3–0"));
  check("battles stay folded until the player opens the match", !(await rows.first().getByRole("list").isVisible()));

  await rows.first().locator("summary").click();
  const ownLines = await battleLines(rows.first());
  check("opening it shows the same battle-by-battle score", ownLines.length === 6 && ownLines[1] === "B2 Riley Xtreme +3 2–3" && ownLines[5] === "B6 Jordan Spin +1 4–3" && (await reading(rows.first())).includes("Scores read Jordan–Riley."), ownLines.join(" | "));
  await shot(jordan, "4-player");

  await jordan.reload();
  await jordan.getByRole("heading", { name: "Your matches" }).waitFor();
  const sent = await jordan.content();
  check("undone battles and other players' matches are never sent to the phone", !sent.includes("Burst") && !sent.includes("Undone") && !["Alex", "Casey", "Morgan"].some((n) => sent.includes(n)));
  const feed = await (await jordan.request.get(`${BASE}/api/public/${slug}/me/matches`)).text();
  check("the feed carries only that player's finished matches", feed.includes("Riley") && !feed.includes("Burst") && !["Alex", "Casey", "Morgan", "voided"].some((n) => feed.includes(n)));

  const riley = await rileyPhone.newPage();
  await riley.goto(`${BASE}/t/${slug}#k=${await token("Riley")}`);
  await riley.getByRole("heading", { name: "Your matches" }).waitFor();
  check("the loser reads the same match from their side", (await reading(riley.locator("details summary").first())) === "Lost 3–4 vs Jordan Winners R1");
  await riley.close();

  // The match in progress finishes: the list grows by itself.
  await battle("A", "spin", 1);
  await sql`update app.matches set state = 'complete', scores = '4-0', winner_id = ${pid("Jordan")}, call_status = 'none', stadium_id = null where id = ${matchId.A}`;
  await sql`update app.tournaments set board_version = board_version + 1 where id = ${tid}`;
  await rows.nth(1).waitFor({ timeout: 25000 });
  check("a newly finished match appears on the player's page by itself, latest first", (await reading(rows.first().locator("summary"))) === "Won 4–0 vs Sam Winners R2", await reading(rows.first().locator("summary")));
  await rows.first().locator("summary").click();
  const fresh = await battleLines(rows.first());
  check("with its battles", JSON.stringify(fresh) === JSON.stringify(["B1 Jordan Xtreme +3 3–0", "B2 Jordan Spin +1 4–0"]), fresh.join(" | "));

  // Scanning another player's slip on this phone switches the whole page to that player.
  await jordan.goto(`${BASE}/t/${slug}#k=${await token("Riley")}`);
  await jordan.getByRole("heading", { name: "Hi, Riley" }).waitFor({ timeout: 15000 });
  const switched = await Promise.all((await jordan.locator("details summary").all()).map(reading));
  check("switching player on one phone replaces the status and the matches", JSON.stringify(switched) === JSON.stringify(["Lost 3–4 vs Jordan Winners R1"]) && !(await reading(jordan.locator("main"))).includes("vs Sam"), switched.join(" | "));

  // And in the control room, without a reload by hand.
  await page.getByRole("button", { name: /View battles of .*Jordan vs Sam/ }).waitFor({ timeout: 15000 });
  check("the control room offers it too once it is finished", (await viewButtons.count()) === 4);
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 400));
  await shot(page, "error").catch(() => {});
} finally {
  await browser.close();
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
