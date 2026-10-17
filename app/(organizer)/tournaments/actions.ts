"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireOrganizer } from "@/lib/auth";
import { db } from "@/lib/db";
import { ruleProfiles, tournaments } from "@/lib/db/schema";
import { isPresetKey } from "@/lib/scoring/profile";
import { createTournament } from "@/lib/tournament/create";
import { FORMATS } from "@/lib/tournament/format";
import { parsePlayerNames } from "@/lib/tournament/setup";

export type ActionState = { error?: string; message?: string };

const format = z.enum(FORMATS as [string, ...string[]]).transform((f) => f as (typeof FORMATS)[number]);
const count = (fallback: number) => z.coerce.number().int().catch(fallback);

/** Creates a tournament from the New tournament form and opens it on the Desk, not started yet. */
export async function createTournamentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const organizer = await requireOrganizer();
  const field = (name: string) => String(form.get(name) ?? "");
  const finalFormat = format.safeParse(field("format"));
  if (!finalFormat.success) return { error: "Pick a format." };
  const groups = form.get("groupStage") === "on";
  const groupFormat = format.safeParse(field("groupFormat"));
  if (groups && !groupFormat.success) return { error: "Pick a format for the groups." };
  const rounds = field("swissRounds").trim();

  const created = await createTournament(organizer.id, {
    name: field("name"),
    format: finalFormat.data,
    players: parsePlayerNames(field("players").slice(0, 20_000)),
    grandFinal: field("grandFinal") === "single" ? "single" : "reset",
    thirdPlace: form.get("thirdPlace") === "on",
    roundRobinLegs: field("roundRobinLegs") === "2" ? 2 : 1,
    swissRounds: rounds ? count(0).parse(rounds) : null,
    groupStage: groups && groupFormat.success ? { format: groupFormat.data, groups: count(0).parse(field("groups")), advance: count(0).parse(field("advance")) } : null,
  });
  if ("error" in created) return { error: created.error };
  revalidatePath("/tournaments");
  redirect(`/tournaments/${created.id}`);
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
