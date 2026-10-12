"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardSnapshot } from "@/lib/board";
import { SAFETY_INTERVAL_MS, startChecks, useBoardSignal } from "./board-signal";

type BoardOptions = {
  /** How often to check while nothing is pushing changes to this screen. */
  intervalMs?: number;
  /** Also listen on Supabase Realtime and fetch as soon as the board changes. */
  realtime?: boolean;
};

/**
 * Keeps a board snapshot current by polling the public board endpoint. Unchanged boards cost a
 * 304 against our own server (never Challonge). Pauses while the tab is hidden.
 * With `realtime`, a push triggers the fetch and polling drops to a slow safety check for as long
 * as the channel stays connected.
 */
export function useBoard(slug: string, initial: BoardSnapshot, { intervalMs = 2500, realtime = false }: BoardOptions = {}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [online, setOnline] = useState(true);
  const etag = useRef(`W/"v${initial.version}"`);
  const checkNow = useRef(() => {});
  const pushing = useBoardSignal(slug, realtime, () => checkNow.current());

  useEffect(() => {
    const checks = startChecks(
      async () => {
        try {
          const res = await fetch(`/api/public/${slug}/board`, { headers: { "If-None-Match": etag.current }, cache: "no-store" });
          if (res.status === 200) {
            etag.current = res.headers.get("etag") ?? etag.current;
            setSnapshot((await res.json()) as BoardSnapshot);
          }
          setOnline(res.status === 200 || res.status === 304);
        } catch {
          setOnline(false);
        }
      },
      pushing ? SAFETY_INTERVAL_MS : intervalMs,
    );
    checkNow.current = checks.now;
    return checks.stop;
  }, [slug, intervalMs, pushing]);

  return { snapshot, online };
}
