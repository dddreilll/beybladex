"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardSnapshot } from "@/lib/board";
import type { JudgeSnapshot } from "@/lib/judges";
import type { PlayerSnapshot } from "@/lib/player-status";
import { SAFETY_INTERVAL_MS, startChecks, useBoardSignal, useCloseSignal } from "./board-signal";

type FeedOptions = {
  /** How often to check while nothing is pushing changes to this screen. */
  intervalMs?: number;
  /** Also listen on Supabase Realtime and fetch as soon as the board changes. */
  realtime?: boolean;
};

/** Why the server stopped answering this screen: "replaced" = the player signed in elsewhere. */
export type Denied = "replaced" | "none";

/**
 * Keeps a snapshot current by polling one of our own endpoints. Unchanged data costs a 304
 * (never a Challonge request). Pauses while the tab is hidden.
 * With `realtime`, a push triggers the fetch and polling drops to a slow safety check for as long
 * as the channel stays connected.
 * A 401 means this screen is no longer allowed to see the data (disconnected by the organizer,
 * or signed out): polling stops and `denied` says why.
 * As the tab closes, the screen says so at `<url>/bye`, and the control room shows it closed.
 */
function useFeed<T extends { version: number }>(url: string, slug: string, initial: T, { intervalMs = 2500, realtime = false }: FeedOptions) {
  const [snapshot, setSnapshot] = useState(initial);
  const [online, setOnline] = useState(true);
  const [denied, setDenied] = useState<Denied | null>(null);
  const etag = useRef(`W/"v${initial.version}"`);
  const checkNow = useRef(() => {});
  const pushing = useBoardSignal(slug, realtime, () => checkNow.current());
  useCloseSignal(denied ? null : `${url}/bye`, () => checkNow.current());

  useEffect(() => {
    const checks = startChecks(
      async () => {
        try {
          const res = await fetch(url, { headers: { "If-None-Match": etag.current }, cache: "no-store" });
          if (res.status === 401) {
            const body = (await res.json().catch(() => null)) as { reason?: string } | null;
            setDenied(body?.reason === "replaced" ? "replaced" : "none");
            return "stop";
          }
          if (res.status === 200) {
            etag.current = res.headers.get("etag") ?? etag.current;
            setSnapshot((await res.json()) as T);
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
  }, [url, intervalMs, pushing]);

  return { snapshot, online, denied };
}

/** The whole board, for a call board screen the organizer approved. */
export function useBoard(slug: string, initial: BoardSnapshot, options: FeedOptions = {}) {
  return useFeed(`/api/public/${slug}/board`, slug, initial, options);
}

/** A judge tablet's own stadium. There is one tablet per stadium, so Realtime is affordable here. */
export function useJudgeFeed(slug: string, initial: JudgeSnapshot) {
  return useFeed(`/api/public/${slug}/judge`, slug, initial, { intervalMs: 3000, realtime: true });
}

/** One player's own match. Phones stay on polling to keep within the Realtime connection cap. */
export function usePlayerFeed(slug: string, initial: PlayerSnapshot) {
  return useFeed(`/api/public/${slug}/me`, slug, initial, { intervalMs: 10_000 });
}
