// S1b: client-credentials flow (no browser). Read-only.
// Questions: can an organizer's own app get an application:manage token, and which
// tournaments can that token see (application routes vs. the normal user routes)?
import {
  env, tokenRequest, api, saveFixture, saveSummary, redactTokens, requestCount
} from './lib/challonge.mjs';

const clientId = env('CHALLONGE_CLIENT_ID');
const clientSecret = env('CHALLONGE_CLIENT_SECRET');
const tournamentId = env('SPIKE_TOURNAMENT_ID', { optional: true });
const summary = { attempts: {} };

async function tryGrant(label, params) {
  const res = await tokenRequest({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, ...params }, label);
  await saveFixture(`s1b-${label}`, { status: res.status, transport: res.transport, body: redactTokens(res.body) });
  summary.attempts[label] = { status: res.status, scope: res.body?.scope ?? null, expires_in: res.body?.expires_in ?? null, error: res.body?.error ?? null };
  return res.status === 200 ? res.body.access_token : null;
}

console.log('\n[1] Token with scope=application:manage');
let appToken = await tryGrant('scope-application-manage', { scope: 'application:manage' });
if (!appToken) {
  console.log('\n[1b] Token without an explicit scope');
  appToken = await tryGrant('no-scope', {});
}

if (!appToken) {
  summary.conclusion = 'Client-credentials grant refused for this app.';
} else {
  const probes = [
    ['application-tournaments', '/application/tournaments.json?per_page=25'],
    ['user-tournaments', '/tournaments.json?per_page=25'],
    ['me', '/me.json']
  ];
  if (tournamentId) probes.push(['spike-tournament', `/tournaments/${tournamentId}.json`]);

  summary.probes = {};
  for (const [label, path] of probes) {
    console.log(`\n[probe] ${label}`);
    const res = await api(appToken, 'GET', path, { label: `app token: ${label}` });
    await saveFixture(`s1b-probe-${label}`, { status: res.status, body: res.body });
    const data = res.body?.data;
    summary.probes[label] = {
      status: res.status,
      count: Array.isArray(data) ? data.length : (data ? 1 : 0),
      names: Array.isArray(data) ? data.map((t) => t.attributes?.name) : undefined,
      error: res.body?.errors?.[0]?.detail ?? null
    };
  }
}

summary.requests_used = requestCount();
await saveSummary('s1b', summary);
console.log(JSON.stringify(summary, null, 2));
