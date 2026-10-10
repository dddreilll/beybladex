import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiUsage } from "@/lib/db/schema";

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export async function recordUsage(connectionId: string, count = 1): Promise<void> {
  await db
    .insert(apiUsage)
    .values({ connectionId, month: currentMonth(), count })
    .onConflictDoUpdate({
      target: [apiUsage.connectionId, apiUsage.month],
      set: { count: sql`${apiUsage.count} + ${count}` },
    });
}

export async function monthlyUsage(connectionId: string): Promise<number> {
  const [row] = await db
    .select({ count: apiUsage.count })
    .from(apiUsage)
    .where(and(eq(apiUsage.connectionId, connectionId), eq(apiUsage.month, currentMonth())));
  return row?.count ?? 0;
}
