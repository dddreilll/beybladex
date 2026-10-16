// S22: a corrected result where no spike had tried one. One run creates one private "[SPIKE]"
// tournament and plays it through the API, the lower seed winning, then sends one result again
// with the other winner:
//   --variant=round-robin-final  (the default) 6 players in 2 round robin groups of 3, 2 advancing
//                                to a round robin final stage, played to the end. A final-stage
//                                result is corrected; the tournament is finalized; then a result
//                                is corrected again, to see whether Challonge takes a correction
//                                once a tournament is complete.
//   --variant=swiss-final        The same groups, to a Swiss final stage of 2 rounds. A round 1
//                                result is corrected once round 2 is paired: does round 2 change?
//   --variant=bracket-group      One double elimination group of 4, 2 advancing. The first round,
//                                the winners final and the first losers match are played, then
//                                the first match's winner is corrected: does Challonge reset the two
//                                matches its players went on to, as in a bracket of one stage
//                                (spike S4b)? BXQ asks before such a correction and assumes so.
// WRITES to the account: it creates one tournament, plays it through the API and resets and
// deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses, unless the refusal is what the step asks about, and at a cap of
// requests for each variant; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

const GROUPS = {
  stage_type: 'round robin',
  group_size: 3,
  participant_count_to_advance_per_group: 2,
  rr_iterations: 1,
  ranked_by: 'match wins',
  rr_pts_for_match_win: 1,
  rr_pts_for_match_tie: 0.5,
  rr_pts_for_game_win: 0,
  rr_pts_for_game_tie: 0,
  split_participants: false
};
const VARIANTS = {
  'round-robin-final': {
    players: 6,
    attributes: { tournament_type: 'round robin', round_robin_options: { iterations: 1, ranking: 'match wins' }, group_stage_options: GROUPS },
    cap: 32
  },
  'swiss-final': {
    players: 6,
    attributes: {
      tournament_type: 'swiss',
      swiss_options: { rounds: 2, pts_for_match_win: 1, pts_for_match_tie: 0.5, pts_for_game_win: 0, pts_for_game_tie: 0, pts_for_bye: 1 },
      group_stage_options: GROUPS
    },
    cap: 26
  },
  'bracket-group': {
    players: 4,
    attributes: { tournament_type: 'single elimination', group_stage_options: { ...GROUPS, stage_type: 'double elimination', group_size: 4 } },
    cap: 16
  }
};
const name = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1] ?? 'round-robin-final';
const variant = VARIANTS[name];
if (!variant) {
  console.error(`Unknown variant "${name}". Use one of: ${Object.keys(VARIANTS).join(', ')}.`);
  process.exit(1);
}
if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s22 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = { variant: name };
let id = null;
let participants = [];

async function call(label, method, path, body, { allowRefusal = false } = {}) {
  if (requestCount() >= variant.cap) throw new Error(`stopped at the cap of ${variant.cap} requests, before ${label}`);
  const res = await api(token, method, path, { body });
  await saveFixture(`s22-${name}-${label}`, { status: res.status, body: res.body });
  const problem = `${label} -> ${res.status}: ${JSON.stringify(res.body)}`;
  if ([401, 403, 429].includes(res.status)) throw new Error(problem);
  if (res.status >= 400 && !allowRefusal) throw new Error(problem);
  return res;
}

const text = (value) => (value == null ? null : String(value));
const row = (m) => {
  const a = m.attributes;
  return {
    id: String(m.id),
    identifier: a.identifier,
    round: a.round,
    state: a.state,
    players: (a.points_by_participant ?? []).map((p) => text(p.participant_id)),
    winner_id: text(a.winner_id),
    scores: a.scores ?? null,
    updated_at: a.timestamps?.updated_at ?? null
  };
};
const rowsOf = (resources) =>
  resources
    .filter((r) => r.type === 'match')
    .map(row)
    .sort((a, b) => Number(a.id) - Number(b.id));
const playable = (rows) => rows.filter((r) => r.state === 'open' && r.players.length === 2 && r.players.every(Boolean));
const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const seedOf = (player) => participants.find((p) => String(p.id) === player)?.attributes.seed ?? null;
const who = (player) => (player ? `S${seedOf(player) ?? '?'}` : '-');
const line = (r) => `${r.identifier} r${r.round} ${r.state} [${r.players.map(who).join(' v ')}]${r.winner_id ? ` w=${who(r.winner_id)}` : ''}${r.scores ? ` ${r.scores}` : ''}`;
const lowerSeed = (m) => [...m.players].sort((a, b) => seedOf(a) - seedOf(b))[0];
const other = (m, player) => m.players.find((p) => p !== player);
/** What changed between two reads of the same matches. */
const changes = (before, after) => {
  const was = new Map(before.map((r) => [r.id, r]));
  return {
    added: after.filter((r) => !was.has(r.id)).map(line),
    changed: after.filter((r) => was.has(r.id) && line(was.get(r.id)) !== line(r)).map((r) => `${line(was.get(r.id))}  =>  ${line(r)}`)
  };
};

async function changeState(state, { allowRefusal = false } = {}) {
  const res = await call(state.replaceAll('_', '-'), 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state } } }, { allowRefusal });
  return { status: res.status, state: res.body?.data?.attributes?.state ?? null, refusal: res.status >= 400 ? res.body : undefined };
}
async function readTournament(label) {
  const res = await call(label, 'GET', `/tournaments/${id}.json`);
  const included = res.body.included ?? [];
  const read = included.filter((r) => r.type === 'participant');
  if (read.length) participants = read;
  return { attributes: res.body.data.attributes, rows: rowsOf(included) };
}
const readMatches = async (label) => rowsOf((await call(label, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);

// The entries BXQ sends for a result: rank 1 and `advancing` for the winner.
async function report(match, winnerId, label, { allowRefusal = false } = {}) {
  const entries = match.players.map((player) => ({ participant_id: player, score_set: player === winnerId ? '4' : '2', rank: player === winnerId ? 1 : 2, advancing: player === winnerId }));
  const res = await call(label, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, { data: { type: 'Match', attributes: { match: entries } } }, { allowRefusal });
  const a = res.body?.data?.attributes ?? {};
  const accepted = res.status < 400 && a.state === 'complete' && text(a.winner_id) === winnerId;
  if (!accepted && !allowRefusal) throw new Error(`${label} answered ${res.status} without completing ${line(match)}: ${a.state} w=${text(a.winner_id)}`);
  return { match: line(match), sent_winner: who(winnerId), status: res.status, accepted, state: a.state ?? null, winner: who(text(a.winner_id)), refusal: res.status >= 400 ? res.body : undefined };
}

/** Plays every open match of these rows, the lower seed winning. */
async function playAll(rows, prefix) {
  const played = [];
  for (const m of playable(rows)) played.push((await report(m, lowerSeed(m), `${prefix}-${m.identifier}-${m.id.slice(-3)}`)).match);
  return played;
}

/** Plays the groups, ends the group stage and starts the final stage: 10 requests. */
async function toFinalStage(groupRows) {
  summary.group_results = await playAll(groupRows, 'group');
  summary.finalize_group_stage = await changeState('finalize_group_stage');
  summary.start = await changeState('start');
  const started = await readTournament('tournament-final-stage');
  const groupIds = new Set(groupRows.map((r) => r.id));
  return { groupIds, finals: started.rows.filter((r) => !groupIds.has(r.id)) };
}

try {
  console.log(`\n[1] ${name}: create, add ${variant.players} players, start the group stage`);
  const made = await call('create', 'POST', '/tournaments.json', {
    data: { type: 'Tournaments', attributes: { name: `[SPIKE] BXQ S22 ${name}`, url: `bxq_spike_s22_${Date.now().toString(36)}`, private: true, group_stage_enabled: true, ...variant.attributes } }
  });
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const list = Array.from({ length: variant.players }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  participants = (await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants: list } } })).body?.data ?? [];
  summary.start_group_stage = await changeState('start_group_stage');
  const t = await readTournament('tournament-group-stage');

  if (name === 'round-robin-final') {
    console.log('\n[2] the groups, then the whole final stage');
    const { groupIds, finals } = await toFinalStage(t.rows);
    summary.final_results = await playAll(finals, 'final');
    const played = (await readMatches('matches-after-final-stage')).filter((r) => !groupIds.has(r.id));

    console.log('\n[3] a final-stage result corrected');
    const target = played[0];
    summary.correction = await report(target, other(target, target.winner_id), 'correction', { allowRefusal: true });
    const corrected = (await readMatches('matches-after-correction')).filter((r) => !groupIds.has(r.id));
    summary.after_correction = changes(played, corrected);

    console.log('\n[4] finalize, then a correction once the tournament is complete');
    summary.finalize = await changeState('finalize', { allowRefusal: true });
    const again = corrected.find((r) => r.id === target.id);
    summary.correction_after_finalize = await report(again, other(again, again.winner_id), 'correction-after-finalize', { allowRefusal: true });
    const after = await readTournament('tournament-after-late-correction');
    summary.after_late_correction = { state: after.attributes.state, changes: changes(corrected, after.rows.filter((r) => !groupIds.has(r.id))) };
  } else if (name === 'swiss-final') {
    console.log('\n[2] the groups, then round 1 of the final stage');
    const { groupIds, finals } = await toFinalStage(t.rows);
    summary.round_1 = await playAll(finals, 'round-1');
    // Challonge pairs the next round a moment after the round's last result (spike S20).
    let rows = [];
    for (const seconds of [2, 3]) {
      await wait(seconds);
      rows = (await readMatches(`matches-after-round-1-${seconds}s`)).filter((r) => !groupIds.has(r.id));
      if (rows.some((r) => r.round === 2)) break;
    }
    if (!rows.some((r) => r.round === 2)) throw new Error('round 2 was never paired');
    summary.paired = rows.map(line);

    console.log('\n[3] a round 1 result corrected with round 2 paired');
    const target = rows.find((r) => r.round === 1);
    summary.correction = await report(target, other(target, target.winner_id), 'correction', { allowRefusal: true });
    await wait(2);
    const after = (await readMatches('matches-after-correction')).filter((r) => !groupIds.has(r.id));
    summary.after_correction = changes(rows, after);
  } else {
    console.log('\n[2] the first round of the group, then what it fills');
    summary.round_1 = await playAll(t.rows, 'round-1');
    let rows = await readMatches('matches-after-round-1');
    summary.after_round_1 = rows.map(line);

    console.log('\n[3] the winners final and the first losers match');
    summary.next = await playAll(rows, 'next');
    rows = await readMatches('matches-after-next');
    summary.before_correction = rows.map(line);

    console.log("\n[4] the first match's winner corrected");
    const target = rows.find((r) => r.identifier === 'A');
    summary.correction = await report(target, other(target, target.winner_id), 'correction', { allowRefusal: true });
    const after = await readMatches('matches-after-correction');
    summary.after_correction = changes(rows, after);
  }
} catch (error) {
  summary.error = String(error.message ?? error);
  console.error(`\nStopped: ${summary.error}`);
} finally {
  if (id && keep) console.log(`\nKept ${id}. Delete it on challonge.com when you are done.`);
  if (id && !keep) {
    // A two-stage tournament is pending again after `reset_group_stage`, with `reset` before it once
    // its final stage has started (spike S17); Challonge deletes only a pending one.
    console.log(`\nreset and delete ${id}`);
    const put = (state) => api(token, 'PUT', `/tournaments/${id}/change_state.json`, { body: { data: { type: 'TournamentState', attributes: { state } } } });
    const tried = [];
    for (const state of summary.start ? ['reset', 'reset_group_stage'] : summary.start_group_stage ? ['reset_group_stage'] : []) tried.push(`${state}:${(await put(state)).status}`);
    const deleted = await api(token, 'DELETE', `/tournaments/${id}.json`);
    tried.push(`delete:${deleted.status}`);
    if (deleted.status >= 400) console.error(`    Could not delete ${id} (${tried.join(', ')}): ${JSON.stringify(deleted.body)}. Delete it on challonge.com.`);
    summary.deleted = tried;
  }
  summary.requests_used = requestCount();
  await saveSummary(`s22-${name}`, summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
