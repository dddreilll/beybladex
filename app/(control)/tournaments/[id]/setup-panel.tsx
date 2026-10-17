"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Play, Shuffle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parsePlayerNames } from "@/lib/tournament/setup";
import { cn } from "@/lib/utils";
import { addPlayersAction, deleteTournamentAction, moveSeedAction, removePlayerAction, renamePlayerAction, shuffleSeedsAction, startTournamentAction } from "./setup-actions";
import type { VenueState } from "./venue-actions";

const outlineButton = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-semibold disabled:opacity-60";

function useAction() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<VenueState>({});
  const run = (action: () => Promise<VenueState>, after?: (result: VenueState) => void) =>
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      after?.(outcome);
    });
  const feedback = (
    <p aria-live="polite" className={cn("text-sm empty:hidden", result.error ? "text-destructive" : "text-muted-foreground")}>
      {result.error ?? result.message ?? ""}
    </p>
  );
  return { pending, run, feedback };
}

export type SetupPlayer = { id: string; name: string; seed: number };

/**
 * Before the start: the players in seed order, to add to, rename, reorder and remove. Nothing is
 * dragged, as elsewhere on the Desk: each player has Move up and Move down.
 */
export function SetupPanel({ tournamentId, players, summary }: { tournamentId: string; players: SetupPlayer[]; summary: string }) {
  const { pending, run, feedback } = useAction();
  const [names, setNames] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const adding = parsePlayerNames(names).length;

  const rename = (player: SetupPlayer) =>
    run(
      () => renamePlayerAction(tournamentId, player.id, draft),
      (outcome) => !outcome.error && setEditing(null),
    );

  return (
    <section aria-labelledby="setup-heading" className="flex flex-col gap-4 rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="setup-heading" className="font-display text-2xl font-semibold">
          Players and seeds <span className="text-muted-foreground">({players.length})</span>
        </h2>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">The order is the seed order: the first player is seed 1. Players and seeds are fixed once you start.</p>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => addPlayersAction(tournamentId, names),
            (outcome) => !outcome.error && setNames(""),
          );
        }}
      >
        <Label htmlFor="add-players">Add players</Label>
        <textarea
          id="add-players"
          rows={2}
          value={names}
          onChange={(e) => setNames(e.target.value)}
          placeholder="One name, or many separated by commas or new lines"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || adding === 0}>
            {adding > 1 ? `Add ${adding} players` : "Add player"}
          </Button>
          <button type="button" disabled={pending || players.length < 2} onClick={() => run(() => shuffleSeedsAction(tournamentId))} className={outlineButton}>
            <Shuffle className="size-4" aria-hidden />
            Shuffle seeds
          </button>
        </div>
      </form>

      {feedback}

      {players.length > 0 && (
        <ol className="flex flex-col divide-y rounded-xl border">
          {players.map((player, i) => (
            <li key={player.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="w-8 font-display font-semibold tabular-nums text-muted-foreground">{player.seed}</span>
              {editing === player.id ? (
                <form
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename(player);
                  }}
                >
                  <Input aria-label={`New name for ${player.name}`} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} autoFocus className="max-w-xs" />
                  <Button type="submit" size="sm" disabled={pending}>
                    Save
                  </Button>
                  <button type="button" onClick={() => setEditing(null)} className={outlineButton}>
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(player.id);
                    setDraft(player.name);
                  }}
                  title="Rename"
                  className="min-w-0 flex-1 truncate text-left font-semibold underline-offset-4 hover:underline"
                >
                  {player.name}
                </button>
              )}
              <div className="flex items-center gap-1.5">
                <button type="button" disabled={pending || i === 0} onClick={() => run(() => moveSeedAction(tournamentId, player.id, -1))} aria-label={`Move ${player.name} up`} className={outlineButton}>
                  <ArrowUp className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  disabled={pending || i === players.length - 1}
                  onClick={() => run(() => moveSeedAction(tournamentId, player.id, 1))}
                  aria-label={`Move ${player.name} down`}
                  className={outlineButton}
                >
                  <ArrowDown className="size-4" aria-hidden />
                </button>
                <button type="button" disabled={pending} onClick={() => run(() => removePlayerAction(tournamentId, player.id))} aria-label={`Remove ${player.name}`} className={outlineButton}>
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Starts the tournament: the bracket or the groups are built and the queue fills. Players and seeds
 * are fixed after it, so it asks first. What still blocks it is said beside the disabled button.
 */
export function StartButton({ tournamentId, tournamentName, players, blockers }: { tournamentId: string; tournamentName: string; players: number; blockers: string[] }) {
  const { pending, run, feedback } = useAction();
  const [confirming, setConfirming] = useState(false);
  const ready = blockers.length === 0;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={!ready || pending} aria-describedby={ready ? undefined : "start-blockers"} onClick={() => setConfirming(true)}>
        <Play className="size-4" aria-hidden />
        {pending ? "Starting…" : "Start tournament"}
      </Button>
      {!ready && (
        <span id="start-blockers" className="text-sm text-muted-foreground">
          {blockers.join(" ")}
        </span>
      )}
      {feedback}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="start-title" className="flex w-full max-w-md flex-col gap-4 rounded-2xl border bg-card p-6">
            <h2 id="start-title" className="font-display text-2xl font-bold">
              Start {tournamentName}?
            </h2>
            <p className="text-muted-foreground">
              The matches of all {players} players are made and go to the stadiums. After this,{" "}
              <strong className="text-foreground">players can&apos;t be added or reseeded</strong>; a player can still drop out.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => setConfirming(false)} className="min-h-12 flex-1 rounded-xl border bg-secondary font-semibold">
                Not yet
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  run(() => startTournamentAction(tournamentId));
                }}
                className="min-h-12 flex-1 rounded-xl bg-primary font-bold text-primary-foreground"
              >
                Start
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Deletes the tournament with everything in it, once its name is typed. */
export function DeleteTournament({ tournamentId, tournamentName }: { tournamentId: string; tournamentName: string }) {
  const { pending, run, feedback } = useAction();
  const [typed, setTyped] = useState("");

  return (
    <details className="rounded-2xl border border-destructive/40 bg-card">
      <summary className="cursor-pointer px-5 py-4 font-display text-lg font-semibold">Delete tournament</summary>
      <form
        className="flex flex-col gap-3 border-t px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => deleteTournamentAction(tournamentId, typed));
        }}
      >
        <p className="max-w-prose text-sm text-muted-foreground">
          This deletes the tournament with its players, matches, battles, stadiums and devices, and <strong className="text-foreground">can&apos;t be undone</strong>.
        </p>
        <Label htmlFor="delete-name">
          Type <strong>{tournamentName}</strong> to confirm
        </Label>
        <div className="flex flex-wrap items-center gap-3">
          <Input id="delete-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="max-w-xs" />
          <Button type="submit" variant="destructive" disabled={pending || typed.trim() !== tournamentName}>
            {pending ? "Deleting…" : "Delete tournament"}
          </Button>
        </div>
        {feedback}
      </form>
    </details>
  );
}
