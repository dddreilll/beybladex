import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { DEFAULT_PRESET, isPresetKey, PRESETS } from "@/lib/scoring/profile";
import { createProfileAction } from "../actions";
import { ProfileForm } from "../profile-form";

export const metadata: Metadata = { title: "New rule profile" };

export default async function NewProfilePage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  const preset = PRESETS[from && isPresetKey(from) ? from : DEFAULT_PRESET];

  return (
    <PageShell
      title="New rule profile"
      subtitle={`Starting from “${preset.name}”`}
    >
      <div className="flex max-w-2xl flex-col gap-6">
        <ProfileForm action={createProfileAction} initial={{ ...preset, name: `${preset.name} (custom)` }} submitLabel="Create profile" />
      </div>
    </PageShell>
  );
}
