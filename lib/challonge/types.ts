// Shapes of the Challonge v2.1 JSON:API responses we rely on.
// Field lists follow what the live API returned in the spikes (docs/rfc-001-architecture.md),
// which differs from the published docs in places (e.g. match players).

export type Resource<TType extends string, TAttributes> = {
  id: string;
  type: TType;
  attributes: TAttributes;
  relationships?: Record<string, unknown>;
};

export type ListResponse<T> = {
  data: T[];
  meta?: { count?: number };
  links?: { self?: string; next?: string | null; prev?: string | null };
};

export type SingleResponse<T> = { data: T };

export type TournamentAttributes = {
  name: string;
  url: string;
  state: string;
  tournament_type: string;
  participants_count: number;
  full_challonge_url?: string;
  timestamps?: { started_at?: string | null; updated_at?: string | null; completed_at?: string | null };
};

export type ParticipantAttributes = {
  name: string;
  seed: number | null;
  misc: string | null;
  states?: { active?: boolean };
};

export type MatchAttributes = {
  state: "pending" | "open" | "complete";
  round: number;
  identifier: string;
  suggested_play_order: number | null;
  scores: string | null;
  score_in_sets: number[][] | null;
  points_by_participant: { participant_id: number | null; scores: number[] }[] | null;
  winner_id: number | null;
  tie: boolean;
  timestamps?: { underway_at?: string | null; updated_at?: string | null };
};

export type TournamentResource = Resource<"tournament", TournamentAttributes>;
export type ParticipantResource = Resource<"participant", ParticipantAttributes>;
export type MatchResource = Resource<"match", MatchAttributes>;

export type ChallongeUser = Resource<"user", { username: string; email?: string; image_url?: string }>;

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  created_at?: number;
  scope?: string;
  token_type?: string;
};
