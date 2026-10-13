// S12: in an elimination bracket, are the winner and the loser moved into their next matches
// inside the result request, or after it has been answered? Swiss pairs its next round after
// (S10), and BXQ reads the bracket straight after every result.
// It compares how long the result request ran on Challonge's server (`x-runtime`) with the
// timestamps of the matches the result changed.
// WRITES to the account: it creates one private "[SPIKE]" double elimination tournament of 4
// players, reports its two first-round matches and resets and deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s12 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = {};
let id = null;

async function call(label, method, path, body) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s12-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

const time = (value) => (value ? Date.parse(value) : null);
const row = (m) => ({
  id: String(m.id),
  identifier: m.attributes.identifier,
  round: m.attributes.round,
  state: m.attributes.state,
  players: (m.attributes.points_by_participant ?? []).map((p) => (p.participant_id == null ? null : String(p.participant_id))),
  updated_at: time(m.attributes.timestamps?.updated_at),
  started_at: time(m.attributes.timestamps?.started_at)
});
const rowsOf = (resources) => resources.filter((r) => r.type === 'match').map(row);

// The entries BXQ sends for a result: the first player wins. Returns when it was saved and how long the request ran.
async function win(match, label) {
  const res = await call(label, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, {
    data: {
      type: 'Match',
      attributes: { match: match.players.map((player, i) => ({ participant_id: player, score_set: i === 0 ? '4' : '2', rank: i === 0 ? 1 : 2, advancing: i === 0 })) }
    }
  });
  return { saved: time(res.body.data.attributes.timestamps.updated_at), ran_ms: Math.round(parseFloat(res.headers.get('x-runtime')) * 1000) };
}

try {
  console.log('\n[1] create a 4-player double elimination bracket, start it');
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: '[SPIKE] BXQ double elim, 4 players, timing',
        url: `bxq_spike_s12_${Date.now().toString(36)}`,
        tournament_type: 'double elimination',
        private: true
      }
    }
  });
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const participants = Array.from({ length: 4 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await call('start', 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start' } } });
  const before = rowsOf((await call('tournament', 'GET', `/tournaments/${id}.json`)).body.included ?? []);
  const open = before.filter((r) => r.state === 'open' && r.players.every(Boolean));
  if (open.length < 2) throw new Error(`expected two open matches, found ${open.length}`);

  console.log('\n[2] report both first-round matches; the second one opens the next winners and losers matches');
  const first = await win(open[0], `report-${open[0].identifier}`);
  const second = await win(open[1], `report-${open[1].identifier}`);
  summary.first_result = { match: open[0].identifier, ran_ms: first.ran_ms };
  summary.second_result = { match: open[1].identifier, ran_ms: second.ran_ms };

  console.log('\n[3] read the bracket: when were the next matches changed?');
  const after = rowsOf((await call('matches-after', 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);
  const was = new Map(before.map((r) => [r.id, r]));
  // Times are counted from the second result being saved. Inside the request means at most `ran_ms`.
  summary.moved_on = after
    .filter((r) => ![open[0].id, open[1].id].includes(r.id))
    .filter((r) => JSON.stringify(was.get(r.id)) !== JSON.stringify(r))
    .map((r) => ({
      match: r.identifier,
      round: r.round,
      state: `${was.get(r.id)?.state} -> ${r.state}`,
      players: r.players.filter(Boolean).length,
      updated_ms_after_the_second_result: r.updated_at - second.saved,
      opened_ms_after_the_second_result: r.started_at ? r.started_at - second.saved : null
    }));
  const latest = Math.max(...summary.moved_on.flatMap((m) => [m.updated_ms_after_the_second_result, m.opened_ms_after_the_second_result ?? -Infinity]));
  summary.latest_change_ms_after_the_second_result = latest;
  summary.verdict =
    summary.moved_on.length === 0
      ? 'no other match changed'
      : latest <= second.ran_ms
        ? 'every change is within the time the result request ran'
        : 'a change came after the result request had finished';
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
  await saveSummary('s12', summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
