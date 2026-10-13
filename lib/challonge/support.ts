import { APP_NAME } from "@/lib/config";

// Which Challonge formats the app can run. Its pad and reporting assume one-against-one matches,
// and its round labels and correction check assume an elimination bracket
// (docs/rfc-001-architecture.md, spike S7). Every other format is refused before it is imported:
// it would load without an error and then go wrong.

export type TournamentFormat = { tournamentType: string; groupStage: boolean };

export type FormatSupport = { supported: true } | { supported: false; reason: string };

const SUPPORTED_TYPES = ["single elimination", "double elimination"];
/** Formats Challonge handles as the app expects, which the app itself isn't adapted to yet. */
const NOT_YET_TYPES: Record<string, string> = { "round robin": "round robin", swiss: "Swiss" };

const normalize = (tournamentType: string) => tournamentType.trim().toLowerCase().replace(/[_-]+/g, " ");

/** Whether a tournament can be imported and resynced; `reason` is written for the organizer. */
export function formatSupport(format: TournamentFormat): FormatSupport {
  const type = normalize(format.tournamentType);
  const runs = "It runs single and double elimination.";
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

/** What the organizer reviews before importing. The two options are null when Challonge didn't send them. */
export type TournamentPreview = {
  challongeId: string;
  challongeUrl: string;
  name: string;
  state: string;
  tournamentType: string;
  participantsCount: number;
  grandFinals: GrandFinals | null;
  thirdPlaceMatch: boolean | null;
};

const GRAND_FINALS: Record<GrandFinals, string> = {
  reset: "1 or 2 matches (a reset if the losers-side finalist wins the first)",
  single: "1 match, no reset",
  skip: "None",
};

/** The format options worth checking before an event. Empty when the format has none, or Challonge didn't send them. */
export function formatOptions(
  preview: Pick<TournamentPreview, "tournamentType" | "grandFinals" | "thirdPlaceMatch">,
): { label: string; value: string }[] {
  const type = normalize(preview.tournamentType);
  if (type === "double elimination" && preview.grandFinals) {
    return [{ label: "Grand finals", value: GRAND_FINALS[preview.grandFinals] }];
  }
  if (type === "single elimination" && preview.thirdPlaceMatch !== null) {
    return [{ label: "Third-place match", value: preview.thirdPlaceMatch ? "Yes" : "No" }];
  }
  return [];
}
