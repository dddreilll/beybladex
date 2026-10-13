// S15: how do consolation matches beyond third place appear? S6 found the third-place match as
// identifier `3P` in round 0. This run creates an 8-player single elimination bracket with matches
// down to 7th place (`consolation_matches_target_rank: 7`, or 5 if Challonge refuses 7) and reads
// its structure. Nothing is played.
// WRITES to the account: it creates one private "[SPIKE]" tournament and resets and deletes it
// (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses, except that a refused rank of 7 is followed by one try with 5.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s15 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = {};
let id = null;

async function call(label, method, path, body, { allowRefusal = false } = {}) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s15-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400 && !allowRefusal) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

const create = (rank, allowRefusal) =>
  call(`create-rank-${rank}`, 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: `[SPIKE] BXQ single elim, 8 players, to ${rank}th`,
        url: `bxq_spike_s15_${rank}_${Date.now().toString(36)}`,
        tournament_type: 'single elimination',
        private: true,
        match_options: { consolation_matches_target_rank: rank }
      }
    }
  }, { allowRefusal });

try {
  console.log('\n[1] create an 8-player single elimination bracket with consolation matches, start it');
  let made = await create(7, true);
  summary.asked_for_rank = 7;
  if (made.status >= 400) {
    summary.rank_7_refused = made.body;
    made = await create(5, false);
    summary.asked_for_rank = 5;
  }
  id = made.body.data.id;
  summary.match_options_after_create = made.body.data.attributes.match_options;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const participants = Array.from({ length: 8 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await call('start', 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start' } } });

  console.log('\n[2] read the bracket');
  const read = await call('tournament', 'GET', `/tournaments/${id}.json`);
  summary.match_options_after_start = read.body.data.attributes.match_options;
  const rows = (read.body.included ?? [])
    .filter((r) => r.type === 'match')
    .map((m) => ({ identifier: m.attributes.identifier, round: m.attributes.round, play_order: m.attributes.suggested_play_order, state: m.attributes.state }))
    .sort((a, b) => (a.play_order ?? 999) - (b.play_order ?? 999));
  summary.match_count = rows.length;
  summary.rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
  summary.matches = rows.map((r) => `${r.identifier}:r${r.round}:#${r.play_order}:${r.state}`);
  summary.outside_the_main_bracket = rows.filter((r) => r.round <= 0 || !/^[A-Z]+$/.test(String(r.identifier)));
} catch (error) {
  summary.error = String(error.message ?? error);
  console.error(`\nStopped: ${summary.error}`);
} finally {
  if (id && keep) console.log(`\nKept ${id}. Delete it on challonge.com when you are done.`);
  if (id && !keep) {
    // Challonge refuses to delete a tournament that is underway (422): it goes back to pending first.
    console.log(`\nreset and delete ${id}`);
    const reset = await api(token, 'PUT', `/tournaments/${id}/change_state.json`, {
      body: { data: { type: 'TournamentState', attributes: { state: 'reset' } } }
    });
    const res = await api(token, 'DELETE', `/tournaments/${id}.json`);
    if (res.status >= 400) console.error(`    Could not delete ${id} (reset ${reset.status}, delete ${res.status}): ${JSON.stringify(res.body)}. Delete it on challonge.com.`);
    summary.deleted = { reset: reset.status, delete: res.status };
  }
  summary.requests_used = requestCount();
  await saveSummary('s15', summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
