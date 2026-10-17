import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { isFinished } from "@/lib/tournament/format";
import { roundLabeller } from "@/lib/tournament/labels";
import { db } from "@/lib/db";
import { battles, matches, participants, stadiums, tournaments } from "@/lib/db/schema";
import { playerStatus, type PlayerSnapshot } from "@/lib/player-status";
import { lastBattleText } from "@/lib/scoring/describe";
import { scoreMatch } from "@/lib/scoring/engine";
import { standingsTables } from "@/lib/standings";

// Data for the call board and player page (/t/<slug>). Names and match status only: nothing here
// identifies the organizer. Who may read it is decided in lib/access.ts: an approved screen gets
// the whole board, a signed-in player gets their own match.

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
export type BoardStanding = { id: string; name: string; rank: number };
/** Running standings on the board, by record: the best rows, and how many more there are. Not official. */
export type BoardTable = {
  title: string;
  rows: { id: string; rank: number; name: string; record: string; advanced: boolean | null }[];
  more: number;
};
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
  /** Final placements, best first, once the tournament is finalized; null until then. */
  standings: BoardStanding[] | null;
  /**
   * Running standings of the stage being played, once a match of it has a result, until the
   * tournament is finalized. Empty for a bracket, which has none (lib/standings.ts).
   */
  tables: BoardTable[];
};

/** How many rows of a standings table fit the board. */
const BOARD_TABLE_ROWS = 10;

type LiveSource = Pick<typeof matches.$inferSelect, "id" | "callStatus" | "ruleSnapshot" | "player1Id" | "player2Id">;
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
      lastBattle = lastBattleText(m.ruleSnapshot, mine, { 1: nameOf(m.player1Id), 2: nameOf(m.player2Id) });
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
  return (await loadBoard(slug))?.snapshot ?? null;
}

/** One player's own view of the board: their match, or their placement once it's over. */
export async function playerSnapshot(slug: string, playerId: string): Promise<PlayerSnapshot | null> {
  const board = await loadBoard(slug);
  const me = board?.names.get(playerId);
  if (!board || me === undefined) return null;
  return {
    version: board.snapshot.version,
    tournament: { name: board.snapshot.tournament.name },
    me: { id: playerId, name: me },
    status: playerStatus(board.snapshot, playerId, board.advanced.get(playerId)),
    results: board.finished
      .filter((m) => m.player1Id === playerId || m.player2Id === playerId)
      .map((m) => `${m.identifier}:${m.scores}:${m.winnerId}`)
      .sort()
      .join("|"),
  };
}

/** What the sign-in screen shows before a player has proved who they are: names only. */
export async function signInInfo(slug: string): Promise<{ tournament: string; players: BoardPlayer[] } | null> {
  const [tournament] = await db
    .select({ id: tournaments.id, name: tournaments.name })
    .from(tournaments)
    .where(eq(tournaments.publicSlug, slug))
    .limit(1);
  if (!tournament) return null;
  const rows = await db
    .select({ id: participants.id, name: participants.name })
    .from(participants)
    .where(and(eq(participants.tournamentId, tournament.id), eq(participants.active, true)))
    .orderBy(asc(participants.name));
  return { tournament: tournament.name, players: rows };
}

type FinishedMatch = Pick<typeof matches.$inferSelect, "identifier" | "player1Id" | "player2Id" | "scores" | "winnerId">;

type Board = {
  snapshot: BoardSnapshot;
  names: Map<string, string>;
  /** Who went on to the final stage, once a group stage has ended. */
  advanced: Map<string, boolean | null>;
  finished: FinishedMatch[];
};

async function loadBoard(slug: string): Promise<Board | null> {
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

  const names = new Map(participantRows.map((p) => [p.id, p.name]));
  const live = await liveMatchInfo(matchRows, names);
  const player = (id: string | null): BoardPlayer | null => (id ? { id, name: names.get(id) ?? `#${id}` } : null);
  const labelOf = roundLabeller(tournament, matchRows);

  const toBoard = (m: (typeof matchRows)[number]): BoardMatch => {
    const playing = m.callStatus === "playing" ? live.get(m.id) : undefined;
    const liveScore = playing?.score ?? null;
    const round = labelOf(m);
    return {
      id: m.id,
      label: `${round} · ${m.identifier}`,
      round,
      matchName: m.playOrder != null ? `Match ${m.playOrder} · ${m.identifier}` : `Match ${m.identifier}`,
      player1: player(m.player1Id),
      player2: player(m.player2Id),
      status: m.callStatus,
      liveScore,
      lastBattle: playing?.lastBattle ?? null,
      calledAt: m.calledAt?.toISOString() ?? null,
      callNumber: m.callCount,
    };
  };

  // Play order starts again in every group; the groups then take turns, as in the stadium queue.
  const byOrder = (a: (typeof matchRows)[number], b: (typeof matchRows)[number]) =>
    (a.playOrder ?? Number.MAX_SAFE_INTEGER) - (b.playOrder ?? Number.MAX_SAFE_INTEGER) ||
    (a.groupNumber ?? 0) - (b.groupNumber ?? 0);

  // Several rounds are usually in play at once; the board shows the one called most recently.
  const latestCalled = matchRows
    .filter((m) => m.calledAt && m.callStatus !== "none")
    .sort((a, b) => b.calledAt!.getTime() - a.calledAt!.getTime())[0];

  const ranked = participantRows
    .filter((p) => p.finalRank != null)
    .sort((a, b) => a.finalRank! - b.finalRank! || a.name.localeCompare(b.name));

  const snapshot: BoardSnapshot = {
    version: tournament.boardVersion,
    tournament: { name: tournament.name, state: tournament.state },
    currentRound: latestCalled ? labelOf(latestCalled) : null,
    stadiums: stadiumRows.map((s) => {
      const here = matchRows.filter((m) => m.stadiumId === s.id);
      const now = here.find((m) => m.callStatus === "called" || m.callStatus === "playing");
      const next = here.find((m) => m.callStatus === "on_deck");
      return { id: s.id, name: s.name, now: now ? toBoard(now) : null, next: next ? toBoard(next) : null };
    }),
    queue: matchRows
      .filter((m) => m.callStatus === "none" && !m.held && m.state === "open" && m.player1Id && m.player2Id)
      .sort(byOrder)
      .map(toBoard),
    waiting: matchRows
      .filter((m) => m.state === "pending" && Boolean(m.player1Id) !== Boolean(m.player2Id))
      .sort(byOrder)
      .map(toBoard),
    standings:
      isFinished(tournament.state) && ranked.length
        ? ranked.map((p) => ({ id: p.id, name: p.name, rank: p.finalRank! }))
        : null,
    tables: isFinished(tournament.state)
      ? []
      : standingsTables(tournament, matchRows, participantRows)
          .filter((t) => t.current && t.rows.some((r) => r.wins + r.losses > 0))
          .map((t) => ({
            title: t.title,
            rows: t.rows.slice(0, BOARD_TABLE_ROWS).map((r) => ({ id: r.playerId, rank: r.rank, name: r.name, record: r.record, advanced: r.advanced })),
            more: Math.max(0, t.rows.length - BOARD_TABLE_ROWS),
          })),
  };
  const advanced = new Map(participantRows.map((p) => [p.id, p.advanced]));
  return { snapshot, names, advanced, finished: matchRows.filter((m) => m.state === "complete" && !m.bye) };
}
