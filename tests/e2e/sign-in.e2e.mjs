// End-to-end check that organizer sign-in is invite-only: an email nobody invited gets no link
// and no account (from the form, and when Supabase is called directly), the invite script's
// email signs an organizer in through the app, and an invited organizer can ask for a sign-in
// link afterwards. Same prerequisites as the other suites:
//
//   npm run supabase:start
//   npm run build && npx next start -p 3100
//   node tests/e2e/sign-in.e2e.mjs
import { execSync, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";

process.loadEnvFile(".env.local");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const MAILPIT = "http://127.0.0.1:44324";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const status = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const secret = status.match(/^SECRET_KEY="?([^"\r\n]+)/m)?.[1] ?? status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)/m)?.[1];
if (!secret) throw new Error("Couldn't read the local Supabase secret key. Is `npm run supabase:start` running?");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, secret, { auth: { persistSession: false } });
const anyone = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const stranger = `e2e+stranger${stamp}@example.test`;
const direct = `e2e+direct${stamp}@example.test`;
const invited = `e2e+invited${stamp}@example.test`;
const userFor = async (email) => (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email);
const invite = (email) => spawnSync(process.execPath, ["scripts/invite-organizer.mjs", email], { encoding: "utf8" });
/** The newest email to an address, from the local test inbox. */
const mailTo = async (email) => {
  for (let i = 0; i < 40; i++) {
    const found = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    if (found.messages?.length) return (await fetch(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
};

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "msedge", executablePath: process.env.E2E_EXECUTABLE, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

try {
  // ------------------------------------------------------------------------------------------
  // Not invited
  // ------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/auth/login`);
  check("the sign-in card says access is by invite", (await page.getByText(/Access is by invite for now\./).count()) === 1);
  await page.getByLabel("Email").fill(stranger);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  const refusal = page.getByRole("alert").filter({ hasText: "This email doesn't have access yet. BXQ is invite-only for now." });
  await refusal.waitFor();
  check("an email nobody invited is told it has no access, and isn't told to check its inbox", (await page.getByText("Check your inbox").count()) === 0);
  const requestUrl = process.env.EARLY_ACCESS_URL?.trim();
  check("the refusal offers Request Early Access when this deployment has a link", (await refusal.getByRole("link", { name: "Request Early Access" }).count()) === (requestUrl ? 1 : 0));
  check("no account was made for it, and no email sent", !(await userFor(stranger)) && (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${stranger}"`)}`)).json()).messages.length === 0);

  // Going around the form: the rule is Supabase's, not the page's.
  const { error: directError } = await anyone.auth.signInWithOtp({ email: direct });
  check("asking Supabase directly, without the form, is refused too", Boolean(directError) && !(await userFor(direct)), directError?.code ?? "no error");
  const { error: signUpError } = await anyone.auth.signUp({ email: direct, password: `pw-${stamp}-Aa1` });
  check("and so is signing up with a password", Boolean(signUpError) && !(await userFor(direct)), signUpError?.code ?? "no error");

  // ------------------------------------------------------------------------------------------
  // Invited
  // ------------------------------------------------------------------------------------------
  const sent = invite(invited);
  check("npm run invite invites an email", sent.status === 0 && sent.stdout.includes(`Invited ${invited}.`), (sent.stdout + sent.stderr).trim().slice(0, 200));
  const mail = await mailTo(invited);
  const href = mail?.HTML?.match(/href="([^"]*\/auth\/confirm\?[^"]*)"/)?.[1]?.replaceAll("&amp;", "&");
  check("the invite email is BXQ's own and links to the app's confirm route", mail?.Subject === "You're invited to BXQ" && /token_hash=[^&]+&type=invite&next=\/tournaments$/.test(href ?? ""), `${mail?.Subject} · ${href?.replace(/token_hash=[^&]+/, "token_hash=…")}`);
  // The email points at the site URL; this run's server may be on another port.
  const link = new URL(href);
  await page.goto(`${BASE}${link.pathname}${link.search}`);
  await page.waitForURL("**/tournaments");
  await page.getByRole("heading", { name: "Tournaments", exact: true, level: 1 }).waitFor();
  check("opening the invite signs the organizer in and lands on their tournaments", true);

  const again = invite(invited);
  check("inviting the same email twice says they already have access", again.status === 1 && again.stderr.includes("already has access"), again.stderr.trim().slice(0, 200));

  // Later, from a browser that isn't signed in.
  const later = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await later.goto(`${BASE}/auth/login`);
  await later.getByLabel("Email").fill(invited);
  await later.getByRole("button", { name: "Email me a sign-in link" }).click();
  await later.getByText("Check your inbox").waitFor();
  check("once invited, the organizer gets a sign-in link from the form like before", (await later.getByText(/doesn't have access yet/).count()) === 0 && Boolean(await mailTo(invited)));
} catch (error) {
  check("no unexpected error", false, String(error).slice(0, 900));
} finally {
  await browser.close();
  for (const email of [stranger, direct, invited]) {
    const user = await userFor(email);
    if (user) await admin.auth.admin.deleteUser(user.id);
  }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
