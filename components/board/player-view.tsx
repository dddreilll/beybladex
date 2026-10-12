"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Search } from "lucide-react";
import type { BoardMatch, BoardSnapshot } from "@/lib/board";
import { callLabel } from "@/lib/call-label";
import { PushToggle, unlinkPush } from "./push-toggle";
import { useBoard } from "./use-board";

type Status =
  | { kind: "called"; stadium: string; match: BoardMatch }
  | { kind: "playing"; stadium: string; match: BoardMatch }
  | { kind: "on_deck"; stadium: string; match: BoardMatch }
  | { kind: "queued"; position: number; match: BoardMatch }
  | { kind: "waiting"; match: BoardMatch }
  | { kind: "idle" };

const involves = (m: BoardMatch | null, id: string) => Boolean(m && (m.player1?.id === id || m.player2?.id === id));
const opponent = (m: BoardMatch, id: string) => (m.player1?.id === id ? m.player2?.name : m.player1?.name) ?? "TBD";

function statusFor(snapshot: BoardSnapshot, id: string): Status {
  for (const s of snapshot.stadiums) {
    if (involves(s.now, id)) return { kind: s.now!.status === "playing" ? "playing" : "called", stadium: s.name, match: s.now! };
  }
  for (const s of snapshot.stadiums) if (involves(s.next, id)) return { kind: "on_deck", stadium: s.name, match: s.next! };
  const queued = snapshot.queue.findIndex((m) => involves(m, id));
  if (queued >= 0) return { kind: "queued", position: queued + 1, match: snapshot.queue[queued] };
  const waiting = snapshot.waiting.find((m) => involves(m, id));
  if (waiting) return { kind: "waiting", match: waiting };
  return { kind: "idle" };
}

// The chosen player is remembered per tournament on this phone.
const storageKey = (slug: string) => `player:${slug}`;
const listeners = new Set<() => void>();
function readPlayer(slug: string): string | null {
  try {
    return localStorage.getItem(storageKey(slug));
  } catch {
    return null;
  }
}
function writePlayer(slug: string, id: string | null) {
  try {
    if (id) localStorage.setItem(storageKey(slug), id);
    else localStorage.removeItem(storageKey(slug));
  } catch {}
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function PlayerView({ slug, initial, vapidPublicKey }: { slug: string; initial: BoardSnapshot; vapidPublicKey: string | null }) {
  const { snapshot, online } = useBoard(slug, initial, { intervalMs: 10_000 });
  const playerId = useSyncExternalStore(subscribe, () => readPlayer(slug), () => null);
  const [query, setQuery] = useState("");
  const me = snapshot.players.find((p) => p.id === playerId) ?? null;
  const status = useMemo(() => (me ? statusFor(snapshot, me.id) : null), [snapshot, me]);

  // Buzz when this player gets called (until web push arrives, the page has to be open).
  const lastCall = useRef<string | null>(null);
  const callKey = status?.kind === "called" ? `called:${status.match.callNumber}` : (status?.kind ?? null);
  useEffect(() => {
    // A first call or a recall, but not the state the page happened to open in.
    if (callKey?.startsWith("called") && lastCall.current && lastCall.current !== callKey) navigator.vibrate?.([300, 150, 300]);
    lastCall.current = callKey;
  }, [callKey]);

  if (!me) {
    const matches = snapshot.players.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col gap-5 p-5">
        <header>
          <p className="text-sm text-muted-foreground">{snapshot.tournament.name}</p>
          <h1 className="font-display text-3xl font-bold">Who are you?</h1>
        </header>
        <label className="flex items-center gap-2 rounded-xl border bg-card px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <span className="sr-only">Search your name</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your name"
            className="h-12 flex-1 bg-transparent outline-none"
          />
        </label>
        <ul className="flex flex-col gap-2">
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => writePlayer(slug, p.id)}
                className="w-full rounded-xl border bg-card px-4 py-3 text-left text-lg font-semibold"
              >
                {p.name}
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="text-muted-foreground">No player matches “{query}”.</li>}
        </ul>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-5 p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{snapshot.tournament.name}</p>
          <h1 className="font-display text-3xl font-bold">Hi, {me.name}</h1>
        </div>
        <button
          type="button"
          onClick={() => {
            // Stop this phone's notifications for the previous player before switching.
            void unlinkPush(slug);
            writePlayer(slug, null);
          }}
          className="min-h-11 text-sm text-muted-foreground underline underline-offset-4"
        >
          Not you?
        </button>
      </header>

      <StatusCard status={status!} playerId={me.id} />
      {vapidPublicKey && <PushToggle slug={slug} playerId={me.id} vapidPublicKey={vapidPublicKey} />}

      {!online && (
        <p role="status" className="text-sm text-warning">
          Reconnecting… your status will update when the connection is back.
        </p>
      )}
      <p className="text-sm text-muted-foreground">This page also updates by itself and vibrates when you&apos;re called.</p>
      <a href={`/t/${slug}/board`} className="min-h-11 text-center font-semibold underline underline-offset-4">
        See the full call board
      </a>
    </main>
  );
}

function StatusCard({ status, playerId }: { status: Status; playerId: string }) {
  const shell = "flex flex-col gap-2 rounded-2xl p-5";
  switch (status.kind) {
    case "called":
      return (
        <section role="alert" className={`${shell} bg-primary text-primary-foreground`}>
          <span className="text-sm font-bold uppercase tracking-widest">{callLabel(status.match.callNumber) ?? "You're called"}</span>
          <span className="font-display text-4xl font-bold leading-none">{status.stadium}</span>
          <span className="text-lg font-semibold">vs {opponent(status.match, playerId)}</span>
          <span>Go to {status.stadium} now.</span>
        </section>
      );
    case "playing":
      return (
        <section className={`${shell} bg-success-muted text-success`}>
          <span className="text-sm font-bold uppercase tracking-widest">Playing</span>
          <span className="font-display text-3xl font-bold">{status.stadium}</span>
          <span className="text-lg font-semibold">
            vs {opponent(status.match, playerId)}
            {status.match.liveScore ? ` · ${status.match.liveScore}` : ""}
          </span>
        </section>
      );
    case "on_deck":
      return (
        <section className={`${shell} border-2 border-primary bg-card`}>
          <span className="text-sm font-bold uppercase tracking-widest text-primary">On deck</span>
          <span className="font-display text-3xl font-bold">{status.stadium}</span>
          <span className="text-lg font-semibold">vs {opponent(status.match, playerId)}</span>
          <span className="text-muted-foreground">Head over: you play after the current match.</span>
        </section>
      );
    case "queued":
      return (
        <section className={`${shell} bg-card`}>
          <span className="text-sm font-bold uppercase tracking-widest text-muted-foreground">In the queue</span>
          <span className="text-lg font-semibold">vs {opponent(status.match, playerId)}</span>
          <span className="text-muted-foreground">
            {status.position === 1 ? "Next up for a free stadium." : `${status.position - 1} matches ahead of you.`}
          </span>
        </section>
      );
    case "waiting":
      return (
        <section className={`${shell} bg-card`}>
          <span className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Waiting</span>
          <span className="text-lg font-semibold">{status.match.label}</span>
          <span className="text-muted-foreground">Your next opponent is still playing.</span>
        </section>
      );
    default:
      return (
        <section className={`${shell} bg-card`}>
          <span className="text-lg font-semibold">No match for you right now.</span>
          <span className="text-muted-foreground">If you&apos;re still in, your next match appears here when it&apos;s ready.</span>
        </section>
      );
  }
}
