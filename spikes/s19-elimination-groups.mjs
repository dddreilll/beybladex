// S19: how a group that is a bracket ends, which S17 only looked at. BXQ refuses such groups
// until that is known. One run creates one private "[SPIKE]" tournament with a single group of 4,
// 2 advancing to a single elimination final stage, and plays its group stage, the lower seed
// winning every match:
//   --variant=single-elimination  (the default) Plays both first-round matches, asks to end the
//                                 group stage with the group's final still open, plays it, and
//                                 ends the group stage. It also reads the participant list while
//                                 the group stage is played: the docs say a participant has a
//                                 `group_id` there, and the tournament response had it null (S17).
//   --variant=double-elimination  Plays the group up to its grand final, reads which of the two
//                                 last-round matches that is, plays it so that no reset is
//                                 needed, ends the group stage and reads what is left.
// The final stage isn't started. WRITES to the account: it creates one tournament, plays it
// through the API and resets and deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses, unless the refusal is what the step asks about; nothing is
// tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

const VARIANTS = { 'single-elimination': 'single elimination', 'double-elimination': 'double elimination' };
const name = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1] ?? 'single-elimination';
const stage = VARIANTS[name];
if (!stage) {
  console.error(`Unknown variant "${name}". Use one of: ${Object.keys(VARIANTS).join(', ')}.`);
  process.exit(1);
}
if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s19 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = { variant: name };
let id = null;
// Seed by participant id, from the players as they were added.
const seedOf = new Map();

async function call(label, method, path, body, { allowRefusal = false } = {}) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s19-${name}-${label}`, { status: res.status, body: res.body });
  const problem = `${label} -> ${res.status}: ${JSON.stringify(res.body)}`;
  if ([401, 403, 429].includes(res.status)) throw new Error(problem);
  if (res.status >= 400 && !allowRefusal) throw new Error(problem);
  return res;
}

const text = (value) => (value == null ? null : String(value));
const row = (m) => ({
  id: String(m.id),
  identifier: m.attributes.identifier,
  round: m.attributes.round,
  play_order: m.attributes.suggested_play_order ?? null,
  state: m.attributes.state,
  players: (m.attributes.points_by_participant ?? []).map((p) => text(p.participant_id)),
  winner_id: text(m.attributes.winner_id),
  scores: m.attributes.scores ?? null
});
const rowsOf = (resources) => resources.filter((r) => r.type === 'match').map(row).sort((a, b) => Number(a.id) - Number(b.id));
const who = (player) => (player ? `S${seedOf.get(player) ?? '?'}` : '-');
const line = (r) => `${r.identifier} r${r.round} #${r.play_order ?? '-'} ${r.state} [${r.players.map(who).join(' v ')}]${r.winner_id ? ` w=${who(r.winner_id)}` : ''}${r.scores ? ` ${r.scores}` : ''}`;
const show = (rows) => rows.map(line);
const people = (resources) =>
  resources
    .filter((r) => r.type === 'participant')
    .map((p) => ({ seed: p.attributes.seed, was: seedOf.get(String(p.id)), group_id: p.attributes.group_id ?? null, active: p.attributes.states?.active ?? null }))
    .sort((a, b) => a.seed - b.seed)
    .map((p) => `seed ${p.seed} (was S${p.was}) group_id=${p.group_id}${p.active === false ? ' inactive' : ''}`);

async function changeState(state, { allowRefusal = false, label = state.replaceAll('_', '-') } = {}) {
  const res = await call(label, 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state } } }, { allowRefusal });
  return { status: res.status, state: res.body?.data?.attributes?.state ?? null, refusal: res.status >= 400 ? res.body : undefined };
}

async function readTournament(label) {
  const res = await call(label, 'GET', `/tournaments/${id}.json`);
  const included = res.body.included ?? [];
  return { state: res.body.data.attributes.state, rows: rowsOf(included), included };
}

/**
 * Sends a result for the two players a match has, or is expected to have by now, the lower seed
 * winning, with the entries BXQ sends. Gives the winner and the loser.
 */
async function play(match, players, label, { allowRefusal = false } = {}) {
  const [winner, loser] = [...players].sort((a, b) => seedOf.get(a) - seedOf.get(b));
  const entries = [winner, loser].map((player, i) => ({ participant_id: player, score_set: i === 0 ? '4' : '2', rank: i + 1, advancing: i === 0 }));
  const res = await call(label, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, { data: { type: 'Match', attributes: { match: entries } } }, { allowRefusal });
  const a = res.body?.data?.attributes ?? {};
  const accepted = a.state === 'complete' && text(a.winner_id) === winner;
  (summary.results ??= []).push({ match: `${match.identifier} r${match.round}`, sent: `${who(winner)} beat ${who(loser)}`, status: res.status, state: a.state ?? null, accepted, refusal: res.status >= 400 ? res.body : undefined });
  if (!accepted) throw new Error(`${label}: the result wasn't accepted (${res.status}, ${a.state ?? 'no state'})`);
  return { winner, loser };
}

try {
  console.log(`\n[1] ${name}: one group of 4, 2 advance; start the group stage`);
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: `[SPIKE] BXQ one ${stage} group`,
        url: `bxq_spike_s19_${Date.now().toString(36)}`,
        tournament_type: 'single elimination',
        private: true,
        group_stage_enabled: true,
        // An options object that is incomplete is refused (spike S7), so every documented field is sent.
        group_stage_options: {
          stage_type: stage,
          group_size: 4,
          participant_count_to_advance_per_group: 2,
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
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const list = Array.from({ length: 4 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  const added = await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants: list } } });
  for (const p of added.body?.data ?? []) seedOf.set(String(p.id), p.attributes.seed);
  summary.start_group_stage = await changeState('start_group_stage');
  const started = await readTournament('tournament-group-stage');
  summary.group_stage = { state: started.state, matches: show(started.rows), participants: people(started.included) };

  const inRound = (round) => started.rows.filter((r) => r.round === round);
  const [first, second] = inRound(1);
  if (inRound(1).length !== 2 || !first.players.every(Boolean) || !second.players.every(Boolean)) throw new Error('the group has no two first-round matches with players');

  if (name === 'single-elimination') {
    console.log('\n[2] the participant list, while the group stage is played');
    const listed = await call('participants-list', 'GET', `/tournaments/${id}/participants.json?page=1&per_page=100`);
    const data = listed.body.data ?? [];
    summary.participant_list = {
      returned: data.length,
      attribute_keys: Object.keys(data[0]?.attributes ?? {}),
      group_ids: data.map((p) => `S${p.attributes.seed}:${p.attributes.group_id ?? null}`),
      any_group_id: data.some((p) => p.attributes.group_id != null)
    };

    console.log('\n[3] the two first-round matches, then ask to end the group stage with its final open');
    const a = await play(first, first.players, 'first-round-1');
    const b = await play(second, second.players, 'first-round-2');
    summary.early_finalize_group_stage = await changeState('finalize_group_stage', { allowRefusal: true, label: 'finalize-group-stage-early' });

    if (summary.early_finalize_group_stage.status >= 400) {
      console.log("\n[4] the group's final, then end the group stage");
      const [final] = inRound(2);
      await play(final, [a.winner, b.winner], 'group-final');
      summary.finalize_group_stage = await changeState('finalize_group_stage', { allowRefusal: true });
    } else {
      // Ended with a match unplayed: what became of it, and who advances?
      const ended = await readTournament('tournament-after-early-finalize');
      summary.after_early_finalize = { state: ended.state, matches: show(ended.rows), participants: people(ended.included) };
    }
  } else {
    console.log('\n[2] the bracket up to its grand final');
    const a = await play(first, first.players, 'winners-round-1a');
    const b = await play(second, second.players, 'winners-round-1b');
    const [winnersFinal] = inRound(2);
    const [losersFirst] = inRound(-1);
    const [losersFinal] = inRound(-2);
    const c = await play(winnersFinal, [a.winner, b.winner], 'winners-final');
    const f = await play(losersFirst, [a.loser, b.loser], 'losers-round-1');
    const g = await play(losersFinal, [c.loser, f.winner], 'losers-final');

    // The single elimination run ended its group stage with the group's final never opened: two
    // players were left, and two advance. Here two are left once the losers final is played.
    console.log('\n[3] is a grand final open? Ask to end the group stage; play the grand final only if Challonge wants it');
    const before = rowsOf((await call('matches-before-grand-final', 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);
    summary.before_grand_final = show(before);
    const last = before.filter((r) => r.round === 3);
    const grandFinal = last.find((r) => r.state === 'open');
    summary.last_round = { open: grandFinal ? line(grandFinal) : null, all: last.map(line) };
    summary.finalize_group_stage = await changeState('finalize_group_stage', { allowRefusal: true, label: 'finalize-group-stage-first' });
    if (summary.finalize_group_stage.status >= 400 && grandFinal) {
      await play(grandFinal, [c.winner, g.winner], 'grand-final');
      summary.finalize_group_stage_after_grand_final = await changeState('finalize_group_stage', { allowRefusal: true });
    }

    console.log('\n[4] read what is left');
    const ended = await readTournament('tournament-after-finalize-group-stage');
    summary.after_finalize_group_stage = { state: ended.state, matches: show(ended.rows), participants: people(ended.included) };
  }
} catch (error) {
  summary.error = String(error.message ?? error);
  console.error(`\nStopped: ${summary.error}`);
} finally {
  if (id && keep) console.log(`\nKept ${id}. Delete it on challonge.com when you are done.`);
  if (id && !keep) {
    // A two-stage tournament can be deleted once `reset_group_stage` has made it pending again (spike S17).
    console.log(`\nreset and delete ${id}`);
    const reset = await api(token, 'PUT', `/tournaments/${id}/change_state.json`, { body: { data: { type: 'TournamentState', attributes: { state: 'reset_group_stage' } } } });
    const res = await api(token, 'DELETE', `/tournaments/${id}.json`);
    if (res.status >= 400) console.error(`    Could not delete ${id} (reset_group_stage ${reset.status}, delete ${res.status}): ${JSON.stringify(res.body)}. Delete it on challonge.com.`);
    summary.deleted = { reset_group_stage: reset.status, delete: res.status };
  }
  summary.requests_used = requestCount();
  await saveSummary(`s19-${name}`, summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
