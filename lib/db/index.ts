import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };

function client() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  // prepare: false keeps this compatible with Supabase's transaction pooler.
  // Each server instance has its own pool, so it stays small and gives idle connections back.
  globalForDb.pgClient ??= postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  return globalForDb.pgClient;
}

export const db = drizzle(client(), { schema });
export { schema };
