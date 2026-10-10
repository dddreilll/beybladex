import { NextResponse, type NextRequest } from "next/server";
import { SLUG_PATTERN } from "@/lib/board";
import { pushConfig, removePushSubscription, savePushSubscription } from "@/lib/push";
import { subscribeSchema, unsubscribeSchema } from "@/lib/push-endpoint";

type Context = { params: Promise<{ slug: string }> };

const json = (body: object, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Subscribe this browser to a player's calls. Public: anyone with the tournament link can opt in. */
export async function POST(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  if (!pushConfig()) return json({ error: "Notifications aren't set up on this server." }, 503);

  const parsed = subscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid subscription." }, 400);

  const result = await savePushSubscription(slug, parsed.data);
  if (result === "not_found") return json({ error: "Not found" }, 404);
  if (result === "limit") return json({ error: "Too many subscriptions for this tournament." }, 429);
  return json({ ok: true }, 201);
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  const parsed = unsubscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request." }, 400);
  await removePushSubscription(slug, parsed.data.endpoint);
  return json({ ok: true }, 200);
}
