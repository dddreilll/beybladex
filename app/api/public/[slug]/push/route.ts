import { NextResponse, type NextRequest } from "next/server";
import { playerAccess, playerCookie } from "@/lib/access";
import { crossSite } from "@/lib/api-auth";
import { SLUG_PATTERN } from "@/lib/board";
import { pushConfig, removePushSubscription, savePushSubscription } from "@/lib/push";
import { subscribeSchema, unsubscribeSchema } from "@/lib/push-endpoint";

type Context = { params: Promise<{ slug: string }> };

const json = (body: object, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The player signed in on this device, or the response to return instead. */
async function signedInPlayer(request: NextRequest, slug: string) {
  const refused = crossSite(request);
  if (refused) return { response: refused };
  const access = await playerAccess(slug, request.cookies.get(playerCookie(slug))?.value);
  if (access.status !== "signed_in") return { response: json({ error: "Sign in again to change notifications." }, 401) };
  return { playerId: access.playerId };
}

/** Subscribe this browser to the signed-in player's calls. */
export async function POST(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  if (!pushConfig()) return json({ error: "Notifications aren't set up on this server." }, 503);
  const player = await signedInPlayer(request, slug);
  if ("response" in player) return player.response;

  const parsed = subscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid subscription." }, 400);

  const result = await savePushSubscription(slug, { playerId: player.playerId, subscription: parsed.data.subscription });
  if (result === "not_found") return json({ error: "Not found" }, 404);
  if (result === "limit") return json({ error: "Too many subscriptions for this tournament." }, 429);
  return json({ ok: true }, 201);
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  const player = await signedInPlayer(request, slug);
  if ("response" in player) return player.response;

  const parsed = unsubscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request." }, 400);
  await removePushSubscription(slug, parsed.data.endpoint);
  return json({ ok: true }, 200);
}
