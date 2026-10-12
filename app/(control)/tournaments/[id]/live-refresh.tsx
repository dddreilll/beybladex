"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { SAFETY_INTERVAL_MS, startChecks, useBoardSignal } from "@/components/board/board-signal";

/**
 * Re-renders the control room when judges, results or the queue change it from other devices.
 * A Realtime push triggers the check; without one it polls every few seconds.
 */
export function LiveRefresh({ tournamentId, slug, version }: { tournamentId: string; slug: string; version: number }) {
  const router = useRouter();
  const checkNow = useRef(() => {});
  const pushing = useBoardSignal(slug, true, () => checkNow.current());

  useEffect(() => {
    const checks = startChecks(
      async () => {
        try {
          const res = await fetch(`/api/tournaments/${tournamentId}/version`, { headers: { "If-None-Match": `W/"v${version}"` }, cache: "no-store" });
          if (res.status === 200) {
            router.refresh();
            return "stop"; // the refreshed page mounts a new poller with the new version
          }
        } catch {}
      },
      pushing ? SAFETY_INTERVAL_MS : 4000,
    );
    checkNow.current = checks.now;
    return checks.stop;
  }, [tournamentId, version, router, pushing]);
  return null;
}
