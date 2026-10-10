import { z } from "zod";

export const FINISHES = ["spin", "over", "burst", "xtreme"] as const;
export type Finish = (typeof FINISHES)[number];

const points = z.number().int().min(0).max(10);
const target = z.number().int().min(1).max(20);
const bestOf = z
  .number()
  .int()
  .min(1)
  .max(7)
  .refine((n) => n % 2 === 1, "Best of must be an odd number of sets.");

export const ruleProfileSchema = z.object({
  name: z.string().trim().min(1, "Give the profile a name.").max(60),
  points: z.object({ spin: points, over: points, burst: points, xtreme: points }),
  /** Points awarded when the opponent's Bey launches straight into a pocket. null = not used. */
  ownFinishPoints: z.number().int().min(1).max(10).nullable(),
  targetPoints: target,
  bestOfSets: bestOf,
  /** Report the winner's set score as the target (e.g. 4) even if a finish took it past (e.g. 5). */
  capAtTarget: z.boolean(),
  /** Every `strikes` launch errors by a player give the opponent `points`. null = not used. */
  launchErrorPenalty: z.object({ strikes: z.number().int().min(1).max(5), points: z.number().int().min(1).max(5) }).nullable(),
  /** Different length for the final match(es): Grand Finals in double elimination, the Final otherwise. */
  finals: z.object({ targetPoints: target, bestOfSets: bestOf }).nullable(),
});

export type RuleProfile = z.infer<typeof ruleProfileSchema>;

/** The rules that apply to one match; snapshotted onto the match when scoring starts. */
export type MatchRules = Omit<RuleProfile, "finals" | "name"> & { profileName: string };

const base = {
  points: { spin: 1, over: 2, burst: 2, xtreme: 3 },
  ownFinishPoints: null,
  bestOfSets: 1,
  capAtTarget: false,
  launchErrorPenalty: { strikes: 2, points: 1 },
  finals: null,
} satisfies Omit<RuleProfile, "name" | "targetPoints">;

/** Common community setups. Organizers should check their event's own rulebook and adjust. */
export const PRESETS = {
  "first-to-4": { ...base, name: "First to 4", targetPoints: 4 },
  "first-to-4-bo3-finals": { ...base, name: "First to 4 · Bo3 finals", targetPoints: 4, finals: { targetPoints: 4, bestOfSets: 3 } },
  "first-to-5": { ...base, name: "First to 5", targetPoints: 5 },
  "first-to-7": { ...base, name: "First to 7", targetPoints: 7 },
} satisfies Record<string, RuleProfile>;

export type PresetKey = keyof typeof PRESETS;
export const DEFAULT_PRESET: PresetKey = "first-to-4";

export const isPresetKey = (key: string): key is PresetKey => key in PRESETS;

export function rulesForMatch(profile: RuleProfile, { isFinals }: { isFinals: boolean }): MatchRules {
  const { finals, name, ...rest } = profile;
  return {
    ...rest,
    profileName: name,
    ...(isFinals && finals ? { targetPoints: finals.targetPoints, bestOfSets: finals.bestOfSets } : {}),
  };
}
