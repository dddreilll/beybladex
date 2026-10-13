// S16: a whole event run through BXQ itself against the real Challonge API, which no test does
// (the e2e suites have no Challonge, and the integration tests use a fake one).
// It creates a private "[SPIKE]" 4-player tournament through the API (double elimination, or
// round robin with --format=round-robin), then drives the app in a real browser as an organizer:
// import with the review dialog, a stadium, "Judge here myself", every match scored on the pad and
// sent to Challonge, and Finalize. At the end it reads the tournament from Challonge and compares
// it with what BXQ stored.
//
// Needs: local Supabase running, the app built and started (default http://localhost:3101, or
// BXQ_BASE_URL), `.env.local`, `spikes/.env` and `spikes/out/tokens.json`.
// WRITES: one tournament on the Challonge account (reset and deleted at the end, or kept with
// --keep), and one throwaway organizer in the local database holding the spike's Challonge
// credentials, encrypted the way the app encrypts them (always deleted at the end).
// Guarded: only runs with --confirm. Run it from the repository root.
import { execSync } from 'node:child_process';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';
import postgres from 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
process.loadEnvFile(path.join(root, '.env.local'));
process.loadEnvFile(path.join(here, '.env'));
const { getAccessToken, api, saveFixture, saveSummary, requestCount, OUT } = await import('./lib/challonge.mjs');

if (!process.argv.includes('--confirm')) {
  console.error('This script writes to your Challonge account and to the local database. Re-run with --confirm.');
  process.exit(1);
}
const keep = process.argv.includes('--keep');

// What differs by format: the tournament, what the review dialog says, how many matches the
// import stores, and what a result costs (a bracket is read again after it, a round robin isn't).
const FORMATS = {
  'double-elimination': {
    attributes: { name: '[SPIKE] BXQ full event, 4 players', tournament_type: 'double elimination' },
    review: [/Format double elimination/i, 'Grand finals 1 or 2 matches'],
    matches: 7,
    requestsPerResult: 2
  },
  'round-robin': {
    attributes: { name: '[SPIKE] BXQ full round robin, 4 players', tournament_type: 'round robin', round_robin_options: { iterations: 1, ranking: 'match wins' } },
    review: [/Format round robin/i, 'Plays each opponent Once'],
    matches: 6,
    requestsPerResult: 1
  }
};
const formatName = process.argv.find((a) => a.startsWith('--format='))?.split('=')[1] ?? 'double-elimination';
const format = FORMATS[formatName];
if (!format) {
  console.error(`Unknown format "${formatName}". Use one of: ${Object.keys(FORMATS).join(', ')}.`);
  process.exit(1);
}
const BASE = process.env.BXQ_BASE_URL ?? 'http://localhost:3101';
const SHOTS = path.join(OUT, `s16-shots-${formatName}`);
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const summary = { checks: results };

// The same envelope as lib/crypto/secrets.ts.
const [keyVersion, keyMaterial] = process.env.APP_ENCRYPTION_KEYS.split(',')[0].trim().split(':');
const encrypt = (plaintext, aad) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyMaterial, 'base64'), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [keyVersion, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
};

const token = await getAccessToken();
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
let challongeId = null;
let userId = null;
let browser = null;

async function direct(label, method, pathAndQuery, body) {
  const res = await api(token, method, pathAndQuery, { body });
  await saveFixture(`s16-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

try {
  // --- 1. The tournament, made directly on Challonge ---
  console.log(`\n[1] create and start a 4-player ${format.attributes.tournament_type} tournament on Challonge`);
  const slug = `bxq_spike_s16_${Date.now().toString(36)}`;
  const made = await direct('create', 'POST', '/tournaments.json', {
    data: { type: 'Tournaments', attributes: { ...format.attributes, url: slug, private: true } }
  });
  challongeId = String(made.body.data.id);
  const participants = Array.from({ length: 4 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await direct('participants', 'POST', `/tournaments/${challongeId}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await direct('start', 'PUT', `/tournaments/${challongeId}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start' } } });
  console.log(`    ${challongeId} (https://challonge.com/${slug})`);

  // --- 2. A throwaway organizer whose Challonge connection is the spike's ---
  const status = execSync('npx supabase status -o env', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const secret = status.match(/^SECRET_KEY="?([^"\r\n]+)/m)?.[1] ?? status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)/m)?.[1];
  if (!secret) throw new Error("Couldn't read the local Supabase secret key. Is `npm run supabase:start` running?");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, secret, { auth: { persistSession: false } });
  const email = `s16+${Date.now()}@example.test`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (createError) throw createError;
  userId = created.user.id;
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkError) throw linkError;

  const tokens = JSON.parse(readFileSync(path.join(OUT, 'tokens.json'), 'utf8'));
  const connectionId = randomUUID();
  await sql`insert into app.challonge_connections (id, organizer_id, client_id, client_secret_enc, access_token_enc, refresh_token_enc, token_expires_at, status)
    values (${connectionId}, ${userId}, ${process.env.CHALLONGE_CLIENT_ID}, ${encrypt(process.env.CHALLONGE_CLIENT_SECRET, `${userId}:client_secret`)},
            ${encrypt(tokens.access_token, `${userId}:access_token`)}, ${encrypt(tokens.refresh_token, `${userId}:refresh_token`)},
            ${new Date((tokens.created_at + tokens.expires_in) * 1000)}, 'connected')`;
  const usage = async () => (await sql`select coalesce(sum(count), 0)::int as n from app.api_usage where connection_id = ${connectionId}`)[0].n;

  browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

  // --- 3. Import, through the review dialog ---
  console.log('\n[2] import it in BXQ');
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments`);
  await page.waitForURL('**/tournaments');
  await page.getByLabel('Tournament link or ID').fill(`https://challonge.com/${slug}`);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog');
  await review.waitFor({ timeout: 30000 });
  const reviewText = (await review.innerText()).replace(/\s+/g, ' ');
  check('the review dialog shows the real tournament', format.review.every((expected) => (expected instanceof RegExp ? expected.test(reviewText) : reviewText.includes(expected))) && reviewText.includes('Players 4') && reviewText.includes('Status Underway'), reviewText);
  check('reviewing cost 1 request', (await usage()) === 1, `${await usage()}`);
  await shot('1-review');
  await review.getByRole('button', { name: 'Import' }).click();
  await page.waitForURL(/\/tournaments\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const tid = page.url().split('/').pop();
  await page.getByRole('heading', { name: 'BXQ Desk' }).waitFor();
  const stored = async () => sql`select m.id, m.identifier, m.round, m.state, m.scores, m.call_status, m.winner_challonge_id, m.player1_challonge_id, m.suggested_play_order,
      p1.name as p1, p2.name as p2
    from app.matches m
    left join app.participants p1 on p1.tournament_id = m.tournament_id and p1.challonge_id = m.player1_challonge_id
    left join app.participants p2 on p2.tournament_id = m.tournament_id and p2.challonge_id = m.player2_challonge_id
    where m.tournament_id = ${tid} order by m.suggested_play_order`;
  const imported = await stored();
  check(`the import stored ${format.matches} matches and 4 players, in 3 requests`, imported.length === format.matches && (await sql`select count(*)::int as n from app.participants where tournament_id = ${tid}`)[0].n === 4 && (await usage()) === 3, `${imported.length} matches, ${await usage()} requests`);

  // --- 4. A stadium with the organizer as its judge ---
  console.log('\n[3] one stadium, judged by the organizer');
  await page.getByRole('button', { name: 'Add stadium' }).first().click();
  const stadium = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Stadium 1', exact: true }) });
  await stadium.waitFor();
  await page.getByRole('button', { name: 'Stadium 1 actions' }).click();
  await page.getByRole('menuitem', { name: 'Judge here myself' }).click();
  await stadium.getByText('Judge: you').waitFor();
  const called = async () => {
    for (let i = 0; i < 40; i++) {
      const row = (await stored()).find((m) => m.call_status === 'called' || m.call_status === 'playing');
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  };
  check('the first match is called at the stadium', Boolean(await called()));
  if (formatName === 'round-robin') {
    const queue = await page.getByRole('region', { name: 'Queue' }).innerText();
    check('the Desk calls no round of a round robin a final', /Round 3/.test(queue) && !/\bFinal\b/.test(queue), queue.replace(/\s+/g, ' ').slice(0, 200));
    check('the Desk says a result is one request', (await page.getByText('one request each').count()) === 1);
  }
  await shot('2-desk-first-call');

  // --- 5. Every match: scored on the pad, sent to Challonge ---
  console.log('\n[4] play every match on the pad');
  summary.matches = [];
  for (let played = 0; played < 8; played++) {
    if (!(await stored()).some((m) => m.state === 'open')) break;
    const match = await called();
    if (!match) throw new Error('matches are open but none is called at the stadium');
    const before = await usage();
    await page.goto(`${BASE}/tournaments/${tid}/matches/${match.id}`);
    await page.getByRole('button', { name: 'Start match' }).click();
    await page.getByRole('button', { name: `Xtreme for ${match.p1}, plus 3` }).click();
    await page.getByRole('button', { name: `Spin for ${match.p1}, plus 1` }).click();
    const result = page.getByRole('dialog');
    await result.getByText(`${match.p1} wins`).waitFor();
    if (played === 0) await shot('3-pad-result');
    await result.getByRole('button', { name: 'Send to Challonge' }).click();
    await result.getByText('Result saved on Challonge').waitFor({ timeout: 45000 });
    const after = (await stored()).find((m) => m.id === match.id);
    const cost = (await usage()) - before;
    const ok = after.state === 'complete' && after.winner_challonge_id === match.player1_challonge_id && after.scores === '4 - 0' && cost === format.requestsPerResult;
    check(`${match.identifier} (round ${match.round}): ${match.p1} beat ${match.p2}, saved on Challonge in ${format.requestsPerResult} request${format.requestsPerResult === 1 ? '' : 's'}`, ok, `state ${after.state}, scores ${after.scores}, ${cost} requests`);
    summary.matches.push({ match: match.identifier, round: match.round, winner: match.p1, loser: match.p2, requests: cost, stored: { state: after.state, scores: after.scores } });
    await result.getByRole('link', { name: 'Back to the Desk' }).click();
    await page.waitForURL(`**/tournaments/${tid}`);
  }
  const left = await stored();
  summary.left_unplayed = left.filter((m) => m.state !== 'complete').map((m) => `${m.identifier}:r${m.round}:${m.state}`);
  check('no match is left open', !left.some((m) => m.state === 'open'), summary.left_unplayed.join(', ') || 'all complete');
  await page.getByRole('heading', { name: 'BXQ Desk' }).waitFor();
  await shot('4-desk-all-played');

  // --- 6. Finalize ---
  console.log('\n[5] finalize from the Desk');
  const beforeFinalize = await usage();
  const finalize = page.getByRole('button', { name: 'Finalize tournament' });
  // When the winners-side finalist wins the first grand-finals match, Challonge removes the reset match.
  check('the Desk offers Finalize once nothing is open', await finalize.isEnabled(), summary.left_unplayed.join(', ') || 'no match left unplayed');
  await finalize.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Finalize', exact: true }).click();
  await page.getByText('Finalized', { exact: true }).waitFor({ timeout: 60000 });
  const [tournament] = await sql`select state from app.tournaments where id = ${tid}`;
  const ranks = await sql`select challonge_id, name, final_rank from app.participants where tournament_id = ${tid} order by final_rank, name`;
  const finalizeCost = (await usage()) - beforeFinalize;
  check('BXQ finalized it on Challonge and stored every placement', tournament.state === 'complete' && ranks.every((p) => p.final_rank !== null), `state ${tournament.state}; ${ranks.map((p) => `${p.final_rank}. ${p.name}`).join(', ')}; ${finalizeCost} requests`);
  summary.finalize = { requests: finalizeCost, standings: ranks.map((p) => `${p.final_rank}. ${p.name}`) };
  summary.requests_made_by_bxq = await usage();
  await shot('5-desk-finalized');

  // --- 7. What Challonge has, read directly ---
  console.log('\n[6] compare with Challonge');
  const remote = await direct('tournament-after', 'GET', `/tournaments/${challongeId}.json`);
  const included = remote.body.included ?? [];
  const remoteMatches = new Map(included.filter((r) => r.type === 'match').map((m) => [m.attributes.identifier, m.attributes]));
  const remoteRanks = new Map(included.filter((r) => r.type === 'participant').map((p) => [String(p.id), p.attributes.final_rank]));
  const finalRows = await stored();
  const mismatched = finalRows.filter((m) => {
    const r = remoteMatches.get(m.identifier);
    return !r || r.state !== m.state || (m.state === 'complete' && (String(r.winner_id) !== m.winner_challonge_id || r.scores !== m.scores));
  });
  check('Challonge says the tournament is complete', remote.body.data.attributes.state === 'complete', remote.body.data.attributes.state);
  check('every match on Challonge has the state, winner and score BXQ stored', mismatched.length === 0, mismatched.map((m) => m.identifier).join(', ') || `${finalRows.length} matches`);
  check('every placement on Challonge is the one BXQ stored', ranks.every((p) => remoteRanks.get(p.challonge_id) === p.final_rank), [...remoteRanks.values()].join(', '));
  summary.challonge = {
    state: remote.body.data.attributes.state,
    matches: [...remoteMatches].map(([identifier, a]) => `${identifier}:r${a.round}:${a.state}:${a.scores}`)
  };
} catch (error) {
  summary.error = String(error?.message ?? error);
  check('no unexpected error', false, summary.error.slice(0, 600));
} finally {
  if (browser) await browser.close();
  if (userId) await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
  if (challongeId && keep) console.log(`\nKept ${challongeId} on Challonge. Delete it on challonge.com when you are done.`);
  if (challongeId && !keep) {
    // Challonge refuses to delete a tournament that is underway (422): it goes back to pending first.
    console.log(`\nreset and delete ${challongeId} on Challonge`);
    const reset = await api(token, 'PUT', `/tournaments/${challongeId}/change_state.json`, {
      body: { data: { type: 'TournamentState', attributes: { state: 'reset' } } }
    });
    const res = await api(token, 'DELETE', `/tournaments/${challongeId}.json`);
    if (res.status >= 400) console.error(`    Could not delete ${challongeId} (reset ${reset.status}, delete ${res.status}): ${JSON.stringify(res.body)}. Delete it on challonge.com.`);
    summary.deleted = { reset: reset.status, delete: res.status };
  }
  summary.requests_made_directly = requestCount();
  await saveSummary(`s16-${formatName}`, summary);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log(`Requests: ${summary.requests_made_by_bxq ?? '?'} by BXQ, ${summary.requests_made_directly} directly`);
process.exit(failed ? 1 : 0);
