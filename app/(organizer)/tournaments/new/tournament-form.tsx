"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FORMATS, formatName, type Format } from "@/lib/tournament/format";
import { parsePlayerNames } from "@/lib/tournament/setup";
import { createTournamentAction, type ActionState } from "../actions";

function FormatSelect({ id, value, onChange }: { id: string; value: Format; onChange: (format: Format) => void }) {
  return (
    <Select name={id} value={value} onValueChange={(v) => onChange(v as Format)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FORMATS.map((format) => (
          <SelectItem key={format} value={format}>
            {formatName(format)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NumberField({ id, label, hint, defaultValue, min, max, required = true }: { id: string; label: string; hint?: string; defaultValue?: number; min: number; max: number; required?: boolean }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} type="number" inputMode="numeric" min={min} max={max} required={required} defaultValue={defaultValue} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The New tournament form: name, format and its options, an optional group stage, and the players
 * if the organizer has them already. Only the options of the chosen formats are shown.
 */
export function TournamentForm() {
  const [state, action] = useActionState<ActionState, FormData>(createTournamentAction, {});
  const [format, setFormat] = useState<Format>("double_elimination");
  const [groups, setGroups] = useState(false);
  const [groupFormat, setGroupFormat] = useState<Format>("round_robin");
  const [players, setPlayers] = useState("");
  const count = parsePlayerNames(players).length;
  const roundRobin = format === "round_robin" || (groups && groupFormat === "round_robin");

  return (
    <form action={action} className="flex flex-col gap-6">
      <div className="grid gap-1.5">
        <Label htmlFor="name">Tournament name</Label>
        <Input id="name" name="name" required maxLength={100} placeholder="Autumn Clash" />
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-display text-lg font-semibold">Format</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="format">{groups ? "Final stage" : "Format"}</Label>
            <FormatSelect id="format" value={format} onChange={setFormat} />
          </div>
          {format === "double_elimination" && (
            <div className="grid gap-1.5">
              <Label htmlFor="grandFinal">Grand final</Label>
              <Select name="grandFinal" defaultValue="reset">
                <SelectTrigger id="grandFinal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reset">A reset if the losers-bracket player wins</SelectItem>
                  <SelectItem value="single">One match</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {format === "swiss" && (
            <NumberField id="swissRounds" label="Rounds" hint="Leave empty for the suggested number for your players." min={1} max={20} required={false} />
          )}
          {roundRobin && (
            <div className="grid gap-1.5">
              <Label htmlFor="roundRobinLegs">Each pair meets</Label>
              <Select name="roundRobinLegs" defaultValue="1">
                <SelectTrigger id="roundRobinLegs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Once</SelectItem>
                  <SelectItem value="2">Twice</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {format === "single_elimination" && (
          <label htmlFor="thirdPlace" className="flex items-center gap-3 font-semibold">
            <input id="thirdPlace" name="thirdPlace" type="checkbox" className="size-5 accent-[hsl(var(--primary))]" />
            Third-place match
          </label>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border p-4">
        <label htmlFor="groupStage" className="flex items-center gap-3 font-semibold">
          <input
            id="groupStage"
            name="groupStage"
            type="checkbox"
            checked={groups}
            onChange={(e) => setGroups(e.target.checked)}
            className="size-5 accent-[hsl(var(--primary))]"
          />
          Start with a group stage
        </label>
        {groups && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="groupFormat">Groups play</Label>
              <FormatSelect id="groupFormat" value={groupFormat} onChange={setGroupFormat} />
            </div>
            <NumberField id="groups" label="Groups" defaultValue={2} min={2} max={32} />
            <NumberField id="advance" label="Go through per group" defaultValue={2} min={1} max={64} />
          </div>
        )}
        {groups && <p className="text-sm text-muted-foreground">Players are spread over the groups by seed. The best of each group go through to the final stage.</p>}
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor="players">Players, in seed order</Label>
        <textarea
          id="players"
          name="players"
          rows={8}
          value={players}
          onChange={(e) => setPlayers(e.target.value)}
          placeholder={"Alex, Sam, Riley\nor one per line"}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {count === 0 ? "Optional: you can add players on the Desk too." : `${count} player${count === 1 ? "" : "s"}. The first is seed 1.`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <SubmitButton pendingLabel="Creating…">Create tournament</SubmitButton>
        <span aria-live="polite" className="text-sm text-destructive empty:hidden">
          {state.error}
        </span>
      </div>
    </form>
  );
}
