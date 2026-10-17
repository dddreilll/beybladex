import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { PageShell } from "@/components/page-shell";
import { requireOrganizer } from "@/lib/auth";
import { readScore } from "@/lib/battle-sheet";
import { db } from "@/lib/db";
import { matches, participants, tournaments, type Match } from "@/lib/db/schema";
import { bracketLayout, type Section } from "@/lib/tournament/bracket-layout";
import { formatName, isElimination, stageType } from "@/lib/tournament/format";
import { roundLabeller } from "@/lib/tournament/labels";
import { cn } from "@/lib/utils";
import { LiveRefresh } from "../live-refresh";

export const metadata: Metadata = { title: "Bracket" };

/**
 * The whole bracket of a tournament for its organizer: every round as a column, the winners and
 * losers brackets and the finals of double elimination, each group of a group stage. Stays current
 * like the Desk, and every match with both players opens its pad.
 */
export default async function BracketPage({ params }: { params: Promise<{ id: string }> }) {
  const organizer = await requireOrganizer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.id, id), eq(tournaments.organizerId, organizer.id)))
    .limit(1);
  if (!tournament) notFound();

  const [matchRows, people] = await Promise.all([
    db.select().from(matches).where(eq(matches.tournamentId, id)),
    db.select({ id: participants.id, name: participants.name }).from(participants).where(eq(participants.tournamentId, id)),
  ]);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const labelOf = roundLabeller(tournament, matchRows);
  const blocks = bracketLayout(matchRows, (stage) => isElimination(stageType(tournament, stage)));
  const format = tournament.groupStage && tournament.groupStageType
    ? `${formatName(tournament.groupStageType)} groups, then ${formatName(tournament.tournamentType).toLowerCase()}`
    : formatName(tournament.tournamentType);

  return (
    <PageShell
      title="Bracket"
      subtitle={`${tournament.name} · ${format}`}
      actions={
        <Link href={`/tournaments/${id}`} className="inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-semibold">
          BXQ Desk
        </Link>
      }
    >
      <LiveRefresh tournamentId={id} slug={tournament.publicSlug} version={tournament.boardVersion} />
      {blocks.length === 0 ? (
        <p className="text-muted-foreground">The matches are made when you start the tournament on the Desk.</p>
      ) : (
        <div className="flex flex-col gap-10">
          {blocks.map((block) => (
            <section key={block.key} aria-label={block.title || "Bracket"} className="flex flex-col gap-6">
              {block.title && <h2 className="font-display text-2xl font-semibold">{block.title}</h2>}
              {block.sections.map((section) => (
                <BracketSection
                  key={section.title}
                  section={section}
                  labelOf={labelOf}
                  nameOf={(playerId) => (playerId ? (names.get(playerId) ?? "TBD") : "TBD")}
                  padHref={(matchId) => `/tournaments/${id}/matches/${matchId}`}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}

function BracketSection({
  section,
  labelOf,
  nameOf,
  padHref,
}: {
  section: Section<Match>;
  labelOf: (match: Match) => string;
  nameOf: (playerId: string | null) => string;
  padHref: (matchId: string) => string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {section.title && <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">{section.title}</h3>}
      <div className="overflow-x-auto pb-2">
        <ol className="flex gap-4">
          {section.columns.map((column) => (
            <li key={column.round} className="flex w-56 shrink-0 flex-col gap-2">
              <h4 className="text-sm font-semibold text-muted-foreground">{labelOf(column.cells[0].match).replace(/^Group \S+ · /, "")}</h4>
              <ol className="grid flex-1 gap-2" style={{ gridTemplateRows: `repeat(${section.rows}, minmax(4.75rem, auto))` }}>
                {column.cells.map(({ match, row, span }) => (
                  <li key={match.id} className="self-center" style={{ gridRow: `${row} / span ${span}` }}>
                    <MatchCard match={match} nameOf={nameOf} padHref={padHref(match.id)} />
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** One match: its letter, both players with their score, the winner marked; a forfeit says so. */
function MatchCard({ match, nameOf, padHref }: { match: Match; nameOf: (playerId: string | null) => string; padHref: string }) {
  const score = readScore(match.scores);
  const line = (side: 1 | 2) => {
    const playerId = side === 1 ? match.player1Id : match.player2Id;
    const won = match.winnerId !== null && match.winnerId === playerId;
    return (
      <div className={cn("flex items-baseline justify-between gap-2 px-3 py-1.5", won && "font-bold text-success", !playerId && "text-muted-foreground")}>
        <span className="truncate">{nameOf(playerId)}</span>
        <span className="shrink-0 font-display tabular-nums">{match.forfeit ? (won ? "W" : "–") : (score?.[side] ?? "")}</span>
      </div>
    );
  };
  const playable = Boolean(match.player1Id && match.player2Id);
  const body = (
    <div className={cn("flex flex-col divide-y rounded-lg border bg-card text-sm", match.state === "open" && "border-primary-text")}>
      <div className="flex items-center justify-between px-3 py-1 text-xs text-muted-foreground">
        <span className="font-semibold">{match.identifier}</span>
        <span>{match.forfeit ? "Forfeit" : match.state === "open" ? (match.callStatus === "playing" ? "Playing" : "Ready") : match.ifNeeded && !playable ? "If needed" : ""}</span>
      </div>
      {line(1)}
      {line(2)}
    </div>
  );
  return playable ? (
    <Link href={padHref} aria-label={`Match ${match.identifier}: ${nameOf(match.player1Id)} vs ${nameOf(match.player2Id)}`} className="block rounded-lg hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}
