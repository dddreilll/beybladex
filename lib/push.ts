import "server-only";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import webpush from "web-push";
import { roundContext, roundLabel } from "@/lib/challonge/map";
import { db } from "@/lib/db";
import { matches, participants, pushSubscriptions, stadiums, tournaments } from "@/lib/db/schema";
import { callPayload, type PushPayload } from "@/lib/push-endpoint";

const MAX_SUBSCRIPTIONS_PER_TOURNAMENT = 2000;
const MAX_FAILURES = 5;

export function pushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com" };
}

type StoredSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushSender = (subscription: StoredSubscription, payload: PushPayload, ttlSeconds: number) => Promise<number>;

/** Sends one notification and returns the push service's HTTP status. */
const webPushSender: PushSender = async (subscription, payload, ttlSeconds) => {
  const config = pushConfig()!;
  try {
    const res = await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: ttlSeconds,
      urgency: "high",
      vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
    });
    return res.statusCode;
  } catch (error) {
    if (error instanceof webpush.WebPushError) return error.statusCode;
    throw error;
  }
};

export type SaveResult = "ok" | "not_found" | "limit";

/** Binds this browser's subscription to a player; re-subscribing as someone else moves it. */
export async function savePushSubscription(
  slug: string,
  input: { playerId: string; subscription: StoredSubscription },
): Promise<SaveResult> {
  const [tournament] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.publicSlug, slug)).limit(1);
  if (!tournament) return "not_found";
  const [player] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.tournamentId, tournament.id), eq(participants.challongeId, input.playerId)))
    .limit(1);
  if (!player) return "not_found";

  const [{ total }] = await db
    .select({ total: count() })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.tournamentId, tournament.id));
  if (total >= MAX_SUBSCRIPTIONS_PER_TOURNAMENT) return "limit";

  const values = {
    tournamentId: tournament.id,
    participantChallongeId: input.playerId,
    p256dh: input.subscription.keys.p256dh,
    auth: input.subscription.keys.auth,
    failureCount: 0,
  };
  await db
    .insert(pushSubscriptions)
    .values({ endpoint: input.subscription.endpoint, ...values })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
  return "ok";
}

export async function removePushSubscription(slug: string, endpoint: string) {
  const [tournament] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.publicSlug, slug)).limit(1);
  if (!tournament) return;
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.tournamentId, tournament.id), eq(pushSubscriptions.endpoint, endpoint)));
}

/**
 * Pushes "on deck" / "you're up" to the players of matches whose call status changed.
 * The UPDATE … RETURNING claims each change atomically, so concurrent callers never double-send
 * and a retry after a crash can't repeat a notification.
 */
export async function dispatchNotifications(tournamentId: string, sender: PushSender = webPushSender) {
  if (sender === webPushSender && !pushConfig()) return { sent: 0, removed: 0 };

  const claimed = await db
    .update(matches)
    .set({ notifiedStatus: sql`${matches.callStatus}` })
    .where(
      and(
        eq(matches.tournamentId, tournamentId),
        inArray(matches.callStatus, ["called", "on_deck"]),
        sql`${matches.notifiedStatus} is distinct from ${matches.callStatus}`,
      ),
    )
    .returning();
  return deliver(tournamentId, claimed, sender);
}

/**
 * Pushes a repeat call ("Second call: Stadium 2") to a called match's players. Not claimed like
 * first calls: the organizer asked for it explicitly, and the caller enforces the cooldown.
 */
export async function dispatchRecall(matchId: string, sender: PushSender = webPushSender) {
  if (sender === webPushSender && !pushConfig()) return { sent: 0, removed: 0 };
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!match || match.callStatus !== "called") return { sent: 0, removed: 0 };
  return deliver(match.tournamentId, [match], sender);
}

async function deliver(tournamentId: string, claimed: (typeof matches.$inferSelect)[], sender: PushSender) {
  if (claimed.length === 0) return { sent: 0, removed: 0 };

  const playerIds = claimed.flatMap((m) => [m.player1ChallongeId, m.player2ChallongeId]).filter((p): p is string => Boolean(p));
  const [subscriptions, [tournament], stadiumRows, names, rounds] = await Promise.all([
    db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.tournamentId, tournamentId), inArray(pushSubscriptions.participantChallongeId, playerIds))),
    db.select().from(tournaments).where(eq(tournaments.id, tournamentId)),
    db.select().from(stadiums).where(eq(stadiums.tournamentId, tournamentId)),
    db.select({ id: participants.challongeId, name: participants.name }).from(participants).where(eq(participants.tournamentId, tournamentId)),
    db.select({ round: matches.round }).from(matches).where(eq(matches.tournamentId, tournamentId)),
  ]);
  if (subscriptions.length === 0) return { sent: 0, removed: 0 };

  const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? "TBD";
  const ctx = roundContext(tournament.tournamentType, rounds.map((r) => r.round));

  const jobs = claimed.flatMap((m) => {
    const stadium = stadiumRows.find((s) => s.id === m.stadiumId)?.name ?? "your stadium";
    const status = m.callStatus as "called" | "on_deck";
    return subscriptions
      .filter((s) => s.participantChallongeId === m.player1ChallongeId || s.participantChallongeId === m.player2ChallongeId)
      .map((s) => ({
        subscription: s,
        // A call that arrives late is worse than none: let the push service drop it.
        ttl: status === "called" ? 180 : 600,
        payload: callPayload({
          status,
          stadium,
          opponent: nameOf(s.participantChallongeId === m.player1ChallongeId ? m.player2ChallongeId : m.player1ChallongeId),
          label: `${roundLabel(m.round, ctx, m.identifier)} · ${m.identifier}`,
          slug: tournament.publicSlug,
          matchId: m.id,
          callNumber: m.callCount,
        }),
      }));
  });

  let sent = 0;
  let removed = 0;
  await Promise.all(
    jobs.map(async ({ subscription, payload, ttl }) => {
      let status: number;
      try {
        status = await sender({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, ttl);
      } catch {
        status = 0;
      }
      if (status >= 200 && status < 300) {
        sent++;
        await db.update(pushSubscriptions).set({ failureCount: 0, lastSuccessAt: new Date() }).where(eq(pushSubscriptions.id, subscription.id));
      } else if (status === 404 || status === 410 || subscription.failureCount + 1 >= MAX_FAILURES) {
        // Gone: the browser unsubscribed or the subscription expired.
        removed++;
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
      } else {
        await db
          .update(pushSubscriptions)
          .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
          .where(eq(pushSubscriptions.id, subscription.id));
      }
    }),
  );
  return { sent, removed };
}
