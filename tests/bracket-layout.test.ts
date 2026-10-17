import { describe, expect, it } from "vitest";
import { buildDoubleElimination } from "@/lib/bracket/double-elimination";
import { buildRoundRobin } from "@/lib/bracket/round-robin";
import { buildSingleElimination } from "@/lib/bracket/single-elimination";
import { pairSwissRound } from "@/lib/bracket/swiss";
import type { BracketMatch } from "@/lib/bracket/types";
import { bracketLayout, type Section } from "@/lib/tournament/bracket-layout";
import { prefixKeys, toRow } from "@/lib/tournament/store";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const rows = (built: BracketMatch[], stage: "group" | "final" = "final", groupNumber: number | null = null) =>
  built.map((m) => toRow(m, { tournamentId: "t", stage, groupNumber }));
const elimination = () => true;

/** "key@row+span" per column. */
const picture = (section: Section<{ key: string }>) => section.columns.map((c) => c.cells.map((cell) => `${cell.match.key}@${cell.row}+${cell.span}`).join(" "));

describe("bracketLayout", () => {
  it("lays out a full single elimination: every round centred between the two matches that feed it", () => {
    const [block] = bracketLayout(rows(buildSingleElimination(players(8))), elimination);
    expect(block.sections).toHaveLength(1);
    expect(block.sections[0].rows).toBe(4);
    expect(picture(block.sections[0])).toEqual(["R1-1@1+1 R1-2@2+1 R1-3@3+1 R1-4@4+1", "R2-1@1+2 R2-2@3+2", "R3-1@1+4"]);
  });

  it("leaves a gap where a bye takes the place of a match", () => {
    const [block] = bracketLayout(rows(buildSingleElimination(players(6))), elimination);
    expect(picture(block.sections[0])).toEqual(["R1-2@2+1 R1-4@4+1", "R2-1@1+2 R2-2@3+2", "R3-1@1+4"]);
  });

  it("puts a third-place match in a section of its own", () => {
    const [block] = bracketLayout(rows(buildSingleElimination(players(4), { thirdPlace: true })), elimination);
    expect(block.sections.map((s) => s.title)).toEqual(["", "Third place"]);
    expect(picture(block.sections[1])).toEqual(["3P@1+1"]);
  });

  it("splits double elimination into the winners bracket, the losers bracket and the finals", () => {
    const [block] = bracketLayout(rows(buildDoubleElimination(players(8))), elimination);
    expect(block.sections.map((s) => s.title)).toEqual(["Winners bracket", "Losers bracket", "Finals"]);
    // The losers side halves every other round: 2, 2, 1, 1 matches.
    expect(block.sections[1].rows).toBe(2);
    expect(picture(block.sections[1])).toEqual(["L1-1@1+1 L1-2@2+1", "L2-1@1+1 L2-2@2+1", "L3-1@1+2", "L4-1@1+2"]);
    expect(picture(block.sections[2])).toEqual(["GF1@1+1", "GF2@1+1"]);
  });

  it("keeps every cell inside its section's rows, whatever the size", () => {
    for (let n = 2; n <= 33; n++) {
      for (const built of [buildSingleElimination(players(n), { thirdPlace: n >= 4 }), buildDoubleElimination(players(n))]) {
        const [block] = bracketLayout(rows(built), elimination);
        const cells = block.sections.flatMap((s) => s.columns.flatMap((c) => c.cells.map((cell) => ({ ...cell, rows: s.rows }))));
        expect(cells).toHaveLength(built.length);
        for (const cell of cells) expect(cell.row + cell.span - 1).toBeLessThanOrEqual(cell.rows);
      }
    }
  });

  it("shows a round robin as a column per round, and leaves a Swiss bye out", () => {
    const [rr] = bracketLayout(rows(buildRoundRobin(players(4))), () => false);
    expect(rr.elimination).toBe(false);
    expect(picture(rr.sections[0])).toEqual(["R1-1@1+1 R1-2@2+1", "R2-1@1+1 R2-2@2+1", "R3-1@1+1 R3-2@2+1"]);
    const [swiss] = bracketLayout(rows(pairSwissRound(players(5), [])), () => false);
    expect(picture(swiss.sections[0])).toEqual(["R1-1@1+1 R1-2@2+1"]);
  });

  it("gives each group a block of its own, then the final stage", () => {
    const matches = [
      ...rows(prefixKeys(buildRoundRobin(["a", "b", "c", "d"]), "G1:"), "group", 1),
      ...rows(prefixKeys(buildRoundRobin(["e", "f", "g"]), "G2:"), "group", 2),
      ...rows(buildSingleElimination(["a", "e"])),
    ];
    const blocks = bracketLayout(matches, (stage) => stage === "final");
    expect(blocks.map((b) => `${b.title}:${b.elimination}`)).toEqual(["Group A:false", "Group B:false", "Final stage:true"]);
    expect(blocks[0].sections[0].columns.map((c) => c.cells.length)).toEqual([2, 2, 2]);
    expect(picture(blocks[2].sections[0])).toEqual(["R1-1@1+1"]);
  });
});
