// S17: two-stage tournaments (a group stage, then a final stage), which BXQ refuses and no spike
// has run. One run plays one kind of group stage, in a private "[SPIKE]" tournament whose final
// stage is single elimination, with 2 players advancing from each group:
//   --variant=round-robin         (the default) 6 players in 2 groups of 3. Played to the end: the
//                                 groups, the change of stage, a group result corrected after the
//                                 final stage has begun, finalize.
//   --variant=swiss               8 players in 2 groups of 4. One group's round is finished before
//                                 the other's, to see when the next round is paired. A result is
//                                 corrected during the group stage and another once every match is
//                                 played; then the group stage is ended.
//   --variant=single-elimination  8 players in 2 groups of 4: the layout only.
//   --variant=double-elimination  The layout, one result and the groups after it, and it asks to
//                                 end the group stage while matches are open.
// WRITES to the account: it creates one tournament, plays it through the API and resets and deletes
// it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses, unless the refusal is what the step asks about, and at a cap of
// requests for each variant; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

const VARIANTS = {
  'round-robin': { stage: 'round robin', players: 6, size: 3, cap: 38 },
  swiss: { stage: 'swiss', players: 8, size: 4, cap: 26 },
  'single-elimination': { stage: 'single elimination', players: 8, size: 4, cap: 6 },
  'double-elimination': { stage: 'double elimination', players: 8, size: 4, cap: 10 }
};
const name = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1] ?? 'round-robin';
const variant = VARIANTS[name];
if (!variant) {
  console.error(`Unknown variant "${name}". Use one of: ${Object.keys(VARIANTS).join(', ')}.`);
  process.exit(1);
}
if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s17 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = { variant: name };
let id = null;
// The participants as last read, to tell whose id a match carries.
let participants = [];
// The id sent for a player in a result: the one the match carries, as BXQ does, unless Challonge refuses it.
let sendId = (player) => player;

async function call(label, method, path, body, { allowRefusal = false } = {}) {
  if (requestCount() >= variant.cap) throw new Error(`stopped at the cap of ${variant.cap} requests, before ${label}`);
  const res = await api(token, method, path, { body });
  await saveFixture(`s17-${name}-${label}`, { status: res.status, body: res.body });
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
    group_id: 'group_id' in a ? a.group_id : '(absent)',
    players: (a.points_by_participant ?? []).map((p) => text(p.participant_id)),
    winner_id: text(a.winner_id),
    scores: a.scores ?? null,
    created_at: a.timestamps?.created_at ?? null,
    // In the round robin run, group matches had these two relationships and final-stage matches didn't.
    player_links: ['player1', 'player2'].filter((key) => m.relationships?.[key]).length
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

// The participant a match's player id belongs to: by its own id, or by any attribute holding that id.
function ownerOf(player) {
  if (!player) return null;
  const direct = participants.find((p) => String(p.id) === player);
  if (direct) return { participant: direct, via: 'id' };
  for (const participant of participants) {
    for (const [key, value] of Object.entries(participant.attributes ?? {})) {
      if (key === 'tournament_id' || key === 'seed') continue;
      if ([value].flat(Infinity).some((v) => v != null && typeof v !== 'object' && String(v) === player)) return { participant, via: key };
    }
  }
  return null;
}
const seedOf = (player) => ownerOf(player)?.participant.attributes.seed ?? null;
const who = (player) => (player ? (seedOf(player) != null ? `S${seedOf(player)}` : `?${player}`) : '-');
const lowerSeed = (match) => {
  const [a, b] = match.players.map(seedOf);
  return a != null && b != null && b < a ? 1 : 0;
};
// The group a match belongs to; "~" marks one taken from its players because the match has none.
function groupOf(r) {
  if (r.group_id !== '(absent)') return r.group_id == null ? 'no-group' : `g${r.group_id}`;
  const group = ownerOf(r.players.find(Boolean))?.participant.attributes.group_id;
  return group == null ? 'no-group' : `g${group}~`;
}
function byGroup(rows) {
  const groups = new Map();
  for (const r of rows) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
  return groups;
}
const line = (r) =>
  `${groupOf(r)} ${r.identifier} r${r.round} #${r.play_order ?? '-'} ${r.state} [${r.players.map(who).join(' v ')}]` +
  `${r.winner_id ? ` w=${who(r.winner_id)}` : ''}${r.scores ? ` ${r.scores}` : ''} links=${r.player_links}`;
const show = (rows) => rows.map(line);

function changes(before, after) {
  const was = new Map(before.map((r) => [r.id, r]));
  const now = new Set(after.map((r) => r.id));
  return {
    added: show(after.filter((r) => !was.has(r.id))),
    removed: show(before.filter((r) => !now.has(r.id))),
    changed: after.filter((r) => was.has(r.id) && JSON.stringify(was.get(r.id)) !== JSON.stringify(r)).map((r) => `${line(was.get(r.id))}  =>  ${line(r)}`)
  };
}

const people = () =>
  participants
    .map((p) => ({ seed: p.attributes.seed, id: String(p.id), group_id: p.attributes.group_id ?? null, final_rank: p.attributes.final_rank ?? null, active: p.attributes.states?.active ?? null }))
    .sort((a, b) => a.seed - b.seed)
    .map((p) => `S${p.seed} id=${p.id} group=${p.group_id} rank=${p.final_rank}${p.active === false ? ' inactive' : ''}`);

// Whose ids the matches carry: BXQ looks every player of a match up by participant id.
function identities(rows) {
  const players = [...new Set(rows.flatMap((r) => r.players).filter(Boolean))];
  const found = {};
  for (const player of players) {
    const via = ownerOf(player)?.via ?? '(nowhere)';
    found[via] = (found[via] ?? 0) + 1;
  }
  return { players_in_matches: players.length, found_by: found };
}

async function changeState(state, { allowRefusal = false, label = state.replaceAll('_', '-') } = {}) {
  const res = await call(label, 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state } } }, { allowRefusal });
  return { status: res.status, state: res.body?.data?.attributes?.state ?? null, refusal: res.status >= 400 ? res.body : undefined };
}

// The whole tournament in one request: its state, its participants and its matches.
async function readTournament(label) {
  const res = await call(label, 'GET', `/tournaments/${id}.json`);
  const included = res.body.included ?? [];
  const read = included.filter((r) => r.type === 'participant');
  if (read.length) participants = read;
  return { attributes: res.body.data.attributes, state: res.body.data.attributes.state, matches: included.filter((r) => r.type === 'match'), rows: rowsOf(included) };
}
const readMatches = async (label) => rowsOf((await call(label, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);

// The entries BXQ sends for a result: rank 1 and `advancing` for the winner.
async function report(match, winner, label, { allowRefusal = false, idOf = sendId } = {}) {
  const sent = match.players.map(idOf);
  const entries = sent.map((player, i) => ({ participant_id: player, score_set: i === winner ? '4' : '2', rank: i === winner ? 1 : 2, advancing: i === winner }));
  const res = await call(label, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, { data: { type: 'Match', attributes: { match: entries } } }, { allowRefusal });
  const a = res.body?.data?.attributes ?? {};
  return {
    match: line(match),
    sent_winner: `${who(match.players[winner])} as ${sent[winner]}`,
    status: res.status,
    state: a.state ?? null,
    winner_id: text(a.winner_id),
    scores: a.scores ?? null,
    // What lib/challonge/report.ts checks before it believes a 200.
    accepted: a.state === 'complete' && [sent[winner], match.players[winner]].includes(text(a.winner_id)),
    refusal: res.status >= 400 ? res.body : undefined
  };
}

// Create, add the players, start the group stage, read: 4 requests.
async function setup() {
  console.log(`\n[1] ${name}: ${variant.players} players in groups of ${variant.size}, 2 advance to a single elimination final stage`);
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: `[SPIKE] BXQ two-stage, ${variant.stage} groups`,
        url: `bxq_spike_s17_${Date.now().toString(36)}`,
        tournament_type: 'single elimination',
        private: true,
        group_stage_enabled: true,
        // An options object that is incomplete is refused (spike S7), so every documented field is sent.
        group_stage_options: {
          stage_type: variant.stage,
          group_size: variant.size,
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
  const createdAs = made.body.data.attributes ?? {};
  console.log(`    created ${id} (https://challonge.com/${createdAs.url})`);
  summary.created = { state: createdAs.state, tournament_type: createdAs.tournament_type, group_stage_enabled: createdAs.group_stage_enabled, group_stage_options: createdAs.group_stage_options ?? '(absent)' };

  const list = Array.from({ length: variant.players }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  const added = await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants: list } } });
  participants = added.body?.data ?? [];

  summary.start_group_stage = await changeState('start_group_stage');
  const t = await readTournament('tournament-group-stage');
  summary.group_stage = {
    state: t.state,
    tournament_type: t.attributes.tournament_type,
    group_stage_options: t.attributes.group_stage_options ?? '(absent)',
    participants_count: t.attributes.participants_count,
    timestamps: t.attributes.timestamps ?? null,
    match_attribute_keys: Object.keys(t.matches[0]?.attributes ?? {}),
    match_relationship_keys: Object.keys(t.matches[0]?.relationships ?? {}),
    participant_attribute_keys: Object.keys(participants[0]?.attributes ?? {}),
    ids: identities(t.rows),
    participants: people(),
    matches: show(t.rows)
  };
  return t;
}

async function roundRobin(t) {
  const groupIds = new Set(t.rows.map((r) => r.id));
  const finalRows = (rows) => rows.filter((r) => !groupIds.has(r.id));

  console.log('\n[2] the match list, as an import reads it');
  const listed = await call('matches-list', 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`);
  summary.match_list = {
    returned: listed.body.data?.length ?? 0,
    same_attribute_keys_as_in_the_tournament: JSON.stringify(Object.keys(listed.body.data?.[0]?.attributes ?? {})) === JSON.stringify(summary.group_stage.match_attribute_keys),
    links: listed.body.links ?? null
  };

  console.log('\n[3] the group matches, lower seed winning');
  const [first, ...rest] = playable(t.rows);
  summary.group_results = [await report(first, lowerSeed(first), 'group-result-1', { allowRefusal: true })];
  if (!summary.group_results[0].accepted) {
    // Not accepted with the ids the match carries: the participants' own ids are the other candidate.
    const own = (player) => text(ownerOf(player)?.participant.id);
    if (!first.players.every(own) || first.players.every((p) => own(p) === p)) throw new Error('the first group result was not accepted');
    const again = await report(first, lowerSeed(first), 'group-result-1-participant-ids', { allowRefusal: true, idOf: own });
    summary.group_results.push(again);
    if (!again.accepted) throw new Error('the first group result was accepted with neither kind of id');
    sendId = own;
  }
  for (const [i, match] of rest.entries()) summary.group_results.push(await report(match, lowerSeed(match), `group-result-${i + 2}`));

  const afterGroups = await readTournament('tournament-after-groups');
  summary.after_groups = { state: afterGroups.state, new_matches: show(finalRows(afterGroups.rows)), participants: people() };

  console.log('\n[4] end the group stage, start the final stage');
  summary.finalize_group_stage = await changeState('finalize_group_stage');
  const ended = await readTournament('tournament-after-finalize-group-stage');
  summary.after_finalize_group_stage = { state: ended.state, new_matches: show(finalRows(ended.rows)), participants: people() };

  summary.start = await changeState('start');
  const started = await readTournament('tournament-final-stage');
  const finals = finalRows(started.rows);
  summary.final_stage = {
    state: started.state,
    changes_since_the_group_stage_ended: changes(ended.rows, started.rows),
    ids: identities(finals),
    created_at: [...new Set(finals.map((r) => r.created_at))],
    matches: show(finals)
  };

  console.log('\n[5] one final-stage result, then a group result corrected so that another player would advance');
  const [semi] = playable(finals);
  if (!semi) throw new Error('no final-stage match is open');
  summary.final_first_result = await report(semi, lowerSeed(semi), 'final-result-1');

  // In a group of three where the lower seed always won, the middle seed advanced. Giving its
  // match to the lowest seed puts that player second.
  const group = [...byGroup(afterGroups.rows.filter((r) => groupIds.has(r.id))).values()][0];
  const [, middle, lowest] = [...new Set(group.flatMap((r) => r.players))].sort((a, b) => (seedOf(a) ?? 0) - (seedOf(b) ?? 0));
  const target = group.find((r) => r.players.includes(middle) && r.players.includes(lowest)) ?? group[0];
  const flipped = target.players.indexOf(target.winner_id) === 0 ? 1 : 0;
  summary.correction = await report(target, flipped, 'group-correction', { allowRefusal: true });
  const afterCorrection = await readTournament('tournament-after-correction');
  summary.after_correction = {
    state: afterCorrection.state,
    // Besides the first final-stage result and the winner it moved on.
    changes_since_the_final_stage_started: changes(started.rows, afterCorrection.rows),
    first_final_result_still_there: afterCorrection.rows.find((r) => r.id === semi.id)?.state === 'complete',
    participants: people()
  };

  console.log('\n[6] the rest of the final stage, and finalize');
  let rows = afterCorrection.rows;
  summary.final_results = [];
  for (let pass = 1; pass <= 3; pass++) {
    const open = playable(finalRows(rows));
    if (!open.length) break;
    for (const match of open) summary.final_results.push(await report(match, lowerSeed(match), `final-pass-${pass}-${match.identifier}-${match.id}`));
    rows = await readMatches(`matches-after-final-pass-${pass}`);
  }
  summary.final_stage_at_the_end = show(finalRows(rows));

  summary.finalize = await changeState('finalize', { allowRefusal: true });
  const final = await call('participants-final', 'GET', `/tournaments/${id}/participants.json?page=1&per_page=100`);
  if (final.body.data?.length) participants = final.body.data;
  summary.standings = people();
}

async function swiss(t) {
  console.log('\n[2] round 1 of one group, then of the others');
  const open = playable(t.rows);
  const groups = [...byGroup(open).values()];
  // Without a group on the match or the player, the first half of the play order stands in for a group.
  const first = groups.length > 1 ? groups[0] : open.slice(0, Math.ceil(open.length / 2));
  const others = open.filter((r) => !first.includes(r));
  summary.round_1 = [];
  for (const [i, match] of first.entries()) {
    summary.round_1.push(await report(match, lowerSeed(match), `r1-${match.identifier}-${match.id}`));
    // A result corrected while the group stage is being played: once it has ended, Challonge refuses one.
    if (i === 0) summary.correction_during_the_group_stage = await report(match, lowerSeed(match) === 0 ? 1 : 0, 'correction-during', { allowRefusal: true });
  }
  await wait(2);
  let rows = await readMatches('matches-after-one-groups-round-1');
  summary.after_one_groups_round_1 = changes(t.rows, rows).added;

  for (const match of others) summary.round_1.push(await report(match, lowerSeed(match), `r1-${match.identifier}-${match.id}`));
  await wait(2);
  let next = await readMatches('matches-after-round-1');
  summary.after_round_1 = changes(rows, next).added;
  rows = next;

  console.log('\n[3] the later rounds');
  let last = others.at(-1) ?? first.at(-1);
  for (let round = 2; round <= 3; round++) {
    const ready = playable(rows);
    if (!ready.length) break;
    summary[`round_${round}`] = [];
    for (const match of ready) summary[`round_${round}`].push(await report(match, lowerSeed(match), `r${round}-${match.identifier}-${match.id}`));
    last = ready.at(-1);
    await wait(2);
    next = await readMatches(`matches-after-round-${round}`);
    summary[`after_round_${round}`] = changes(rows, next).added;
    rows = next;
  }

  console.log('\n[4] end the group stage');
  summary.matches_before_the_end = show(rows);
  if (playable(rows).length) throw new Error('matches are still open after three rounds');
  // Every group match is played and the group stage hasn't been ended: can a result still be corrected?
  summary.correction_before_the_end = await report(last, lowerSeed(last) === 0 ? 1 : 0, 'correction-before-the-end', { allowRefusal: true });
  summary.finalize_group_stage = await changeState('finalize_group_stage', { allowRefusal: true });
  const ended = await readTournament('tournament-after-finalize-group-stage');
  summary.after_finalize_group_stage = { state: ended.state, changes: changes(rows, ended.rows), participants: people() };
}

async function elimination(t) {
  if (name !== 'double-elimination') return;
  console.log('\n[2] one result, and the groups after it');
  const [first] = playable(t.rows);
  summary.first_result = await report(first, lowerSeed(first), 'group-result-1', { allowRefusal: true });
  const after = await readMatches('matches-after-result');
  summary.after_result = changes(t.rows, after);

  console.log('\n[3] ask to end the group stage while matches are open');
  summary.early_finalize_group_stage = await changeState('finalize_group_stage', { allowRefusal: true });
  if (summary.early_finalize_group_stage.status < 400) {
    const ended = await readTournament('tournament-after-early-finalize');
    summary.after_early_finalize = { state: ended.state, changes: changes(after, ended.rows), participants: people() };
  }
}

try {
  const t = await setup();
  if (name === 'round-robin') await roundRobin(t);
  else if (name === 'swiss') await swiss(t);
  else await elimination(t);
} catch (error) {
  summary.error = String(error.message ?? error);
  console.error(`\nStopped: ${summary.error}`);
} finally {
  if (id && keep) console.log(`\nKept ${id}. Delete it on challonge.com when you are done.`);
  if (id && !keep) {
    // Challonge refuses to delete a tournament that isn't pending (422). A two-stage one is pending
    // again after `reset_group_stage`; the round robin run, whose final stage had begun, needed
    // `reset` before it. If the first attempt fails, both are sent.
    console.log(`\nreset and delete ${id}`);
    const put = (state) => api(token, 'PUT', `/tournaments/${id}/change_state.json`, { body: { data: { type: 'TournamentState', attributes: { state } } } });
    const tried = [];
    const attempt = async (states) => {
      for (const state of states) tried.push(`${state}:${(await put(state)).status}`);
      const deleted = await api(token, 'DELETE', `/tournaments/${id}.json`);
      tried.push(`delete:${deleted.status}`);
      return deleted;
    };
    let res = await attempt(summary.start ? ['reset', 'reset_group_stage'] : ['reset_group_stage']);
    if (res.status >= 400 && !summary.start) res = await attempt(['reset', 'reset_group_stage']);
    if (res.status >= 400) console.error(`    Could not delete ${id} (${tried.join(', ')}): ${JSON.stringify(res.body)}. Delete it on challonge.com.`);
    summary.deleted = tried;
  }
  summary.requests_used = requestCount();
  await saveSummary(`s17-${name}`, summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
