"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrganizer } from "@/lib/auth";
import { getConnection, removeConnection, saveCredentials } from "@/lib/challonge/connection";
import { authorizeUrl } from "@/lib/challonge/oauth";
import { challongeRedirectUri, OAUTH_NONCE_COOKIE, OAUTH_STATE_TTL_MS } from "@/lib/config";
import { signPayload } from "@/lib/crypto/secrets";

export type CredentialsState = { error?: string; saved?: boolean };

const credentialsSchema = z.object({
  clientId: z.string().trim().min(8, "That client ID looks too short.").max(200),
  clientSecret: z.string().trim().min(8, "That client secret looks too short.").max(500),
});

export async function saveCredentialsAction(_prev: CredentialsState, formData: FormData): Promise<CredentialsState> {
  const organizer = await requireOrganizer();
  const parsed = credentialsSchema.safeParse({
    clientId: formData.get("clientId"),
    clientSecret: formData.get("clientSecret"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };

  await saveCredentials(organizer.id, parsed.data.clientId, parsed.data.clientSecret);
  revalidatePath("/settings/challonge");
  return { saved: true };
}

/** Starts the authorization-code flow against the organizer's own Challonge app. */
export async function connectChallongeAction() {
  const organizer = await requireOrganizer();
  const connection = await getConnection(organizer.id);
  if (!connection) redirect("/settings/challonge?error=no_credentials");

  // The nonce lives in an httpOnly cookie and inside the signed state, so a callback
  // only succeeds in the browser that started the flow, for the organizer who started it.
  const nonce = randomBytes(16).toString("base64url");
  const state = signPayload({ o: organizer.id, n: nonce, exp: Date.now() + OAUTH_STATE_TTL_MS });
  (await cookies()).set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/challonge/oauth",
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  });

  redirect(authorizeUrl({ clientId: connection.clientId, redirectUri: challongeRedirectUri(), state }));
}

export async function removeConnectionAction() {
  const organizer = await requireOrganizer();
  await removeConnection(organizer.id);
  revalidatePath("/settings/challonge");
  redirect("/settings/challonge");
}
