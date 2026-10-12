// Run by Vercel before each build (see vercel.json). Applies pending database migrations for
// production deploys only, so new code never goes live ahead of its schema and preview builds
// never touch the production database. A failed migration fails the deploy.
import { execSync } from "node:child_process";

if (process.env.VERCEL_ENV !== "production") {
  console.log("Not a production deploy: skipping database migrations.");
  process.exit(0);
}

execSync("npx drizzle-kit migrate", { stdio: "inherit" });
