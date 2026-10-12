"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { approveBoardScreen, removeBoardScreen, resetPlayerAccess } from "@/lib/access";
import { requireOrganizer } from "@/lib/auth";
import { finalizeTournament, loadStandings } from "@/lib/challonge/finalize";
import { approveJudge, judgeMyself, removeJudge, renameJudge } from "@/lib/judges";
import type { VenueState } from "./venue-actions";

const id = z.uuid();
const refresh = (tournamentId: string) => revalidatePath(`/tournaments/${id.parse(tournamentId)}`);

/** Lets a waiting screen show the call board (refused once the tournament's limit is reached). */
export async function approveScreenAction(tournamentId: string, screenId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await approveBoardScreen(organizer.id, id.parse(screenId));
  refresh(tournamentId);
  return result;
}

/** Declines a waiting screen, or disconnects one that is showing the board. */
export async function removeScreenAction(tournamentId: string, screenId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  await removeBoardScreen(organizer.id, id.parse(screenId));
  refresh(tournamentId);
  return {};
}

/** Lets a waiting tablet judge its stadium (refused while that stadium already has a judge). */
export async function approveJudgeAction(tournamentId: string, judgeId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await approveJudge(organizer.id, id.parse(judgeId));
  refresh(tournamentId);
  return result;
}

/** Declines a waiting tablet, disconnects a stadium's judge, or ends the organizer's own judging. */
export async function removeJudgeAction(tournamentId: string, judgeId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  await removeJudge(organizer.id, id.parse(judgeId));
  refresh(tournamentId);
  return {};
}

/** Renames a stadium's judge tablet; a blank name goes back to the detected device name. */
export async function renameJudgeAction(tournamentId: string, judgeId: string, name: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await renameJudge(organizer.id, id.parse(judgeId), z.string().max(200).parse(name));
  refresh(tournamentId);
  return result;
}

/** "Judge here myself": the organizer becomes the stadium's judge. */
export async function judgeMyselfAction(tournamentId: string, stadiumId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await judgeMyself(organizer.id, id.parse(stadiumId));
  refresh(tournamentId);
  return result;
}

/** New passcode and QR code for one player; their device is signed out. */
export async function resetPlayerAction(tournamentId: string, playerId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const done = await resetPlayerAccess(organizer.id, id.parse(tournamentId), z.string().regex(/^\d{1,20}$/).parse(playerId));
  refresh(tournamentId);
  return done ? { message: "New passcode issued. The old slip no longer works." } : { error: "Player not found." };
}

export async function finalizeAction(tournamentId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await finalizeTournament(organizer.id, id.parse(tournamentId));
  refresh(tournamentId);
  if (outcome.status !== "finalized") return { error: outcome.error };
  return { message: outcome.warning ?? "Finalized on Challonge. The call board now shows the final standings." };
}

/** Reads the final placements again (1 request), for when they couldn't be read while finalizing. */
export async function loadStandingsAction(tournamentId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await loadStandings(organizer.id, id.parse(tournamentId));
  refresh(tournamentId);
  if ("error" in result) return { error: result.error };
  return result.ranked ? { message: "Standings loaded." } : { error: "Challonge hasn't published the standings yet. Try again in a moment." };
}
