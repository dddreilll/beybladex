import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JudgePad } from "@/components/judge/judge-pad";
import { requireOrganizer } from "@/lib/auth";
import { matchForOrganizer } from "@/lib/battles";
import { db } from "@/lib/db";
import { padData } from "@/lib/pad";
import { NO_JUDGE, stadiumHasJudge } from "@/lib/venue";

export const metadata: Metadata = { title: "Judge pad" };

const UUID = /^[0-9a-f-]{36}$/i;

// The organizer's own way into a pad: any match of theirs, to score it or correct its result.
// Judge tablets use /t/<slug>/judge instead, which needs no organizer sign-in.
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

  // Only a match that was called to a stadium waits for a start (and for that stadium's judge).
  const called = match.callStatus === "called";
  const startBlocked = called && !(await stadiumHasJudge(db, match.stadiumId)) ? `${NO_JUDGE} Approve a judge's device, or choose Judge here myself in the control room.` : null;

  return <JudgePad mode="organizer" backHref={back} backLabel="Control room" started={!called} startBlocked={startBlocked} {...await padData(tournament, match)} />;
}
