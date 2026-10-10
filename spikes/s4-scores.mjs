// S4 (+ S3 progression check): how Challonge interprets reported scores.
// WRITES to the tournament: it starts it, reports scores, and reopens a match.
// Guarded: only runs with --confirm and only on a tournament whose name starts with "[SPIKE]".
import {
  env, getAccessToken, api, listAll, saveFixture, saveSummary, requestCount, diffMatches, matchSummary, playersOf
} from './lib/challonge.mjs';

const tournamentId = env('SPIKE_TOURNAMENT_ID');
if (!process.argv.includes('--confirm')) {
  console.error('This script changes the tournament. Re-run with --confirm (npm run s4 -- --confirm).');
  process.exit(1);
}

const token = await getAccessToken();
const summary = { tournament_id: tournamentId, steps: [] };
const matchesPath = `/tournaments/${tournamentId}/matches.json`;
const matchPath = (id) => `/tournaments/${tournamentId}/matches/${id}.json`;

const tournament = await api(token, 'GET', `/tournaments/${tournamentId}.json`);
const attrs = tournament.body?.data?.attributes ?? {};
if (!String(attrs.name ?? '').startsWith('[SPIKE]')) {
  console.error(`Refusing to run: tournament name "${attrs.name}" does not start with "[SPIKE]".`);
  process.exit(1);
}

async function record(step, res, extra = {}) {
  await saveFixture(`s4-${step}`, { status: res.status, body: res.body });
  summary.steps.push({ step, status: res.status, ...extra });
  if (res.status >= 400) console.log(`    ${step} failed:`, JSON.stringify(res.body));
}

function scoreBody(entries) {
  return { data: { type: 'Match', attributes: { match: entries } } };
}

console.log(`\nTournament "${attrs.name}" is ${attrs.state}`);
if (attrs.state === 'pending') {
  console.log('\n[1] Starting the tournament');
  const started = await api(token, 'PUT', `/tournaments/${tournamentId}/change_state.json`, {
    body: { data: { type: 'TournamentState', attributes: { state: 'start' } } }
  });
  await record('start', started);
}

let before = await listAll(token, matchesPath, 100);
const open = before.filter((m) => {
  const [a, b] = playersOf(m);
  return m.attributes?.state === 'open' && a && b;
});
if (open.length === 0) {
  console.error('No open matches with two players. Reset the tournament on challonge.com and try again.');
  process.exit(1);
}
const target = open[0];
const [p1, p2] = playersOf(target);
summary.match = matchSummary(target);
console.log(`\nUsing match ${target.id} (${target.attributes.identifier}): ${p1} vs ${p2}`);

console.log('\n[2] mark_as_underway');
const underway = await api(token, 'PUT', `/tournaments/${tournamentId}/matches/${target.id}/change_state.json`, {
  body: { data: { type: 'MatchState', attributes: { state: 'mark_as_underway' } } }
});
await record('mark-underway', underway, { attribute_keys_after: Object.keys(underway.body?.data?.attributes ?? {}) });

console.log('\n[3] Single set, score over the target (5-2 after an Xtreme at 3-2)');
const overshoot = await api(token, 'PUT', matchPath(target.id), {
  body: scoreBody([
    { participant_id: String(p1), score_set: '5', rank: 1, advancing: true },
    { participant_id: String(p2), score_set: '2', rank: 2, advancing: false }
  ])
});
await record('report-overshoot', overshoot, {
  scores: overshoot.body?.data?.attributes?.scores,
  winner_id: overshoot.body?.data?.attributes?.winner_id
});

console.log('\n[4] Progression: which matches changed after one report? (S3)');
let after = await listAll(token, matchesPath, 100);
summary.progression_after_report = diffMatches(before, after);
console.log(`    ${summary.progression_after_report.length} match(es) changed`);

console.log('\n[5] Reopen the match (does it roll back the downstream match?)');
const reopened = await api(token, 'PUT', `/tournaments/${tournamentId}/matches/${target.id}/change_state.json`, {
  body: { data: { type: 'MatchState', attributes: { state: 'reopen' } } }
});
await record('reopen', reopened);
before = after;
after = await listAll(token, matchesPath, 100);
summary.progression_after_reopen = diffMatches(before, after);

console.log('\n[6] Best of 3 sets: 4-1, 2-4, 4-3');
const multiSet = await api(token, 'PUT', matchPath(target.id), {
  body: scoreBody([
    { participant_id: String(p1), score_set: '4,2,4', rank: 1, advancing: true },
    { participant_id: String(p2), score_set: '1,4,3', rank: 2, advancing: false }
  ])
});
await record('report-multi-set', multiSet, {
  scores: multiSet.body?.data?.attributes?.scores,
  score_in_sets: multiSet.body?.data?.attributes?.score_in_sets
});

const second = open[1];
if (second) {
  console.log('\n[7] Tie on an elimination match (expect a 422; records the error shape)');
  const tie = await api(token, 'PUT', matchPath(second.id), {
    body: {
      data: {
        type: 'Match',
        attributes: {
          tie: true,
          match: playersOf(second).map((id) => ({ participant_id: String(id), score_set: '3', rank: 1, advancing: false }))
        }
      }
    }
  });
  await record('report-tie', tie);
}

summary.requests_used = requestCount();
await saveSummary('s4', summary);
console.log(JSON.stringify(summary, null, 2));
console.log('\nReset the tournament on challonge.com before running this again.');
