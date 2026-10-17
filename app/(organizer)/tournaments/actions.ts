"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireOrganizer } from "@/lib/auth";
import { db } from "@/lib/db";
import { ruleProfiles, tournaments } from "@/lib/db/schema";
import { isPresetKey } from "@/lib/scoring/profile";

export type ActionState = { error?: string; message?: string };

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
