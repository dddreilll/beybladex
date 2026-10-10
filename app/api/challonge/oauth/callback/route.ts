import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { currentOrganizer } from "@/lib/auth";
import { completeAuthorization } from "@/lib/challonge/connection";
import { OAUTH_NONCE_COOKIE } from "@/lib/config";
import { verifyPayload } from "@/lib/crypto/secrets";

type OAuthState = { o: string; n: string; exp: number };

const back = (error: string) => redirect(`/settings/challonge?error=${error}`);

export async function GET(request: NextRequest) {
  const organizer = await currentOrganizer();
  if (!organizer) redirect("/auth/login?next=/settings/challonge");

  const params = request.nextUrl.searchParams;
  const cookieStore = await cookies();
  const nonce = cookieStore.get(OAUTH_NONCE_COOKIE)?.value;
  cookieStore.delete({ name: OAUTH_NONCE_COOKIE, path: "/api/challonge/oauth" });

  if (params.get("error")) back("denied");

  const state = verifyPayload<OAuthState>(params.get("state") ?? "");
  const stateValid = state && state.o === organizer.id && state.exp > Date.now() && nonce && state.n === nonce;
  if (!stateValid) back("invalid_state");

  const code = params.get("code");
  if (!code) back("missing_code");

  let failed = false;
  try {
    await completeAuthorization(organizer.id, code!);
  } catch (error) {
    console.error("Challonge authorization failed", error);
    failed = true;
  }
  if (failed) back("exchange_failed");
  redirect("/settings/challonge?connected=1");
}
