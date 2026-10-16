// End-to-end check of a two-stage tournament's screens in a real browser: the groups named on the
// Desk, "End group stage" and "Start final stage" in place of Finalize, who advances, what a
// player's Pass says once the group stage has ended, and the final stage as a bracket.
// Nothing here reaches Challonge: each phase is put in the database as a sync would leave it. The
// two steps themselves are covered by tests/integration/two-stage.test.ts. Same prerequisites as
// offline-pad.e2e.mjs:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/two-stage.e2e.mjs
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

// --- Six players in two round robin groups of three; the top two of each go to a bracket of four ---
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const tid = randomUUID();
const names = ["Jordan", "Riley", "Alex", "Sam", "Quinn", "Drew"];
const pid = (name) => String(1000 + names.indexOf(name));
// [group, letter, round, order, p1, p2], as Challonge lays out two groups: both have a match A with play order 1.
const groupPlan = [
  [1, "A", 1, 1, "Riley", "Alex"],
  [1, "B", 2, 2, "Jordan", "Riley"],
  [1, "C", 3, 3, "Alex", "Jordan"],
  [2, "A", 1, 1, "Quinn", "Drew"],
  [2, "B", 2, 2, "Sam", "Quinn"],
  [2, "C", 3, 3, "Drew", "Sam"],
];

await sql`insert into app.challonge_connections (id, organizer_id, client_id, client_secret_enc, status, challonge_username)
  values (${randomUUID()}, ${userId}, 'e2e-client', 'v1.x.x.x', 'credentials_saved', 'e2e')`;
await sql`insert into app.tournaments (id, organizer_id, challonge_id, challonge_url, name, state, tournament_type, group_stage, group_stage_type, group_size, participants_count, auto_call, auto_on_deck, last_synced_at)
  values (${tid}, ${userId}, '998', 'e2e_two_stage', 'Winter Groups', 'group_stages_underway', 'single elimination', true, 'round robin', 3, ${names.length}, false, false, now())`;
for (const [i, name] of names.entries()) {
  await sql`insert into app.participants (tournament_id, challonge_id, name, seed) values (${tid}, ${pid(name)}, ${name}, ${i + 1})`;
}
for (const [i, [group, letter, round, order, p1, p2]] of groupPlan.entries()) {
  await sql`insert into app.matches (tournament_id, challonge_id, identifier, round, suggested_play_order, stage, group_number, state, player1_challonge_id, player2_challonge_id)
    values (${tid}, ${String(5000 + i)}, ${letter}, ${round}, ${order}, 'group', ${group}, 'open', ${pid(p1)}, ${pid(p2)})`;
}
const [{ public_slug: slug }] = await sql`select public_slug from app.tournaments where id = ${tid}`;
const player = async (name) => (await sql`select * from app.participants where tournament_id = ${tid} and challonge_id = ${pid(name)}`)[0];

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const shot = async (target, name) => {
  if (SHOTS) await target.screenshot({ path: path.join(SHOTS, `two-stage-${name}.png`), fullPage: true });
};
const flat = (text) => text.replace(/\s+/g, " ");
const desk = async () => {
  await page.goto(`${BASE}/tournaments/${tid}`);
  await page.getByRole("heading", { name: "BXQ Desk" }).waitFor();
  return flat(await page.locator("main").first().innerText());
};
const endButton = page.getByRole("button", { name: "End group stage" });
const startButton = page.getByRole("button", { name: "Start final stage" });
const finalizeButton = page.getByRole("button", { name: "Finalize tournament" });

/** What a player sees on their Pass, opened with the secret in their QR code. */
async function pass(name) {
  const phone = await (await browser.newContext({ viewport: { width: 400, height: 800 } })).newPage();
  await phone.goto(`${BASE}/t/${slug}#k=${(await player(name)).sign_in_token}`);
  await phone.getByRole("button", { name: "Not you?" }).waitFor({ timeout: 20000 });
  const text = flat(await phone.locator("body").innerText());
  await shot(phone, `pass-${name.toLowerCase()}`);
  await phone.context().close();
  return text;
}

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments`);
  await page.waitForURL("**/tournaments");
  const listed = flat(await page.getByRole("link", { name: /Winter Groups/ }).innerText());
  check("the tournaments list says it has groups, and that they are being played", /Group stage/.test(listed) && /groups \+ single elimination/i.test(listed), listed);

  // --- The group stage ---
  let text = await desk();
  const queue = flat(await page.getByRole("region", { name: "Queue" }).innerText());
  check(
    "the queue names the group of every match and takes the groups in turn",
    queue.indexOf("Group A · Round 1") < queue.indexOf("Group B · Round 1") && queue.indexOf("Group B · Round 1") < queue.indexOf("Group A · Round 2") && queue.includes("Group B · Round 3"),
    queue.slice(0, 240),
  );
  check("no round of the groups is called a final", !/\bFinal\b/.test(queue));
  check("End group stage stands where Finalize would, and waits for the matches", (await endButton.isDisabled()) && (await finalizeButton.count()) === 0 && text !== "" && (await page.getByText("No match has been played yet.").count()) === 1);
  check("the Desk says a group result is one request", (await page.getByText("one request each").count()) === 1);
  await shot(page, "1-group-stage");

  await sql`update app.matches set state = 'complete', winner_challonge_id = player1_challonge_id, scores = '4 - 1' where tournament_id = ${tid} and identifier <> 'C'`;
  await desk();
  check("it counts the group matches still to play", (await endButton.isDisabled()) && (await page.getByText("2 matches still to play.").count()) === 1);

  await sql`update app.matches set state = 'complete', winner_challonge_id = player1_challonge_id, scores = '4 - 1' where tournament_id = ${tid}`;
  await desk();
  check("with every group match played, End group stage is ready", await endButton.isEnabled());
  await endButton.click();
  const asking = page.getByRole("alertdialog");
  const question = flat(await asking.innerText());
  check("it asks first, and says group results can't be corrected afterwards and what it costs", /End the group stage of Winter Groups\?/.test(question) && /group results can't be corrected/.test(question) && /Uses 2 Challonge requests/.test(question), question);
  await shot(page, "2-end-group-stage");
  await asking.getByRole("button", { name: "Not yet" }).click();
  check("Not yet closes it and changes nothing", (await page.getByRole("alertdialog").count()) === 0 && (await sql`select state from app.tournaments where id = ${tid}`)[0].state === "group_stages_underway");

  // --- Between the stages, as ending the group stage leaves it ---
  const advancing = ["Jordan", "Sam", "Riley", "Quinn"];
  await sql`update app.tournaments set state = 'group_stages_finalized', board_version = board_version + 1 where id = ${tid}`;
  for (const [i, name] of [...advancing, "Alex", "Drew"].entries()) {
    await sql`update app.participants set seed = ${i + 1}, advanced = ${advancing.includes(name)} where tournament_id = ${tid} and challonge_id = ${pid(name)}`;
  }
  text = await desk();
  const banner = flat(await page.getByRole("status").filter({ hasText: "The group stage has ended." }).innerText());
  check("the Desk lists who advances, in the order Challonge seeded them", banner.includes("Advancing to the final stage: Jordan, Sam, Riley, Quinn."), banner);
  check("Start final stage is the next step, and Finalize still isn't offered", (await startButton.isEnabled()) && (await endButton.count()) === 0 && (await finalizeButton.count()) === 0);
  await startButton.click();
  const starting = flat(await page.getByRole("alertdialog").innerText());
  check("it asks first, naming the players who advance", /Start the final stage of Winter Groups\?/.test(starting) && starting.includes("4 players advance: Jordan, Sam, Riley, Quinn.") && /Uses 2 Challonge requests/.test(starting), starting);
  await shot(page, "3-start-final-stage");
  await page.getByRole("alertdialog").getByRole("button", { name: "Not yet" }).click();

  const through = await pass("Riley");
  const out = await pass("Alex");
  check("a player who advanced is told so on their Pass", through.includes("You're through to the final stage."), through.slice(0, 200));
  check("a player who didn't is told so, keeps their results, and is no longer offered calls", out.includes("You didn't advance to the final stage.") && out.includes("Group A") && !out.includes("Get pinged") && through.includes("Get pinged"), out.slice(0, 260));
  await page.goto(`${BASE}/t/${slug}`);
  await page.getByRole("heading", { name: "Who are you?" }).waitFor();
  const picker = flat(await page.locator("body").innerText());
  check("everyone can still sign in to their Pass, advanced or not", names.every((name) => picker.includes(name)), picker.slice(0, 200));

  // --- The final stage, as starting it leaves it ---
  await sql`update app.tournaments set state = 'underway', started_at = now(), board_version = board_version + 1 where id = ${tid}`;
  const finalPlan = [["A", 1, 1, "open", "Jordan", "Quinn"], ["B", 1, 2, "open", "Sam", "Riley"], ["C", 2, 3, "pending", null, null]];
  for (const [i, [letter, round, order, state, p1, p2]] of finalPlan.entries()) {
    await sql`insert into app.matches (tournament_id, challonge_id, identifier, round, suggested_play_order, stage, state, player1_challonge_id, player2_challonge_id)
      values (${tid}, ${String(6000 + i)}, ${letter}, ${round}, ${order}, 'final', ${state}, ${p1 ? pid(p1) : null}, ${p2 ? pid(p2) : null})`;
  }
  text = await desk();
  const finalQueue = flat(await page.getByRole("region", { name: "Queue" }).innerText());
  check("the final stage reads as a bracket, without a group", /Round 1/.test(finalQueue) && !/Group/.test(finalQueue) && finalQueue.includes("Jordan vs Quinn"), finalQueue.slice(0, 200));
  check("Finalize is back, waiting for the final stage", (await finalizeButton.isDisabled()) && (await startButton.count()) === 0 && (await page.getByText("2 matches still to play.").count()) === 1);
  check("a result in the final stage costs two requests again", (await page.getByText("one request each").count()) === 0);
  await page.getByText(/^Completed/).click();
  const completed = flat(await page.locator("details").filter({ hasText: "Completed" }).innerText());
  check("the group results keep their group in the list of completed matches", completed.includes("Group A · Round 3") && completed.includes("Group B · Round 1"), completed.slice(0, 200));
  await shot(page, "4-final-stage");

  const knockedOut = await pass("Alex");
  check("a player who didn't advance still sees that during the final stage", knockedOut.includes("You didn't advance to the final stage."));
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
