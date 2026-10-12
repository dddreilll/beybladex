import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't read Next's env files; load the local one if present.
try {
  process.loadEnvFile(".env.local");
} catch {}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["app"],
  // Migrations need a direct or session-mode connection; the app itself can use the transaction pooler.
  dbCredentials: { url: (process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL)! },
});
