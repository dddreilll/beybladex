// "BX" (the Beyblade X product line code) plus "Q" for queue. Screen names are in docs/brand.md.
export const APP_NAME = "BXQ";
export const APP_TAGLINE = "Your stadium is ready.";

/** The most call board screens an organizer can allow per tournament. */
export const MAX_BOARD_LIMIT = 10;

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Where "Request Early Access" on the landing page leads: a form or a chat link, set per
 * deployment. Without a valid http(s) URL the button is shown disabled.
 */
export function earlyAccessUrl(): string | null {
  const value = process.env.EARLY_ACCESS_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Who runs this deployment, as named in the Terms of Service and Privacy Policy. The app is
 * open source and anyone can host it, so the name and contact are set per deployment.
 */
export function operatorName(): string | null {
  return process.env.OPERATOR_NAME?.trim() || null;
}

/** Where questions about the terms or about someone's data go; left out of both pages when unset or not an address. */
export function contactEmail(): string | null {
  const value = process.env.CONTACT_EMAIL?.trim() ?? "";
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value) ? value : null;
}

/** Only allow same-site relative redirects (blocks `//evil.com` and absolute URLs). */
export function safeNextPath(next: string | null | undefined, fallback = "/tournaments"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
