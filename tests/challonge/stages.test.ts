import { describe, expect, it } from "vitest";
import { groupNumbers, stageOf, stagesOf } from "@/lib/challonge/stages";
import type { ListResponse, MatchResource, SingleResponse, TournamentResource } from "@/lib/challonge/types";
import { roundLabeller } from "@/lib/challonge/map";
import finalStageFixture from "../fixtures/challonge/two-stage-round-robin-final-stage.json";
import roundRobinFixture from "../fixtures/challonge/two-stage-round-robin-tournament.json";
import swissRoundTwoFixture from "../fixtures/challonge/two-stage-swiss-matches-round-2.json";
import thirdPlaceFixture from "../fixtures/challonge/two-stage-third-place-final-stage.json";
import threeGroupsFixture from "../fixtures/challonge/two-stage-three-groups-tournament.json";
import unequalFixture from "../fixtures/challonge/two-stage-unequal-groups-tournament.json";
import bigGroupsFixture from "../fixtures/challonge/two-stage-big-groups-tournament.json";

// Recorded in spike S17. A tournament of 6 players in 2 round robin groups of 3, right after its
// group stage started and right after its final stage did; and the matches of 8 players in 2 Swiss
// groups of 4, once the second round of both groups had been paired.
type Recorded = SingleResponse<TournamentResource> & { included: MatchResource[] };
const matchesOf = (fixture: unknown) => (fixture as Recorded).included.filter((r) => r.type === "match");
const groupStage = matchesOf(roundRobinFixture);
const finalStage = matchesOf(finalStageFixture);
const startedAt = new Date((finalStageFixture as unknown as Recorded).data.attributes.timestamps!.started_at!);
const swissRoundTwo = (swissRoundTwoFixture as unknown as ListResponse<MatchResource>).data;

const underway = { groupStage: true, state: "underway", startedAt };

describe("stageOf", () => {
  const created = new Date("2026-10-13T23:32:35.276Z");

  it("puts every match of a tournament without a group stage in its only stage", () => {
    expect(stageOf(created, { groupStage: false, state: "underway", startedAt: null })).toBe("final");
    expect(stageOf(null, { groupStage: false, state: "pending", startedAt: null })).toBe("final");
  });

  it("puts every match in the group stage until the final stage starts", () => {
    expect(stageOf(created, { groupStage: true, state: "group_stages_underway", startedAt: null })).toBe("group");
    expect(stageOf(created, { groupStage: true, state: "group_stages_finalized", startedAt: null })).toBe("group");
    expect(stageOf(null, { groupStage: true, state: "pending", startedAt: null })).toBe("group");
  });

  it("then tells the stages apart by when the match was created", () => {
    const start = new Date("2026-10-14T03:00:00Z");
    const format = { groupStage: true, state: "underway", startedAt: start };
    expect(stageOf(new Date("2026-10-14T01:00:00Z"), format)).toBe("group");
    // The final stage's matches were created up to 14 ms before it started.
    expect(stageOf(new Date("2026-10-14T02:59:59.986Z"), format)).toBe("final");
    expect(stageOf(new Date("2026-10-14T02:59:58.500Z"), format)).toBe("final");
    // The recorded groups were created 5.8 s before: a script played them, and nothing is played faster.
    expect(stageOf(new Date("2026-10-14T02:59:54.200Z"), format)).toBe("group");
    expect(stageOf(new Date("2026-10-14T03:00:07Z"), format)).toBe("final");
    expect(stageOf(new Date("2026-10-14T01:00:00Z"), { ...format, state: "complete" })).toBe("group");
  });

  it("takes a match for the final stage when a time is missing", () => {
    expect(stageOf(null, underway)).toBe("final");
    expect(stageOf(created, { groupStage: true, state: "underway", startedAt: null })).toBe("final");
  });
});

describe("groupNumbers", () => {
  const match = (challongeId: number, identifier: string, players: (number | null)[]) => ({
    challongeId: String(challongeId),
    identifier,
    players: players.map((p) => (p === null ? null : String(p))),
  });
  const groupsOf = (matches: ReturnType<typeof match>[], groupSize?: number) => {
    const groups = groupNumbers(matches, groupSize);
    return matches.map((m) => groups.get(m.challongeId) ?? null);
  };

  it("starts a group at each match A, in order of id", () => {
    // Round robin groups of 3, as recorded: the ids of a group follow each other.
    const roundRobin = [match(139, "A", [731, 732]), match(140, "B", [730, 731]), match(141, "C", [732, 730]), match(142, "A", [734, 735]), match(143, "B", [733, 734]), match(144, "C", [735, 733])];
    expect(groupsOf(roundRobin, 3)).toEqual([1, 1, 1, 2, 2, 2]);
    // The order they are given in doesn't matter.
    expect(groupsOf([...roundRobin].reverse(), 3)).toEqual([2, 2, 2, 1, 1, 1]);
  });

  it("puts a later round with the group of its players", () => {
    // Swiss groups of 4: the second group finished its first round first, so its second round has the lower ids.
    const swiss = [
      match(368, "A", [111, 113]), match(369, "B", [112, 114]), match(370, "A", [115, 117]), match(371, "B", [116, 118]),
      match(372, "C", [115, 116]), match(373, "D", [117, 118]), match(374, "C", [112, 113]), match(375, "D", [111, 114]),
    ];
    expect(groupsOf(swiss, 4)).toEqual([1, 1, 2, 2, 2, 2, 1, 1]);
  });

  it("gives a player who sat out a round the group of their first opponent", () => {
    // Swiss groups of 3: one player of each group has no match in round 1.
    const swiss = [match(1, "A", [10, 11]), match(2, "A", [20, 21]), match(3, "B", [12, 10]), match(4, "B", [22, 21])];
    expect(groupsOf(swiss, 3)).toEqual([1, 2, 1, 2]);
  });

  it("keeps the matches of a bracket that have no players yet with their group", () => {
    // Double elimination groups of 4, as recorded: seven matches a group, five of them empty at the start.
    const bracket = (from: number, players: number[]) => [
      match(from, "A", [players[0], players[3]]), match(from + 1, "B", [players[1], players[2]]),
      ...["C", "F", "G", "D", "E"].map((identifier, i) => match(from + 2 + i, identifier, [null, null])),
    ];
    expect(groupsOf([...bracket(482, [338, 339, 340, 341]), ...bracket(489, [342, 343, 344, 345])], 4)).toEqual([...Array(7).fill(1), ...Array(7).fill(2)]);
  });

  it("gives no numbers when there is one group, which needs no name", () => {
    expect(groupsOf([match(1, "A", [10, 11]), match(2, "B", [12, 13]), match(3, "C", [10, 12])], 4)).toEqual([null, null, null]);
  });

  it("gives no numbers when what it assumes doesn't hold", () => {
    // A match between players of two groups.
    expect(groupsOf([match(1, "A", [10, 11]), match(2, "A", [20, 21]), match(3, "B", [10, 20])])).toEqual([null, null, null]);
    // More players in a group than a group has: the groups weren't created one after the other.
    expect(groupsOf([match(1, "A", [10, 11]), match(2, "B", [12, 13]), match(3, "A", [20, 21])], 3)).toEqual([null, null, null]);
  });
});

describe("stagesOf", () => {
  const described = (rows: MatchResource[], format: Parameters<typeof stagesOf>[1]) => {
    const stages = stagesOf(rows, format);
    return rows.map((m) => `${m.attributes.identifier}:${stages.get(m.id)!.stage}:${stages.get(m.id)!.groupNumber}`);
  };

  it("finds the two groups of the recorded round robin group stage", () => {
    expect(described(groupStage, { groupStage: true, state: "group_stages_underway", startedAt: null, groupSize: 3 })).toEqual([
      "A:group:1", "B:group:1", "C:group:1", "A:group:2", "B:group:2", "C:group:2",
    ]);
  });

  it("tells the recorded final stage from the groups, whose matches have the same names", () => {
    expect(described(finalStage, { ...underway, groupSize: 3 })).toEqual([
      "A:group:1", "B:group:1", "C:group:1", "A:group:2", "B:group:2", "C:group:2", "A:final:null", "B:final:null", "C:final:null",
    ]);
  });

  it("finds the groups of the recorded Swiss rounds", () => {
    expect(described(swissRoundTwo, { groupStage: true, state: "group_stages_underway", startedAt: null, groupSize: 4 }).sort()).toEqual([
      "A:group:1", "A:group:2", "B:group:1", "B:group:2", "C:group:1", "C:group:2", "D:group:1", "D:group:2",
    ]);
  });

  it("leaves a tournament with one stage as it is", () => {
    expect(new Set(described(groupStage, { groupStage: false, state: "underway", startedAt }))).toEqual(new Set(["A:final:null", "B:final:null", "C:final:null"]));
  });

  // Recorded in spike S21, right after the group stage started: 9 players in 3 groups of 3, and 7
  // players in groups of 4, which Challonge made a group of 4 and a group of 3.
  it("finds three groups, and groups that aren't the same size", () => {
    const groupStageOf = { groupStage: true, state: "group_stages_underway", startedAt: null };
    expect(described(matchesOf(threeGroupsFixture), { ...groupStageOf, groupSize: 3 })).toEqual([
      "A:group:1", "B:group:1", "C:group:1", "A:group:2", "B:group:2", "C:group:2", "A:group:3", "B:group:3", "C:group:3",
    ]);
    expect(described(matchesOf(unequalFixture), { ...groupStageOf, groupSize: 4 })).toEqual([
      "A:group:1", "B:group:1", "C:group:1", "D:group:1", "E:group:1", "F:group:1", "A:group:2", "B:group:2", "C:group:2",
    ]);
  });

  // Recorded in spike S21: 16 players in 2 round robin groups of 8, 28 matches each, named A to Z, AA and AB.
  it("finds groups of 8, whose matches go past Z", () => {
    const described8 = described(matchesOf(bigGroupsFixture), { groupStage: true, state: "group_stages_underway", startedAt: null, groupSize: 8 });
    expect(described8).toHaveLength(56);
    expect(described8.filter((d) => d.endsWith(":group:1"))).toHaveLength(28);
    expect(described8.filter((d) => d.endsWith(":group:2"))).toHaveLength(28);
    expect(described8.slice(26, 29)).toEqual(["AA:group:1", "AB:group:1", "A:group:2"]);
  });

  // Recorded in spike S21 right after a single elimination final stage with a third-place match started.
  it("puts the third-place match in the final stage, and names it", () => {
    const recorded = thirdPlaceFixture as unknown as Recorded;
    const rows = matchesOf(thirdPlaceFixture);
    const format = { groupStage: true, state: "underway", startedAt: new Date(recorded.data.attributes.timestamps!.started_at!), groupSize: 3 };
    const stages = stagesOf(rows, format);
    const finals = rows.filter((m) => stages.get(m.id)!.stage === "final");
    expect(finals.map((m) => `${m.attributes.identifier}:r${m.attributes.round}`)).toEqual(["A:r1", "B:r1", "C:r2", "3P:r0"]);
    const labelOf = roundLabeller({ tournamentType: "single elimination", groupStageType: "round robin" }, rows.map((m) => ({ round: m.attributes.round, stage: stages.get(m.id)!.stage })));
    expect(finals.map((m) => labelOf({ round: m.attributes.round, identifier: m.attributes.identifier, stage: "final" }))).toEqual(["Round 1", "Round 1", "Final", "Third place"]);
  });
});
