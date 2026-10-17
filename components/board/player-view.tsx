"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BattleSheet } from "@/components/battle-sheet";
import type { MatchSheet } from "@/lib/battle-sheet";
import { callLabel } from "@/lib/call-label";
import { ordinal } from "@/lib/format";
import type { PlayerSnapshot, PlayerStatus } from "@/lib/player-status";
import { signOut, useQrSignIn } from "./player-session";
import { PushToggle } from "./push-toggle";
import { usePlayerFeed } from "./use-board";

/** A signed-in player's own page: where they are in the queue, and where to go when called. */
type Props = {
  slug: string;
  initial: PlayerSnapshot;
  /** The player's finished matches with their battles, as of when the page was rendered. */
  initialMatches: MatchSheet[];
  vapidPublicKey: string | null;
};

export function PlayerView({ slug, initial, initialMatches, vapidPublicKey }: Props) {
  const router = useRouter();
  const { snapshot, online, denied } = usePlayerFeed(slug, initial);
  const matches = useOwnMatches(slug, snapshot.results, initial.results, initialMatches);
  // Scanning another player's slip on a phone that is already signed in switches to that player.
  const qr = useQrSignIn(slug);
  const [leaving, setLeaving] = useState(false);
  const { me, status } = snapshot;
  // Nobody is called again once the tournament is over, or once they are out after the group stage.
  const noMoreCalls = status.kind === "finished" || status.kind === "out";

  // Signed out from elsewhere (another device took over, or the organizer reset the passcode):
  // the server decides what this phone shows next.
  useEffect(() => {
    if (denied) router.refresh();
  }, [denied, router]);

  // Buzz when this player gets called (push covers the case where the page is closed).
  const lastCall = useRef<string | null>(null);
  const callKey = status.kind === "called" ? `called:${status.match.callNumber}` : status.kind;
  useEffect(() => {
    // A first call or a recall, but not the state the page happened to open in.
    if (callKey.startsWith("called") && lastCall.current && lastCall.current !== callKey) navigator.vibrate?.([300, 150, 300]);
    lastCall.current = callKey;
  }, [callKey]);

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-5 p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">BXQ Pass · {snapshot.tournament.name}</p>
          <h1 className="font-display text-3xl font-bold">Hi, {me.name}</h1>
        </div>
        <button
          type="button"
          disabled={leaving}
          onClick={async () => {
            setLeaving(true);
            // Also stops this phone's notifications for the player.
            await signOut(slug);
            router.refresh();
          }}
          className="min-h-11 text-sm text-muted-foreground underline underline-offset-4 disabled:opacity-60"
        >
          Not you?
        </button>
      </header>

      {qr.error && (
        <p role="alert" className="rounded-xl bg-destructive/15 p-4 text-sm text-destructive">
          {qr.error}
        </p>
      )}

      <StatusCard status={status} />
      {vapidPublicKey && !noMoreCalls && <PushToggle key={me.id} slug={slug} vapidPublicKey={vapidPublicKey} />}

      {!online && (
        <p role="status" className="text-sm text-warning">
          Reconnecting… your status will update when the connection is back.
        </p>
      )}
      {!noMoreCalls && (
        <p className="text-sm text-muted-foreground">This page updates by itself and vibrates when you&apos;re called.</p>
      )}

      {matches.length > 0 && (
        <section aria-labelledby="own-matches" className="flex flex-col gap-2">
          <h2 id="own-matches" className="font-display text-xl font-bold">
            Your matches
          </h2>
          <ul className="flex flex-col gap-2">
            {matches.map((sheet) => (
              <OwnMatch key={sheet.id} sheet={sheet} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/**
 * The player's finished matches. They are reloaded only when the feed says one of this player's
 * results changed (a new result, or a correction), not on every change to the board.
 */
function useOwnMatches(slug: string, results: string, initialResults: string, initialMatches: MatchSheet[]): MatchSheet[] {
  const [loaded, setLoaded] = useState<{ results: string; matches: MatchSheet[] }>({ results: initialResults, matches: initialMatches });
  const asked = useRef(initialResults);
  useEffect(() => {
    if (asked.current === results) return;
    asked.current = results;
    void fetch(`/api/public/${slug}/me/matches`, { cache: "no-store" })
      .then(async (res) => {
        if (res.ok) setLoaded({ results, matches: ((await res.json()) as { matches: MatchSheet[] }).matches });
        // Otherwise the next change asks again.
        else asked.current = "";
      })
      .catch(() => {
        asked.current = "";
      });
  }, [slug, results]);
  return loaded.matches;
}

/** One finished match: the result from this player's side, opening to its battle-by-battle score. */
function OwnMatch({ sheet }: { sheet: MatchSheet }) {
  const mine = sheet.mine ?? 1;
  const theirs = mine === 1 ? 2 : 1;
  const outcome = sheet.winner === mine ? "Won" : "Lost";
  const score = sheet.forfeit ? " by forfeit" : sheet.score ? ` ${sheet.score[mine]}–${sheet.score[theirs]}` : "";
  return (
    <li>
      <details className="rounded-xl border bg-card">
        <summary className="flex min-h-12 cursor-pointer flex-wrap items-baseline gap-x-2 px-4 py-3">
          <span className={sheet.winner === mine ? "font-bold text-success" : "font-bold"}>
            {outcome}
            {score}
          </span>
          <span className="font-semibold">vs {sheet.players[theirs]}</span>
          <span className="text-sm text-muted-foreground">{sheet.round}</span>
        </summary>
        <div className="border-t px-4 py-3">
          {/* In the sheet the scores read in bracket order, so say whose is whose. */}
          {sheet.recorded && (
            <p className="pb-2 text-xs text-muted-foreground">
              Scores read {sheet.players[1]}–{sheet.players[2]}.
            </p>
          )}
          <BattleSheet sheet={sheet} />
        </div>
      </details>
    </li>
  );
}

function StatusCard({ status }: { status: PlayerStatus }) {
  const shell = "flex flex-col gap-2 rounded-2xl p-5";
  switch (status.kind) {
    case "called":
      return (
        <section role="alert" className={`${shell} bg-primary text-primary-foreground`}>
          <span className="text-sm font-bold uppercase tracking-widest">{callLabel(status.match.callNumber) ?? "You're called"}</span>
          <span className="font-display text-4xl font-bold leading-none">{status.stadium}</span>
          <span className="text-lg font-semibold">vs {status.match.opponent}</span>
          <span>Go to {status.stadium} now.</span>
        </section>
      );
    case "playing":
      return (
        <section className={`${shell} bg-success-muted text-success`}>
          <span className="text-sm font-bold uppercase tracking-widest">Playing</span>
          <span className="font-display text-3xl font-bold">{status.stadium}</span>
          <span className="text-lg font-semibold">
            vs {status.match.opponent}
            {status.match.liveScore ? ` · ${status.match.liveScore}` : ""}
          </span>
        </section>
      );
    case "on_deck":
      return (
        <section className={`${shell} border-2 border-primary bg-card`}>
          <span className="text-sm font-bold uppercase tracking-widest text-primary">On deck</span>
          <span className="font-display text-3xl font-bold">{status.stadium}</span>
          <span className="text-lg font-semibold">vs {status.match.opponent}</span>
          <span className="text-muted-foreground">Head over: you play after the current match.</span>
        </section>
      );
    case "queued":
      return (
        <section className={`${shell} bg-card`}>
          <span className="text-sm font-bold uppercase tracking-widest text-muted-foreground">In the queue</span>
          <span className="text-lg font-semibold">vs {status.match.opponent}</span>
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
    case "finished":
      return (
        <section className={`${shell} border-2 border-primary bg-card`}>
          <span className="text-sm font-bold uppercase tracking-widest text-primary">Tournament finished</span>
          {status.rank ? (
            <>
              <span className="font-display text-5xl font-bold leading-none">{ordinal(status.rank)}</span>
              <span className="text-lg font-semibold">out of {status.of} players</span>
            </>
          ) : (
            <span className="text-lg font-semibold">Thanks for playing.</span>
          )}
        </section>
      );
    case "advanced":
      return (
        <section className={`${shell} border-2 border-primary bg-card`}>
          <span className="text-sm font-bold uppercase tracking-widest text-primary">Group stage finished</span>
          <span className="text-lg font-semibold">You&apos;re through to the final stage.</span>
          <span className="text-muted-foreground">Your next match appears here when it starts.</span>
        </section>
      );
    case "out":
      return (
        <section className={`${shell} bg-card`}>
          <span className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Group stage finished</span>
          <span className="text-lg font-semibold">You didn&apos;t advance to the final stage.</span>
          <span className="text-muted-foreground">Thanks for playing. Your placement appears here when the tournament is finished.</span>
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
