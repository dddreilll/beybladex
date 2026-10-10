"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { CloudOff } from "lucide-react";
import { flushOutbox, getOutbox } from "@/lib/offline/client";
import { needsAttention, needsWork, type PadRecord } from "@/lib/offline/outbox";

const EMPTY: PadRecord[] = [];
const RETRY_MS = 5000;

function describe(record: PadRecord): string {
  if (record.problem?.kind === "signed_out") return "Sign in again to sync it.";
  if (record.problem?.kind === "not_found") return "It belongs to a different account than the one signed in.";
  if (record.problem?.kind === "needs_confirmation") return "The correction needs your confirmation.";
  if (record.problem?.kind === "error") return record.problem.message;
  if (record.submit) return "Result saved on this device; it will be sent when the connection is back.";
  return `${record.queue.length} battle${record.queue.length === 1 ? "" : "s"} saved on this device, waiting to sync.`;
}

/**
 * Mounted once per layout. Registers the service worker, keeps retrying unsent judge-pad work
 * from any match (not just the one on screen), and optionally lists what still needs attention.
 */
export function OutboxSync({ banner = false }: { banner?: boolean }) {
  const outbox = getOutbox();
  const records = useSyncExternalStore(outbox.subscribe, outbox.all, () => EMPTY);

  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  useEffect(() => {
    const flush = () => void flushOutbox();
    void outbox.init().then(flush);
    const timer = setInterval(() => outbox.hasWork() && flush(), RETRY_MS);
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [outbox]);

  const pending = records.filter(needsAttention);
  if (!banner || pending.length === 0) return null;

  return (
    <section
      aria-label="Results saved on this device"
      className="mx-auto mt-4 flex w-full max-w-6xl flex-col gap-3 rounded-xl border border-warning/50 bg-warning-muted p-4 text-sm"
    >
      <h2 className="flex items-center gap-2 font-display text-base font-semibold text-warning">
        <CloudOff className="size-4" aria-hidden />
        Saved on this device, not on the server yet ({pending.length})
      </h2>
      <ul className="flex flex-col gap-2">
        {pending.map((record) => (
          <li key={record.matchId} className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold">{record.label}</span>
            <span className="text-muted-foreground">{describe(record)}</span>
            {record.problem?.kind === "not_found" ? (
              <button type="button" onClick={() => void outbox.discard(record.matchId)} className="font-semibold underline underline-offset-4">
                Discard
              </button>
            ) : (
              <Link href={`/tournaments/${record.tournamentId}/matches/${record.matchId}`} className="font-semibold underline underline-offset-4">
                {needsWork(record) ? "Open judge pad" : "Review"}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Asks the service worker to pre-load these judge pads so they open without a connection. */
export function WarmPads({ urls }: { urls: string[] }) {
  const key = urls.join("|");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !key) return;
    void navigator.serviceWorker.ready.then((registration) =>
      registration.active?.postMessage({ type: "cache-pages", urls: key.split("|") }),
    );
  }, [key]);
  return null;
}
