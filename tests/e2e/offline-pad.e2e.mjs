// End-to-end check of the offline judge pad in a real browser (your installed Edge or Chrome).
//
//   1. npm run supabase:start
//   2. npm run build && npx next start -p 3100      (a production build: dev mode isn't cacheable)
//   3. npm run test:e2e
//
// It signs in with a one-time link, seeds a small bracket for a throwaway organizer, then goes
// offline mid-match, reloads while offline, finishes the match offline and reconnects.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";
import postgres from "postgres";

process.loadEnvFile(".env.local");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const CHANNEL = process.env.E2E_BROWSER ?? "msedge";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// --- A throwaway organizer, signed in through the app's own confirm route ---
const status = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const secret = status.match(/^SECRET_KEY="?([^"\r\n]+)/m)?.[1] ?? status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)/m)?.[1];
if (!secret) throw new Error("Couldn't read the local Supabase secret key. Is `npm run supabase:start` running?");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, secret, { auth: { persistSession: false } });
const email = `e2e+${Date.now()}@example.test`;
// Create the user first: for a brand-new email Supabase issues a "signup" token, not a magic link.
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, email_confirm: true });
if (createError) throw createError;
const userId = created.user.id;
const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
if (linkError) throw linkError;

const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const tid = randomUUID();
const matchA = randomUUID();
const matchB = randomUUID();
const stadium = randomUUID();
await sql`insert into app.tournaments (id, organizer_id, challonge_id, challonge_url, name, state, tournament_type, participants_count)
  values (${tid}, ${userId}, '999', 'e2e_bracket', 'E2E Cup', 'underway', 'single elimination', 4)`;
await sql`insert into app.participants (tournament_id, challonge_id, name, seed) values
  (${tid}, '1001', 'Blader 01', 1), (${tid}, '1004', 'Blader 04', 4), (${tid}, '1002', 'Blader 02', 2), (${tid}, '1003', 'Blader 03', 3)`;
await sql`insert into app.stadiums (id, tournament_id, name, position) values (${stadium}, ${tid}, 'Stadium 1', 1)`;
// A called match can only be started while its stadium has a judge: here, the organizer.
await sql`insert into app.judge_screens (tournament_id, stadium_id, status, by_organizer, device, name, approved_at) values (${tid}, ${stadium}, 'approved', true, 'You', 'You', now())`;
await sql`insert into app.matches (id, tournament_id, challonge_id, identifier, round, suggested_play_order, state, player1_challonge_id, player2_challonge_id, stadium_id, call_status, called_at) values
  (${matchA}, ${tid}, '5001', 'A', 1, 1, 'open', '1001', '1004', null, 'none', null),
  (${matchB}, ${tid}, '5002', 'B', 1, 2, 'open', '1002', '1003', ${stadium}, 'called', now())`;

const activeBattles = async (matchId) =>
  (await sql`select kind, side from app.battles where match_id = ${matchId} and voided_at is null order by seq`).map((b) => `${b.kind}:${b.side}`);

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
const page = await context.newPage();
const padA = `${BASE}/tournaments/${tid}/matches/${matchA}`;
const padB = `${BASE}/tournaments/${tid}/matches/${matchB}`;
const statusChip = page.locator("header [role=status]");
const tap = (label) => page.getByRole("button", { name: label }).click();

try {
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments/${tid}`);
  await page.waitForURL(`**/tournaments/${tid}`);
  await page.getByRole("heading", { name: "Control room" }).waitFor();
  check("signed in and landed in the control room", (await page.locator("header").textContent()).includes("E2E Cup"));

  // The control room asks the service worker to pre-load pads of matches at stadiums (match B).
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  await page.waitForFunction(
    async (path) => Boolean(await (await caches.open("judge-pad-v1")).match(path)),
    new URL(padB).pathname,
    { timeout: 15000 },
  );
  check("control room pre-loaded the pad of the match at the stadium", true);

  // --- Online: open pad A and record one battle ---
  await page.goto(padA);
  await page.getByRole("heading", { name: "Battle log" }).waitFor();
  await tap("Xtreme for Blader 01, plus 3");
  await page.waitForFunction(() => document.querySelector("header [role=status]")?.textContent?.includes("Saved"));
  await page.waitForTimeout(300);
  check("online tap is saved on the server", (await activeBattles(matchA)).join() === "xtreme:1", (await activeBattles(matchA)).join());

  // --- Go offline mid-match ---
  await context.setOffline(true);
  await tap("Spin for Blader 04, plus 1");
  await statusChip.filter({ hasText: "Offline" }).waitFor({ timeout: 20000 });
  check("offline tap shows immediately and is marked as saved on the device", (await statusChip.textContent()).includes("1 saved on this device"), await statusChip.textContent());
  check("the score reflects the offline tap", (await page.getByLabel("1 points").count()) === 1 && (await page.getByLabel("3 points").count()) === 1);
  check("the server hasn't received it", (await activeBattles(matchA)).length === 1);

  // --- Reload while offline: the pad comes back from the cache with nothing lost ---
  await page.reload();
  await page.getByRole("heading", { name: "Battle log" }).waitFor({ timeout: 20000 });
  await page.getByText("2 battles").waitFor({ timeout: 10000 });
  check("pad reloads offline with both battles", (await page.getByLabel("3 points").count()) === 1 && (await page.getByLabel("1 points").count()) === 1);

  // --- Finish the match offline and ask to send the result ---
  await tap("Spin for Blader 01, plus 1");
  await page.getByRole("dialog").waitFor();
  check("target reached opens the result dialog offline", (await page.getByRole("dialog").textContent()).includes("Blader 01 wins 4–1"));
  await page.getByRole("button", { name: "Send to Challonge" }).click();
  await page.getByText("will be sent to Challonge automatically").waitFor({ timeout: 20000 });
  check("result is queued with a clear offline message", (await page.getByRole("button", { name: "Waiting for connection…" }).count()) === 1);

  // --- A pad never opened on this device, but pre-loaded by the control room ---
  await page.goto(padB);
  await page.getByRole("heading", { name: "Battle log" }).waitFor({ timeout: 20000 });
  check("a pre-loaded pad opens offline", (await page.getByRole("heading", { name: "Blader 02" }).count()) === 1);
  // This match was called, so it has to be started first: scoring is locked until then.
  const burst = page.getByRole("button", { name: "Burst for Blader 03, plus 2" });
  check("a called match is locked until Start is pressed", (await burst.isDisabled()) && (await page.getByRole("button", { name: "Start match" }).count()) === 1);
  await page.getByRole("button", { name: "Start match" }).click();
  await burst.waitFor({ state: "visible" });
  check("Start unlocks scoring at once, even offline", (await burst.isEnabled()) && (await page.getByRole("button", { name: "Start match" }).count()) === 0);
  await tap("Burst for Blader 03, plus 2");
  await page.getByText("1 battles").waitFor();

  // --- Reconnect: everything syncs by itself, from every match, without touching the pads ---
  await context.setOffline(false);
  await page.waitForFunction(() => document.querySelector("header [role=status]")?.textContent?.includes("Saved"), null, { timeout: 30000 });
  let a = [];
  for (let i = 0; i < 40 && a.length < 3; i++) {
    await page.waitForTimeout(500);
    a = await activeBattles(matchA);
  }
  check("match A's offline battles reached the server in order", a.join() === "xtreme:1,spin:2,spin:1", a.join());
  check("match B's offline battle reached the server", (await activeBattles(matchB)).join() === "burst:2", (await activeBattles(matchB)).join());
  check("the offline Start reached the server too", (await sql`select call_status from app.matches where id = ${matchB}`)[0].call_status === "playing");

  // The throwaway organizer has no Challonge connection, so the queued result is refused: it must
  // be kept as a visible problem, not retried forever or silently dropped.
  await page.goto(`${BASE}/tournaments/${tid}`);
  const waiting = page.getByRole("region", { name: "Waiting to sync to Challonge" });
  await waiting.getByText("Not sent").waitFor({ timeout: 30000 });
  const waitingText = await waiting.textContent();
  check("control room lists the result that couldn't be sent, with the reason", waitingText.includes("Blader 01 vs Blader 04") && waitingText.includes("Connect your Challonge account"), waitingText.slice(0, 200));
  const sends = await sql`select status, attempts from app.sync_outbox where match_id = ${matchA}`;
  check("the refused result wasn't retried in a loop", sends.length <= 1, `${sends.length} outbox rows`);

  // --- Signing out drops the cached pads ---
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Tournaments" }).click();
  await page.waitForURL("**/tournaments");
  const deviceBanner = page.getByRole("region", { name: "Results saved on this device" });
  await deviceBanner.waitFor();
  check("other pages still list device-only results in a banner", (await deviceBanner.count()) === 1);
  // Sign out lives in the side navigation.
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/auth/login");
  // Static scripts may be cached again by the login page; what must be gone are the pad pages,
  // which contain the organizer's tournament data.
  const cachedPads = await page.evaluate(async () =>
    (await (await caches.open("judge-pad-v1")).keys()).map((r) => new URL(r.url).pathname).filter((p) => p.startsWith("/tournaments/")),
  );
  check("signing out removes cached pad pages", cachedPads.length === 0, cachedPads.join(", ") || "none left");
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 300));
} finally {
  await browser.close();
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
