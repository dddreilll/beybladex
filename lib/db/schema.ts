import type { BattleKind } from "@/lib/scoring/engine";
import type { SlotRef } from "@/lib/bracket/types";
import type { MatchRules, RuleProfile } from "@/lib/scoring/profile";
import type { Format, TournamentState } from "@/lib/tournament/format";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
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
    name: text("name").notNull(),
    state: text("state").$type<TournamentState>().notNull().default("pending"),
    /** The format (lib/tournament/format.ts); in a two-stage tournament, the final stage's. */
    tournamentType: text("tournament_type").$type<Format>().notNull(),
    /** A group stage before the final stage. */
    groupStage: boolean("group_stage").notNull().default(false),
    /** The format of the groups in a two-stage tournament, where `tournament_type` is the final stage's; null otherwise. */
    groupStageType: text("group_stage_type").$type<Format>(),
    /** How many groups, and how many players of each go through to the final stage; null without a group stage. */
    groupCount: integer("group_count"),
    advancePerGroup: integer("advance_per_group"),
    /** Double elimination: a grand final that may reset, or a single one. */
    grandFinal: text("grand_final").$type<"reset" | "single">().notNull().default("reset"),
    /** Single elimination: a match for third place between the semi-final losers. */
    thirdPlace: boolean("third_place").notNull().default(false),
    /** Round robin: whether every pair meets once or twice. */
    roundRobinLegs: integer("round_robin_legs").notNull().default(1),
    /** When the tournament was started; in a two-stage one, when its final stage was. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** How many rounds a Swiss tournament (or a Swiss stage) has; null for every other format. Its rounds are paired one at a time. */
    swissRounds: integer("swiss_rounds"),
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
    /** How many screens may show the call board at once; each one is approved by the organizer. */
    boardLimit: integer("board_limit").notNull().default(1),
    /** Short enough to type on a TV: /b/<code> opens the call board, /j/<code> the judge sign-up. */
    shortCode: text("short_code")
      .notNull()
      .unique()
      .default(sql`app.short_code()`),
    ...timestamps,
  },
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
    name: text("name").notNull(),
    seed: integer("seed"),
    active: boolean("active").notNull().default(true),
    /** Final placement, set when the tournament is finished. */
    finalRank: integer("final_rank"),
    /** 1 for the first group in a two-stage tournament; null without a group stage. */
    groupNumber: integer("group_number"),
    /** Whether the player went on to the final stage; null until a group stage has ended, and without one. */
    advanced: boolean("advanced"),
    /** The player's seed in the final stage of a two-stage tournament, once the group stage has ended (lib/bracket/two-stage.ts). */
    finalSeed: integer("final_seed"),
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
  (t) => [index("participants_tournament_idx").on(t.tournamentId, t.seed)],
);

export const matches = app.table(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    /**
     * The bracket engine's key for the match (lib/bracket): "R2-1", "L3-2", "GF1"; a group's are
     * prefixed with it, "G1:R2-1", so every key is unique in the tournament.
     */
    key: text("key").notNull(),
    identifier: text("identifier").notNull(),
    round: integer("round").notNull(),
    /** The order the matches are played in, from 1 in each stage and group. */
    playOrder: integer("play_order").notNull(),
    stage: text("stage").$type<"group" | "final">().notNull().default("final"),
    /** 1 for the first group; null in the final stage. */
    groupNumber: integer("group_number"),
    /** "open" with both players and no winner, "complete" with a winner, "pending" otherwise. */
    state: text("state").notNull(),
    player1Id: uuid("player1_id").references(() => participants.id),
    player2Id: uuid("player2_id").references(() => participants.id),
    winnerId: uuid("winner_id").references(() => participants.id),
    /** The score as players read it, "4-2", sets apart with commas. */
    scores: text("scores"),
    /** Double elimination: the losers bracket or the grand final; null in the winners bracket and in every other format. */
    section: text("section").$type<"losers" | "grand_final">(),
    thirdPlace: boolean("third_place").notNull().default(false),
    /** The grand-final reset, played only if the losers-bracket player wins the first grand final. */
    ifNeeded: boolean("if_needed").notNull().default(false),
    /** A Swiss bye: player 1 sits the round out and is given the win. Never queued. */
    bye: boolean("bye").notNull().default(false),
    /** Won because the other player dropped out: no battles, no score. */
    forfeit: boolean("forfeit").notNull().default(false),
    /** Where the winner and the loser go next, by key. */
    winnerTo: jsonb("winner_to").$type<SlotRef>(),
    loserTo: jsonb("loser_to").$type<SlotRef>(),
    /** The organizer whose account recorded the result (a judge tablet records on theirs), and when. */
    reportedBy: uuid("reported_by"),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    /** Rules frozen when scoring starts, so editing a profile can't change a match in progress. */
    ruleSnapshot: jsonb("rule_snapshot").$type<MatchRules>(),
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
  (t) => [uniqueIndex("matches_tournament_key_idx").on(t.tournamentId, t.key), index("matches_tournament_order_idx").on(t.tournamentId, t.playOrder)],
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
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("push_subscriptions_player_idx").on(t.tournamentId, t.participantId)],
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
    /** When the screen said its tab was closing; cleared when it checks in again (lib/access.ts). */
    closedAt: timestamp("closed_at", { withTimezone: true }),
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
    /** When the tablet said its tab was closing; cleared when it checks in again (lib/judges.ts). */
    closedAt: timestamp("closed_at", { withTimezone: true }),
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
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** The cookie this one replaced, so the previous phone can be told why it was signed out. */
    replacedTokenHash: text("replaced_token_hash"),
    device: text("device").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the Pass said its tab was closing; cleared when it checks in again (lib/access.ts). */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("player_sessions_player_idx").on(t.tournamentId, t.participantId)],
);

/** Wrong passcode attempts, kept for a short while to slow down guessing. */
export const signInFailures = app.table(
  "sign_in_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "cascade" }),
    /** "player:<participant id>" or "net:<hashed address>". */
    bucket: text("bucket").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sign_in_failures_bucket_idx").on(t.tournamentId, t.bucket, t.createdAt)],
);

export type Tournament = typeof tournaments.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type Match = typeof matches.$inferSelect;
export type RuleProfileRow = typeof ruleProfiles.$inferSelect;
export type Stadium = typeof stadiums.$inferSelect;
export type BattleRow = typeof battles.$inferSelect;
export type BoardScreen = typeof boardScreens.$inferSelect;
export type JudgeScreen = typeof judgeScreens.$inferSelect;
export type PlayerSession = typeof playerSessions.$inferSelect;
