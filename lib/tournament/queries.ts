import "server-only";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import type { BracketMatch } from "@/lib/bracket/types";
import { db } from "@/lib/db";
import { matches, participants, type Tournament } from "@/lib/db/schema";
import type { Stage } from "./format";
import { numberMatches, toRow } from "./store";

type Executor = Pick<typeof db, "select" | "insert">;

/** The match rows of one stage, and of one group in a group stage. */
export function stageRows(executor: Executor, tournamentId: string, stage: Stage, groupNumber: number | null) {
  return executor
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.tournamentId, tournamentId),
        eq(matches.stage, stage),
        groupNumber === null ? isNull(matches.groupNumber) : eq(matches.groupNumber, groupNumber),
      ),
    )
    .orderBy(asc(matches.playOrder));
}

/**
 * The players of a stage in seed order: a group's, the final stage's of a two-stage tournament
 * (who went through, in the order they were seeded into it), or everyone's. `activeOnly` leaves out
 * players who dropped out, for pairing a new Swiss round; their past matches still count.
 */
export async function stagePlayers(
  executor: Executor,
  tournament: Pick<Tournament, "id" | "groupStage">,
  stage: Stage,
  groupNumber: number | null,
  options: { activeOnly?: boolean } = {},
): Promise<string[]> {
  const rows = await executor
    .select({ id: participants.id, seed: participants.seed, finalSeed: participants.finalSeed, groupNumber: participants.groupNumber, active: participants.active, advanced: participants.advanced })
    .from(participants)
    .where(eq(participants.tournamentId, tournament.id));
  const inStage = rows.filter((p) => {
    if (options.activeOnly && !p.active) return false;
    if (stage === "group") return p.groupNumber === groupNumber;
    return !tournament.groupStage || p.advanced === true;
  });
  const seedOf = (p: (typeof rows)[number]) => (stage === "final" && tournament.groupStage ? p.finalSeed : p.seed) ?? Number.MAX_SAFE_INTEGER;
  return inStage.sort((a, b) => seedOf(a) - seedOf(b)).map((p) => p.id);
}

/**
 * Stores the matches the engine built for a stage, or for several groups of it at once, numbered
 * on from the tournament's last match. Run it under the tournament's lock, as every bracket change is.
 */
export async function insertMatches(
  executor: Executor,
  tournamentId: string,
  stage: Stage,
  groups: { groupNumber: number | null; built: BracketMatch[] }[],
): Promise<void> {
  const rows = groups.flatMap(({ groupNumber, built }) => built.map((m) => toRow(m, { tournamentId, stage, groupNumber })));
  if (!rows.length) return;
  const [{ last }] = await executor.select({ last: max(matches.number) }).from(matches).where(eq(matches.tournamentId, tournamentId));
  await executor.insert(matches).values(numberMatches(rows, (last ?? 0) + 1));
}

/** Stores the matches the engine built for a stage, or a group in it. */
export const insertStage = (executor: Executor, tournamentId: string, stage: Stage, groupNumber: number | null, built: BracketMatch[]) =>
  insertMatches(executor, tournamentId, stage, [{ groupNumber, built }]);

/** The columns round labels need of every match (lib/tournament/labels.ts). */
export const labelColumns = {
  round: matches.round,
  stage: matches.stage,
  groupNumber: matches.groupNumber,
  section: matches.section,
  thirdPlace: matches.thirdPlace,
  ifNeeded: matches.ifNeeded,
};
