"use client";

import { useCallback, useEffect, useState } from "react";
import { startChecks } from "@/components/board/board-signal";

type Stadium = { id: string; name: string; taken: boolean };
type Pending = { code: string; stadium: string; name: string };
type Phase = { kind: "choose" } | { kind: "asking" } | ({ kind: "waiting" } & Pending);
type PairResponse = { status?: "approved" | "pending" | "none"; code?: string; stadium?: string; name?: string; error?: string };

/**
 * What a tablet shows until the organizer lets it judge: say who you are, pick your stadium,
 * then a short code to match against the control room. Nothing about any match reaches the
 * tablet before that.
 */
export function JudgePairing({
  slug,
  tournament,
  stadiums,
  defaultName,
  initial,
  disconnected,
  left,
}: {
  slug: string;
  tournament: string;
  stadiums: Stadium[];
  /** What the tablet looks like to us ("Chrome on Android"): the name a judge starts with. */
  defaultName: string;
  /** A request this tablet already has waiting. */
  initial: Pending | null;
  disconnected: boolean;
  /** The stadium this device just left by its own choice. */
  left: string | null;
}) {
  const [phase, setPhase] = useState<Phase>(initial ? { kind: "waiting", ...initial } : { kind: "choose" });
  const [name, setName] = useState(initial?.name ?? defaultName);
  const [message, setMessage] = useState<string | null>(
    disconnected ? "The organizer disconnected this device. Pick your stadium to ask again." : left ? `You left ${left}. Pick a stadium to judge again.` : null,
  );
  const openHome = useCallback(() => window.location.replace(`/t/${slug}/judge`), [slug]);

  const ask = async (stadiumId: string) => {
    setPhase({ kind: "asking" });
    setMessage(null);
    try {
      const res = await fetch(`/api/public/${slug}/judge/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stadiumId, name }),
      });
      const body = (await res.json().catch(() => null)) as PairResponse | null;
      if (body?.status === "approved") return openHome();
      if (body?.status === "pending" && body.code && body.stadium) {
        // The server tidies the name (and falls back to the device name if it was blank).
        const saved = body.name ?? name;
        setName(saved);
        return setPhase({ kind: "waiting", code: body.code, stadium: body.stadium, name: saved });
      }
      setMessage(body?.error ?? "Couldn't reach the server.");
    } catch {
      setMessage("Couldn't reach the server. Check this device's connection.");
    }
    setPhase({ kind: "choose" });
  };

  const waiting = phase.kind === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const checks = startChecks(async () => {
      try {
        const res = await fetch(`/api/public/${slug}/judge/pair`, { cache: "no-store" });
        const body = (await res.json()) as PairResponse;
        if (body.status === "approved") openHome();
        else if (body.status === "none") {
          setMessage("The request was declined or ran out. Pick your stadium to ask again.");
          setPhase({ kind: "choose" });
          return "stop";
        }
      } catch {}
    }, 3000);
    return checks.stop;
  }, [waiting, slug, openHome]);

  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 p-6">
      <header>
        <p className="text-sm text-muted-foreground">{tournament}</p>
        <h1 className="font-display text-3xl font-bold">Judge sign-up</h1>
      </header>

      {message && (
        <p role="status" className="rounded-xl bg-warning-muted p-4 text-sm text-warning">
          {message}
        </p>
      )}

      {phase.kind === "waiting" && (
        <section className="flex flex-col items-center gap-4 text-center">
          <p className="text-lg text-muted-foreground">
            Waiting for the organizer to approve <strong className="text-foreground">{phase.name}</strong> for{" "}
            <strong className="text-foreground">{phase.stadium}</strong>
          </p>
          <p
            aria-label={`Pairing code ${phase.code.split("").join(" ")}`}
            className="rounded-3xl border-2 bg-card px-10 py-6 font-display text-7xl font-bold leading-none tracking-[0.18em] sm:text-8xl"
          >
            {phase.code}
          </p>
          <p className="max-w-[40ch] text-muted-foreground">
            In the control room, find this code under <span className="font-semibold text-foreground">Judges</span> and press Approve.
          </p>
          <button type="button" onClick={() => setPhase({ kind: "choose" })} className="min-h-11 text-sm text-muted-foreground underline underline-offset-4">
            Wrong name or stadium? Change it
          </button>
        </section>
      )}

      {phase.kind === "asking" && (
        <p role="status" className="text-lg text-muted-foreground">
          Asking for access…
        </p>
      )}

      {phase.kind === "choose" && (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor="judge-name" className="text-lg font-semibold">
              Your name
            </label>
            <input
              id="judge-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={30}
              autoComplete="off"
              aria-describedby="judge-name-help"
              className="h-12 rounded-xl border bg-card px-4 text-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p id="judge-name-help" className="text-sm text-muted-foreground">
              This is how the organizer sees you. You can change it later.
            </p>
          </div>

          <section aria-labelledby="pick-stadium" className="flex flex-col gap-3">
            <h2 id="pick-stadium" className="text-lg font-semibold">
              Which stadium are you judging?
            </h2>
            {stadiums.length === 0 && <p className="text-muted-foreground">No stadiums have been set up yet. Ask the organizer, then reload this page.</p>}
            <ul className="flex flex-col gap-2">
              {stadiums.map((stadium) => (
                <li key={stadium.id}>
                  <button
                    type="button"
                    onClick={() => void ask(stadium.id)}
                    className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border bg-card px-4 text-left text-lg font-semibold"
                  >
                    {stadium.name}
                    {/* Still selectable: the organizer may be about to swap a tablet that died. */}
                    {stadium.taken && <span className="text-sm font-normal text-muted-foreground">has a judge</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
