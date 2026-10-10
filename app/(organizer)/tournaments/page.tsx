import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizer } from "@/lib/auth";
import { challongeClientFor, getConnection } from "@/lib/challonge/connection";
import { describeChallongeError } from "@/lib/challonge/describe-error";
import type { ListResponse, TournamentResource } from "@/lib/challonge/types";
import { db } from "@/lib/db";
import { tournaments } from "@/lib/db/schema";
import { formatRelative } from "@/lib/format";
import { ImportForm } from "./import-form";
import { TournamentStateBadge } from "./state-badge";

export const metadata: Metadata = { title: "Tournaments" };

export default async function TournamentsPage({ searchParams }: { searchParams: Promise<{ browse?: string }> }) {
  const organizer = await requireOrganizer();
  const { browse } = await searchParams;
  const connection = await getConnection(organizer.id);
  const connected = connection?.status === "connected";

  const imported = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.organizerId, organizer.id))
    .orderBy(desc(tournaments.updatedAt));

  return (
    <PageShell title="Tournaments">
      <div className="flex flex-col gap-8">

        {!connected && (
          <Card>
            <CardHeader>
              <CardTitle className="font-display">
                {connection?.status === "reconnect_required" ? "Reconnect Challonge" : "Connect Challonge first"}
              </CardTitle>
              <CardDescription>Tournaments are imported from your Challonge account using your own Challonge app.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href="/settings/challonge">Set up the connection</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        <section aria-labelledby="imported-heading" className="flex flex-col gap-3">
          <h2 id="imported-heading" className="font-display text-xl font-semibold">
            Imported
          </h2>
          {imported.length === 0 ? (
            <p className="text-muted-foreground">No tournaments imported yet.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {imported.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/tournaments/${t.id}`}
                    className="flex h-full flex-col gap-2 rounded-xl border bg-card p-4 transition-colors hover:border-primary"
                  >
                    <span className="font-display text-lg font-semibold">{t.name}</span>
                    <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <TournamentStateBadge state={t.state} />
                      <span className="capitalize">{t.tournamentType}</span>· {t.participantsCount} players
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Synced {t.lastSyncedAt ? formatRelative(t.lastSyncedAt) : "never"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {connected && (
          <section aria-labelledby="import-heading" className="flex flex-col gap-4">
            <h2 id="import-heading" className="font-display text-xl font-semibold">
              Import from Challonge
            </h2>
            <Card>
              <CardContent className="pt-6">
                <ImportForm />
              </CardContent>
            </Card>
            {browse ? (
              <RemoteTournaments organizerId={organizer.id} importedIds={new Set(imported.map((t) => t.challongeId))} />
            ) : (
              <div>
                <Button asChild variant="outline">
                  <Link href="/tournaments?browse=1">Show my Challonge tournaments (1 request)</Link>
                </Button>
              </div>
            )}
          </section>
        )}
      </div>
    </PageShell>
  );
}

async function RemoteTournaments({ organizerId, importedIds }: { organizerId: string; importedIds: Set<string> }) {
  let list: TournamentResource[];
  try {
    const { client } = await challongeClientFor(organizerId);
    const res = await client.get<ListResponse<TournamentResource>>("/tournaments.json?page=1&per_page=50");
    list = res.notModified ? [] : res.body.data;
  } catch (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {describeChallongeError(error)}
      </p>
    );
  }

  if (list.length === 0) return <p className="text-muted-foreground">No tournaments found on your Challonge account.</p>;
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {list.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex flex-col gap-1">
            <span className="font-semibold">{t.attributes.name}</span>
            <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <TournamentStateBadge state={t.attributes.state} />
              <span className="capitalize">{t.attributes.tournament_type}</span>· {t.attributes.participants_count} players
            </span>
          </div>
          {importedIds.has(t.id) ? (
            <Badge variant="muted">Imported</Badge>
          ) : (
            <ImportForm tournament={t.id} label={t.attributes.name} />
          )}
        </li>
      ))}
    </ul>
  );
}
