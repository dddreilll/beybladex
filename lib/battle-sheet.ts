import "server-only";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { roundLabeller } from "@/lib/tournament/labels";
import { labelColumns } from "@/lib/tournament/queries";
import { db } from "@/lib/db";
import { battles, matches, participants, tournaments, type BattleRow, type Match } from "@/lib/db/schema";
import { battleWords, sheetLines, type SheetLine } from "@/lib/scoring/describe";
import type { Side } from "@/lib/scoring/engine";

// A finished match's battle-by-battle score, for the control room (any match of the organizer's,
// optionally with the battles that were undone) and for a player (their own matches only).

export type SheetEntry =
  | { type: "battle"; line: SheetLine }
  /** A battle that doesn't count: undone by the judge, or wiped by a cancel or a correction. */
  | { type: "voided"; who: string | null; what: string; reason: string };

export type MatchSheet = {
  id: string;
  round: string;
  identifier: string;
  players: { 1: string; 2: string };
  winner: Side | null;
  /** The result (points, or sets won in a multi-set match), player 1 first. */
  score: { 1: number; 2: number } | null;
  /** False when the match has no battles to show. */
  recorded: boolean;
  /** In the order the judge recorded them. */
  entries: SheetEntry[];
  /** Which side the signed-in player is, on a player's own sheets. */
  mine?: Side;
};

const VOID_REASONS: Record<string, string> = {
  undo: "Undone by the judge",
  cancelled: "Match cancelled",
  reset_by_correction: "Reset by a correction",
};

type SheetBattle = Pick<BattleRow, "matchId" | "kind" | "side" | "voidedAt" | "voidReason">;

type Labeller = ReturnType<typeof roundLabeller>;

function buildSheet(match: Match, names: Map<string, string>, labelOf: Labeller, rows: SheetBattle[], withVoided: boolean): MatchSheet {
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? `#${id}`) : "TBD");
  const players = { 1: nameOf(match.player1Id), 2: nameOf(match.player2Id) };
  const active = rows.filter((r) => !r.voidedAt).map((r) => ({ kind: r.kind, side: r.side ?? null }));
  const lines = match.ruleSnapshot && active.length ? sheetLines(match.ruleSnapshot, active, players) : null;

  const entries: SheetEntry[] = [];
  let next = 0;
  for (const row of rows) {
    if (!row.voidedAt) {
      if (lines) entries.push({ type: "battle", line: lines[next++] });
    } else if (withVoided) {
      entries.push({
        type: "voided",
        ...battleWords({ kind: row.kind, side: row.side ?? null }, players),
        reason: VOID_REASONS[row.voidReason ?? ""] ?? "Voided",
      });
    }
  }

  const score = readScore(match.scores);
  return {
    id: match.id,
    round: labelOf(match),
    identifier: match.identifier,
    players,
    winner: !match.winnerId ? null : match.winnerId === match.player1Id ? 1 : match.winnerId === match.player2Id ? 2 : null,
    score,
    recorded: Boolean(lines),
    entries,
  };
}

async function tournamentContext(tournamentId: string, format: { tournamentType: string; groupStageType: string | null }) {
  const [rounds, people] = await Promise.all([
    db.select(labelColumns).from(matches).where(eq(matches.tournamentId, tournamentId)),
    db.select({ id: participants.id, name: participants.name }).from(participants).where(eq(participants.tournamentId, tournamentId)),
  ]);
  return { labelOf: roundLabeller(format, rounds), names: new Map(people.map((p) => [p.id, p.name])) };
}

const battleColumns = { matchId: battles.matchId, kind: battles.kind, side: battles.side, voidedAt: battles.voidedAt, voidReason: battles.voidReason };

/** One match's sheet for its organizer, including the battles that were undone. */
export async function organizerSheet(organizerId: string, matchId: string): Promise<MatchSheet | null> {
  const [found] = await db
    .select({ match: matches, tournamentType: tournaments.tournamentType, groupStageType: tournaments.groupStageType })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(and(eq(matches.id, matchId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  if (!found) return null;

  const [{ labelOf, names }, rows] = await Promise.all([
    tournamentContext(found.match.tournamentId, found),
    db.select(battleColumns).from(battles).where(eq(battles.matchId, matchId)).orderBy(asc(battles.seq)),
  ]);
  return buildSheet(found.match, names, labelOf, rows, true);
}

/**
 * The finished matches of one player, latest first, with the battles that count. Nothing about
 * matches the player wasn't in, and nothing that was undone.
 */
export async function playerSheets(slug: string, playerId: string): Promise<MatchSheet[]> {
  const [tournament] = await db
    .select({ id: tournaments.id, tournamentType: tournaments.tournamentType, groupStageType: tournaments.groupStageType })
    .from(tournaments)
    .where(eq(tournaments.publicSlug, slug))
    .limit(1);
  if (!tournament) return [];

  const own = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.tournamentId, tournament.id),
        eq(matches.state, "complete"),
        // A Swiss bye was never played.
        eq(matches.bye, false),
        or(eq(matches.player1Id, playerId), eq(matches.player2Id, playerId)),
      ),
    )
    .orderBy(desc(matches.playOrder));
  if (own.length === 0) return [];

  const [{ labelOf, names }, rows] = await Promise.all([
    tournamentContext(tournament.id, tournament),
    db
      .select(battleColumns)
      .from(battles)
      .where(inArray(battles.matchId, own.map((m) => m.id)))
      .orderBy(asc(battles.seq)),
  ]);
  return own.map((match) => ({
    ...buildSheet(match, names, labelOf, rows.filter((r) => r.matchId === match.id), false),
    mine: match.player1Id === playerId ? 1 : 2,
  }));
}

/** The score players read, player 1 first: the points of a one-set match, the sets won otherwise ("4-1,2-4,4-3" is 2–1). */
export function readScore(scores: string | null): { 1: number; 2: number } | null {
  const sets = (scores ?? "").split(",").map((set) => /^(\d+)-(\d+)$/.exec(set.trim()));
  if (!scores || sets.some((set) => !set)) return null;
  const points = sets.map((set) => [Number(set![1]), Number(set![2])] as const);
  if (points.length === 1) return { 1: points[0][0], 2: points[0][1] };
  return { 1: points.filter(([a, b]) => a > b).length, 2: points.filter(([a, b]) => b > a).length };
}
