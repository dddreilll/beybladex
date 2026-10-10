/**
 * Accepts what an organizer is likely to paste: a numeric ID, a URL slug, or a full
 * challonge.com URL. Returns the identifier to use as `tournament_id`, or null.
 * Community tournaments (subdomain URLs) are not supported yet.
 */
export function parseTournamentRef(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!/(^|\.)challonge\.com$/i.test(url.hostname)) return null;
    // challonge.com/<lang>/<slug> and challonge.com/<slug>(/standings etc.)
    const parts = url.pathname.split("/").filter(Boolean);
    const slug = parts.find((p) => !/^[a-z]{2}(-[A-Z]{2})?$/.test(p));
    return slug && /^[A-Za-z0-9_]+$/.test(slug) ? slug : null;
  }
  return /^[A-Za-z0-9_]+$/.test(value) ? value : null;
}
