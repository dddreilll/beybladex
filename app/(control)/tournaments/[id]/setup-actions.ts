"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrganizer } from "@/lib/auth";
import { startTournament } from "@/lib/tournament/create";
import { addLatePlayer, addPlayers, deleteTournament, dropPlayer, moveSeed, removePlayer, renamePlayer, shuffleSeeds } from "@/lib/tournament/players";
import { parsePlayerNames } from "@/lib/tournament/setup";
import type { VenueState } from "./venue-actions";

const id = z.uuid();
const text = z.string().max(20_000);
const refresh = (tournamentId: string) => revalidatePath(`/tournaments/${id.parse(tournamentId)}`);
const done = (outcome: { error?: string }, message?: string): VenueState => (outcome.error ? { error: outcome.error } : { message });

/** Adds one player or many: names one per line or separated by commas. */
export async function addPlayersAction(tournamentId: string, names: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const list = parsePlayerNames(text.parse(names));
  const outcome = await addPlayers(organizer.id, id.parse(tournamentId), list);
  refresh(tournamentId);
  return done(outcome, list.length === 1 ? `${list[0]} added.` : `${list.length} players added.`);
}

export async function removePlayerAction(tournamentId: string, playerId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await removePlayer(organizer.id, id.parse(tournamentId), id.parse(playerId));
  refresh(tournamentId);
  return done(outcome);
}

export async function moveSeedAction(tournamentId: string, playerId: string, direction: -1 | 1): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await moveSeed(organizer.id, id.parse(tournamentId), id.parse(playerId), z.union([z.literal(-1), z.literal(1)]).parse(direction));
  refresh(tournamentId);
  return done(outcome);
}

export async function shuffleSeedsAction(tournamentId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await shuffleSeeds(organizer.id, id.parse(tournamentId));
  refresh(tournamentId);
  return done(outcome, "Seeds shuffled.");
}

export async function renamePlayerAction(tournamentId: string, playerId: string, name: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await renamePlayer(organizer.id, id.parse(tournamentId), id.parse(playerId), text.parse(name));
  refresh(tournamentId);
  return done(outcome);
}

/** Builds the bracket (or the groups) and fills the queue. Players and seeds are fixed from here on. */
export async function startTournamentAction(tournamentId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await startTournament(organizer.id, id.parse(tournamentId));
  refresh(tournamentId);
  return done(outcome, "Started. Add stadiums to send matches to them.");
}

/** A player leaves a running tournament: their matches go to their opponents as forfeits. */
export async function dropPlayerAction(tournamentId: string, playerId: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await dropPlayer(organizer.id, id.parse(tournamentId), id.parse(playerId));
  refresh(tournamentId);
  return outcome.error ? { error: outcome.error } : { message: outcome.warning ?? "Dropped. Their matches went to their opponents." };
}

/** A player who arrived late joins a running Swiss from its next round. */
export async function addLatePlayerAction(tournamentId: string, name: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await addLatePlayer(organizer.id, id.parse(tournamentId), text.parse(name));
  refresh(tournamentId);
  return done(outcome, "Added. They play from the next round.");
}

export async function deleteTournamentAction(tournamentId: string, typedName: string): Promise<VenueState> {
  const organizer = await requireOrganizer();
  const outcome = await deleteTournament(organizer.id, id.parse(tournamentId), text.parse(typedName));
  if (outcome.error) return { error: outcome.error };
  revalidatePath("/tournaments");
  redirect("/tournaments");
}
