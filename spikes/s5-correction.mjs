// S4b: correcting a wrong result. Can a reported match be flipped to the other winner,
// and what happens to the matches downstream, before and after they have been played?
// WRITES to the tournament. Guarded: --confirm and a "[SPIKE]" tournament name.
import {
  env, getAccessToken, api, listAll, saveFixture, saveSummary, requestCount, diffMatches, matchSummary, playersOf
} from './lib/challonge.mjs';

const tournamentId = env('SPIKE_TOURNAMENT_ID');
if (!process.argv.includes('--confirm')) {
  console.error('This script changes the tournament. Re-run with --confirm (npm run s5 -- --confirm).');
  process.exit(1);
}

const token = await getAccessToken();
const matchesPath = `/tournaments/${tournamentId}/matches.json`;
const summary = { tournament_id: tournamentId, tests: {} };

const tournament = await api(token, 'GET', `/tournaments/${tournamentId}.json`);
const name = String(tournament.body?.data?.attributes?.name ?? '');
if (!name.startsWith('[SPIKE]')) {
  console.error(`Refusing to run: tournament name "${name}" does not start with "[SPIKE]".`);
  process.exit(1);
}

let current = await listAll(token, matchesPath, 100);
const byId = (id) => current.find((m) => m.id === id);
const same = (a, b) => a != null && b != null && String(a) === String(b);

async function refresh() {
  const next = await listAll(token, matchesPath, 100);
  const changes = diffMatches(current, next);
  current = next;
  return changes;
}

async function report(match, winnerId, loserId, winnerScore, loserScore) {
  const [p1] = playersOf(match);
  const entries = [
    { participant_id: String(winnerId), score_set: String(winnerScore), rank: 1, advancing: true },
    { participant_id: String(loserId), score_set: String(loserScore), rank: 2, advancing: false }
  ];
  // Keep player1 first, as Challonge lists them.
  if (!same(entries[0].participant_id, p1)) entries.reverse();
  return api(token, 'PUT', `/tournaments/${tournamentId}/matches/${match.id}.json`, {
    body: { data: { type: 'Match', attributes: { match: entries } } }
  });
}

async function reopen(match) {
  return api(token, 'PUT', `/tournaments/${tournamentId}/matches/${match.id}/change_state.json`, {
    body: { data: { type: 'MatchState', attributes: { state: 'reopen' } } }
  });
}

function outcome(res, expectedWinner) {
  const a = res.body?.data?.attributes ?? {};
  return {
    status: res.status,
    state: a.state ?? null,
    winner_id: a.winner_id ?? null,
    scores: a.scores ?? null,
    accepted: res.status < 400 && a.state === 'complete' && same(a.winner_id, expectedWinner),
    errors: res.body?.errors ?? null
  };
}

async function run(label, fn) {
  console.log(`\n[${label}]`);
  const result = await fn();
  summary.tests[label] = result;
  await saveFixture(`s5-${label}`, result);
  return result;
}

// The completed round-1 match from S4 is the one we will try to correct.
const target = current.find((m) => m.attributes.round === 1 && m.attributes.state === 'complete');
if (!target) {
  console.error('No completed round-1 match found. Run S4 first, or reset the tournament and run S4 again.');
  process.exit(1);
}
const [a, b] = playersOf(target);
let winner = target.attributes.winner_id;
let loser = same(winner, a) ? b : a;
summary.target = matchSummary(target);
console.log(`Target match ${target.id} (${target.attributes.identifier}): winner ${winner}, loser ${loser}`);

// T1: flip the winner on a completed match directly, without reopening it.
const t1 = await run('t1-direct-flip', async () => {
  const res = await report(byId(target.id), loser, winner, 4, 2);
  const result = { ...outcome(res, loser), downstream: await refresh() };
  return result;
});
if (t1.accepted) [winner, loser] = [loser, winner];

// T2: only if T1 was refused: reopen first, then report the flipped result.
if (!t1.accepted) {
  await run('t2-reopen-then-flip', async () => {
    const reopened = await reopen(byId(target.id));
    const res = await report(byId(target.id), loser, winner, 4, 2);
    const result = { reopen_status: reopened.status, ...outcome(res, loser), downstream: await refresh() };
    if (result.accepted) [winner, loser] = [loser, winner];
    return result;
  });
}

// T3: let the downstream match be played, then try to correct the original match again.
const nextRound = target.attributes.round + 1;
const findNext = () => current.find((m) => m.attributes.round === nextRound && playersOf(m).some((p) => same(p, winner)));
let next = findNext();
summary.next_match_before = next ? matchSummary(next) : null;

// Fill the other slot of the next match by completing the feeder match(es).
for (let i = 0; next && playersOf(next).some((p) => p == null) && i < 4; i++) {
  const feeder = current
    .filter((m) => m.attributes.round === 1 && m.attributes.state === 'open' && playersOf(m).every((p) => p != null))
    .sort((x, y) => x.attributes.suggested_play_order - y.attributes.suggested_play_order)[0];
  if (!feeder) break;
  const [f1, f2] = playersOf(feeder);
  console.log(`\nCompleting feeder ${feeder.id} (${feeder.attributes.identifier}) so the next match fills up`);
  await report(feeder, f1, f2, 4, 1);
  await refresh();
  next = findNext();
}

if (!next || next.attributes.state !== 'open') {
  summary.tests.t3_skipped = `Next match not playable (${next ? next.attributes.state : 'not found'}).`;
} else {
  const opponent = playersOf(next).find((p) => !same(p, winner));
  await run('t3a-play-next-match', async () => {
    const res = await report(next, winner, opponent, 4, 0);
    return { next_match_id: next.id, ...outcome(res, winner), downstream: await refresh() };
  });

  await run('t3b-flip-after-next-played', async () => {
    const res = await report(byId(target.id), loser, winner, 4, 3);
    return { ...outcome(res, loser), downstream: await refresh() };
  });

  await run('t3c-reopen-after-next-played', async () => {
    const res = await reopen(byId(target.id));
    const a2 = res.body?.data?.attributes ?? {};
    const downstream = await refresh();
    return {
      status: res.status,
      state: a2.state ?? null,
      errors: res.body?.errors ?? null,
      next_match_after: matchSummary(byId(next.id)),
      downstream
    };
  });
  summary.next_match_final = matchSummary(byId(next.id));
}

summary.requests_used = requestCount();
await saveSummary('s5', summary);
console.log(JSON.stringify(summary, null, 2));
console.log('\nReset the tournament on challonge.com before running this again.');
