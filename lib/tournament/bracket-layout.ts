import type { Stage } from "./format";
import { groupLabel } from "./labels";

// How the bracket page lays out a tournament's matches. Pure: given the stored matches, it says
// which section, column and grid rows each one takes.
//
// In an elimination bracket a match sits by its position in the full bracket ("R2-3" is the third
// slot of round 2), so a bye leaves a gap and every later match is centred between the two that
// feed it. A round robin or a Swiss is a column per round, its matches in play order.

export type LayoutMatch = {
  key: string;
  round: number;
  playOrder: number;
  stage: Stage;
  groupNumber: number | null;
  section: "losers" | "grand_final" | null;
  thirdPlace: boolean;
  bye: boolean;
};

export type Cell<M> = { match: M; row: number; span: number };
export type Column<M> = { round: number; cells: Cell<M>[] };
export type Section<M> = {
  /** "Winners bracket", "Losers bracket", "Finals", or empty when it is the only one. */
  title: string;
  /** How many grid rows the columns share; a cell takes `span` of them from `row`. */
  rows: number;
  columns: Column<M>[];
};
/** One stage or group: its title and its sections. */
export type Block<M> = { key: string; title: string; elimination: boolean; sections: Section<M>[] };

/** The slot of a match in its round: "G2:R3-1" is 1. Matches without one ("GF1", "3P") are 1. */
const slotOf = (key: string) => Number(/^(?:G\d+:)?[RL]\d+-(\d+)$/.exec(key)?.[1] ?? 1);

/**
 * A side of a bracket, each match in its slot. On the winners side round r of R rounds has
 * 2^(R-r) slots; the losers side halves every other round, so round j of J has 2^floor((J-j)/2).
 * Every round's slots share the first round's rows.
 */
function bracketSection<M extends LayoutMatch>(title: string, matches: M[], side: "winners" | "losers"): Section<M> {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const last = rounds.at(-1) ?? 1;
  const slots = (round: number) => (side === "winners" ? 2 ** (last - round) : 2 ** Math.floor((last - round) / 2));
  const rows = slots(1);
  return {
    title,
    rows,
    columns: rounds.map((round) => {
      const span = rows / slots(round);
      return {
        round,
        cells: matches
          .filter((m) => m.round === round)
          .sort((a, b) => slotOf(a.key) - slotOf(b.key))
          .map((match) => ({ match, row: (slotOf(match.key) - 1) * span + 1, span })),
      };
    }),
  };
}

/** Matches in a column per round, in play order, a row each: a round robin, a Swiss, or the finals. */
function listSection<M extends LayoutMatch>(title: string, matches: M[]): Section<M> {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const columns = rounds.map((round) => ({
    round,
    cells: matches
      .filter((m) => m.round === round)
      .sort((a, b) => a.playOrder - b.playOrder)
      .map((match, i) => ({ match, row: i + 1, span: 1 })),
  }));
  return { title, rows: Math.max(1, ...columns.map((c) => c.cells.length)), columns };
}

/** The sections of one stage or group, in the format it is played in. A Swiss bye isn't shown. */
function sectionsOf<M extends LayoutMatch>(matches: M[], elimination: boolean): Section<M>[] {
  if (!elimination) return [listSection("", matches.filter((m) => !m.bye))];
  const winners = matches.filter((m) => !m.section && !m.thirdPlace);
  const losers = matches.filter((m) => m.section === "losers");
  const finals = matches.filter((m) => m.section === "grand_final" || m.thirdPlace);
  const sections: Section<M>[] = [];
  if (winners.length) sections.push(bracketSection(losers.length ? "Winners bracket" : "", winners, "winners"));
  if (losers.length) sections.push(bracketSection("Losers bracket", losers, "losers"));
  // The grand final and its reset, or the third-place match, side by side.
  if (finals.length) {
    const sorted = [...finals].sort((a, b) => a.playOrder - b.playOrder);
    sections.push({
      title: losers.length ? "Finals" : "Third place",
      rows: 1,
      columns: sorted.map((match, i) => ({ round: i + 1, cells: [{ match, row: 1, span: 1 }] })),
    });
  }
  return sections;
}

/**
 * The blocks of a tournament's bracket page: each group of a group stage, then the final stage.
 * `isElimination(stage)` says whether a stage is a bracket.
 */
export function bracketLayout<M extends LayoutMatch>(matches: M[], isElimination: (stage: Stage) => boolean): Block<M>[] {
  const blocks: Block<M>[] = [];
  const groups = [...new Set(matches.filter((m) => m.stage === "group").map((m) => m.groupNumber))].sort((a, b) => (a ?? 0) - (b ?? 0));
  for (const group of groups) {
    const elimination = isElimination("group");
    const own = matches.filter((m) => m.stage === "group" && m.groupNumber === group);
    blocks.push({ key: `group-${group ?? 0}`, title: groupLabel(group), elimination, sections: sectionsOf(own, elimination) });
  }
  const final = matches.filter((m) => m.stage === "final");
  if (final.length) {
    const elimination = isElimination("final");
    blocks.push({ key: "final", title: groups.length ? "Final stage" : "", elimination, sections: sectionsOf(final, elimination) });
  }
  return blocks;
}
