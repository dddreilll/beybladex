import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireOrganizer } from "@/lib/auth";
import { activeBattles, matchForOrganizer } from "@/lib/battles";
import { roundContext, roundLabel } from "@/lib/challonge/map";
import { db } from "@/lib/db";
import { matches, participants, syncOutbox } from "@/lib/db/schema";
import { serverTime } from "@/lib/format";
import { rulesFor } from "@/lib/rules";
import { JudgePad } from "./judge-pad";

export const metadata: Metadata = { title: "Judge pad" };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function JudgePadPage({ params }: { params: Promise<{ id: string; matchId: string }> }) {
  const organizer = await requireOrganizer();
  const { id, matchId } = await params;
  if (!UUID.test(id) || !UUID.test(matchId)) notFound();

  const found = await matchForOrganizer(organizer.id, matchId);
  if (!found || found.tournament.id !== id) notFound();
  const { match, tournament } = found;
  const back = `/tournaments/${tournament.id}`;

  if (!match.player1ChallongeId || !match.player2ChallongeId) {
    return (
      <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-4 p-6">
        <h1 className="font-display text-2xl font-bold">Players not decided yet</h1>
        <p className="text-muted-foreground">This match can be scored once both players are known.</p>
        <Link href={back} className="font-semibold text-primary underline underline-offset-4">
          Back to the control room
        </Link>
      </main>
    );
  }

  const [names, rounds, rules, battles, [lastSync]] = await Promise.all([
    db
      .select({ challongeId: participants.challongeId, name: participants.name })
      .from(participants)
      .where(
        and(
          eq(participants.tournamentId, tournament.id),
          inArray(participants.challongeId, [match.player1ChallongeId, match.player2ChallongeId]),
        ),
      ),
    db.select({ round: matches.round }).from(matches).where(eq(matches.tournamentId, tournament.id)),
    rulesFor(tournament, match),
    activeBattles(match.id),
    db
      .select({ status: syncOutbox.status, lastError: syncOutbox.lastError })
      .from(syncOutbox)
      .where(eq(syncOutbox.matchId, match.id))
      .orderBy(desc(syncOutbox.createdAt))
      .limit(1),
  ]);
  const nameOf = (pid: string) => names.find((n) => n.challongeId === pid)?.name ?? `#${pid}`;
  const label = roundLabel(match.round, roundContext(tournament.tournamentType, rounds.map((r) => r.round)));

  return (
    <JudgePad
      tournamentId={tournament.id}
      matchId={match.id}
      backHref={back}
      title={`${label} · Match ${match.identifier}`}
      players={{ 1: nameOf(match.player1ChallongeId), 2: nameOf(match.player2ChallongeId) }}
      rules={rules}
      initialBattles={battles}
      renderedAt={serverTime()}
      challonge={{
        complete: match.state === "complete",
        scores: match.scores,
        winnerSide:
          match.winnerChallongeId === match.player1ChallongeId ? 1 : match.winnerChallongeId === match.player2ChallongeId ? 2 : null,
        lastSync: lastSync ?? null,
      }}
    />
  );
}
