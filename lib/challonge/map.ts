import type { GrandFinals, TournamentPreview } from "./support";
import type { MatchResource, ParticipantResource, TournamentAttributes, TournamentResource } from "./types";

const toId = (value: number | string | null | undefined) => (value == null ? null : String(value));

/**
 * The docs describe relationships.player1/player2, but the live API only returns the players
 * in attributes.points_by_participant (participant_id is null until the slot is filled).
 */
export function playersOf(match: MatchResource): [string | null, string | null] {
  const slots = match.attributes.points_by_participant ?? [];
  return [toId(slots[0]?.participant_id), toId(slots[1]?.participant_id)];
}

export function mapTournament(t: TournamentResource) {
  const a = t.attributes;
  return {
    challongeId: t.id,
    challongeUrl: a.url,
    name: a.name,
    state: a.state,
    tournamentType: a.tournament_type,
    participantsCount: a.participants_count ?? 0,
    groupStage: a.group_stage_enabled ?? false,
  };
}

const GRAND_FINALS: Record<string, GrandFinals> = { "": "reset", "single match": "single", skip: "skip" };

function grandFinalsOf(options: TournamentAttributes["double_elimination_options"]): GrandFinals | null {
  if (!options) return null;
  return GRAND_FINALS[options.grand_finals_modifier ?? ""] ?? null;
}

function thirdPlaceMatchOf(options: TournamentAttributes["match_options"]): boolean | null {
  if (!options) return null;
  if (typeof options.third_place_match === "boolean") return options.third_place_match;
  if (options.consolation_matches_target_rank === undefined) return null;
  return (options.consolation_matches_target_rank ?? 0) >= 3;
}

/** The tournament as the organizer reviews it before importing; `formatOptions` turns the two options into text. */
export function previewTournament(t: TournamentResource): TournamentPreview {
  const { challongeId, challongeUrl, name, state, tournamentType, participantsCount } = mapTournament(t);
  return {
    challongeId,
    challongeUrl,
    name,
    state,
    tournamentType,
    participantsCount,
    grandFinals: grandFinalsOf(t.attributes.double_elimination_options),
    thirdPlaceMatch: thirdPlaceMatchOf(t.attributes.match_options),
  };
}

/** Challonge's states for a finalized tournament ("ended" is the older name). */
export const isFinalState = (state: string) => state === "complete" || state === "ended";

export function mapParticipant(p: ParticipantResource) {
  return {
    challongeId: p.id,
    name: p.attributes.name,
    seed: p.attributes.seed,
    active: p.attributes.states?.active ?? true,
    finalRank: p.attributes.final_rank ?? null,
  };
}

export function mapMatch(m: MatchResource) {
  const a = m.attributes;
  const [player1, player2] = playersOf(m);
  return {
    challongeId: m.id,
    identifier: a.identifier,
    round: a.round,
    suggestedPlayOrder: a.suggested_play_order,
    state: a.state,
    player1ChallongeId: player1,
    player2ChallongeId: player2,
    winnerChallongeId: toId(a.winner_id),
    scores: a.scores,
    scoreInSets: a.score_in_sets ?? [],
    underwayAt: a.timestamps?.underway_at ? new Date(a.timestamps.underway_at) : null,
  };
}

export type RoundContext = { tournamentType: string; maxRound: number; minRound: number };

export function roundContext(tournamentType: string, rounds: number[]): RoundContext {
  return {
    tournamentType,
    maxRound: rounds.length ? Math.max(...rounds) : 0,
    minRound: rounds.length ? Math.min(...rounds) : 0,
  };
}

const PLACES: Record<string, string> = { "3": "Third place", "5": "Fifth place", "7": "Seventh place" };

/**
 * Challonge puts every consolation match of a single elimination bracket in round 0 and tells
 * them apart by identifier: 3P, 5P and 7P decide a place, 5PQ1 and 5PQ2 lead to 5P (spikes S6, S15).
 */
function consolationLabel(identifier: string | undefined): string {
  const [, place, qualifier] = /^(\d+)P(Q\d+)?$/.exec(identifier ?? "") ?? [];
  const label = PLACES[place];
  if (!label) return "Placement match";
  return qualifier ? `${label} qualifier` : label;
}

/**
 * Human labels for Challonge round numbers (losers-bracket rounds are negative). The match's
 * identifier is only needed for round 0, where every consolation match shares the round.
 */
export function roundLabel(round: number, ctx: RoundContext, identifier?: string): string {
  const isDouble = ctx.tournamentType.toLowerCase().includes("double");
  if (!isDouble) {
    if (round === 0) return consolationLabel(identifier);
    if (round === ctx.maxRound && ctx.maxRound > 1) return "Final";
    return `Round ${round}`;
  }
  if (round < 0) return round === ctx.minRound ? "Losers Final" : `Losers R${-round}`;
  if (round === ctx.maxRound) return "Grand Finals";
  if (round === ctx.maxRound - 1) return "Winners Final";
  return `Winners R${round}`;
}
