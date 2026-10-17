import type { Format } from "@/lib/bracket/types";

// What a tournament is and where it stands. Pure, so the Desk, the board and the tests share it.

export type { Format };

/** A two-stage tournament has both; any other tournament is all `final`. */
export type Stage = "group" | "final";

/**
 * Where a tournament stands. `pending` until it is started. A two-stage tournament then plays its
 * `group_stage`, waits `between_stages` once the group stage has ended (so the organizer sees who
 * goes through), and is `underway` in its final stage, like a tournament with one stage.
 * `complete` once finished: the places are fixed and no result can change.
 */
export type TournamentState = "pending" | "group_stage" | "between_stages" | "underway" | "complete";

export type StagePhase = "groups" | "between" | "final";

export const FORMATS: Format[] = ["single_elimination", "double_elimination", "round_robin", "swiss"];

/** Accepts both "double_elimination" and the older "double elimination". */
const normalize = (format: string) => format.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** A bracket, where a result moves its players into later matches and a corrected winner can erase them. */
export const isElimination = (format: string) => ["single_elimination", "double_elimination"].includes(normalize(format));

/** Swiss gets its rounds one at a time: the next is paired once the last result of a round is in. */
export const isSwiss = (format: string) => normalize(format) === "swiss";

/** The format a match is played in: the groups' in a group stage, the tournament's otherwise. */
export const stageType = (format: { tournamentType: string; groupStageType?: string | null }, stage: Stage) =>
  stage === "group" ? (format.groupStageType ?? format.tournamentType) : format.tournamentType;

/** Where a two-stage tournament is; null for a tournament with one stage, and before it starts. */
export function stagePhase(tournament: { groupStage: boolean; state: string }): StagePhase | null {
  if (!tournament.groupStage || tournament.state === "pending") return null;
  if (tournament.state === "group_stage") return "groups";
  if (tournament.state === "between_stages") return "between";
  return "final";
}

export const isFinished = (state: string) => state === "complete";

const NAMES: Record<Format, string> = {
  single_elimination: "Single elimination",
  double_elimination: "Double elimination",
  round_robin: "Round robin",
  swiss: "Swiss",
};

/** "Double elimination", for the screens. */
export const formatName = (format: string) => NAMES[normalize(format) as Format] ?? format;
