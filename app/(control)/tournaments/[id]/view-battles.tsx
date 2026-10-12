"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { BattleSheet, sheetScore } from "@/components/battle-sheet";
import type { MatchSheet } from "@/lib/battle-sheet";
import { battleSheetAction } from "./battle-actions";

type State = { kind: "closed" } | { kind: "loading" } | { kind: "open"; sheet: MatchSheet } | { kind: "error" };

/**
 * "View battles" on a finished match: a dialog with every battle and the score after it. The
 * battles are read when it opens. Undone battles stay hidden until the organizer asks for them.
 */
export function ViewBattles({ matchId, label, players }: { matchId: string; label: string; players: string }) {
  const [state, setState] = useState<State>({ kind: "closed" });
  const [showVoided, setShowVoided] = useState(false);
  const isOpen = state.kind !== "closed";

  const open = async () => {
    setState({ kind: "loading" });
    setShowVoided(false);
    try {
      const sheet = await battleSheetAction(matchId);
      setState(sheet ? { kind: "open", sheet } : { kind: "error" });
    } catch {
      setState({ kind: "error" });
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setState({ kind: "closed" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const sheet = state.kind === "open" ? state.sheet : null;
  const voided = sheet ? sheet.entries.filter((e) => e.type === "voided").length : 0;
  const titleId = `battles-${matchId}`;

  return (
    <>
      <button type="button" onClick={() => void open()} aria-label={`View battles of ${label}, ${players}`} className="font-semibold underline underline-offset-4">
        View battles
      </button>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={() => setState({ kind: "closed" })}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[min(44rem,calc(100svh-2rem))] w-full max-w-lg flex-col gap-4 rounded-2xl border bg-card p-6 text-base"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <h3 id={titleId} className="font-display text-2xl font-bold leading-tight">
                  {players}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {sheet ? `${sheet.round} · ${label}` : label}
                  {sheet?.winner && (
                    <>
                      {" · "}
                      <span className="font-semibold text-foreground">
                        {sheet.players[sheet.winner]} won{sheetScore(sheet) ? ` ${sheetScore(sheet)}` : ""}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <button
                type="button"
                autoFocus
                onClick={() => setState({ kind: "closed" })}
                aria-label="Close"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            {state.kind === "loading" && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading battles…
              </p>
            )}
            {state.kind === "error" && (
              <p role="alert" className="text-sm text-destructive">
                Couldn&apos;t load this match&apos;s battles. Close this and try again.
              </p>
            )}
            {sheet && (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <BattleSheet sheet={sheet} showVoided={showVoided} />
                </div>
                {voided > 0 && (
                  <label className="flex cursor-pointer items-center gap-3 border-t pt-4 text-sm">
                    <input type="checkbox" role="switch" checked={showVoided} onChange={(event) => setShowVoided(event.target.checked)} className="size-4 accent-primary" />
                    <span>
                      Show undone battles <span className="text-muted-foreground">({voided})</span>
                    </span>
                  </label>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
