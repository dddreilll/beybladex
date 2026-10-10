"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RuleProfile } from "@/lib/scoring/profile";
import type { ProfileFormState } from "./actions";

type Action = (prev: ProfileFormState, form: FormData) => Promise<ProfileFormState>;

const BEST_OF = [1, 3, 5, 7];

function NumberField({ id, label, defaultValue, min = 0, max = 20 }: { id: string; label: string; defaultValue: number; min?: number; max?: number }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} type="number" inputMode="numeric" min={min} max={max} required defaultValue={defaultValue} />
    </div>
  );
}

function BestOfField({ id, label, defaultValue }: { id: string; label: string; defaultValue: number }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        name={id}
        defaultValue={defaultValue}
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
      >
        {BEST_OF.map((n) => (
          <option key={n} value={n}>
            {n === 1 ? "Single set" : `Best of ${n} sets`}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ id, label, defaultChecked, children }: { id: string; label: string; defaultChecked: boolean; children?: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border p-4">
      <label htmlFor={id} className="flex items-center gap-3 font-semibold">
        <input id={id} name={id} type="checkbox" defaultChecked={defaultChecked} className="size-5 accent-[hsl(var(--primary))]" />
        {label}
      </label>
      {children && <div className="grid gap-3 sm:grid-cols-2">{children}</div>}
    </fieldset>
  );
}

export function ProfileForm({ action, initial, submitLabel }: { action: Action; initial: RuleProfile; submitLabel: string }) {
  const [state, formAction] = useActionState(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="grid gap-1.5">
        <Label htmlFor="name">Profile name</Label>
        <Input id="name" name="name" required maxLength={60} defaultValue={initial.name} />
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-display text-lg font-semibold">Points per finish</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberField id="spin" label="Spin" defaultValue={initial.points.spin} max={10} />
          <NumberField id="over" label="Over" defaultValue={initial.points.over} max={10} />
          <NumberField id="burst" label="Burst" defaultValue={initial.points.burst} max={10} />
          <NumberField id="xtreme" label="Xtreme" defaultValue={initial.points.xtreme} max={10} />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-display text-lg font-semibold">Match length</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField id="targetPoints" label="Points to win a set" defaultValue={initial.targetPoints} min={1} />
          <BestOfField id="bestOfSets" label="Sets" defaultValue={initial.bestOfSets} />
        </div>
      </fieldset>

      <Toggle id="finalsEnabled" label="Different length for the finals (Grand Finals / Final)" defaultChecked={Boolean(initial.finals)}>
        <NumberField id="finalsTargetPoints" label="Points to win a set" defaultValue={initial.finals?.targetPoints ?? initial.targetPoints} min={1} />
        <BestOfField id="finalsBestOfSets" label="Sets" defaultValue={initial.finals?.bestOfSets ?? 3} />
      </Toggle>

      <Toggle id="launchErrorEnabled" label="Launch errors give the opponent points" defaultChecked={Boolean(initial.launchErrorPenalty)}>
        <NumberField id="launchErrorStrikes" label="Launch errors per penalty" defaultValue={initial.launchErrorPenalty?.strikes ?? 2} min={1} max={5} />
        <NumberField id="launchErrorPoints" label="Points to the opponent" defaultValue={initial.launchErrorPenalty?.points ?? 1} min={1} max={5} />
      </Toggle>

      <Toggle id="ownFinishEnabled" label="Own finish button (opponent launched straight into a pocket)" defaultChecked={initial.ownFinishPoints != null}>
        <NumberField id="ownFinishPoints" label="Points awarded" defaultValue={initial.ownFinishPoints ?? 1} min={1} max={10} />
      </Toggle>

      <Toggle id="capAtTarget" label="Report set scores capped at the target (e.g. 4–2 instead of 5–2)" defaultChecked={initial.capAtTarget} />

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div>
        <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
