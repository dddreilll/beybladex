"use client";

import { useFormStatus } from "react-dom";
import { Plus } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import { addStadiumAction } from "./venue-actions";

/** Compact button for the Stadiums heading row. */
export function AddStadiumButton({ tournamentId }: { tournamentId: string }) {
  return (
    <form action={addStadiumAction.bind(null, tournamentId)}>
      <SubmitButton size="sm" variant="outline" pendingLabel="Adding…">
        <Plus className="size-4" aria-hidden /> Add stadium
      </SubmitButton>
    </form>
  );
}

function Tile() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60"
    >
      <span className="flex size-12 items-center justify-center rounded-full border-2 border-current">
        <Plus className="size-6" aria-hidden />
      </span>
      <span className="font-display text-lg font-semibold">{pending ? "Adding…" : "Add stadium"}</span>
    </button>
  );
}

/** A card-sized tile at the end of the stadium grid (and the whole grid when there are none yet). */
export function AddStadiumTile({ tournamentId }: { tournamentId: string }) {
  return (
    <li className="flex">
      <form action={addStadiumAction.bind(null, tournamentId)} className="flex flex-1">
        <Tile />
      </form>
    </li>
  );
}
