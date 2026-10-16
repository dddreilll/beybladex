import { finalStageRounds, roundContext, roundLabeller } from "@/lib/challonge/map";
import type { Stage } from "@/lib/challonge/support";

// Shapes the stored bracket into what the control room shows: the queue, who is waiting, results.

type MatchRow = {
  id: string;
  identifier: string;
  round: number;
  suggestedPlayOrder: number | null;
  /** Both are absent from a tournament with one stage. */
  stage?: Stage;
  groupNumber?: number | null;
  state: string;
  player1ChallongeId: string | null;
  player2ChallongeId: string | null;
  winnerChallongeId: string | null;
  scores: string | null;
  underwayAt: Date | null;
  stadiumId?: string | null;
  callStatus?: "none" | "on_deck" | "called" | "playing";
  calledAt?: Date | null;
  callCount?: number;
  held?: boolean;
};

type ParticipantRow = { challongeId: string; name: string; seed: number | null };

export type QueueMatch = {
  id: string;
  /** Play-order number plus the letter Challonge shows on its bracket, e.g. "M18 · R". */
  label: string;
  identifier: string;
  roundLabel: string;
  playOrder: number | null;
  state: string;
  player1: string;
  player2: string;
  winner: string | null;
  winnerSlot: 1 | 2 | null;
  scores: string | null;
  underway: boolean;
  stadiumId: string | null;
  callStatus: "none" | "on_deck" | "called" | "playing";
  calledAt: Date | null;
  callCount: number;
  held: boolean;
};

export type ControlRoom = {
  /** Open matches with both players, in Challonge's suggested play order. */
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
  const names = new Map(participantRows.map((p) => [p.challongeId, p.name]));
  const tournament = typeof format === "string" ? { tournamentType: format } : format;
  // The final stage's rounds: the Grand Finals are there, whatever a group stage before it played.
  const ctx = roundContext(tournament.tournamentType, finalStageRounds(matchRows));
  const labelOf = roundLabeller(tournament, matchRows);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? `#${id}`) : TBD);
  // Play order starts again in every group, so the groups take turns: all first matches, then all second ones.
  const byOrder = (a: MatchRow, b: MatchRow) =>
    (a.suggestedPlayOrder ?? Number.MAX_SAFE_INTEGER) - (b.suggestedPlayOrder ?? Number.MAX_SAFE_INTEGER) ||
    (a.groupNumber ?? 0) - (b.groupNumber ?? 0) ||
    a.identifier.localeCompare(b.identifier);

  // Double elimination has two Grand Finals matches in the last round; the later one is the reset.
  const finals = matchRows.filter((m) => m.stage !== "group" && m.round === ctx.maxRound).sort(byOrder);
  const isReset = (m: MatchRow) =>
    ctx.tournamentType.toLowerCase().includes("double") && finals.length > 1 && finals.at(-1)?.id === m.id;

  const toQueue = (m: MatchRow): QueueMatch => ({
    id: m.id,
    label: m.suggestedPlayOrder != null ? `M${m.suggestedPlayOrder} · ${m.identifier}` : m.identifier,
    identifier: m.identifier,
    roundLabel: isReset(m) ? "Grand Finals reset" : labelOf(m),
    playOrder: m.suggestedPlayOrder,
    state: m.state,
    player1: nameOf(m.player1ChallongeId),
    player2: nameOf(m.player2ChallongeId),
    winner: m.winnerChallongeId ? nameOf(m.winnerChallongeId) : null,
    winnerSlot: !m.winnerChallongeId
      ? null
      : m.winnerChallongeId === m.player1ChallongeId
        ? 1
        : m.winnerChallongeId === m.player2ChallongeId
          ? 2
          : null,
    scores: m.scores,
    underway: Boolean(m.underwayAt),
    stadiumId: m.stadiumId ?? null,
    callStatus: m.callStatus ?? "none",
    calledAt: m.calledAt ?? null,
    callCount: m.callCount ?? 0,
    held: m.held ?? false,
  });

  const sorted = [...matchRows].sort(byOrder);
  const hasBoth = (m: MatchRow) => Boolean(m.player1ChallongeId && m.player2ChallongeId);
  const hasOne = (m: MatchRow) => Boolean(m.player1ChallongeId) !== Boolean(m.player2ChallongeId);

  const completed = sorted.filter((m) => m.state === "complete").reverse();
  return {
    ready: sorted.filter((m) => m.state === "open" && hasBoth(m)).map(toQueue),
    waiting: sorted.filter((m) => m.state === "pending" && hasOne(m)).map(toQueue),
    completed: completed.map(toQueue),
    totals: { matches: matchRows.length, completed: completed.length },
  };
}
