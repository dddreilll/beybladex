import { champion, openMatches } from "./progress";
import { BracketError, isElimination, type BracketMatch, type Format } from "./types";

export type StandingRow = {
  player: string;
  /** 1 for the best; unique, since every tie is broken down to the seed. */
  rank: number;
  wins: number;
  losses: number;
  /** Wins given by a Swiss bye; already counted in `wins`. */
  byes: number;
  /** The wins of every opponent met, added up. Byes add nothing. */
  buchholz: number;
  pointsFor: number;
  pointsAgainst: number;
};

const loserOf = (m: BracketMatch) => (m.winner === m.player1 ? m.player2 : m.player1);

/**
 * Standings of a round robin or a Swiss, from its matches with a winner. `players` are in seed
 * order; matches of players not in it (who dropped out) still count for their opponents' Buchholz.
 *
 * Ranked by wins, then Buchholz, then head-to-head (wins in matches between the players still
 * level), then Beyblade X points difference, then seed.
 */
export function standings(players: string[], matches: BracketMatch[]): StandingRow[] {
  const decided = matches.filter((m) => m.winner);
  const wins = new Map<string, number>();
  for (const m of decided) wins.set(m.winner!, (wins.get(m.winner!) ?? 0) + 1);
  const winsOf = (p: string) => wins.get(p) ?? 0;

  const rows = players.map((player) => {
    const row = { player, rank: 0, wins: winsOf(player), losses: 0, byes: 0, buchholz: 0, pointsFor: 0, pointsAgainst: 0 };
    for (const m of decided) {
      if (m.player1 !== player && m.player2 !== player) continue;
      if (m.bye) {
        row.byes += 1;
        continue;
      }
      const side = m.player1 === player ? 0 : 1;
      const opponent = side === 0 ? m.player2! : m.player1!;
      if (m.winner !== player) row.losses += 1;
      row.buchholz += winsOf(opponent);
      if (m.score) {
        row.pointsFor += m.score[side];
        row.pointsAgainst += m.score[1 - side];
      }
    }
    return row;
  });

  const seed = new Map(players.map((p, i) => [p, i]));
  const level = (a: StandingRow, b: StandingRow) => a.wins === b.wins && a.buchholz === b.buchholz;
  const headToHead = (row: StandingRow) => {
    const tied = new Set(rows.filter((r) => level(r, row)).map((r) => r.player));
    return decided.filter((m) => !m.bye && m.winner === row.player && tied.has(loserOf(m)!)).length;
  };
  const h2h = new Map(rows.map((r) => [r.player, headToHead(r)]));

  return rows
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        b.buchholz - a.buchholz ||
        h2h.get(b.player)! - h2h.get(a.player)! ||
        b.pointsFor - b.pointsAgainst - (a.pointsFor - a.pointsAgainst) ||
        seed.get(a.player)! - seed.get(b.player)!,
    )
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

export type Placement = { player: string; place: number };

/**
 * Final places once a stage is played out. In an elimination bracket players knocked out in the
 * same round share a place (3rd, 5th, 7th, …), except that a third-place match separates 3rd and
 * 4th. In a round robin or a Swiss the standings are the places.
 */
export function placements(format: Format, players: string[], matches: BracketMatch[]): Placement[] {
  if (openMatches(matches).length) throw new BracketError("The stage isn't finished yet.");
  if (!isElimination(format)) return standings(players, matches).map((r) => ({ player: r.player, place: r.rank }));

  const winner = champion(matches);
  if (!winner) throw new BracketError("The stage isn't finished yet.");

  // Where each player was knocked out: their last loss. The third-place match is placed apart.
  const knockedOut = new Map<string, BracketMatch>();
  for (const m of [...matches].sort((a, b) => a.playOrder - b.playOrder)) {
    if (m.winner && !m.thirdPlace) knockedOut.set(loserOf(m)!, m);
  }
  const depth = (player: string) => {
    if (player === winner) return Infinity;
    const m = knockedOut.get(player);
    if (!m) throw new BracketError("A player has no result in this bracket.");
    return m.section === "grand_final" ? 10_000 + m.round : m.round;
  };

  const rows = players.map((player) => ({ player, depth: depth(player) }));
  const placed = rows.map((r) => ({ player: r.player, place: 1 + rows.filter((o) => o.depth > r.depth).length }));
  const third = matches.find((m) => m.thirdPlace && m.winner);
  if (third) {
    const lost = placed.find((p) => p.player === loserOf(third))!;
    lost.place += 1;
  }
  return placed.sort((a, b) => a.place - b.place || players.indexOf(a.player) - players.indexOf(b.player));
}
