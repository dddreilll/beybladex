import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { roundContext, roundLabel } from "@/lib/challonge/map";
import { db } from "@/lib/db";
import { battles, matches, participants, stadiums, tournaments } from "@/lib/db/schema";
import { lastBattleText } from "@/lib/scoring/describe";
import { scoreMatch } from "@/lib/scoring/engine";

// Public data for the call board and player page (/t/<slug>). Names and match status only:
// nothing here identifies the organizer or exposes Challonge ids.

export const SLUG_PATTERN = /^[a-f0-9]{16}$/;

export type BoardPlayer = { id: string; name: string };
export type BoardMatch = {
  id: string;
  label: string;
  /** The round on its own ("Winners R2") and the match's name ("Match 14 · K"), for the call banner. */
  round: string;
  matchName: string;
  player1: BoardPlayer | null;
  player2: BoardPlayer | null;
  status: "none" | "on_deck" | "called" | "playing";
  /** Current set points while the match is being scored, e.g. "2–1". */
  liveScore: string | null;
  /** The most recent battle while the match is being scored, e.g. "Alex · Xtreme +3". */
  lastBattle: string | null;
  calledAt: string | null;
  /** 1 for the first call, 2+ after the organizer recalled the players. */
  callNumber: number;
};
export type BoardStadium = { id: string; name: string; now: BoardMatch | null; next: BoardMatch | null };
export type BoardSnapshot = {
  version: number;
  tournament: { name: string; state: string };
  /** Round of the match called most recently, shown beside the tournament name. */
  currentRound: string | null;
  stadiums: BoardStadium[];
  /** Ready but not yet assigned, in play order. */
  queue: BoardMatch[];
  /** One player through, waiting for an opponent. */
  waiting: BoardMatch[];
  players: BoardPlayer[];
};

type LiveSource = Pick<typeof matches.$inferSelect, "id" | "callStatus" | "ruleSnapshot" | "player1ChallongeId" | "player2ChallongeId">;
export type LiveInfo = { score: string | null; battles: number; lastBattle: string | null };

/**
 * For matches at a stadium: how many battles are recorded and, once scoring has started,
 * the current set's points (e.g. "2–1") and what the latest battle was.
 */
export async function liveMatchInfo(rows: LiveSource[], names: Map<string, string>): Promise<Map<string, LiveInfo>> {
  const current = rows.filter((m) => m.callStatus === "playing" || m.callStatus === "called");
  const info = new Map<string, LiveInfo>();
  if (current.length === 0) return info;
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? `#${id}`) : "TBD");

  const recorded = await db
    .select({ matchId: battles.matchId, kind: battles.kind, side: battles.side })
    .from(battles)
    .where(and(inArray(battles.matchId, current.map((m) => m.id)), isNull(battles.voidedAt)))
    .orderBy(asc(battles.seq));

  for (const m of current) {
    const mine = recorded.filter((b) => b.matchId === m.id).map((b) => ({ kind: b.kind, side: b.side ?? null }));
    let score: string | null = null;
    let lastBattle: string | null = null;
    if (m.ruleSnapshot && mine.length) {
      try {
        const result = scoreMatch(m.ruleSnapshot, mine);
        const set = result.sets[result.currentSet];
        score = `${set[1]}–${set[2]}`;
      } catch {}
      lastBattle = lastBattleText(m.ruleSnapshot, mine, { 1: nameOf(m.player1ChallongeId), 2: nameOf(m.player2ChallongeId) });
    }
    info.set(m.id, { score, battles: mine.length, lastBattle });
  }
  return info;
}

export async function boardVersion(slug: string): Promise<number | null> {
  const [row] = await db
    .select({ version: tournaments.boardVersion })
    .from(tournaments)
    .where(eq(tournaments.publicSlug, slug))
    .limit(1);
  return row?.version ?? null;
}

export async function boardSnapshot(slug: string): Promise<BoardSnapshot | null> {
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.publicSlug, slug)).limit(1);
  if (!tournament) return null;

  const [stadiumRows, matchRows, participantRows] = await Promise.all([
    db
      .select()
      .from(stadiums)
      .where(and(eq(stadiums.tournamentId, tournament.id), eq(stadiums.active, true)))
      .orderBy(asc(stadiums.position)),
    db.select().from(matches).where(eq(matches.tournamentId, tournament.id)),
    db.select().from(participants).where(eq(participants.tournamentId, tournament.id)),
  ]);

  const names = new Map(participantRows.map((p) => [p.challongeId, p.name]));
  const live = await liveMatchInfo(matchRows, names);
  const player = (id: string | null): BoardPlayer | null => (id ? { id, name: names.get(id) ?? `#${id}` } : null);
  const ctx = roundContext(tournament.tournamentType, matchRows.map((m) => m.round));

  const toBoard = (m: (typeof matchRows)[number]): BoardMatch => {
    const playing = m.callStatus === "playing" ? live.get(m.id) : undefined;
    const liveScore = playing?.score ?? null;
    const round = roundLabel(m.round, ctx);
    return {
      id: m.id,
      label: `${round} · ${m.identifier}`,
      round,
      matchName: m.suggestedPlayOrder != null ? `Match ${m.suggestedPlayOrder} · ${m.identifier}` : `Match ${m.identifier}`,
      player1: player(m.player1ChallongeId),
      player2: player(m.player2ChallongeId),
      status: m.callStatus,
      liveScore,
      lastBattle: playing?.lastBattle ?? null,
      calledAt: m.calledAt?.toISOString() ?? null,
      callNumber: m.callCount,
    };
  };

  const byOrder = (a: (typeof matchRows)[number], b: (typeof matchRows)[number]) =>
    (a.suggestedPlayOrder ?? Number.MAX_SAFE_INTEGER) - (b.suggestedPlayOrder ?? Number.MAX_SAFE_INTEGER);

  // Several rounds are usually in play at once; the board shows the one called most recently.
  const latestCalled = matchRows
    .filter((m) => m.calledAt && m.callStatus !== "none")
    .sort((a, b) => b.calledAt!.getTime() - a.calledAt!.getTime())[0];

  return {
    version: tournament.boardVersion,
    tournament: { name: tournament.name, state: tournament.state },
    currentRound: latestCalled ? roundLabel(latestCalled.round, ctx) : null,
    stadiums: stadiumRows.map((s) => {
      const here = matchRows.filter((m) => m.stadiumId === s.id);
      const now = here.find((m) => m.callStatus === "called" || m.callStatus === "playing");
      const next = here.find((m) => m.callStatus === "on_deck");
      return { id: s.id, name: s.name, now: now ? toBoard(now) : null, next: next ? toBoard(next) : null };
    }),
    queue: matchRows
      .filter((m) => m.callStatus === "none" && !m.held && m.state === "open" && m.player1ChallongeId && m.player2ChallongeId)
      .sort(byOrder)
      .map(toBoard),
    waiting: matchRows
      .filter((m) => m.state === "pending" && Boolean(m.player1ChallongeId) !== Boolean(m.player2ChallongeId))
      .sort(byOrder)
      .map(toBoard),
    players: participantRows
      .filter((p) => p.active)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ id: p.challongeId, name: p.name })),
  };
}
