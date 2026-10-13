// S14: what does Challonge do with the last-round matches of a double elimination bracket whose
// grand finals are set to None (`grand_finals_modifier: "skip"`)? S6 saw that the started bracket
// still lists them. This run plays a 4-player bracket up to them, reads them, and asks Challonge
// to finalize.
// WRITES to the account: it creates one private "[SPIKE]" tournament, plays it through the API and
// resets and deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses (a refused finalize is recorded, not retried).
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s14 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = {};
let id = null;

async function call(label, method, path, body, { allowRefusal = false } = {}) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s14-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400 && !allowRefusal) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

const row = (m) => ({
  id: String(m.id),
  identifier: m.attributes.identifier,
  round: m.attributes.round,
  play_order: m.attributes.suggested_play_order,
  state: m.attributes.state,
  players: (m.attributes.points_by_participant ?? []).map((p) => (p.participant_id == null ? null : String(p.participant_id))),
  winner_id: m.attributes.winner_id == null ? null : String(m.attributes.winner_id),
  scores: m.attributes.scores ?? null
});
const rowsOf = (resources) => resources.filter((r) => r.type === 'match').map(row).sort((a, b) => (a.play_order ?? 999) - (b.play_order ?? 999));

// The entries BXQ sends for a result.
async function report(match, winner, loser) {
  const entries = [
    { participant_id: winner, score_set: '4', rank: 1, advancing: true },
    { participant_id: loser, score_set: '2', rank: 2, advancing: false }
  ];
  const res = await call(`report-${match.identifier}`, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, { data: { type: 'Match', attributes: { match: entries } } });
  const a = res.body.data.attributes;
  if (a.state !== 'complete' || String(a.winner_id) !== winner) throw new Error(`${match.identifier} was not completed with the expected winner: ${JSON.stringify(a)}`);
  return `${match.identifier} (round ${match.round}): ${winner} beat ${loser}`;
}

try {
  console.log('\n[1] create a 4-player double elimination bracket with grand finals set to None, start it');
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: '[SPIKE] BXQ double elim, 4 players, no GF',
        url: `bxq_spike_s14_${Date.now().toString(36)}`,
        tournament_type: 'double elimination',
        private: true,
        double_elimination_options: { grand_finals_modifier: 'skip' }
      }
    }
  });
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const participants = Array.from({ length: 4 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await call('start', 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start' } } });
  const read = await call('tournament', 'GET', `/tournaments/${id}.json`);
  summary.options = read.body.data.attributes.double_elimination_options;
  const rows = rowsOf(read.body.included ?? []);
  summary.at_start = rows.map((r) => `${r.identifier}:r${r.round}:#${r.play_order}:${r.state}`);
  const inRound = (round) => rows.filter((r) => r.round === round);
  const [a, b] = inRound(1);
  const [winnersFinal] = inRound(2);
  const [losers1] = inRound(-1);
  const [losersFinal] = inRound(-2);
  const lastRound = Math.max(...rows.map((r) => r.round));
  if (!a || !b || !winnersFinal || !losers1 || !losersFinal) throw new Error(`unexpected bracket: ${summary.at_start.join(' ')}`);

  console.log('\n[2] play the winners and losers brackets to their ends');
  // First players win the first round; the winner of A then wins the winners final.
  const [wa, la] = a.players;
  const [wb, lb] = b.players;
  summary.results = [
    await report(a, wa, la),
    await report(b, wb, lb),
    await report(winnersFinal, wa, wb),
    await report(losers1, la, lb),
    await report(losersFinal, wb, la)
  ];
  summary.expected = { winners_bracket_winner: wa, losers_bracket_winner: wb };

  console.log('\n[3] the last round, then finalize');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = rowsOf((await call('matches-after', 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);
  summary.last_round = after.filter((r) => r.round === lastRound).map((r) => ({ match: r.identifier, round: r.round, state: r.state, players: r.players, winner_id: r.winner_id }));
  summary.all_states = after.map((r) => `${r.identifier}:r${r.round}:${r.state}`);

  const finalized = await call('finalize', 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'finalize' } } }, { allowRefusal: true });
  summary.finalize = { status: finalized.status, state: finalized.body?.data?.attributes?.state ?? null, refusal: finalized.status >= 400 ? finalized.body : undefined };
  const people = await call('participants-final', 'GET', `/tournaments/${id}/participants.json?page=1&per_page=100`);
  summary.standings = (people.body.data ?? [])
    .map((p) => ({ id: String(p.id), name: p.attributes.name, final_rank: p.attributes.final_rank ?? null }))
    .sort((x, y) => (x.final_rank ?? 999) - (y.final_rank ?? 999));
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
  await saveSummary('s14', summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
