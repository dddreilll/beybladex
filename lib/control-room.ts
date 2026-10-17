import { matchCode, roundLabeller } from "@/lib/tournament/labels";
import type { Stage } from "@/lib/tournament/format";

// Shapes the stored bracket into what the control room shows: the queue, who is waiting, results.

type MatchRow = {
  id: string;
  number: number | null;
  round: number;
  playOrder: number | null;
  /** Both are absent from a tournament with one stage. */
  stage?: Stage;
  groupNumber?: number | null;
  state: string;
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  scores: string | null;
  section?: "losers" | "grand_final" | null;
  thirdPlace?: boolean;
  ifNeeded?: boolean;
  /** A Swiss bye: nothing to play, so it is left out. */
  bye?: boolean;
  forfeit?: boolean;
  stadiumId?: string | null;
  callStatus?: "none" | "on_deck" | "called" | "playing";
  calledAt?: Date | null;
  callCount?: number;
  held?: boolean;
};

type ParticipantRow = { id: string; name: string; seed: number | null };

export type QueueMatch = {
  id: string;
  /** The match's number in its tournament, e.g. "M18". */
  label: string;
  number: number | null;
  roundLabel: string;
  playOrder: number | null;
  state: string;
  player1: string;
  player2: string;
  winner: string | null;
  winnerSlot: 1 | 2 | null;
  scores: string | null;
  /** Won because the other player dropped out. */
  forfeit: boolean;
  /** Being played at its stadium. */
  underway: boolean;
  stadiumId: string | null;
  callStatus: "none" | "on_deck" | "called" | "playing";
  calledAt: Date | null;
  callCount: number;
  held: boolean;
};

export type ControlRoom = {
  /** Open matches with both players, in play order. */
  ready: QueueMatch[];
  /** Pending matches that already have one player waiting for an opponent. */
  waiting: QueueMatch[];
  completed: QueueMatch[];
  totals: { matches: number; completed: number };
};

const TBD = "TBD";

/** `format` is the tournament: its type and, in a two-stage one, the type of its groups. */
export function buildControlRoom(
  format: string | { tournamentType: string; groupStageType?: string | null },
  participantRows: ParticipantRow[],
  matchRows: MatchRow[],
): ControlRoom {
  const names = new Map(participantRows.map((p) => [p.id, p.name]));
  const tournament = typeof format === "string" ? { tournamentType: format } : format;
  const labelOf = roundLabeller(tournament, matchRows);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? `#${id}`) : TBD);
  // Play order starts again in every group, so the groups take turns: all first matches, then all second ones.
  const byOrder = (a: MatchRow, b: MatchRow) =>
    (a.playOrder ?? Number.MAX_SAFE_INTEGER) - (b.playOrder ?? Number.MAX_SAFE_INTEGER) ||
    (a.groupNumber ?? 0) - (b.groupNumber ?? 0) ||
    (a.number ?? 0) - (b.number ?? 0);

  const toQueue = (m: MatchRow): QueueMatch => ({
    id: m.id,
    label: matchCode(m.number),
    number: m.number,
    roundLabel: labelOf(m),
    playOrder: m.playOrder,
    state: m.state,
    player1: nameOf(m.player1Id),
    player2: nameOf(m.player2Id),
    winner: m.winnerId ? nameOf(m.winnerId) : null,
    winnerSlot: !m.winnerId
      ? null
      : m.winnerId === m.player1Id
        ? 1
        : m.winnerId === m.player2Id
          ? 2
          : null,
    scores: m.scores,
    forfeit: m.forfeit ?? false,
    underway: m.callStatus === "playing",
    stadiumId: m.stadiumId ?? null,
    callStatus: m.callStatus ?? "none",
    calledAt: m.calledAt ?? null,
    callCount: m.callCount ?? 0,
    held: m.held ?? false,
  });

  const played = matchRows.filter((m) => !m.bye);
  const sorted = [...played].sort(byOrder);
  const hasBoth = (m: MatchRow) => Boolean(m.player1Id && m.player2Id);
  const hasOne = (m: MatchRow) => Boolean(m.player1Id) !== Boolean(m.player2Id);

  const completed = sorted.filter((m) => m.state === "complete").reverse();
  return {
    ready: sorted.filter((m) => m.state === "open" && hasBoth(m)).map(toQueue),
    waiting: sorted.filter((m) => m.state === "pending" && hasOne(m)).map(toQueue),
    completed: completed.map(toQueue),
    totals: { matches: played.length, completed: completed.length },
  };
}
