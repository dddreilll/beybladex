"use client";

import { useState, useTransition } from "react";
import { Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { finalizeAction, loadStandingsAction } from "./access-actions";
import type { VenueState } from "./venue-actions";

type Props = {
  tournamentId: string;
  tournamentName: string;
  finalized: boolean;
  /** Final placements have been read from Challonge. */
  hasStandings: boolean;
  /** What still has to happen before finalizing; empty when it's ready. */
  blockers: string[];
};

/**
 * Ends the event: marks the tournament final on Challonge and puts the standings on the screens.
 * It can't be undone on Challonge, so it asks first, and only once everything is played and sent.
 */
export function FinalizeButton({ tournamentId, tournamentName, finalized, hasStandings, blockers }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<VenueState>({});
  const run = (action: (id: string) => Promise<VenueState>) => startTransition(async () => setResult(await action(tournamentId)));
  const feedback = (
    <span aria-live="polite" className="text-sm empty:hidden">
      {result.error ? <span className="text-destructive">{result.error}</span> : result.message}
    </span>
  );

  if (finalized) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-2 text-sm font-semibold">
          <Flag className="size-4" aria-hidden />
          Finalized
        </span>
        {!hasStandings && (
          <Button variant="outline" disabled={pending} onClick={() => run(loadStandingsAction)}>
            {pending ? "Loading…" : "Load standings"}
          </Button>
        )}
        {feedback}
      </div>
    );
  }

  const ready = blockers.length === 0;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={!ready || pending} aria-describedby={ready ? undefined : "finalize-blockers"} onClick={() => setConfirming(true)}>
        <Flag className="size-4" aria-hidden />
        {pending ? "Finalizing…" : "Finalize tournament"}
      </Button>
      {!ready && (
        <span id="finalize-blockers" className="text-sm text-muted-foreground">
          {blockers.join(" ")}
        </span>
      )}
      {feedback}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="finalize-title" className="flex w-full max-w-md flex-col gap-4 rounded-2xl border bg-card p-6">
            <h2 id="finalize-title" className="font-display text-2xl font-bold">
              Finalize {tournamentName}?
            </h2>
            <p className="text-muted-foreground">
              This marks the tournament complete on Challonge and <strong className="text-foreground">can&apos;t be undone there</strong>. The call
              board and every player&apos;s page switch to the final standings.
            </p>
            <p className="text-sm text-muted-foreground">Uses about 4 Challonge requests: a resync, the finalize, and the standings.</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => setConfirming(false)} className="min-h-12 flex-1 rounded-xl border bg-secondary font-semibold">
                Not yet
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  run(finalizeAction);
                }}
                className="min-h-12 flex-1 rounded-xl bg-primary font-bold text-primary-foreground"
              >
                Finalize
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
