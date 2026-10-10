// Throwaway spike helpers. Not app code: no retries, no types, minimal error handling.
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.resolve(here, '..', 'out');
export const API = 'https://api.challonge.com/v2.1';
export const OAUTH = 'https://api.challonge.com/oauth';
const TOKENS_FILE = path.join(OUT, 'tokens.json');

let count = 0;
export const requestCount = () => count;

export function env(name, { optional = false } = {}) {
  const value = process.env[name];
  if (!value && !optional) {
    console.error(`Missing env var ${name}. Copy spikes/.env.example to spikes/.env and fill it in.`);
    process.exit(1);
  }
  return value;
}

async function ensureOut() {
  await mkdir(path.join(OUT, 'fixtures'), { recursive: true });
}

export async function saveFixture(label, data) {
  await ensureOut();
  const file = path.join(OUT, 'fixtures', `${label}.json`);
  await writeFile(file, JSON.stringify(data, null, 2));
  return file;
}

export async function saveSummary(name, data) {
  await ensureOut();
  await writeFile(path.join(OUT, `summary-${name}.json`), JSON.stringify(data, null, 2));
  console.log(`\nSummary written to spikes/out/summary-${name}.json`);
}

// Headers worth keeping for S2: caching and any rate-limit hints Challonge may send.
const INTERESTING_HEADERS = /^(etag|cache-control|last-modified|x-rate|ratelimit|retry-after|x-request-id|x-runtime)/i;

function pickHeaders(headers) {
  const out = {};
  for (const [key, value] of headers) if (INTERESTING_HEADERS.test(key)) out[key] = value;
  return out;
}

function redactUrl(url) {
  return url.replace(/(client_secret|code|refresh_token|access_token)=[^&]+/g, '$1=***');
}

export function redactTokens(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = { ...body };
  for (const key of ['access_token', 'refresh_token', 'id_token']) {
    if (typeof copy[key] === 'string') copy[key] = `***${copy[key].slice(-4)}`;
  }
  return copy;
}

// Every request to Challonge (API and OAuth) goes through here so the local count
// can be compared with the usage shown in the Developer Portal.
export async function rawFetch(url, init = {}, label = '') {
  count += 1;
  const started = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const entry = {
    n: count,
    at: new Date().toISOString(),
    label,
    method: init.method ?? 'GET',
    url: redactUrl(url),
    status: res.status,
    ms: Date.now() - started,
    headers: pickHeaders(res.headers)
  };
  await ensureOut();
  await appendFile(path.join(OUT, 'requests.jsonl'), JSON.stringify(entry) + '\n');
  console.log(`  #${count} ${entry.method} ${entry.url} -> ${res.status} (${entry.ms} ms)`);
  return { status: res.status, headers: res.headers, body };
}

// The token-request docs list parameters as query params, while the Authorization guide
// describes a standard OAuth form post. Try the form body first and record which one works.
export async function tokenRequest(params, label) {
  const form = new URLSearchParams(params);
  let res = await rawFetch(
    `${OAUTH}/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form },
    `${label} (form body)`
  );
  if (res.status >= 400) {
    console.log('  Form body rejected; retrying with query params.');
    res = await rawFetch(`${OAUTH}/token?${form}`, { method: 'POST', headers: { Accept: 'application/json' } }, `${label} (query params)`);
    res.transport = 'query';
  } else {
    res.transport = 'form';
  }
  return res;
}

export async function saveTokens(tokens) {
  await ensureOut();
  await writeFile(TOKENS_FILE, JSON.stringify({ ...tokens, saved_at: new Date().toISOString() }, null, 2));
}

async function loadTokens() {
  try {
    return JSON.parse(await readFile(TOKENS_FILE, 'utf8'));
  } catch {
    console.error('No tokens yet. Run `npm run s1` first (see spikes/README.md).');
    process.exit(1);
  }
}

// Refreshes the access token when it is within 5 minutes of expiring.
export async function getAccessToken() {
  const tokens = await loadTokens();
  const issuedAt = tokens.created_at ? tokens.created_at * 1000 : Date.parse(tokens.saved_at);
  const expiresAt = issuedAt + (tokens.expires_in ?? 0) * 1000;
  if (!tokens.expires_in || Date.now() < expiresAt - 5 * 60 * 1000) return tokens.access_token;

  console.log('Access token expired or about to; refreshing.');
  const res = await tokenRequest(
    {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: env('CHALLONGE_CLIENT_ID'),
      client_secret: env('CHALLONGE_CLIENT_SECRET')
    },
    'refresh'
  );
  if (res.status !== 200) {
    console.error('Refresh failed. Run `npm run s1` again.', res.body);
    process.exit(1);
  }
  await saveTokens({ ...res.body, refresh_token: res.body.refresh_token ?? tokens.refresh_token });
  return res.body.access_token;
}

export function withCommunity(pathAndQuery) {
  const community = process.env.CHALLONGE_COMMUNITY_ID;
  if (!community) return pathAndQuery;
  return pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') + `community_id=${encodeURIComponent(community)}`;
}

export async function api(token, method, pathAndQuery, { body, headers = {}, label } = {}) {
  return rawFetch(
    `${API}${withCommunity(pathAndQuery)}`,
    {
      method,
      headers: {
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/json',
        'Authorization-Type': 'v2',
        Authorization: `Bearer ${token}`,
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    },
    label ?? `${method} ${pathAndQuery}`
  );
}

export async function listAll(token, basePath, perPage = 100) {
  const all = [];
  for (let page = 1; ; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const res = await api(token, 'GET', `${basePath}${sep}page=${page}&per_page=${perPage}`);
    if (res.status !== 200) throw new Error(`${basePath} page ${page} -> ${res.status}: ${JSON.stringify(res.body)}`);
    const data = res.body?.data ?? [];
    all.push(...data);
    if (data.length < perPage) return all;
  }
}

// The docs show player1/player2 relationships, but real v2.1 responses only carry the
// players in attributes.points_by_participant (participant_id is null until a slot is filled).
export function playersOf(match) {
  const rel = match.relationships ?? {};
  if (rel.player1 || rel.player2) return [rel.player1?.data?.id ?? null, rel.player2?.data?.id ?? null];
  const slots = match.attributes?.points_by_participant ?? [];
  return [slots[0]?.participant_id ?? null, slots[1]?.participant_id ?? null];
}

export function matchSummary(match) {
  const a = match.attributes ?? {};
  const [player1, player2] = playersOf(match);
  return {
    id: match.id,
    identifier: a.identifier,
    round: a.round,
    state: a.state,
    player1,
    player2,
    winner_id: a.winner_id ?? null,
    scores: a.scores ?? null,
    underway_at: a.timestamps?.underway_at ?? null
  };
}

export function diffMatches(before, after) {
  const prev = new Map(before.map((m) => [m.id, matchSummary(m)]));
  const changes = [];
  for (const m of after) {
    const now = matchSummary(m);
    const was = prev.get(m.id);
    if (JSON.stringify(was) !== JSON.stringify(now)) changes.push({ id: m.id, before: was ?? null, after: now });
  }
  return changes;
}
