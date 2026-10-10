import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { PageShell } from "@/components/page-shell";
import { SubmitButton } from "@/components/submit-button";
import { requireOrganizer } from "@/lib/auth";
import { db } from "@/lib/db";
import { ruleProfiles } from "@/lib/db/schema";
import { deleteProfileAction, updateProfileAction } from "../actions";
import { ProfileForm } from "../profile-form";

export const metadata: Metadata = { title: "Edit rule profile" };

export default async function EditProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const organizer = await requireOrganizer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [profile] = await db
    .select()
    .from(ruleProfiles)
    .where(and(eq(ruleProfiles.id, id), eq(ruleProfiles.organizerId, organizer.id)))
    .limit(1);
  if (!profile) notFound();

  return (
    <PageShell
      title={profile.name}
      subtitle="Changes apply to matches that haven't started scoring yet"
    >
      <div className="flex max-w-2xl flex-col gap-6">
        <ProfileForm action={updateProfileAction.bind(null, profile.id)} initial={profile.config} submitLabel="Save changes" />
        <form action={deleteProfileAction.bind(null, profile.id)} className="border-t pt-6">
          <SubmitButton variant="outline" pendingLabel="Deleting…">
            Delete profile
          </SubmitButton>
          <p className="mt-2 text-sm text-muted-foreground">Tournaments using it go back to their preset.</p>
        </form>
      </div>
    </PageShell>
  );
}
