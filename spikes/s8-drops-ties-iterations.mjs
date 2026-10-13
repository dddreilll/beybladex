// S8: what S7 left untested. In Swiss: a tie, and a player who drops out after round 1. In round
// robin: an odd number of players and two iterations.
// WRITES to the account: it creates two private "[SPIKE]" tournaments, plays part of the Swiss one
// through the API (a tie, results, a dropped player), then resets and deletes both (--keep leaves
// them).
// Guarded: only runs with --confirm and only touches the tournaments it created. A request
// Challonge refuses ends that tournament's steps, and a 401, 403 or 429 ends the run; nothing is
// tried twice.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates tournaments on your Challonge account. Re-run with --confirm (npm run s8 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const stamp = Date.now().toString(36);
const token = await getAccessToken();
const created = [];
const summary = {};

class Abort extends Error {}

async function call(label, method, path, body, { allowRefusal = false } = {}) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s8-${label}`, { status: res.status, body: res.body });
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
const rowsOf = (resources) =>
  resources
    .filter((r) => r.type === 'match')
    .map(row)
    .sort((a, b) => (a.play_order ?? 999) - (b.play_order ?? 999) || String(a.identifier).localeCompare(String(b.identifier)));
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
  return { id, attributes: read.body.data.attributes, included: read.body.included ?? [] };
}

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
    accepted: a.state === 'complete' && String(a.winner_id) === String(match.players[winner])
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
  await scenario('swiss', async (out) => {
    // An options object has to be complete, `pts_for_bye` included (spike S7).
    const t = await create('swiss', {
      name: '[SPIKE] BXQ Swiss, 6 players, 3 rounds',
      url: `bxq_spike_sw_${stamp}`,
      tournament_type: 'swiss',
      swiss_options: { rounds: 3, pts_for_match_win: 1, pts_for_match_tie: 0.5, pts_for_game_win: 0, pts_for_game_tie: 0, pts_for_bye: 1 }
    }, 6);
    const names = new Map(t.included.filter((r) => r.type === 'participant').map((p) => [String(p.id), p.attributes.name]));
    out.participants = Object.fromEntries(names);
    const round1 = rowsOf(t.included);
    out.round_1 = round1;
    const [first, ...rest] = playable(round1);

    // A tie in round 1: is it accepted, and is round 2 still paired?
    const tie = await call('swiss-tie', 'PUT', `/tournaments/${t.id}/matches/${first.id}.json`, {
      data: {
        type: 'Match',
        attributes: { tie: true, match: first.players.map((player) => ({ participant_id: String(player), score_set: '3', rank: 1, advancing: false })) }
      }
    }, { allowRefusal: true });
    const tied = tie.body?.data?.attributes ?? {};
    out.tie = {
      match: first.identifier,
      status: tie.status,
      state: tied.state ?? null,
      winner_id: tied.winner_id ?? null,
      tie: tied.tie ?? null,
      scores: tied.scores ?? null,
      refusal: tie.status >= 400 ? tie.body : undefined
    };
    out.round_1_reports = [];
    // If the tie didn't complete the match, give it a winner so the round can end.
    if (tied.state !== 'complete') out.round_1_reports.push(await report('swiss', t.id, first, 0, `r1-${first.identifier}`));
    for (const match of rest.slice(0, 2)) out.round_1_reports.push(await report('swiss', t.id, match, 0, `r1-${match.identifier}`));

    const afterRound1 = rowsOf((await call('swiss-matches-after-round-1', 'GET', `/tournaments/${t.id}/matches.json?page=1&per_page=100`)).body.data ?? []);
    out.after_round_1 = changes(round1, afterRound1);

    // A player drops out with a round 2 match still to play.
    const theirs = playable(afterRound1).find((r) => r.round === 2);
    if (!theirs) throw new Error('round 2 was not paired, so there is nobody to drop');
    const dropped = String(theirs.players[0]);
    const drop = await call('swiss-drop', 'DELETE', `/tournaments/${t.id}/participants/${dropped}.json`, undefined, { allowRefusal: true });
    out.drop = {
      participant: `${dropped} (${names.get(dropped)})`,
      their_open_match: theirs.identifier,
      status: drop.status,
      states: drop.body?.data?.attributes?.states ?? null,
      refusal: drop.status >= 400 ? drop.body : undefined
    };

    // One read shows the count the app compares, each player's `active`, and what became of their match.
    const read = await call('swiss-tournament-after-drop', 'GET', `/tournaments/${t.id}.json`);
    const included = read.body.included ?? [];
    const afterDrop = rowsOf(included);
    out.after_drop = {
      participants_count: { before: t.attributes.participants_count, after: read.body.data.attributes.participants_count },
      participants: included
        .filter((r) => r.type === 'participant')
        .map((p) => ({ id: String(p.id), name: p.attributes.name, active: p.attributes.states?.active ?? null })),
      matches: changes(afterRound1, afterDrop)
    };

    out.round_2_reports = [];
    for (const match of playable(afterDrop).slice(0, 3)) {
      // If their match is still open, the player who stayed wins it.
      const winner = String(match.players[0]) === dropped ? 1 : 0;
      out.round_2_reports.push(await report('swiss', t.id, match, winner, `r2-${match.identifier}`));
    }
    const afterRound2 = rowsOf((await call('swiss-matches-after-round-2', 'GET', `/tournaments/${t.id}/matches.json?page=1&per_page=100`)).body.data ?? []);
    out.after_round_2 = changes(afterDrop, afterRound2);
  });

  await scenario('round-robin-twice', async (out) => {
    // Three players: one sits out each round. Two iterations: everyone meets twice.
    const t = await create('rr2', {
      name: '[SPIKE] BXQ round robin, 3 players, twice',
      url: `bxq_spike_rr2_${stamp}`,
      tournament_type: 'round robin',
      round_robin_options: { iterations: 2, ranking: 'match wins' }
    }, 3);
    const rows = rowsOf(t.included);
    out.options = t.attributes.round_robin_options ?? '(absent)';
    out.matches = rows;
    out.rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
    out.open_at_start = rows.filter((r) => r.state === 'open').length;
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
  await saveSummary('s8', summary);
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.aborted ? 1 : 0);
