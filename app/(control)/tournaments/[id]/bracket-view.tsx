import Link from "next/link";
import { readScore } from "@/lib/battle-sheet";
import type { Match, Tournament } from "@/lib/db/schema";
import { bracketLayout, type Section } from "@/lib/tournament/bracket-layout";
import { isElimination, stageType } from "@/lib/tournament/format";
import { matchCode, matchTitle, roundLabeller } from "@/lib/tournament/labels";
import { cn } from "@/lib/utils";

/**
 * The whole bracket of a tournament, for the Desk's Bracket tab: every round as a column, the
 * winners and losers brackets and the finals of double elimination, each group of a group stage.
 * Every match with both players opens its pad.
 */
export function BracketView({
  tournament,
  matches,
  names,
  padHref,
}: {
  tournament: Tournament;
  matches: Match[];
  names: Map<string, string>;
  padHref: (matchId: string) => string;
}) {
  const labelOf = roundLabeller(tournament, matches);
  const blocks = bracketLayout(matches, (stage) => isElimination(stageType(tournament, stage)));
  const nameOf = (playerId: string | null) => (playerId ? (names.get(playerId) ?? "TBD") : "TBD");

  if (blocks.length === 0) return <p className="text-muted-foreground">The matches are made when you start the tournament.</p>;
  return (
    <div className="flex flex-col gap-10">
      {blocks.map((block) => (
        <section key={block.key} aria-label={block.title || "Bracket"} className="flex flex-col gap-6">
          {block.title && <h3 className="font-display text-xl font-semibold">{block.title}</h3>}
          {block.sections.map((section) => (
            <BracketSection key={section.title} section={section} labelOf={labelOf} nameOf={nameOf} padHref={padHref} />
          ))}
        </section>
      ))}
    </div>
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
      {section.title && <h4 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">{section.title}</h4>}
      <div className="overflow-x-auto pb-2">
        <ol className="flex gap-4">
          {section.columns.map((column) => (
            <li key={column.round} className="flex w-56 shrink-0 flex-col gap-2">
              <h5 className="text-sm font-semibold text-muted-foreground">{labelOf(column.cells[0].match).replace(/^Group \S+ · /, "")}</h5>
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

/** One match: its number, both players with their score, the winner marked; a forfeit says so. */
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
        <span className="font-semibold">{matchCode(match.number)}</span>
        <span>{match.forfeit ? "Forfeit" : match.state === "open" ? (match.callStatus === "playing" ? "Playing" : "Ready") : match.ifNeeded && !playable ? "If needed" : ""}</span>
      </div>
      {line(1)}
      {line(2)}
    </div>
  );
  return playable ? (
    <Link href={padHref} aria-label={`${matchTitle(match.number)}: ${nameOf(match.player1Id)} vs ${nameOf(match.player2Id)}`} className="block rounded-lg hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}
