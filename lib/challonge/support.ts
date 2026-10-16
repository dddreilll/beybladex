import { APP_NAME } from "@/lib/config";

// Which Challonge formats the app can run, and how they differ where the app has to know.
// Its pad and reporting assume one-against-one matches. Elimination brackets, round robin and
// Swiss are handled, and so is a two-stage tournament whose groups are any of those four and whose
// final stage is a bracket. Every other format is refused before it is imported: it would load
// without an error and then go wrong (docs/rfc-001-architecture.md, spikes S7 to S19).

/** A two-stage tournament has both; any other tournament is all `final`. */
export type Stage = "group" | "final";

/** In a two-stage tournament `tournamentType` is the format of the final stage, and `groupStageType` that of the groups. */
export type TournamentFormat = { tournamentType: string; groupStage: boolean; groupStageType?: string | null };

export type FormatSupport = { supported: true } | { supported: false; reason: string };

const ELIMINATION_TYPES = ["single elimination", "double elimination"];
const SUPPORTED_TYPES = [...ELIMINATION_TYPES, "round robin", "swiss"];
// Challonge's states from the start of the final stage on ("ended" is the older name for "complete").
const FINAL_STAGE_STATES = ["underway", "awaiting_review", "complete", "ended"];

const normalize = (tournamentType: string) => tournamentType.trim().toLowerCase().replace(/[_-]+/g, " ");

/**
 * Whether the format is a bracket, where a result moves its players into later matches and a
 * corrected winner can erase them. In round robin and Swiss a result changes that match only
 * (spike S7).
 */
export const isElimination = (tournamentType: string) => ELIMINATION_TYPES.includes(normalize(tournamentType));

/**
 * Whether the format gets its rounds one at a time: Challonge pairs the next round once the last
 * result of the current one is in, a moment after it has answered that result (spikes S9 to S11).
 */
export const isSwiss = (tournamentType: string) => normalize(tournamentType) === "swiss";

/** The format a match is played in: the groups' in a group stage, the tournament's otherwise. */
export const stageType = (format: Pick<TournamentFormat, "tournamentType" | "groupStageType">, stage: Stage) =>
  stage === "group" ? (format.groupStageType ?? format.tournamentType) : format.tournamentType;

export type StagePhase = "groups" | "between" | "final";

/**
 * Where a two-stage tournament is: its groups being played, the group stage ended with the final
 * stage not started, or the final stage. Null for a tournament with one stage.
 */
export function stagePhase(tournament: { groupStage: boolean; state: string }): StagePhase | null {
  if (!tournament.groupStage) return null;
  if (tournament.state === "group_stages_finalized") return "between";
  return FINAL_STAGE_STATES.includes(tournament.state) ? "final" : "groups";
}

/** Whether a tournament can be imported and resynced; `reason` is written for the organizer. */
export function formatSupport(format: TournamentFormat): FormatSupport {
  const type = normalize(format.tournamentType);
  const runs = "It runs single elimination, double elimination, round robin and Swiss.";
  if (type === "free for all") {
    return { supported: false, reason: `${APP_NAME} can't run free-for-all tournaments: its matches are one player against one.` };
  }
  if (!SUPPORTED_TYPES.includes(type)) {
    return { supported: false, reason: `${APP_NAME} doesn't run this format${type ? ` (${type})` : ""} yet. ${runs}` };
  }
  if (format.groupStage) {
    const groups = normalize(format.groupStageType ?? "");
    if (!ELIMINATION_TYPES.includes(type)) {
      return { supported: false, reason: `${APP_NAME} runs a two-stage tournament only when its final stage is single or double elimination (this one's is ${type}).` };
    }
    if (!groups) {
      return { supported: false, reason: `${APP_NAME} can't run this two-stage tournament: Challonge didn't say what its groups play.` };
    }
    if (!SUPPORTED_TYPES.includes(groups)) {
      return { supported: false, reason: `${APP_NAME} doesn't run groups of this format (${groups}) yet. Its groups can be single elimination, double elimination, round robin or Swiss.` };
    }
  }
  return { supported: true };
}

/** Thrown by import and resync for a format the app can't run. The message is the organizer-facing reason. */
export class UnsupportedFormatError extends Error {
  name = "UnsupportedFormatError";
}

export type GrandFinals = "reset" | "single" | "skip";

/** What the organizer reviews before importing. The four options are null when Challonge didn't send them. */
export type TournamentPreview = {
  challongeId: string;
  challongeUrl: string;
  name: string;
  state: string;
  /** The format of the final stage when there are `groups`. */
  tournamentType: string;
  participantsCount: number;
  /** The group stage of a two-stage tournament; `type` is null when Challonge didn't say what the groups play. */
  groups: { type: string | null; size: number | null; advance: number | null } | null;
  grandFinals: GrandFinals | null;
  thirdPlaceMatch: boolean | null;
  /** Round robin: how many times each pair of players meets. */
  iterations: number | null;
  /** Swiss: how many rounds are played. */
  swissRounds: number | null;
};

const GRAND_FINALS: Record<GrandFinals, string> = {
  reset: "1 or 2 matches (a reset if the losers-side finalist wins the first)",
  single: "1 match, no reset",
  skip: "None",
};

const TIMES: Record<number, string> = { 1: "Once", 2: "Twice" };

/** A group stage in a line: "Round robin, groups of 4, top 2 advance". */
export function groupStageSummary(groups: NonNullable<TournamentPreview["groups"]>): string {
  const type = normalize(groups.type ?? "");
  return [
    type ? type.charAt(0).toUpperCase() + type.slice(1) : "Groups",
    ...(groups.size ? [`groups of ${groups.size}`] : []),
    ...(groups.advance ? [`top ${groups.advance} advance`] : []),
  ].join(", ");
}

/** The format options worth checking before an event. Empty when the format has none, or Challonge didn't send them. */
export function formatOptions(
  preview: Pick<TournamentPreview, "tournamentType" | "grandFinals" | "thirdPlaceMatch" | "iterations" | "swissRounds">,
): { label: string; value: string }[] {
  const type = normalize(preview.tournamentType);
  if (type === "double elimination" && preview.grandFinals) {
    return [{ label: "Grand finals", value: GRAND_FINALS[preview.grandFinals] }];
  }
  if (type === "single elimination" && preview.thirdPlaceMatch !== null) {
    return [{ label: "Third-place match", value: preview.thirdPlaceMatch ? "Yes" : "No" }];
  }
  if (type === "round robin" && preview.iterations) {
    return [{ label: "Plays each opponent", value: TIMES[preview.iterations] ?? `${preview.iterations} times` }];
  }
  if (type === "swiss" && preview.swissRounds) {
    return [{ label: "Rounds", value: String(preview.swissRounds) }];
  }
  return [];
}
