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
    /** A group stage before the final stage; with the type, decides whether the app can run it (lib/challonge/support.ts). */
    groupStage: boolean("group_stage").notNull().default(false),
    /** The format of the groups in a two-stage tournament, where `tournament_type` is the final stage's; null otherwise. */
    groupStageType: text("group_stage_type"),
    /** How many players a group has at most; null without a group stage. */
    groupSize: integer("group_size"),
    /** When Challonge started the tournament: in a two-stage one, its final stage. Tells the matches of the two stages apart (lib/challonge/stages.ts). */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** How many rounds a Swiss tournament has; null for every other format. Its rounds arrive one at a time. */
    swissRounds: integer("swiss_rounds"),
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
    /** How many screens may show the call board at once; each one is approved by the organizer. */
    boardLimit: integer("board_limit").notNull().default(1),
    /** Short enough to type on a TV: /b/<code> opens the call board, /j/<code> the judge sign-up. */
    shortCode: text("short_code")
      .notNull()
      .unique()
      .default(sql`app.short_code()`),
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
    /** Final placement, read from Challonge once the tournament is finalized. */
    finalRank: integer("final_rank"),
    /** Whether the player went on to the final stage; null until a group stage has ended, and without one. */
    advanced: boolean("advanced"),
    /** What the player types to open their page. Readable on purpose: the organizer hands it out. */
    passcode: text("passcode")
      .notNull()
      .default(sql`lpad(floor(random() * 10000)::int::text, 4, '0')`),
    /** The long secret inside the player's personal QR code, so scanning needs no typing. */
    signInToken: text("sign_in_token")
      .notNull()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
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
    /** Challonge doesn't say which stage or group a match is in, so both are worked out (lib/challonge/stages.ts). */
    stage: text("stage").$type<"group" | "final">().notNull().default("final"),
    /** 1 for the first group; null in the final stage, and when the groups couldn't be told apart. */
    groupNumber: integer("group_number"),
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

export const screenStatus = app.enum("screen_status", ["pending", "approved"]);

/** A browser that asked to show the call board. It gets board data only once the organizer approves it. */
export const boardScreens = app.table(
  "board_screens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    /** Shown on the screen itself, so the organizer can tell which request is which. */
    pairingCode: text("pairing_code").notNull(),
    /** SHA-256 of the cookie the screen holds; the cookie itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    status: screenStatus("status").notNull().default("pending"),
    device: text("device").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("board_screens_tournament_idx").on(t.tournamentId, t.status)],
);

/**
 * Who judges a stadium: a tablet that asked and was approved, or the organizer themselves
 * ("Judge here myself", which has no cookie). A match can't start until its stadium has one.
 */
export const judgeScreens = app.table(
  "judge_screens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    /** Removing a stadium removes its judge and any requests for it. */
    stadiumId: uuid("stadium_id")
      .notNull()
      .references(() => stadiums.id, { onDelete: "cascade" }),
    pairingCode: text("pairing_code"),
    /** SHA-256 of the tablet's cookie; null when the organizer judges the stadium themselves. */
    tokenHash: text("token_hash").unique(),
    status: screenStatus("status").notNull().default("pending"),
    byOrganizer: boolean("by_organizer").notNull().default(false),
    /** What the tablet's browser looks like ("Chrome on Android"); the name a judge starts with. */
    device: text("device").notNull(),
    /** What the judge is called in the control room. They, or the organizer, can change it. */
    name: text("name").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("judge_screens_tournament_idx").on(t.tournamentId, t.status),
    // One judge per stadium, guaranteed by the database.
    uniqueIndex("judge_screens_stadium_judge_idx").on(t.stadiumId).where(sql`${t.status} = 'approved'`),
  ],
);

/** The one device a player is signed in on. Signing in elsewhere replaces the row's cookie. */
export const playerSessions = app.table(
  "player_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    participantChallongeId: text("participant_challonge_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** The cookie this one replaced, so the previous phone can be told why it was signed out. */
    replacedTokenHash: text("replaced_token_hash"),
    device: text("device").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("player_sessions_player_idx").on(t.tournamentId, t.participantChallongeId)],
);

/** Wrong passcode attempts, kept for a short while to slow down guessing. */
export const signInFailures = app.table(
  "sign_in_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    /** "player:<challonge id>" or "net:<hashed address>". */
    bucket: text("bucket").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sign_in_failures_bucket_idx").on(t.tournamentId, t.bucket, t.createdAt)],
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
export type BoardScreen = typeof boardScreens.$inferSelect;
export type JudgeScreen = typeof judgeScreens.$inferSelect;
export type PlayerSession = typeof playerSessions.$inferSelect;
