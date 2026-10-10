import type { BattleKind, ChallongeMatchEntry } from "@/lib/scoring/engine";
import type { MatchRules, RuleProfile } from "@/lib/scoring/profile";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Our tables live in their own schema, which Supabase's Data API does not expose;
// all access goes through the server with the organizer id taken from the session.
export const app = pgSchema("app");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const connectionStatus = app.enum("connection_status", [
  "credentials_saved",
  "connected",
  "reconnect_required",
]);

/** One Challonge OAuth app per organizer (bring-your-own keys). Secrets are AES-GCM envelopes. */
export const challongeConnections = app.table("challonge_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizerId: uuid("organizer_id").notNull().unique(),
  clientId: text("client_id").notNull(),
  clientSecretEnc: text("client_secret_enc").notNull(),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  scopes: text("scopes"),
  challongeUserId: text("challonge_user_id"),
  challongeUsername: text("challonge_username"),
  status: connectionStatus("status").notNull().default("credentials_saved"),
  lastError: text("last_error"),
  ...timestamps,
});

/** Our own count of requests per connection per month; every request counts, including 304s and token calls. */
export const apiUsage = app.table(
  "api_usage",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => challongeConnections.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.month] })],
);

/** An organizer's own scoring rules. Presets live in code (lib/scoring/profile.ts), not here. */
export const ruleProfiles = app.table(
  "rule_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizerId: uuid("organizer_id").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<RuleProfile>().notNull(),
    ...timestamps,
  },
  (t) => [index("rule_profiles_organizer_idx").on(t.organizerId)],
);

export const tournaments = app.table(
  "tournaments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizerId: uuid("organizer_id").notNull(),
    challongeId: text("challonge_id").notNull(),
    challongeUrl: text("challonge_url").notNull(),
    communityId: text("community_id"),
    name: text("name").notNull(),
    state: text("state").notNull(),
    tournamentType: text("tournament_type").notNull(),
    participantsCount: integer("participants_count").notNull().default(0),
    matchesEtag: text("matches_etag"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Rules: the organizer's profile if set, otherwise this preset. */
    rulePresetKey: text("rule_preset_key").notNull().default("first-to-4"),
    ruleProfileId: uuid("rule_profile_id").references(() => ruleProfiles.id, { onDelete: "set null" }),
    /** Unguessable id for the public call board and player page (/t/<slug>). */
    publicSlug: text("public_slug")
      .notNull()
      .unique()
      .default(sql`substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)`),
    /** Bumped on every change the board or control room should show; doubles as their polling ETag. */
    boardVersion: integer("board_version").notNull().default(0),
    /** Put the next ready match on deck automatically; off = the organizer places matches by hand. */
    autoOnDeck: boolean("auto_on_deck").notNull().default(true),
    /** When a stadium frees up, call its on-deck match automatically. */
    autoCall: boolean("auto_call").notNull().default(true),
    /** Also mark matches underway on Challonge when they start (1 extra request per match). */
    markUnderway: boolean("mark_underway").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("tournaments_organizer_challonge_idx").on(t.organizerId, t.challongeId)],
);

export const stadiums = app.table(
  "stadiums",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("stadiums_tournament_idx").on(t.tournamentId, t.position)],
);

export const callStatus = app.enum("call_status", ["none", "on_deck", "called", "playing"]);

export const participants = app.table(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    challongeId: text("challonge_id").notNull(),
    name: text("name").notNull(),
    seed: integer("seed"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("participants_tournament_challonge_idx").on(t.tournamentId, t.challongeId)],
);

export const matches = app.table(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    challongeId: text("challonge_id").notNull(),
    identifier: text("identifier").notNull(),
    round: integer("round").notNull(),
    suggestedPlayOrder: integer("suggested_play_order"),
    state: text("state").notNull(),
    player1ChallongeId: text("player1_challonge_id"),
    player2ChallongeId: text("player2_challonge_id"),
    winnerChallongeId: text("winner_challonge_id"),
    scores: text("scores"),
    scoreInSets: jsonb("score_in_sets").$type<number[][]>().notNull().default([]),
    underwayAt: timestamp("underway_at", { withTimezone: true }),
    /** Rules frozen when scoring starts, so editing a profile can't change a match in progress. */
    ruleSnapshot: jsonb("rule_snapshot").$type<MatchRules>(),
    /** Learned after reporting (Challonge doesn't expose bracket links; spike S3). */
    winnerNextChallongeId: text("winner_next_challonge_id"),
    loserNextChallongeId: text("loser_next_challonge_id"),
    /** Venue queue (local only): which stadium the match is assigned to, and how far along it is. */
    stadiumId: uuid("stadium_id").references(() => stadiums.id, { onDelete: "set null" }),
    callStatus: callStatus("call_status").notNull().default("none"),
    calledAt: timestamp("called_at", { withTimezone: true }),
    /** 1 for the first call, +1 for every recall; 0 while the match isn't called. */
    callCount: integer("call_count").notNull().default(0),
    playingAt: timestamp("playing_at", { withTimezone: true }),
    /** Kept out of the queue (e.g. a no-show) until released. */
    held: boolean("held").notNull().default(false),
    /** The call status players were last pushed about; differs from call_status = a push is due. */
    notifiedStatus: callStatus("notified_status"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("matches_tournament_challonge_idx").on(t.tournamentId, t.challongeId),
    index("matches_tournament_order_idx").on(t.tournamentId, t.suggestedPlayOrder),
  ],
);

/** Every judge tap. Undo voids a battle instead of deleting it; `op_id` makes retries idempotent. */
export const battles = app.table(
  "battles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    opId: uuid("op_id").notNull().unique(),
    kind: text("kind").$type<BattleKind>().notNull(),
    side: integer("side").$type<1 | 2>(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [index("battles_match_seq_idx").on(t.matchId, t.seq)],
);

/** A player's browser push subscription for one tournament (opt-in from the public player page). */
export const pushSubscriptions = app.table(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    participantChallongeId: text("participant_challonge_id").notNull(),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("push_subscriptions_player_idx").on(t.tournamentId, t.participantChallongeId)],
);

export const outboxStatus = app.enum("outbox_status", ["pending", "done", "failed", "conflict"]);

/** Results on their way to Challonge, kept for retries and as an audit trail of who reported what. */
export const syncOutbox = app.table(
  "sync_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"report_result" | "correct_result">().notNull(),
    payload: jsonb("payload").$type<{ winnerId: string; loserId: string; entries: ChallongeMatchEntry[] }>().notNull(),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdBy: uuid("created_by").notNull(),
    ...timestamps,
  },
  (t) => [index("sync_outbox_tournament_status_idx").on(t.tournamentId, t.status)],
);

export type ChallongeConnection = typeof challongeConnections.$inferSelect;
export type Tournament = typeof tournaments.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type Match = typeof matches.$inferSelect;
export type RuleProfileRow = typeof ruleProfiles.$inferSelect;
export type Stadium = typeof stadiums.$inferSelect;
export type BattleRow = typeof battles.$inferSelect;
export type OutboxRow = typeof syncOutbox.$inferSelect;
