"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setTournamentRulesAction, type ActionState } from "@/app/(organizer)/tournaments/actions";

type Option = { value: string; label: string };

// Each finish keeps its hue everywhere; the pastel shades are for dark backgrounds, so light mode
// uses a darker shade of the same hue on a tinted chip.
const CHIPS: { key: "spin" | "over" | "burst" | "xtreme"; label: string; className: string }[] = [
  { key: "spin", label: "Spin", className: "bg-[#1D4ED8]/10 text-[#1D4ED8] dark:bg-secondary dark:text-[#8EB1FF]" },
  { key: "over", label: "Over", className: "bg-[#B45309]/10 text-[#92400E] dark:bg-secondary dark:text-[#FBC54A]" },
  { key: "burst", label: "Burst", className: "bg-[#B91C1C]/10 text-[#B91C1C] dark:bg-secondary dark:text-[#FF8A8A]" },
  { key: "xtreme", label: "Xtreme", className: "bg-[#6D28D9]/10 text-[#6D28D9] dark:bg-secondary dark:text-[#C9B6FF]" },
];

/** The mockup's rule profile card: a summary, with the picker behind "Edit". */
export function RuleCard({
  tournamentId,
  current,
  presets,
  profiles,
  name,
  points,
  details,
}: {
  tournamentId: string;
  current: string;
  presets: Option[];
  profiles: Option[];
  name: string;
  points: Record<"spin" | "over" | "burst" | "xtreme", number>;
  details: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [state, action] = useActionState<ActionState, FormData>(setTournamentRulesAction.bind(null, tournamentId), {});

  return (
    <section aria-labelledby="rules-heading" className="flex flex-col gap-3 rounded-2xl border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="rules-heading" className="font-display text-lg font-semibold">
          Rule profile
        </h2>
        <button
          type="button"
          aria-expanded={editing}
          onClick={() => setEditing((e) => !e)}
          className="text-sm font-semibold text-primary-text underline underline-offset-4"
        >
          {editing ? "Close" : "Edit"}
        </button>
      </div>
      <p className="font-semibold">{name}</p>
      <ul className="flex flex-wrap gap-2 text-sm font-semibold">
        {CHIPS.map((chip) => (
          <li key={chip.key} className={`rounded-lg px-2.5 py-1 ${chip.className}`}>
            {chip.label} {points[chip.key]}
          </li>
        ))}
      </ul>
      {details.map((line) => (
        <p key={line} className="text-sm text-muted-foreground">
          {line}
        </p>
      ))}

      {editing && (
        <form action={action} className="flex flex-col gap-2 border-t pt-3">
          <label htmlFor="rules" className="text-sm font-semibold">
            Use these rules
          </label>
          <Select name="rules" defaultValue={current}>
            <SelectTrigger id="rules">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Presets</SelectLabel>
                {presets.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
              {profiles.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Your profiles</SelectLabel>
                  {profiles.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Matches that already started scoring keep the rules they started with.</p>
          <div className="flex items-center gap-3">
            <SubmitButton size="sm" pendingLabel="Saving…">
              Save
            </SubmitButton>
            <Link href="/rules" className="text-sm font-semibold underline underline-offset-4">
              Manage profiles
            </Link>
          </div>
          <span aria-live="polite" className="text-sm">
            {state.error ? <span className="text-destructive">{state.error}</span> : state.message}
          </span>
        </form>
      )}
    </section>
  );
}
