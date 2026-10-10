import type { TokenResponse } from "./types";

export const CHALLONGE_OAUTH = "https://api.challonge.com/oauth";

export const CHALLONGE_SCOPES = [
  "me",
  "tournaments:read",
  "tournaments:write",
  "matches:read",
  "matches:write",
  "participants:read",
  "participants:write",
] as const;

export function authorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  return `${CHALLONGE_OAUTH}/authorize?${new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: CHALLONGE_SCOPES.join(" "),
    state: params.state,
  })}`;
}

export class TokenRequestError extends Error {
  constructor(
    readonly status: number,
    readonly oauthError: string | null,
  ) {
    super(`Challonge token request failed (${status}${oauthError ? `: ${oauthError}` : ""})`);
    this.name = "TokenRequestError";
  }

  /** The refresh token was revoked or already used: only a new authorization fixes it. */
  get needsReauthorization() {
    return this.oauthError === "invalid_grant" || this.status === 401;
  }
}

type TokenRequestOptions = { fetch?: typeof fetch; onRequest?: () => void | Promise<void> };

// Spike S1 confirmed the token endpoint accepts a standard form-encoded body.
async function tokenRequest(params: Record<string, string>, options: TokenRequestOptions): Promise<TokenResponse> {
  const res = await (options.fetch ?? fetch)(`${CHALLONGE_OAUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
    cache: "no-store",
  });
  await options.onRequest?.();
  const body = (await res.json().catch(() => null)) as (TokenResponse & { error?: string }) | null;
  if (!res.ok || !body?.access_token) throw new TokenRequestError(res.status, body?.error ?? null);
  return body;
}

export function exchangeCode(
  params: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  options: TokenRequestOptions = {},
) {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
    },
    options,
  );
}

/** Challonge rotates the refresh token on every refresh (spike S1): always store the new one. */
export function refreshAccessToken(
  params: { clientId: string; clientSecret: string; refreshToken: string },
  options: TokenRequestOptions = {},
) {
  return tokenRequest(
    {
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    },
    options,
  );
}

export function tokenExpiry(token: TokenResponse, now = Date.now()): Date {
  const issuedAt = token.created_at ? token.created_at * 1000 : now;
  return new Date(issuedAt + (token.expires_in ?? 604800) * 1000);
}
