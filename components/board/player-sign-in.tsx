"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Search } from "lucide-react";
import type { BoardPlayer } from "@/lib/board";
import { signIn, useQrSignIn } from "./player-session";

/**
 * What a phone shows until its player has signed in: pick your name, then type the 4-digit
 * passcode from your slip. Scanning the slip's QR code skips both steps.
 */
export function PlayerSignIn({ slug, tournament, players, replaced }: { slug: string; tournament: string; players: BoardPlayer[]; replaced: boolean }) {
  const router = useRouter();
  const qr = useQrSignIn(slug);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<BoardPlayer | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!chosen || code.length !== 4 || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await signIn(slug, { playerId: chosen.id, code });
    if (outcome.ok) {
      // The server now renders this player's page; stay "busy" until it replaces this screen.
      router.refresh();
      return;
    }
    setBusy(false);
    setCode("");
    setError(outcome.error);
  };

  if (qr.working) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-2 p-5">
        <p className="text-sm text-muted-foreground">{tournament}</p>
        <p role="status" className="font-display text-2xl font-bold">
          Signing you in…
        </p>
      </main>
    );
  }

  const notices = (
    <>
      {replaced && (
        <p role="status" className="rounded-xl bg-warning-muted p-4 text-sm text-warning">
          You signed in on another device, so this one was signed out. Sign in here to move back.
        </p>
      )}
      {qr.error && (
        <p role="alert" className="rounded-xl bg-destructive/15 p-4 text-sm text-destructive">
          {qr.error}
        </p>
      )}
    </>
  );

  if (chosen) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col gap-5 p-5">
        <header>
          <p className="text-sm text-muted-foreground">BXQ Pass · {tournament}</p>
          <h1 className="font-display text-3xl font-bold">Hi, {chosen.name}</h1>
        </header>
        {notices}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="passcode" className="text-lg font-semibold">
            Enter your 4-digit passcode
          </label>
          <input
            id="passcode"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            aria-describedby="passcode-help"
            aria-invalid={error ? true : undefined}
            className="h-16 rounded-xl border bg-card text-center font-display text-4xl font-bold tracking-[0.4em] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p id="passcode-help" className="text-sm text-muted-foreground">
            It&apos;s on the slip the organizer gave you. No slip? Ask at the organizer&apos;s table.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={code.length !== 4 || busy}
            className="min-h-12 rounded-xl bg-primary text-lg font-bold text-primary-foreground disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Open my Pass"}
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setChosen(null);
            setCode("");
            setError(null);
          }}
          className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground underline underline-offset-4"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Not {chosen.name}? Pick another name
        </button>
      </main>
    );
  }

  const matches = players.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-5 p-5">
      <header>
        <p className="text-sm text-muted-foreground">BXQ Pass · {tournament}</p>
        <h1 className="font-display text-3xl font-bold">Who are you?</h1>
      </header>
      {notices}
      <label className="flex items-center gap-2 rounded-xl border bg-card px-3">
        <Search className="size-4 text-muted-foreground" aria-hidden />
        <span className="sr-only">Search your name</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your name"
          className="h-12 flex-1 bg-transparent outline-none"
        />
      </label>
      <ul className="flex flex-col gap-2">
        {matches.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => setChosen(p)}
              className="w-full rounded-xl border bg-card px-4 py-3 text-left text-lg font-semibold"
            >
              {p.name}
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className="text-muted-foreground">No player matches “{query}”.</li>}
      </ul>
    </main>
  );
}
