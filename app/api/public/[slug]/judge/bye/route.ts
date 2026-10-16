import { NextResponse, type NextRequest } from "next/server";
import { crossSite } from "@/lib/api-auth";
import { SLUG_PATTERN } from "@/lib/board";
import { closeJudgeScreen, judgeCookie } from "@/lib/judges";

// Sent by a judge tablet as its tab closes (navigator.sendBeacon), so the control room shows it
// closed at once. Not a pad action: nothing is lost if it never arrives, so it isn't queued
// offline. It answers the same whatever happened.
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const refused = crossSite(request);
  if (refused) return refused;
  const { slug } = await params;
  if (SLUG_PATTERN.test(slug)) await closeJudgeScreen(slug, request.cookies.get(judgeCookie(slug))?.value);
  return new NextResponse(null, { status: 204 });
}
