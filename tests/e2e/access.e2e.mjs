// End-to-end check of M6 in a real browser: call boards the organizer approves (with a limit),
// player sign-in by passcode or personal QR on one device at a time, passcode slips, and what the
// screens show once a tournament is finished. Same prerequisites as the other e2e suites:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/access.e2e.mjs
//
// The bracket seeded here is only part of one, so the finished state and the places are written to
// the database; finishing itself is covered by tests/integration/finish.test.ts.
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

// --- A small event in progress: one stadium, one match called, one on deck, one queued ---
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const tid = randomUUID();
const names = ["Jordan", "Riley", "Alex", "Sam", "Quinn", "Drew", "Casey", "Morgan"];
const pids = Object.fromEntries(names.map((name) => [name, randomUUID()]));
const pid = (name) => pids[name];
const stadiumId = randomUUID();
// [letter, round, order, state, p1, p2, at the stadium, call status]
const plan = [
  ["Z", 1, 1, "complete", "Casey", "Morgan", false, "none"],
  ["A", 1, 2, "open", "Jordan", "Riley", true, "called"],
  ["B", 1, 3, "open", "Alex", "Sam", true, "on_deck"],
  ["C", 1, 4, "open", "Quinn", "Drew", false, "none"],
  ["I", 2, 5, "pending", "Casey", null, false, "none"],
  ["M", 3, 7, "pending", null, null, false, "none"],
];

await sql`insert into app.tournaments (id, organizer_id, name, state, tournament_type, auto_call, auto_on_deck)
  values (${tid}, ${userId}, 'Winter Cup', 'underway', 'double_elimination', false, true)`;
for (const name of names) {
  await sql`insert into app.participants (id, tournament_id, name) values (${pid(name)}, ${tid}, ${name})`;
}
await sql`insert into app.stadiums (id, tournament_id, name, position) values (${stadiumId}, ${tid}, 'Stadium 1', 1)`;
for (const [letter, round, order, state, p1, p2, here, call] of plan) {
  await sql`insert into app.matches (tournament_id, key, number, round, play_order, state,
      player1_id, player2_id, winner_id, scores, stadium_id, call_status, called_at, call_count)
    values (${tid}, ${"8" + order}, ${letter.charCodeAt(0) - 64}, ${round}, ${order}, ${state}, ${p1 ? pid(p1) : null}, ${p2 ? pid(p2) : null},
      ${state === "complete" ? pid(p1) : null}, ${state === "complete" ? "4-1" : null}, ${here ? stadiumId : null}, ${call},
      ${call === "called" ? new Date() : null}, ${call === "called" ? 1 : 0})`;
}
const [{ public_slug: slug }] = await sql`select public_slug from app.tournaments where id = ${tid}`;
const playerRow = async (name) => (await sql`select * from app.participants where tournament_id = ${tid} and id = ${pid(name)}`)[0];
const bump = () => sql`update app.tournaments set board_version = board_version + 1 where id = ${tid}`;

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", executablePath: process.env.E2E_EXECUTABLE, headless: true });
// Each context is a separate device: its own cookies.
const organizer = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const tv = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const tv2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const phoneSize = { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true };
const phone = await browser.newContext(phoneSize);
const phone2 = await browser.newContext(phoneSize);

const page = await organizer.newPage();
const boardsPanel = page.getByRole("region", { name: "BXQ Boards" });
const shot = async (target, name) => SHOTS && (await target.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }));
// What a person sees, and everything the server sent (which includes data embedded for React).
const text = (target) => target.locator("body").innerText();
const source = (target) => target.content();
const pairingCode = async (target) => {
  const code = target.getByLabel(/^Pairing code/);
  await code.waitFor();
  return (await code.textContent()).trim();
};

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments/${tid}`);
  await page.waitForURL(`**/tournaments/${tid}`);
  await page.getByRole("heading", { name: "BXQ Desk" }).waitFor();

  // ------------------------------------------------------------------------------------------
  // Call board: approval, limit, disconnect
  // ------------------------------------------------------------------------------------------
  const emptyPanel = await boardsPanel.textContent();
  check("the control room starts with no call boards, out of a limit of 1", emptyPanel.includes("0 of 1") && emptyPanel.includes("No screen is showing the board.") && !emptyPanel.includes("Open this link"));

  const board = await tv.newPage();
  const closedFeed = await board.request.get(`${BASE}/api/public/${slug}/board`);
  check("the board feed refuses a screen that isn't approved", closedFeed.status() === 401 && !(await closedFeed.text()).includes("Jordan"));

  await board.goto(`${BASE}/t/${slug}/board`);
  const code1 = await pairingCode(board);
  const waitingText = await source(board);
  check("an unapproved screen shows the tournament and a pairing code", /^[A-HJKMNP-Z2-9]{4}$/.test(code1) && waitingText.includes("Winter Cup") && waitingText.includes("Waiting for the organizer"), code1);
  check("no player or match reaches a screen before it is approved", !["Jordan", "Riley", "Alex", "Stadium 1"].some((n) => waitingText.includes(n)));
  await shot(board, "1-pairing");
  await board.reload();
  check("reloading the waiting screen keeps the same code", (await pairingCode(board)) === code1);

  const approve1 = page.getByRole("button", { name: `Approve screen ${code1}` });
  await approve1.waitFor({ timeout: 15000 });
  const requestText = await boardsPanel.textContent();
  check("the request appears in the control room with its code and device", requestText.includes(code1) && requestText.includes("Wants access") && /(Edge|Chrome) on Windows/.test(requestText), requestText.slice(0, 80));
  await shot(page, "2-request");
  await approve1.click();

  await board.getByLabel("Now calling").waitFor({ timeout: 15000 });
  check("once approved, the screen switches to the board by itself", (await text(board)).includes("Jordan") && (await board.getByLabel(/^Pairing code/).count()) === 0);
  await boardsPanel.getByText("Open now").waitFor({ timeout: 15000 });
  const onePanel = await boardsPanel.textContent();
  check("the control room counts the open board", onePanel.includes("1 of 1") && onePanel.includes("Open now") && onePanel.includes("approved"));
  const openFeed = await board.request.get(`${BASE}/api/public/${slug}/board`);
  check("the approved screen's feed works", openFeed.status() === 200 && (await openFeed.text()).includes("Jordan"));

  // A second screen, beyond the limit.
  const board2 = await tv2.newPage();
  await board2.goto(`${BASE}/t/${slug}/board`);
  const code2 = await pairingCode(board2);
  const approve2 = page.getByRole("button", { name: `Approve screen ${code2}` });
  await approve2.waitFor({ timeout: 15000 });
  check("a second screen gets its own code", code2 !== code1);
  check("at the limit, Approve is disabled and the panel says why", (await approve2.isDisabled()) && (await boardsPanel.textContent()).includes("The limit of 1 is reached"));
  await shot(page, "3-limit");

  await page.getByRole("button", { name: "Venue settings" }).click();
  await page.getByRole("spinbutton", { name: /Boards allowed/ }).fill("2");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Saved.").waitFor();
  await page.getByRole("button", { name: "Venue settings" }).click();
  await boardsPanel.getByText("1 of 2").waitFor();
  await approve2.click();
  await board2.getByLabel("Now calling").waitFor({ timeout: 15000 });
  await boardsPanel.getByText("2 of 2").waitFor();
  check("raising the limit in Venue settings lets the second screen in", (await sql`select 1 from app.board_screens where tournament_id = ${tid} and status = 'approved'`).length === 2);

  // Disconnect the second screen (the list is oldest first).
  await boardsPanel.getByRole("button", { name: /^Disconnect/ }).nth(1).click();
  await board2.getByText("The organizer disconnected this screen.").waitFor({ timeout: 15000 });
  const afterDisconnect = await source(board2);
  check("a disconnected screen loses the board at once and says why", !afterDisconnect.includes("Jordan") && (await board2.getByRole("button", { name: "Ask to show the board" }).count()) === 1);
  await boardsPanel.getByText("1 of 2").waitFor();
  await page.waitForTimeout(1500);
  check("it doesn't ask again by itself", (await sql`select 1 from app.board_screens where tournament_id = ${tid}`).length === 1);
  check("the other board keeps running", (await board.getByLabel("Now calling").count()) === 1);
  await board2.close();

  // ------------------------------------------------------------------------------------------
  // Player page: passcode, one screen per player
  // ------------------------------------------------------------------------------------------
  const jordan = await playerRow("Jordan");
  const mine = await phone.newPage();
  const closedMe = await mine.request.get(`${BASE}/api/public/${slug}/me`);
  check("the player feed refuses a phone that isn't signed in", closedMe.status() === 401);

  await mine.goto(`${BASE}/t/${slug}`);
  await mine.getByRole("heading", { name: "Who are you?" }).waitFor();
  const pickerText = await source(mine);
  check("before signing in, the page lists names and nothing about matches", pickerText.includes("Jordan") && pickerText.includes("Morgan") && !pickerText.includes("Stadium 1") && !pickerText.includes(" vs "));
  await mine.getByRole("button", { name: "Jordan", exact: true }).click();
  const codeInput = mine.getByLabel("Enter your 4-digit passcode");
  const agreed = await mine.getByText(/^By continuing, you agree to our/).getByRole("link").evaluateAll((els) => els.map((el) => `${el.textContent} ${el.getAttribute("href")} ${el.target}`));
  check("under Open my Pass, continuing means agreeing to the terms and the privacy policy", agreed.join(" | ") === "Terms of Service /terms _blank | Privacy Policy /privacy _blank", agreed.join(" | "));
  await codeInput.fill(jordan.passcode === "0000" ? "0001" : "0000");
  await mine.getByRole("button", { name: "Open my Pass" }).click();
  await mine.getByRole("alert").filter({ hasText: "doesn't match" }).waitFor();
  check("a wrong passcode is refused and nothing is shown", !(await source(mine)).includes("Stadium 1") && (await codeInput.inputValue()) === "");
  await shot(mine, "4-passcode");

  await codeInput.fill(jordan.passcode);
  await mine.getByRole("button", { name: "Open my Pass" }).click();
  // The passcode step greets the player too; "Not you?" only exists on their own page.
  await mine.getByRole("button", { name: "Not you?" }).waitFor();
  const myText = await text(mine);
  check("the right passcode opens the player's own page", myText.includes("Stadium 1") && myText.includes("vs Riley"));
  check("the page shows only that player's match", !["Alex", "Sam", "Quinn", "Drew", "Casey"].some((n) => myText.includes(n)) && (await mine.getByRole("link", { name: /board/i }).count()) === 0);
  await mine.reload();
  await mine.getByRole("button", { name: "Not you?" }).waitFor();
  const mySource = await source(mine);
  check("nothing about other players is sent to a signed-in phone, even out of sight", mySource.includes("Riley") && !["Alex", "Sam", "Quinn", "Drew", "Casey", "Morgan"].some((n) => mySource.includes(n)));
  const myFeed = await (await mine.request.get(`${BASE}/api/public/${slug}/me`)).text();
  check("the player feed carries only that player's match", myFeed.includes("Riley") && !["Alex", "Quinn", "Casey", "passcode"].some((n) => myFeed.includes(n)));
  check("a signed-in player still can't read the whole board", (await mine.request.get(`${BASE}/api/public/${slug}/board`)).status() === 401);
  await shot(mine, "5-player");

  // The control room's Players panel.
  await page.getByRole("navigation", { name: "Desk sections" }).getByRole("link", { name: /^Players/ }).click();
  await page.getByRole("heading", { name: /^Players and passcodes/ }).waitFor();
  const jordanRow = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Jordan", exact: true }) });
  await jordanRow.getByText("Open now").waitFor({ timeout: 15000 });
  check("the control room lists each passcode and who is signed in", (await jordanRow.textContent()).includes(jordan.passcode) && (await page.getByText("(1 of 8 signed in)").count()) === 1);
  await shot(page, "6-players");

  // A second device takes over, using the personal QR link.
  const other = await phone2.newPage();
  await other.goto(`${BASE}/t/${slug}#k=${jordan.sign_in_token}`);
  await other.getByRole("heading", { name: "Hi, Jordan" }).waitFor();
  check("the personal QR link signs in without typing, and the secret leaves the address bar", !other.url().includes("#k=") && !other.url().includes(jordan.sign_in_token));
  await mine.getByRole("status").filter({ hasText: "You signed in on another device" }).waitFor({ timeout: 20000 });
  check("the first device is signed out and told why", (await mine.getByRole("heading", { name: "Who are you?" }).count()) === 1 && !(await text(mine)).includes("Stadium 1"));
  await mine.reload();
  await mine.getByRole("heading", { name: "Who are you?" }).waitFor();
  check("after a reload it still explains, and still has no match data", (await text(mine)).includes("You signed in on another device") && !(await source(mine)).includes("Stadium 1"));
  check("one session per player", (await sql`select 1 from app.player_sessions where tournament_id = ${tid} and participant_id = ${pid("Jordan")}`).length === 1);
  await shot(mine, "7-replaced");

  // A live change reaches the signed-in phone: the organizer starts the match.
  await sql`update app.matches set call_status = 'playing', playing_at = now() where tournament_id = ${tid} and number = 1`;
  await bump();
  await other.getByText("Playing", { exact: true }).waitFor({ timeout: 20000 });
  check("the player's page follows the match by itself", (await text(other)).includes("vs Riley"));

  // The organizer issues a new passcode.
  await page.getByRole("button", { name: "New passcode for Jordan" }).click();
  await page.getByText("New passcode issued").waitFor();
  const jordanAfter = await playerRow("Jordan");
  await other.getByRole("heading", { name: "Who are you?" }).waitFor({ timeout: 20000 });
  check("a new passcode signs the player's device out and replaces the QR secret", jordanAfter.sign_in_token !== jordan.sign_in_token && (await jordanRow.textContent()).includes(jordanAfter.passcode) && (await jordanRow.textContent()).includes("Not signed in"));
  await other.goto(`${BASE}/t/${slug}#k=${jordan.sign_in_token}`);
  await other.getByRole("alert").filter({ hasText: "QR code no longer works" }).waitFor();
  check("the old slip's QR code no longer works", (await other.getByRole("heading", { name: "Who are you?" }).count()) === 1);

  // "Not you?" signs out.
  await other.goto(`${BASE}/t/${slug}#k=${jordanAfter.sign_in_token}`);
  await other.getByRole("heading", { name: "Hi, Jordan" }).waitFor();
  await other.getByRole("button", { name: "Not you?" }).click();
  await other.getByRole("heading", { name: "Who are you?" }).waitFor();
  check("Not you? signs the device out", (await sql`select 1 from app.player_sessions where tournament_id = ${tid}`).length === 0);

  // ------------------------------------------------------------------------------------------
  // Passcode slips
  // ------------------------------------------------------------------------------------------
  const slips = await organizer.newPage();
  await slips.goto(`${BASE}/tournaments/${tid}/passcodes`);
  await slips.getByRole("heading", { name: "Passcode slips" }).waitFor();
  const slipItems = slips.getByRole("listitem");
  const jordanSlip = slipItems.filter({ hasText: "Jordan" });
  check("the print page has one slip per player with their passcode and a QR code", (await slipItems.count()) === 8 && (await jordanSlip.textContent()).includes(jordanAfter.passcode) && (await jordanSlip.locator("svg").count()) === 1 && (await slips.getByRole("button", { name: "Print" }).count()) === 1);
  check("slips are black on white", (await slips.locator("ul").evaluate((el) => getComputedStyle(el.parentElement).backgroundColor)) === "rgb(255, 255, 255)");
  await shot(slips, "8-slips");
  await slips.emulateMedia({ media: "print" });
  check("the Print button and heading stay off the paper", !(await slips.getByRole("button", { name: "Print" }).isVisible()));
  await slips.close();
  const strangerSlips = await phone.newPage();
  const refused = await strangerSlips.goto(`${BASE}/tournaments/${tid}/passcodes`);
  check("the slips need the organizer's sign-in", strangerSlips.url().includes("/auth/login") && !(await source(strangerSlips)).includes(jordanAfter.sign_in_token), String(refused?.status()));
  await strangerSlips.close();

  // ------------------------------------------------------------------------------------------
  // Finishing
  // ------------------------------------------------------------------------------------------
  const finalize = page.getByRole("button", { name: "Finish tournament" });
  check("Finish is disabled while matches remain, and says how many", (await finalize.isDisabled()) && (await page.locator("header").textContent()).includes("3 matches still to play."));

  await sql`update app.matches set state = 'complete', call_status = 'none', stadium_id = null where tournament_id = ${tid} and state = 'open'`;
  await bump();
  await page.locator("header").getByText("matches still to play").waitFor({ state: "hidden", timeout: 15000 });
  check("with every match played, Finish is available", await finalize.isEnabled());
  await finalize.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const dialogText = await dialog.textContent();
  check("finishing asks first and says results are fixed after it", dialogText.includes("Finish Winter Cup?") && dialogText.includes("results can't be corrected after it") && !dialogText.includes("Challonge"));
  await shot(page, "9-finalize-dialog");
  await dialog.getByRole("button", { name: "Not yet" }).click();
  check("Not yet leaves the tournament as it is", (await page.getByRole("alertdialog").count()) === 0 && (await sql`select state from app.tournaments where id = ${tid}`)[0].state === "underway");

  // What the screens show once it is finished (written straight to the database: see the top).
  const riley = await playerRow("Riley");
  await mine.goto(`${BASE}/t/${slug}#k=${riley.sign_in_token}`);
  await mine.getByRole("heading", { name: "Hi, Riley" }).waitFor();
  await sql`update app.tournaments set state = 'complete' where id = ${tid}`;
  await bump();
  await page.locator("header").getByText("Finished").waitFor({ timeout: 15000 });
  check("a finished tournament says so, and Finish is gone", (await finalize.count()) === 0);

  const order = ["Jordan", "Riley", "Alex", "Sam", "Quinn", "Drew", "Casey", "Morgan"];
  for (const [i, name] of order.entries()) {
    await sql`update app.participants set final_rank = ${i < 4 ? i + 1 : i % 2 ? i : i + 1} where tournament_id = ${tid} and id = ${pid(name)}`;
  }
  await bump();
  const standings = board.getByRole("region", { name: "Final standings" });
  await standings.waitFor({ timeout: 15000 });
  const standingsText = await standings.textContent();
  check("the call board switches to the final standings with a podium", standingsText.includes("1stJordan") && standingsText.includes("2ndRiley") && standingsText.includes("3rdAlex") && standingsText.includes("5thQuinn") && standingsText.includes("5thDrew"), standingsText.slice(0, 60));
  check("the stadium cards and calls are gone from the finished board", (await board.getByLabel("Now calling").count()) === 0 && (await board.locator("article").count()) === 0 && (await board.locator("header").textContent()).includes("Final standings"));
  await shot(board, "10-standings");

  await mine.getByText("Tournament finished").waitFor({ timeout: 20000 });
  const finishedText = await text(mine);
  // Riley's own finished match (against Jordan) is listed under the placement; nobody else's is.
  check("each player sees their own placement", finishedText.includes("2nd") && finishedText.includes("out of 8 players") && !["Alex", "Quinn", "Casey"].some((n) => finishedText.includes(n)), finishedText.replace(/\s+/g, " ").slice(0, 160));
  await shot(mine, "11-placement");
  check("the Desk shows Finished and stays usable", (await page.locator("header").getByText("Finished").count()) === 1 && (await page.getByRole("button", { name: "Venue settings" }).isEnabled()));
  await shot(page, "12-finalized");
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
