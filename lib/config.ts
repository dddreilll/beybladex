// Placeholder product name until the organizer picks one; change it here only.
export const APP_NAME = "Stadium Control";

/** Challonge's free API tier; organizers on a paid plan can raise it later. */
export const FREE_TIER_MONTHLY_REQUESTS = 500;

/** The most call board screens an organizer can allow per tournament. */
export const MAX_BOARD_LIMIT = 10;

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Must match, exactly, a redirect URI registered on the organizer's Challonge app. */
export function challongeRedirectUri(): string {
  return `${appUrl()}/api/challonge/oauth/callback`;
}

export const OAUTH_NONCE_COOKIE = "challonge_oauth_nonce";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Only allow same-site relative redirects (blocks `//evil.com` and absolute URLs). */
export function safeNextPath(next: string | null | undefined, fallback = "/tournaments"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
