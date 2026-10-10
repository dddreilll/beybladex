"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { retryResultAction, type ActionState } from "@/app/(organizer)/tournaments/actions";

export function RetryButton({ tournamentId, matchId }: { tournamentId: string; matchId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(retryResultAction.bind(null, tournamentId, matchId), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton size="sm" pendingLabel="Sending…">
        Retry send
      </SubmitButton>
      <span aria-live="polite" className="text-sm">
        {state.error ? <span className="text-destructive">{state.error}</span> : state.message}
      </span>
    </form>
  );
}
