// Invites an organizer. Sign-ups are off, so this is how someone gets access:
//
//   npm run invite -- organizer@example.com
//
// They get the invite email (supabase/templates/invite.html); locally it lands in Mailpit at
// http://127.0.0.1:44324. Once invited, they sign in at /auth/login like anyone else.
//
// Against local Supabase the secret key is read from `supabase status`. Against a hosted project,
// set SUPABASE_SECRET_KEY to its secret (service role) key for this one command; never put it in
// a file the app loads.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const email = process.argv[2]?.trim();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: npm run invite -- organizer@example.com");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!url) {
  console.error("NEXT_PUBLIC_SUPABASE_URL is not set. See the README to set up .env.local.");
  process.exit(1);
}

const localSecret = () => {
  const status = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return status.match(/^SECRET_KEY="?([^"\r\n]+)/m)?.[1] ?? status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)/m)?.[1];
};
const isLocal = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);
const secret = process.env.SUPABASE_SECRET_KEY ?? (isLocal ? localSecret() : undefined);
if (!secret) {
  console.error(isLocal ? "Couldn't read the local Supabase secret key. Is `npm run supabase:start` running?" : "Set SUPABASE_SECRET_KEY to the hosted project's secret key for this command.");
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false } });
const { error } = await admin.auth.admin.inviteUserByEmail(email);
if (error) {
  console.error(error.code === "email_exists" ? `${email} already has access. They can sign in at /auth/login.` : `Couldn't invite ${email}: ${error.message}`);
  process.exit(1);
}
console.log(`Invited ${email}.${isLocal ? " The email is in Mailpit: http://127.0.0.1:44324" : ""}`);
