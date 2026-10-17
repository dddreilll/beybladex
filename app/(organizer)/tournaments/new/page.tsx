import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { requireOrganizer } from "@/lib/auth";
import { TournamentForm } from "./tournament-form";

export const metadata: Metadata = { title: "New tournament" };

export default async function NewTournamentPage() {
  await requireOrganizer();
  return (
    <PageShell title="New tournament" subtitle="You can add players and change seeds on the Desk before you start it.">
      <div className="flex max-w-2xl flex-col gap-6">
        <TournamentForm />
      </div>
    </PageShell>
  );
}
