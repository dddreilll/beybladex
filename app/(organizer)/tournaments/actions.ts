"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireOrganizer } from "@/lib/auth";
import { describeChallongeError } from "@/lib/challonge/describe-error";
import { submitResult } from "@/lib/challonge/report";
import { db } from "@/lib/db";
import { ruleProfiles, tournaments } from "@/lib/db/schema";
import { isPresetKey } from "@/lib/scoring/profile";
import { UnsupportedFormatError, type TournamentPreview } from "@/lib/challonge/support";
import { importReviewed, importTournament, resyncTournament, reviewTournament } from "@/lib/challonge/sync";
import { parseTournamentRef } from "@/lib/challonge/tournament-ref";

export type ActionState = { error?: string; message?: string };
export type ReviewState = { error?: string; review?: { preview: TournamentPreview; token: string } };

const BAD_REF = "Paste a Challonge tournament link (challonge.com/…) or its ID.";

/**
 * Reads a tournament by link or ID for the organizer to review (1 request). The page isn't
 * revalidated: with the organizer's Challonge tournaments listed, that would read the list again.
 */
export async function reviewTournamentAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  const organizer = await requireOrganizer();
  const ref = parseTournamentRef(String(formData.get("tournament") ?? ""));
  if (!ref) return { error: BAD_REF };
  try {
    return { review: await reviewTournament(organizer.id, ref) };
  } catch (error) {
    return { error: describeChallongeError(error) };
  }
}

/** Imports the tournament a review token stands for (2 requests). */
export async function importReviewedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const organizer = await requireOrganizer();
  let tournamentId: string;
  try {
    tournamentId = await importReviewed(organizer.id, String(formData.get("token") ?? ""));
  } catch (error) {
    return { error: describeChallongeError(error) };
  }
  revalidatePath("/tournaments");
  redirect(`/tournaments/${tournamentId}`);
}

/** Imports a tournament picked from the organizer's Challonge tournaments, whose details were already on the page (3 requests). */
export async function importTournamentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const organizer = await requireOrganizer();
  const ref = parseTournamentRef(String(formData.get("tournament") ?? ""));
  if (!ref) return { error: BAD_REF };

  let tournamentId: string;
  try {
    tournamentId = await importTournament(organizer.id, ref);
  } catch (error) {
    return { error: describeChallongeError(error) };
  }
  revalidatePath("/tournaments");
  redirect(`/tournaments/${tournamentId}`);
}

const uuid = z.uuid();

/** Value is either `preset:<key>` or `profile:<uuid>`. Matches already being scored keep their snapshot. */
export async function setTournamentRulesAction(tournamentId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const organizer = await requireOrganizer();
  const [kind, value] = String(form.get("rules") ?? "").split(":");
  let update: { rulePresetKey?: string; ruleProfileId: string | null };
  if (kind === "preset" && isPresetKey(value)) {
    update = { rulePresetKey: value, ruleProfileId: null };
  } else if (kind === "profile" && uuid.safeParse(value).success) {
    const [own] = await db
      .select({ id: ruleProfiles.id })
      .from(ruleProfiles)
      .where(and(eq(ruleProfiles.id, value), eq(ruleProfiles.organizerId, organizer.id)));
    if (!own) return { error: "That rule profile doesn't exist." };
    update = { ruleProfileId: value };
  } else {
    return { error: "Pick a rule profile." };
  }
  await db
    .update(tournaments)
    .set(update)
    .where(and(eq(tournaments.id, uuid.parse(tournamentId)), eq(tournaments.organizerId, organizer.id)));
  revalidatePath(`/tournaments/${tournamentId}`);
  return { message: "Rules updated." };
}

/** Re-sends a match's current result (recomputed from its battles). */
export async function retryResultAction(tournamentId: string, matchId: string): Promise<ActionState> {
  const organizer = await requireOrganizer();
  const outcome = await submitResult(organizer.id, uuid.parse(matchId));
  revalidatePath(`/tournaments/${tournamentId}`);
  if (outcome.status === "synced") return { message: outcome.warning ?? "Sent to Challonge." };
  if (outcome.status === "needs_confirmation") return { error: "This correction erases later results. Open the BXQ Pad to confirm." };
  return { error: outcome.error };
}

export async function resyncTournamentAction(tournamentId: string): Promise<ActionState> {
  const organizer = await requireOrganizer();
  try {
    const result = await resyncTournament(organizer.id, tournamentId);
    revalidatePath(`/tournaments/${tournamentId}`);
    return { message: result.matchesChanged ? "Bracket updated from Challonge." : "Already up to date." };
  } catch (error) {
    // A refused resync has recorded the tournament's new format, which the Desk shows.
    if (error instanceof UnsupportedFormatError) revalidatePath(`/tournaments/${tournamentId}`);
    return { error: describeChallongeError(error) };
  }
}
