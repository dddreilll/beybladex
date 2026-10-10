import "server-only";
import { and, eq, max, min } from "drizzle-orm";
import { db } from "@/lib/db";
import { matches, ruleProfiles, type Match, type Tournament } from "@/lib/db/schema";
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

/** The final match(es): Grand Finals (and its reset) in double elimination, the Final otherwise. */
export async function isFinalsMatch(tournament: Tournament, match: Match, executor: Executor = db): Promise<boolean> {
  const [range] = await executor
    .select({ max: max(matches.round), min: min(matches.round) })
    .from(matches)
    .where(eq(matches.tournamentId, tournament.id));
  const type = tournament.tournamentType.toLowerCase();
  if (!type.includes("elimination") || !range?.max) return false;
  return match.round === range.max && range.max > 1;
}

/** The match's frozen rules once scoring started, otherwise what the tournament's profile says now. */
export async function rulesFor(tournament: Tournament, match: Match, executor: Executor = db): Promise<MatchRules> {
  if (match.ruleSnapshot) return match.ruleSnapshot;
  const profile = await tournamentProfile(tournament, executor);
  return rulesForMatch(profile, { isFinals: await isFinalsMatch(tournament, match, executor) });
}
