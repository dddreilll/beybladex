import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasEnvVars } from "../utils";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  // If the env vars are not set, skip proxy check. You can remove this
  // once you setup the project.
  if (!hasEnvVars) {
    return supabaseResponse;
  }

  // With Fluid compute, don't put this client in a global environment
  // variable. Always create a new one on each request.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not run code between createServerClient and
  // supabase.auth.getClaims(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  // IMPORTANT: If you remove getClaims() and you use server-side rendering
  // with the Supabase client, your users may be randomly logged out.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  const { pathname, search } = request.nextUrl;
  // No organizer sign-in: the venue call board and player pages (/t/<slug>) and their endpoints.
  // They check their own access (an approved screen, a player's passcode; see lib/access.ts).
  // Also public: what a player's phone needs for notifications (service worker, icons), and the
  // preview image that chat apps fetch when a link to the app is shared.
  const isPublic =
    pathname === "/" ||
    pathname.startsWith("/auth") ||
    // Linked from the sign-in screens, so they must open before anyone has signed in.
    pathname === "/terms" ||
    pathname === "/privacy" ||
    pathname.startsWith("/t/") ||
    // Short links to the call board and the judge sign-up; both lead into /t/<slug>.
    pathname.startsWith("/b/") ||
    pathname.startsWith("/j/") ||
    pathname.startsWith("/api/public/") ||
    pathname === "/sw.js" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/apple-icon") ||
    pathname.startsWith("/opengraph-image");
  // API routes answer for themselves (401 as JSON): a fetch can't follow a login redirect usefully.
  if (!user && !isPublic && !pathname.startsWith("/api/")) {
    // Not signed in: send to login and come back here afterwards.
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    url.search = "";
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is.
  // If you're creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  // 4. Finally:
  //    return myNewResponse
  // If this is not done, you may be causing the browser and server to go out
  // of sync and terminate the user's session prematurely!

  return supabaseResponse;
}
