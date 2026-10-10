import { z } from "zod";
import { callLabel } from "@/lib/call-label";

// The subscribe endpoint is public and the server later POSTs to the stored URL, so only the
// real browser push services are accepted (otherwise it would be a way to make our server
// call arbitrary addresses).
const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge on Android, most Chromium browsers
  ".push.services.mozilla.com", // Firefox
  ".notify.windows.com", // Edge on Windows
  ".push.apple.com", // Safari (web.push.apple.com)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed));
}

const base64url = z.string().regex(/^[A-Za-z0-9_-]+=*$/);

export const subscribeSchema = z.object({
  playerId: z.string().regex(/^\d{1,20}$/),
  subscription: z.object({
    endpoint: z.string().max(1000).refine(isAllowedPushEndpoint, "Unsupported push service."),
    keys: z.object({ p256dh: base64url.max(200), auth: base64url.max(100) }),
  }),
});

export const unsubscribeSchema = z.object({ endpoint: z.string().max(1000) });

export type PushPayload = { title: string; body: string; tag: string; url: string };

export function callPayload(input: {
  status: "called" | "on_deck";
  stadium: string;
  opponent: string;
  label: string;
  slug: string;
  matchId: string;
  /** 2 or more when the organizer recalls players who haven't shown up. */
  callNumber?: number;
}): PushPayload {
  const called = input.status === "called";
  const repeat = called ? callLabel(input.callNumber ?? 1) : null;
  return {
    title: repeat ? `${repeat}: ${input.stadium}` : called ? `You're up at ${input.stadium}` : `On deck at ${input.stadium}`,
    body: called
      ? `vs ${input.opponent} · ${input.label}. Head there now.`
      : `vs ${input.opponent} · ${input.label}. You play after the current match.`,
    // Same tag for both stages of one match: "you're up" replaces "on deck" instead of stacking.
    tag: `match-${input.matchId}`,
    url: `/t/${input.slug}`,
  };
}
