"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveCredentialsAction, type CredentialsState } from "./actions";

export function CredentialsForm({ clientId, hasSecret }: { clientId: string | null; hasSecret: boolean }) {
  const [state, action] = useActionState<CredentialsState, FormData>(saveCredentialsAction, {});

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="clientId">Client ID</Label>
        <Input id="clientId" name="clientId" required autoComplete="off" defaultValue={clientId ?? ""} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="clientSecret">Client secret</Label>
        <Input
          id="clientSecret"
          name="clientSecret"
          type="password"
          required
          autoComplete="off"
          aria-describedby="clientSecretHelp"
        />
        <p id="clientSecretHelp" className="text-sm text-muted-foreground">
          {hasSecret
            ? "A secret is already saved (encrypted). Enter it again, or a new one, to replace it. Saving disconnects the current Challonge sign-in."
            : "Stored encrypted. It is never shown again or sent to your browser."}
        </p>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-sm text-success">
          Saved. Now connect your Challonge account below.
        </p>
      )}
      <div>
        <SubmitButton pendingLabel="Saving…" variant={hasSecret ? "outline" : "default"}>
          {hasSecret ? "Replace credentials" : "Save credentials"}
        </SubmitButton>
      </div>
    </form>
  );
}
