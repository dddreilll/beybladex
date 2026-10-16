import { groupLabel } from "@/lib/challonge/map";
import { isElimination, stagePhase, stageType, type Stage } from "@/lib/challonge/support";

// Running standings for the formats where everyone keeps playing: a round robin, Swiss, every
// group of a two-stage tournament, and a final stage that is a round robin or Swiss. Worked out
// from the stored results, with no Challonge request. They go by record alone: Challonge has its
// own tie-breaks (Buchholz in Swiss, among others) and places everyone at Finalize, so these are
// labelled unofficial wherever they are shown.

export type StandingRow = {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  /** Complete without a winner: a tie entered on challonge.com. BXQ itself never sends one. */
  ties: number;
  /** 1 for the best record; players with the same record share a place (1, 2, 2, 4). */
  rank: number;
  /** "2-1", or "2-1-1" with ties. */
  record: string;
  /** Whether the player went on to the final stage; null until a group stage has ended, and outside one. */
  advanced: boolean | null;
  /** Dropped out on Challonge. */
  dropped: boolean;
};

export type StandingsTable = {
  /** "all", "final", or "group-1"; "group-0" when the groups couldn't be told apart. */
  key: string;
  title: string;
  /** Whether its stage is the one being played (the groups until the final stage starts). */
  current: boolean;
  rows: StandingRow[];
};

type StandingsMatch = {
  stage: Stage;
  groupNumber: number | null;
  state: string;
  player1ChallongeId: string | null;
  player2ChallongeId: string | null;
  winnerChallongeId: string | null;
};
type StandingsPlayer = { challongeId: string; name: string; active: boolean; advanced: boolean | null };
type StandingsFormat = { tournamentType: string; groupStage: boolean; groupStageType?: string | null; state: string };

/** The standings of these matches' players; everyone in `extra` too, with no match played. */
function table(matches: StandingsMatch[], players: Map<string, StandingsPlayer>, extra: string[] = []): StandingRow[] {
  const counts = new Map<string, { wins: number; losses: number; ties: number }>();
  const tally = (id: string | null) => {
    if (!id) return null;
    if (!counts.has(id)) counts.set(id, { wins: 0, losses: 0, ties: 0 });
    return counts.get(id)!;
  };
  for (const id of extra) tally(id);
  for (const m of matches) {
    const [a, b] = [tally(m.player1ChallongeId), tally(m.player2ChallongeId)];
    if (!a || !b || m.state !== "complete") continue;
    if (!m.winnerChallongeId) {
      a.ties++;
      b.ties++;
    } else if (m.winnerChallongeId === m.player1ChallongeId) {
      a.wins++;
      b.losses++;
    } else if (m.winnerChallongeId === m.player2ChallongeId) {
      b.wins++;
      a.losses++;
    }
  }

  const points = (c: { wins: number; ties: number }) => c.wins + c.ties / 2;
  const rows = [...counts].map(([playerId, c]) => {
    const player = players.get(playerId);
    return {
      playerId,
      name: player?.name ?? `#${playerId}`,
      ...c,
      rank: 0,
      record: `${c.wins}-${c.losses}${c.ties ? `-${c.ties}` : ""}`,
      advanced: player?.advanced ?? null,
      dropped: player ? !player.active : false,
    };
  });
  rows.sort((x, y) => points(y) - points(x) || x.losses - y.losses || x.name.localeCompare(y.name));
  rows.forEach((row, i) => {
    const before = rows[i - 1];
    row.rank = before && points(before) === points(row) && before.losses === row.losses ? before.rank : i + 1;
  });
  return rows;
}

/**
 * Every standings table of a tournament, the stage being played first; empty for a single or
 * double elimination bracket without groups, where a bracket says more than a record.
 */
export function standingsTables(format: StandingsFormat, matches: StandingsMatch[], players: StandingsPlayer[]): StandingsTable[] {
  const byId = new Map(players.map((p) => [p.challongeId, p]));
  const phase = stagePhase(format);

  if (!phase) {
    if (isElimination(format.tournamentType)) return [];
    // A Swiss round can leave a player without a match; they still have a place.
    return [{ key: "all", title: "Standings", current: true, rows: table(matches, byId, players.map((p) => p.challongeId)) }];
  }

  const groupMatches = matches.filter((m) => m.stage === "group");
  const numbers = [...new Set(groupMatches.map((m) => m.groupNumber ?? 0))].sort((a, b) => a - b);
  const groups: StandingsTable[] = numbers.map((n) => ({
    key: `group-${n}`,
    title: groupLabel(n || null),
    current: phase !== "final",
    rows: table(
      groupMatches.filter((m) => (m.groupNumber ?? 0) === n),
      byId,
    ),
  }));

  const finalMatches = matches.filter((m) => m.stage === "final");
  if (phase !== "final" || isElimination(stageType(format, "final")) || finalMatches.length === 0) return groups;
  // Who didn't advance has no place here: the final stage is its own competition.
  const final: StandingsTable = { key: "final", title: "Final stage", current: true, rows: table(finalMatches, byId) };
  return [final, ...groups];
}
