// S1: bring-your-own OAuth onboarding.
// Runs the authorization-code flow against the organizer's own Challonge app, then tests
// /me and the refresh flow. The client-credentials flow is in s1b-client-credentials.mjs.
import http from 'node:http';
import crypto from 'node:crypto';
import {
  env, tokenRequest, saveTokens, api, saveFixture, saveSummary, redactTokens, requestCount, OAUTH
} from './lib/challonge.mjs';

const clientId = env('CHALLONGE_CLIENT_ID');
const clientSecret = env('CHALLONGE_CLIENT_SECRET');
const redirectUri = env('CHALLONGE_REDIRECT_URI');
const scopes = process.env.CHALLONGE_SCOPES
  || 'me tournaments:read tournaments:write matches:read matches:write participants:read participants:write';

const state = crypto.randomBytes(16).toString('hex');
const callback = new URL(redirectUri);
const authorizeUrl = `${OAUTH}/authorize?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: scopes,
  state
})}`;

const summary = { requested_scopes: scopes };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== callback.pathname) {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('State mismatch. Start again from the URL printed in the terminal.');
    return;
  }
  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(400).end(`Challonge returned an error: ${error}`);
    console.error('Authorization failed:', Object.fromEntries(url.searchParams));
    server.close();
    process.exitCode = 1;
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorized. You can close this tab and go back to the terminal.');
  server.close();
  try {
    await afterAuthorize(url.searchParams.get('code'));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
});

server.listen(Number(callback.port) || 80, () => {
  console.log(`Listening for the OAuth callback on ${redirectUri}`);
  console.log('\nOpen this URL in your browser and approve access:\n');
  console.log(authorizeUrl + '\n');
});

async function afterAuthorize(code) {
  console.log('\n[1/3] Exchanging the authorization code');
  const exchange = await tokenRequest(
    { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri },
    'authorization_code'
  );
  await saveFixture('s1-token-exchange', { status: exchange.status, transport: exchange.transport, body: redactTokens(exchange.body) });
  if (exchange.status !== 200) {
    console.error('Code exchange failed:', exchange.body);
    process.exitCode = 1;
    return;
  }
  await saveTokens(exchange.body);
  summary.token_transport = exchange.transport;
  summary.granted_scopes = exchange.body.scope;
  summary.expires_in = exchange.body.expires_in;
  summary.has_refresh_token = Boolean(exchange.body.refresh_token);

  console.log('\n[2/3] GET /me.json');
  const me = await api(exchange.body.access_token, 'GET', '/me.json');
  await saveFixture('s1-me', me.body);
  summary.me_status = me.status;
  summary.challonge_username = me.body?.data?.attributes?.username;

  console.log('\n[3/3] Refreshing the token');
  const refreshed = await tokenRequest(
    { grant_type: 'refresh_token', refresh_token: exchange.body.refresh_token, client_id: clientId, client_secret: clientSecret },
    'refresh_token'
  );
  await saveFixture('s1-token-refresh', { status: refreshed.status, transport: refreshed.transport, body: redactTokens(refreshed.body) });
  summary.refresh_status = refreshed.status;
  if (refreshed.status === 200) {
    summary.refresh_rotates_refresh_token = Boolean(refreshed.body.refresh_token)
      && refreshed.body.refresh_token !== exchange.body.refresh_token;
    await saveTokens({ ...refreshed.body, refresh_token: refreshed.body.refresh_token ?? exchange.body.refresh_token });
    const meAgain = await api(refreshed.body.access_token, 'GET', '/me.json', { label: 'me with refreshed token' });
    summary.refreshed_token_works = meAgain.status === 200;
  }

  summary.requests_used = requestCount();
  await saveSummary('s1', summary);
  console.log(summary);
}
