import "server-only";
import { eq } from "drizzle-orm";
import { SHORT_CODE_PATTERN } from "@/lib/access-codes";
import { appUrl } from "@/lib/config";
import { db } from "@/lib/db";
import { tournaments } from "@/lib/db/schema";

// Short links an organizer can read out or type on a TV: /b/<code> for the call board and
// /j/<code> for judges. They only lead to screens that still need the organizer's approval.

/** The tournament behind a short code, typed in any case; null if there is none. */
export async function slugForShortCode(raw: string): Promise<string | null> {
  const code = raw.trim().toUpperCase();
  if (!SHORT_CODE_PATTERN.test(code)) return null;
  const [row] = await db.select({ slug: tournaments.publicSlug }).from(tournaments).where(eq(tournaments.shortCode, code)).limit(1);
  return row?.slug ?? null;
}

export const boardShortLink = (code: string) => `${appUrl()}/b/${code}`;
export const judgeShortLink = (code: string) => `${appUrl()}/j/${code}`;
