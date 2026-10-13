// S13: four more measurements for S12's question. In an elimination bracket, are the winner and
// the loser moved into their next matches inside the result request, or after it has answered?
// It reports the four first-round matches of an 8-player double elimination bracket one at a
// time, reads the bracket after each, and compares how long each result request ran on Challonge's
// server (`x-runtime`) with the timestamps of the matches that result changed.
// WRITES to the account: it creates one private "[SPIKE]" tournament and resets and deletes it
// (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s13 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = { samples: [] };
let id = null;

async function call(label, method, path, body) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s13-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

const time = (value) => (value ? Date.parse(value) : null);
const row = (m) => ({
  id: String(m.id),
  identifier: m.attributes.identifier,
  round: m.attributes.round,
  play_order: m.attributes.suggested_play_order,
  state: m.attributes.state,
  players: (m.attributes.points_by_participant ?? []).map((p) => (p.participant_id == null ? null : String(p.participant_id))),
  updated_at: time(m.attributes.timestamps?.updated_at),
  started_at: time(m.attributes.timestamps?.started_at)
});
const rowsOf = (resources) => resources.filter((r) => r.type === 'match').map(row);
const filled = (r) => r.players.filter(Boolean).length;

try {
  console.log('\n[1] create an 8-player double elimination bracket, start it');
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: '[SPIKE] BXQ double elim, 8 players, timing',
        url: `bxq_spike_s13_${Date.now().toString(36)}`,
        tournament_type: 'double elimination',
        private: true
      }
    }
  });
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const participants = Array.from({ length: 8 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await call('start', 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start' } } });
  let before = rowsOf((await call('tournament', 'GET', `/tournaments/${id}.json`)).body.included ?? []);
  const firstRound = before.filter((r) => r.state === 'open' && r.players.every(Boolean)).sort((a, b) => (a.play_order ?? 999) - (b.play_order ?? 999));
  if (firstRound.length < 4) throw new Error(`expected four open matches, found ${firstRound.length}`);

  console.log('\n[2] one result at a time, with a read after each');
  for (const match of firstRound.slice(0, 4)) {
    // The entries BXQ sends for a result: the first player wins.
    const res = await call(`report-${match.identifier}`, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, {
      data: {
        type: 'Match',
        attributes: { match: match.players.map((player, i) => ({ participant_id: player, score_set: i === 0 ? '4' : '2', rank: i === 0 ? 1 : 2, advancing: i === 0 })) }
      }
    });
    const saved = time(res.body.data.attributes.timestamps.updated_at);
    const ranMs = Math.round(parseFloat(res.headers.get('x-runtime')) * 1000);
    const after = rowsOf((await call(`matches-after-${match.identifier}`, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);
    const was = new Map(before.map((r) => [r.id, r]));
    // Times are counted from this result being saved. Inside the request means at most `ran_ms`.
    const movedOn = after
      .filter((r) => r.id !== match.id && JSON.stringify(was.get(r.id)) !== JSON.stringify(r))
      .map((r) => ({
        match: r.identifier,
        round: r.round,
        players: `${filled(was.get(r.id))} -> ${filled(r)}`,
        state: `${was.get(r.id).state} -> ${r.state}`,
        updated_ms_after_the_result: r.updated_at !== was.get(r.id).updated_at ? r.updated_at - saved : null,
        opened_ms_after_the_result: r.started_at && !was.get(r.id).started_at ? r.started_at - saved : null
      }));
    const lags = movedOn.flatMap((m) => [m.updated_ms_after_the_result, m.opened_ms_after_the_result]).filter((v) => v !== null);
    const latest = lags.length ? Math.max(...lags) : null;
    summary.samples.push({
      result: match.identifier,
      ran_ms: ranMs,
      moved_on: movedOn,
      latest_change_ms_after_the_result: latest,
      verdict: latest === null ? 'no timestamp changed' : latest <= ranMs ? 'within the request' : 'AFTER THE REQUEST FINISHED'
    });
    before = after;
  }
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
  await saveSummary('s13', summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
