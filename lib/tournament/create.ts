import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { splitIntoGroups } from "@/lib/bracket/two-stage";
import { BracketError } from "@/lib/bracket/types";
import { db } from "@/lib/db";
import { participants, tournaments } from "@/lib/db/schema";
import { reconcileQueue } from "@/lib/venue";
import { buildStage, swissRoundsFor } from "./build";
import { FORMATS } from "./format";
import { insertStage } from "./queries";
import { MAX_PLAYERS, namesProblem, setupProblems, type Setup } from "./setup";
import { groupPrefix, prefixKeys } from "./store";

const format = z.enum(FORMATS as [string, ...string[]]).transform((f) => f as (typeof FORMATS)[number]);

/**
 * A new tournament as the organizer sets it up. `players` are names in seed order, the first
 * being seed 1; there may be none yet, since players can be added on the Desk before the start.
 * With `groupStage`, `format` is the final stage's.
 */
export const tournamentInput = z
  .object({
    name: z.string().trim().min(1, "Give the tournament a name.").max(100),
    format,
    players: z.array(z.string()).max(MAX_PLAYERS).default([]),
    grandFinal: z.enum(["reset", "single"]).default("reset"),
    thirdPlace: z.boolean().default(false),
    roundRobinLegs: z.union([z.literal(1), z.literal(2)]).default(1),
    swissRounds: z.number().int().min(1).nullable().default(null),
    groupStage: z.object({ format, groups: z.number().int(), advance: z.number().int() }).nullable().default(null),
  })
  .transform((input) => ({ ...input, players: input.players.map((name) => name.trim().replace(/\s+/g, " ")).filter(Boolean) }))
  .superRefine((input, ctx) => {
    const names = input.players.length ? namesProblem(input.players) : null;
    if (names) ctx.addIssue({ code: "custom", path: ["players"], message: names });
    for (const message of setupProblems({ ...setupOf(input), players: null })) ctx.addIssue({ code: "custom", message });
  });

/** The setup of a tournament, for the checks in lib/tournament/setup.ts. */
function setupOf(t: {
  format: (typeof FORMATS)[number];
  thirdPlace: boolean;
  swissRounds: number | null;
  groupStage: { groups: number; advance: number } | null;
}): Omit<Setup, "players"> {
  return { format: t.format, thirdPlace: t.thirdPlace, swissRounds: t.swissRounds, groupStage: t.groupStage };
}

export type TournamentInput = z.input<typeof tournamentInput>;

/** Creates a tournament and its players, not started yet. Returns its id, or why it couldn't. */
export async function createTournament(organizerId: string, input: TournamentInput): Promise<{ id: string } | { error: string }> {
  const parsed = tournamentInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const t = parsed.data;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tournaments)
      .values({
        organizerId,
        name: t.name,
        tournamentType: t.format,
        groupStage: Boolean(t.groupStage),
        groupStageType: t.groupStage?.format ?? null,
        groupCount: t.groupStage?.groups ?? null,
        advancePerGroup: t.groupStage?.advance ?? null,
        grandFinal: t.grandFinal,
        thirdPlace: t.thirdPlace,
        roundRobinLegs: t.roundRobinLegs,
        swissRounds: t.format === "swiss" ? t.swissRounds : null,
      })
      .returning({ id: tournaments.id });
    if (t.players.length) await tx.insert(participants).values(t.players.map((name, i) => ({ tournamentId: row.id, name, seed: i + 1 })));
    return { id: row.id };
  });
}

/**
 * Starts a tournament: builds its bracket, or its groups in a two-stage tournament, and fills the
 * queue. The players and their seeds are fixed from here on.
 */
export async function startTournament(organizerId: string, tournamentId: string): Promise<{ error?: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [tournament] = await tx
        .select()
        .from(tournaments)
        .where(and(eq(tournaments.id, tournamentId), eq(tournaments.organizerId, organizerId)))
        .for("update");
      if (!tournament) return { error: "Tournament not found." };
      if (tournament.state !== "pending") return { error: "This tournament has already started." };

      const players = (
        await tx
          .select({ id: participants.id })
          .from(participants)
          .where(and(eq(participants.tournamentId, tournamentId), eq(participants.active, true)))
          .orderBy(asc(participants.seed))
      ).map((p) => p.id);
      const options = { grandFinal: tournament.grandFinal, thirdPlace: tournament.thirdPlace, roundRobinLegs: tournament.roundRobinLegs };
      const problems = setupProblems({
        ...setupOf({
          format: tournament.tournamentType,
          thirdPlace: tournament.thirdPlace,
          swissRounds: tournament.swissRounds,
          groupStage: tournament.groupStage ? { groups: tournament.groupCount ?? 0, advance: tournament.advancePerGroup ?? 0 } : null,
        }),
        players: players.length,
      });
      if (problems.length) return { error: problems.join(" ") };

      if (tournament.groupStage && tournament.groupStageType && tournament.groupCount) {
        const groups = splitIntoGroups(players, tournament.groupCount);
        for (const [i, group] of groups.entries()) {
          await tx.update(participants).set({ groupNumber: i + 1 }).where(inArray(participants.id, group));
          const built = buildStage(tournament.groupStageType, group, { ...options, thirdPlace: false });
          await insertStage(tx, tournamentId, "group", i + 1, prefixKeys(built, groupPrefix(i + 1)));
        }
        await tx.update(tournaments).set({ state: "group_stage" }).where(eq(tournaments.id, tournamentId));
      } else {
        await insertStage(tx, tournamentId, "final", null, buildStage(tournament.tournamentType, players, options));
        await tx
          .update(tournaments)
          .set({
            state: "underway",
            startedAt: new Date(),
            swissRounds: tournament.tournamentType === "swiss" ? swissRoundsFor(players.length, tournament.swissRounds) : null,
          })
          .where(eq(tournaments.id, tournamentId));
      }
      await reconcileQueue(tournamentId, tx);
      return {};
    });
  } catch (error) {
    if (error instanceof BracketError) return { error: error.message };
    throw error;
  }
}
