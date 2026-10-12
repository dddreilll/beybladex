import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { matches, syncOutbox, tournaments } from "@/lib/db/schema";
import { finalizeBlockers } from "@/lib/finalize-check";
import { bumpBoard, ownedTournament } from "@/lib/venue";
import { ChallongeError } from "./client";
import { challongeClientFor } from "./connection";
import { describeChallongeError } from "./describe-error";
import { isFinalState } from "./map";
import { replaceParticipants, resyncTournament, tournamentPath } from "./sync";
import type { ParticipantResource, SingleResponse, TournamentResource } from "./types";

export type FinalizeOutcome =
  /** `warning` is set when the tournament is final but its standings couldn't be read yet. */
  | { status: "finalized"; ranked: number; warning?: string }
  /** Not attempted: something in the app still needs doing first. */
  | { status: "blocked"; error: string }
  | { status: "failed"; error: string };

/** Results whose latest send hasn't reached Challonge (in flight, failed, or refused). */
async function unsentResults(tournamentId: string): Promise<number> {
  const rows = await db
    .select({ matchId: syncOutbox.matchId, status: syncOutbox.status })
    .from(syncOutbox)
    .where(eq(syncOutbox.tournamentId, tournamentId))
    .orderBy(desc(syncOutbox.createdAt));
  const latest = new Map<string, string>();
  for (const row of rows) if (!latest.has(row.matchId)) latest.set(row.matchId, row.status);
  return [...latest.values()].filter((status) => status !== "done").length;
}

/**
 * Reads every player's final placement from Challonge (1 request) and shows it on the call board
 * and the player pages. Challonge only fills these in once the tournament is finalized.
 */
export async function loadStandings(organizerId: string, tournamentId: string): Promise<{ ranked: number } | { error: string }> {
  const tournament = await ownedTournament(organizerId, tournamentId);
  if (!tournament) return { error: "Tournament not found." };
  if (!isFinalState(tournament.state)) return { error: "Standings exist once the tournament is finalized." };
  try {
    const { client } = await challongeClientFor(organizerId, { communityId: tournament.communityId });
    const list = await client.listAll<ParticipantResource>(`${tournamentPath(tournament.challongeId)}/participants.json`);
    if (list.notModified) return { error: "Challonge sent no standings. Try again in a moment." };
    await db.transaction(async (tx) => {
      await replaceParticipants(tx, tournament.id, list.data);
      await bumpBoard(tx, tournament.id);
    });
    return { ranked: list.data.filter((p) => p.attributes.final_rank != null).length };
  } catch (error) {
    return { error: describeChallongeError(error) };
  }
}

/**
 * Marks the tournament final on Challonge, which can't be undone there, then reads the standings.
 * About 4 requests: a resync first (so nothing changed on challonge.com is overlooked), the
 * finalize call, and the participants with their placements.
 */
export async function finalizeTournament(organizerId: string, tournamentId: string): Promise<FinalizeOutcome> {
  const owned = await ownedTournament(organizerId, tournamentId);
  if (!owned) return { status: "failed", error: "Tournament not found." };
  if (isFinalState(owned.state)) return { status: "blocked", error: "This tournament is already finalized." };

  try {
    await resyncTournament(organizerId, tournamentId);
  } catch (error) {
    return { status: "failed", error: describeChallongeError(error) };
  }
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);

  // The resync may have found it finalized on challonge.com already; then only the standings are missing.
  if (!isFinalState(tournament.state)) {
    const matchRows = await db.select({ state: matches.state }).from(matches).where(eq(matches.tournamentId, tournamentId));
    const blockers = finalizeBlockers({ matches: matchRows, unsent: await unsentResults(tournamentId) });
    if (blockers.length) return { status: "blocked", error: blockers.join(" ") };

    let state: string | undefined;
    try {
      const { client } = await challongeClientFor(organizerId, { communityId: tournament.communityId });
      const response = await client.put<SingleResponse<TournamentResource> | null>(
        `${tournamentPath(tournament.challongeId)}/change_state.json`,
        { data: { type: "TournamentState", attributes: { state: "finalize" } } },
      );
      state = response?.data?.attributes?.state;
    } catch (error) {
      if (error instanceof ChallongeError && error.status === 422) {
        return { status: "failed", error: `Challonge refused to finalize: ${error.details[0]?.detail ?? "it says the tournament isn't ready."}` };
      }
      return { status: "failed", error: describeChallongeError(error) };
    }
    // A 200 doesn't prove the change was applied (spike S4), so check what Challonge says it is now.
    if (!state || !isFinalState(state)) {
      return { status: "failed", error: `Challonge answered, but the tournament is still "${state ?? "unknown"}" there. Check it on challonge.com.` };
    }
    await db.transaction(async (tx) => {
      await tx.update(tournaments).set({ state }).where(eq(tournaments.id, tournamentId));
      await bumpBoard(tx, tournamentId);
    });
  }

  const standings = await loadStandings(organizerId, tournamentId);
  if ("error" in standings) {
    return { status: "finalized", ranked: 0, warning: `Finalized, but the standings couldn't be read: ${standings.error}` };
  }
  return { status: "finalized", ranked: standings.ranked };
}
