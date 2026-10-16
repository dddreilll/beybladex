// S20: a two-stage tournament whose final stage is a round robin or Swiss, which BXQ refuses and
// S17 didn't play (its final stages were single elimination). Challonge's help center lists both
// as final-stage formats. One run creates one private "[SPIKE]" tournament: 6 players in 2 round
// robin groups of 3, 2 advancing from each, so 4 players reach the final stage. The lower seed
// wins every match.
//   --variant=round-robin  (the default) The final stage is a round robin, played to the end.
//   --variant=swiss        The final stage is Swiss with 2 rounds: round 1, a read to see whether
//                          round 2 is paired, round 2, and a read to see that no round 3 follows.
// Both read what starting the final stage creates and when, and finalize at the end.
// WRITES to the account: it creates one tournament, plays it through the API and resets and
// deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses, unless the refusal is what the step asks about, and at a cap of
// requests for each variant; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

// Challonge refuses a create (422) when an options object is incomplete (spike S7).
const ROUND_ROBIN = { iterations: 1, ranking: 'match wins' };
const SWISS = { rounds: 2, pts_for_match_win: 1, pts_for_match_tie: 0.5, pts_for_game_win: 0, pts_for_game_tie: 0, pts_for_bye: 1 };
const VARIANTS = {
  'round-robin': { final: 'round robin', options: { round_robin_options: ROUND_ROBIN }, cap: 32 },
  swiss: { final: 'swiss', options: { swiss_options: SWISS }, cap: 32 }
};
const name = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1] ?? 'round-robin';
const variant = VARIANTS[name];
if (!variant) {
  console.error(`Unknown variant "${name}". Use one of: ${Object.keys(VARIANTS).join(', ')}.`);
  process.exit(1);
}
if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s20 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = { variant: name };
let id = null;
// The participants as last read, to tell whose id a match carries.
let participants = [];

async function call(label, method, path, body, { allowRefusal = false } = {}) {
  if (requestCount() >= variant.cap) throw new Error(`stopped at the cap of ${variant.cap} requests, before ${label}`);
  const res = await api(token, method, path, { body });
  await saveFixture(`s20-${name}-${label}`, { status: res.status, body: res.body });
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
    play_order: a.suggested_play_order ?? null,
    state: a.state,
    players: (a.points_by_participant ?? []).map((p) => text(p.participant_id)),
    winner_id: text(a.winner_id),
    scores: a.scores ?? null,
    created_at: a.timestamps?.created_at ?? null
  };
};
const rowsOf = (resources) =>
  resources
    .filter((r) => r.type === 'match')
    .map(row)
    .sort((a, b) => (a.play_order ?? 999) - (b.play_order ?? 999) || Number(a.id) - Number(b.id));
const playable = (rows) => rows.filter((r) => r.state === 'open' && r.players.length === 2 && r.players.every(Boolean));
const wait = (seconds) => {
  console.log(`    waiting ${seconds} s`);
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

const seedOf = (player) => participants.find((p) => String(p.id) === player)?.attributes.seed ?? null;
const who = (player) => (player ? (seedOf(player) != null ? `S${seedOf(player)}` : `?${player}`) : '-');
const lowerSeed = (match) => {
  const [a, b] = match.players.map(seedOf);
  return a != null && b != null && b < a ? 1 : 0;
};
const line = (r) =>
  `${r.identifier} r${r.round} #${r.play_order ?? '-'} ${r.state} [${r.players.map(who).join(' v ')}]` +
  `${r.winner_id ? ` w=${who(r.winner_id)}` : ''}${r.scores ? ` ${r.scores}` : ''}`;
const show = (rows) => rows.map(line);
const added = (before, after) => {
  const was = new Set(before.map((r) => r.id));
  return show(after.filter((r) => !was.has(r.id)));
};

const people = () =>
  participants
    .map((p) => ({ seed: p.attributes.seed, id: String(p.id), final_rank: p.attributes.final_rank ?? null, active: p.attributes.states?.active ?? null }))
    .sort((a, b) => a.seed - b.seed)
    .map((p) => `S${p.seed} id=${p.id} rank=${p.final_rank}${p.active === false ? ' inactive' : ''}`);

// Whether every player of these matches is a participant id, as BXQ looks them up.
const idsAreParticipants = (rows) => rows.flatMap((r) => r.players).filter(Boolean).every((p) => seedOf(p) != null);

// How long after `started_at` each match was created, in ms: BXQ tells the stages apart by it
// (lib/challonge/stages.ts takes a match created more than 2 s before it for a group match).
const createdAfterStart = (rows, startedAt) =>
  rows.map((r) => (r.created_at && startedAt ? new Date(r.created_at).getTime() - new Date(startedAt).getTime() : null));

async function changeState(state, { allowRefusal = false } = {}) {
  const res = await call(state.replaceAll('_', '-'), 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state } } }, { allowRefusal });
  return { status: res.status, state: res.body?.data?.attributes?.state ?? null, refusal: res.status >= 400 ? res.body : undefined };
}

// The whole tournament in one request: its state, its options, its participants and its matches.
async function readTournament(label) {
  const res = await call(label, 'GET', `/tournaments/${id}.json`);
  const included = res.body.included ?? [];
  const read = included.filter((r) => r.type === 'participant');
  if (read.length) participants = read;
  return { attributes: res.body.data.attributes, state: res.body.data.attributes.state, rows: rowsOf(included) };
}
const readMatches = async (label) => rowsOf((await call(label, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);
const options = (a) => ({
  tournament_type: a.tournament_type,
  group_stage_options: a.group_stage_options ?? '(absent)',
  round_robin_options: a.round_robin_options ?? '(absent)',
  swiss_options: a.swiss_options ?? '(absent)',
  started_at: a.timestamps?.started_at ?? null
});

// The entries BXQ sends for a result: rank 1 and `advancing` for the winner.
async function report(match, winner, label) {
  const entries = match.players.map((player, i) => ({ participant_id: player, score_set: i === winner ? '4' : '2', rank: i === winner ? 1 : 2, advancing: i === winner }));
  const res = await call(label, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, { data: { type: 'Match', attributes: { match: entries } } });
  const a = res.body?.data?.attributes ?? {};
  // What lib/challonge/report.ts checks before it believes a 200.
  const accepted = a.state === 'complete' && text(a.winner_id) === match.players[winner];
  if (!accepted) throw new Error(`${label} answered 200 without completing ${line(match)}: ${a.state} w=${text(a.winner_id)}`);
  return `${line(match)} -> w=${who(match.players[winner])} at ${new Date().toISOString()}`;
}

// Create, add the players, start the group stage, read: 4 requests.
async function setup() {
  console.log(`\n[1] ${name}: 6 players in 2 round robin groups of 3, 2 advance to a ${variant.final} final stage`);
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: `[SPIKE] BXQ two-stage, ${variant.final} final stage`,
        url: `bxq_spike_s20_${Date.now().toString(36)}`,
        tournament_type: variant.final,
        private: true,
        ...variant.options,
        group_stage_enabled: true,
        // Every documented field, as in S17.
        group_stage_options: {
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
        }
      }
    }
  });
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  summary.created = { state: made.body.data.attributes?.state, ...options(made.body.data.attributes ?? {}) };

  const list = Array.from({ length: 6 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  const bulk = await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants: list } } });
  participants = bulk.body?.data ?? [];

  summary.start_group_stage = await changeState('start_group_stage');
  const t = await readTournament('tournament-group-stage');
  summary.group_stage = { state: t.state, ...options(t.attributes), matches: show(t.rows) };
  return t;
}

// The six group matches, the end of the group stage and the start of the final stage: 10 requests.
async function toFinalStage(t) {
  console.log('\n[2] the group matches, lower seed winning');
  summary.group_results = [];
  for (const [i, match] of playable(t.rows).entries()) summary.group_results.push(await report(match, lowerSeed(match), `group-result-${i + 1}`));

  console.log('\n[3] end the group stage, start the final stage');
  summary.finalize_group_stage = await changeState('finalize_group_stage');
  const ended = await readTournament('tournament-after-finalize-group-stage');
  summary.after_finalize_group_stage = { state: ended.state, ...options(ended.attributes), participants: people() };

  summary.start = await changeState('start');
  const started = await readTournament('tournament-final-stage');
  const groupIds = new Set(ended.rows.map((r) => r.id));
  const finals = started.rows.filter((r) => !groupIds.has(r.id));
  summary.final_stage = {
    state: started.state,
    ...options(started.attributes),
    participants_count: started.attributes.participants_count,
    matches_created: finals.length,
    open: playable(finals).length,
    rounds: [...new Set(finals.map((r) => r.round))],
    player_ids_are_participant_ids: idsAreParticipants(finals),
    created_ms_after_started_at: createdAfterStart(finals, started.attributes.timestamps?.started_at),
    // The latest group match, against the same clock: BXQ needs it well before `started_at`.
    last_group_match_ms_after_started_at: Math.max(...createdAfterStart(ended.rows, started.attributes.timestamps?.started_at).filter((n) => n !== null)),
    matches: show(finals)
  };
  return { groupIds, startedAt: started.attributes.timestamps?.started_at, rows: started.rows };
}

async function roundRobin({ groupIds, rows }) {
  console.log('\n[4] the final stage, lower seed winning');
  const finals = rows.filter((r) => !groupIds.has(r.id));
  summary.final_results = [];
  for (const [i, match] of playable(finals).entries()) summary.final_results.push(await report(match, lowerSeed(match), `final-result-${i + 1}`));
  const after = await readTournament('tournament-after-final-stage');
  summary.after_final_stage = { state: after.state, matches_added: added(rows, after.rows), final_stage: show(after.rows.filter((r) => !groupIds.has(r.id))) };
}

async function swiss({ groupIds, startedAt, rows }) {
  let finals = rows.filter((r) => !groupIds.has(r.id));
  for (let round = 1; round <= 2; round++) {
    console.log(`\n[${round + 3}] final stage round ${round}, lower seed winning`);
    const ready = playable(finals);
    if (!ready.length) throw new Error(`no final-stage match is open in round ${round}`);
    summary[`round_${round}`] = [];
    for (const match of ready) summary[`round_${round}`].push(await report(match, lowerSeed(match), `round-${round}-${match.identifier}`));
    // Challonge pairs a Swiss round a moment after it answers the round's last result (S9 to S11).
    await wait(2);
    const next = (await readMatches(`matches-after-round-${round}`)).filter((r) => !groupIds.has(r.id));
    const fresh = next.filter((r) => !finals.some((f) => f.id === r.id));
    summary[`after_round_${round}`] = {
      added: show(fresh),
      created_ms_after_started_at: createdAfterStart(fresh, startedAt),
      created_at: fresh.map((r) => r.created_at),
      player_ids_are_participant_ids: idsAreParticipants(fresh)
    };
    finals = next;
  }
  summary.final_stage_at_the_end = show(finals);
}

try {
  const t = await setup();
  const final = await toFinalStage(t);
  if (name === 'round-robin') await roundRobin(final);
  else await swiss(final);

  console.log('\n[6] finalize, then the placements');
  summary.finalize = await changeState('finalize', { allowRefusal: true });
  const standings = await call('participants-final', 'GET', `/tournaments/${id}/participants.json?page=1&per_page=100`);
  if (standings.body.data?.length) participants = standings.body.data;
  summary.standings = people();
} catch (error) {
  summary.error = String(error.message ?? error);
  console.error(`\nStopped: ${summary.error}`);
} finally {
  if (id && keep) console.log(`\nKept ${id}. Delete it on challonge.com when you are done.`);
  if (id && !keep) {
    // Challonge refuses to delete a tournament that isn't pending (422). A two-stage one is pending
    // again after `reset_group_stage`, with `reset` before it once the final stage has started (S17).
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
  await saveSummary(`s20-${name}`, summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
