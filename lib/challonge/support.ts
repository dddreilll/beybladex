import { APP_NAME } from "@/lib/config";

// Which Challonge formats the app can run, and how they differ where the app has to know.
// Its pad and reporting assume one-against-one matches. Elimination brackets and round robin are
// handled; every other format is refused before it is imported: it would load without an error
// and then go wrong (docs/rfc-001-architecture.md, spikes S7 to S16).

export type TournamentFormat = { tournamentType: string; groupStage: boolean };

export type FormatSupport = { supported: true } | { supported: false; reason: string };

const ELIMINATION_TYPES = ["single elimination", "double elimination"];
const SUPPORTED_TYPES = [...ELIMINATION_TYPES, "round robin"];
/** Formats Challonge handles as the app expects, which the app itself isn't adapted to yet. */
const NOT_YET_TYPES: Record<string, string> = { swiss: "Swiss" };

const normalize = (tournamentType: string) => tournamentType.trim().toLowerCase().replace(/[_-]+/g, " ");

/**
 * Whether the format is a bracket, where a result moves its players into later matches and a
 * corrected winner can erase them. In round robin every match exists from the start and a result
 * changes that match only (spike S7).
 */
export const isElimination = (tournamentType: string) => ELIMINATION_TYPES.includes(normalize(tournamentType));

/** Whether a tournament can be imported and resynced; `reason` is written for the organizer. */
export function formatSupport(format: TournamentFormat): FormatSupport {
  const type = normalize(format.tournamentType);
  const runs = "It runs single elimination, double elimination and round robin.";
  if (type === "free for all") {
    return { supported: false, reason: `${APP_NAME} can't run free-for-all tournaments: its matches are one player against one.` };
  }
  if (NOT_YET_TYPES[type]) {
    return { supported: false, reason: `${APP_NAME} doesn't run ${NOT_YET_TYPES[type]} tournaments yet. ${runs}` };
  }
  if (!SUPPORTED_TYPES.includes(type)) {
    return { supported: false, reason: `${APP_NAME} doesn't run this format${type ? ` (${type})` : ""} yet. ${runs}` };
  }
  if (format.groupStage) {
    return { supported: false, reason: `${APP_NAME} doesn't run two-stage tournaments yet (a group stage, then a final stage).` };
  }
  return { supported: true };
}

/** Thrown by import and resync for a format the app can't run. The message is the organizer-facing reason. */
export class UnsupportedFormatError extends Error {
  name = "UnsupportedFormatError";
}

export type GrandFinals = "reset" | "single" | "skip";

/** What the organizer reviews before importing. The three options are null when Challonge didn't send them. */
export type TournamentPreview = {
  challongeId: string;
  challongeUrl: string;
  name: string;
  state: string;
  tournamentType: string;
  participantsCount: number;
  grandFinals: GrandFinals | null;
  thirdPlaceMatch: boolean | null;
  /** Round robin: how many times each pair of players meets. */
  iterations: number | null;
};

const GRAND_FINALS: Record<GrandFinals, string> = {
  reset: "1 or 2 matches (a reset if the losers-side finalist wins the first)",
  single: "1 match, no reset",
  skip: "None",
};

const TIMES: Record<number, string> = { 1: "Once", 2: "Twice" };

/** The format options worth checking before an event. Empty when the format has none, or Challonge didn't send them. */
export function formatOptions(
  preview: Pick<TournamentPreview, "tournamentType" | "grandFinals" | "thirdPlaceMatch" | "iterations">,
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
  return [];
}
