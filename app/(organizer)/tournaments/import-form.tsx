"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { importTournamentAction, type ActionState } from "./actions";

/** Either a free-text field, or (with `tournament`) a one-click import button for a listed tournament. */
export function ImportForm({ tournament, label }: { tournament?: string; label?: string }) {
  const [state, action] = useActionState<ActionState, FormData>(importTournamentAction, {});

  if (tournament) {
    return (
      <form action={action} className="flex flex-col items-end gap-1">
        <input type="hidden" name="tournament" value={tournament} />
        <SubmitButton size="sm" pendingLabel="Importing…" aria-label={label ? `Import ${label}` : undefined}>
          Import
        </SubmitButton>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </form>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <Label htmlFor="tournament">Tournament link or ID</Label>
      <div className="flex flex-wrap gap-2">
        <Input id="tournament" name="tournament" required placeholder="https://challonge.com/your_bracket" className="min-w-0 flex-1 basis-64" />
        <SubmitButton pendingLabel="Importing…">Import</SubmitButton>
      </div>
      <p className="text-sm text-muted-foreground">Uses 3 Challonge requests.</p>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
