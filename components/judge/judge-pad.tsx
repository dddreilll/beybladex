"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  ArrowUpFromLine,
  Check,
  ChevronLeft,
  CircleSlash,
  CloudOff,
  Equal,
  LoaderCircle,
  Play,
  RotateCw,
  Sparkles,
  TriangleAlert,
  Undo2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCloseSignal } from "@/components/board/board-signal";
import { usePadOutbox } from "@/components/offline/use-pad-outbox";
import type { PadBattle } from "@/lib/battles";
import { uuid } from "@/lib/offline/client";
import { applyQueue } from "@/lib/offline/outbox";
import { scoreMatch, scoreSets, type BattleKind, type MatchScore, type Side } from "@/lib/scoring/engine";
import type { MatchRules } from "@/lib/scoring/profile";
import { cn } from "@/lib/utils";

type Props = {
  /** Who is holding the pad: the organizer (any match, corrections) or a stadium's judge tablet. */
  mode: "organizer" | "judge";
  tournamentId: string;
  matchId: string;
  backHref: string;
  /** Where the back link leads, e.g. "BXQ Desk" or "Stadium 2". */
  backLabel: string;
  /** Where to go once the result is on Challonge, if not the same place. */
  doneHref?: string;
  /** False for a match that was called and still has to be started; scoring is locked until then. */
  started: boolean;
  /** Why this match can't be started right now (its stadium has no judge), if so. */
  startBlocked?: string | null;
  title: string;
  players: { 1: string; 2: string };
  rules: MatchRules;
  initialBattles: PadBattle[];
  /** Server time this page was rendered: a page restored from the offline cache can be stale. */
  renderedAt: number;
  /** Where a judge tablet says its tab is closing, so the control room shows it closed; the organizer's pad has none. */
  closeSignalUrl?: string;
  challonge: {
    complete: boolean;
    scores: string | null;
    winnerSide: Side | null;
    lastSync: { status: string; lastError: string | null } | null;
  };
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "queued" } // offline: will be sent when the connection is back
  | { kind: "confirm"; affected: string[] }
  | { kind: "error"; message: string }
  | { kind: "done"; warning?: string };

const PLAYER_COLOR: Record<Side, string> = { 1: "#2DD4BF", 2: "#F472B6" };

const FINISH_STYLE: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  spin: { label: "Spin", color: "#8EB1FF", icon: RotateCw },
  over: { label: "Over", color: "#FBC54A", icon: ArrowUpFromLine },
  burst: { label: "Burst", color: "#FF8A8A", icon: Sparkles },
  xtreme: { label: "Xtreme", color: "#C9B6FF", icon: Zap },
  own: { label: "Own finish", color: "#C4CBD6", icon: CircleSlash },
};

export function JudgePad({
  mode,
  tournamentId,
  matchId,
  backHref,
  backLabel,
  doneHref = backHref,
  started: startedOnServer,
  startBlocked = null,
  title,
  players,
  rules,
  initialBattles,
  renderedAt,
  challonge,
  closeSignalUrl,
}: Props) {
  const router = useRouter();
  useCloseSignal(closeSignalUrl ?? null);
  // All battle state lives in the device's outbox (IndexedDB): taps apply instantly, survive
  // reloads and lost connections, and sync in the background.
  const { outbox, record, online } = usePadOutbox(
    matchId,
    tournamentId,
    `${title}: ${players[1]} vs ${players[2]}`,
    initialBattles,
    renderedAt,
    startedOnServer,
  );
  // Pressing Start unlocks scoring at once, also offline; the outbox remembers it across reloads.
  const started = record?.started ?? startedOnServer;
  const [swapped, setSwapped] = useState(false);
  const [dialogClosed, setDialogClosed] = useState(false);

  const battles = useMemo(() => (record ? applyQueue(record.acked, record.queue) : initialBattles), [record, initialBattles]);
  const score: MatchScore = useMemo(() => {
    try {
      return scoreMatch(rules, battles);
    } catch {
      return scoreMatch(rules, []);
    }
  }, [rules, battles]);

  const pending = record?.queue.length ?? 0;
  const unsaved = pending > 0;
  const dirty = record?.touched ?? false;
  const notice = record?.notice ?? null;
  const problem = record?.problem ?? null;

  const submit: SubmitState = record?.result
    ? { kind: "done", warning: record.result.warning }
    : problem?.kind === "needs_confirmation"
      ? { kind: "confirm", affected: problem.affected }
      : problem?.kind === "error"
        ? { kind: "error", message: problem.message }
        : problem?.kind === "signed_out"
          ? {
              kind: "error",
              message:
                mode === "judge"
                  ? "This device is no longer approved to judge. Ask the organizer to approve it again; everything here is kept and will sync."
                  : "You have been signed out. Sign in again in another tab; everything here is kept and will sync.",
            }
          : problem?.kind === "not_found"
            ? {
                kind: "error",
                message: mode === "judge" ? "This match is no longer at your stadium. Ask the organizer." : "This match belongs to a different account than the one signed in.",
              }
            : record?.submit
              ? online
                ? { kind: "sending" }
                : { kind: "queued" }
              : { kind: "idle" };

  // Once the result is on Challonge, refresh the server-rendered parts (status banner, links).
  const synced = Boolean(record?.result);
  useEffect(() => {
    if (synced) router.refresh();
  }, [synced, router]);

  // Keep the tablet awake while scoring.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        lock = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {}
    };
    const onVisible = () => document.visibilityState === "visible" && void request();
    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, []);

  const start = () => {
    navigator.vibrate?.(12);
    void outbox.start(matchId, uuid());
  };

  const add = (kind: BattleKind, side: Side | null) => {
    if (score.complete || !started) return;
    navigator.vibrate?.(12);
    setDialogClosed(false);
    void outbox.enqueue(matchId, { op: "add", opId: uuid(), kind, side });
  };

  const undo = () => {
    if (battles.length === 0) return;
    navigator.vibrate?.(12);
    setDialogClosed(false);
    void outbox.undoLast(matchId, uuid());
  };

  const send = (confirmDestructive: boolean) => void outbox.requestSubmit(matchId, confirmDestructive);

  const order: Side[] = swapped ? [2, 1] : [1, 2];
  const current = score.sets[score.currentSet];
  const winnerName = score.winner ? players[score.winner] : null;
  const multiSet = rules.bestOfSets > 1;
  const sets = scoreSets(rules, score);
  const finalLine = score.winner
    ? multiSet
      ? `${score.setsWon[score.winner]}–${score.setsWon[score.winner === 1 ? 2 : 1]} in sets`
      : `${current[score.winner]}–${current[score.winner === 1 ? 2 : 1]}`
    : "";
  // A match already reported (on Challonge, or by this device) only re-opens the dialog after an edit.
  const reported = challonge.complete || Boolean(record?.syncedAt);
  const showDialog = score.complete && (dirty || !reported) && !dialogClosed;

  const finishKinds: ("spin" | "over" | "burst" | "xtreme" | "own")[] = [
    "spin",
    "over",
    "burst",
    "xtreme",
    ...(rules.ownFinishPoints != null ? (["own"] as const) : []),
  ];
  const pointsFor = (kind: (typeof finishKinds)[number]) => (kind === "own" ? (rules.ownFinishPoints ?? 0) : rules.points[kind]);

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b bg-card px-4 py-3">
        <Link href={backHref} className="inline-flex min-h-11 items-center gap-1 font-semibold text-primary">
          <ChevronLeft className="size-5" aria-hidden />
          {backLabel}
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate font-display text-xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {rules.profileName} · first to {rules.targetPoints}
            {multiSet ? ` · best of ${rules.bestOfSets} sets` : ""}
          </p>
        </div>
        <SaveStatus online={online} pending={pending} resultQueued={submit.kind === "queued"} />
        <button
          type="button"
          onClick={() => setSwapped((s) => !s)}
          className="inline-flex min-h-12 items-center gap-2 rounded-xl border bg-secondary px-4 font-semibold"
        >
          <ArrowLeftRight className="size-5" aria-hidden />
          Swap sides
        </button>
      </header>

      {challonge.complete && !dirty && submit.kind === "idle" && (
        <p role="status" className="border-b bg-secondary px-4 py-2 text-sm">
          Challonge has this match as{" "}
          <strong>
            {challonge.winnerSide ? players[challonge.winnerSide] : "?"} winning {challonge.scores}
          </strong>
          . Undo or add battles, then submit, to correct it.
        </p>
      )}
      {challonge.lastSync && ["failed", "conflict"].includes(challonge.lastSync.status) && !dirty && submit.kind === "idle" && (
        <p role="alert" className="border-b bg-warning-muted px-4 py-2 text-sm text-warning">
          The last send to Challonge didn&apos;t go through: {challonge.lastSync.lastError}
        </p>
      )}
      {notice && (
        <p role="alert" className="border-b bg-warning-muted px-4 py-2 text-sm text-warning">
          {notice}
        </p>
      )}

      {!started && !score.complete && (
        <section aria-label="Start the match" className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b bg-card px-4 py-4">
          <div className="flex min-w-[14rem] flex-1 flex-col">
            <span className="font-display text-xl font-bold">Both players at the stadium?</span>
            <span className={cn("text-sm", startBlocked ? "text-warning" : "text-muted-foreground")}>
              {startBlocked ?? "Scoring unlocks when you start the match."}
            </span>
          </div>
          <button
            type="button"
            disabled={Boolean(startBlocked)}
            onClick={start}
            className="inline-flex min-h-16 flex-1 items-center justify-center gap-3 rounded-2xl bg-primary px-8 font-display text-2xl font-bold text-primary-foreground disabled:opacity-50 sm:flex-none"
          >
            <Play className="size-6" aria-hidden />
            Start match
          </button>
        </section>
      )}

      <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_17rem_minmax(0,1fr)]">
        {order.map((side, position) => (
          <section
            key={side}
            aria-label={`${players[side]}, ${position === 0 ? "left" : "right"} side`}
            className={cn("flex flex-col gap-4 rounded-2xl border bg-card p-4 sm:p-5", position === 1 && "lg:order-last")}
            style={{ boxShadow: `inset 0 4px 0 ${PLAYER_COLOR[side]}` }}
          >
            <div className="flex items-center gap-3">
              <span
                className="rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider text-[#0B0E13]"
                style={{ background: PLAYER_COLOR[side] }}
              >
                {position === 0 ? "Left side" : "Right side"}
              </span>
              {multiSet && (
                <span className="text-sm text-muted-foreground">
                  Sets won: <strong className="text-foreground">{score.setsWon[side]}</strong>/{score.setsToWin}
                </span>
              )}
            </div>
            <div className="flex items-end justify-between gap-3">
              <h2 className="min-w-0 break-words font-display text-3xl font-bold leading-none sm:text-4xl">{players[side]}</h2>
              <div className="font-display text-7xl font-bold leading-[0.85] tabular-nums sm:text-8xl" aria-label={`${current[side]} points`}>
                {current[side]}
              </div>
            </div>
            <div className="flex gap-2" aria-hidden>
              {Array.from({ length: rules.targetPoints }, (_, i) => (
                <div
                  key={i}
                  className="h-2.5 flex-1 rounded-full bg-muted"
                  style={i < current[side] ? { background: PLAYER_COLOR[side] } : undefined}
                />
              ))}
            </div>
            <div className="grid flex-1 grid-cols-2 gap-3">
              {finishKinds.map((kind) => {
                const style = FINISH_STYLE[kind];
                const Icon = style.icon;
                const points = pointsFor(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    disabled={score.complete || !started}
                    onClick={() => add(kind, side)}
                    aria-label={`${style.label} for ${players[side]}, plus ${points}`}
                    className="flex min-h-24 flex-col items-start justify-between rounded-2xl border bg-secondary p-4 text-left transition-transform active:scale-[0.97] disabled:opacity-40"
                  >
                    <span className="flex w-full items-center justify-between">
                      <Icon className="size-7" style={{ color: style.color }} aria-hidden />
                      <span className="font-display text-3xl font-bold" style={{ color: style.color }}>
                        +{points}
                      </span>
                    </span>
                    <span className="font-display text-xl font-semibold sm:text-2xl">{style.label}</span>
                  </button>
                );
              })}
            </div>
            {rules.launchErrorPenalty && (
              <button
                type="button"
                disabled={score.complete || !started}
                onClick={() => add("launch_error", side)}
                className="flex min-h-12 items-center justify-center gap-3 rounded-xl border border-dashed font-semibold text-muted-foreground disabled:opacity-40"
              >
                <TriangleAlert className="size-4" aria-hidden />
                Launch error
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-sm">
                  Strikes {score.strikes[side]}/{rules.launchErrorPenalty.strikes}
                </span>
              </button>
            )}
          </section>
        ))}

        <aside className="order-last flex flex-col gap-3 rounded-2xl border bg-background p-4 lg:order-none" aria-label="Battle log">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold">Battle log</h2>
            <span className="text-sm text-muted-foreground">
              {multiSet ? `Set ${score.currentSet + 1} · ` : ""}
              {score.log.length} battles
            </span>
          </div>
          <ol className="flex max-h-72 min-h-24 flex-1 flex-col gap-2 overflow-y-auto lg:max-h-none">
            {score.log.length === 0 && (
              <li className="text-sm text-muted-foreground">{started ? "Tap a finish to record the first battle." : "Start the match to record the first battle."}</li>
            )}
            {[...score.log].reverse().map((entry) => (
              <li key={entry.index} className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm">
                <span className="w-8 font-display text-muted-foreground">B{entry.index + 1}</span>
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: entry.side ? PLAYER_COLOR[entry.side] : "#5B6575" }}
                  aria-hidden
                />
                <span className="flex-1">{describe(entry.kind, entry.side, entry.awardedTo, players)}</span>
                {entry.points > 0 && <span className="font-bold">+{entry.points}</span>}
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={score.complete || !started}
            onClick={() => add("draw", null)}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border bg-secondary font-semibold disabled:opacity-40"
          >
            <Equal className="size-4" aria-hidden />
            Draw · replay battle
          </button>
          <button
            type="button"
            disabled={battles.length === 0}
            onClick={undo}
            className="inline-flex min-h-16 items-center justify-center gap-2 rounded-xl border-2 border-primary text-lg font-bold text-primary disabled:opacity-40"
          >
            <Undo2 className="size-5" aria-hidden />
            Undo last
          </button>
          {score.complete && !showDialog && submit.kind !== "done" && (
            <button
              type="button"
              onClick={() => setDialogClosed(false)}
              className="min-h-12 rounded-xl bg-primary font-bold text-primary-foreground"
            >
              Review &amp; submit
            </button>
          )}
        </aside>
      </main>

      {(showDialog || submit.kind === "done") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="result-title" className="flex w-full max-w-lg flex-col gap-5 rounded-3xl border bg-card p-6 sm:p-8">
            {submit.kind === "done" ? (
              <>
                <p className="flex items-center gap-2 font-semibold text-success">
                  <Check className="size-5" aria-hidden /> Result saved on Challonge
                </p>
                <h2 id="result-title" className="font-display text-3xl font-bold">
                  {winnerName} advances
                </h2>
                {submit.warning && <p className="text-sm text-warning">{submit.warning}</p>}
                <div className="flex flex-wrap gap-3">
                  {/* A result that is on Challonge can only be corrected by the organizer. */}
                  {mode === "organizer" && (
                    <button
                      type="button"
                      onClick={() => void outbox.acknowledgeResult(matchId)}
                      className="min-h-14 flex-1 rounded-xl border bg-secondary font-semibold"
                    >
                      Keep editing
                    </button>
                  )}
                  <Link href={doneHref} className="flex min-h-14 flex-[1.4] items-center justify-center rounded-xl bg-primary font-bold text-primary-foreground">
                    {mode === "judge" ? "Next match" : "Back to the Desk"}
                  </Link>
                </div>
              </>
            ) : submit.kind === "confirm" ? (
              <>
                <p className="flex items-center gap-2 font-semibold text-destructive">
                  <TriangleAlert className="size-5" aria-hidden /> This correction erases results
                </p>
                <h2 id="result-title" className="font-display text-2xl font-bold">
                  Changing the winner resets matches already played
                </h2>
                <p className="text-sm text-muted-foreground">Challonge will wipe these results and send the matches back to the queue:</p>
                <ul className="list-disc pl-5 font-semibold">
                  {submit.affected.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => void outbox.dismissProblem(matchId)}
                    className="min-h-14 flex-1 rounded-xl border bg-secondary font-semibold"
                  >
                    Cancel
                  </button>
                  <button type="button" onClick={() => send(true)} className="min-h-14 flex-[1.4] rounded-xl bg-destructive font-bold text-destructive-foreground">
                    Erase and correct
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold uppercase tracking-widest text-primary">
                  {challonge.complete ? "Correct the result" : "Target reached"}
                </p>
                <h2 id="result-title" className="font-display text-4xl font-bold leading-tight">
                  {winnerName} wins {finalLine}
                </h2>
                <p className="text-muted-foreground">
                  Sent to Challonge as{" "}
                  <strong className="text-foreground">
                    {players[1]} {sets[1]} · {players[2]} {sets[2]}
                  </strong>
                  . The battle-by-battle log stays here.
                </p>
                {submit.kind === "error" && (
                  <p role="alert" className="text-sm text-destructive">
                    {submit.message}
                  </p>
                )}
                {submit.kind === "queued" && (
                  <p role="status" className="flex items-start gap-2 rounded-xl bg-warning-muted p-3 text-sm text-warning">
                    <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden />
                    You&apos;re offline. The result is saved on this device and will be sent to Challonge automatically when the connection is
                    back.
                  </p>
                )}
                {unsaved && online && <p className="text-sm text-muted-foreground">Saving the last battles first…</p>}
                <div className="flex flex-wrap gap-3">
                  <button type="button" onClick={undo} className="min-h-14 flex-1 rounded-xl border bg-secondary font-semibold">
                    Undo last battle
                  </button>
                  <button
                    type="button"
                    disabled={submit.kind === "sending" || submit.kind === "queued"}
                    onClick={() => send(false)}
                    className="inline-flex min-h-14 flex-[1.4] items-center justify-center gap-2 rounded-xl bg-primary font-bold text-primary-foreground disabled:opacity-60"
                  >
                    {submit.kind === "sending" && <LoaderCircle className="size-5 animate-spin" aria-hidden />}
                    {submit.kind === "sending"
                      ? "Sending…"
                      : submit.kind === "queued"
                        ? "Waiting for connection…"
                        : submit.kind === "error"
                          ? "Try again"
                          : "Send to Challonge"}
                  </button>
                </div>
                <button type="button" onClick={() => setDialogClosed(true)} className="self-center text-sm text-muted-foreground underline underline-offset-4">
                  Close and review the log
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function describe(kind: BattleKind, side: Side | null, awardedTo: Side | null, players: { 1: string; 2: string }) {
  if (kind === "draw") return "Draw · replayed";
  if (kind === "launch_error") {
    return `${side ? players[side] : "?"} launch error${awardedTo ? ` · point to ${players[awardedTo]}` : ""}`;
  }
  return `${side ? players[side] : "?"} · ${FINISH_STYLE[kind]?.label ?? kind}`;
}

function SaveStatus({ online, pending, resultQueued }: { online: boolean; pending: number; resultQueued: boolean }) {
  if (!online) {
    return (
      <span role="status" className="inline-flex items-center gap-2 rounded-full bg-warning-muted px-3 py-1.5 text-sm font-semibold text-warning">
        <CloudOff className="size-4" aria-hidden />
        Offline · {pending > 0 ? `${pending} saved on this device` : resultQueued ? "result queued" : "saved on this device"}
      </span>
    );
  }
  return (
    <span role="status" className="inline-flex items-center gap-2 rounded-full bg-success-muted px-3 py-1.5 text-sm font-semibold text-success">
      {pending > 0 ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
      {pending > 0 ? "Saving…" : "Saved"}
    </span>
  );
}
