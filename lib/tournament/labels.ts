import { isElimination, stageType, type Stage } from "./format";

// The names of rounds and groups on every screen: "Winners R2", "Losers Final", "Group A · Round 2".

/** What a label needs of a match. Rows of the matches table have it all. */
export type LabelledMatch = {
  round: number;
  stage?: Stage;
  groupNumber?: number | null;
  section?: "losers" | "grand_final" | null;
  thirdPlace?: boolean;
  ifNeeded?: boolean;
};

/** "Group A" for the first group, "Group stage" without a group number. */
export function groupLabel(groupNumber: number | null): string {
  if (!groupNumber) return "Group stage";
  return `Group ${groupNumber <= 26 ? String.fromCharCode(64 + groupNumber) : groupNumber}`;
}

/** The last round of the winners side (or the whole bracket) and of the losers side, among some matches. */
function lastRounds(matches: LabelledMatch[]) {
  const last = (list: LabelledMatch[]) => Math.max(0, ...list.map((m) => m.round));
  return {
    main: last(matches.filter((m) => !m.section && !m.thirdPlace)),
    losers: last(matches.filter((m) => m.section === "losers")),
  };
}

/** A round's name within its own bracket, given the format and the last rounds of that bracket. */
function roundLabel(format: string, match: LabelledMatch, last: ReturnType<typeof lastRounds>): string {
  // A round robin or a Swiss has no final: its last round is a round like the others.
  if (!isElimination(format)) return `Round ${match.round}`;
  if (match.thirdPlace) return "Third place";
  if (match.section === "grand_final") return match.ifNeeded ? "Grand Finals reset" : "Grand Finals";
  if (match.section === "losers") return match.round === last.losers ? "Losers Final" : `Losers R${match.round}`;
  if (isDouble(format)) return match.round === last.main ? "Winners Final" : `Winners R${match.round}`;
  return match.round === last.main && last.main > 1 ? "Final" : `Round ${match.round}`;
}

const isDouble = (format: string) => format.replace(/[\s-]+/g, "_").toLowerCase() === "double_elimination";

/**
 * Labels the matches of a tournament, given all of them. Each stage, and each group, has its own
 * format and its own rounds, and a group match is named with its group: "Group A · Round 2".
 */
export function roundLabeller(format: { tournamentType: string; groupStageType?: string | null }, matches: LabelledMatch[]) {
  const finalStage = lastRounds(matches.filter((m) => m.stage !== "group"));
  const groups = new Map<number | null, ReturnType<typeof lastRounds>>();
  for (const m of matches) {
    const group = m.groupNumber ?? null;
    if (m.stage !== "group" || groups.has(group)) continue;
    groups.set(group, lastRounds(matches.filter((o) => o.stage === "group" && (o.groupNumber ?? null) === group)));
  }
  return (match: LabelledMatch): string => {
    if (match.stage !== "group") return roundLabel(stageType(format, "final"), match, finalStage);
    const last = groups.get(match.groupNumber ?? null) ?? lastRounds([match]);
    return `${groupLabel(match.groupNumber ?? null)} · ${roundLabel(stageType(format, "group"), match, last)}`;
  };
}
