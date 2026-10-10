"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { PadBattle } from "@/lib/battles";
import { flushOutbox, getOutbox } from "@/lib/offline/client";

/** Connects a judge pad to the device's outbox: local-first state that survives reloads. */
export function usePadOutbox(
  matchId: string,
  tournamentId: string,
  label: string,
  battles: PadBattle[],
  renderedAt: number,
) {
  const outbox = getOutbox();

  useEffect(() => {
    void outbox.open(matchId, { tournamentId, label, battles, renderedAt }).then(() => flushOutbox());
  }, [outbox, matchId, tournamentId, label, battles, renderedAt]);

  const record = useSyncExternalStore(
    outbox.subscribe,
    () => outbox.snapshot(matchId),
    () => undefined,
  );
  const online = useSyncExternalStore(
    outbox.subscribe,
    () => outbox.online,
    () => true,
  );
  return { outbox, record, online };
}
