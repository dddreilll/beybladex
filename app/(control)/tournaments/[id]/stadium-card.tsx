"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { BellRing, MoreVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  backToQueueAction,
  callOnDeckAction,
  cancelMatchAction,
  holdMatchAction,
  recallAction,
  removeStadiumAction,
  renameStadiumAction,
  startMatchAction,
  type VenueState,
} from "./venue-actions";

export type CardMatch = {
  id: string;
  label: string;
  roundLabel: string;
  players: string;
  padHref: string;
};

export type CurrentMatch = CardMatch & {
  status: "called" | "playing";
  /** "Second call" etc. after a recall; null on the first call. */
  repeatLabel: string | null;
  calledAgo: string | null;
  /** When it was (last) called, and how long until it may be recalled, as of when the page was rendered. */
  calledAt: string | null;
  recallReadyInMs: number;
  liveScore: string | null;
  /** The most recent battle, e.g. "Alex · Xtreme +3". */
  lastBattle: string | null;
  battles: number;
};

type Props = {
  tournamentId: string;
  stadium: { id: string; name: string };
  now: CurrentMatch | null;
  next: CardMatch | null;
  autoCall: boolean;
  autoOnDeck: boolean;
};

const sectionLabel = "text-xs font-bold uppercase tracking-widest text-muted-foreground";

/** "M14 · I · Winners R2 · called just now", leaving out any part that is missing. */
const details = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");

/**
 * Seconds left of the recall cooldown, ticking in real time. The server says how long was left
 * when it rendered the page; from there we count with the browser's own clock, so a wrong
 * device clock can't shorten the wait. (The server enforces the cooldown regardless.)
 */
function useRecallCooldown(readyInMs: number, callKey: string): number {
  const signature = `${callKey}:${readyInMs}`;
  const [progress, setProgress] = useState({ signature, elapsed: 0 });
  useEffect(() => {
    if (readyInMs <= 0) return;
    const started = performance.now();
    const timer = setInterval(() => {
      const elapsed = performance.now() - started;
      setProgress({ signature, elapsed });
      if (elapsed >= readyInMs) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [readyInMs, signature]);
  // A new call (or fresher numbers from the server) restarts the count immediately.
  const elapsed = progress.signature === signature ? progress.elapsed : 0;
  return Math.max(0, Math.ceil((readyInMs - elapsed) / 1000));
}

type Feedback = VenueState & { about?: "match" | "card" };

export function StadiumCard({ tournamentId, stadium, now, next, autoCall, autoOnDeck }: Props) {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>({});
  const recallIn = useRecallCooldown(now?.status === "called" ? now.recallReadyInMs : 0, now?.calledAt ?? "");
  const [renaming, setRenaming] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // Feedback is transient: a stale "wait 13s" shouldn't sit on the card for the rest of the event.
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clearTimer.current), []);
  // Messages about the current match show under its buttons; everything else at the foot of the card.
  const run = (action: () => Promise<VenueState>, about: "match" | "card" = "card") => {
    setFeedback({ about });
    startTransition(async () => {
      setFeedback({ ...(await action()), about });
      clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setFeedback({}), 8000);
    });
  };
  const message = (about: "match" | "card") =>
    feedback.about !== about ? "" : pending ? "Working…" : (feedback.error ?? feedback.message ?? "");

  const chip = now?.status === "playing" ? "playing" : now ? "called" : "free";

  return (
    <li className="flex flex-col gap-4 rounded-2xl border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 gap-2"
            action={(form) => {
              setRenaming(false);
              run(() => renameStadiumAction(tournamentId, stadium.id, String(form.get("name") ?? "")));
            }}
          >
            <label htmlFor={`name-${stadium.id}`} className="sr-only">
              Stadium name
            </label>
            <input
              id={`name-${stadium.id}`}
              name="name"
              defaultValue={stadium.name}
              maxLength={40}
              autoFocus
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
            />
            <button type="submit" className="rounded-md bg-secondary px-3 text-sm font-semibold">
              Save
            </button>
          </form>
        ) : (
          <h3 className="min-w-0 truncate font-display text-xl font-bold">{stadium.name}</h3>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[0.7rem] font-bold uppercase tracking-wider",
              chip === "playing" && "bg-success-muted text-success",
              chip === "called" && "bg-primary text-primary-foreground",
              chip === "free" && "bg-muted text-muted-foreground",
            )}
          >
            {chip}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${stadium.name} actions`}
              className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <MoreVertical className="size-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {now && (
                <>
                  <DropdownMenuLabel>Current match</DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href={now.padHref}>Open judge pad</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => run(() => holdMatchAction(tournamentId, now.id), "match")}>
                    Hold match (keeps battles)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setConfirmingCancel(true)}>Cancel match…</DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel>Stadium</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(() => removeStadiumAction(tournamentId, stadium.id))}>
                Remove (matches go back to the queue)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={sectionLabel}>Now</span>
        {now ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-lg font-semibold leading-tight">{now.players}</span>
              {now.liveScore && (
                <span className="font-display text-lg font-bold tabular-nums" aria-label={`Score ${now.liveScore}`}>
                  {now.liveScore}
                </span>
              )}
            </div>
            {now.lastBattle && (
              <span className="text-xs text-muted-foreground">
                Latest battle: <span className="font-semibold text-foreground">{now.lastBattle}</span>
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {details(now.label, now.roundLabel, now.status === "called" && now.calledAgo ? `${now.repeatLabel ?? "called"} ${now.calledAgo}` : null)}
            </span>
            {now.status === "called" && (
              // Start is the usual next step, so it is the wider, filled button; Recall is the exception.
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => startMatchAction(tournamentId, now.id), "match")}
                  className="min-h-11 flex-[2] rounded-xl bg-primary px-3 font-bold text-primary-foreground disabled:opacity-60"
                >
                  Start match
                </button>
                <button
                  type="button"
                  disabled={pending || recallIn > 0}
                  aria-label="Recall players"
                  onClick={() => run(() => recallAction(tournamentId, now.id), "match")}
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border-2 border-primary px-3 font-bold text-primary disabled:opacity-60"
                >
                  <BellRing className="size-4 shrink-0" aria-hidden />
                  Recall
                </button>
              </div>
            )}
            {now.status === "called" && recallIn > 0 && (
              // role="timer" keeps screen readers from announcing every second.
              <p role="timer" className="text-sm text-muted-foreground mt-2">
                Just called. Next recall available in <span className="font-semibold tabular-nums text-foreground">{recallIn}s</span>
              </p>
            )}
          </>
        ) : (
          <span className="text-lg text-muted-foreground">—</span>
        )}
        <p aria-live="polite" className={cn("text-sm empty:hidden", feedback.error ? "text-destructive" : "text-muted-foreground")}>
          {message("match")}
        </p>
      </div>

      <div className="h-px bg-border" />

      <div className="flex flex-col gap-1.5">
        <span className={sectionLabel}>On deck</span>
        {next ? (
          <>
            <span className="font-semibold leading-tight">{next.players}</span>
            <span className="text-xs text-muted-foreground">{details(next.label, next.roundLabel)}</span>
            {now ? (
              <p className="text-sm text-muted-foreground">
                {autoCall ? "Called automatically when this stadium is free." : "You can call them once this stadium is free."}
              </p>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => callOnDeckAction(tournamentId, stadium.id))}
                className="mt-1 min-h-12 rounded-xl bg-primary font-bold text-primary-foreground disabled:opacity-60"
              >
                Call players
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => backToQueueAction(tournamentId, next.id))}
              className="mt-1 min-h-11 rounded-xl border px-3 text-sm font-semibold disabled:opacity-60"
            >
              Send back to queue
            </button>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">
            {autoOnDeck ? "Nothing ready to put on deck." : "Empty. Place a match here from the queue."}
          </span>
        )}
      </div>

      <p aria-live="polite" className={cn("text-sm empty:hidden", feedback.error ? "text-destructive" : "text-muted-foreground")}>
        {message("card")}
      </p>

      {confirmingCancel && now && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby={`cancel-${now.id}`} className="flex w-full max-w-md flex-col gap-4 rounded-2xl border bg-card p-6">
            <h4 id={`cancel-${now.id}`} className="font-display text-2xl font-bold">
              Cancel this match?
            </h4>
            <p className="text-muted-foreground">
              <strong className="text-foreground">{now.players}</strong>
              {now.battles > 0
                ? ` · ${now.battles} recorded battle${now.battles === 1 ? "" : "s"} will be voided (they stay in the log). `
                : ". "}
              The match goes on hold at 0–0 until you release it from the queue.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => setConfirmingCancel(false)} className="min-h-12 flex-1 rounded-xl border bg-secondary font-semibold">
                Keep the match
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingCancel(false);
                  run(() => cancelMatchAction(tournamentId, now.id), "match");
                }}
                className="min-h-12 flex-1 rounded-xl bg-destructive font-bold text-destructive-foreground"
              >
                Cancel match
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
