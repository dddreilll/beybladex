// S6: what the two supported formats look like with the options BXQ shows before an import,
// and whether the tournament list carries those options.
// WRITES to the account: it creates two private "[SPIKE]" tournaments, adds placeholder
// participants, starts them, reads them, then resets and deletes them (--keep leaves them).
// Guarded: only runs with --confirm, only ever touches the tournaments it created, and stops at
// the first request Challonge refuses instead of trying again.
import { getAccessToken, api, saveFixture, saveSummary, requestCount } from './lib/challonge.mjs';

if (!process.argv.includes('--confirm')) {
  console.error('This script creates tournaments on your Challonge account. Re-run with --confirm (npm run s6 -- --confirm).');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const PLAYERS = 8;
const stamp = Date.now().toString(36);

// The docs name `third_place_match`; a recorded response has `consolation_matches_target_rank`.
// Both are sent, and the response shows which one Challonge keeps. A name can be 60 characters.
const SPECS = [
  {
    key: 'single-third-place',
    attributes: {
      name: '[SPIKE] BXQ single elim, third-place match',
      url: `bxq_spike_se_${stamp}`,
      tournament_type: 'single elimination',
      private: true,
      match_options: { third_place_match: true, consolation_matches_target_rank: 3 }
    }
  },
  {
    key: 'double-no-grand-finals',
    attributes: {
      name: '[SPIKE] BXQ double elim, no grand finals',
      url: `bxq_spike_de_${stamp}`,
      tournament_type: 'double elimination',
      private: true,
      double_elimination_options: { grand_finals_modifier: 'skip' }
    }
  }
];

const OPTION_KEYS = ['tournament_type', 'group_stage_enabled', 'match_options', 'double_elimination_options'];
const pick = (attributes = {}) => Object.fromEntries(OPTION_KEYS.map((k) => [k, k in attributes ? attributes[k] : '(absent)']));

const token = await getAccessToken();
const created = [];
const summary = { players: PLAYERS, tournaments: {} };

// Saves the response, and stops the run when Challonge refuses the request.
async function step(label, method, path, body) {
  const res = await api(token, method, path, { body });
  await saveFixture(`s6-${label}`, { status: res.status, body: res.body });
  if (res.status >= 400) throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

try {
  for (const spec of SPECS) {
    console.log(`\n[${spec.key}] create, add ${PLAYERS} players, start, read`);
    const made = await step(`${spec.key}-create`, 'POST', '/tournaments.json', { data: { type: 'Tournaments', attributes: spec.attributes } });
    const id = made.body.data.id;
    created.push({ key: spec.key, id });
    console.log(`    created ${id} (https://challonge.com/${made.body.data.attributes?.url})`);

    const participants = Array.from({ length: PLAYERS }, (_, i) => ({ name: `Blader ${String(i + 1).padStart(2, '0')}`, seed: i + 1 }));
    await step(`${spec.key}-participants`, 'POST', `/tournaments/${id}/participants/bulk_add.json`, {
      data: { type: 'Participants', attributes: { participants } }
    });
    await step(`${spec.key}-start`, 'PUT', `/tournaments/${id}/change_state.json`, {
      data: { type: 'TournamentState', attributes: { state: 'start' } }
    });

    // A single tournament has come back with its matches in `included`; ask for them only if it doesn't.
    const read = await step(`${spec.key}-tournament`, 'GET', `/tournaments/${id}.json`);
    let matches = (read.body.included ?? []).filter((r) => r.type === 'match');
    const matchesIncluded = matches.length > 0;
    if (!matchesIncluded) matches = (await step(`${spec.key}-matches`, 'GET', `/tournaments/${id}/matches.json?page=1&per_page=100`)).body.data ?? [];

    const rows = matches
      .map((m) => ({
        identifier: m.attributes.identifier,
        round: m.attributes.round,
        play_order: m.attributes.suggested_play_order,
        state: m.attributes.state
      }))
      .sort((a, b) => (a.play_order ?? 999) - (b.play_order ?? 999));
    const rounds = rows.map((r) => r.round);
    const maxRound = Math.max(...rounds);
    summary.tournaments[spec.key] = {
      id,
      sent: pick(spec.attributes),
      create_response: pick(made.body.data.attributes),
      after_start: pick(read.body.data.attributes),
      matches_in_tournament_response: matchesIncluded,
      match_count: rows.length,
      max_round: maxRound,
      min_round: Math.min(...rounds),
      matches_in_last_round: rows.filter((r) => r.round === maxRound).map((r) => r.identifier),
      matches: rows
    };
    console.log(`    ${rows.length} matches, rounds ${Math.min(...rounds)}..${maxRound}, last round: ${summary.tournaments[spec.key].matches_in_last_round.join(', ')}`);
  }

  console.log('\n[list] do list items carry the same options as a single tournament?');
  const list = await step('list', 'GET', '/tournaments.json?page=1&per_page=10');
  const items = list.body.data ?? [];
  summary.list = {
    count: items.length,
    attribute_keys: Object.keys(items[0]?.attributes ?? {}),
    created_found: created.map(({ key, id }) => {
      const item = items.find((t) => String(t.id) === String(id));
      return { key, found: Boolean(item), options: item ? pick(item.attributes) : null };
    })
  };
} catch (error) {
  summary.error = String(error.message ?? error);
  console.error(`\nStopped: ${summary.error}`);
} finally {
  for (const { key, id } of created) {
    if (keep) {
      console.log(`\nKept ${key}: ${id}. Delete it on challonge.com when you are done.`);
      continue;
    }
    // Challonge refuses to delete a tournament that is underway (422): it goes back to pending first.
    console.log(`\n[${key}] reset and delete ${id}`);
    let res = await api(token, 'PUT', `/tournaments/${id}/change_state.json`, {
      body: { data: { type: 'TournamentState', attributes: { state: 'reset' } } }
    });
    if (res.status < 400) res = await api(token, 'DELETE', `/tournaments/${id}.json`);
    if (res.status >= 400) console.error(`    Could not delete ${id} (${res.status}): ${JSON.stringify(res.body)}. Delete it on challonge.com.`);
    (summary.deleted ??= {})[key] = res.status;
  }
  await saveSummary('s6', summary);
  console.log(`Requests used: ${requestCount()}`);
}
process.exit(summary.error ? 1 : 0);
