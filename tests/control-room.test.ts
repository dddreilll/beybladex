import { describe, expect, it } from "vitest";
import { buildDoubleElimination } from "@/lib/bracket/double-elimination";
import { openMatches, recordWinner } from "@/lib/bracket/progress";
import { buildRoundRobin } from "@/lib/bracket/round-robin";
import { buildSingleElimination } from "@/lib/bracket/single-elimination";
import { pairSwissRound } from "@/lib/bracket/swiss";
import type { BracketMatch } from "@/lib/bracket/types";
import { buildControlRoom } from "@/lib/control-room";
import { prefixKeys, toRow } from "@/lib/tournament/store";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const participants = players(16).map((id, i) => ({ id, name: `Blader ${String(i + 1).padStart(2, "0")}`, seed: i + 1 }));

/** Match rows as the database holds them, from the engine's matches. */
const rows = (built: BracketMatch[], stage: "group" | "final" = "final", groupNumber: number | null = null) =>
  built.map((m) => ({ id: `${stage}-${m.key}`, ...toRow(m, { tournamentId: "t", stage, groupNumber }), scores: m.winner ? "4-2" : null }));

/** Plays every open match, the better seed winning, and stops before `stopAt` if given. */
function playOut(matches: BracketMatch[], stopAt?: string) {
  let open = openMatches(matches).filter((m) => m.key !== stopAt);
  while (open.length) {
    const m = open[0];
    matches = recordWinner(matches, m.key, Number(m.player1!.slice(1)) < Number(m.player2!.slice(1)) ? m.player1! : m.player2!);
    open = openMatches(matches).filter((x) => x.key !== stopAt);
  }
  return matches;
}

describe("buildControlRoom", () => {
  it("lists the 8 opening matches of a 16-player double elimination in play order with player names", () => {
    const room = buildControlRoom("double_elimination", participants, rows(buildDoubleElimination(players(16))));
    expect(room.ready.map((m) => m.identifier)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(room.ready[0]).toMatchObject({ roundLabel: "Winners R1", player1: "Blader 01", player2: "Blader 16", label: "M1 · A" });
    expect(room.waiting).toEqual([]);
    expect(room.totals).toEqual({ matches: 31, completed: 0 });
  });

  it("moves a reported match to completed and shows both players waiting in their next matches", () => {
    const after = recordWinner(buildDoubleElimination(players(16)), "R1-1", "p1");
    const room = buildControlRoom("double_elimination", participants, rows(after));
    expect(room.completed[0]).toMatchObject({ identifier: "A", winner: "Blader 01", winnerSlot: 1, scores: "4-2" });
    expect(room.waiting.map((m) => [m.roundLabel, m.player1, m.player2])).toEqual([
      ["Winners R2", "Blader 01", "TBD"],
      ["Losers R1", "Blader 16", "TBD"],
    ]);
  });

  it("names the grand final, its reset, and the finals of each side", () => {
    const done = playOut(buildDoubleElimination(players(4)), "GF1");
    const played = recordWinner(done, "GF1", "p2");
    const labels = buildControlRoom("double_elimination", participants, rows(played)).completed.map((m) => m.roundLabel);
    expect(labels).toEqual(expect.arrayContaining(["Grand Finals", "Winners Final", "Losers Final"]));
    expect(buildControlRoom("double_elimination", participants, rows(played)).ready.map((m) => m.roundLabel)).toEqual(["Grand Finals reset"]);
  });

  it("names the rounds of single elimination, its final and the third-place match", () => {
    const room = buildControlRoom("single_elimination", participants, rows(playOut(buildSingleElimination(players(8), { thirdPlace: true }))));
    expect(room.completed.map((m) => `${m.identifier}: ${m.roundLabel}`).reverse()).toEqual([
      "A: Round 1", "B: Round 1", "C: Round 1", "D: Round 1", "E: Round 2", "F: Round 2", "3P: Third place", "G: Final",
    ]);
  });

  it("names the groups of a two-stage tournament and keeps the grand final for its final stage", () => {
    const group = (n: number, list: string[]) => rows(playOut(prefixKeys(buildRoundRobin(list), `G${n}:`)), "group", n);
    const all = [...group(1, ["p1", "p4"]), ...group(2, ["p2", "p3"]), ...rows(playOut(buildDoubleElimination(["p1", "p2"])))];
    const room = buildControlRoom({ tournamentType: "double_elimination", groupStageType: "round_robin" }, participants, all);
    expect(room.completed.map((m) => m.roundLabel).sort()).toEqual(["Grand Finals", "Group A · Round 1", "Group B · Round 1", "Winners Final"]);
  });

  it("leaves a Swiss bye out: nothing is played in it", () => {
    const room = buildControlRoom("swiss", participants, rows(pairSwissRound(players(5), [])));
    expect(room.ready).toHaveLength(2);
    expect(room.completed).toEqual([]);
    expect(room.totals).toEqual({ matches: 2, completed: 0 });
  });
});
