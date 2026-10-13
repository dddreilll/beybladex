import "server-only";
import { and, eq, notInArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { matches, participants, tournaments } from "@/lib/db/schema";
import { reconcileQueue } from "@/lib/venue";
import { challongeClientFor } from "./connection";
import { readReview, signReview, type ReviewedTournament } from "./import-review";
import { mapMatch, mapParticipant, mapTournament, previewTournament } from "./map";
import { formatSupport, isSwiss, UnsupportedFormatError, type TournamentFormat, type TournamentPreview } from "./support";
import type { MatchResource, ParticipantResource, SingleResponse, TournamentResource } from "./types";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Client = Awaited<ReturnType<typeof challongeClientFor>>["client"];

const excluded = (column: PgColumn): SQL => sql.raw(`excluded.${column.name}`);

export const tournamentPath = (challongeId: string) => `/tournaments/${encodeURIComponent(challongeId)}`;

async function fetchTournament(client: Client, challongeId: string) {
  const res = await client.get<SingleResponse<TournamentResource>>(`${tournamentPath(challongeId)}.json`);
  if (res.notModified) throw new Error("Unexpected 304 for an unconditional request.");
  return res.body.data;
}

function assertSupported(format: TournamentFormat) {
  const support = formatSupport(format);
  if (!support.supported) throw new UnsupportedFormatError(support.reason);
}

// A player's passcode and QR secret are set when the row is first created and survive every re-import.
export async function replaceParticipants(tx: Tx, tournamentId: string, rows: ParticipantResource[]) {
  const mapped = rows.map(mapParticipant);
  if (mapped.length) {
    await tx
      .insert(participants)
      .values(mapped.map((p) => ({ ...p, tournamentId })))
      .onConflictDoUpdate({
        target: [participants.tournamentId, participants.challongeId],
        set: {
          name: excluded(participants.name),
          seed: excluded(participants.seed),
          active: excluded(participants.active),
          finalRank: excluded(participants.finalRank),
          updatedAt: sql`now()`,
        },
      });
  }
  await tx.delete(participants).where(
    and(
      eq(participants.tournamentId, tournamentId),
      mapped.length ? notInArray(participants.challongeId, mapped.map((p) => p.challongeId)) : undefined,
    ),
  );
}

// Matches that disappeared (e.g. after a bracket reset on challonge.com) are removed locally.
export async function replaceMatches(tx: Tx, tournamentId: string, rows: MatchResource[]) {
  const mapped = rows.map(mapMatch);
  if (mapped.length) {
    await tx
      .insert(matches)
      .values(mapped.map((m) => ({ ...m, tournamentId })))
      .onConflictDoUpdate({
        target: [matches.tournamentId, matches.challongeId],
        set: {
          identifier: excluded(matches.identifier),
          round: excluded(matches.round),
          suggestedPlayOrder: excluded(matches.suggestedPlayOrder),
          state: excluded(matches.state),
          player1ChallongeId: excluded(matches.player1ChallongeId),
          player2ChallongeId: excluded(matches.player2ChallongeId),
          winnerChallongeId: excluded(matches.winnerChallongeId),
          scores: excluded(matches.scores),
          scoreInSets: excluded(matches.scoreInSets),
          underwayAt: excluded(matches.underwayAt),
          updatedAt: sql`now()`,
        },
      });
  }
  await tx.delete(matches).where(
    and(
      eq(matches.tournamentId, tournamentId),
      mapped.length ? notInArray(matches.challongeId, mapped.map((m) => m.challongeId)) : undefined,
    ),
  );
}

/** Reads the participants and matches of a tournament already read (2 requests) and stores all three. */
async function storeImport(organizerId: string, client: Client, tournament: ReviewedTournament): Promise<string> {
  const path = tournamentPath(tournament.challongeId);
  const participantList = await client.listAll<ParticipantResource>(`${path}/participants.json`);
  const matchList = await client.listAll<MatchResource>(`${path}/matches.json`);
  if (participantList.notModified || matchList.notModified) throw new Error("Unexpected 304 during import.");

  return db.transaction(async (tx) => {
    const values = { ...tournament, matchesEtag: matchList.etag, lastSyncedAt: new Date() };
    const [row] = await tx
      .insert(tournaments)
      .values({ organizerId, ...values })
      .onConflictDoUpdate({ target: [tournaments.organizerId, tournaments.challongeId], set: values })
      .returning({ id: tournaments.id });
    await replaceParticipants(tx, row.id, participantList.data);
    await replaceMatches(tx, row.id, matchList.data);
    await reconcileQueue(row.id, tx);
    return row.id;
  });
}

/**
 * Imports (or re-imports) a tournament: 3 requests for brackets up to 500 matches. A format the
 * app can't run is refused after the first request, before anything is stored.
 */
export async function importTournament(organizerId: string, challongeIdOrSlug: string): Promise<string> {
  const { client } = await challongeClientFor(organizerId);
  const tournament = mapTournament(await fetchTournament(client, challongeIdOrSlug));
  assertSupported(tournament);
  return storeImport(organizerId, client, tournament);
}

/**
 * The first step of an import by link or ID (1 request): reads the tournament for the organizer to
 * review, and refuses a format the app can't run. The token carries what was read, signed, so
 * `importReviewed` doesn't read it again.
 */
export async function reviewTournament(
  organizerId: string,
  challongeIdOrSlug: string,
): Promise<{ preview: TournamentPreview; token: string }> {
  const { client } = await challongeClientFor(organizerId);
  const tournament = await fetchTournament(client, challongeIdOrSlug);
  const mapped = mapTournament(tournament);
  assertSupported(mapped);
  return { preview: previewTournament(tournament), token: signReview(organizerId, mapped) };
}

/** The second step (2 requests): imports the tournament the organizer reviewed and confirmed. */
export async function importReviewed(organizerId: string, token: string): Promise<string> {
  const tournament = readReview(organizerId, token);
  assertSupported(tournament);
  const { client } = await challongeClientFor(organizerId);
  return storeImport(organizerId, client, tournament);
}

/**
 * Cheap refresh: 2 requests when nothing changed (tournament + a conditional matches request
 * that returns 304). Participants are re-fetched only if their count changed, except in Swiss,
 * where they always are (3 requests): a player who drops out stays in the count (spike S8). If the
 * tournament now has a format the app can't run, it stops after the first request and throws.
 */
export async function resyncTournament(organizerId: string, tournamentId: string) {
  const [local] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.id, tournamentId), eq(tournaments.organizerId, organizerId)))
    .limit(1);
  if (!local) throw new Error("Tournament not found.");

  const { client } = await challongeClientFor(organizerId, { communityId: local.communityId });
  const mapped = mapTournament(await fetchTournament(client, local.challongeId));
  const support = formatSupport(mapped);
  if (!support.supported) {
    // The bracket stored here stays as it was. Only the format is recorded, so the Desk can say why.
    await db
      .update(tournaments)
      .set({ tournamentType: mapped.tournamentType, groupStage: mapped.groupStage })
      .where(eq(tournaments.id, local.id));
    throw new UnsupportedFormatError(support.reason);
  }
  const path = tournamentPath(local.challongeId);
  const matchList = await client.listAll<MatchResource>(`${path}/matches.json`, { etag: local.matchesEtag });
  const participantList =
    mapped.participantsCount !== local.participantsCount || isSwiss(mapped.tournamentType)
      ? await client.listAll<ParticipantResource>(`${path}/participants.json`)
      : null;

  await db.transaction(async (tx) => {
    await tx
      .update(tournaments)
      .set({ ...mapped, matchesEtag: matchList.etag ?? local.matchesEtag, lastSyncedAt: new Date() })
      .where(eq(tournaments.id, local.id));
    if (participantList && !participantList.notModified) await replaceParticipants(tx, local.id, participantList.data);
    if (!matchList.notModified) await replaceMatches(tx, local.id, matchList.data);
    await reconcileQueue(local.id, tx);
  });
  return { matchesChanged: !matchList.notModified, participantsRefetched: Boolean(participantList) };
}
