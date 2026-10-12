// End-to-end check of the control room in a real browser: layout, recall, manual on-deck,
// back to queue, hold and cancel. Same prerequisites as offline-pad.e2e.mjs:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/control-room.e2e.mjs
//
// Set E2E_SCREENSHOTS=<folder> to save before/after screenshots.
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

// --- A venue in mid-event: 4 stadiums, live scores, a queue, one failed send ---
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const tid = randomUUID();
const connectionId = randomUUID();
const names = ["Jordan", "Riley", "Alex", "Sam", "Quinn", "Drew", "Casey", "Morgan", "Taylor", "Jamie", "Avery", "Parker", "Rowan", "Skyler", "Emerson", "Hayden", "Finley", "Reese", "Blake", "Cameron", "Dana", "Kai"];
const pid = (name) => String(1000 + names.indexOf(name));
const stadiums = [1, 2, 3, 4].map((n) => ({ id: randomUUID(), name: `Stadium ${n}`, position: n }));
const rules = { points: { spin: 1, over: 2, burst: 2, xtreme: 3 }, ownFinishPoints: null, targetPoints: 4, bestOfSets: 1, capAtTarget: false, launchErrorPenalty: { strikes: 2, points: 1 }, profileName: "First to 4" };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000);

// [letter, round, order, state, p1, p2, stadium index, call status]
const plan = [
  ["A", 1, 1, "open", "Jordan", "Riley", 0, "playing"],
  ["B", 1, 2, "open", "Alex", "Sam", 1, "playing"],
  ["C", 1, 3, "open", "Quinn", "Drew", 2, "called"],
  ["D", 1, 4, "open", "Casey", "Morgan", 0, "on_deck"],
  ["E", 1, 5, "open", "Taylor", "Jamie", 1, "on_deck"],
  ["F", 1, 6, "open", "Avery", "Parker", 2, "on_deck"],
  ["G", 1, 7, "open", "Rowan", "Skyler", 3, "on_deck"],
  ["H", 1, 8, "open", "Emerson", "Hayden", null, "none"],
  ["R", -1, 9, "open", "Finley", "Reese", null, "none"],
  ["S", -1, 10, "open", "Blake", "Cameron", null, "none"],
  ["I", 2, 13, "pending", "Dana", null, null, "none"],
  ["Z", 1, 0, "complete", "Dana", "Kai", null, "none"],
  // Later rounds exist so round labels read "Winners R1" rather than "Final".
  ["M", 3, 23, "pending", null, null, null, "none"],
  ["O", 4, 28, "pending", null, null, null, "none"],
  ["P", 5, 30, "pending", null, null, null, "none"],
  ["V", -2, 20, "pending", null, null, null, "none"],
];
const matchId = Object.fromEntries(plan.map(([letter]) => [letter, randomUUID()]));

await sql`insert into app.challonge_connections (id, organizer_id, client_id, client_secret_enc, status, challonge_username)
  values (${connectionId}, ${userId}, 'e2e-client', 'v1.x.x.x', 'credentials_saved', 'e2e')`;
await sql`insert into app.api_usage (connection_id, month, count) values (${connectionId}, ${new Date().toISOString().slice(0, 7)}, 132)`;
await sql`insert into app.tournaments (id, organizer_id, challonge_id, challonge_url, name, state, tournament_type, participants_count, auto_call, auto_on_deck, last_synced_at)
  values (${tid}, ${userId}, '999', 'e2e_bracket', 'Autumn Clash', 'underway', 'double elimination', ${names.length}, false, true, ${ago(2)})`;
for (const name of names) {
  await sql`insert into app.participants (tournament_id, challonge_id, name) values (${tid}, ${pid(name)}, ${name})`;
}
for (const s of stadiums) {
  await sql`insert into app.stadiums (id, tournament_id, name, position) values (${s.id}, ${tid}, ${s.name}, ${s.position})`;
}
for (const [letter, round, order, state, p1, p2, stadium, call] of plan) {
  const atStadium = stadium === null ? null : stadiums[stadium].id;
  const current = call === "playing" || call === "called";
  await sql`insert into app.matches (id, tournament_id, challonge_id, identifier, round, suggested_play_order, state,
      player1_challonge_id, player2_challonge_id, winner_challonge_id, scores, stadium_id, call_status, called_at, call_count, held, rule_snapshot)
    values (${matchId[letter]}, ${tid}, ${"7" + order + letter.charCodeAt(0)}, ${letter}, ${round}, ${order}, ${state},
      ${p1 ? pid(p1) : null}, ${p2 ? pid(p2) : null}, ${state === "complete" ? pid(p1) : null}, ${state === "complete" ? "4 - 1" : null},
      ${atStadium}, ${call}, ${current ? ago(2) : null}, ${current ? 1 : 0}, ${letter === "S"}, ${call === "playing" ? sql.json(rules) : null})`;
}
const battle = (letter, kind, side) =>
  sql`insert into app.battles (match_id, op_id, kind, side, created_by) values (${matchId[letter]}, ${randomUUID()}, ${kind}, ${side}, ${userId})`;
await battle("A", "over", 1);
await battle("A", "xtreme", 2); // Jordan 2–3 Riley
await battle("B", "xtreme", 1);
await battle("B", "spin", 2); // Alex 3–1 Sam
await sql`insert into app.sync_outbox (tournament_id, match_id, kind, payload, status, attempts, last_error, created_by)
  values (${tid}, ${matchId.Z}, 'report_result', ${sql.json({ winnerId: pid("Dana"), loserId: pid("Kai"), entries: [] })}, 'failed', 1, 'Challonge returned an error (500). Try again in a moment.', ${userId})`;

const one = async (letter) => (await sql`select * from app.matches where id = ${matchId[letter]}`)[0];
const activeBattles = async (letter) => (await sql`select 1 from app.battles where match_id = ${matchId[letter]} and voided_at is null`).length;

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const card = (name) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
const cardMenu = async (name, item) => {
  await page.getByRole("button", { name: `${name} actions` }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const rowMenu = async (players, item) => {
  await page.getByRole("button", { name: new RegExp(`Actions for .*${players}`) }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
};
const queueRow = (players) => page.getByRole("row").filter({ hasText: players });
const shot = async (name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }));

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments/${tid}`);
  await page.waitForURL(`**/tournaments/${tid}`);
  await page.getByRole("heading", { name: "Control room" }).waitFor();
  await page.waitForTimeout(500);
  await shot("1-initial");

  // --- Layout from the mockup ---
  check("header shows the tournament name, sync time and Resync", (await page.locator("header").textContent()).includes("Autumn Clash") && (await page.getByText(/Synced 2 minutes ago/).count()) === 1 && (await page.getByRole("button", { name: "Resync" }).count()) === 1);
  check("the API budget is no longer in the header", (await page.getByText("Challonge API budget").count()) === 0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const navText = await page.getByRole("dialog", { name: "Navigation" }).textContent();
  check("the API budget is in the side navigation", navText.includes("Challonge API budget") && navText.includes("132 / 500") && navText.includes("This month"));
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Navigation" }).waitFor({ state: "hidden" });
  check("app navigation bar is hidden on this page", (await page.getByRole("navigation", { name: "Main" }).count()) === 0 && (await page.getByRole("button", { name: "Sign out" }).count()) === 0);
  const titleBox = await page.getByRole("heading", { name: "Control room" }).boundingBox();
  const menuBox = await page.getByRole("button", { name: "Open navigation" }).boundingBox();
  check("the header has no return link: the menu button is the only thing before the title", (await page.locator("header").getByRole("link").count()) === 0 && menuBox.x < titleBox.x && titleBox.x - (menuBox.x + menuBox.width) < 40);
  const s1 = await card("Stadium 1").textContent();
  check("stadium card shows players and live score", s1.includes("Jordan vs Riley") && s1.includes("2–3") && s1.toLowerCase().includes("playing"), s1.slice(0, 90));
  check("no broken or empty label parts on any card", !(await page.getByRole("main").textContent()).match(/undefined|NaN|· ·/));
  await page.getByRole("button", { name: "Stadium 1 actions" }).click();
  const padItem = page.getByRole("menuitem", { name: "Open judge pad" });
  check("Open judge pad lives in the stadium menu and links to the pad", (await padItem.getAttribute("href")) === `/tournaments/${tid}/matches/${matchId.A}` && (await card("Stadium 1").getByRole("link", { name: "Open judge pad" }).count()) === 0);
  check("Start is no longer a menu item", (await page.getByRole("menuitem", { name: /start/i }).count()) === 0);
  await page.keyboard.press("Escape");
  // While a menu is open the page behind it is inert; wait for it to close before looking.
  await page.getByRole("menu").waitFor({ state: "hidden" });
  const backButton = card("Stadium 1").getByRole("button", { name: "Send back to queue" });
  await backButton.waitFor();
  const deckBox = await card("Stadium 1").getByText("Casey vs Morgan").boundingBox();
  const backBox = await backButton.boundingBox();
  check("Send back to queue is a full-width button under the on-deck players", backBox.y > deckBox.y && backBox.width > 200, `${Math.round(backBox.width)}px wide`);
  const startBox = await card("Stadium 3").getByRole("button", { name: "Start match" }).boundingBox();
  const recallBox = await card("Stadium 3").getByRole("button", { name: "Recall players" }).boundingBox();
  check("Start sits left of Recall on the same row and is wider", Math.abs(startBox.y - recallBox.y) < 2 && startBox.x < recallBox.x && startBox.width > recallBox.width * 1.5, `start ${Math.round(startBox.width)}px, recall ${Math.round(recallBox.width)}px`);
  check("match labels combine number and letter", s1.includes("M1 · A") && s1.includes("Winners R1"));
  check("busy stadium shows a status line instead of Call players", s1.includes("You can call them once this stadium is free.") && (await card("Stadium 1").getByRole("button", { name: "Call players" }).count()) === 0);
  check("free stadium with a match on deck offers Call players", (await card("Stadium 4").getByRole("button", { name: "Call players" }).count()) === 1);
  const headers = await page.getByRole("columnheader").allTextContents();
  check("queue is a table with the mockup's columns", ["Match", "Round", "Players", "Status", "Stadium"].every((h) => headers.includes(h)), headers.join("|"));
  check("queue shows ready, held and pending rows", (await queueRow("Emerson vs Hayden").textContent()).includes("Ready") && (await queueRow("Blake vs Cameron").textContent()).includes("Held") && (await queueRow("Dana vs TBD").textContent()).includes("Pending"));
  check("ready rows say Next free while filling is automatic", (await queueRow("Emerson vs Hayden").textContent()).includes("Next free"));
  const side = await page.getByRole("complementary").textContent();
  check("sidebar has the problem, waiting and rule profile panels", side.includes("1 result needs you") && side.includes("Dana vs Kai") && side.includes("Waiting to sync to Challonge") && side.includes("Rule profile") && side.includes("Xtreme 3"));

  // --- Latest battle, and where Add stadium lives ---
  check("stadium card shows the latest battle under the score", s1.includes("Latest battle: Riley · Xtreme +3") && (await card("Stadium 3").getByText("Latest battle").count()) === 0, s1.slice(0, 120));
  const settingsBox = await page.getByRole("button", { name: "Venue settings" }).boundingBox();
  const addBox = await page.getByRole("button", { name: "Add stadium" }).first().boundingBox();
  const boardLinkBox = await page.getByRole("link", { name: "Open call board" }).boundingBox();
  check("Add stadium sits between Venue settings and Open call board", settingsBox.x < addBox.x && addBox.x < boardLinkBox.x && Math.abs(addBox.y - settingsBox.y) < 6);
  const tileBox = await page.getByRole("button", { name: "Add stadium" }).last().boundingBox();
  const lastCardBox = await card("Stadium 4").boundingBox();
  check("the Add stadium tile is the same size as a stadium card", Math.abs(tileBox.width - lastCardBox.width) < 2 && Math.abs(tileBox.height - lastCardBox.height) < 2 && tileBox.x > lastCardBox.x, `tile ${Math.round(tileBox.width)}x${Math.round(tileBox.height)}, card ${Math.round(lastCardBox.width)}x${Math.round(lastCardBox.height)}`);
  await page.getByRole("button", { name: "Venue settings" }).click();
  check("Add stadium is no longer inside Venue settings", (await page.locator("#venue-settings").getByRole("button", { name: "Add stadium" }).count()) === 0);
  await page.getByRole("button", { name: "Venue settings" }).click();

  // --- Call board: banner as in the mockup ---
  const board = await context.newPage();
  const boardChecks = [];
  board.on("request", (request) => {
    if (request.url().includes("/api/public/")) boardChecks.push(Date.now());
  });
  await board.goto(`${BASE}/t/${(await sql`select public_slug from app.tournaments where id = ${tid}`)[0].public_slug}/board`);
  const bannerEl = board.getByLabel("Now calling");
  await bannerEl.waitFor();
  const headerText = await board.locator("header").textContent();
  check("board header shows the tournament and the round of the latest call", headerText.includes("Autumn Clash") && headerText.includes("Winners R1"), headerText.slice(0, 60));
  const stadiumBox = await bannerEl.getByText("Stadium 3").boundingBox();
  const dividerBox = await bannerEl.locator("span[aria-hidden]").first().boundingBox();
  const namesBox = await bannerEl.getByText("Quinn").boundingBox();
  check("banner has the divider between the stadium and the players", dividerBox.width <= 6 && dividerBox.height > 40 && stadiumBox.x + stadiumBox.width <= dividerBox.x && dividerBox.x < namesBox.x);
  const roundBox = await bannerEl.getByText("Winners R1", { exact: true }).boundingBox();
  const matchBox = await bannerEl.getByText("Match 3 · C", { exact: true }).boundingBox();
  check("banner's right label is two right-aligned lines: round over match", matchBox.y > roundBox.y && Math.abs(roundBox.x + roundBox.width - (matchBox.x + matchBox.width)) < 2 && roundBox.x > namesBox.x);
  check("board shows the latest battle under each live score", (await board.getByText("Latest battle:").count()) === 2 && (await board.locator("article").filter({ hasText: "Stadium 1" }).textContent()).includes("Latest battle: Riley · Xtreme +3"));
  if (SHOTS) await board.screenshot({ path: path.join(SHOTS, "board.png") });

  // --- Realtime: a connected board stops polling, and still shows a change at once ---
  // Polling alone asks every 2.5 s, so a 6 s gap only happens once the channel is connected.
  let quiet = false;
  for (const deadline = Date.now() + 20000; !quiet && Date.now() < deadline; ) {
    quiet = Date.now() - (boardChecks.at(-1) ?? 0) >= 6000;
    if (!quiet) await board.waitForTimeout(250);
  }
  check("a board connected to Realtime stops polling every few seconds", quiet);
  const pushedAt = Date.now();
  await sql`update app.tournaments set name = 'Autumn Clash Finals', board_version = board_version + 1 where id = ${tid}`;
  await board.getByRole("heading", { name: "Autumn Clash Finals" }).waitFor({ timeout: 10000 }).catch(() => {});
  const pushMs = Date.now() - pushedAt;
  check("a change reaches the board through the push, long before the 60 s safety check", pushMs < 3000, `${pushMs}ms`);
  await sql`update app.tournaments set name = 'Autumn Clash', board_version = board_version + 1 where id = ${tid}`;
  await board.getByRole("heading", { name: "Autumn Clash", exact: true }).waitFor({ timeout: 10000 });

  // --- Recall ---
  const recall3 = card("Stadium 3").getByRole("button", { name: "Recall players" });
  const timer3 = card("Stadium 3").getByRole("timer");
  check("a match called a while ago shows no countdown and can be recalled", (await timer3.count()) === 0 && (await recall3.isEnabled()));
  await recall3.click();

  // The cooldown counts down by itself, under the Now buttons, and locks Recall meanwhile.
  await timer3.waitFor();
  const secondsLeft = async () => Number((await timer3.textContent()).match(/(\d+)s/)[1]);
  const first = await secondsLeft();
  const recallBox3 = await recall3.boundingBox();
  const buttonsBottom = recallBox3.y + recallBox3.height;
  const onDeckTop = (await card("Stadium 3").getByText("On deck", { exact: true }).boundingBox()).y;
  const timerBox = await timer3.boundingBox();
  check("countdown appears by itself after a call", first > 5 && first <= 15 && /^Just called\. .*available in \d+s$/.test(await timer3.textContent()), await timer3.textContent());
  check("countdown sits under the Now buttons, above On deck", timerBox.y >= buttonsBottom && timerBox.y < onDeckTop, `buttons end ${Math.round(buttonsBottom)}, timer ${Math.round(timerBox.y)}, on deck ${Math.round(onDeckTop)}`);
  // A successful recall has no message of its own: the card's detail line and the countdown say it.
  const card3 = await card("Stadium 3").textContent();
  check("a successful recall shows the call number on the card and no separate message", card3.includes("Second call") && !card3.includes("announced"));
  check("Recall is disabled while the countdown runs", await recall3.isDisabled());
  await page.waitForTimeout(2300);
  const later = await secondsLeft();
  check("countdown ticks down in real time", first - later >= 2 && first - later <= 3, `${first}s to ${later}s after 2.3s`);
  if (process.env.E2E_SCREENSHOTS) await card("Stadium 3").screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, "countdown.png") });
  const recalled = await one("C");
  check("recall counts the second call and keeps the match at its stadium", recalled.call_count === 2 && recalled.call_status === "called" && recalled.stadium_id === stadiums[2].id);
  await card("Stadium 3").getByText(/Second call/).first().waitFor();
  await board.getByText("Second call").first().waitFor({ timeout: 15000 });
  check("the call board announces it as the second call", (await board.getByLabel("Now calling").textContent()).includes("Quinn"));
  await board.close();
  await timer3.waitFor({ state: "hidden", timeout: 20000 });
  check("when the countdown ends it disappears and Recall is available again", (await recall3.isEnabled()) && (await one("C")).call_count === 2);

  // --- Start from the card ---
  await card("Stadium 3").getByRole("button", { name: "Start match" }).click();
  await card("Stadium 3").getByText("playing", { exact: true }).waitFor();
  check("Start match marks the called match as playing and removes Start and Recall", (await one("C")).call_status === "playing" && (await card("Stadium 3").getByRole("button", { name: /Start match|Recall/ }).count()) === 0);

  // --- Call players on the free stadium ---
  await card("Stadium 4").getByRole("button", { name: "Call players" }).click();
  await card("Stadium 4").getByText("called", { exact: true }).waitFor();
  check("calling fills the next on-deck slot automatically", (await card("Stadium 4").textContent()).includes("Emerson vs Hayden"));
  await card("Stadium 4").getByRole("timer").waitFor();
  check("a first call starts the countdown too, with Recall locked", await card("Stadium 4").getByRole("button", { name: "Recall players" }).isDisabled());

  // --- Back to queue (automatic filling: skipped once) ---
  await card("Stadium 1").getByRole("button", { name: "Send back to queue" }).click();
  await card("Stadium 1").getByText("Finley vs Reese").waitFor();
  const firstRow = await page.getByRole("row").nth(1).textContent();
  check("on-deck match sent back is replaced by the next one and waits first in the queue", firstRow.includes("Casey vs Morgan") && (await one("D")).call_status === "none", firstRow.slice(0, 60));

  // --- Queue hold / release ---
  await rowMenu("Casey vs Morgan", "Hold");
  await queueRow("Casey vs Morgan").getByText("Held").waitFor();
  await rowMenu("Casey vs Morgan", "Release to queue");
  await queueRow("Casey vs Morgan").getByText("Ready").waitFor();
  check("a queued match can be held and released", (await one("D")).held === false);

  // --- Manual on-deck ---
  await page.getByRole("button", { name: "Venue settings" }).click();
  await page.getByRole("switch", { name: /Fill on deck automatically/ }).uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Saved.").waitFor();
  await page.getByRole("button", { name: "Venue settings" }).click();
  await card("Stadium 2").getByRole("button", { name: "Send back to queue" }).click();
  await card("Stadium 2").getByText("Empty. Place a match here from the queue.").waitFor();
  check("with manual filling, an emptied slot stays empty and rows stop promising a stadium", (await one("E")).call_status === "none" && !(await queueRow("Casey vs Morgan").textContent()).includes("Next free"));
  await rowMenu("Casey vs Morgan", "Stadium 2");
  await card("Stadium 2").getByText("Casey vs Morgan").waitFor();
  check("the organizer placed a chosen match on deck by hand", (await one("D")).call_status === "on_deck" && (await one("D")).stadium_id === stadiums[1].id);

  // --- Hold a match in progress ---
  await cardMenu("Stadium 1", "Hold match (keeps battles)");
  await queueRow("Jordan vs Riley").getByText("Held").waitFor();
  check("holding a match in progress keeps its battles and frees the stadium", (await activeBattles("A")) === 2 && (await one("A")).call_status === "none" && (await card("Stadium 1").textContent()).toLowerCase().includes("free"));

  // --- Cancel a match in progress ---
  await cardMenu("Stadium 2", "Cancel match…");
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  check("cancel asks first and says how many battles are voided", (await dialog.textContent()).includes("Alex vs Sam") && (await dialog.textContent()).includes("2 recorded battles will be voided"));
  await shot("2-cancel-dialog");
  await dialog.getByRole("button", { name: "Cancel match" }).click();
  await queueRow("Alex vs Sam").getByText("Held").waitFor();
  const cancelled = await one("B");
  check("cancelling voids the battles and holds the match at 0–0", (await activeBattles("B")) === 0 && cancelled.held && cancelled.rule_snapshot === null && (await sql`select 1 from app.battles where match_id = ${matchId.B} and void_reason = 'cancelled'`).length === 2);

  // --- Add stadium, from the tile and from the heading button ---
  await page.getByRole("button", { name: "Add stadium" }).last().click();
  await card("Stadium 5").waitFor();
  await page.getByRole("button", { name: "Add stadium" }).first().click();
  await card("Stadium 6").waitFor();
  const stadiumCount = (await sql`select 1 from app.stadiums where tournament_id = ${tid}`).length;
  check("both Add stadium controls create a stadium, and the tile stays last", stadiumCount === 6 && (await page.getByRole("region", { name: "Stadiums" }).getByRole("listitem").last().textContent()).includes("Add stadium"), `${stadiumCount} stadiums`);

  await page.waitForTimeout(400);
  await shot("3-after");

  // --- Back to the tournaments list, through the side navigation ---
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Tournaments" }).click();
  await page.waitForURL("**/tournaments");
  check("the side navigation leads back to the tournaments list", (await page.getByRole("heading", { name: "Tournaments", exact: true }).count()) === 1);
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 400));
  await shot("error").catch(() => {});
} finally {
  await browser.close();
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
