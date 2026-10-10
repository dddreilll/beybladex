import type { Metadata } from "next";
import { CopyField } from "@/components/copy-field";
import { PageShell } from "@/components/page-shell";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizer } from "@/lib/auth";
import { getConnection } from "@/lib/challonge/connection";
import { CHALLONGE_SCOPES } from "@/lib/challonge/oauth";
import { challongeRedirectUri } from "@/lib/config";
import { connectChallongeAction, removeConnectionAction } from "./actions";
import { CredentialsForm } from "./credentials-form";

export const metadata: Metadata = { title: "Challonge connection" };

const CALLBACK_ERRORS: Record<string, string> = {
  denied: "Access was not granted on Challonge. Try connecting again.",
  invalid_state: "The connection attempt expired or came from another browser. Start it again from this page.",
  missing_code: "Challonge didn't send an authorization code. Try connecting again.",
  exchange_failed:
    "Challonge rejected the sign-in. Check that the client ID and secret are correct and that the redirect URI below is registered on your app exactly.",
  no_credentials: "Save your app credentials first.",
};

export default async function ChallongeSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const organizer = await requireOrganizer();
  const { connected, error } = await searchParams;
  const connection = await getConnection(organizer.id);

  return (
    <PageShell title="Challonge connection">
      <div className="flex max-w-3xl flex-col gap-6">
        <p className="text-muted-foreground">You use your own Challonge app, so its request budget and plan are yours alone.</p>

        {connected && (
          <p role="status" className="rounded-lg bg-success-muted p-4 text-success">
            Connected. You can now import tournaments.
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-destructive/15 p-4 text-sm">
            {CALLBACK_ERRORS[error] ?? "Connecting to Challonge failed. Try again."}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-3 font-display">
              Status
              <ConnectionBadge status={connection?.status ?? null} />
            </CardTitle>
            {connection?.status === "connected" && (
              <CardDescription>
                Signed in to Challonge as <strong className="text-foreground">{connection.challongeUsername}</strong>.
                Access renews automatically
                {connection.tokenExpiresAt && <> (current token valid until {connection.tokenExpiresAt.toLocaleString("en")})</>}.
              </CardDescription>
            )}
            {connection?.status === "reconnect_required" && (
              <CardDescription>
                Challonge access stopped working{connection.lastError ? ` (${connection.lastError})` : ""}. Connect again
                to continue.
              </CardDescription>
            )}
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display">1. Create your Challonge app</CardTitle>
            <CardDescription>
              Go to{" "}
              <a href="https://connect.challonge.com" target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
                connect.challonge.com
              </a>
              , create an application, and add this redirect URI exactly as shown.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CopyField id="redirectUri" label="Redirect URI" value={challongeRedirectUri()} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display">2. Enter the app&apos;s credentials</CardTitle>
            <CardDescription>Copy the client ID and client secret from your app in the Developer Portal.</CardDescription>
          </CardHeader>
          <CardContent>
            <CredentialsForm clientId={connection?.clientId ?? null} hasSecret={Boolean(connection)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display">3. Connect your Challonge account</CardTitle>
            <CardDescription>
              You&apos;ll approve access on Challonge, then come back here. Requested access: {CHALLONGE_SCOPES.join(", ")}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <form action={connectChallongeAction}>
              <SubmitButton disabled={!connection} pendingLabel="Opening Challonge…">
                {connection?.status === "connected" ? "Reconnect Challonge" : "Connect Challonge"}
              </SubmitButton>
            </form>
            {connection && (
              <form action={removeConnectionAction}>
                <SubmitButton variant="outline" pendingLabel="Removing…">
                  Remove connection and credentials
                </SubmitButton>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

function ConnectionBadge({ status }: { status: string | null }) {
  if (status === "connected") return <Badge variant="success">Connected</Badge>;
  if (status === "reconnect_required") return <Badge variant="warning">Reconnect needed</Badge>;
  if (status === "credentials_saved") return <Badge variant="muted">Credentials saved · not connected</Badge>;
  return <Badge variant="muted">Not set up</Badge>;
}
