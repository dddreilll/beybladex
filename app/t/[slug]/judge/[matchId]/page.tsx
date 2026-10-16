import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { JudgePad } from "@/components/judge/judge-pad";
import { SLUG_PATTERN } from "@/lib/board";
import { db } from "@/lib/db";
import { matches, tournaments } from "@/lib/db/schema";
import { judgeAccess, judgeCookie } from "@/lib/judges";
import { padData } from "@/lib/pad";

export const metadata: Metadata = { title: { absolute: "BXQ Pad" }, robots: { index: false } };

const UUID = /^[0-9a-f-]{36}$/i;

// A judge tablet's pad: only for the match that is at its own stadium right now. Anything else
// (not approved, another stadium's match, a finished one) goes back to the tablet's home screen.
export default async function JudgeTabletPad({ params }: { params: Promise<{ slug: string; matchId: string }> }) {
  const { slug, matchId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID.test(matchId)) notFound();
  const home = `/t/${slug}/judge`;

  const access = await judgeAccess(slug, (await cookies()).get(judgeCookie(slug))?.value);
  if (access.status !== "approved") redirect(home);

  const [found] = await db
    .select({ match: matches, tournament: tournaments })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(and(eq(matches.id, matchId), eq(tournaments.id, access.tournamentId)))
    .limit(1);
  const here = found && found.match.stadiumId === access.stadiumId && (found.match.callStatus === "called" || found.match.callStatus === "playing");
  if (!found || !here || !found.match.player1ChallongeId || !found.match.player2ChallongeId) redirect(home);

  return (
    <JudgePad
      mode="judge"
      // Back to the tablet's home without it opening this pad again straight away.
      backHref={`${home}?stay=1`}
      backLabel={access.stadium}
      // After a result the tablet follows its stadium again and opens the next match by itself.
      doneHref={home}
      started={found.match.callStatus === "playing"}
      closeSignalUrl={`/api/public/${slug}/judge/bye`}
      {...await padData(found.tournament, found.match)}
    />
  );
}
