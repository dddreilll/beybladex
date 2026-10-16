"use client";

import { useState, useTransition, type ReactNode } from "react";
import { ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StagePhase } from "@/lib/challonge/support";
import { endGroupStageAction, startFinalStageAction } from "./access-actions";
import type { VenueState } from "./venue-actions";

type Props = {
  tournamentId: string;
  tournamentName: string;
  /** `groups`: the group stage is being played. `between`: it has ended and the final stage hasn't started. `final`: it has. */
  phase: StagePhase;
  /** What still has to happen before the group stage can end; empty when it's ready. */
  blockers: string[];
  /** The players who advance, in the order Challonge seeded them, once the group stage has ended. */
  advancing: string[];
  /** What stands here once the final stage has started: Finalize. */
  children: ReactNode;
};

/**
 * Moves a two-stage tournament on: ends its group stage, then starts its final stage. Two steps, as
 * on Challonge, so the organizer sees who advances in between. Ending the group stage can't be
 * undone from here, so it asks first, and only once every group match is played and sent.
 * It stays in place through all three phases, so what the last step answered is still shown after it.
 */
export function StageButton({ tournamentId, tournamentName, phase, blockers, advancing, children }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<VenueState>({});
  const feedback = (
    <span aria-live="polite" className="text-sm empty:hidden">
      {result.error ? <span className="text-destructive">{result.error}</span> : result.message}
    </span>
  );

  if (phase === "final") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {children}
        {feedback}
      </div>
    );
  }

  const ending = phase === "groups";
  const ready = !ending || blockers.length === 0;
  const label = ending ? "End group stage" : "Start final stage";
  const confirm = () => {
    setConfirming(false);
    startTransition(async () => setResult(await (ending ? endGroupStageAction : startFinalStageAction)(tournamentId)));
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={!ready || pending} aria-describedby={ready ? undefined : "stage-blockers"} onClick={() => setConfirming(true)}>
        <ChevronsRight className="size-4" aria-hidden />
        {pending ? (ending ? "Ending…" : "Starting…") : label}
      </Button>
      {!ready && (
        <span id="stage-blockers" className="text-sm text-muted-foreground">
          {blockers.join(" ")}
        </span>
      )}
      {feedback}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="stage-title" className="flex w-full max-w-md flex-col gap-4 rounded-2xl border bg-card p-6">
            <h2 id="stage-title" className="font-display text-2xl font-bold">
              {ending ? `End the group stage of ${tournamentName}?` : `Start the final stage of ${tournamentName}?`}
            </h2>
            {ending ? (
              <p className="text-muted-foreground">
                Challonge works out who advances. After this, <strong className="text-foreground">group results can&apos;t be corrected</strong>.
              </p>
            ) : (
              <p className="text-muted-foreground">
                {advancing.length > 0 && (
                  <>
                    <strong className="text-foreground">{advancing.length} players advance:</strong> {advancing.join(", ")}.{" "}
                  </>
                )}
                Challonge creates the matches of the final stage, and they go to the stadiums.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {ending ? "Uses 2 Challonge requests: the change, and the players who advance." : "Uses 2 Challonge requests: the start, and the new matches."}
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => setConfirming(false)} className="min-h-12 flex-1 rounded-xl border bg-secondary font-semibold">
                Not yet
              </button>
              <button type="button" onClick={confirm} className="min-h-12 flex-1 rounded-xl bg-primary font-bold text-primary-foreground">
                {label}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
