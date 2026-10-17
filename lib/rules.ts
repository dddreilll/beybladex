import "server-only";
import { and, eq, isNull, max } from "drizzle-orm";
import { db } from "@/lib/db";
import { matches, ruleProfiles, type Match, type Tournament } from "@/lib/db/schema";
import { isElimination } from "@/lib/tournament/format";
import { DEFAULT_PRESET, isPresetKey, PRESETS, rulesForMatch, type MatchRules, type RuleProfile } from "@/lib/scoring/profile";

type Executor = Pick<typeof db, "select">;

export async function tournamentProfile(tournament: Tournament, executor: Executor = db): Promise<RuleProfile> {
  if (tournament.ruleProfileId) {
    const [row] = await executor
      .select({ config: ruleProfiles.config })
      .from(ruleProfiles)
      .where(and(eq(ruleProfiles.id, tournament.ruleProfileId), eq(ruleProfiles.organizerId, tournament.organizerId)))
      .limit(1);
    if (row) return row.config;
  }
  return PRESETS[isPresetKey(tournament.rulePresetKey) ? tournament.rulePresetKey : DEFAULT_PRESET];
}

/**
 * The final match(es): the grand final (and its reset) in double elimination, the final otherwise.
 * In a two-stage tournament they are the final stage's; no group match is one. A bracket of two
 * players has no final round to speak of, and a round robin or a Swiss has none at all.
 */
export async function isFinalsMatch(tournament: Tournament, match: Match, executor: Executor = db): Promise<boolean> {
  if (match.stage === "group" || !isElimination(tournament.tournamentType)) return false;
  if (match.section) return match.section === "grand_final";
  if (match.thirdPlace) return false;
  const [range] = await executor
    .select({ max: max(matches.round) })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournament.id), eq(matches.stage, "final"), isNull(matches.section)));
  return Boolean(range?.max && range.max > 1 && match.round === range.max && tournament.tournamentType === "single_elimination");
}

/** The match's frozen rules once scoring started, otherwise what the tournament's profile says now. */
export async function rulesFor(tournament: Tournament, match: Match, executor: Executor = db): Promise<MatchRules> {
  if (match.ruleSnapshot) return match.ruleSnapshot;
  const profile = await tournamentProfile(tournament, executor);
  return rulesForMatch(profile, { isFinals: await isFinalsMatch(tournament, match, executor) });
}
