// End-to-end check of judge tablets and the short links in a real browser: the judge link and
// sign-up, approval in the control room, the tablet following its stadium, Start on the pad,
// scoring without an organizer sign-in, and disconnecting. Same prerequisites as the other suites:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/judges.e2e.mjs
//
// Sending a result needs Challonge, which the throwaway organizer doesn't have; here a finished
// match is written to the database, and sending is covered by the integration tests.
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

// --- Two stadiums, nothing called yet: A and B are on deck, C waits in the queue ---
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const tid = randomUUID();
const names = ["Jordan", "Riley", "Alex", "Sam", "Quinn", "Drew"];
const pid = (name) => String(4000 + names.indexOf(name));
const stadiums = [1, 2].map((n) => ({ id: randomUUID(), name: `Stadium ${n}`, position: n }));
// [letter, round, order, state, p1, p2, stadium index, call status]
const plan = [
  ["A", 1, 1, "open", "Jordan", "Riley", 0, "on_deck"],
  ["B", 1, 2, "open", "Alex", "Sam", 1, "on_deck"],
  ["C", 1, 3, "open", "Quinn", "Drew", null, "none"],
  ["M", 2, 5, "pending", null, null, null, "none"],
  ["O", 3, 6, "pending", null, null, null, "none"],
  ["P", 4, 7, "pending", null, null, null, "none"],
];
const matchId = Object.fromEntries(plan.map(([letter]) => [letter, randomUUID()]));

await sql`insert into app.challonge_connections (organizer_id, client_id, client_secret_enc, status, challonge_username)
  values (${userId}, 'e2e-client', 'v1.x.x.x', 'credentials_saved', 'e2e')`;
await sql`insert into app.tournaments (id, organizer_id, challonge_id, challonge_url, name, state, tournament_type, participants_count, auto_call, auto_on_deck, last_synced_at)
  values (${tid}, ${userId}, '996', 'e2e_judges', 'Summer Slam', 'underway', 'double elimination', ${names.length}, false, false, now())`;
for (const name of names) {
  await sql`insert into app.participants (tournament_id, challonge_id, name) values (${tid}, ${pid(name)}, ${name})`;
}
for (const s of stadiums) {
  await sql`insert into app.stadiums (id, tournament_id, name, position) values (${s.id}, ${tid}, ${s.name}, ${s.position})`;
}
for (const [letter, round, order, state, p1, p2, stadium, call] of plan) {
  await sql`insert into app.matches (id, tournament_id, challonge_id, identifier, round, suggested_play_order, state,
      player1_challonge_id, player2_challonge_id, stadium_id, call_status)
    values (${matchId[letter]}, ${tid}, ${"6" + order}, ${letter}, ${round}, ${order}, ${state}, ${p1 ? pid(p1) : null}, ${p2 ? pid(p2) : null},
      ${stadium === null ? null : stadiums[stadium].id}, ${call})`;
}
const [{ public_slug: slug, short_code: code }] = await sql`select public_slug, short_code from app.tournaments where id = ${tid}`;
const one = async (letter) => (await sql`select * from app.matches where id = ${matchId[letter]}`)[0];
const battlesOf = async (letter) => (await sql`select kind, side from app.battles where match_id = ${matchId[letter]} and voided_at is null order by seq`).map((b) => `${b.kind}:${b.side}`);
const host = new URL(process.env.APP_URL ?? "http://localhost:3000").host;

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", headless: true });
const organizer = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
// Judge tablets: no organizer sign-in on these.
const tabletSize = { viewport: { width: 1180, height: 820 }, hasTouch: true };
const tablet = await browser.newContext(tabletSize);
const tablet2 = await browser.newContext(tabletSize);
const tablet3 = await browser.newContext(tabletSize);

const page = await organizer.newPage();
const card = (name) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
const cardMenu = async (name, item) => {
  await page.getByRole("button", { name: `${name} actions` }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const judgesPanel = page.getByRole("region", { name: "Judges" });
const boardsPanel = page.getByRole("region", { name: "Call boards" });
const shot = async (target, name) => SHOTS && (await target.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }));
const reading = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
const pairingCode = async (target) => {
  const shown = target.getByLabel(/^Pairing code/);
  await shown.waitFor();
  return (await shown.textContent()).trim();
};

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments/${tid}`);
  await page.waitForURL(`**/tournaments/${tid}`);
  await page.getByRole("heading", { name: "Control room" }).waitFor();

  // ------------------------------------------------------------------------------------------
  // Short links on the cards
  // ------------------------------------------------------------------------------------------
  const boardLink = boardsPanel.getByRole("button", { name: `/b/${code}` });
  check("the Call boards card shows a short link without https://", (await boardLink.textContent()) === `${host}/b/${code}` && /^[A-HJKMNP-Z2-9]{6}$/.test(code), await boardLink.textContent());
  const linkStyle = await boardLink.evaluate((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), weight: Number(getComputedStyle(el).fontWeight), border: getComputedStyle(el).borderTopWidth }));
  check("the link is large, bold and not inside a field", linkStyle.size >= 20 && linkStyle.weight >= 700 && linkStyle.border === "0px", JSON.stringify(linkStyle));
  check("the cards have no copy buttons and no links that open the page", (await page.getByRole("button", { name: /^Copy/ }).count()) === 0 && (await boardsPanel.getByRole("link").count()) === 0 && (await judgesPanel.getByRole("link").count()) === 0);
  const pagesBefore = organizer.pages().length;
  check("no hint line under the link any more", !(await reading(boardsPanel)).includes("Click the link") && (await boardLink.getAttribute("title")) === null);
  await boardLink.hover();
  const tip = page.getByRole("tooltip");
  await tip.filter({ hasText: "Click to copy" }).waitFor();
  check("hovering the link shows a Click to copy tooltip", true);
  await boardLink.click();
  await tip.filter({ hasText: "Copied" }).first().waitFor();
  check("after a click the tooltip stays up and says Copied", !(await tip.first().textContent()).includes("Click to copy"));
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("clicking the link copies the full address", /^https?:\/\//.test(copied) && copied.endsWith(`/b/${code}`), copied);
  check("clicking the link doesn't open or leave the page", organizer.pages().length === pagesBefore && page.url().endsWith(`/tournaments/${tid}`));
  const judgeLink = judgesPanel.getByRole("button", { name: `/j/${code}` });
  await judgeLink.click();
  // The first link's "Copied" can still be up for a moment: there may be two.
  await tip.filter({ hasText: "Copied" }).last().waitFor();
  const copiedJudge = await page.evaluate(() => navigator.clipboard.readText());
  const judgesText = await reading(judgesPanel);
  check("the Judges card shows the judge link the same way, and copies it", (await judgeLink.textContent()) === `${host}/j/${code}` && copiedJudge.endsWith(`/j/${code}`) && judgesText.includes("0 of 2 stadiums"));
  check("the cards' hints use the short wording", judgesText.includes("A judge opens this link on their device and picks a stadium.") && !/tablet/i.test(judgesText) && (await reading(boardsPanel)).includes("No screen is showing the board."));
  await shot(page, "1-cards");

  const tv = await tablet2.newPage();
  await tv.goto(`${BASE}/b/${code.toLowerCase()}`);
  await tv.waitForURL(`**/t/${slug}/board`);
  check("the short board link opens the board's approval screen, typed in any case", /^[A-HJKMNP-Z2-9]{4}$/.test(await pairingCode(tv)) && !(await tv.content()).includes("Jordan"));
  const wrong = await tv.goto(`${BASE}/b/ZZZZZ2`);
  check("a wrong short code finds nothing", wrong.status() === 404);
  await tv.close();
  await sql`delete from app.board_screens where tournament_id = ${tid}`;

  // ------------------------------------------------------------------------------------------
  // No judge, no start
  // ------------------------------------------------------------------------------------------
  await card("Stadium 1").getByRole("button", { name: "Call players" }).click();
  await card("Stadium 1").getByText("called", { exact: true }).waitFor();
  const start1 = card("Stadium 1").getByRole("button", { name: "Start match" });
  const noJudge = await reading(card("Stadium 1"));
  check("a called match can't be started while its stadium has no judge", (await start1.isDisabled()) && noJudge.includes("Awaiting judge...") && !noJudge.includes("Judge here myself") && !noJudge.includes("can't start"));
  check("calling still works without a judge", (await one("A")).call_status === "called");

  // ------------------------------------------------------------------------------------------
  // A judge tablet signs up
  // ------------------------------------------------------------------------------------------
  const pad = await tablet.newPage();
  check("the pad's endpoints refuse a device that is nobody", (await pad.request.post(`${BASE}/api/matches/${matchId.A}/battles`, { data: { ops: [] }, headers: { origin: BASE } })).status() === 401);
  await pad.goto(`${BASE}/j/${code}`);
  await pad.waitForURL(`**/t/${slug}/judge`);
  await pad.getByRole("heading", { name: "Judge sign-up" }).waitFor();
  const signUp = await pad.content();
  check("the judge link opens the sign-up with the stadiums and no match data", signUp.includes("Summer Slam") && signUp.includes("Stadium 1") && signUp.includes("Stadium 2") && !["Jordan", "Riley", "Alex"].some((n) => signUp.includes(n)));
  const nameField = pad.getByLabel("Your name");
  check("the sign-up starts with the detected device as the judge's name", /^(Edge|Chrome) on Windows$/.test(await nameField.inputValue()), await nameField.inputValue());
  await pad.getByRole("button", { name: "Stadium 1" }).click();
  const code1 = await pairingCode(pad);
  check("picking a stadium shows a pairing code and says which stadium", /approve (Edge|Chrome) on Windows for Stadium 1/.test(await reading(pad.locator("main"))), code1);
  await shot(pad, "2-sign-up");

  const approve = page.getByRole("button", { name: new RegExp(`^Approve judge ${code1}, .* for Stadium 1$`) });
  await approve.waitFor({ timeout: 15000 });
  const request = await reading(judgesPanel);
  check("the request appears in the control room with its code, stadium and device", request.includes(code1) && /wants to judge/i.test(request) && request.includes("Stadium 1") && /(Edge|Chrome) on Windows/.test(request), request.slice(0, 120));
  const asking = await reading(card("Stadium 1"));
  check("the stadium card says a judge is asking for approval", asking.includes("Judge Asking for Approval") && !asking.includes("Judge here myself") && !asking.includes("Awaiting judge"));
  await shot(page, "3-request");
  await approve.click();

  // The tablet follows its stadium: approved, it finds the called match and opens its pad.
  await pad.waitForURL(`**/t/${slug}/judge/${matchId.A}`, { timeout: 20000 });
  await pad.getByRole("heading", { name: "Battle log" }).waitFor();
  check("once approved, the tablet opens the called match's pad by itself", (await pad.getByRole("heading", { name: "Jordan" }).count()) === 1 && (await pad.getByRole("link", { name: "Stadium 1" }).count()) === 1);
  await card("Stadium 1").getByText("open now").waitFor({ timeout: 15000 });
  check("the stadium card names its judge, and Start is available in the control room too", (await reading(card("Stadium 1").getByText(/^Judge:/))).includes("on Windows · open now") && (await start1.isEnabled()) && (await reading(judgesPanel)).includes("1 of 2 stadiums"));
  await shot(page, "4-approved");

  // ------------------------------------------------------------------------------------------
  // Start on the pad
  // ------------------------------------------------------------------------------------------
  const xtreme = pad.getByRole("button", { name: "Xtreme for Jordan, plus 3" });
  const startOnPad = pad.getByRole("button", { name: "Start match" });
  check("scoring is locked behind Start match", (await xtreme.isDisabled()) && (await pad.getByRole("button", { name: /Draw/ }).isDisabled()) && (await startOnPad.isEnabled()));
  await shot(pad, "5-pad-locked");
  await startOnPad.click();
  await card("Stadium 1").getByText("playing", { exact: true }).waitFor({ timeout: 15000 });
  check("the judge's Start marks the match as playing everywhere", (await one("A")).call_status === "playing" && (await startOnPad.count()) === 0 && (await xtreme.isEnabled()));
  await xtreme.click();
  await pad.locator("header [role=status]").filter({ hasText: "Saved" }).waitFor({ timeout: 15000 });
  await pad.waitForTimeout(300);
  check("the judge's taps are saved without an organizer sign-in", (await battlesOf("A")).join() === "xtreme:1", (await battlesOf("A")).join());
  await card("Stadium 1").getByLabel("Score 3–0").waitFor({ timeout: 15000 });
  check("the control room shows the judge's score live", true);
  await shot(pad, "6-pad-started");

  // ------------------------------------------------------------------------------------------
  // What a judge can't do
  // ------------------------------------------------------------------------------------------
  await pad.goto(`${BASE}/t/${slug}/judge/${matchId.B}`);
  await pad.waitForURL(`**/t/${slug}/judge/${matchId.A}`, { timeout: 15000 });
  check("another stadium's match sends the tablet back to its own", (await pad.getByRole("heading", { name: "Jordan" }).count()) === 1);
  const foreign = await pad.request.post(`${BASE}/api/matches/${matchId.B}/battles`, { data: { ops: [{ op: "add", opId: randomUUID(), kind: "spin", side: 1 }] }, headers: { origin: BASE } });
  check("the server refuses a judge's taps on another stadium's match", foreign.status() === 404 && (await battlesOf("B")).length === 0);
  const control = await pad.goto(`${BASE}/tournaments/${tid}`);
  check("a judge tablet has no way into the control room", pad.url().includes("/auth/login"), String(control?.status()));
  const feed = await (await pad.request.get(`${BASE}/api/public/${slug}/judge`)).text();
  check("the tablet's feed carries only its own stadium", feed.includes("Jordan vs Riley") && !["Alex", "Sam", "Quinn"].some((n) => feed.includes(n)));

  // One judge per stadium.
  const other = await tablet2.newPage();
  await other.goto(`${BASE}/j/${code}`);
  const taken = await reading(other.getByRole("button", { name: /Stadium 1/ }));
  check("the sign-up shows which stadiums already have a judge", taken.includes("has a judge") && !(await reading(other.getByRole("button", { name: /Stadium 2/ }))).includes("has a judge"));
  await other.getByLabel("Your name").fill("Maria");
  await other.getByRole("button", { name: /Stadium 1/ }).click();
  const code2 = await pairingCode(other);
  const approve2 = page.getByRole("button", { name: `Approve judge ${code2}, Maria, for Stadium 1` });
  await approve2.waitFor({ timeout: 15000 });
  const request2 = await reading(judgesPanel);
  check("a second tablet for the same stadium can't be approved", (await approve2.isDisabled()) && request2.includes("Stadium 1 already has a judge"));
  check("the request shows the name the judge typed, not the device", request2.includes("Maria · asked") && !/on Windows · asked/.test(request2) && (await reading(other.locator("main"))).includes("approve Maria for Stadium 1"), request2.slice(0, 140));
  await other.getByRole("button", { name: "Wrong name or stadium? Change it" }).click();
  check("going back keeps the typed name", (await other.getByLabel("Your name").inputValue()) === "Maria");
  await other.getByRole("button", { name: /Stadium 2/ }).click();
  const approveFor2 = page.getByRole("button", { name: `Approve judge ${code2}, Maria, for Stadium 2` });
  await approveFor2.waitFor({ timeout: 15000 });
  check("the waiting tablet can switch stadium and keeps its code", (await pairingCode(other)) === code2 && (await approveFor2.isEnabled()));
  await approveFor2.click();
  await other.getByRole("heading", { name: "Judge · Stadium 2" }).waitFor({ timeout: 20000 });
  const waitingScreen = await reading(other.locator("main"));
  check("an approved tablet with no called match waits and shows who is on deck", waitingScreen.includes("Waiting for the next match") && waitingScreen.includes("Alex vs Sam"));
  await shot(other, "7-waiting");

  // Names: the judge renames themselves, then the organizer does.
  await card("Stadium 2").getByText("Judge: Maria").waitFor({ timeout: 15000 });
  check("the stadium card shows the judge's name only", /^Judge: Maria · (open now|last seen)/.test(await reading(card("Stadium 2").getByText(/^Judge:/))) && waitingScreen.includes("Judging as Maria"));
  await other.getByRole("button", { name: "Rename" }).click();
  await other.getByLabel("Your name").fill("Maria K");
  await other.getByRole("button", { name: "Save" }).click();
  await other.getByText("Judging as Maria K").waitFor();
  await card("Stadium 2").getByText("Judge: Maria K").waitFor({ timeout: 15000 });
  check("a judge can rename themselves on the tablet, and the control room follows", true);
  await cardMenu("Stadium 2", "Rename judge");
  await card("Stadium 2").getByLabel("Judge name").fill("Table 2");
  await card("Stadium 2").getByRole("button", { name: "Save" }).click();
  await card("Stadium 2").getByText("Judge: Table 2").waitFor({ timeout: 15000 });
  await other.getByText("Judging as Table 2").waitFor({ timeout: 20000 });
  check("the organizer can rename a judge from the stadium's menu, and the tablet follows", (await sql`select name, device from app.judge_screens where stadium_id = ${stadiums[1].id}`)[0].name === "Table 2");
  await shot(page, "8-names");

  // The organizer calls Stadium 2's match: that tablet opens it by itself.
  await card("Stadium 2").getByRole("button", { name: "Call players" }).click();
  await other.waitForURL(`**/t/${slug}/judge/${matchId.B}`, { timeout: 20000 });
  check("a call opens the pad on that stadium's tablet by itself", (await other.getByRole("button", { name: "Start match" }).count()) === 1);

  // Start from the control room unlocks the judge's pad as well.
  await card("Stadium 2").getByRole("button", { name: "Start match" }).click();
  await card("Stadium 2").getByText("playing", { exact: true }).waitFor();
  await other.reload();
  await other.getByRole("heading", { name: "Battle log" }).waitFor();
  check("a start from the control room unlocks the pad too", (await other.getByRole("button", { name: "Start match" }).count()) === 0 && (await other.getByRole("button", { name: "Spin for Alex, plus 1" }).isEnabled()));

  // ------------------------------------------------------------------------------------------
  // A judge leaves their stadium; another takes over with the same score
  // ------------------------------------------------------------------------------------------
  // Stadium 1's judge is on the pad of the match being played there (Jordan 3–0 Riley).
  // First, a tap that can't reach the server: leaving has to wait for it.
  await pad.goto(`${BASE}/t/${slug}/judge`);
  await pad.waitForURL(`**/t/${slug}/judge/${matchId.A}`, { timeout: 20000 });
  await pad.getByRole("heading", { name: "Battle log" }).waitFor();
  await pad.route("**/api/matches/*/battles", (route) => route.abort());
  await pad.getByRole("button", { name: "Spin for Riley, plus 1" }).click();
  await pad.locator("header [role=status]").filter({ hasText: "Offline" }).waitFor({ timeout: 20000 });
  await pad.getByRole("link", { name: "Stadium 1" }).click();
  await pad.getByRole("heading", { name: "Judge · Stadium 1" }).waitFor();
  const leave = pad.getByRole("button", { name: "Leave this stadium" });
  await leave.click();
  await pad.getByRole("alert").filter({ hasText: "still saving" }).waitFor({ timeout: 30000 });
  check("leaving is refused while a tap hasn't been saved", (await reading(pad.getByRole("alert").filter({ hasText: "still saving" }))) === "1 tap is still saving. Reconnect, then try again." && (await pad.getByRole("alertdialog").count()) === 0 && (await battlesOf("A")).join() === "xtreme:1");
  check("and the judge is still the stadium's judge", (await sql`select 1 from app.judge_screens where stadium_id = ${stadiums[0].id} and status = 'approved'`).length === 1);

  // The connection is back: the tap is saved first, then leaving asks for confirmation.
  await pad.unroute("**/api/matches/*/battles");
  await leave.click();
  const leaveDialog = pad.getByRole("alertdialog");
  await leaveDialog.waitFor({ timeout: 30000 });
  const leaveText = await reading(leaveDialog);
  check("with a match being played, leaving asks first and says the score is kept", leaveText.includes("Leave Stadium 1?") && leaveText.includes("Jordan vs Riley is being played here.") && leaveText.includes("The score stays as it is: the next judge, or the organizer, carries on from the same point."), leaveText);
  check("the waiting tap was saved before asking", (await battlesOf("A")).join() === "xtreme:1,spin:2", (await battlesOf("A")).join());
  await shot(pad, "9-leave-confirm");
  await leaveDialog.getByRole("button", { name: "Stay" }).click();
  check("Stay keeps the judge at the stadium", (await pad.getByRole("alertdialog").count()) === 0 && (await pad.getByRole("heading", { name: "Judge · Stadium 1" }).count()) === 1);

  await leave.click();
  await pad.getByRole("alertdialog").getByRole("button", { name: "Leave stadium" }).click();
  await pad.getByText("You left Stadium 1. Pick a stadium to judge again.").waitFor({ timeout: 20000 });
  check("after leaving, the device is back at sign-up and says which stadium it left", (await pad.getByRole("heading", { name: "Judge sign-up" }).count()) === 1 && !(await reading(pad.locator("main"))).includes("disconnected"));
  check("the judge's name is kept for signing up again", /^(Edge|Chrome) on Windows$/.test(await pad.getByLabel("Your name").inputValue()));
  check("its cookie no longer works", (await pad.request.post(`${BASE}/api/matches/${matchId.A}/battles`, { data: { ops: [] }, headers: { origin: BASE } })).status() === 401);

  await card("Stadium 1").getByText("Awaiting judge...").waitFor({ timeout: 15000 });
  const afterLeave = await reading(card("Stadium 1"));
  check("the control room shows the stadium awaiting a judge, with the match and score untouched", afterLeave.includes("PLAYING") && afterLeave.includes("Jordan vs Riley") && (await card("Stadium 1").getByLabel("Score 3–1").count()) === 1 && (await one("A")).call_status === "playing", afterLeave.slice(0, 90));

  // Another judge takes the stadium over.
  const relief = await tablet3.newPage();
  await relief.goto(`${BASE}/j/${code}`);
  await relief.getByLabel("Your name").fill("Second judge");
  await relief.getByRole("button", { name: /Stadium 1/ }).click();
  const code3 = await pairingCode(relief);
  await page.getByRole("button", { name: `Approve judge ${code3}, Second judge, for Stadium 1` }).click({ timeout: 15000 });
  await relief.waitForURL(`**/t/${slug}/judge/${matchId.A}`, { timeout: 20000 });
  await relief.getByRole("heading", { name: "Battle log" }).waitFor();
  check("the new judge opens the same match with the same score, already started", (await relief.getByLabel("3 points").count()) === 1 && (await relief.getByLabel("1 points").count()) === 1 && (await relief.getByText("2 battles").count()) === 1 && (await relief.getByRole("button", { name: "Start match" }).count()) === 0);
  await shot(relief, "10-new-judge");
  await relief.getByRole("button", { name: "Spin for Riley, plus 1" }).click();
  await relief.locator("header [role=status]").filter({ hasText: "Saved" }).waitFor({ timeout: 15000 });
  await card("Stadium 1").getByLabel("Score 3–2").waitFor({ timeout: 15000 });
  const battlesAfterSwitch = (await battlesOf("A")).join();
  check("and carries on scoring from there", battlesAfterSwitch === "xtreme:1,spin:2,spin:2" && (await reading(card("Stadium 1").getByText(/^Judge:/))).startsWith("Judge: Second judge"), battlesAfterSwitch);

  // With no match at the stadium, leaving needs no confirmation (Stadium 2's judge, once its match is gone).
  await sql`update app.matches set stadium_id = null, call_status = 'none', called_at = null, call_count = 0 where id = ${matchId.B}`;
  await sql`update app.tournaments set board_version = board_version + 1 where id = ${tid}`;
  await other.goto(`${BASE}/t/${slug}/judge`);
  await other.getByText("Waiting for the next match").waitFor({ timeout: 15000 });
  await other.getByRole("button", { name: "Leave this stadium" }).click();
  await other.getByText("You left Stadium 2. Pick a stadium to judge again.").waitFor({ timeout: 20000 });
  check("with no match at the stadium, leaving needs no confirmation and keeps the chosen name", (await other.getByLabel("Your name").inputValue()) === "Table 2");
  await card("Stadium 2").getByText("Awaiting judge...").waitFor({ timeout: 15000 });

  // ------------------------------------------------------------------------------------------
  // The device moves on after a result; disconnecting
  // ------------------------------------------------------------------------------------------
  // Stadium 1's match finishes (written to the database: see the top) and C is called there.
  await sql`update app.matches set state = 'complete', scores = '4 - 0', winner_challonge_id = ${pid("Jordan")}, call_status = 'none', stadium_id = null where id = ${matchId.A}`;
  await sql`update app.matches set stadium_id = ${stadiums[0].id}, call_status = 'called', called_at = now(), call_count = 1 where id = ${matchId.C}`;
  await sql`update app.tournaments set board_version = board_version + 1 where id = ${tid}`;
  await relief.goto(`${BASE}/t/${slug}/judge`);
  await relief.waitForURL(`**/t/${slug}/judge/${matchId.C}`, { timeout: 20000 });
  check("after a result the device moves on to the next match at its stadium", (await relief.getByRole("heading", { name: "Quinn" }).count()) === 1 && (await relief.getByRole("button", { name: "Start match" }).count()) === 1);
  const finished = await relief.request.post(`${BASE}/api/matches/${matchId.A}/battles`, { data: { ops: [{ op: "add", opId: randomUUID(), kind: "spin", side: 2 }] }, headers: { origin: BASE } });
  check("a judge can't touch a finished match", finished.status() === 404 && (await battlesOf("A")).join() === battlesAfterSwitch);

  // The back link leaves the pad without bouncing straight back in.
  await relief.getByRole("link", { name: "Stadium 1" }).click();
  await relief.getByRole("heading", { name: "Judge · Stadium 1" }).waitFor();
  await relief.waitForTimeout(1500);
  check("the pad's back link shows the stadium screen, with a way back into the pad", relief.url().includes("/judge?stay=1") && (await relief.getByRole("link", { name: "Open the pad" }).count()) === 1);

  await cardMenu("Stadium 1", "Disconnect judge pad");
  await relief.getByText("The organizer disconnected this device. Pick your stadium to ask again.").waitFor({ timeout: 20000 });
  check("a disconnected device is sent back to sign-up and told why", (await relief.getByRole("heading", { name: "Judge sign-up" }).count()) === 1);
  check("the disconnected device's cookie no longer works", (await relief.request.post(`${BASE}/api/matches/${matchId.C}/battles`, { data: { ops: [] }, headers: { origin: BASE } })).status() === 401);
  await card("Stadium 1").getByText("Awaiting judge...").waitFor();
  check("the stadium is back to having no judge, so its called match can't start", await start1.isDisabled());

  // ------------------------------------------------------------------------------------------
  // The organizer's own pad
  // ------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/tournaments/${tid}/matches/${matchId.C}`);
  await page.getByRole("heading", { name: "Battle log" }).waitFor();
  const blocked = await reading(page.getByRole("region", { name: "Start the match" }));
  check("the organizer's pad explains why a match without a judge can't start", blocked.includes("This stadium has no judge yet.") && (await page.getByRole("button", { name: "Start match" }).isDisabled()));
  await page.goto(`${BASE}/tournaments/${tid}`);
  await cardMenu("Stadium 1", "Judge here myself");
  await card("Stadium 1").getByText("Judge: you").waitFor();
  await page.goto(`${BASE}/tournaments/${tid}/matches/${matchId.C}`);
  await page.getByRole("button", { name: "Start match" }).click();
  await page.getByRole("button", { name: "Spin for Quinn, plus 1" }).click();
  await page.locator("header [role=status]").filter({ hasText: "Saved" }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  check("judging a stadium yourself lets you start and score from your own pad", (await one("C")).call_status === "playing" && (await battlesOf("C")).join() === "spin:1");
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 900));
  await shot(page, "error").catch(() => {});
} finally {
  await browser.close();
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
