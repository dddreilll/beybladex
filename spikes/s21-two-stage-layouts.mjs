// S21: the two-stage cases S17 to S20 left untested. One run creates one private "[SPIKE]"
// tournament with round robin groups and a single elimination final stage:
//   --variant=three-groups  (the default) 9 players in 3 groups of 3: the layout only. Does BXQ still
//                           tell the groups apart with more than two of them?
//   --variant=unequal       7 players in groups of 4, so the groups aren't the same size: the layout
//                           only.
//   --variant=big-groups    16 players in 2 groups of 8, larger than any run before: the layout only.
//   --variant=third-place   6 players in 2 groups of 3, 2 advancing, to a final stage with a
//                           third-place match. Group A is played to a three-way tie, to see whom
//                           Challonge lets advance; group B goes by seed. The final stage is played
//                           to Finalize, to see where the third-place match is and when it opens.
// The layouts are saved in out/fixtures as the tournament response, for BXQ's tests.
// WRITES to the account: it creates one tournament, plays it through the API and resets and
// deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses, and at a cap of requests for each variant; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

const VARIANTS = {
  'three-groups': { players: 9, size: 3, advance: 2, cap: 8 },
  unequal: { players: 7, size: 4, advance: 2, cap: 8 },
  'big-groups': { players: 16, size: 8, advance: 4, cap: 8 },
  'third-place': { players: 6, size: 3, advance: 2, thirdPlace: true, cap: 30 }
};
const name = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1] ?? 'three-groups';
const variant = VARIANTS[name];
if (!variant) {
  console.error(`Unknown variant "${name}". Use one of: ${Object.keys(VARIANTS).join(', ')}.`);
  process.exit(1);
}
if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s21 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = { variant: name };
let id = null;
let participants = [];

async function call(label, method, path, body) {
  if (requestCount() >= variant.cap) throw new Error(`stopped at the cap of ${variant.cap} requests, before ${label}`);
  const res = await api(token, method, path, { body });
  await saveFixture(`s21-${name}-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
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
    created_at: a.timestamps?.created_at ?? null
  };
};
const rowsOf = (resources) =>
  resources
    .filter((r) => r.type === 'match')
    .map(row)
    .sort((a, b) => Number(a.id) - Number(b.id));
const seedOf = (player) => participants.find((p) => String(p.id) === player)?.attributes.seed ?? null;
const who = (player) => (player ? `S${seedOf(player) ?? '?'}` : '-');
const line = (r) => `#${r.id.slice(-3)} ${r.identifier} r${r.round} po${r.play_order ?? '-'} ${r.state} [${r.players.map(who).join(' v ')}]${r.winner_id ? ` w=${who(r.winner_id)}` : ''}`;
const people = () =>
  [...participants]
    .sort((a, b) => a.attributes.seed - b.attributes.seed)
    .map((p) => `S${p.attributes.seed} ${p.attributes.name}${p.attributes.final_rank != null ? ` rank=${p.attributes.final_rank}` : ''}${p.attributes.states?.active === false ? ' inactive' : ''}`);

/** The groups as their players show them: matches that share a player are in one group. */
function groupsOf(rows) {
  const groups = [];
  for (const r of rows) {
    const players = r.players.filter(Boolean);
    const found = groups.filter((g) => players.some((p) => g.players.has(p)));
    const merged = { players: new Set(players), matches: [r] };
    for (const g of found) {
      g.players.forEach((p) => merged.players.add(p));
      merged.matches.push(...g.matches);
      groups.splice(groups.indexOf(g), 1);
    }
    groups.push(merged);
  }
  return groups
    .map((g) => ({ seeds: [...g.players].map(seedOf).sort((a, b) => a - b), matches: g.matches.sort((a, b) => Number(a.id) - Number(b.id)) }))
    .sort((a, b) => a.seeds[0] - b.seeds[0]);
}

async function changeState(state) {
  const res = await call(state.replaceAll('_', '-'), 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state } } });
  return res.body?.data?.attributes?.state ?? null;
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
async function report(match, winnerId, label) {
  const entries = match.players.map((player) => ({ participant_id: player, score_set: player === winnerId ? '4' : '2', rank: player === winnerId ? 1 : 2, advancing: player === winnerId }));
  const res = await call(label, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, { data: { type: 'Match', attributes: { match: entries } } });
  const a = res.body?.data?.attributes ?? {};
  if (a.state !== 'complete' || text(a.winner_id) !== winnerId) throw new Error(`${label} answered without completing ${line(match)}: ${a.state} w=${text(a.winner_id)}`);
  return `${line(match)} -> w=${who(winnerId)}`;
}
const lowerSeed = (m) => [...m.players].sort((a, b) => seedOf(a) - seedOf(b))[0];

try {
  console.log(`\n[1] ${name}: ${variant.players} players in round robin groups of ${variant.size}, ${variant.advance} advancing to a single elimination final stage${variant.thirdPlace ? ' with a third-place match' : ''}`);
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: `[SPIKE] BXQ two-stage, ${name}`,
        url: `bxq_spike_s21_${Date.now().toString(36)}`,
        tournament_type: 'single elimination',
        private: true,
        ...(variant.thirdPlace ? { match_options: { third_place_match: true, consolation_matches_target_rank: 3 } } : {}),
        group_stage_enabled: true,
        group_stage_options: {
          stage_type: 'round robin',
          group_size: variant.size,
          participant_count_to_advance_per_group: variant.advance,
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
  summary.created = { match_options: made.body.data.attributes?.match_options ?? '(absent)', group_stage_options: made.body.data.attributes?.group_stage_options ?? '(absent)' };

  const list = Array.from({ length: variant.players }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  participants = (await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants: list } } })).body?.data ?? [];
  summary.start_group_stage = await changeState('start_group_stage');

  // The response BXQ's import reads, saved whole for the tests.
  const t = await readTournament('tournament-group-stage');
  const groups = groupsOf(t.rows);
  summary.group_stage = {
    state: t.attributes.state,
    matches: t.rows.length,
    groups: groups.map((g, i) => ({ group: String.fromCharCode(65 + i), seeds: g.seeds, matches: g.matches.map(line) })),
    // BXQ starts a new group at a match "A" whose players it hasn't seen (lib/challonge/stages.ts).
    identifiers_in_id_order: t.rows.map((r) => r.identifier).join(' ')
  };

  if (variant.thirdPlace) {
    console.log('\n[2] group A to a three-way tie, group B by seed');
    const [a, b] = groups;
    // A beats B, B beats C, C beats A: everyone in group A ends 1-1.
    const [s1, s2, s3] = [...a.matches.flatMap((m) => m.players)].filter((p, i, all) => all.indexOf(p) === i).sort((x, y) => seedOf(x) - seedOf(y));
    const beats = new Map([[s1, s2], [s2, s3], [s3, s1]]);
    summary.group_results = [];
    for (const m of a.matches) summary.group_results.push(await report(m, m.players.find((p) => m.players.includes(beats.get(p))), `group-a-${m.identifier}`));
    for (const m of b.matches) summary.group_results.push(await report(m, lowerSeed(m), `group-b-${m.identifier}`));

    console.log('\n[3] end the group stage, start the final stage');
    summary.finalize_group_stage = await changeState('finalize_group_stage');
    const ended = await readTournament('tournament-after-finalize-group-stage');
    summary.after_finalize_group_stage = {
      state: ended.attributes.state,
      tie_breaks: ended.attributes.group_stage_options?.tie_breaks ?? '(absent)',
      ranked_by: ended.attributes.group_stage_options?.ranked_by ?? '(absent)',
      participants: people()
    };
    summary.start = await changeState('start');
    const started = await readTournament('tournament-final-stage');
    const groupIds = new Set(t.rows.map((r) => r.id));
    let finals = started.rows.filter((r) => !groupIds.has(r.id));
    summary.final_stage = { state: started.attributes.state, match_options: started.attributes.match_options ?? '(absent)', matches: finals.map(line) };

    console.log('\n[4] the semifinals, lower seed winning, then what they fill');
    const semis = finals.filter((r) => r.state === 'open');
    summary.semifinals = [];
    for (const m of semis) summary.semifinals.push(await report(m, lowerSeed(m), `semifinal-${m.identifier}`));
    finals = (await readMatches('matches-after-semifinals')).filter((r) => !groupIds.has(r.id));
    summary.after_semifinals = finals.map(line);

    console.log('\n[5] the final and the third-place match');
    summary.last_matches = [];
    for (const m of finals.filter((r) => r.state === 'open')) summary.last_matches.push(await report(m, lowerSeed(m), `last-${m.identifier}`));
    summary.finalize = await changeState('finalize');
    const standings = await call('participants-final', 'GET', `/tournaments/${id}/participants.json?page=1&per_page=100`);
    if (standings.body.data?.length) participants = standings.body.data;
    summary.standings = people();
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
  await saveSummary(`s21-${name}`, summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
