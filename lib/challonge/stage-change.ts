import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { matches, tournaments, type Tournament } from "@/lib/db/schema";
import { endGroupStageBlockers } from "@/lib/finalize-check";
import { bumpBoard, ownedTournament, reconcileQueue } from "@/lib/venue";
import { ChallongeError } from "./client";
import { challongeClientFor } from "./connection";
import { describeChallongeError } from "./describe-error";
import { unsentResults } from "./finalize";
import { mapTournament } from "./map";
import { stagePhase } from "./support";
import { replaceMatches, replaceParticipants, tournamentPath } from "./sync";
import type { MatchResource, ParticipantResource, SingleResponse, TournamentResource } from "./types";

// The two steps between the stages of a two-stage tournament (spike S17). Challonge keeps them
// apart, and so does the Desk: ending the group stage shows who advances before the final stage
// is started.

export type StageOutcome =
  /** `warning` is set when the step was done on Challonge but what it changed couldn't be read. */
  | { status: "done"; warning?: string }
  /** Not attempted: something in the app still needs doing first. */
  | { status: "blocked"; error: string }
  | { status: "failed"; error: string };

type Client = Awaited<ReturnType<typeof challongeClientFor>>["client"];

/** Asks Challonge for a change of state (1 request). Gives the tournament as it is after it, or why it was refused. */
async function changeState(client: Client, tournament: Tournament, state: string, doing: string): Promise<{ data: TournamentResource } | { error: string }> {
  try {
    const response = await client.put<SingleResponse<TournamentResource> | null>(`${tournamentPath(tournament.challongeId)}/change_state.json`, {
      data: { type: "TournamentState", attributes: { state } },
    });
    if (!response?.data) return { error: `Challonge answered without the tournament. Check it on challonge.com, then resync.` };
    return { data: response.data };
  } catch (error) {
    if (error instanceof ChallongeError && error.status === 422) {
      return { error: `Challonge refused to ${doing}: ${error.details[0]?.detail ?? "it says the tournament isn't ready"}. Resync to see where it stands.` };
    }
    return { error: describeChallongeError(error) };
  }
}

/**
 * Ends the group stage on Challonge, which then works out who advances, and reads the participants:
 * 2 requests. It can't be undone from here, and a group result can't be corrected after it.
 */
export async function endGroupStage(organizerId: string, tournamentId: string): Promise<StageOutcome> {
  const tournament = await ownedTournament(organizerId, tournamentId);
  if (!tournament) return { status: "failed", error: "Tournament not found." };
  if (stagePhase(tournament) !== "groups") {
    return { status: "blocked", error: tournament.groupStage ? "The group stage has already ended." : "This tournament has no group stage." };
  }
  const groupMatches = await db
    .select({ state: matches.state })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, "group")));
  const blockers = endGroupStageBlockers({ matches: groupMatches, unsent: await unsentResults(tournamentId) });
  if (blockers.length) return { status: "blocked", error: blockers.join(" ") };

  let client: Client;
  try {
    ({ client } = await challongeClientFor(organizerId, { communityId: tournament.communityId }));
  } catch (error) {
    return { status: "failed", error: describeChallongeError(error) };
  }
  const changed = await changeState(client, tournament, "finalize_group_stage", "end the group stage");
  if ("error" in changed) return { status: "failed", error: changed.error };
  // A 200 doesn't prove the change was applied (spike S4), so check what Challonge says it is now.
  const format = { groupStage: true, state: changed.data.attributes.state };
  if (stagePhase(format) === "groups") {
    return { status: "failed", error: `Challonge answered, but the tournament is still "${format.state}" there. Check it on challonge.com.` };
  }
  await db.transaction(async (tx) => {
    await tx.update(tournaments).set({ state: format.state }).where(eq(tournaments.id, tournamentId));
    await bumpBoard(tx, tournamentId);
  });

  // Challonge has rewritten the seeds and marked who didn't advance, without changing their number.
  try {
    const list = await client.listAll<ParticipantResource>(`${tournamentPath(tournament.challongeId)}/participants.json`);
    if (list.notModified) throw new Error("Unexpected 304 for an unconditional request.");
    await db.transaction(async (tx) => {
      await replaceParticipants(tx, tournamentId, list.data, format);
      await bumpBoard(tx, tournamentId);
    });
  } catch (error) {
    return { status: "done", warning: `The group stage has ended, but who advances couldn't be read (${describeChallongeError(error)}). Use Resync.` };
  }
  return { status: "done" };
}

/** Starts the final stage on Challonge, which creates its matches, and reads them: 2 requests. */
export async function startFinalStage(organizerId: string, tournamentId: string): Promise<StageOutcome> {
  const tournament = await ownedTournament(organizerId, tournamentId);
  if (!tournament) return { status: "failed", error: "Tournament not found." };
  const phase = stagePhase(tournament);
  if (phase !== "between") {
    const why = phase === "groups" ? "End the group stage first." : phase === "final" ? "The final stage has already started." : "This tournament has no group stage.";
    return { status: "blocked", error: why };
  }

  let client: Client;
  try {
    ({ client } = await challongeClientFor(organizerId, { communityId: tournament.communityId }));
  } catch (error) {
    return { status: "failed", error: describeChallongeError(error) };
  }
  const changed = await changeState(client, tournament, "start", "start the final stage");
  if ("error" in changed) return { status: "failed", error: changed.error };
  const mapped = mapTournament(changed.data);
  if (stagePhase(mapped) !== "final") {
    return { status: "failed", error: `Challonge answered, but the tournament is still "${mapped.state}" there. Check it on challonge.com.` };
  }
  // The matches of the final stage are told from the others by when it started (lib/challonge/stages.ts).
  const format = { groupStage: true, state: mapped.state, startedAt: mapped.startedAt ?? new Date(), groupSize: tournament.groupSize };
  await db.transaction(async (tx) => {
    await tx.update(tournaments).set({ state: format.state, startedAt: format.startedAt }).where(eq(tournaments.id, tournamentId));
    await bumpBoard(tx, tournamentId);
  });

  try {
    const list = await client.listAll<MatchResource>(`${tournamentPath(tournament.challongeId)}/matches.json`);
    if (list.notModified) throw new Error("Unexpected 304 for an unconditional request.");
    await db.transaction(async (tx) => {
      await replaceMatches(tx, tournamentId, list.data, format);
      await tx.update(tournaments).set({ matchesEtag: list.etag, lastSyncedAt: new Date() }).where(eq(tournaments.id, tournamentId));
      // Puts the first matches of the final stage on deck.
      await reconcileQueue(tournamentId, tx);
    });
  } catch (error) {
    return { status: "done", warning: `The final stage has started, but its matches couldn't be read (${describeChallongeError(error)}). Use Resync.` };
  }
  const [first] = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, "final")))
    .limit(1);
  if (!first) return { status: "done", warning: "The final stage has started, but its matches aren't on Challonge yet. Use Resync in a moment." };
  return { status: "done" };
}
