"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition } from "react";
import { MonitorCheck, Printer } from "lucide-react";
import { startChecks } from "@/components/board/board-signal";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AccessOverview, JudgeInfo } from "@/lib/access";
import { cn } from "@/lib/utils";
import { approveJudgeAction, approveScreenAction, removeJudgeAction, removeScreenAction, resetPlayerAction } from "./access-actions";
import { addLatePlayerAction, dropPlayerAction } from "./setup-actions";
import type { VenueState } from "./venue-actions";

const AccessContext = createContext<AccessOverview | null>(null);

function useAccess(): AccessOverview {
  const access = useContext(AccessContext);
  if (!access) throw new Error("Access panels must be inside <AccessProvider>.");
  return access;
}

/**
 * Keeps "which boards are open, who is signed in" current for the panels below. A screen checking
 * in doesn't change the board, so the page isn't re-rendered for it: this asks every few seconds.
 */
export function AccessProvider({ tournamentId, initial, children }: { tournamentId: string; initial: AccessOverview; children: React.ReactNode }) {
  const [polled, setPolled] = useState<AccessOverview | null>(null);
  useEffect(() => {
    const checks = startChecks(async () => {
      try {
        const res = await fetch(`/api/tournaments/${tournamentId}/access`, { cache: "no-store" });
        if (res.ok) setPolled((await res.json()) as AccessOverview);
      } catch {}
    }, 8000);
    return checks.stop;
  }, [tournamentId]);
  // After an action the page re-renders with a newer copy than the last poll: show whichever is newer.
  return <AccessContext.Provider value={polled && polled.at > initial.at ? polled : initial}>{children}</AccessContext.Provider>;
}

/** A stadium's judge and any tablet asking to judge it, for the stadium's card. */
export function useStadiumJudge(stadiumId: string): { judge: JudgeInfo | null; asking: number } {
  const { judges } = useAccess();
  const here = judges.filter((j) => j.stadiumId === stadiumId);
  return { judge: here.find((j) => j.status === "approved") ?? null, asking: here.filter((j) => j.status === "pending").length };
}

/**
 * A link short enough to read out or type on a TV, shown large and without "https://". Clicking
 * it copies the full address (it doesn't open the page: that is for the TV or the tablet). A
 * tooltip says so on hover or focus, and confirms the copy.
 */
function CopyLink({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // No clipboard access (a plain-http address on the venue network): copy the old way.
      const field = document.createElement("textarea");
      field.value = url;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  // If the address doesn't fit on one line, break it before the path rather than mid-word.
  const shown = url.replace(/^https?:\/\//, "");
  const cut = shown.indexOf("/");
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <TooltipProvider delayDuration={150}>
        {/* A click would normally close the tooltip; it stays up to say "Copied". */}
        <Tooltip open={hovered || copied} onOpenChange={setHovered}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void copy()}
              className="max-w-full text-left font-display text-xl font-bold leading-tight underline-offset-4 [overflow-wrap:anywhere] hover:underline"
            >
              {cut < 0 ? shown : shown.slice(0, cut)}
              <wbr />
              {cut < 0 ? "" : shown.slice(cut)}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="start">
            {copied ? "Copied" : "Click to copy"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span aria-live="polite" className="sr-only">
        {copied ? "Link copied" : ""}
      </span>
    </div>
  );
}

/** Runs a server action and shows what it answered for a few seconds. */
function useFeedback() {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<VenueState>({});
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clearTimer.current), []);
  const run = (action: () => Promise<VenueState>) =>
    startTransition(async () => {
      setFeedback(await action());
      clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setFeedback({}), 8000);
    });
  return { pending, feedback, run };
}

const outlineButton = "min-h-9 rounded-md border px-3 text-sm font-semibold disabled:opacity-60";

/** Screens asking to show the call board, and the ones already showing it. */
export function BoardsPanel({ tournamentId, link }: { tournamentId: string; link: string }) {
  const { boards, limit } = useAccess();
  const { pending, feedback, run } = useFeedback();
  const waiting = boards.filter((b) => b.status === "pending");
  const approved = boards.filter((b) => b.status === "approved");
  const full = approved.length >= limit;

  return (
    <section
      aria-labelledby="boards-heading"
      className={cn("flex flex-col gap-3 rounded-2xl border bg-card p-5", waiting.length > 0 && "border-primary-text")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="boards-heading" className="font-display text-lg font-semibold">
          BXQ Boards
        </h2>
        <span className="text-sm font-semibold tabular-nums text-muted-foreground">
          {approved.length} of {limit}
        </span>
      </div>

      <CopyLink label="Board link" url={link} />
      {boards.length === 0 && (
        <p className="text-sm text-muted-foreground">No screen is showing the board.</p>
      )}

      {waiting.length > 0 && (
        <ul aria-label="Waiting for approval" className="flex flex-col gap-2">
          {waiting.map((screen) => (
            <li key={screen.id} className="flex flex-col gap-2 rounded-lg bg-secondary px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-display text-xl font-bold tracking-[0.15em]">{screen.code}</span>
                <span className="text-xs font-bold uppercase tracking-wider text-primary-text">Wants access</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {screen.device} · {screen.since}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending || full}
                  onClick={() => run(() => approveScreenAction(tournamentId, screen.id))}
                  aria-label={`Approve screen ${screen.code}`}
                  className="min-h-9 flex-1 rounded-md bg-primary px-3 text-sm font-bold text-primary-foreground disabled:opacity-60"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => removeScreenAction(tournamentId, screen.id))}
                  aria-label={`Decline screen ${screen.code}`}
                  className={outlineButton}
                >
                  Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {waiting.length > 0 && full && (
        <p className="text-sm text-warning">
          The limit of {limit} is reached. Disconnect a board below, or raise the limit in Venue settings.
        </p>
      )}

      {approved.length > 0 && (
        <ul aria-label="Showing the board" className="flex flex-col gap-2 text-sm">
          {approved.map((screen) => (
            <li key={screen.id} className="flex items-center gap-3 rounded-lg bg-secondary px-3 py-2.5">
              <MonitorCheck className={cn("size-5 shrink-0", screen.open ? "text-success" : "text-muted-foreground")} aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">{screen.device}</span>
                <span className="text-xs text-muted-foreground">
                  {screen.open ? "Open now" : `Not open · last seen ${screen.seen}`} · {screen.since}
                </span>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => removeScreenAction(tournamentId, screen.id))}
                aria-label={`Disconnect ${screen.device}`}
                className={outlineButton}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}

      <p aria-live="polite" className={cn("text-sm empty:hidden", feedback.error ? "text-destructive" : "text-muted-foreground")}>
        {pending ? "Working…" : (feedback.error ?? feedback.message ?? "")}
      </p>
    </section>
  );
}

/** The judge link, and tablets asking to judge a stadium. Each stadium's card shows its judge. */
export function JudgesPanel({ tournamentId, link, stadiums }: { tournamentId: string; link: string; stadiums: number }) {
  const { judges } = useAccess();
  const { pending, feedback, run } = useFeedback();
  const waiting = judges.filter((j) => j.status === "pending");
  const approved = judges.filter((j) => j.status === "approved");
  const taken = new Set(approved.map((j) => j.stadiumId));

  return (
    <section
      aria-labelledby="judges-heading"
      className={cn("flex flex-col gap-3 rounded-2xl border bg-card p-5", waiting.length > 0 && "border-primary-text")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="judges-heading" className="font-display text-lg font-semibold">
          Judges
        </h2>
        <span className="text-sm font-semibold tabular-nums text-muted-foreground">
          {taken.size} of {stadiums} stadium{stadiums === 1 ? "" : "s"}
        </span>
      </div>

      <CopyLink label="Judge link" url={link} />
      {waiting.length === 0 && (
        <p className="text-sm text-muted-foreground">
          A judge opens this link on their device and picks a stadium.
        </p>
      )}

      {waiting.length > 0 && (
        <ul aria-label="Waiting for approval" className="flex flex-col gap-2">
          {waiting.map((judge) => {
            const blocked = taken.has(judge.stadiumId);
            return (
              <li key={judge.id} className="flex flex-col gap-2 rounded-lg bg-secondary px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-display text-xl font-bold tracking-[0.15em]">{judge.code}</span>
                  <span className="text-xs font-bold uppercase tracking-wider text-primary-text">Wants to judge</span>
                </div>
                <span className="font-semibold">{judge.stadium}</span>
                <span className="text-xs text-muted-foreground">
                  {judge.name} · {judge.since}
                </span>
                {blocked && <span className="text-sm text-warning">{judge.stadium} already has a judge. Disconnect that one first, from the stadium&apos;s menu.</span>}
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending || blocked}
                    onClick={() => run(() => approveJudgeAction(tournamentId, judge.id))}
                    aria-label={`Approve judge ${judge.code}, ${judge.name}, for ${judge.stadium}`}
                    className="min-h-9 flex-1 rounded-md bg-primary px-3 text-sm font-bold text-primary-foreground disabled:opacity-60"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => removeJudgeAction(tournamentId, judge.id))}
                    aria-label={`Decline judge ${judge.code}`}
                    className={outlineButton}
                  >
                    Decline
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p aria-live="polite" className={cn("text-sm empty:hidden", feedback.error ? "text-destructive" : "text-muted-foreground")}>
        {pending ? "Working…" : (feedback.error ?? feedback.message ?? "")}
      </p>
    </section>
  );
}

export type PlayerRow = { id: string; name: string; passcode: string; dropped: boolean };

/** Every player's passcode, whether they are signed in, and a way to issue a new one. */
/**
 * Every player with their passcode and device. Once the tournament runs, a player can be dropped
 * (`canDrop`), and in a running Swiss a player who arrived late can join (`lateEntry`).
 */
export function PlayersPanel({
  tournamentId,
  players,
  printHref,
  canDrop = false,
  lateEntry = false,
}: {
  tournamentId: string;
  players: PlayerRow[];
  printHref: string;
  canDrop?: boolean;
  lateEntry?: boolean;
}) {
  const { players: sessions } = useAccess();
  const { pending, feedback, run } = useFeedback();
  const [dropping, setDropping] = useState<string | null>(null);
  const [late, setLate] = useState("");
  const signedIn = players.filter((p) => sessions[p.id]).length;

  return (
    <details className="rounded-2xl border bg-card">
      <summary className="cursor-pointer px-5 py-4 font-display text-lg font-semibold">
        Players and passcodes{" "}
        <span className="text-muted-foreground">
          ({signedIn} of {players.length} signed in)
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-sm text-muted-foreground">
            Each player opens their page with their own passcode, on one device at a time. Signing in on another device moves them there.
          </p>
          <a
            href={printHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold"
          >
            <Printer className="size-4" aria-hidden />
            Print passcode slips
          </a>
        </div>
        {players.length === 0 ? (
          <p className="text-sm text-muted-foreground">No players yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-semibold">Player</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Passcode</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Their device</th>
                  <th scope="col" className="w-0 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {players.map((player) => {
                  const session = sessions[player.id];
                  return (
                    <tr key={player.id} className="border-t">
                      <th scope="row" className="py-2.5 pr-4 text-left font-semibold">
                        {player.name}
                        {player.dropped && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">Dropped</span>}
                      </th>
                      <td className="py-2.5 pr-4 font-display text-base font-bold tracking-[0.2em] tabular-nums">{player.passcode}</td>
                      <td className="py-2.5 pr-4 text-muted-foreground">
                        {session ? (
                          <>
                            <span className={session.open ? "font-semibold text-success" : undefined}>{session.open ? "Open now" : `Last seen ${session.seen}`}</span>
                            {" · "}
                            {session.device}
                          </>
                        ) : (
                          "Not signed in"
                        )}
                      </td>
                      <td className="py-1.5">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => run(() => resetPlayerAction(tournamentId, player.id))}
                            aria-label={`New passcode for ${player.name}`}
                            title="Issues a new passcode and QR code, and signs this player's device out"
                            className={cn(outlineButton, "whitespace-nowrap")}
                          >
                            New passcode
                          </button>
                          {canDrop && !player.dropped && dropping !== player.id && (
                            <button type="button" disabled={pending} onClick={() => setDropping(player.id)} aria-label={`Drop ${player.name}`} className={cn(outlineButton, "whitespace-nowrap")}>
                              Drop
                            </button>
                          )}
                          {dropping === player.id && (
                            <>
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => {
                                  setDropping(null);
                                  run(() => dropPlayerAction(tournamentId, player.id));
                                }}
                                className={cn(outlineButton, "whitespace-nowrap border-destructive bg-destructive text-destructive-foreground")}
                              >
                                Drop: they forfeit
                              </button>
                              <button type="button" onClick={() => setDropping(null)} className={cn(outlineButton, "whitespace-nowrap")}>
                                Keep
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {canDrop && (
          <p className="text-sm text-muted-foreground">A player who drops out plays no more: their open matches, and any they would reach, go to their opponents as forfeits.</p>
        )}
        {lateEntry && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const outcome = await addLatePlayerAction(tournamentId, late);
                if (!outcome.error) setLate("");
                return outcome;
              });
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Late player
              <input
                value={late}
                onChange={(e) => setLate(e.target.value)}
                maxLength={60}
                placeholder="Name"
                className="h-9 rounded-md border border-input bg-transparent px-3 font-normal"
              />
            </label>
            <button type="submit" disabled={pending || !late.trim()} className={outlineButton}>
              Add to the next round
            </button>
          </form>
        )}
        <p aria-live="polite" className={cn("text-sm empty:hidden", feedback.error ? "text-destructive" : "text-muted-foreground")}>
          {pending ? "Working…" : (feedback.error ?? feedback.message ?? "")}
        </p>
      </div>
    </details>
  );
}
