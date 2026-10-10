import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Organizer = { id: string; email: string | null };

/** The signed-in organizer, or a redirect to the login page. */
export async function requireOrganizer(): Promise<Organizer> {
  const organizer = await currentOrganizer();
  if (!organizer) redirect("/auth/login");
  return organizer;
}

export async function currentOrganizer(): Promise<Organizer | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}
