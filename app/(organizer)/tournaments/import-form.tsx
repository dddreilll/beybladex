"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TournamentPreview } from "@/lib/challonge/support";
import { importReviewedAction, importTournamentAction, reviewTournamentAction, type ReviewState } from "./actions";
import { ImportDialog } from "./import-dialog";

/** Import by link or ID: the tournament is read first, then the organizer reviews it and confirms. */
export function ImportForm() {
  const [state, review] = useActionState<ReviewState, FormData>(reviewTournamentAction, {});
  // Held in state so the link survives the form's reset after each review: a typo can be fixed, a closed review reopened.
  const [link, setLink] = useState("");
  // The token of the review the organizer closed, so its dialog stays closed until they review again.
  const [closed, setClosed] = useState<string | null>(null);
  const open = state.review && state.review.token !== closed ? state.review : null;

  return (
    <>
      <form action={review} className="flex flex-col gap-2">
        <Label htmlFor="tournament">Tournament link or ID</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="tournament"
            name="tournament"
            required
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://challonge.com/your_bracket"
            className="min-w-0 flex-1 basis-64"
          />
          <SubmitButton pendingLabel="Reading…">Review</SubmitButton>
        </div>
        <p className="text-sm text-muted-foreground">Reading it uses 1 Challonge request. Importing it uses 2 more.</p>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </form>
      {open && (
        <ImportDialog
          key={open.token}
          preview={open.preview}
          action={importReviewedAction}
          field={{ name: "token", value: open.token }}
          requests={2}
          onClose={() => setClosed(open.token)}
        />
      )}
    </>
  );
}

/** Import from the organizer's Challonge tournaments: the details are already on the page, so reviewing costs nothing. */
export function ImportListed({ preview }: { preview: TournamentPreview }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} aria-label={`Import ${preview.name}`}>
        Import
      </Button>
      {open && (
        <ImportDialog
          preview={preview}
          action={importTournamentAction}
          field={{ name: "tournament", value: preview.challongeId }}
          requests={3}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
