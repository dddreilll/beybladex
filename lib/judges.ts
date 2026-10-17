import "server-only";
import { and, asc, count, eq, inArray, lt, ne } from "drizzle-orm";
import { deviceLabel, hashToken, judgeCookie, judgeName, newPairingCode, newSessionToken } from "@/lib/access-codes";
import { roundLabeller } from "@/lib/tournament/labels";
import { labelColumns } from "@/lib/tournament/queries";
import { db } from "@/lib/db";
import { judgeScreens, matches, participants, stadiums, tournaments } from "@/lib/db/schema";
import { bumpBoard } from "@/lib/venue";

// Judges. A judge is a tablet tied to one stadium: it asks from /t/<slug>/judge, shows a pairing
// code, and the organizer approves it in the control room. An approved tablet can score the
// match at its stadium and nothing else, without the organizer's sign-in. The organizer can also
// judge a stadium themselves. A stadium has one judge, and its matches can't start without one.

/** Don't write "last seen" on every poll. */
const SEEN_WRITE_MS = 20_000;
const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING = 8;

export { judgeCookie };

export type JudgeAccess =
  | { status: "approved"; judgeId: string; name: string; tournamentId: string; organizerId: string; stadiumId: string; stadium: string; version: number }
  | { status: "pending"; judgeId: string; name: string; code: string; stadiumId: string; stadium: string }
  | { status: "none" };

/** What the tablet holding this cookie may do. Also records that an approved tablet is still open. */
export async function judgeAccess(slug: string, token: string | undefined): Promise<JudgeAccess> {
  if (!token) return { status: "none" };
  const [row] = await db
    .select({
      id: judgeScreens.id,
      status: judgeScreens.status,
      code: judgeScreens.pairingCode,
      name: judgeScreens.name,
      lastSeenAt: judgeScreens.lastSeenAt,
      closedAt: judgeScreens.closedAt,
      createdAt: judgeScreens.createdAt,
      stadiumId: judgeScreens.stadiumId,
      stadium: stadiums.name,
      tournamentId: tournaments.id,
      organizerId: tournaments.organizerId,
      version: tournaments.boardVersion,
    })
    .from(judgeScreens)
    .innerJoin(tournaments, eq(tournaments.id, judgeScreens.tournamentId))
    .innerJoin(stadiums, eq(stadiums.id, judgeScreens.stadiumId))
    .where(and(eq(tournaments.publicSlug, slug), eq(judgeScreens.tokenHash, hashToken(token))))
    .limit(1);
  if (!row) return { status: "none" };

  if (row.status === "pending") {
    if (Date.now() - row.createdAt.getTime() > PENDING_TTL_MS) {
      await db.delete(judgeScreens).where(eq(judgeScreens.id, row.id));
      return { status: "none" };
    }
    return { status: "pending", judgeId: row.id, name: row.name, code: row.code ?? "", stadiumId: row.stadiumId, stadium: row.stadium };
  }
  // A tablet that said it closed is open again at once.
  if (row.closedAt || Date.now() - row.lastSeenAt.getTime() > SEEN_WRITE_MS) {
    await db.update(judgeScreens).set({ lastSeenAt: new Date(), closedAt: null }).where(eq(judgeScreens.id, row.id));
  }
  return {
    status: "approved",
    judgeId: row.id,
    name: row.name,
    tournamentId: row.tournamentId,
    organizerId: row.organizerId,
    stadiumId: row.stadiumId,
    stadium: row.stadium,
    version: row.version,
  };
}

/** What the sign-up screen shows before a tablet is approved: the tournament and its stadiums. */
export async function judgeSignUpInfo(slug: string): Promise<{ tournament: string; stadiums: { id: string; name: string; taken: boolean }[] } | null> {
  const [tournament] = await db
    .select({ id: tournaments.id, name: tournaments.name })
    .from(tournaments)
    .where(eq(tournaments.publicSlug, slug))
    .limit(1);
  if (!tournament) return null;
  const [stadiumRows, judges] = await Promise.all([
    db
      .select({ id: stadiums.id, name: stadiums.name })
      .from(stadiums)
      .where(and(eq(stadiums.tournamentId, tournament.id), eq(stadiums.active, true)))
      .orderBy(asc(stadiums.position)),
    db
      .select({ stadiumId: judgeScreens.stadiumId })
      .from(judgeScreens)
      .where(and(eq(judgeScreens.tournamentId, tournament.id), eq(judgeScreens.status, "approved"))),
  ]);
  const taken = new Set(judges.map((j) => j.stadiumId));
  return { tournament: tournament.name, stadiums: stadiumRows.map((s) => ({ ...s, taken: taken.has(s.id) })) };
}

export type JudgePairing =
  | { status: "approved" }
  /** `token` is set when a new request was created and the tablet needs its cookie. */
  | { status: "pending"; code: string; stadium: string; name: string; token?: string }
  | { status: "not_found" }
  | { status: "busy" };

/**
 * A tablet asks to judge a stadium, under the name the judge typed (the detected device name if
 * they left it alone). Asking again with the same cookie keeps the same code, and can change the
 * stadium or the name.
 */
export async function requestJudgeAccess(
  slug: string,
  token: string | undefined,
  stadiumId: string,
  userAgent: string | null,
  rawName?: string | null,
): Promise<JudgePairing> {
  const [target] = await db
    .select({ tournamentId: tournaments.id, stadium: stadiums.name })
    .from(stadiums)
    .innerJoin(tournaments, eq(tournaments.id, stadiums.tournamentId))
    .where(and(eq(tournaments.publicSlug, slug), eq(stadiums.id, stadiumId), eq(stadiums.active, true)))
    .limit(1);
  if (!target) return { status: "not_found" };

  const device = deviceLabel(userAgent);
  const existing = await judgeAccess(slug, token);
  if (existing.status === "approved") return { status: "approved" };
  if (existing.status === "pending") {
    // Not sending a name keeps the one the request already has.
    const name = rawName == null ? existing.name : judgeName(rawName, device);
    if (existing.stadiumId !== stadiumId || existing.name !== name) {
      await db.transaction(async (tx) => {
        await tx.update(judgeScreens).set({ stadiumId, name }).where(eq(judgeScreens.id, existing.judgeId));
        await bumpBoard(tx, target.tournamentId);
      });
    }
    return { status: "pending", code: existing.code, stadium: target.stadium, name };
  }
  const name = judgeName(rawName, device);

  const fresh = await db.transaction(async (tx) => {
    // One request at a time per tournament, so the cap and the code's uniqueness hold.
    await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, target.tournamentId)).for("update");
    await tx
      .delete(judgeScreens)
      .where(
        and(
          eq(judgeScreens.tournamentId, target.tournamentId),
          eq(judgeScreens.status, "pending"),
          lt(judgeScreens.createdAt, new Date(Date.now() - PENDING_TTL_MS)),
        ),
      );
    const rows = await tx
      .select({ code: judgeScreens.pairingCode, status: judgeScreens.status })
      .from(judgeScreens)
      .where(eq(judgeScreens.tournamentId, target.tournamentId));
    // The sign-up page is public: don't let it fill the organizer's list.
    if (rows.filter((r) => r.status === "pending").length >= MAX_PENDING) return null;

    let code = newPairingCode();
    while (rows.some((r) => r.code === code)) code = newPairingCode();
    const sessionToken = newSessionToken();
    await tx.insert(judgeScreens).values({
      tournamentId: target.tournamentId,
      stadiumId,
      pairingCode: code,
      tokenHash: hashToken(sessionToken),
      device,
      name,
    });
    // Makes the control room show the request straight away.
    await bumpBoard(tx, target.tournamentId);
    return { code, token: sessionToken };
  });
  return fresh ? { status: "pending", stadium: target.stadium, name, ...fresh } : { status: "busy" };
}

/** A judge renames themselves on their tablet, waiting or approved. Returns the name as saved. */
export async function renameJudgeTablet(slug: string, token: string | undefined, rawName: string): Promise<string | null> {
  const access = await judgeAccess(slug, token);
  if (access.status === "none") return null;
  const [row] = await db
    .select({ device: judgeScreens.device, tournamentId: judgeScreens.tournamentId })
    .from(judgeScreens)
    .where(eq(judgeScreens.id, access.judgeId))
    .limit(1);
  if (!row) return null;
  const name = judgeName(rawName, row.device);
  await db.update(judgeScreens).set({ name }).where(eq(judgeScreens.id, access.judgeId));
  await bumpBoard(db, row.tournamentId);
  return name;
}

/** The organizer renames a stadium's judge tablet from the control room. */
export async function renameJudge(organizerId: string, judgeId: string, rawName: string): Promise<{ error?: string }> {
  const [row] = await db
    .select({ device: judgeScreens.device, byOrganizer: judgeScreens.byOrganizer, tournamentId: judgeScreens.tournamentId })
    .from(judgeScreens)
    .innerJoin(tournaments, eq(tournaments.id, judgeScreens.tournamentId))
    .where(and(eq(judgeScreens.id, judgeId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  if (!row) return { error: "That judge is no longer here." };
  if (row.byOrganizer) return { error: "You are judging this stadium yourself." };
  await db.update(judgeScreens).set({ name: judgeName(rawName, row.device) }).where(eq(judgeScreens.id, judgeId));
  await bumpBoard(db, row.tournamentId);
  return {};
}

async function ownedJudge(organizerId: string, judgeId: string) {
  const [row] = await db
    .select({ id: judgeScreens.id, status: judgeScreens.status, tournamentId: judgeScreens.tournamentId, stadiumId: judgeScreens.stadiumId, stadium: stadiums.name })
    .from(judgeScreens)
    .innerJoin(tournaments, eq(tournaments.id, judgeScreens.tournamentId))
    .innerJoin(stadiums, eq(stadiums.id, judgeScreens.stadiumId))
    .where(and(eq(judgeScreens.id, judgeId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  return row ?? null;
}

/** How many judges a stadium has besides `exceptId`: at most one, which is what blocks a second. */
async function otherJudges(tx: Pick<typeof db, "select">, stadiumId: string, exceptId: string | null) {
  const [{ total }] = await tx
    .select({ total: count() })
    .from(judgeScreens)
    .where(and(eq(judgeScreens.stadiumId, stadiumId), eq(judgeScreens.status, "approved"), exceptId ? ne(judgeScreens.id, exceptId) : undefined));
  return total;
}

/** Lets a waiting tablet judge its stadium, unless that stadium already has a judge. */
export async function approveJudge(organizerId: string, judgeId: string): Promise<{ error?: string }> {
  const judge = await ownedJudge(organizerId, judgeId);
  if (!judge) return { error: "That device is no longer waiting. It may have been closed." };
  if (judge.status === "approved") return {};

  return db.transaction(async (tx) => {
    await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, judge.tournamentId)).for("update");
    if (await otherJudges(tx, judge.stadiumId, judge.id)) {
      return { error: `${judge.stadium} already has a judge. Disconnect that one first.` };
    }
    const now = new Date();
    const updated = await tx
      .update(judgeScreens)
      .set({ status: "approved", approvedAt: now, lastSeenAt: now })
      .where(and(eq(judgeScreens.id, judgeId), eq(judgeScreens.status, "pending")))
      .returning({ id: judgeScreens.id });
    if (updated.length === 0) return { error: "That device is no longer waiting. It may have been closed." };
    await bumpBoard(tx, judge.tournamentId);
    return {};
  });
}

/**
 * Declines a waiting tablet, disconnects a stadium's judge, or ends the organizer's own judging.
 * A match already being played carries on; the next one can't start until there is a judge again.
 */
export async function removeJudge(organizerId: string, judgeId: string): Promise<boolean> {
  const judge = await ownedJudge(organizerId, judgeId);
  if (!judge) return false;
  await db.delete(judgeScreens).where(eq(judgeScreens.id, judgeId));
  await bumpBoard(db, judge.tournamentId);
  return true;
}

/**
 * A judge leaves their stadium from their own device (or withdraws a request still waiting).
 * Only the judge goes: the match at the stadium keeps its battles and its status, so the next
 * judge, or the organizer, carries on from the same score. Returns the stadium they left.
 */
export async function leaveStadium(slug: string, token: string | undefined): Promise<{ stadium: string } | null> {
  const access = await judgeAccess(slug, token);
  if (access.status === "none") return null;
  const [gone] = await db.delete(judgeScreens).where(eq(judgeScreens.id, access.judgeId)).returning({ tournamentId: judgeScreens.tournamentId });
  if (!gone) return null;
  // The control room's stadium card goes back to "Awaiting judge..." at once.
  await bumpBoard(db, gone.tournamentId);
  return { stadium: access.stadium };
}

/**
 * The tablet holding this cookie says its tab is closing: the control room shows it closed at
 * once. It stays the stadium's judge, and is open again when it checks in.
 */
export async function closeJudgeScreen(slug: string, token: string | undefined) {
  if (!token) return;
  const [tournament] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.publicSlug, slug)).limit(1);
  if (!tournament) return;
  const now = new Date();
  await db
    .update(judgeScreens)
    .set({ closedAt: now, lastSeenAt: now })
    .where(and(eq(judgeScreens.tournamentId, tournament.id), eq(judgeScreens.tokenHash, hashToken(token)), eq(judgeScreens.status, "approved")));
}

/** "Judge here myself": the organizer becomes the stadium's judge, with no tablet to approve. */
export async function judgeMyself(organizerId: string, stadiumId: string): Promise<{ error?: string }> {
  const [stadium] = await db
    .select({ id: stadiums.id, name: stadiums.name, tournamentId: stadiums.tournamentId })
    .from(stadiums)
    .innerJoin(tournaments, eq(tournaments.id, stadiums.tournamentId))
    .where(and(eq(stadiums.id, stadiumId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  if (!stadium) return { error: "Stadium not found." };

  return db.transaction(async (tx) => {
    await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, stadium.tournamentId)).for("update");
    if (await otherJudges(tx, stadiumId, null)) return { error: `${stadium.name} already has a judge. Disconnect that one first.` };
    const now = new Date();
    await tx.insert(judgeScreens).values({
      tournamentId: stadium.tournamentId,
      stadiumId,
      status: "approved",
      byOrganizer: true,
      device: "You",
      name: "You",
      approvedAt: now,
    });
    await bumpBoard(tx, stadium.tournamentId);
    return {};
  });
}

// ---------------------------------------------------------------------------------------------
// What a judge tablet shows between matches
// ---------------------------------------------------------------------------------------------

export type JudgeMatch = { id: string; label: string; players: string; status: "called" | "playing" };

export type JudgeSnapshot = {
  version: number;
  tournament: string;
  stadium: string;
  /** What this judge is called in the control room. */
  judge: string;
  /** The match at this stadium that the judge starts and scores. */
  now: JudgeMatch | null;
  /** Who plays here next, so the judge can see them coming. */
  next: { label: string; players: string } | null;
};

/** The judge's own stadium: its current match and who is on deck. Nothing about other stadiums. */
export async function judgeSnapshot(access: Extract<JudgeAccess, { status: "approved" }>): Promise<JudgeSnapshot | null> {
  const [[tournament], here, rounds] = await Promise.all([
    db.select().from(tournaments).where(eq(tournaments.id, access.tournamentId)).limit(1),
    db.select().from(matches).where(eq(matches.stadiumId, access.stadiumId)),
    db.select(labelColumns).from(matches).where(eq(matches.tournamentId, access.tournamentId)),
  ]);
  if (!tournament) return null;

  const current = here.find((m) => m.callStatus === "called" || m.callStatus === "playing");
  const onDeck = here.find((m) => m.callStatus === "on_deck");
  const ids = [current, onDeck].flatMap((m) => (m ? [m.player1Id, m.player2Id] : [])).filter((id): id is string => Boolean(id));
  const people = ids.length
    ? await db
        .select({ id: participants.id, name: participants.name })
        .from(participants)
        .where(and(eq(participants.tournamentId, tournament.id), inArray(participants.id, ids)))
    : [];
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? "TBD";
  const labelOf = roundLabeller(tournament, rounds);
  const describe = (m: (typeof here)[number]) => ({
    label: `${labelOf(m)} · Match ${m.identifier}`,
    players: `${nameOf(m.player1Id)} vs ${nameOf(m.player2Id)}`,
  });

  return {
    version: tournament.boardVersion,
    tournament: tournament.name,
    stadium: access.stadium,
    judge: access.name,
    now: current ? { id: current.id, ...describe(current), status: current.callStatus === "playing" ? "playing" : "called" } : null,
    next: onDeck ? describe(onDeck) : null,
  };
}
