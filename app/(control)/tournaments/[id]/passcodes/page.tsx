import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import QRCode from "qrcode";
import { requireOrganizer } from "@/lib/auth";
import { appUrl } from "@/lib/config";
import { db } from "@/lib/db";
import { participants } from "@/lib/db/schema";
import { ownedTournament } from "@/lib/venue";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Passcode slips", robots: { index: false } };

// One slip per player, to print and cut: their name, their passcode, and a personal QR code that
// signs them in without typing. Black on white whatever the app's theme, since it goes on paper.
export default async function PasscodeSlipsPage({ params }: { params: Promise<{ id: string }> }) {
  const organizer = await requireOrganizer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const tournament = await ownedTournament(organizer.id, id);
  if (!tournament) notFound();

  const rows = await db
    .select({ id: participants.challongeId, name: participants.name, passcode: participants.passcode, signInToken: participants.signInToken })
    .from(participants)
    .where(and(eq(participants.tournamentId, tournament.id), eq(participants.active, true)))
    .orderBy(asc(participants.name));

  const playerUrl = `${appUrl()}/t/${tournament.publicSlug}`;
  const slips = await Promise.all(
    rows.map(async (player) => ({
      ...player,
      // The secret goes after the #, which is never sent to a server until the page itself signs in.
      // Output of the qrcode library from a URL we built: safe to inline.
      qrSvg: await QRCode.toString(`${playerUrl}#k=${player.signInToken}`, { type: "svg", margin: 0, errorCorrectionLevel: "M" }),
    })),
  );

  return (
    <div className="min-h-svh bg-white p-6 text-black print:p-0">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 print:hidden">
        <div>
          <h1 className="font-display text-3xl font-bold">Passcode slips</h1>
          <p className="text-sm text-neutral-600">
            {tournament.name} · {slips.length} player{slips.length === 1 ? "" : "s"}. Print, cut along the dashed lines, and hand each player their own slip.
          </p>
        </div>
        <PrintButton />
      </header>

      {slips.length === 0 && <p>No players yet. Add them on Challonge, then resync.</p>}
      <ul className="grid grid-cols-1 sm:grid-cols-2 print:grid-cols-2">
        {slips.map((slip) => (
          <li key={slip.id} className="flex break-inside-avoid items-center gap-4 border border-dashed border-neutral-400 p-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-xs text-neutral-600">{tournament.name}</span>
              <span className="font-display text-2xl font-bold leading-tight">{slip.name}</span>
              <span className="mt-1 text-xs font-bold uppercase tracking-widest text-neutral-600">Your passcode</span>
              <span className="font-display text-4xl font-bold leading-none tracking-[0.2em] tabular-nums">{slip.passcode}</span>
              <span className="mt-1 text-xs leading-snug text-neutral-700">
                Scan this code to open your match page. Or scan the code on the call board, pick your name and type your passcode. Keep it to
                yourself.
              </span>
            </div>
            <div
              role="img"
              aria-label={`Personal QR code for ${slip.name}`}
              className="size-28 shrink-0 [&>svg]:size-full"
              dangerouslySetInnerHTML={{ __html: slip.qrSvg }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
