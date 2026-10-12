"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

export type SignInOutcome = { ok: true } | { ok: false; error: string };

/** Signs this device in as a player; the server answers with the session cookie. */
export async function signIn(slug: string, credentials: { playerId: string; code: string } | { token: string }): Promise<SignInOutcome> {
  try {
    const res = await fetch(`/api/public/${slug}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: (await res.json().catch(() => null))?.error ?? "Couldn't sign in. Try again." };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
}

export async function signOut(slug: string) {
  await fetch(`/api/public/${slug}/session`, { method: "DELETE" }).catch(() => {});
}

// A personal QR code opens /t/<slug>#k=<secret>. The secret sits after the #, which browsers never
// send to a server: link previews and scanners that fetch the address can't sign anyone in (and,
// with one screen per player, can't sign the real player out).
const subscribeHash = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const hashSecret = () => window.location.hash.match(/^#k=([a-f0-9]{32})$/)?.[1] ?? null;

/** Signs in with the secret from a scanned QR code, if the address carries one. */
export function useQrSignIn(slug: string): { working: boolean; error: string | null } {
  const router = useRouter();
  const secret = useSyncExternalStore(subscribeHash, hashSecret, () => null);
  const [done, setDone] = useState<{ secret: string; error: string | null } | null>(null);
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!secret || started.current === secret) return;
    started.current = secret;
    void signIn(slug, { token: secret }).then((outcome) => {
      // Used once: keep the secret out of the address bar, history and any screenshot.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setDone({ secret, error: outcome.ok ? null : outcome.error });
      if (outcome.ok) router.refresh();
    });
  }, [secret, slug, router]);

  return { working: secret !== null && done?.secret !== secret, error: done?.error ?? null };
}
