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
import { importTournament, resyncTournament } from "@/lib/challonge/sync";
import { parseTournamentRef } from "@/lib/challonge/tournament-ref";

export type ActionState = { error?: string; message?: string };

export async function importTournamentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const organizer = await requireOrganizer();
  const ref = parseTournamentRef(String(formData.get("tournament") ?? ""));
  if (!ref) return { error: "Paste a Challonge tournament link (challonge.com/…) or its ID." };

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
  if (outcome.status === "needs_confirmation") return { error: "This correction erases later results. Open the judge pad to confirm." };
  return { error: outcome.error };
}

export async function resyncTournamentAction(tournamentId: string): Promise<ActionState> {
  const organizer = await requireOrganizer();
  try {
    const result = await resyncTournament(organizer.id, tournamentId);
    revalidatePath(`/tournaments/${tournamentId}`);
    return { message: result.matchesChanged ? "Bracket updated from Challonge." : "Already up to date." };
  } catch (error) {
    return { error: describeChallongeError(error) };
  }
}
