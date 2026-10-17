import type { Metadata } from "next";
import Link from "next/link";
import { count, desc, eq } from "drizzle-orm";
import { Plus } from "lucide-react";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { requireOrganizer } from "@/lib/auth";
import { db } from "@/lib/db";
import { participants, tournaments } from "@/lib/db/schema";
import { formatName } from "@/lib/tournament/format";
import { TournamentStateBadge } from "./state-badge";

export const metadata: Metadata = { title: "Tournaments" };

export default async function TournamentsPage() {
  const organizer = await requireOrganizer();
  const rows = await db
    .select({ tournament: tournaments, players: count(participants.id) })
    .from(tournaments)
    .leftJoin(participants, eq(participants.tournamentId, tournaments.id))
    .where(eq(tournaments.organizerId, organizer.id))
    .groupBy(tournaments.id)
    .orderBy(desc(tournaments.updatedAt));

  return (
    <PageShell
      title="Tournaments"
      actions={
        <Button asChild>
          <Link href="/tournaments/new">
            <Plus aria-hidden />
            New tournament
          </Link>
        </Button>
      }
    >
      <section aria-labelledby="tournaments-heading" className="flex flex-col gap-3">
        <h2 id="tournaments-heading" className="font-display text-xl font-semibold">
          Your tournaments
        </h2>
        {rows.length === 0 ? (
          <p className="text-muted-foreground">No tournaments yet. Create one to set up its players and start it.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map(({ tournament: t, players }) => (
              <li key={t.id}>
                <Link
                  href={`/tournaments/${t.id}`}
                  className="flex h-full flex-col gap-2 rounded-xl border bg-card p-4 transition-colors hover:border-primary-text"
                >
                  <span className="font-display text-lg font-semibold">{t.name}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <TournamentStateBadge state={t.state} />
                    <span>{t.groupStage && t.groupStageType ? `${formatName(t.groupStageType)} groups, then ${formatName(t.tournamentType).toLowerCase()}` : formatName(t.tournamentType)}</span>
                    · {players} players
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageShell>
  );
}
