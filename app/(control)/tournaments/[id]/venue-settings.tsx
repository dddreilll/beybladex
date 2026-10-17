"use client";

import { useActionState, useState } from "react";
import { ExternalLink, Settings2 } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import { MAX_BOARD_LIMIT } from "@/lib/config";
import { venueSettingsAction, type VenueState } from "./venue-actions";

const toggle =
  "relative h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-muted transition-colors checked:bg-primary " +
  "after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-foreground after:transition-transform " +
  "checked:after:translate-x-5 checked:after:bg-primary-foreground";

function Switch({ name, label, hint, defaultChecked }: { name: string; label: string; hint: string; defaultChecked: boolean }) {
  return (
    <label className="flex items-start justify-between gap-4">
      <span className="flex flex-col">
        <span className="font-semibold">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      <input type="checkbox" role="switch" name={name} defaultChecked={defaultChecked} className={toggle} />
    </label>
  );
}

/** Everything about how the venue runs that the mockup doesn't show on the page itself. */
export function VenueSettings({
  tournamentId,
  autoOnDeck,
  autoCall,
  boardLimit,
  playerPageHref,
}: {
  tournamentId: string;
  autoOnDeck: boolean;
  autoCall: boolean;
  boardLimit: number;
  playerPageHref: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<VenueState, FormData>(venueSettingsAction.bind(null, tournamentId), {});

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="venue-settings"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold"
      >
        <Settings2 className="size-4" aria-hidden />
        Venue settings
      </button>
      {open && (
        <div id="venue-settings" className="absolute right-0 z-20 mt-2 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-4 rounded-2xl border bg-popover p-4 text-sm shadow-xl">
          <form action={action} className="flex flex-col gap-4">
            <Switch
              name="autoOnDeck"
              label="Fill on deck automatically"
              hint="Off: on-deck slots stay empty until you place a match from the queue."
              defaultChecked={autoOnDeck}
            />
            <Switch
              name="autoCall"
              label="Call automatically"
              hint="Off: you press Call players when a stadium is free."
              defaultChecked={autoCall}
            />
            <label className="flex items-start justify-between gap-4">
              <span className="flex flex-col">
                <span className="font-semibold">Boards allowed</span>
                <span className="text-xs text-muted-foreground">How many screens you can approve to show the board.</span>
              </span>
              <input
                type="number"
                name="boardLimit"
                min={1}
                max={MAX_BOARD_LIMIT}
                required
                defaultValue={boardLimit}
                className="h-9 w-16 shrink-0 rounded-md border border-input bg-transparent px-2 text-right tabular-nums"
              />
            </label>
            <div className="flex items-center gap-3">
              <SubmitButton size="sm" pendingLabel="Saving…">
                Save settings
              </SubmitButton>
              <span aria-live="polite" className={state.error ? "text-destructive" : "text-muted-foreground"}>
                {state.error ?? state.message}
              </span>
            </div>
          </form>
          <div className="h-px bg-border" />
          <div className="flex flex-col gap-2">
            <a href={playerPageHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline underline-offset-4">
              BXQ Pass <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
