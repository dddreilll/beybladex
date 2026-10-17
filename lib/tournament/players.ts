import "server-only";
import { randomInt } from "node:crypto";
import { and, asc, eq, max } from "drizzle-orm";
import { db } from "@/lib/db";
import { matches, participants, tournaments, type Tournament } from "@/lib/db/schema";
import { bumpBoard, reconcileQueue } from "@/lib/venue";
import { isFinished, isSwiss, stagePhase } from "./format";
import { settleStage } from "./results";
import { namesProblem } from "./setup";

// The players of a tournament: added, renamed, reordered and removed before it starts; dropped,
// or (in a Swiss) added late, once it has.

type Outcome = { error?: string };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The organizer's tournament, locked for the change, or why it can't be changed. */
async function lockOwned(tx: Tx, organizerId: string, tournamentId: string): Promise<Tournament | null> {
  const [row] = await tx
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.id, tournamentId), eq(tournaments.organizerId, organizerId)))
    .for("update");
  return row ?? null;
}

const seeded = (tx: Tx, tournamentId: string) =>
  tx.select().from(participants).where(eq(participants.tournamentId, tournamentId)).orderBy(asc(participants.seed));

/** Numbers the seeds 1, 2, 3 … in this order. */
async function reseed(tx: Tx, ids: string[]) {
  for (const [i, id] of ids.entries()) await tx.update(participants).set({ seed: i + 1 }).where(eq(participants.id, id));
}

/** Runs a change to a tournament that hasn't started: the players and their seeds can still change. */
function beforeStart(organizerId: string, tournamentId: string, change: (tx: Tx, tournament: Tournament) => Promise<Outcome>): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const tournament = await lockOwned(tx, organizerId, tournamentId);
    if (!tournament) return { error: "Tournament not found." };
    if (tournament.state !== "pending") return { error: "The tournament has started, so its players and seeds are fixed." };
    const outcome = await change(tx, tournament);
    if (!outcome.error) await bumpBoard(tx, tournamentId);
    return outcome;
  });
}

/** Adds players after the last seed, one or many. */
export function addPlayers(organizerId: string, tournamentId: string, names: string[]): Promise<Outcome> {
  return beforeStart(organizerId, tournamentId, async (tx) => {
    const current = await seeded(tx, tournamentId);
    const problem = namesProblem(names, current.map((p) => p.name));
    if (problem) return { error: problem };
    await tx.insert(participants).values(names.map((name, i) => ({ tournamentId, name, seed: current.length + i + 1 })));
    return {};
  });
}

/** Removes a player before the start; the seeds below move up. */
export function removePlayer(organizerId: string, tournamentId: string, playerId: string): Promise<Outcome> {
  return beforeStart(organizerId, tournamentId, async (tx) => {
    const current = await seeded(tx, tournamentId);
    if (!current.some((p) => p.id === playerId)) return { error: "Player not found." };
    await tx.delete(participants).where(eq(participants.id, playerId));
    await reseed(
      tx,
      current.filter((p) => p.id !== playerId).map((p) => p.id),
    );
    return {};
  });
}

/** Moves a player one seed up (-1) or down (1). */
export function moveSeed(organizerId: string, tournamentId: string, playerId: string, direction: -1 | 1): Promise<Outcome> {
  return beforeStart(organizerId, tournamentId, async (tx) => {
    const ids = (await seeded(tx, tournamentId)).map((p) => p.id);
    const at = ids.indexOf(playerId);
    if (at < 0) return { error: "Player not found." };
    const to = at + direction;
    if (to < 0 || to >= ids.length) return {};
    [ids[at], ids[to]] = [ids[to], ids[at]];
    await reseed(tx, ids);
    return {};
  });
}

/** Puts the players in a random seed order, for an event without seeding. */
export function shuffleSeeds(organizerId: string, tournamentId: string): Promise<Outcome> {
  return beforeStart(organizerId, tournamentId, async (tx) => {
    const ids = (await seeded(tx, tournamentId)).map((p) => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    await reseed(tx, ids);
    return {};
  });
}

/** Fixes a player's name, at any time. */
export async function renamePlayer(organizerId: string, tournamentId: string, playerId: string, name: string): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const tournament = await lockOwned(tx, organizerId, tournamentId);
    if (!tournament) return { error: "Tournament not found." };
    const current = await seeded(tx, tournamentId);
    if (!current.some((p) => p.id === playerId)) return { error: "Player not found." };
    const clean = name.trim().replace(/\s+/g, " ");
    const problem = namesProblem(
      [clean],
      current.filter((p) => p.id !== playerId).map((p) => p.name),
    );
    if (problem) return { error: problem };
    await tx.update(participants).set({ name: clean }).where(eq(participants.id, playerId));
    await bumpBoard(tx, tournamentId);
    return {};
  });
}

/**
 * Drops a player from a running tournament: they play no more. Their open matches, and any they
 * would have reached, go to their opponents as forfeits; a Swiss pairs them no more. Their
 * results so far stand, and they keep their Pass.
 */
export async function dropPlayer(organizerId: string, tournamentId: string, playerId: string): Promise<Outcome & { warning?: string }> {
  return db.transaction(async (tx) => {
    const tournament = await lockOwned(tx, organizerId, tournamentId);
    if (!tournament) return { error: "Tournament not found." };
    if (tournament.state === "pending") return { error: "The tournament hasn't started: remove the player instead." };
    if (isFinished(tournament.state)) return { error: "The tournament is finished." };
    const [player] = await tx
      .select()
      .from(participants)
      .where(and(eq(participants.id, playerId), eq(participants.tournamentId, tournamentId)));
    if (!player) return { error: "Player not found." };
    if (!player.active) return { error: `${player.name} has already dropped out.` };
    await tx.update(participants).set({ active: false }).where(eq(participants.id, playerId));

    // Every stage still being played: the groups until the group stage ends, then the final stage.
    const phase = stagePhase(tournament);
    const stages = await tx
      .selectDistinct({ stage: matches.stage, groupNumber: matches.groupNumber })
      .from(matches)
      .where(eq(matches.tournamentId, tournamentId));
    const warnings: string[] = [];
    for (const { stage, groupNumber } of stages) {
      if (stage === "group" && phase !== "groups") continue;
      const warning = await settleStage(tx, tournament, stage, groupNumber, organizerId);
      if (warning) warnings.push(warning);
    }
    await reconcileQueue(tournamentId, tx);
    return warnings.length ? { warning: warnings.join(" ") } : {};
  });
}

/**
 * Adds a player who arrived late to a Swiss that is running. They start with no wins and are
 * paired from the next round on, so there has to be one left.
 */
export async function addLatePlayer(organizerId: string, tournamentId: string, name: string): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const tournament = await lockOwned(tx, organizerId, tournamentId);
    if (!tournament) return { error: "Tournament not found." };
    if (!isSwiss(tournament.tournamentType) || tournament.groupStage) return { error: "Players can join late only in a Swiss." };
    if (tournament.state !== "underway") return { error: tournament.state === "pending" ? "Add the player to the list: the tournament hasn't started." : "The tournament is finished." };
    const [{ latest }] = await tx.select({ latest: max(matches.round) }).from(matches).where(eq(matches.tournamentId, tournamentId));
    if ((latest ?? 0) >= (tournament.swissRounds ?? 0)) return { error: "Every round is already paired, so there is none left to join." };

    const current = await seeded(tx, tournamentId);
    const clean = name.trim().replace(/\s+/g, " ");
    const problem = namesProblem(
      [clean],
      current.map((p) => p.name),
    );
    if (problem) return { error: problem };
    await tx.insert(participants).values({ tournamentId, name: clean, seed: current.length + 1 });
    await bumpBoard(tx, tournamentId);
    return {};
  });
}

/**
 * Deletes a tournament with everything in it: players, matches, battles, stadiums, screens and
 * sessions. `typedName` has to be the tournament's name, as a last check.
 */
export async function deleteTournament(organizerId: string, tournamentId: string, typedName: string): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const tournament = await lockOwned(tx, organizerId, tournamentId);
    if (!tournament) return { error: "Tournament not found." };
    if (typedName.trim() !== tournament.name) return { error: "Type the tournament's name exactly to delete it." };
    await tx.delete(tournaments).where(eq(tournaments.id, tournamentId));
    return {};
  });
}
