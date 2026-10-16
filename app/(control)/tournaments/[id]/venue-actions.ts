"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrganizer } from "@/lib/auth";
import { MAX_BOARD_LIMIT } from "@/lib/config";
import {
  addStadium,
  backToQueue,
  callOnDeck,
  cancelMatch,
  holdMatch,
  moveOnDeck,
  placeOnDeck,
  recallMatch,
  removeStadium,
  renameStadium,
  setHeld,
  startMatch,
  updateVenueSettings,
} from "@/lib/venue";

export type VenueState = { error?: string; message?: string };

const id = z.uuid();
const refresh = (tournamentId: string) => revalidatePath(`/tournaments/${id.parse(tournamentId)}`);

export async function addStadiumAction(tournamentId: string) {
  const organizer = await requireOrganizer();
  await addStadium(organizer.id, id.parse(tournamentId));
  refresh(tournamentId);
}

export async function renameStadiumAction(tournamentId: string, stadiumId: string, name: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const parsed = z.string().trim().min(1).max(40).safeParse(name);
  if (!parsed.success) return { error: "Give the stadium a name (up to 40 characters)." };
  await renameStadium(organizer.id, id.parse(stadiumId), parsed.data);
  refresh(tournamentId);
  return {};
}

export async function removeStadiumAction(tournamentId: string, stadiumId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  await removeStadium(organizer.id, id.parse(stadiumId));
  refresh(tournamentId);
  return {};
}

export async function callOnDeckAction(tournamentId: string, stadiumId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await callOnDeck(organizer.id, id.parse(stadiumId));
  refresh(tournamentId);
  return result;
}

export async function recallAction(tournamentId: string, matchId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await recallMatch(organizer.id, id.parse(matchId));
  refresh(tournamentId);
  return result.error ? { error: result.error } : {};
}

export async function startMatchAction(tournamentId: string, matchId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await startMatch(organizer.id, id.parse(matchId));
  refresh(tournamentId);
  return result.error ? { error: result.error } : { message: result.warning };
}

export async function placeOnDeckAction(tournamentId: string, matchId: string, stadiumId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await placeOnDeck(organizer.id, id.parse(matchId), id.parse(stadiumId));
  refresh(tournamentId);
  return result;
}

export async function moveOnDeckAction(tournamentId: string, matchId: string, stadiumId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await moveOnDeck(organizer.id, id.parse(matchId), id.parse(stadiumId));
  refresh(tournamentId);
  return result;
}

export async function backToQueueAction(tournamentId: string, matchId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await backToQueue(organizer.id, id.parse(matchId));
  refresh(tournamentId);
  return result;
}

/** Pauses a called or playing match (battles kept); it waits as HELD until released. */
export async function holdMatchAction(tournamentId: string, matchId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await holdMatch(organizer.id, id.parse(matchId));
  refresh(tournamentId);
  return result.error ? { error: result.error } : { message: result.warning };
}

/** Voids the recorded battles and holds the match at 0–0. */
export async function cancelMatchAction(tournamentId: string, matchId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const result = await cancelMatch(organizer.id, id.parse(matchId));
  refresh(tournamentId);
  return result.error ? { error: result.error } : { message: result.warning };
}

/** Hold (true) or release (false) a match that is waiting in the queue. */
export async function setHeldAction(tournamentId: string, matchId: string, held: boolean): Promise<VenueState> {
  const organizer = await requireOrganizer();
  await setHeld(organizer.id, id.parse(matchId), held);
  refresh(tournamentId);
  return {};
}

export async function venueSettingsAction(tournamentId: string, _prev: VenueState, form: FormData): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const boardLimit = z.coerce.number().int().min(1).max(MAX_BOARD_LIMIT).safeParse(form.get("boardLimit"));
  if (!boardLimit.success) return { error: `Boards allowed must be between 1 and ${MAX_BOARD_LIMIT}.` };
  await updateVenueSettings(organizer.id, id.parse(tournamentId), {
    autoOnDeck: form.get("autoOnDeck") === "on",
    autoCall: form.get("autoCall") === "on",
    markUnderway: form.get("markUnderway") === "on",
    boardLimit: boardLimit.data,
  });
  refresh(tournamentId);
  return { message: "Saved." };
}
