// S0: adds placeholder participants to the [SPIKE] tournament so S2/S3/S4 have matches to inspect.
// One request (bulk_add takes up to 20). Guarded the same way as S4.
import { env, getAccessToken, api, saveFixture, requestCount } from './lib/challonge.mjs';

const tournamentId = env('SPIKE_TOURNAMENT_ID');
const count = Number(process.argv.find((a) => /^--count=\d+$/.test(a))?.split('=')[1] ?? 16);
if (count < 2 || count > 20) {
  console.error('--count must be between 2 and 20 (bulk_add limit).');
  process.exit(1);
}

const token = await getAccessToken();
const tournament = await api(token, 'GET', `/tournaments/${tournamentId}.json`);
const attrs = tournament.body?.data?.attributes ?? {};
if (!String(attrs.name ?? '').startsWith('[SPIKE]')) {
  console.error(`Refusing to run: tournament name "${attrs.name}" does not start with "[SPIKE]".`);
  process.exit(1);
}
if (attrs.state !== 'pending') {
  console.error(`Tournament is ${attrs.state}; participants can only be added before it starts. Reset it on challonge.com first.`);
  process.exit(1);
}
if (attrs.participants_count > 0) {
  console.error(`Tournament already has ${attrs.participants_count} participants; nothing to do.`);
  process.exit(0);
}

const participants = Array.from({ length: count }, (_, i) => ({
  name: `Blader ${String(i + 1).padStart(2, '0')}`,
  seed: i + 1,
  misc: `spike-${i + 1}`
}));

const res = await api(token, 'POST', `/tournaments/${tournamentId}/participants/bulk_add.json`, {
  body: { data: { type: 'Participants', attributes: { participants } } }
});
await saveFixture('s0-bulk-add', { status: res.status, body: res.body });
console.log(res.status < 400 ? `\nAdded ${count} participants.` : `\nBulk add failed: ${JSON.stringify(res.body)}`);
console.log(`Requests used: ${requestCount()}`);
