// S11: is the next Swiss round created a moment after the last result of a round is saved, so
// that a read made straight away can miss it? S8 missed a round once; S10 replayed S8 exactly and
// didn't. In the saved responses the next round's matches were created 35 to 300 ms after the last
// result. This run reads on purpose while and just after the last result of each round is sent
// (150, 250 and 350 ms after sending it, and when it returns), then reads again 3 seconds later.
// WRITES to the account: it creates one private "[SPIKE]" tournament (4 players, 3 rounds), plays
// two rounds through the API and resets and deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s11 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const PROBES_MS = [150, 250, 350];
const token = await getAccessToken();
const summary = { transitions: [] };
let id = null;

async function call(label, method, path, body) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s11-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (m) => ({
  id: String(m.id),
  identifier: m.attributes.identifier,
  round: m.attributes.round,
  state: m.attributes.state,
  players: (m.attributes.points_by_participant ?? []).map((p) => String(p.participant_id))
});
const rowsOf = (resources) => resources.filter((r) => r.type === 'match').map(row).sort((a, b) => a.round - b.round || String(a.identifier).localeCompare(String(b.identifier)));
const inRound = (rows, round) => rows.filter((r) => r.round === round);

// The entries BXQ sends for a result: the first player wins.
const win = (match, label) =>
  call(label, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, {
    data: {
      type: 'Match',
      attributes: { match: match.players.map((player, i) => ({ participant_id: player, score_set: i === 0 ? '4' : '2', rank: i === 0 ? 1 : 2, advancing: i === 0 })) }
    }
  });

// One read of the match list: has the round ended, and is the next one there?
async function look(label, round, sent) {
  const started = Date.now() - sent;
  const rows = rowsOf((await call(label, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);
  const ended = inRound(rows, round).every((r) => r.state === 'complete');
  const next = inRound(rows, round + 1).length;
  const saw = !ended ? 'the result was not saved yet' : next ? `round ${round + 1} is there` : `ROUND ${round} COMPLETE, ROUND ${round + 1} MISSING`;
  return { info: { read: label.split('-').slice(2).join('-'), sent_ms_after_the_result: started, answered_ms_after_the_result: Date.now() - sent, saw }, rows };
}

// Plays a round and reads around its last result.
async function endRound(round, matches) {
  for (const match of matches.slice(0, -1)) await win(match, `r${round}-${match.identifier}`);
  const last = matches.at(-1);
  const sent = Date.now();
  // A read that fails is recorded, not thrown: these run beside the result and nothing waits on them.
  const guarded = (label) => look(label, round, sent).catch((error) => ({ info: { read: label, failed: String(error.message ?? error), sent_ms_after_the_result: Date.now() - sent } }));
  const early = PROBES_MS.map((ms) => delay(ms).then(() => guarded(`r${round}-read-at-${ms}ms`)));
  const returned = await win(last, `r${round}-${last.identifier}-last`).then(() => Date.now() - sent);
  const reads = await Promise.all([...early, guarded(`r${round}-read-when-the-result-returned`)]);
  await delay(3000);
  const later = await look(`r${round}-read-3s-later`, round, sent);
  summary.transitions.push({
    round,
    result_returned_after_ms: returned,
    reads: [...reads, later].map((r) => r.info).sort((a, b) => a.sent_ms_after_the_result - b.sent_ms_after_the_result)
  });
  return later.rows;
}

try {
  console.log('\n[1] create a 4-player Swiss with 3 rounds, start it');
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: '[SPIKE] BXQ Swiss, 4 players, pairing race',
        url: `bxq_spike_s11_${Date.now().toString(36)}`,
        tournament_type: 'swiss',
        private: true,
        swiss_options: { rounds: 3, pts_for_match_win: 1, pts_for_match_tie: 0.5, pts_for_game_win: 0, pts_for_game_tie: 0, pts_for_bye: 1 }
      }
    }
  });
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const participants = Array.from({ length: 4 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await call('start', 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start' } } });
  let rows = rowsOf((await call('tournament', 'GET', `/tournaments/${id}.json`)).body.included ?? []);

  for (const round of [1, 2]) {
    console.log(`\n[${round + 1}] round ${round}: reads around its last result`);
    const matches = inRound(rows, round);
    if (matches.length === 0) throw new Error(`round ${round} was not paired`);
    rows = await endRound(round, matches);
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
  await saveSummary('s11', summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
