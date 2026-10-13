// S7: how round robin and Swiss behave, the two formats BXQ refuses until they are understood,
// and how many matches one list request returns for a large bracket.
// WRITES to the account: it creates three private "[SPIKE]" tournaments, plays two of them through
// the API (results, a tie, a correction, finalize), then resets and deletes all three (--keep
// leaves them).
// Guarded: only runs with --confirm and only touches the tournaments it created. A request
// Challonge refuses ends that tournament's steps, and a 401, 403 or 429 ends the run; nothing is
// tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates tournaments on your Challonge account. Re-run with --confirm (npm run s7 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const stamp = Date.now().toString(36);
const token = await getAccessToken();
const created = [];
const summary = {};

class Abort extends Error {}

// Challonge refuses a create (422) when an options object is incomplete: round robin needs
// `ranking`, and Swiss needs every points field, including `pts_for_bye`, which the docs leave out.
const ROUND_ROBIN = { iterations: 1, ranking: 'match wins' };
const SWISS = { rounds: 2, pts_for_match_win: 1, pts_for_match_tie: 0.5, pts_for_game_win: 0, pts_for_game_tie: 0, pts_for_bye: 1 };

async function call(label, method, path, body, { allowRefusal = false } = {}) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s7-${label}`, { status: res.status, body: res.body });
  const problem = `${label} -> ${res.status}: ${JSON.stringify(res.body)}`;
  if ([401, 403, 429].includes(res.status)) throw new Abort(problem);
  if (res.status >= 400 && !allowRefusal) throw new Error(problem);
  return res;
}

const row = (m) => ({
  id: String(m.id),
  identifier: m.attributes.identifier,
  round: m.attributes.round,
  play_order: m.attributes.suggested_play_order,
  state: m.attributes.state,
  players: (m.attributes.points_by_participant ?? []).map((p) => p.participant_id),
  winner_id: m.attributes.winner_id ?? null,
  tie: m.attributes.tie ?? null,
  scores: m.attributes.scores ?? null
});
const rowsOf = (matches) =>
  matches.map(row).sort((a, b) => (a.play_order ?? 999) - (b.play_order ?? 999) || String(a.identifier).localeCompare(String(b.identifier)));
const playable = (rows) => rows.filter((r) => r.state === 'open' && r.players.length === 2 && r.players.every(Boolean));

function changes(before, after) {
  const was = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  return {
    added: after.filter((r) => !was.has(r.id)),
    removed: before.filter((r) => !now.has(r.id)).map((r) => r.identifier),
    changed: after
      .filter((r) => was.has(r.id) && JSON.stringify(was.get(r.id)) !== JSON.stringify(r))
      .map((r) => ({ before: was.get(r.id), after: r }))
  };
}

// Create, add players, start, read: 4 requests. A single tournament comes back with its matches.
async function create(key, attributes, players) {
  const made = await call(`${key}-create`, 'POST', '/tournaments.json', {
    data: { type: 'Tournaments', attributes: { ...attributes, private: true } }
  });
  const id = made.body.data.id;
  created.push({ key, id });
  console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);
  const participants = Array.from({ length: players }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
  await call(`${key}-participants`, 'POST', `/tournaments/${id}/participants/bulk_add.json`, {
    data: { type: 'Participants', attributes: { participants } }
  });
  await call(`${key}-start`, 'PUT', `/tournaments/${id}/change_state.json`, {
    data: { type: 'TournamentState', attributes: { state: 'start' } }
  });
  const read = await call(`${key}-tournament`, 'GET', `/tournaments/${id}.json`);
  const included = read.body.included ?? [];
  return { id, attributes: read.body.data.attributes, matches: included.filter((r) => r.type === 'match') };
}

const readMatches = (key, id, label, perPage = 100) => call(`${key}-${label}`, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=${perPage}`);

// The entries BXQ sends for a result: rank 1 and `advancing` for the winner.
async function report(key, id, match, winner, label) {
  const entries = match.players.map((player, i) => ({
    participant_id: String(player),
    score_set: i === winner ? '4' : '2',
    rank: i === winner ? 1 : 2,
    advancing: i === winner
  }));
  const res = await call(`${key}-${label}`, 'PUT', `/tournaments/${id}/matches/${match.id}.json`, {
    data: { type: 'Match', attributes: { match: entries } }
  });
  const a = res.body?.data?.attributes ?? {};
  return {
    match: match.identifier,
    sent_winner: String(match.players[winner]),
    status: res.status,
    state: a.state ?? null,
    winner_id: a.winner_id ?? null,
    tie: a.tie ?? null,
    scores: a.scores ?? null,
    // What lib/challonge/report.ts checks before it believes a 200.
    accepted: a.state === 'complete' && String(a.winner_id) === String(match.players[winner])
  };
}

// Finalize, then the placements: 2 requests.
async function finish(key, id) {
  const finalized = await call(`${key}-finalize`, 'PUT', `/tournaments/${id}/change_state.json`, {
    data: { type: 'TournamentState', attributes: { state: 'finalize' } }
  }, { allowRefusal: true });
  const people = await call(`${key}-participants-final`, 'GET', `/tournaments/${id}/participants.json?page=1&per_page=100`);
  const list = people.body.data ?? [];
  return {
    finalize_status: finalized.status,
    state: finalized.body?.data?.attributes?.state ?? null,
    refusal: finalized.status >= 400 ? finalized.body : undefined,
    participant_attribute_keys: Object.keys(list[0]?.attributes ?? {}),
    standings: list
      .map((p) => ({ name: p.attributes.name, seed: p.attributes.seed, final_rank: p.attributes.final_rank ?? null }))
      .sort((a, b) => (a.final_rank ?? 999) - (b.final_rank ?? 999) || a.seed - b.seed)
  };
}

async function scenario(key, run) {
  console.log(`\n=== ${key} ===`);
  const out = (summary[key] = {});
  try {
    await run(out);
  } catch (error) {
    out.error = String(error.message ?? error);
    console.error(`    Stopped: ${out.error}`);
    if (error instanceof Abort) throw error;
  }
}

try {
  await scenario('round-robin', async (out) => {
    const t = await create('rr', {
      name: '[SPIKE] BXQ round robin, 4 players',
      url: `bxq_spike_rr_${stamp}`,
      tournament_type: 'round robin',
      round_robin_options: ROUND_ROBIN
    }, 4);
    const start = rowsOf(t.matches);
    out.options = { round_robin_options: t.attributes.round_robin_options ?? '(absent)', tie_breaks: t.attributes.tie_breaks ?? '(absent)' };
    out.at_start = start;
    const [first, second] = playable(start);

    out.report = await report('rr', t.id, first, 0, 'report');
    // Round robin allows a tie. BXQ never sends one, but an organizer can enter one on challonge.com.
    const tie = await call('rr-tie', 'PUT', `/tournaments/${t.id}/matches/${second.id}.json`, {
      data: {
        type: 'Match',
        attributes: { tie: true, match: second.players.map((player) => ({ participant_id: String(player), score_set: '3', rank: 1, advancing: false })) }
      }
    }, { allowRefusal: true });
    const tied = tie.body?.data?.attributes ?? {};
    out.tie = {
      match: second.identifier,
      status: tie.status,
      state: tied.state ?? null,
      winner_id: tied.winner_id ?? null,
      tie: tied.tie ?? null,
      scores: tied.scores ?? null,
      refusal: tie.status >= 400 ? tie.body : undefined
    };
    out.correction = await report('rr', t.id, first, 1, 'correction');

    const after = rowsOf((await readMatches('rr', t.id, 'matches-after-correction')).body.data ?? []);
    out.changes_since_start = changes(start, after);
    out.finishing = [];
    for (const match of playable(after).slice(0, 6)) out.finishing.push(await report('rr', t.id, match, 0, `finish-${match.identifier}`));
    out.end = await finish('rr', t.id);
  });

  await scenario('swiss', async (out) => {
    // Five players, so one of them has no opponent in each round.
    const t = await create('swiss', {
      name: '[SPIKE] BXQ Swiss, 5 players, 2 rounds',
      url: `bxq_spike_sw_${stamp}`,
      tournament_type: 'swiss',
      swiss_options: SWISS
    }, 5);
    const round1 = rowsOf(t.matches);
    out.options = { swiss_options: t.attributes.swiss_options ?? '(absent)', tie_breaks: t.attributes.tie_breaks ?? '(absent)' };
    out.round_1 = round1;
    const open1 = playable(round1).slice(0, 3);
    out.round_1_reports = [];
    for (const match of open1) out.round_1_reports.push(await report('swiss', t.id, match, 0, `r1-${match.identifier}`));

    // Does Challonge pair the next round by itself once the round is complete?
    const afterRound1 = rowsOf((await readMatches('swiss', t.id, 'matches-after-round-1')).body.data ?? []);
    out.after_round_1 = changes(round1, afterRound1);

    // A round 1 result is corrected after round 2 exists: what happens to round 2?
    out.correction = await report('swiss', t.id, open1[0], 1, 'correction');
    const afterCorrection = rowsOf((await readMatches('swiss', t.id, 'matches-after-correction')).body.data ?? []);
    out.after_correction = changes(afterRound1, afterCorrection);

    out.round_2_reports = [];
    for (const match of playable(afterCorrection).slice(0, 3)) out.round_2_reports.push(await report('swiss', t.id, match, 0, `r2-${match.identifier}`));
    out.end = await finish('swiss', t.id);
  });

  await scenario('big-round-robin', async (out) => {
    // The same create as the first one: if that was refused, this one would be too.
    if (summary['round-robin'].error?.startsWith('rr-create')) throw new Error('skipped: the round robin create was refused');
    // 16 players make 120 matches: more than any list request has returned so far (31).
    const t = await create('big', {
      name: '[SPIKE] BXQ round robin, 16 players',
      url: `bxq_spike_big_${stamp}`,
      tournament_type: 'round robin',
      round_robin_options: ROUND_ROBIN
    }, 16);
    out.matches_in_tournament_response = t.matches.length;
    const list = await readMatches('big', t.id, 'matches-per-page-500', 500);
    const rows = rowsOf(list.body.data ?? []);
    out.list = { returned: rows.length, meta: list.body.meta ?? null, links: list.body.links ?? null };
    out.rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
    out.open_at_start = rows.filter((r) => r.state === 'open').length;
    out.play_order = {
      set_on: rows.filter((r) => r.play_order != null).length,
      of: rows.length,
      first: rows.slice(0, 12).map((r) => `${r.identifier}:r${r.round}:#${r.play_order}`)
    };
  });
} catch (error) {
  summary.aborted = String(error.message ?? error);
  console.error(`\nAborted: ${summary.aborted}`);
} finally {
  for (const { key, id } of created) {
    if (keep) {
      console.log(`\nKept ${key}: ${id}. Delete it on challonge.com when you are done.`);
      continue;
    }
    // Challonge refuses to delete a tournament that is underway (422): it goes back to pending first.
    console.log(`\n[${key}] reset and delete ${id}`);
    const reset = await api(token, 'PUT', `/tournaments/${id}/change_state.json`, {
      body: { data: { type: 'TournamentState', attributes: { state: 'reset' } } }
    });
    const res = await api(token, 'DELETE', `/tournaments/${id}.json`);
    if (res.status >= 400) console.error(`    Could not delete ${id} (reset ${reset.status}, delete ${res.status}): ${JSON.stringify(res.body)}. Delete it on challonge.com.`);
    (summary.deleted ??= {})[key] = { reset: reset.status, delete: res.status };
  }
  summary.requests_used = requestCount();
  await saveSummary('s7', summary);
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.aborted ? 1 : 0);
