import "server-only";
import { and, eq } from "drizzle-orm";
import { placements } from "@/lib/bracket/standings";
import { suggestedSwissRounds } from "@/lib/bracket/swiss";
import { rankGroup, seedFinalStage } from "@/lib/bracket/two-stage";
import { BracketError } from "@/lib/bracket/types";
import { db } from "@/lib/db";
import { matches, participants, tournaments, type Tournament } from "@/lib/db/schema";
import { endGroupStageBlockers, finalizeBlockers } from "@/lib/finalize-check";
import { bumpBoard, reconcileQueue } from "@/lib/venue";
import { buildStage, swissRoundsFor } from "./build";
import { isFinished, isSwiss, stagePhase } from "./format";
import { insertStage, stagePlayers, stageRows } from "./queries";
import { toBracket } from "./store";

// The steps of a tournament after it starts: in a two-stage tournament, ending the group stage
// (which shows who goes through) and starting the final stage; then finishing it.

export type StageOutcome =
  | { status: "done" }
  /** Not done: something still needs doing first. */
  | { status: "blocked"; error: string }
  | { status: "failed"; error: string };

export type FinishOutcome = { status: "finished"; ranked: number } | { status: "blocked"; error: string } | { status: "failed"; error: string };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockOwned(tx: Tx, organizerId: string, tournamentId: string): Promise<Tournament | undefined> {
  const [row] = await tx
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.id, tournamentId), eq(tournaments.organizerId, organizerId)))
    .for("update");
  return row;
}

/** Each group's players, best first, from its results. Throws a BracketError while a group isn't played out. */
async function rankedGroups(tx: Tx, tournament: Tournament) {
  const ranked: string[][] = [];
  for (let g = 1; g <= (tournament.groupCount ?? 0); g++) {
    const players = await stagePlayers(tx, tournament, "group", g);
    const rows = await stageRows(tx, tournament.id, "group", g);
    if (isSwiss(tournament.groupStageType ?? "") && Math.max(0, ...rows.map((r) => r.round)) < suggestedSwissRounds(players.length)) {
      throw new BracketError(`Group ${String.fromCharCode(64 + g)} hasn't played all its rounds yet.`);
    }
    ranked.push(rankGroup(tournament.groupStageType!, players, rows.map(toBracket)));
  }
  return ranked;
}

/**
 * Ends the group stage: ranks every group and works out who goes through and how they are seeded
 * into the final stage. A group result can't be corrected after this.
 */
export async function endGroupStage(organizerId: string, tournamentId: string): Promise<StageOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const tournament = await lockOwned(tx, organizerId, tournamentId);
      if (!tournament) return { status: "failed", error: "Tournament not found." };
      if (stagePhase(tournament) !== "groups") {
        return { status: "blocked", error: tournament.groupStage ? "The group stage has already ended." : "This tournament has no group stage." };
      }
      const groupMatches = await tx
        .select({ state: matches.state })
        .from(matches)
        .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, "group")));
      const blockers = endGroupStageBlockers({ matches: groupMatches });
      if (blockers.length) return { status: "blocked", error: blockers.join(" ") };

      // Players who dropped out don't go through; the next in their group does.
      const active = new Set(
        (await tx.select({ id: participants.id }).from(participants).where(and(eq(participants.tournamentId, tournamentId), eq(participants.active, true)))).map((p) => p.id),
      );
      const ranked = (await rankedGroups(tx, tournament)).map((group) => group.filter((p) => active.has(p)));
      const order = seedFinalStage(ranked, tournament.advancePerGroup ?? 1, tournament.tournamentType);
      const seedOf = new Map(order.map((p, i) => [p, i + 1]));
      for (const player of ranked.flat()) {
        await tx
          .update(participants)
          .set({ advanced: seedOf.has(player), finalSeed: seedOf.get(player) ?? null })
          .where(eq(participants.id, player));
      }
      await tx.update(tournaments).set({ state: "between_stages" }).where(eq(tournaments.id, tournamentId));
      await bumpBoard(tx, tournamentId);
      return { status: "done" };
    });
  } catch (error) {
    if (error instanceof BracketError) return { status: "blocked", error: error.message };
    throw error;
  }
}

/** Starts the final stage with the players who went through, and fills the queue. */
export async function startFinalStage(organizerId: string, tournamentId: string): Promise<StageOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const tournament = await lockOwned(tx, organizerId, tournamentId);
      if (!tournament) return { status: "failed", error: "Tournament not found." };
      const phase = stagePhase(tournament);
      if (phase !== "between") {
        const why = phase === "groups" ? "End the group stage first." : phase === "final" ? "The final stage has already started." : "This tournament has no group stage.";
        return { status: "blocked", error: why };
      }
      const players = await stagePlayers(tx, tournament, "final", null);
      const options = { grandFinal: tournament.grandFinal, thirdPlace: tournament.thirdPlace, roundRobinLegs: tournament.roundRobinLegs };
      await insertStage(tx, tournamentId, "final", null, buildStage(tournament.tournamentType, players, options));
      await tx
        .update(tournaments)
        .set({
          state: "underway",
          startedAt: new Date(),
          swissRounds: tournament.tournamentType === "swiss" ? swissRoundsFor(players.length, tournament.swissRounds) : null,
        })
        .where(eq(tournaments.id, tournamentId));
      await reconcileQueue(tournamentId, tx);
      return { status: "done" };
    });
  } catch (error) {
    if (error instanceof BracketError) return { status: "blocked", error: error.message };
    throw error;
  }
}

/**
 * Finishes the tournament once its final stage is played out: every player gets their place and no
 * result can change any more. In a two-stage tournament, the players who didn't go through are
 * placed after those who did, by their place in their group.
 */
export async function finishTournament(organizerId: string, tournamentId: string): Promise<FinishOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const tournament = await lockOwned(tx, organizerId, tournamentId);
      if (!tournament) return { status: "failed", error: "Tournament not found." };
      if (isFinished(tournament.state)) return { status: "blocked", error: "This tournament is already finished." };
      if (tournament.state === "pending") return { status: "blocked", error: "This tournament hasn't started yet." };

      const rows = await stageRows(tx, tournamentId, "final", null);
      const blockers = finalizeBlockers({ matches: rows, swissRounds: tournament.swissRounds, phase: stagePhase(tournament) });
      if (blockers.length) return { status: "blocked", error: blockers.join(" ") };

      const finalists = await stagePlayers(tx, tournament, "final", null);
      const places = placements(tournament.tournamentType, finalists, rows.map(toBracket));
      const rank = new Map(places.map((p) => [p.player, p.place]));

      if (tournament.groupStage) {
        // Whoever didn't go through, by their place in their group: every group's 3rd shares a place, and so on.
        const groupPlace = new Map<string, number>();
        for (const group of await rankedGroups(tx, tournament)) {
          group.filter((p) => !rank.has(p)).forEach((p, i) => groupPlace.set(p, i + 1));
        }
        for (const [player, place] of groupPlace) {
          const better = [...groupPlace.values()].filter((other) => other < place).length;
          rank.set(player, finalists.length + 1 + better);
        }
      }
      for (const [player, place] of rank) {
        await tx.update(participants).set({ finalRank: place }).where(eq(participants.id, player));
      }
      await tx.update(tournaments).set({ state: "complete" }).where(eq(tournaments.id, tournamentId));
      await bumpBoard(tx, tournamentId);
      return { status: "finished", ranked: rank.size };
    });
  } catch (error) {
    if (error instanceof BracketError) return { status: "blocked", error: error.message };
    throw error;
  }
}
