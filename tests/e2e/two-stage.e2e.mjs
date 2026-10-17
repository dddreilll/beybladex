// End-to-end check of a two-stage tournament's screens in a real browser: the groups named on the
// Desk, "End group stage" and "Start final stage" in place of Finish, who goes through, what a
// player's Pass says once the group stage has ended, the final stage as a bracket, and the
// groups' standings on the Desk and, taking turns with "In the hole", on the board.
// The group results are written to the database; the two steps are taken on the Desk. Same
// prerequisites as offline-pad.e2e.mjs:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/two-stage.e2e.mjs
//
// Set E2E_SCREENSHOTS=<folder> to save screenshots.
import { execSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const pids = Object.fromEntries(names.map((name) => [name, randomUUID()]));
const pid = (name) => pids[name];
// [group, letter, round, order, p1, p2]: the round robins of two groups of three, as starting the tournament lays them out.
const groupPlan = [
  [1, "A", 1, 1, "Riley", "Alex"],
  [1, "B", 2, 2, "Jordan", "Riley"],
  [1, "C", 3, 3, "Alex", "Jordan"],
  [2, "A", 1, 1, "Quinn", "Drew"],
  [2, "B", 2, 2, "Sam", "Quinn"],
  [2, "C", 3, 3, "Drew", "Sam"],
];

await sql`insert into app.tournaments (id, organizer_id, name, state, tournament_type, group_stage, group_stage_type, group_count, advance_per_group, auto_call, auto_on_deck)
  values (${tid}, ${userId}, 'Winter Groups', 'group_stage', 'single_elimination', true, 'round_robin', 2, 2, false, false)`;
const groupOf = { Jordan: 1, Riley: 1, Alex: 1, Sam: 2, Quinn: 2, Drew: 2 };
for (const [i, name] of names.entries()) {
  await sql`insert into app.participants (id, tournament_id, name, seed, group_number) values (${pid(name)}, ${tid}, ${name}, ${i + 1}, ${groupOf[name]})`;
}
for (const [group, letter, round, order, p1, p2] of groupPlan) {
  await sql`insert into app.matches (tournament_id, key, identifier, round, play_order, stage, group_number, state, player1_id, player2_id)
    values (${tid}, ${`G${group}:R${round}-1`}, ${letter}, ${round}, ${order}, 'group', ${group}, 'open', ${pid(p1)}, ${pid(p2)})`;
}
const [{ public_slug: slug }] = await sql`select public_slug from app.tournaments where id = ${tid}`;
const player = async (name) => (await sql`select * from app.participants where tournament_id = ${tid} and id = ${pid(name)}`)[0];

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", executablePath: process.env.E2E_EXECUTABLE, headless: true });
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
const finalizeButton = page.getByRole("button", { name: "Finish tournament" });

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
  check("the tournaments list says it has groups, and that they are being played", /Group stage/.test(listed) && /Round robin groups, then single elimination/.test(listed), listed);

  // --- The group stage ---
  let text = await desk();
  const queue = flat(await page.getByRole("region", { name: "Queue" }).innerText());
  check(
    "the queue names the group of every match and takes the groups in turn",
    queue.indexOf("Group A · Round 1") < queue.indexOf("Group B · Round 1") && queue.indexOf("Group B · Round 1") < queue.indexOf("Group A · Round 2") && queue.includes("Group B · Round 3"),
    queue.slice(0, 240),
  );
  check("no round of the groups is called a final", !/\bFinal\b/.test(queue));
  check("End group stage stands where Finish would, and waits for the matches", (await endButton.isDisabled()) && (await finalizeButton.count()) === 0 && text !== "" && (await page.getByText("No match has been played yet.").count()) === 1);
  await shot(page, "1-group-stage");

  await sql`update app.matches set state = 'complete', winner_id = player1_id, scores = '4-1' where tournament_id = ${tid} and identifier <> 'C'`;
  await desk();
  check("it counts the group matches still to play", (await endButton.isDisabled()) && (await page.getByText("2 matches still to play.").count()) === 1);

  await sql`update app.matches set state = 'complete', winner_id = player1_id, scores = '4-1' where tournament_id = ${tid}`;
  await desk();
  check("with every group match played, End group stage is ready", await endButton.isEnabled());
  // The first player won every match, which leaves each group three-way tied at 1-1, on the same
  // Buchholz, head-to-head and points: the seeds decide.
  const standings = flat(await page.getByRole("region", { name: "Standings" }).innerText());
  check(
    "the Desk shows each group's standings with every tie broken, and how they are ranked",
    standings.includes("Group A") && standings.includes("Group B") && standings.includes("1 Jordan 1-1") && standings.includes("3 Alex 1-1") && standings.includes("1 Sam 1-1") && standings.includes("Buchholz") && !standings.includes("Not official"),
    standings.slice(0, 240),
  );

  // An approved board: "In the hole" first, then each group's standings in its place.
  const boardToken = randomBytes(32).toString("base64url");
  await sql`insert into app.board_screens (tournament_id, pairing_code, token_hash, status, device, approved_at)
    values (${tid}, 'E2EB', ${createHash("sha256").update(boardToken).digest("hex")}, 'approved', 'e2e', now())`;
  const boardContext = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await boardContext.addCookies([{ name: `board_${slug}`, value: boardToken, url: BASE }]);
  const board = await boardContext.newPage();
  await board.goto(`${BASE}/t/${slug}/board`);
  await board.getByRole("region", { name: "In the hole" }).waitFor({ timeout: 20000 });
  const groupA = board.getByRole("region", { name: "Standings, Group A" });
  await groupA.waitFor({ timeout: 20000 });
  const onBoard = flat(await groupA.innerText());
  check(
    "the board shows a group's standings in place of In the hole, saying how they are ranked",
    onBoard.includes("Riley") && onBoard.includes("1-1") && /Buchholz/.test(onBoard) && (await board.getByRole("region", { name: "In the hole" }).count()) === 0,
    onBoard.slice(0, 160),
  );
  await board.getByRole("region", { name: "Standings, Group B" }).waitFor({ timeout: 20000 });
  check("the board goes on to the next group", true);
  if (SHOTS) await board.screenshot({ path: path.join(SHOTS, "two-stage-board-standings.png") });
  await boardContext.close();
  await endButton.click();
  const asking = page.getByRole("alertdialog");
  const question = flat(await asking.innerText());
  check("it asks first, and says group results can't be corrected afterwards", /End the group stage of Winter Groups\?/.test(question) && /group results can't be corrected/.test(question) && !/Challonge/.test(question), question);
  await shot(page, "2-end-group-stage");
  await asking.getByRole("button", { name: "Not yet" }).click();
  check("Not yet closes it and changes nothing", (await page.getByRole("alertdialog").count()) === 0 && (await sql`select state from app.tournaments where id = ${tid}`)[0].state === "group_stage");

  // --- Between the stages: the group stage ended on the Desk ---
  await endButton.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End group stage" }).click();
  await page.getByText("The group stage has ended. Start the final stage when you're ready.").waitFor({ timeout: 20000 });
  text = await desk();
  const banner = flat(await page.getByRole("status").filter({ hasText: "The group stage has ended." }).innerText());
  // Each group's top two go through, group winners seeded first: Jordan (A) and Sam (B), then Riley and Quinn.
  check("the Desk lists who goes through, in their final-stage seed order", banner.includes("Going through to the final stage: Jordan, Sam, Riley, Quinn."), banner);
  check("Start final stage is the next step, and Finish still isn't offered", (await startButton.isEnabled()) && (await endButton.count()) === 0 && (await finalizeButton.count()) === 0);
  const marked = flat(await page.getByRole("region", { name: "Standings" }).innerText());
  check("the standings mark the four who advanced", (marked.match(/Advanced/g) ?? []).length === 4, marked.slice(0, 240));
  await startButton.click();
  const starting = flat(await page.getByRole("alertdialog").innerText());
  check("it asks first, naming the players who go through", /Start the final stage of Winter Groups\?/.test(starting) && starting.includes("4 players advance: Jordan, Sam, Riley, Quinn.") && !/Challonge/.test(starting), starting);
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

  // --- The final stage, started on the Desk ---
  await desk();
  await startButton.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Start final stage" }).click();
  await page.getByText("The final stage has started.").waitFor({ timeout: 20000 });
  text = await desk();
  const finalQueue = flat(await page.getByRole("region", { name: "Queue" }).innerText());
  check("the final stage reads as a bracket, without a group, none of a group meeting first", /Round 1/.test(finalQueue) && !/Group/.test(finalQueue) && finalQueue.includes("Jordan vs Quinn") && finalQueue.includes("Sam vs Riley"), finalQueue.slice(0, 200));
  check("Finish is back, waiting for the final stage", (await finalizeButton.isDisabled()) && (await startButton.count()) === 0 && (await page.getByText("2 matches still to play.").count()) === 1);
  const ended = flat(await page.getByRole("region", { name: "Standings" }).innerText());
  check("the groups' standings stay on the Desk, marked as ended, and the bracket has none", ended.includes("Group A · ended") && !ended.includes("Final stage"), ended.slice(0, 160));
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
