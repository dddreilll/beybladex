// S10: why was round 3 missing in S8? That run was a 6-player Swiss of 3 rounds with a tie in
// round 1 and a player dropped during round 2. S9 showed a drop alone doesn't stop the pairing.
// One run plays one variant, to find which ingredient matters and whether the round is only late:
//   --variant=replay   the tie and the drop, as in S8 (the default)
//   --variant=no-tie   the drop, but round 1 has three winners
//   --variant=no-drop  the tie, but nobody drops
// When round 3 is missing it reads again after 30 seconds, and once more after another 60.
// WRITES to the account: it creates one private "[SPIKE]" tournament, plays it through the API and
// resets and deletes it (--keep leaves it).
// Guarded: only runs with --confirm and only touches the tournament it created. It stops at the
// first request Challonge refuses; nothing is tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

const VARIANTS = { replay: { tie: true, drop: true }, 'no-tie': { tie: false, drop: true }, 'no-drop': { tie: true, drop: false } };
const name = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1] ?? 'replay';
const variant = VARIANTS[name];
if (!variant) {
  console.error(`Unknown variant "${name}". Use one of: ${Object.keys(VARIANTS).join(', ')}.`);
  process.exit(1);
}
if (!process.argv.includes('--confirm')) {
  console.error('This script creates a tournament on your Challonge account. Re-run with --confirm (npm run s10 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const token = await getAccessToken();
const summary = { variant: name, ...variant };
let id = null;

async function call(label, method, path, body) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s10-${name}-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

const row = (m) => ({
  id: String(m.id),
  identifier: m.attributes.identifier,
  round: m.attributes.round,
  play_order: m.attributes.suggested_play_order,
  state: m.attributes.state,
  players: (m.attributes.points_by_participant ?? []).map((p) => String(p.participant_id)),
  winner_id: m.attributes.winner_id ?? null,
  tie: m.attributes.tie ?? null,
  scores: m.attributes.scores ?? null
});
// The same order S8 used, so the same player drops.
const rowsOf = (resources) =>
  resources
    .filter((r) => r.type === 'match')
    .map(row)
    .sort((a, b) => (a.play_order ?? 999) - (b.play_order ?? 999) || String(a.identifier).localeCompare(String(b.identifier)));
const inRound = (rows, round) => rows.filter((r) => r.round === round);
const readMatches = async (label) => rowsOf((await call(label, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? []);
const wait = (seconds) => {
  console.log(`    waiting ${seconds} s`);
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};
const matchPath = (match) => `/tournaments/${id}/matches/${match.id}.json`;

// The entries BXQ sends for a result: the first player wins.
async function win(match, label) {
  const entries = match.players.map((player, i) => ({ participant_id: player, score_set: i === 0 ? '4' : '2', rank: i === 0 ? 1 : 2, advancing: i === 0 }));
  const res = await call(`${label}-${match.identifier}`, 'PUT', matchPath(match), { data: { type: 'Match', attributes: { match: entries } } });
  return `${match.identifier}:${res.body?.data?.attributes?.state}`;
}

async function tie(match, label) {
  const entries = match.players.map((player) => ({ participant_id: player, score_set: '3', rank: 1, advancing: false }));
  const res = await call(`${label}-${match.identifier}-tie`, 'PUT', matchPath(match), { data: { type: 'Match', attributes: { tie: true, match: entries } } });
  const a = res.body?.data?.attributes ?? {};
  return `${match.identifier}:${a.state}:tie=${a.tie}`;
}

// The whole tournament in one request: its state, every player's `active`, and its matches.
async function readTournament(label) {
  const res = await call(label, 'GET', `/tournaments/${id}.json`);
  const included = res.body.included ?? [];
  const a = res.body.data.attributes;
  return {
    rows: rowsOf(included),
    info: {
      state: a.state,
      progress_meter: a.progress_meter,
      rounds: a.swiss_options?.rounds ?? null,
      participants_count: a.participants_count,
      inactive: included.filter((r) => r.type === 'participant' && r.attributes.states?.active === false).map((p) => p.attributes.name)
    }
  };
}

try {
  console.log(`\n[1] ${name}: create a 6-player Swiss with 3 rounds, start it`);
  const made = await call('create', 'POST', '/tournaments.json', {
    data: {
      type: 'Tournaments',
      attributes: {
        name: `[SPIKE] BXQ Swiss 6 players, 3 rounds, ${name}`,
        url: `bxq_spike_s10_${Date.now().toString(36)}`,
        tournament_type: 'swiss',
        private: true,
        swiss_options: { rounds: 3, pts_for_match_win: 1, pts_for_match_tie: 0.5, pts_for_game_win: 0, pts_for_game_tie: 0, pts_for_bye: 1 }
      }
    }
  });
  id = made.body.data.id;
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const participants = Array.from({ length: 6 }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await call('participants', 'POST', `/tournaments/${id}/participants/bulk_add.json`, { data: { type: 'Participants', attributes: { participants } } });
  await call('start', 'PUT', `/tournaments/${id}/change_state.json`, { data: { type: 'TournamentState', attributes: { state: 'start' } } });
  const started = await readTournament('tournament');

  console.log(`\n[2] round 1${variant.tie ? ', with a tie in the first match' : ''}`);
  const [first, ...rest] = inRound(started.rows, 1);
  summary.round_1 = [variant.tie ? await tie(first, 'r1') : await win(first, 'r1')];
  for (const match of rest) summary.round_1.push(await win(match, 'r1'));

  const afterRound1 = await readMatches('matches-after-round-1');
  const round2 = inRound(afterRound1, 2);
  summary.round_2_paired = round2.map((r) => `${r.identifier}:[${r.players.join(' v ')}]`);
  if (round2.length === 0) throw new Error('round 2 was not paired');

  console.log(`\n[3] round 2${variant.drop ? ', after the first player of its first match drops out' : ''}`);
  summary.round_2 = [];
  let toPlay = round2;
  if (variant.drop) {
    const dropped = round2[0].players[0];
    const drop = await call('drop', 'DELETE', `/tournaments/${id}/participants/${dropped}.json`);
    summary.drop = { participant: dropped, their_open_match: round2[0].identifier, status: drop.status, states: drop.body?.data?.attributes?.states ?? null };
    // Challonge completes their match as a forfeit (S8, S9), so only the other two are played.
    toPlay = round2.slice(1);
  }
  for (const match of toPlay) summary.round_2.push(await win(match, 'r2'));

  console.log('\n[4] is round 3 there?');
  let rows = await readMatches('matches-after-round-2');
  summary.round_2_states = inRound(rows, 2).map((r) => `${r.identifier}:${r.state}${r.tie ? ':tie' : ''}${r.winner_id ? `:w${r.winner_id}` : ''}:${r.scores}`);
  summary.round_3_at_once = inRound(rows, 3).length;
  if (summary.round_3_at_once === 0) {
    await wait(30);
    let later = await readTournament('tournament-after-30s');
    summary.after_30s = { round_3: inRound(later.rows, 3).length, ...later.info };
    if (summary.after_30s.round_3 === 0) {
      await wait(60);
      later = await readTournament('tournament-after-90s');
      summary.after_90s = { round_3: inRound(later.rows, 3).length, ...later.info };
    }
    rows = later.rows;
  }
  summary.round_3 = inRound(rows, 3).map((r) => `${r.identifier}:${r.state}:[${r.players.join(' v ')}]`);
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
  await saveSummary(`s10-${name}`, summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
