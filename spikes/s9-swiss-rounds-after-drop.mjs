// S9: after a player drops out of a Swiss tournament, does Challonge still pair the next round?
// In S8 round 3 was missing from the match list read right after round 2 ended. This run has a
// control first (rounds 2 and 3 with nobody dropped), then a drop, then two reads of the round
// after it: one at once and one after a wait.
// WRITES to the account: it creates one private "[SPIKE]" tournament, plays it through the API and
// resets and deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s9 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const WAIT_MS = 20_000;
const token = await getAccessToken();
const summary = {};
let id = null;

async function call(label, method, path, body) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s9-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

const row = (m) => ({
  id: String(m.id),
  identifier: m.attributes.identifier,
  round: m.attributes.round,
  state: m.attributes.state,
  players: (m.attributes.points_by_participant ?? []).map((p) => p.participant_id),
  winner_id: m.attributes.winner_id ?? null,
  scores: m.attributes.scores ?? null
});
const rowsOf = (resources) => resources.filter((r) => r.type === 'match').map(row).sort((a, b) => a.round - b.round || String(a.identifier).localeCompare(String(b.identifier)));
const inRound = (rows, round) => rows.filter((r) => r.round === round);
const playable = (rows) => rows.filter((r) => r.state === 'open' && r.players.length === 2 && r.players.every(Boolean));
const readMatches = async (label) => rowsOf((await call(label, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);
const wait = () => new Promise((resolve) => setTimeout(resolve, WAIT_MS));

// The entries BXQ sends for a result. `loser`, when given, is a player who must not win.
async function play(rows, label, loser = null) {
  const done = [];
  for (const match of playable(rows).slice(0, 3)) {
    const winner = String(match.players[0]) === loser ? 1 : 0;
    const entries = match.players.map((player, i) => ({
      participant_id: String(player),
      score_set: i === winner ? '4' : '2',
      rank: i === winner ? 1 : 2,
      advancing: i === winner
    }));
    const res = await call(`${label}-${match.identifier}`, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, {
      data: { type: 'Match', attributes: { match: entries } }
    });
    done.push(`${match.identifier}:${res.body?.data?.attributes?.state}`);
  }
  return done;
}

try {
  console.log('\n[1] create a 6-player Swiss with 4 rounds, start it');
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: '[SPIKE] BXQ Swiss, 6 players, 4 rounds',
        url: `bxq_spike_sw4_${Date.now().toString(36)}`,
        tournament_type: 'swiss',
        private: true,
        swiss_options: { rounds: 4, pts_for_match_win: 1, pts_for_match_tie: 0.5, pts_for_game_win: 0, pts_for_game_tie: 0, pts_for_bye: 1 }
      }
    }
  });
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const participants = Array.from({ length: 6 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await call('start', 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start' } } });
  const started = await call('tournament', 'GET', `/tournaments/${id}.json`);
  let rows = rowsOf(started.body.included ?? []);

  console.log('\n[2] control: rounds 1 and 2 with nobody dropped');
  summary.round_1 = await play(rows, 'r1');
  rows = await readMatches('matches-after-round-1');
  summary.round_2_paired = inRound(rows, 2).length;
  summary.round_2 = await play(rows, 'r2');
  rows = await readMatches('matches-after-round-2');
  summary.round_3_paired_without_a_drop = inRound(rows, 3).length;
  if (summary.round_3_paired_without_a_drop === 0) {
    // Then S8's missing round wasn't about the drop. See whether it is only late.
    await wait();
    rows = await readMatches('matches-after-round-2-later');
    summary.round_3_paired_after_waiting = inRound(rows, 3).length;
    if (summary.round_3_paired_after_waiting === 0) throw new Error('round 3 was not paired even without a drop');
  }

  console.log('\n[3] a player with a round 3 match to play drops out');
  const theirs = playable(inRound(rows, 3))[0];
  const dropped = String(theirs.players[0]);
  const drop = await call('drop', 'DELETE', `/tournaments/${id}/participants/${dropped}.json`);
  summary.drop = { participant: dropped, their_open_match: theirs.identifier, status: drop.status, states: drop.body?.data?.attributes?.states ?? null };

  console.log('\n[4] the rest of round 3, then round 4: at once and after a wait');
  rows = await readMatches('matches-after-drop');
  summary.their_match_after_drop = inRound(rows, 3).find((r) => r.id === theirs.id) ?? null;
  summary.round_3 = await play(rows, 'r3', dropped);
  rows = await readMatches('matches-after-round-3');
  summary.round_3_states = inRound(rows, 3).map((r) => `${r.identifier}:${r.state}`);
  summary.round_4_paired_at_once = inRound(rows, 4).length;

  console.log(`    waiting ${WAIT_MS / 1000} s`);
  await wait();
  const later = await call('tournament-later', 'GET', `/tournaments/${id}.json`);
  const laterRows = rowsOf(later.body.included ?? []);
  summary.round_4_paired_after_waiting = inRound(laterRows, 4).length;
  summary.round_4 = inRound(laterRows, 4);
  summary.tournament_later = {
    state: later.body.data.attributes.state,
    progress_meter: later.body.data.attributes.progress_meter,
    participants_count: later.body.data.attributes.participants_count,
    active: (later.body.included ?? []).filter((r) => r.type === 'participant').map((p) => `${p.attributes.name}:${p.attributes.states?.active}`)
  };
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
  await saveSummary('s9', summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
