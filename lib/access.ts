import "server-only";
import { createHash } from "node:crypto";
import { and, asc, count, eq, gt, lt, min, or, sql } from "drizzle-orm";
import {
  boardCookie,
  deviceLabel,
  hashToken,
  newPairingCode,
  newPasscode,
  newSessionToken,
  newSignInToken,
  playerCookie,
  sameSecret,
} from "@/lib/access-codes";
import { db } from "@/lib/db";
import {
  boardScreens,
  judgeScreens,
  participants,
  playerSessions,
  pushSubscriptions,
  signInFailures,
  stadiums,
  tournaments,
} from "@/lib/db/schema";
import { formatRelative } from "@/lib/format";
import { bumpBoard } from "@/lib/venue";

// Who may see what on the public pages (/t/<slug>):
//  - a call board screen asks for access, shows a pairing code, and gets board data only after the
//    organizer approves it in the control room, up to the tournament's limit;
//  - a player signs in with their own passcode (or personal QR code) on one device at a time.
// Both are remembered with an httpOnly cookie whose hash is stored here.

/** Screens check in at least once a minute; one that has been quiet longer than this is closed. */
export const SCREEN_OPEN_MS = 150_000;
/** Don't write "last seen" on every poll. */
const SEEN_WRITE_MS = 20_000;
const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING_SCREENS = 8;
export const SESSION_COOKIE_SECONDS = 30 * 24 * 60 * 60;

// Guessing a 4-digit passcode: 10 wrong tries per player per 10 minutes makes a full sweep of one
// player take days. The per-network limit is loose because a whole venue shares one address.
const PLAYER_WINDOW_MS = 10 * 60_000;
const PLAYER_MAX_FAILURES = 10;
const NETWORK_WINDOW_MS = 5 * 60_000;
const NETWORK_MAX_FAILURES = 30;

export { boardCookie, playerCookie };

/** Cookie settings shared by both kinds of session. `secure` follows how the request arrived. */
export function sessionCookie(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: SESSION_COOKIE_SECONDS };
}

/** A short, non-reversible name for the caller's network, used only to count wrong passcodes. */
export function networkKey(headers: Headers): string {
  const address = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "local";
  return createHash("sha256").update(address).digest("hex").slice(0, 16);
}

const isOpen = (lastSeenAt: Date, now: number) => now - lastSeenAt.getTime() < SCREEN_OPEN_MS;

async function tournamentBySlug(slug: string) {
  const [row] = await db
    .select({ id: tournaments.id, boardLimit: tournaments.boardLimit })
    .from(tournaments)
    .where(eq(tournaments.publicSlug, slug))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------
// Call board screens
// ---------------------------------------------------------------------------------------------

export type BoardAccess =
  | { status: "approved"; version: number }
  | { status: "pending"; code: string }
  | { status: "none" };

/** What the screen holding this cookie may do. Also records that an approved screen is still open. */
export async function boardAccess(slug: string, token: string | undefined): Promise<BoardAccess> {
  if (!token) return { status: "none" };
  const [row] = await db
    .select({
      id: boardScreens.id,
      status: boardScreens.status,
      code: boardScreens.pairingCode,
      lastSeenAt: boardScreens.lastSeenAt,
      createdAt: boardScreens.createdAt,
      version: tournaments.boardVersion,
    })
    .from(boardScreens)
    .innerJoin(tournaments, eq(tournaments.id, boardScreens.tournamentId))
    .where(and(eq(tournaments.publicSlug, slug), eq(boardScreens.tokenHash, hashToken(token))))
    .limit(1);
  if (!row) return { status: "none" };

  if (row.status === "pending") {
    if (Date.now() - row.createdAt.getTime() > PENDING_TTL_MS) {
      await db.delete(boardScreens).where(eq(boardScreens.id, row.id));
      return { status: "none" };
    }
    return { status: "pending", code: row.code };
  }
  if (Date.now() - row.lastSeenAt.getTime() > SEEN_WRITE_MS) {
    await db.update(boardScreens).set({ lastSeenAt: new Date() }).where(eq(boardScreens.id, row.id));
  }
  return { status: "approved", version: row.version };
}

export type PairingResult =
  | { status: "approved" }
  /** `token` is set when a new request was created and the screen needs its cookie. */
  | { status: "pending"; code: string; token?: string }
  | { status: "not_found" }
  | { status: "busy" };

/** A screen asks to show the board. Asking again with the same cookie returns the same code. */
export async function requestBoardAccess(slug: string, token: string | undefined, userAgent: string | null): Promise<PairingResult> {
  const tournament = await tournamentBySlug(slug);
  if (!tournament) return { status: "not_found" };

  const existing = await boardAccess(slug, token);
  if (existing.status === "approved") return { status: "approved" };
  if (existing.status === "pending") return { status: "pending", code: existing.code };

  const fresh = await db.transaction(async (tx) => {
    // One request at a time per tournament, so the cap and the code's uniqueness hold.
    await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, tournament.id)).for("update");
    await tx
      .delete(boardScreens)
      .where(
        and(
          eq(boardScreens.tournamentId, tournament.id),
          eq(boardScreens.status, "pending"),
          lt(boardScreens.createdAt, new Date(Date.now() - PENDING_TTL_MS)),
        ),
      );
    const rows = await tx
      .select({ code: boardScreens.pairingCode, status: boardScreens.status })
      .from(boardScreens)
      .where(eq(boardScreens.tournamentId, tournament.id));
    // The request page is public: don't let it fill the organizer's list.
    if (rows.filter((r) => r.status === "pending").length >= MAX_PENDING_SCREENS) return null;

    let code = newPairingCode();
    while (rows.some((r) => r.code === code)) code = newPairingCode();
    const sessionToken = newSessionToken();
    await tx.insert(boardScreens).values({
      tournamentId: tournament.id,
      pairingCode: code,
      tokenHash: hashToken(sessionToken),
      device: deviceLabel(userAgent),
    });
    // Makes the control room show the request straight away.
    await bumpBoard(tx, tournament.id);
    return { code, token: sessionToken };
  });
  return fresh ? { status: "pending", ...fresh } : { status: "busy" };
}

async function ownedScreen(organizerId: string, screenId: string) {
  const [row] = await db
    .select({ id: boardScreens.id, status: boardScreens.status, tournamentId: boardScreens.tournamentId })
    .from(boardScreens)
    .innerJoin(tournaments, eq(tournaments.id, boardScreens.tournamentId))
    .where(and(eq(boardScreens.id, screenId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  return row ?? null;
}

/** Lets a waiting screen show the board, unless the tournament already has as many as its limit. */
export async function approveBoardScreen(organizerId: string, screenId: string): Promise<{ error?: string }> {
  const screen = await ownedScreen(organizerId, screenId);
  if (!screen) return { error: "That screen is no longer waiting. It may have been closed." };
  if (screen.status === "approved") return {};

  return db.transaction(async (tx) => {
    const [tournament] = await tx
      .select({ boardLimit: tournaments.boardLimit })
      .from(tournaments)
      .where(eq(tournaments.id, screen.tournamentId))
      .for("update");
    const [{ approved }] = await tx
      .select({ approved: count() })
      .from(boardScreens)
      .where(and(eq(boardScreens.tournamentId, screen.tournamentId), eq(boardScreens.status, "approved")));
    if (approved >= tournament.boardLimit) {
      return {
        error: `The limit is ${tournament.boardLimit} board${tournament.boardLimit === 1 ? "" : "s"}. Disconnect one first, or raise the limit in Venue settings.`,
      };
    }
    const now = new Date();
    const updated = await tx
      .update(boardScreens)
      .set({ status: "approved", approvedAt: now, lastSeenAt: now })
      .where(and(eq(boardScreens.id, screenId), eq(boardScreens.status, "pending")))
      .returning({ id: boardScreens.id });
    if (updated.length === 0) return { error: "That screen is no longer waiting. It may have been closed." };
    await bumpBoard(tx, screen.tournamentId);
    return {};
  });
}

/** Declines a waiting screen or disconnects an approved one: its cookie stops working at once. */
export async function removeBoardScreen(organizerId: string, screenId: string): Promise<boolean> {
  const screen = await ownedScreen(organizerId, screenId);
  if (!screen) return false;
  await db.delete(boardScreens).where(eq(boardScreens.id, screenId));
  // A connected board checks in as soon as the version moves, and finds it is no longer approved.
  await bumpBoard(db, screen.tournamentId);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Player sessions
// ---------------------------------------------------------------------------------------------

export type PlayerAccess =
  | { status: "signed_in"; playerId: string; version: number }
  /** This cookie was valid until the player signed in on another device. */
  | { status: "replaced" }
  | { status: "none" };

export async function playerAccess(slug: string, token: string | undefined): Promise<PlayerAccess> {
  if (!token) return { status: "none" };
  const hash = hashToken(token);
  const [row] = await db
    .select({
      id: playerSessions.id,
      tokenHash: playerSessions.tokenHash,
      playerId: playerSessions.participantChallongeId,
      lastSeenAt: playerSessions.lastSeenAt,
      version: tournaments.boardVersion,
    })
    .from(playerSessions)
    .innerJoin(tournaments, eq(tournaments.id, playerSessions.tournamentId))
    .where(and(eq(tournaments.publicSlug, slug), or(eq(playerSessions.tokenHash, hash), eq(playerSessions.replacedTokenHash, hash))))
    .limit(1);
  if (!row) return { status: "none" };
  if (row.tokenHash !== hash) return { status: "replaced" };

  if (Date.now() - row.lastSeenAt.getTime() > SEEN_WRITE_MS) {
    await db.update(playerSessions).set({ lastSeenAt: new Date() }).where(eq(playerSessions.id, row.id));
  }
  return { status: "signed_in", playerId: row.playerId, version: row.version };
}

/** How long until this bucket may try again, or 0 if it is under its limit. */
async function throttledFor(tournamentId: string, bucket: string, windowMs: number, max: number): Promise<number> {
  const [row] = await db
    .select({ failures: count(), oldest: min(signInFailures.createdAt) })
    .from(signInFailures)
    .where(
      and(
        eq(signInFailures.tournamentId, tournamentId),
        eq(signInFailures.bucket, bucket),
        gt(signInFailures.createdAt, new Date(Date.now() - windowMs)),
      ),
    );
  if (row.failures < max || !row.oldest) return 0;
  // The failures are stamped by the database, whose clock can be slightly ahead of ours.
  const seconds = Math.ceil((row.oldest.getTime() + windowMs - Date.now()) / 1000);
  return Math.min(Math.max(1, seconds), Math.ceil(windowMs / 1000));
}

async function recordFailure(tournamentId: string, buckets: string[]) {
  await db.insert(signInFailures).values(buckets.map((bucket) => ({ tournamentId, bucket })));
  // Old rows have no further use; tidy them while we're here.
  await db
    .delete(signInFailures)
    .where(and(eq(signInFailures.tournamentId, tournamentId), lt(signInFailures.createdAt, new Date(Date.now() - 60 * 60_000))));
}

export type SignInInput = { playerId: string; code: string } | { token: string };
export type SignInResult =
  /** `token` is null when this device was already signed in as that player and keeps its cookie. */
  | { status: "ok"; playerId: string; token: string | null }
  | { status: "wrong" }
  | { status: "throttled"; retryInSeconds: number }
  | { status: "not_found" };

/**
 * Signs a player in with their passcode or their personal QR secret. A player has one session:
 * signing in on another device replaces it, and the previous device is told on its next check.
 */
export async function signInPlayer(
  slug: string,
  input: SignInInput,
  context: { currentToken?: string; userAgent: string | null; network: string },
): Promise<SignInResult> {
  const tournament = await tournamentBySlug(slug);
  if (!tournament) return { status: "not_found" };

  const network = `net:${context.network}`;
  const networkWait = await throttledFor(tournament.id, network, NETWORK_WINDOW_MS, NETWORK_MAX_FAILURES);
  if (networkWait) return { status: "throttled", retryInSeconds: networkWait };

  let playerId: string;
  if ("token" in input) {
    const [player] = await db
      .select({ id: participants.challongeId })
      .from(participants)
      .where(and(eq(participants.tournamentId, tournament.id), eq(participants.signInToken, input.token)))
      .limit(1);
    if (!player) {
      await recordFailure(tournament.id, [network]);
      return { status: "wrong" };
    }
    playerId = player.id;
  } else {
    const bucket = `player:${input.playerId}`;
    // Checked before the passcode: while a player is locked, even the right code is refused,
    // otherwise the lock wouldn't slow a guesser down at all.
    const playerWait = await throttledFor(tournament.id, bucket, PLAYER_WINDOW_MS, PLAYER_MAX_FAILURES);
    if (playerWait) return { status: "throttled", retryInSeconds: playerWait };
    const [player] = await db
      .select({ id: participants.challongeId, passcode: participants.passcode })
      .from(participants)
      .where(and(eq(participants.tournamentId, tournament.id), eq(participants.challongeId, input.playerId)))
      .limit(1);
    if (!player || !sameSecret(player.passcode, input.code)) {
      await recordFailure(tournament.id, player ? [network, bucket] : [network]);
      return { status: "wrong" };
    }
    playerId = player.id;
  }

  const mine = and(eq(playerSessions.tournamentId, tournament.id), eq(playerSessions.participantChallongeId, playerId));
  if (context.currentToken) {
    const [current] = await db.select({ tokenHash: playerSessions.tokenHash }).from(playerSessions).where(mine).limit(1);
    if (current?.tokenHash === hashToken(context.currentToken)) return { status: "ok", playerId, token: null };
  }

  const token = newSessionToken();
  const now = new Date();
  const values = { tokenHash: hashToken(token), device: deviceLabel(context.userAgent), lastSeenAt: now, createdAt: now };
  await db.transaction(async (tx) => {
    await tx
      .insert(playerSessions)
      .values({ tournamentId: tournament.id, participantChallongeId: playerId, ...values })
      .onConflictDoUpdate({
        target: [playerSessions.tournamentId, playerSessions.participantChallongeId],
        // The right-hand side reads the row as it was: the cookie being replaced.
        set: { ...values, replacedTokenHash: sql`${playerSessions.tokenHash}` },
      });
    // One screen per player also means one phone gets the calls: the new device subscribes itself.
    await tx
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.tournamentId, tournament.id), eq(pushSubscriptions.participantChallongeId, playerId)));
  });
  return { status: "ok", playerId, token };
}

/** "Not you?": ends this device's session and stops its notifications. */
export async function signOutPlayer(slug: string, token: string | undefined) {
  if (!token) return;
  const tournament = await tournamentBySlug(slug);
  if (!tournament) return;
  const removed = await db
    .delete(playerSessions)
    .where(and(eq(playerSessions.tournamentId, tournament.id), eq(playerSessions.tokenHash, hashToken(token))))
    .returning({ playerId: playerSessions.participantChallongeId });
  for (const { playerId } of removed) {
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.tournamentId, tournament.id), eq(pushSubscriptions.participantChallongeId, playerId)));
  }
}

/**
 * Gives a player a new passcode and QR secret and signs their device out. For a passcode that
 * got around, or a player locked out by wrong guesses (the lock is cleared too).
 */
export async function resetPlayerAccess(organizerId: string, tournamentId: string, playerId: string): Promise<boolean> {
  const [owned] = await db
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(and(eq(tournaments.id, tournamentId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  if (!owned) return false;

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(participants)
      .set({ passcode: newPasscode(), signInToken: newSignInToken() })
      .where(and(eq(participants.tournamentId, tournamentId), eq(participants.challongeId, playerId)))
      .returning({ id: participants.id });
    if (updated.length === 0) return false;
    await tx
      .delete(playerSessions)
      .where(and(eq(playerSessions.tournamentId, tournamentId), eq(playerSessions.participantChallongeId, playerId)));
    await tx
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.tournamentId, tournamentId), eq(pushSubscriptions.participantChallongeId, playerId)));
    await tx
      .delete(signInFailures)
      .where(and(eq(signInFailures.tournamentId, tournamentId), eq(signInFailures.bucket, `player:${playerId}`)));
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// What the control room shows
// ---------------------------------------------------------------------------------------------

export type ScreenInfo = {
  id: string;
  code: string;
  status: "pending" | "approved";
  device: string;
  /** "asked 2 minutes ago" / "approved 1 hour ago". */
  since: string;
  /** Checked in recently, i.e. the board is on screen right now. */
  open: boolean;
  seen: string;
};

/** A stadium's judge, or a tablet asking to become it (see lib/judges.ts). */
export type JudgeInfo = {
  id: string;
  /** The code on the tablet's screen; null for the organizer judging the stadium themselves. */
  code: string | null;
  status: "pending" | "approved";
  stadiumId: string;
  stadium: string;
  /** What the judge is called: their own choice, or the detected device until they change it. */
  name: string;
  device: string;
  byOrganizer: boolean;
  since: string;
  open: boolean;
  seen: string;
};

export type AccessOverview = {
  /** When this was read, so the control room can tell which of two copies is newer. */
  at: number;
  limit: number;
  boards: ScreenInfo[];
  judges: JudgeInfo[];
  /** Signed-in players, by player id. */
  players: Record<string, { device: string; open: boolean; seen: string }>;
};

export async function accessOverview(tournamentId: string, limit: number): Promise<AccessOverview> {
  const now = Date.now();
  const [screens, sessions, judges] = await Promise.all([
    db.select().from(boardScreens).where(eq(boardScreens.tournamentId, tournamentId)).orderBy(asc(boardScreens.createdAt)),
    db.select().from(playerSessions).where(eq(playerSessions.tournamentId, tournamentId)),
    db
      .select({ judge: judgeScreens, stadium: stadiums.name })
      .from(judgeScreens)
      .innerJoin(stadiums, eq(stadiums.id, judgeScreens.stadiumId))
      .where(eq(judgeScreens.tournamentId, tournamentId))
      .orderBy(asc(judgeScreens.createdAt)),
  ]);
  return {
    at: now,
    limit,
    boards: screens
      // Requests nobody answered drop off the list (and are deleted when the next one arrives).
      .filter((s) => s.status === "approved" || now - s.createdAt.getTime() <= PENDING_TTL_MS)
      .map((s) => ({
        id: s.id,
        code: s.pairingCode,
        status: s.status,
        device: s.device,
        since: s.status === "approved" && s.approvedAt ? `approved ${formatRelative(s.approvedAt, now)}` : `asked ${formatRelative(s.createdAt, now)}`,
        open: s.status === "approved" && isOpen(s.lastSeenAt, now),
        seen: formatRelative(s.lastSeenAt, now),
      })),
    judges: judges
      .filter(({ judge }) => judge.status === "approved" || now - judge.createdAt.getTime() <= PENDING_TTL_MS)
      .map(({ judge, stadium }) => ({
        id: judge.id,
        code: judge.pairingCode,
        status: judge.status,
        stadiumId: judge.stadiumId,
        stadium,
        name: judge.name,
        device: judge.device,
        byOrganizer: judge.byOrganizer,
        since:
          judge.status === "approved" && judge.approvedAt ? `approved ${formatRelative(judge.approvedAt, now)}` : `asked ${formatRelative(judge.createdAt, now)}`,
        // The organizer judging a stadium has no tablet to check in; they count as present.
        open: judge.status === "approved" && (judge.byOrganizer || isOpen(judge.lastSeenAt, now)),
        seen: formatRelative(judge.lastSeenAt, now),
      })),
    players: Object.fromEntries(
      sessions.map((s) => [s.participantChallongeId, { device: s.device, open: isOpen(s.lastSeenAt, now), seen: formatRelative(s.lastSeenAt, now) }]),
    ),
  };
}
