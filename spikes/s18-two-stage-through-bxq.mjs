// S18: a whole two-stage event run through BXQ itself against the real Challonge API, as S16 does
// for the tournaments with one stage. It creates a private "[SPIKE]" tournament through the API and
// starts its group stage, then drives the app in a real browser as an organizer: import with the
// review dialog, a stadium, "Judge here myself", every group match scored on the pad and sent,
// "End group stage", "Start final stage", every match of the final stage, and Finalize. At the end
// it reads the tournament from Challonge and compares it with what BXQ stored.
//   --groups=round-robin         (the default) 6 players in 2 groups of 3, and a double elimination
//                                final stage. It also reads the tournament list, to see whether a
//                                list item says what the groups play.
//   --groups=swiss               8 players in 2 groups of 4, and a double elimination final stage.
//   --groups=single-elimination  8 players in 2 groups of 4 that are brackets, and a single
//                                elimination final stage. It also reads the participant list during
//                                the group stage, to see whether a participant has a `group_id`
//                                when there are two groups (with one group it was null, spike S19).
//   --groups=double-elimination  The same with double elimination groups.
//   --groups=swiss-big           12 players in 2 Swiss groups of 6, 4 advancing from each to a Swiss
//                                final stage of 8 players and 3 rounds: two stages of Swiss rounds.
// In the first four, 2 players advance from each group.
//   --final=round-robin | swiss  A final stage that is a round robin, or Swiss of 2 rounds, in place
//                                of the variant's bracket (spike S20 played both directly).
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

// What differs by the kind of group: the tournament, what the review dialog says, how many matches
// the import stores, and how the final stage reads on the Desk.
const VARIANTS = {
  'round-robin': {
    stage: 'round robin',
    final: 'double elimination',
    players: 6,
    size: 3,
    matches: 6,
    review: ['Group stage Round robin, groups of 3, top 2 advance', /Final stage double elimination/i, 'Grand finals'],
    groupLabel: 'Round 1',
    finalLabel: 'Winners R1'
  },
  swiss: {
    stage: 'swiss',
    final: 'double elimination',
    players: 8,
    size: 4,
    // Only the first round of each group exists at the start.
    matches: 4,
    review: ['Group stage Swiss, groups of 4, top 2 advance', /Final stage double elimination/i, 'Grand finals'],
    groupLabel: 'Round 1',
    finalLabel: 'Winners R1'
  },
  // Groups that are brackets: a result is read back (2 requests), and a group stops when 2 players
  // are left, so the match between them is never played (spike S19).
  'single-elimination': {
    stage: 'single elimination',
    final: 'single elimination',
    players: 8,
    size: 4,
    matches: 6,
    bracket: true,
    unplayed: 2,
    review: ['Group stage Single elimination, groups of 4, top 2 advance', /Final stage single elimination/i, 'Third-place match No'],
    groupLabel: 'Round 1',
    finalLabel: 'Round 1'
  },
  'double-elimination': {
    stage: 'double elimination',
    final: 'single elimination',
    players: 8,
    size: 4,
    matches: 14,
    bracket: true,
    unplayed: 4,
    review: ['Group stage Double elimination, groups of 4, top 2 advance', /Final stage single elimination/i, 'Third-place match No'],
    groupLabel: 'Winners R1',
    finalLabel: 'Round 1'
  },
  // Two stages of Swiss rounds, and a bigger final stage (8 players).
  'swiss-big': {
    stage: 'swiss',
    final: 'swiss',
    players: 12,
    size: 6,
    advance: 4,
    // Only the first round of each group exists at the start: 3 matches in a group of 6.
    matches: 6,
    review: ['Group stage Swiss, groups of 6, top 4 advance'],
    groupLabel: 'Round 1',
    finalLabel: 'Round 1'
  }
};
// A final stage that isn't a bracket: what to create it with, and what the review dialog says.
const FINALS = {
  'round-robin': { type: 'round robin', options: () => ({ round_robin_options: { iterations: 1, ranking: 'match wins' } }), review: () => [/Final stage round robin/i, 'Plays each opponent Once'] },
  swiss: {
    type: 'swiss',
    // Challonge refuses an incomplete options object (spike S7).
    options: (rounds) => ({ swiss_options: { rounds, pts_for_match_win: 1, pts_for_match_tie: 0.5, pts_for_game_win: 0, pts_for_game_tie: 0, pts_for_bye: 1 } }),
    review: (rounds) => [/Final stage swiss/i, `Rounds ${rounds}`]
  }
};
const name = process.argv.find((a) => a.startsWith('--groups='))?.split('=')[1] ?? 'round-robin';
const variant = VARIANTS[name];
if (!variant) {
  console.error(`Unknown groups "${name}". Use one of: ${Object.keys(VARIANTS).join(', ')}.`);
  process.exit(1);
}
const finalName = process.argv.find((a) => a.startsWith('--final='))?.split('=')[1] ?? (variant.final === 'swiss' ? 'swiss' : null);
if (finalName && !FINALS[finalName]) {
  console.error(`Unknown final "${finalName}". Use one of: ${Object.keys(FINALS).join(', ')}.`);
  process.exit(1);
}
const advance = variant.advance ?? 2;
const finalists = advance * 2;
// A Swiss final stage of 4 plays 2 rounds, of 8 plays 3.
const finalRounds = finalists === 8 ? 3 : 2;
const final = finalName ? { ...FINALS[finalName], options: FINALS[finalName].options(finalRounds), review: FINALS[finalName].review(finalRounds) } : null;
const finalType = final ? final.type : variant.final;
const expectedReview = final ? [variant.review[0], ...final.review] : variant.review;
// A round robin or Swiss final stage's rounds read "Round 1", as in a tournament of that format.
const finalLabel = final ? 'Round 1' : variant.finalLabel;
const run = finalName && finalName !== variant.final.replace(' ', '-') ? `${name}-final-${finalName}` : name;
const BASE = process.env.BXQ_BASE_URL ?? 'http://localhost:3101';
const SHOTS = path.join(OUT, `s18-shots-${run}`);
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ name: label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};
const summary = { groups: name, final: finalType, checks: results };

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
  await saveFixture(`s18-${run}-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

try {
  // --- 1. The tournament, made directly on Challonge, with its group stage started ---
  console.log(`\n[1] create a ${variant.players}-player tournament with ${variant.stage} groups and a ${finalType} final stage, and start its group stage`);
  const slug = `bxq_spike_s18_${Date.now().toString(36)}`;
  const made = await direct('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        // Challonge takes 60 characters at most.
        name: `[SPIKE] BXQ S18 ${run}`,
        url: slug,
        tournament_type: finalType,
        ...(final?.options ?? {}),
        private: true,
        group_stage_enabled: true,
        // An options object that is incomplete is refused (spike S7), so every documented field is sent.
        group_stage_options: {
          stage_type: variant.stage,
          group_size: variant.size,
          participant_count_to_advance_per_group: advance,
          rr_iterations: 1,
          ranked_by: 'match wins',
          rr_pts_for_match_win: 1,
          rr_pts_for_match_tie: 0.5,
          rr_pts_for_game_win: 0,
          rr_pts_for_game_tie: 0,
          split_participants: false
        }
      }
    }
  });
  challongeId = String(made.body.data.id);
  const participants = Array.from({ length: variant.players }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await direct('participants', 'POST', `/tournaments/${challongeId}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await direct('start-group-stage', 'PUT', `/tournaments/${challongeId}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start_group_stage' } } });
  console.log(`    ${challongeId} (https://challonge.com/${slug})`);

  if (name === 'round-robin') {
    // "Show my Challonge tournaments" decides from a list item whether a tournament can be imported.
    const list = await direct('list', 'GET', '/tournaments.json?page=1&per_page=25');
    const item = (list.body.data ?? []).find((t) => String(t.id) === challongeId);
    summary.list_item = { found: Boolean(item), group_stage_enabled: item?.attributes.group_stage_enabled ?? null, group_stage_options: item?.attributes.group_stage_options ?? '(absent)' };
    console.log(`    in the tournament list: group_stage_options ${item?.attributes.group_stage_options ? JSON.stringify(item.attributes.group_stage_options) : 'absent'}`);
  }

  if (name === 'single-elimination') {
    // Challonge's docs give a participant a `group_id` in a group stage. Is it set with two groups?
    const listed = await direct('participants-in-group-stage', 'GET', `/tournaments/${challongeId}/participants.json?page=1&per_page=100`);
    const groupIds = (listed.body.data ?? []).map((p) => `S${p.attributes.seed}:${p.attributes.group_id ?? null}`);
    summary.participant_group_ids = groupIds;
    console.log(`    group_id of each participant, read from the participant list: ${groupIds.join(' ')}`);
  }

  // --- 2. A throwaway organizer whose Challonge connection is the spike's ---
  const status = execSync('npx supabase status -o env', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const secret = status.match(/^SECRET_KEY="?([^"\r\n]+)/m)?.[1] ?? status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)/m)?.[1];
  if (!secret) throw new Error("Couldn't read the local Supabase secret key. Is `npm run supabase:start` running?");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, secret, { auth: { persistSession: false } });
  const email = `s18+${Date.now()}@example.test`;
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const shot = (label) => page.screenshot({ path: path.join(SHOTS, `${label}.png`) });
  const flat = (text) => text.replace(/\s+/g, ' ');

  // --- 3. Import, through the review dialog ---
  console.log('\n[2] import it in BXQ');
  await page.goto(`${BASE}/auth/confirm?token_hash=${link.properties.hashed_token}&type=magiclink&next=/tournaments`);
  await page.waitForURL('**/tournaments');
  await page.getByLabel('Tournament link or ID').fill(`https://challonge.com/${slug}`);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog');
  await review.waitFor({ timeout: 30000 });
  const reviewText = flat(await review.innerText());
  check('the review dialog shows the groups and the final stage', expectedReview.every((expected) => (expected instanceof RegExp ? expected.test(reviewText) : reviewText.includes(expected))) && reviewText.includes(`Players ${variant.players}`) && reviewText.includes('Status Group stage'), reviewText);
  check('reviewing cost 1 request', (await usage()) === 1, `${await usage()}`);
  await shot('1-review');
  await review.getByRole('button', { name: 'Import' }).click();
  await page.waitForURL(/\/tournaments\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const tid = page.url().split('/').pop();
  await page.getByRole('heading', { name: 'BXQ Desk' }).waitFor();
  const stored = async () => sql`select m.id, m.challonge_id, m.identifier, m.round, m.stage, m.group_number, m.state, m.scores, m.call_status, m.winner_challonge_id,
      m.player1_challonge_id, m.suggested_play_order, p1.name as p1, p2.name as p2
    from app.matches m
    left join app.participants p1 on p1.tournament_id = m.tournament_id and p1.challonge_id = m.player1_challonge_id
    left join app.participants p2 on p2.tournament_id = m.tournament_id and p2.challonge_id = m.player2_challonge_id
    where m.tournament_id = ${tid} order by m.stage desc, m.suggested_play_order, m.group_number`;
  const people = () => sql`select challonge_id, name, seed, active, advanced, final_rank, sign_in_token from app.participants where tournament_id = ${tid} order by seed`;
  const tournament = async () => (await sql`select state, started_at, public_slug from app.tournaments where id = ${tid}`)[0];
  const imported = await stored();
  const groupsSeen = [...new Set(imported.map((m) => m.group_number))].sort();
  check(
    `the import stored ${variant.matches} group matches in 2 groups and ${variant.players} players, in 3 requests`,
    imported.length === variant.matches && imported.every((m) => m.stage === 'group') && groupsSeen.join() === '1,2' && (await people()).length === variant.players && (await usage()) === 3,
    `${imported.length} matches, groups ${groupsSeen.join()}, ${await usage()} requests`
  );

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
  const deskText = flat(await page.locator('main').first().innerText());
  check('the Desk names the group of each match', deskText.includes(`Group A · ${variant.groupLabel}`) && deskText.includes(`Group B · ${variant.groupLabel}`), deskText.slice(0, 260));
  const oneEach = await page.getByText('one request each').count();
  check(`the Desk says a group result is ${variant.bracket ? 'two requests, the group being a bracket' : 'one request'}`, oneEach === (variant.bracket ? 0 : 1));
  const end = page.getByRole('button', { name: 'End group stage' });
  check('the Desk offers "End group stage" in place of Finalize, and not yet', (await end.isDisabled()) && (await page.getByRole('button', { name: 'Finalize tournament' }).count()) === 0 && (await page.getByText('No match has been played yet.').count()) === 1);
  await shot('2-desk-group-stage');

  // Scores a called match on the pad, for its first player, and sends it. Gives what that cost.
  async function play(match, first) {
    const before = await usage();
    await page.goto(`${BASE}/tournaments/${tid}/matches/${match.id}`);
    await page.getByRole('button', { name: 'Start match' }).click();
    await page.getByRole('button', { name: `Xtreme for ${match.p1}, plus 3` }).click();
    await page.getByRole('button', { name: `Spin for ${match.p1}, plus 1` }).click();
    const result = page.getByRole('dialog');
    await result.getByText(`${match.p1} wins`).waitFor();
    if (first) await shot(`pad-${match.stage}`);
    await result.getByRole('button', { name: 'Send to Challonge' }).click();
    await result.getByText('Result saved on Challonge').waitFor({ timeout: 45000 });
    const after = (await stored()).find((m) => m.id === match.id);
    const cost = (await usage()) - before;
    await result.getByRole('link', { name: 'Back to the Desk' }).click();
    await page.waitForURL(`**/tournaments/${tid}`);
    return { after, cost };
  }
  const where = (m) => (m.stage === 'group' ? `group ${m.group_number}, ${m.identifier}, round ${m.round}` : `final stage, ${m.identifier}, round ${m.round}`);

  // --- 5. The group stage ---
  console.log('\n[4] play the group stage on the pad');
  summary.group_matches = [];
  for (let played = 0; played < 40; played++) {
    const rows = (await stored()).filter((m) => m.stage === 'group');
    if (!rows.some((m) => m.state === 'open')) break;
    const match = await called();
    if (!match) throw new Error('group matches are open but none is called at the stadium');
    // The last result of a Swiss group's round is followed by a read of that group's next round, or
    // two: when the round is late, and after the group's last round, which nothing announces.
    const group = rows.filter((m) => m.group_number === match.group_number);
    const lastRound = Math.max(...group.map((m) => m.round));
    const endsRound = variant.stage === 'swiss' && match.round === lastRound && group.filter((m) => m.round === lastRound && m.state === 'open').length === 1;
    // In a group that is a bracket every result is followed by a read of the matches.
    const expected = variant.bracket ? [2] : endsRound ? [2, 3] : [1];
    const { after, cost } = await play(match, played === 0);
    const ok = after.state === 'complete' && after.winner_challonge_id === match.player1_challonge_id && after.scores === '4 - 0' && expected.includes(cost);
    check(`${where(match)}: ${match.p1} beat ${match.p2}, saved on Challonge in ${cost} request${cost === 1 ? '' : 's'}${endsRound ? ', the last of its round' : ''}`, ok, `state ${after.state}, scores ${after.scores}`);
    summary.group_matches.push({ match: where(match), winner: match.p1, loser: match.p2, requests: cost, ends_round: endsRound });
  }
  const groupRows = (await stored()).filter((m) => m.stage === 'group');
  summary.group_stage = groupRows.map((m) => `g${m.group_number} ${m.identifier} r${m.round} ${m.state} ${m.p1} v ${m.p2} ${m.scores}`);
  const unplayed = groupRows.filter((m) => m.state !== 'complete');
  check(
    variant.bracket ? `no group match is open: each group stopped with 2 players left, and ${variant.unplayed} matches were never opened` : 'every group match is played, and no match is in the final stage yet',
    !groupRows.some((m) => m.state === 'open') && unplayed.length === (variant.unplayed ?? 0) && unplayed.every((m) => m.state === 'pending') && (await stored()).length === groupRows.length,
    `${groupRows.length} group matches, ${unplayed.length} pending`
  );

  // --- 6. Between the stages ---
  console.log('\n[5] end the group stage, then start the final stage');
  await page.getByRole('heading', { name: 'BXQ Desk' }).waitFor();
  let before = await usage();
  await end.click();
  const ask = page.getByRole('alertdialog');
  const endText = flat(await ask.innerText());
  await shot('3-end-group-stage');
  await ask.getByRole('button', { name: 'End group stage' }).click();
  await page.getByText('The group stage has ended.').first().waitFor({ timeout: 45000 });
  const between = await people();
  const advancing = between.filter((p) => p.advanced).map((p) => p.name);
  const endCost = (await usage()) - before;
  check(
    'ending the group stage took 2 requests, and BXQ knows who advances while everyone stays active',
    endCost === 2 && (await tournament()).state === 'group_stages_finalized' && advancing.length === finalists && between.every((p) => p.active) && /can't be corrected/.test(endText),
    `${endCost} requests; advancing ${advancing.join(', ')}`
  );
  const banner = flat(await page.getByRole('status').filter({ hasText: 'The group stage has ended.' }).innerText());
  check('the Desk lists who advances and offers "Start final stage"', advancing.every((p) => banner.includes(p)) && (await page.getByRole('button', { name: 'Start final stage' }).isEnabled()), banner);
  summary.between = { requests: endCost, advancing, seeds: between.map((p) => `${p.seed}. ${p.name}${p.advanced ? '' : ' (out)'}`) };
  await shot('4-desk-between-stages');

  // What two players see on their Pass, opened with the secret in their QR code.
  const { public_slug: publicSlug } = await tournament();
  const passText = async (player) => {
    const phone = await (await browser.newContext({ viewport: { width: 400, height: 800 } })).newPage();
    await phone.goto(`${BASE}/t/${publicSlug}#k=${player.sign_in_token}`);
    await phone.getByRole('button', { name: 'Not you?' }).waitFor({ timeout: 30000 });
    const text = flat(await phone.locator('body').innerText());
    await phone.screenshot({ path: path.join(SHOTS, `pass-${player.advanced ? 'advanced' : 'out'}.png`) });
    await phone.context().close();
    return text;
  };
  const through = await passText(between.find((p) => p.advanced));
  const out = await passText(between.find((p) => !p.advanced));
  check('a Pass says whether its player advanced', through.includes("You're through to the final stage") && out.includes("You didn't advance to the final stage"), `${through.slice(0, 120)} | ${out.slice(0, 120)}`);

  before = await usage();
  await page.getByRole('button', { name: 'Start final stage' }).click();
  await shot('5-start-final-stage');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start final stage' }).click();
  // Finalize takes the button's place once the final stage has started; what the step answered stays beside it.
  await page.getByRole('button', { name: 'Finalize tournament' }).waitFor({ timeout: 60000 });
  check('the Desk says the final stage has started', (await page.getByText('The final stage has started.').count()) === 1);
  const startCost = (await usage()) - before;
  const afterStart = await stored();
  const finals = afterStart.filter((m) => m.stage === 'final');
  check(
    'starting the final stage took 2 requests, and its matches are told from the groups',
    startCost === 2 && (await tournament()).state === 'underway' && finals.length >= 2 && finals.every((m) => m.group_number === null) && afterStart.filter((m) => m.stage === 'group').length === groupRows.length,
    `${startCost} requests; ${finals.length} matches in the final stage, ${afterStart.length - finals.length} in the groups`
  );
  check('the first match of the final stage is called at the stadium', (await called())?.stage === 'final');
  await page.reload();
  const finalDesk = flat(await page.locator('main').first().innerText());
  check(
    `the Desk labels the final stage as ${final ? final.type : 'a bracket'} ("${finalLabel}")`,
    finalDesk.includes(finalLabel) && (await page.getByRole('button', { name: 'Finalize tournament' }).count()) === 1,
    finalDesk.slice(0, 200)
  );
  if (final) {
    // A round robin or Swiss final stage has standings of its own, first on the Desk.
    const standings = flat(await page.getByRole('region', { name: 'Standings' }).innerText());
    check('the Desk shows the final stage\'s standings above the groups\'', standings.indexOf('Final stage') >= 0 && standings.indexOf('Final stage') < standings.indexOf('Group A'), standings.slice(0, 200));
  }
  summary.final_stage_at_start = finals.map((m) => `${m.identifier} r${m.round} ${m.state} ${m.p1 ?? '-'} v ${m.p2 ?? '-'}`);
  await shot('6-desk-final-stage');

  // --- 7. The final stage ---
  console.log('\n[6] play the final stage on the pad');
  summary.final_matches = [];
  for (let played = 0; played < 30; played++) {
    const rows = (await stored()).filter((m) => m.stage === 'final');
    if (!rows.some((m) => m.state === 'open')) break;
    const match = await called();
    if (!match) throw new Error('final-stage matches are open but none is called at the stadium');
    // A bracket reads its matches back after every result. A round robin doesn't. A Swiss final
    // stage reads its next round after a round's last result (twice when it is late), and knows
    // its number of rounds, so nothing is read after the last.
    const lastRound = Math.max(...rows.map((m) => m.round));
    const endsRound = finalType === 'swiss' && match.round === lastRound && rows.filter((m) => m.round === lastRound && m.state === 'open').length === 1;
    const expected = !final ? [2] : endsRound && lastRound < finalRounds ? [2, 3] : [1];
    const { after, cost } = await play(match, played === 0);
    const ok = match.stage === 'final' && after.state === 'complete' && after.winner_challonge_id === match.player1_challonge_id && after.scores === '4 - 0' && expected.includes(cost);
    check(`${where(match)}: ${match.p1} beat ${match.p2}, saved on Challonge in ${cost} request${cost === 1 ? '' : 's'}${endsRound ? ', the last of its round' : ''}`, ok, `state ${after.state}, scores ${after.scores}`);
    summary.final_matches.push({ match: where(match), winner: match.p1, loser: match.p2, requests: cost, ends_round: endsRound });
  }
  if (finalType === 'swiss') {
    const rounds = [...new Set((await stored()).filter((m) => m.stage === 'final').map((m) => m.round))];
    check(`the Swiss final stage played its ${finalRounds} rounds and no more`, rounds.length === finalRounds, `rounds ${rounds.join(', ')}`);
  }
  const left = await stored();
  summary.left_unplayed = left.filter((m) => m.state !== 'complete').map((m) => `${m.stage} ${m.identifier}:r${m.round}:${m.state}`);
  check('no match is left open', !left.some((m) => m.state === 'open'), summary.left_unplayed.join(', ') || 'all complete');

  // --- 8. Finalize ---
  console.log('\n[7] finalize from the Desk');
  await page.getByRole('heading', { name: 'BXQ Desk' }).waitFor();
  before = await usage();
  const finalize = page.getByRole('button', { name: 'Finalize tournament' });
  check('the Desk offers Finalize once nothing is open', await finalize.isEnabled(), summary.left_unplayed.join(', ') || 'no match left unplayed');
  await finalize.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Finalize', exact: true }).click();
  await page.getByText('Finalized', { exact: true }).waitFor({ timeout: 60000 });
  const ranks = await people();
  const finalizeCost = (await usage()) - before;
  check(
    'BXQ finalized it on Challonge in 5 requests and stored a placement for everyone, advanced or not',
    (await tournament()).state === 'complete' && ranks.every((p) => p.final_rank !== null && p.active) && finalizeCost === 5,
    `${ranks.map((p) => `${p.final_rank}. ${p.name}${p.advanced ? '' : ' (out)'}`).join(', ')}; ${finalizeCost} requests`
  );
  summary.finalize = { requests: finalizeCost, standings: [...ranks].sort((a, b) => a.final_rank - b.final_rank).map((p) => `${p.final_rank}. ${p.name}`) };
  summary.requests_made_by_bxq = await usage();
  await shot('7-desk-finalized');

  // --- 9. What Challonge has, read directly ---
  console.log('\n[8] compare with Challonge');
  const remote = await direct('tournament-after', 'GET', `/tournaments/${challongeId}.json`);
  const included = remote.body.included ?? [];
  // By id: the groups and the final stage use the same identifiers.
  const remoteMatches = new Map(included.filter((r) => r.type === 'match').map((m) => [String(m.id), m.attributes]));
  const remoteRanks = new Map(included.filter((r) => r.type === 'participant').map((p) => [String(p.id), p.attributes.final_rank]));
  const finalRows = await stored();
  const mismatched = finalRows.filter((m) => {
    const r = remoteMatches.get(m.challonge_id);
    return !r || r.state !== m.state || (m.state === 'complete' && (String(r.winner_id) !== m.winner_challonge_id || r.scores !== m.scores));
  });
  check('Challonge says the tournament is complete', remote.body.data.attributes.state === 'complete', remote.body.data.attributes.state);
  check('every match on Challonge has the state, winner and score BXQ stored', mismatched.length === 0 && remoteMatches.size === finalRows.length, mismatched.map((m) => where(m)).join('; ') || `${finalRows.length} matches`);
  check('every placement on Challonge is the one BXQ stored', ranks.every((p) => remoteRanks.get(p.challonge_id) === p.final_rank), [...remoteRanks.values()].join(', '));
  summary.challonge = { state: remote.body.data.attributes.state, matches: remoteMatches.size };
} catch (error) {
  summary.error = String(error?.message ?? error);
  check('no unexpected error', false, summary.error.slice(0, 600));
} finally {
  if (browser) await browser.close();
  if (userId) await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
  if (challongeId && keep) console.log(`\nKept ${challongeId} on Challonge. Delete it on challonge.com when you are done.`);
  if (challongeId && !keep) {
    // Challonge refuses to delete a tournament that isn't pending (422). A two-stage one is pending
    // again after `reset_group_stage`, with `reset` before it once its final stage has started (spike S17).
    console.log(`\nreset and delete ${challongeId} on Challonge`);
    const put = (state) => api(token, 'PUT', `/tournaments/${challongeId}/change_state.json`, { body: { data: { type: 'TournamentState', attributes: { state } } } });
    const tried = [`reset:${(await put('reset')).status}`, `reset_group_stage:${(await put('reset_group_stage')).status}`];
    const res = await api(token, 'DELETE', `/tournaments/${challongeId}.json`);
    tried.push(`delete:${res.status}`);
    if (res.status >= 400) console.error(`    Could not delete ${challongeId} (${tried.join(', ')}): ${JSON.stringify(res.body)}. Delete it on challonge.com.`);
    summary.deleted = tried;
  }
  summary.requests_made_directly = requestCount();
  await saveSummary(`s18-${run}`, summary);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log(`Requests: ${summary.requests_made_by_bxq ?? '?'} by BXQ, ${summary.requests_made_directly} directly`);
process.exit(failed ? 1 : 0);
