import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { networkKey, playerCookie, sessionCookie, signInPlayer, signOutPlayer } from "@/lib/access";
import { DEVICE_COOKIE, DEVICE_ID_PATTERN, newDeviceId, PASSCODE_PATTERN, SIGN_IN_TOKEN_PATTERN } from "@/lib/access-codes";
import { crossSite, isSecureRequest } from "@/lib/api-auth";
import { SLUG_PATTERN } from "@/lib/board";

type Context = { params: Promise<{ slug: string }> };

const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

const signInSchema = z.union([
  z.object({ playerId: z.string().regex(/^\d{1,20}$/), code: z.string().regex(PASSCODE_PATTERN) }),
  z.object({ token: z.string().regex(SIGN_IN_TOKEN_PATTERN) }),
]);

const wait = (seconds: number) => (seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`);

/** Signs a player in on this device with their passcode, or with the secret from their QR code. */
export async function POST(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  const refused = crossSite(request);
  if (refused) return refused;

  const parsed = signInSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Enter the 4-digit passcode from your slip." }, 400);

  // Wrong passcodes are counted per device, so this browser gets a name of its own the first time.
  const known = request.cookies.get(DEVICE_COOKIE)?.value;
  const device = known && DEVICE_ID_PATTERN.test(known) ? known : newDeviceId();
  const answer = (body: object, status = 200) => {
    const response = json(body, status);
    if (device !== known) response.cookies.set(DEVICE_COOKIE, device, sessionCookie(isSecureRequest(request)));
    return response;
  };

  const result = await signInPlayer(slug, parsed.data, {
    currentToken: request.cookies.get(playerCookie(slug))?.value,
    userAgent: request.headers.get("user-agent"),
    network: networkKey(request.headers),
    device,
  });
  if (result.status === "not_found") return json({ error: "Not found" }, 404);
  if (result.status === "throttled") {
    return answer(
      {
        error: `Too many wrong passcodes. Scan the QR code on your passcode slip, or ask the organizer for a new passcode. You can also try again in ${wait(result.retryInSeconds)}.`,
      },
      429,
    );
  }
  if (result.status === "wrong") {
    return answer(
      { error: "token" in parsed.data ? "This QR code no longer works. Ask the organizer for a new slip." : "That passcode doesn't match. Check your slip and try again." },
      401,
    );
  }

  const response = answer({ ok: true });
  if (result.token) response.cookies.set(playerCookie(slug), result.token, sessionCookie(isSecureRequest(request)));
  return response;
}

/** "Not you?": signs this device out. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const { slug } = await params;
  if (!SLUG_PATTERN.test(slug)) return json({ error: "Not found" }, 404);
  const refused = crossSite(request);
  if (refused) return refused;

  await signOutPlayer(slug, request.cookies.get(playerCookie(slug))?.value);
  const response = json({ ok: true });
  response.cookies.delete(playerCookie(slug));
  return response;
}
