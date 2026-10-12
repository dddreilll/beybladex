"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { MoreVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { placeOnDeckAction, setHeldAction, type VenueState } from "./venue-actions";

export type QueueRow = {
  id: string;
  label: string;
  round: string;
  players: string;
  status: "ready" | "held" | "pending";
  padHref: string;
};

const STATUS: Record<QueueRow["status"], { text: string; className: string }> = {
  ready: { text: "Ready", className: "bg-success-muted text-success" },
  held: { text: "Held", className: "bg-warning-muted text-warning" },
  pending: { text: "Pending", className: "bg-muted text-muted-foreground" },
};

export function QueueTable({
  tournamentId,
  rows,
  slots,
  autoOnDeck,
}: {
  tournamentId: string;
  rows: QueueRow[];
  /** Stadiums whose on-deck slot is empty, for "Place on deck at…". */
  slots: { id: string; name: string }[];
  autoOnDeck: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<VenueState>({});
  // Feedback is transient: a stale "wait 13s" shouldn't sit on the card for the rest of the event.
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clearTimer.current), []);
  const run = (action: () => Promise<VenueState>) =>
    startTransition(async () => {
      setFeedback(await action());
      clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setFeedback({}), 8000);
    });

  if (rows.length === 0) {
    return <p className="rounded-2xl border bg-card p-5 text-muted-foreground">No matches are waiting.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="px-5 py-3.5 font-semibold">Match</th>
              <th scope="col" className="px-5 py-3.5 font-semibold">Round</th>
              <th scope="col" className="px-5 py-3.5 font-semibold">Players</th>
              <th scope="col" className="px-5 py-3.5 font-semibold">Status</th>
              <th scope="col" className="px-5 py-3.5 font-semibold">Stadium</th>
              <th scope="col" className="w-12 px-2 py-3.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="whitespace-nowrap px-5 py-3.5 font-display font-semibold">{row.label}</td>
                <td className="whitespace-nowrap px-5 py-3.5 text-muted-foreground">{row.round}</td>
                <td className="px-5 py-3.5 font-semibold">{row.players}</td>
                <td className="px-5 py-3.5">
                  <span className={cn("rounded-full px-2.5 py-1 text-[0.7rem] font-bold uppercase tracking-wider", STATUS[row.status].className)}>
                    {STATUS[row.status].text}
                  </span>
                </td>
                <td className="whitespace-nowrap px-5 py-3.5 text-muted-foreground">
                  {row.status === "ready" && autoOnDeck ? "Next free" : "—"}
                </td>
                <td className="px-2 py-2">
                  {row.status !== "pending" && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Actions for ${row.label}, ${row.players}`}
                        className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <MoreVertical className="size-4" aria-hidden />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-60">
                        <DropdownMenuItem asChild>
                          <Link href={row.padHref}>Score on the pad</Link>
                        </DropdownMenuItem>
                        {row.status === "ready" && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>Place on deck at</DropdownMenuLabel>
                            {slots.length === 0 && <DropdownMenuItem disabled>No empty on-deck slot</DropdownMenuItem>}
                            {slots.map((slot) => (
                              <DropdownMenuItem key={slot.id} onSelect={() => run(() => placeOnDeckAction(tournamentId, row.id, slot.id))}>
                                {slot.name}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => run(() => setHeldAction(tournamentId, row.id, true))}>Hold</DropdownMenuItem>
                          </>
                        )}
                        {row.status === "held" && (
                          <DropdownMenuItem onSelect={() => run(() => setHeldAction(tournamentId, row.id, false))}>
                            Release to queue
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p aria-live="polite" className={cn("text-sm empty:hidden", feedback.error ? "text-destructive" : "text-muted-foreground")}>
        {pending ? "Working…" : (feedback.error ?? feedback.message ?? "")}
      </p>
    </div>
  );
}
