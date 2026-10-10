"use client";

import { useEffect, useState } from "react";
import type { BoardSnapshot } from "@/lib/board";

/**
 * Polls the public board endpoint. Unchanged boards cost a 304 against our own server
 * (never Challonge). Pauses while the tab is hidden.
 */
export function useBoard(slug: string, initial: BoardSnapshot, intervalMs = 2500) {
  const [snapshot, setSnapshot] = useState(initial);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let etag = `W/"v${initial.version}"`;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/public/${slug}/board`, { headers: { "If-None-Match": etag }, cache: "no-store" });
          if (res.status === 200) {
            etag = res.headers.get("etag") ?? etag;
            setSnapshot((await res.json()) as BoardSnapshot);
          }
          setOnline(res.status === 200 || res.status === 304);
        } catch {
          setOnline(false);
        }
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [slug, initial.version, intervalMs]);

  return { snapshot, online };
}
