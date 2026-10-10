import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { challongeConnections, type ChallongeConnection } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { challongeRedirectUri } from "@/lib/config";
import { ChallongeClient } from "./client";
import { exchangeCode, refreshAccessToken, tokenExpiry, TokenRequestError } from "./oauth";
import { recordUsage } from "./budget";
import type { ChallongeUser, SingleResponse, TokenResponse } from "./types";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class NotConnectedError extends Error {
  name = "NotConnectedError";
  constructor() {
    super("Connect your Challonge account first.");
  }
}

export class ReconnectRequiredError extends Error {
  name = "ReconnectRequiredError";
  constructor() {
    super("Challonge access expired or was revoked. Reconnect your Challonge account.");
  }
}

// Each secret is bound to its owner and field, so an envelope can't be replayed into another row or column.
const aad = (organizerId: string, field: "client_secret" | "access_token" | "refresh_token") =>
  `${organizerId}:${field}`;

export async function getConnection(organizerId: string): Promise<ChallongeConnection | null> {
  const [row] = await db
    .select()
    .from(challongeConnections)
    .where(eq(challongeConnections.organizerId, organizerId))
    .limit(1);
  return row ?? null;
}

/** Saving new app credentials invalidates any tokens issued to the previous app. */
export async function saveCredentials(organizerId: string, clientId: string, clientSecret: string) {
  const values = {
    clientId,
    clientSecretEnc: encryptSecret(clientSecret, aad(organizerId, "client_secret")),
    accessTokenEnc: null,
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    scopes: null,
    challongeUserId: null,
    challongeUsername: null,
    status: "credentials_saved" as const,
    lastError: null,
  };
  await db
    .insert(challongeConnections)
    .values({ organizerId, ...values })
    .onConflictDoUpdate({ target: challongeConnections.organizerId, set: values });
}

export async function removeConnection(organizerId: string) {
  await db.delete(challongeConnections).where(eq(challongeConnections.organizerId, organizerId));
}

function tokenColumns(organizerId: string, token: TokenResponse, previousRefreshTokenEnc: string | null) {
  return {
    accessTokenEnc: encryptSecret(token.access_token, aad(organizerId, "access_token")),
    refreshTokenEnc: token.refresh_token
      ? encryptSecret(token.refresh_token, aad(organizerId, "refresh_token"))
      : previousRefreshTokenEnc,
    tokenExpiresAt: tokenExpiry(token),
    scopes: token.scope ?? null,
    status: "connected" as const,
    lastError: null,
  };
}

export async function completeAuthorization(organizerId: string, code: string) {
  const connection = await getConnection(organizerId);
  if (!connection) throw new NotConnectedError();
  const meter = () => recordUsage(connection.id);

  const token = await exchangeCode(
    {
      clientId: connection.clientId,
      clientSecret: decryptSecret(connection.clientSecretEnc, aad(organizerId, "client_secret")),
      code,
      redirectUri: challongeRedirectUri(),
    },
    { onRequest: meter },
  );
  const me = await new ChallongeClient({ accessToken: token.access_token, onRequest: meter }).get<
    SingleResponse<ChallongeUser>
  >("/me.json");

  await db
    .update(challongeConnections)
    .set({
      ...tokenColumns(organizerId, token, null),
      challongeUserId: me.notModified ? null : me.body.data.id,
      challongeUsername: me.notModified ? null : me.body.data.attributes.username,
    })
    .where(eq(challongeConnections.id, connection.id));
}

const needsRefresh = (c: ChallongeConnection) =>
  !c.tokenExpiresAt || c.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;

/**
 * Challonge rotates the refresh token on every refresh, so two concurrent refreshes would
 * lock the organizer out. The row lock makes the second caller reuse the first one's token.
 */
async function refreshUnderLock(connectionId: string): Promise<ChallongeConnection> {
  // Usage is recorded after the transaction: writing it on another pooled connection while
  // holding the row lock could exhaust the pool when many requests refresh at once.
  let tokenRequests = 0;
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(challongeConnections)
      .where(eq(challongeConnections.id, connectionId))
      .for("update");
    if (!row?.refreshTokenEnc) return { reconnect: true as const, error: "No refresh token stored." };
    if (!needsRefresh(row)) return { row };

    try {
      const token = await refreshAccessToken(
        {
          clientId: row.clientId,
          clientSecret: decryptSecret(row.clientSecretEnc, aad(row.organizerId, "client_secret")),
          refreshToken: decryptSecret(row.refreshTokenEnc, aad(row.organizerId, "refresh_token")),
        },
        { onRequest: () => void tokenRequests++ },
      );
      const [updated] = await tx
        .update(challongeConnections)
        .set(tokenColumns(row.organizerId, token, row.refreshTokenEnc))
        .where(eq(challongeConnections.id, row.id))
        .returning();
      return { row: updated };
    } catch (error) {
      if (error instanceof TokenRequestError && error.needsReauthorization) {
        return { reconnect: true as const, error: error.message };
      }
      throw error;
    }
  });

  if (tokenRequests) await recordUsage(connectionId, tokenRequests);
  if ("reconnect" in outcome) {
    await markReconnectRequired(connectionId, outcome.error ?? "Token refresh failed.");
    throw new ReconnectRequiredError();
  }
  return outcome.row;
}

async function markReconnectRequired(connectionId: string, error: string) {
  await db
    .update(challongeConnections)
    .set({ status: "reconnect_required", lastError: error })
    .where(eq(challongeConnections.id, connectionId));
}

/** An API client for the organizer's own Challonge app, with tokens refreshed and every request metered. */
export async function challongeClientFor(organizerId: string, options: { communityId?: string | null } = {}) {
  let connection = await getConnection(organizerId);
  if (!connection?.accessTokenEnc) throw new NotConnectedError();
  if (connection.status === "reconnect_required") throw new ReconnectRequiredError();
  if (needsRefresh(connection)) connection = await refreshUnderLock(connection.id);

  const connectionId = connection.id;
  const client = new ChallongeClient({
    accessToken: decryptSecret(connection.accessTokenEnc!, aad(organizerId, "access_token")),
    communityId: options.communityId,
    onRequest: async ({ status }) => {
      await recordUsage(connectionId);
      if (status === 401) await markReconnectRequired(connectionId, "Challonge rejected the access token (401).");
    },
  });
  return { client, connection };
}
