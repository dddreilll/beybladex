"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { setTournamentRulesAction, type ActionState } from "@/app/(organizer)/tournaments/actions";

type Option = { value: string; label: string };

const CHIPS: { key: "spin" | "over" | "burst" | "xtreme"; label: string; color: string }[] = [
  { key: "spin", label: "Spin", color: "#8EB1FF" },
  { key: "over", label: "Over", color: "#FBC54A" },
  { key: "burst", label: "Burst", color: "#FF8A8A" },
  { key: "xtreme", label: "Xtreme", color: "#C9B6FF" },
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
          className="text-sm font-semibold text-primary underline underline-offset-4"
        >
          {editing ? "Close" : "Edit"}
        </button>
      </div>
      <p className="font-semibold">{name}</p>
      <ul className="flex flex-wrap gap-2 text-sm font-semibold">
        {CHIPS.map((chip) => (
          <li key={chip.key} className="rounded-lg bg-secondary px-2.5 py-1" style={{ color: chip.color }}>
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
          <select id="rules" name="rules" defaultValue={current} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
            <optgroup label="Presets">
              {presets.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
            {profiles.length > 0 && (
              <optgroup label="Your profiles">
                {profiles.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
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
