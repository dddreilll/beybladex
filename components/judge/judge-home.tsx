"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useJudgeFeed } from "@/components/board/use-board";
import type { JudgeMatch, JudgeSnapshot } from "@/lib/judges";
import { flushOutbox, getOutbox } from "@/lib/offline/client";
import { needsWork } from "@/lib/offline/outbox";

/**
 * An approved judge tablet between matches. It follows its stadium: when a match is called
 * there, the pad opens by itself. `stay` (arriving through the pad's back link) keeps the match
 * that is already here from re-opening at once.
 */
export function JudgeHome({ slug, initial, stay }: { slug: string; initial: JudgeSnapshot; stay: boolean }) {
  const router = useRouter();
  const { snapshot, online, denied } = useJudgeFeed(slug, initial);
  const padHref = (matchId: string) => `/t/${slug}/judge/${matchId}`;

  // The organizer disconnected this device: back to sign-up, which explains. Not while the judge
  // is leaving by their own choice: that has its own message.
  const leaving = useRef(false);
  useEffect(() => {
    if (denied && !leaving.current) window.location.replace(`/t/${slug}/judge?disconnected=1`);
  }, [denied, slug]);

  const skip = useRef(stay ? (initial.now?.id ?? null) : null);
  const currentId = snapshot.now?.id ?? null;
  useEffect(() => {
    if (currentId && currentId !== skip.current) router.push(`/t/${slug}/judge/${currentId}`);
  }, [currentId, slug, router]);

  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm text-muted-foreground">{snapshot.tournament}</p>
          <h1 className="font-display text-3xl font-bold">Judge · {snapshot.stadium}</h1>
          <JudgeName slug={slug} name={snapshot.judge} />
        </div>
        <span className={`flex shrink-0 items-center gap-2 pt-1 text-sm font-semibold ${online ? "text-success" : "text-warning"}`} role="status">
          <span className={`size-2.5 rounded-full ${online ? "bg-success" : "bg-warning"}`} aria-hidden />
          {online ? "Live" : "Reconnecting…"}
        </span>
      </header>

      {snapshot.now ? (
        <section aria-label="Current match" className="flex flex-col gap-3 rounded-2xl bg-primary p-5 text-primary-foreground">
          <span className="text-sm font-bold uppercase tracking-widest">{snapshot.now.status === "playing" ? "Being played" : "Called to your stadium"}</span>
          <span className="font-display text-3xl font-bold leading-tight">{snapshot.now.players}</span>
          <span>{snapshot.now.label}</span>
          <Link href={padHref(snapshot.now.id)} className="mt-1 flex min-h-14 items-center justify-center rounded-xl bg-background font-display text-xl font-bold text-foreground">
            Open the pad
          </Link>
        </section>
      ) : (
        <section aria-label="Current match" className="flex flex-col gap-2 rounded-2xl border bg-card p-5">
          <span className="font-display text-2xl font-bold">Waiting for the next match</span>
          <span className="text-muted-foreground">The pad opens by itself when a match is called to {snapshot.stadium}. Keep this screen open.</span>
        </section>
      )}

      <section aria-label="On deck" className="flex flex-col gap-1">
        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">On deck</span>
        {snapshot.next ? (
          <>
            <span className="text-lg font-semibold">{snapshot.next.players}</span>
            <span className="text-sm text-muted-foreground">{snapshot.next.label}</span>
          </>
        ) : (
          <span className="text-muted-foreground">Nobody yet.</span>
        )}
      </section>

      <LeaveStadium
        slug={slug}
        stadium={snapshot.stadium}
        name={snapshot.judge}
        match={snapshot.now}
        onLeaving={(value) => {
          leaving.current = value;
        }}
      />
    </main>
  );
}

/**
 * Lets a judge give up their stadium, for example to hand over to someone else. Only the judge
 * goes: the match and its score stay, so whoever judges next carries on from the same point.
 * That is also why leaving waits for this device's unsent taps: once it is no longer the
 * stadium's judge, they could never be saved.
 */
function LeaveStadium({
  slug,
  stadium,
  name,
  match,
  onLeaving,
}: {
  slug: string;
  stadium: string;
  /** Carried to the sign-up screen, so the judge doesn't have to type it again. */
  name: string;
  match: JudgeMatch | null;
  onLeaving: (leaving: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Why this device can't leave yet, if it still holds taps or a result the server hasn't got. */
  const unsaved = async (): Promise<string | null> => {
    const outbox = getOutbox();
    await outbox.init();
    // Work for a match that is no longer at this stadium can't be sent whatever happens.
    const waiting = () => outbox.all().filter((record) => needsWork(record) && record.problem?.kind !== "not_found");
    if (waiting().length) await flushOutbox().catch(() => {});
    const left = waiting();
    if (left.length === 0) return null;
    const taps = left.reduce((total, record) => total + record.queue.length, 0);
    return taps > 0 ? `${taps} tap${taps === 1 ? " is" : "s are"} still saving. Reconnect, then try again.` : "A result is still being sent. Reconnect, then try again.";
  };

  const leave = async () => {
    setConfirming(false);
    setBusy(true);
    onLeaving(true);
    try {
      const res = await fetch(`/api/public/${slug}/judge`, { method: "DELETE" });
      if (res.ok) return window.location.replace(`/t/${slug}/judge?left=${encodeURIComponent(stadium)}&as=${encodeURIComponent(name)}`);
      // Already disconnected by the organizer: the sign-up screen says so.
      if (res.status === 401) return window.location.replace(`/t/${slug}/judge?disconnected=1`);
      setError("Couldn't leave the stadium. Try again.");
    } catch {
      setError("Couldn't reach the server. Check this device's connection.");
    }
    onLeaving(false);
    setBusy(false);
  };

  const ask = async () => {
    setError(null);
    setBusy(true);
    const blocked = await unsaved();
    setBusy(false);
    if (blocked) return setError(blocked);
    // With a match here, players and the organizer are counting on a judge: make sure.
    if (match) setConfirming(true);
    else await leave();
  };

  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      <button
        type="button"
        disabled={busy}
        onClick={() => void ask()}
        className="min-h-11 self-start text-sm text-muted-foreground underline underline-offset-4 disabled:opacity-60"
      >
        {busy ? "Checking…" : "Leave this stadium"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {confirming && match && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="leave-title" className="flex w-full max-w-md flex-col gap-4 rounded-2xl border bg-card p-6">
            <h2 id="leave-title" className="font-display text-2xl font-bold">
              Leave {stadium}?
            </h2>
            <p className="text-muted-foreground">
              <strong className="text-foreground">{match.players}</strong> {match.status === "playing" ? "is being played" : "has been called"} here. The score stays as it
              is: the next judge, or the organizer, carries on from the same point.
            </p>
            {match.status === "called" && <p className="text-sm text-muted-foreground">The match can&apos;t start until this stadium has a judge again.</p>}
            <div className="flex flex-wrap gap-3">
              <button type="button" autoFocus onClick={() => setConfirming(false)} className="min-h-12 flex-1 rounded-xl border bg-secondary font-semibold">
                Stay
              </button>
              <button type="button" onClick={() => void leave()} className="min-h-12 flex-1 rounded-xl bg-destructive font-bold text-destructive-foreground">
                Leave stadium
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The name the organizer sees for this judge, with a way to change it. */
function JudgeName({ slug, name }: { slug: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown until the feed catches up; a later change by the organizer replaces it again.
  const [saved, setSaved] = useState<{ over: string; name: string } | null>(null);
  const shown = saved && saved.over === name ? saved.name : name;

  const save = async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/${slug}/judge`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      const body = (await res.json().catch(() => null)) as { name?: string; error?: string } | null;
      if (res.ok && body?.name) {
        setSaved({ over: name, name: body.name });
        setEditing(false);
      } else setError(body?.error ?? "Couldn't save the name. Try again.");
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
    setBusy(false);
  };

  if (!editing) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-3 text-muted-foreground">
        <span>
          Judging as <strong className="text-foreground">{shown}</strong>
        </span>
        <button type="button" onClick={() => setEditing(true)} className="min-h-11 text-sm underline underline-offset-4">
          Rename
        </button>
      </p>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save(String(new FormData(event.currentTarget).get("name") ?? ""));
      }}
    >
      <label htmlFor="judge-name" className="text-sm font-semibold">
        Your name
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="judge-name"
          name="name"
          defaultValue={shown}
          maxLength={30}
          autoComplete="off"
          autoFocus
          className="h-11 min-w-0 flex-1 rounded-lg border bg-card px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-primary px-4 font-bold text-primary-foreground disabled:opacity-60">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setEditing(false)} className="min-h-11 rounded-lg border px-4 font-semibold">
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
