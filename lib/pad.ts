import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { currentOrganizer } from "@/lib/auth";
import { activeBattles, matchForOrganizer } from "@/lib/battles";
import { matchTitle, roundLabeller } from "@/lib/tournament/labels";
import { labelColumns } from "@/lib/tournament/queries";
import { db } from "@/lib/db";
import { matches, participants, tournaments, type Match, type Tournament } from "@/lib/db/schema";
import { serverTime } from "@/lib/format";
import { judgeAccess, judgeCookie } from "@/lib/judges";
import { rulesFor } from "@/lib/rules";

// What the judge pad needs, whoever opens it: the organizer (any match of theirs) or a judge
// tablet (the match at its stadium).

export type PadActor =
  | { kind: "organizer"; organizerId: string }
  /** A judge acts on the organizer's tournament, but only on the match at `stadiumId`. */
  | { kind: "judge"; organizerId: string; stadiumId: string };

/**
 * Who is asking to act on this match, for the pad's endpoints. 401 means "not signed in at all"
 * (the pad then keeps its taps and asks to be let back in); 404 means this match isn't theirs.
 */
export async function padActor(request: NextRequest, matchId: string): Promise<{ actor: PadActor } | { status: 401 | 404 }> {
  const organizer = await currentOrganizer();
  if (organizer && (await matchForOrganizer(organizer.id, matchId))) return { actor: { kind: "organizer", organizerId: organizer.id } };

  const [row] = await db
    .select({ slug: tournaments.publicSlug, organizerId: tournaments.organizerId, stadiumId: matches.stadiumId, callStatus: matches.callStatus })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(eq(matches.id, matchId))
    .limit(1);
  const access = row ? await judgeAccess(row.slug, request.cookies.get(judgeCookie(row.slug))?.value) : null;
  if (!row || access?.status !== "approved") return { status: organizer ? 404 : 401 };

  // A judge's reach ends with their stadium's current match: not the queue, not finished results.
  const atTheirStadium = row.stadiumId === access.stadiumId && (row.callStatus === "called" || row.callStatus === "playing");
  if (!atTheirStadium) return { status: 404 };
  return { actor: { kind: "judge", organizerId: row.organizerId, stadiumId: access.stadiumId } };
}

/** Everything the pad shows for one match (both players must be known). */
export async function padData(tournament: Tournament, match: Match) {
  const playerIds = [match.player1Id, match.player2Id].filter((id): id is string => Boolean(id));
  const [names, rounds, rules, battles] = await Promise.all([
    db
      .select({ id: participants.id, name: participants.name })
      .from(participants)
      .where(and(eq(participants.tournamentId, tournament.id), inArray(participants.id, playerIds))),
    db.select(labelColumns).from(matches).where(eq(matches.tournamentId, tournament.id)),
    rulesFor(tournament, match),
    activeBattles(match.id),
  ]);
  const nameOf = (id: string | null) => (id ? (names.find((n) => n.id === id)?.name ?? `#${id}`) : "TBD");
  const label = roundLabeller(tournament, rounds)(match);

  return {
    tournamentId: tournament.id,
    matchId: match.id,
    title: `${label} · ${matchTitle(match.number)}`,
    players: { 1: nameOf(match.player1Id), 2: nameOf(match.player2Id) } as { 1: string; 2: string },
    rules,
    initialBattles: battles,
    renderedAt: serverTime(),
    result: {
      complete: match.state === "complete",
      scores: match.scores,
      winnerSide: (match.winnerId === match.player1Id ? 1 : match.winnerId === match.player2Id ? 2 : null) as 1 | 2 | null,
    },
  };
}
