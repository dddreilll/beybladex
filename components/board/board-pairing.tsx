"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startChecks } from "./board-signal";

type Phase =
  | { kind: "asking" }
  | { kind: "waiting"; code: string }
  /** Not asking: the organizer disconnected or declined this screen, or the request ran out. */
  | { kind: "stopped"; message: string }
  | { kind: "error"; message: string };

type PairResponse = { status?: "approved" | "pending" | "none"; code?: string; error?: string };

/**
 * What a screen shows until the organizer lets it display the call board: a short code to match
 * against the control room. No board data reaches this screen before it is approved.
 */
export function BoardPairing({ slug, tournament, initialCode, disconnected }: { slug: string; tournament: string; initialCode: string | null; disconnected: boolean }) {
  const [phase, setPhase] = useState<Phase>(
    initialCode
      ? { kind: "waiting", code: initialCode }
      : disconnected
        ? { kind: "stopped", message: "The organizer disconnected this screen." }
        : { kind: "asking" },
  );
  const showBoard = useCallback(() => window.location.replace(`/t/${slug}/board`), [slug]);

  const ask = useCallback(async () => {
    setPhase({ kind: "asking" });
    try {
      const res = await fetch(`/api/public/${slug}/board/pair`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as PairResponse | null;
      if (body?.status === "approved") showBoard();
      else if (body?.status === "pending" && body.code) setPhase({ kind: "waiting", code: body.code });
      else setPhase({ kind: "error", message: body?.error ?? "Couldn't reach the server." });
    } catch {
      setPhase({ kind: "error", message: "Couldn't reach the server. Check this screen's connection." });
    }
  }, [slug, showBoard]);

  // A screen opening the board for the first time asks by itself; once is enough.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || initialCode || disconnected) return;
    asked.current = true;
    void ask();
  }, [ask, initialCode, disconnected]);

  const waiting = phase.kind === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const checks = startChecks(async () => {
      try {
        const res = await fetch(`/api/public/${slug}/board/pair`, { cache: "no-store" });
        const body = (await res.json()) as PairResponse;
        if (body.status === "approved") showBoard();
        else if (body.status === "none") {
          setPhase({ kind: "stopped", message: "The request was declined or ran out." });
          return "stop";
        }
      } catch {}
    }, 3000);
    return checks.stop;
  }, [waiting, slug, showBoard]);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-[3vh] bg-[#07090D] p-[5vw] text-center text-foreground">
      <p className="text-[clamp(1rem,1.6vw,2rem)] text-muted-foreground">{tournament}</p>
      <h1 className="font-display text-[clamp(1.75rem,3.2vw,4rem)] font-bold">BXQ Board</h1>

      {phase.kind === "waiting" && (
        <>
          <p className="text-[clamp(1rem,1.5vw,1.9rem)] text-muted-foreground">Waiting for the organizer to approve this screen</p>
          <p
            aria-label={`Pairing code ${phase.code.split("").join(" ")}`}
            className="rounded-3xl border-2 border-[#232A35] bg-[#11151B] px-[5vw] py-[3vh] font-display text-[clamp(4rem,12vw,14rem)] font-bold leading-none tracking-[0.18em] tabular-nums"
          >
            {phase.code}
          </p>
          <p className="max-w-[44ch] text-[clamp(1rem,1.4vw,1.75rem)] text-muted-foreground">
            In BXQ Desk, find this code under <span className="font-semibold text-foreground">BXQ Boards</span> and press Approve.
          </p>
        </>
      )}
      {phase.kind === "asking" && <p className="text-[clamp(1rem,1.5vw,1.9rem)] text-muted-foreground">Asking for access…</p>}
      {(phase.kind === "stopped" || phase.kind === "error") && (
        <>
          <p role={phase.kind === "error" ? "alert" : "status"} className="text-[clamp(1.1rem,1.6vw,2rem)]">
            {phase.message}
          </p>
          <button type="button" onClick={() => void ask()} className="min-h-12 rounded-xl bg-primary px-6 text-lg font-bold text-primary-foreground">
            {phase.kind === "error" ? "Try again" : "Ask to show the board"}
          </button>
        </>
      )}
    </main>
  );
}
