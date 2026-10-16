import { playersOf } from "./map";
import { stagePhase, type Stage } from "./support";
import type { MatchResource } from "./types";

// Challonge doesn't say which stage or group a match of a two-stage tournament is in: a match has
// no group, a participant's `group_id` stays null, and rounds, identifiers and play order start
// again in every group and again in the final stage (spike S17). Both are worked out here, from
// what the four tournaments of that spike had in common. None of it is documented by Challonge.

/** What tells a match's stage: whether there are two, where the tournament is, and when its final stage started. */
export type StageFormat = { groupStage: boolean; state: string; startedAt: Date | null; groupSize?: number | null };

/**
 * How long before the final stage started a match must have been created to be a group match.
 * The request that starts the final stage creates its matches, up to 14 ms before `started_at`.
 * A group match is created long before that: it has to be played first. That also covers the
 * clocks of Challonge, which were seen 6.3 s apart between one request and another.
 */
const FINAL_STAGE_MARGIN_MS = 2_000;

/** The stage of a match created at `createdAt`. Everything is a group match until the final stage starts. */
export function stageOf(createdAt: Date | null, format: StageFormat): Stage {
  const phase = stagePhase(format);
  if (!phase) return "final";
  if (phase !== "final") return "group";
  if (!createdAt || !format.startedAt) return "final";
  return createdAt.getTime() < format.startedAt.getTime() - FINAL_STAGE_MARGIN_MS ? "group" : "final";
}

type GroupMatch = { challongeId: string; identifier: string; players: (string | null)[] };

/**
 * The group of each group-stage match, counted from 1, by Challonge match id.
 * Challonge creates a group's matches together, the first of them "A", so in order of id a match
 * "A" without a player seen before starts the next group; a later match (a Swiss round, a bracket
 * filling in) belongs to the group of its players.
 * Empty when that doesn't hold (a match joining two groups, a group with too many players), and
 * when there is one group, which needs no name.
 */
export function groupNumbers(matches: GroupMatch[], groupSize?: number | null): Map<string, number> {
  const groups = new Map<string, number>();
  const groupOfPlayer = new Map<string, number>();
  let current = 0;

  for (const match of [...matches].sort((a, b) => Number(a.challongeId) - Number(b.challongeId))) {
    const players = match.players.filter((p): p is string => Boolean(p));
    const known = [...new Set(players.map((p) => groupOfPlayer.get(p)).filter((g): g is number => g !== undefined))];
    if (known.length > 1) return new Map();
    if (known.length === 0 && (match.identifier === "A" || current === 0)) current += 1;
    const group = known[0] ?? current;
    for (const player of players) groupOfPlayer.set(player, group);
    groups.set(match.challongeId, group);
  }

  const sizes = new Map<number, number>();
  for (const group of groupOfPlayer.values()) sizes.set(group, (sizes.get(group) ?? 0) + 1);
  if (groupSize && [...sizes.values()].some((size) => size > groupSize)) return new Map();
  return current > 1 ? groups : new Map();
}

/** The stage and the group of every match in a response, by Challonge match id. */
export function stagesOf(rows: MatchResource[], format: StageFormat): Map<string, { stage: Stage; groupNumber: number | null }> {
  const staged = rows.map((m) => {
    const createdAt = m.attributes.timestamps?.created_at;
    return { challongeId: m.id, identifier: m.attributes.identifier, players: playersOf(m), stage: stageOf(createdAt ? new Date(createdAt) : null, format) };
  });
  const groups = groupNumbers(staged.filter((m) => m.stage === "group"), format.groupSize);
  return new Map(staged.map((m) => [m.challongeId, { stage: m.stage, groupNumber: groups.get(m.challongeId) ?? null }]));
}
