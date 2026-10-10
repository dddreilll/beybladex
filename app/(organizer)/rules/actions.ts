"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireOrganizer } from "@/lib/auth";
import { db } from "@/lib/db";
import { ruleProfiles } from "@/lib/db/schema";
import { ruleProfileSchema, type RuleProfile } from "@/lib/scoring/profile";

export type ProfileFormState = { error?: string };

const num = (v: FormDataEntryValue | null) => (v === null || v === "" ? NaN : Number(v));
const on = (v: FormDataEntryValue | null) => v === "on";

function parseProfile(form: FormData) {
  const candidate: RuleProfile = {
    name: String(form.get("name") ?? ""),
    points: {
      spin: num(form.get("spin")),
      over: num(form.get("over")),
      burst: num(form.get("burst")),
      xtreme: num(form.get("xtreme")),
    },
    ownFinishPoints: on(form.get("ownFinishEnabled")) ? num(form.get("ownFinishPoints")) : null,
    targetPoints: num(form.get("targetPoints")),
    bestOfSets: num(form.get("bestOfSets")),
    capAtTarget: on(form.get("capAtTarget")),
    launchErrorPenalty: on(form.get("launchErrorEnabled"))
      ? { strikes: num(form.get("launchErrorStrikes")), points: num(form.get("launchErrorPoints")) }
      : null,
    finals: on(form.get("finalsEnabled"))
      ? { targetPoints: num(form.get("finalsTargetPoints")), bestOfSets: num(form.get("finalsBestOfSets")) }
      : null,
  };
  return ruleProfileSchema.safeParse(candidate);
}

const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(" ") || "Profile"}: ${issue.message}` : "Check the fields and try again.";
};

export async function createProfileAction(_prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const organizer = await requireOrganizer();
  const parsed = parseProfile(form);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  await db.insert(ruleProfiles).values({ organizerId: organizer.id, name: parsed.data.name, config: parsed.data });
  revalidatePath("/rules");
  redirect("/rules");
}

export async function updateProfileAction(id: string, _prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const organizer = await requireOrganizer();
  const parsed = parseProfile(form);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  await db
    .update(ruleProfiles)
    .set({ name: parsed.data.name, config: parsed.data })
    .where(and(eq(ruleProfiles.id, z.uuid().parse(id)), eq(ruleProfiles.organizerId, organizer.id)));
  revalidatePath("/rules");
  redirect("/rules");
}

/** Tournaments using a deleted profile fall back to their preset (FK is ON DELETE SET NULL). */
export async function deleteProfileAction(id: string) {
  const organizer = await requireOrganizer();
  await db
    .delete(ruleProfiles)
    .where(and(eq(ruleProfiles.id, z.uuid().parse(id)), eq(ruleProfiles.organizerId, organizer.id)));
  revalidatePath("/rules");
  redirect("/rules");
}
