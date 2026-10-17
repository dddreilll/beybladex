"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { getOutbox } from "@/lib/offline/client";
import { needsAttention, type PadRecord } from "@/lib/offline/outbox";

const EMPTY: PadRecord[] = [];

function deviceStatus(record: PadRecord): { text: string; tone: string } {
  if (record.problem?.kind === "signed_out") return { text: "Sign in again", tone: "text-warning" };
  if (record.problem?.kind === "not_found") return { text: "Other account", tone: "text-warning" };
  if (record.problem?.kind === "needs_confirmation") return { text: "Needs confirmation", tone: "text-warning" };
  if (record.problem?.kind === "error") return { text: "Not sent", tone: "text-destructive" };
  if (record.submit) return { text: "Result on this device", tone: "text-warning" };
  return { text: `${record.queue.length} tap${record.queue.length === 1 ? "" : "s"} on this device`, tone: "text-warning" };
}

/**
 * Anything that so far only exists on this device: offline judge-pad work not yet saved.
 */
export function WaitingPanel() {
  const outbox = getOutbox();
  const device = useSyncExternalStore(outbox.subscribe, outbox.all, () => EMPTY).filter(needsAttention);

  return (
    <section aria-labelledby="waiting-heading" className="flex flex-col gap-3 rounded-2xl border bg-card p-5">
      <h2 id="waiting-heading" className="font-display text-lg font-semibold">
        Waiting to be saved
      </h2>
      {device.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing waiting. Every result is saved.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {device.map((record) => {
            const status = deviceStatus(record);
            return (
              <li key={record.matchId} className="flex flex-col gap-1 rounded-lg bg-secondary px-3 py-2.5">
                <span className="flex items-center justify-between gap-3">
                  <span>{record.label}</span>
                  <span className={`shrink-0 font-semibold ${status.tone}`}>{status.text}</span>
                </span>
                {record.problem?.kind === "error" && <span className="text-xs text-muted-foreground">{record.problem.message}</span>}
                {record.problem?.kind === "not_found" ? (
                  <button type="button" onClick={() => void outbox.discard(record.matchId)} className="self-start text-xs font-semibold underline underline-offset-4">
                    Discard
                  </button>
                ) : (
                  <Link href={`/tournaments/${record.tournamentId}/matches/${record.matchId}`} className="self-start text-xs font-semibold underline underline-offset-4">
                    Open pad
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Taps and results scored offline are saved in order once this device is back online.</p>
    </section>
  );
}
