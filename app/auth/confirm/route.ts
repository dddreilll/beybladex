import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";

// Handles both magic-link styles: the default PKCE `code` link and a `token_hash`
// link (if the Supabase email template is customised to send one).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const next = safeNextPath(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();
  let errorMessage = "The sign-in link is missing its code. Request a new one.";

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) redirect(next);
    errorMessage = error.message;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) redirect(next);
    errorMessage = error.message;
  }

  redirect(`/auth/error?error=${encodeURIComponent(errorMessage)}`);
}
