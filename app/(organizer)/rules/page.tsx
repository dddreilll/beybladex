import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { requireOrganizer } from "@/lib/auth";
import { db } from "@/lib/db";
import { ruleProfiles } from "@/lib/db/schema";
import { describeProfile } from "@/lib/scoring/describe";
import { PRESETS } from "@/lib/scoring/profile";

export const metadata: Metadata = { title: "Rule profiles" };

export default async function RulesPage() {
  const organizer = await requireOrganizer();
  const own = await db.select().from(ruleProfiles).where(eq(ruleProfiles.organizerId, organizer.id)).orderBy(asc(ruleProfiles.name));

  return (
    <PageShell title="Rule profiles">
      <div className="flex flex-col gap-8">
        <p className="max-w-3xl text-muted-foreground">
          How battles are scored. Pick one per tournament in its BXQ Desk. Presets follow common community setups; check your
          event&apos;s rulebook and make your own if it differs.
        </p>

        <section aria-labelledby="own-heading" className="flex flex-col gap-3">
          <h2 id="own-heading" className="font-display text-xl font-semibold">
            Your profiles
          </h2>
          {own.length === 0 ? (
            <p className="text-muted-foreground">None yet. Start from a preset below.</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {own.map((p) => (
                <li key={p.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
                  <span className="font-display text-lg font-semibold">{p.name}</span>
                  <span className="text-sm text-muted-foreground">{describeProfile(p.config)}</span>
                  <div>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/rules/${p.id}`}>Edit</Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="presets-heading" className="flex flex-col gap-3">
          <h2 id="presets-heading" className="font-display text-xl font-semibold">
            Presets
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {Object.entries(PRESETS).map(([key, preset]) => (
              <li key={key} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
                <span className="font-display text-lg font-semibold">{preset.name}</span>
                <span className="text-sm text-muted-foreground">{describeProfile(preset)}</span>
                <div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/rules/new?from=${key}`}>Copy and customise</Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageShell>
  );
}
