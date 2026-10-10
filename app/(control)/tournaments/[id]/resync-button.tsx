"use client";

import { useActionState } from "react";
import { RefreshCw } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import { resyncTournamentAction, type ActionState } from "@/app/(organizer)/tournaments/actions";

export function ResyncButton({ tournamentId }: { tournamentId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(
    resyncTournamentAction.bind(null, tournamentId),
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton variant="outline" pendingLabel="Syncing…">
        <RefreshCw className="size-4" aria-hidden />
        Resync
      </SubmitButton>
      <span aria-live="polite" className="text-sm">
        {state.error ? <span className="text-destructive">{state.error}</span> : state.message}
      </span>
    </form>
  );
}
