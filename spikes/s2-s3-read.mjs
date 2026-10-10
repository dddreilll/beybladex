// S2 + S3 (read-only): request budget behaviour and bracket-progression fields.
// Safe to run against any tournament; it never writes.
import {
  env, getAccessToken, api, listAll, saveFixture, saveSummary, requestCount
} from './lib/challonge.mjs';

const tournamentId = env('SPIKE_TOURNAMENT_ID');
const token = await getAccessToken();
const summary = { tournament_id: tournamentId };

console.log('\n[1/6] Your tournaments (to confirm the ID)');
const list = await api(token, 'GET', '/tournaments.json?per_page=25');
await saveFixture('s2-tournaments', list.body);
for (const t of list.body?.data ?? []) {
  console.log(`    ${t.id}  ${t.attributes?.name}  [${t.attributes?.state}]`);
}

console.log('\n[2/6] The test tournament');
const tournament = await api(token, 'GET', `/tournaments/${tournamentId}.json`);
await saveFixture('s2-tournament', tournament.body);
summary.tournament_status = tournament.status;
summary.tournament_name = tournament.body?.data?.attributes?.name;
summary.tournament_state = tournament.body?.data?.attributes?.state;
summary.tournament_type = tournament.body?.data?.attributes?.tournament_type;

console.log('\n[3/6] Participants');
const participants = await listAll(token, `/tournaments/${tournamentId}/participants.json`, 100);
await saveFixture('s2-participants', participants);
summary.participant_count = participants.length;

console.log('\n[4/6] per_page sweep on matches (does the server cap it?)');
summary.per_page = {};
let firstPage;
for (const perPage of [25, 100, 500]) {
  const res = await api(token, 'GET', `/tournaments/${tournamentId}/matches.json?page=1&per_page=${perPage}`);
  summary.per_page[perPage] = {
    status: res.status,
    returned: res.body?.data?.length ?? null,
    top_level_keys: res.body && typeof res.body === 'object' ? Object.keys(res.body) : null
  };
  if (perPage === 500) firstPage = res;
}
await saveFixture('s2-matches', firstPage.body);

console.log('\n[5/6] Conditional request with If-None-Match');
const etag = firstPage.headers.get('etag');
summary.etag_present = Boolean(etag);
summary.cache_control = firstPage.headers.get('cache-control');
if (etag) {
  const again = await api(token, 'GET', `/tournaments/${tournamentId}/matches.json?page=1&per_page=500`, {
    headers: { 'If-None-Match': etag },
    label: 'matches with If-None-Match'
  });
  summary.conditional_status = again.status;
  console.log(`    Conditional GET returned ${again.status}${again.status === 304 ? ' (Not Modified)' : ''}`);
} else {
  console.log('    No ETag header on the response; conditional requests are not available.');
}

console.log('\n[6/6] Inspecting match fields for progression links (S3)');
const matches = firstPage.body?.data ?? [];
const attributeKeys = new Set();
const relationshipKeys = new Set();
const objectKeys = new Set();
for (const m of matches) {
  Object.keys(m).forEach((k) => objectKeys.add(k));
  Object.keys(m.attributes ?? {}).forEach((k) => attributeKeys.add(k));
  Object.keys(m.relationships ?? {}).forEach((k) => relationshipKeys.add(k));
}
const progressionHint = /prereq|next|loser|winner|source|destination|underway|station|bracket|group/i;
summary.match_count = matches.length;
summary.match_object_keys = [...objectKeys];
summary.match_attribute_keys = [...attributeKeys];
summary.match_relationship_keys = [...relationshipKeys];
summary.possible_progression_fields = [...attributeKeys, ...relationshipKeys].filter((k) => progressionHint.test(k));
summary.included_present = Array.isArray(firstPage.body?.included);

summary.requests_used = requestCount();
await saveSummary('s2-s3', summary);
console.log(summary);
console.log(`\nCompare: this run made ${summary.requests_used} requests. Check how much the usage in the Developer Portal went up.`);
