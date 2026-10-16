"use client";

import { useEffect, useRef, useState } from "react";
import { hasEnvVars } from "@/lib/utils";

/** How often a screen still checks by itself while Realtime is delivering changes to it. */
export const SAFETY_INTERVAL_MS = 60_000;

/**
 * Tells our own server, as the tab closes, that this screen is going away, so the control room
 * shows it closed at once. A beacon is fire-and-forget: offline it is simply lost, and the screen
 * counts as open until its last check-in is old (SCREEN_OPEN_MS in lib/access.ts). `onBack` runs
 * when the browser brings the page back from its cache, so that it checks in again.
 */
export function useCloseSignal(url: string | null, onBack?: () => void) {
  const back = useRef(onBack);
  useEffect(() => {
    back.current = onBack;
  });
  useEffect(() => {
    if (!url) return;
    const bye = () => navigator.sendBeacon?.(url);
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) back.current?.();
    };
    window.addEventListener("pagehide", bye);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", bye);
      window.removeEventListener("pageshow", show);
    };
  }, [url]);
}

/**
 * Listens for the "board changed" push that a database trigger sends through Supabase Realtime
 * whenever tournaments.board_version moves. The channel is public, so a push is only a hint to
 * go and check: what a screen shows always comes from our own server.
 * Returns whether the channel is connected; while it isn't, callers keep polling at their usual rate.
 */
export function useBoardSignal(slug: string, enabled: boolean, onChange: () => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onChange);
  useEffect(() => {
    handler.current = onChange;
  });

  useEffect(() => {
    if (!enabled || !hasEnvVars) return;
    let cancelled = false;
    let leave: (() => void) | undefined;
    // Loaded on demand, so screens that only poll (player phones) don't download the Supabase client.
    void import("@/lib/supabase/client").then(({ createClient }) => {
      if (cancelled) return;
      const supabase = createClient();
      const channel = supabase
        .channel(`board:${slug}`)
        .on("broadcast", { event: "changed" }, () => handler.current())
        .subscribe((status) => {
          setConnected(status === "SUBSCRIBED");
          // Connected or reconnected: anything pushed before now was missed, so check at once.
          if (status === "SUBSCRIBED") handler.current();
        });
      leave = () => void supabase.removeChannel(channel);
    });
    return () => {
      cancelled = true;
      leave?.();
      setConnected(false);
    };
  }, [slug, enabled]);

  return connected;
}

/**
 * Runs `check` every `waitMs`, and straight away when `now()` is called or the tab comes back into
 * view. Skips while the tab is hidden, and never overlaps: a request for a check that arrives
 * during one runs a single follow-up. A check that returns "stop" waits for the next `now()`.
 */
export function startChecks(check: () => Promise<"stop" | void>, waitMs: number) {
  let stopped = false;
  let running = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout>;

  const run = async () => {
    clearTimeout(timer);
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    const result = document.visibilityState === "visible" ? await check() : undefined;
    running = false;
    if (stopped) return;
    if (result === "stop") queued = false;
    else if (queued) {
      queued = false;
      void run();
    } else timer = setTimeout(run, waitMs);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void run();
  };

  document.addEventListener("visibilitychange", onVisible);
  timer = setTimeout(run, waitMs);
  return {
    now: () => void run(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
