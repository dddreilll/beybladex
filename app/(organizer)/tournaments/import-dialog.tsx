"use client";

import { useActionState, useEffect, useId } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatOptions, type TournamentPreview } from "@/lib/challonge/support";
import type { ActionState } from "./actions";
import { TournamentStateBadge } from "./state-badge";

type Props = {
  preview: TournamentPreview;
  /** The server action that imports it, sent `field` as its form data. */
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  field: { name: string; value: string };
  /** What confirming costs in Challonge requests. */
  requests: number;
  onClose: () => void;
};

/**
 * Asks before importing: the organizer checks it is the right tournament, set up the way they
 * meant. Only a tournament the app can run gets here; the others are refused before this opens.
 */
export function ImportDialog({ preview, action, field, requests, onClose }: Props) {
  const [state, submit, pending] = useActionState<ActionState, FormData>(action, {});
  const titleId = useId();
  const close = pending ? undefined : onClose;

  useEffect(() => {
    if (!close) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const details = [
    { label: "Format", value: <span className="capitalize">{preview.tournamentType}</span> },
    ...formatOptions(preview),
    { label: "Players", value: preview.participantsCount },
    { label: "Status", value: <TournamentStateBadge state={preview.state} /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-4 rounded-2xl border bg-card p-6 text-left"
      >
        <h2 id={titleId} className="font-display text-2xl font-bold leading-tight">
          Import {preview.name}?
        </h2>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          {details.map((detail) => (
            <div key={detail.label} className="contents">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="font-semibold">{detail.value}</dd>
            </div>
          ))}
        </dl>
        <a
          href={`https://challonge.com/${preview.challongeUrl}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 self-start text-sm font-semibold underline underline-offset-4"
        >
          View on Challonge
          <ExternalLink className="size-4" aria-hidden />
        </a>
        <p className="text-sm text-muted-foreground">Importing uses {requests} Challonge requests.</p>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <form action={submit} className="flex flex-wrap gap-3">
          <input type="hidden" name={field.name} value={field.value} />
          <Button type="button" variant="secondary" autoFocus disabled={pending} onClick={onClose} className="min-h-12 flex-1 rounded-xl border text-base font-semibold">
            Cancel
          </Button>
          <Button type="submit" disabled={pending} className="min-h-12 flex-1 rounded-xl text-base font-bold">
            {pending ? "Importing…" : "Import"}
          </Button>
        </form>
      </div>
    </div>
  );
}
