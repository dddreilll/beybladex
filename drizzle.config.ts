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
  dbCredentials: { url: process.env.DATABASE_URL! },
});
