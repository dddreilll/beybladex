"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const router = useRouter();

  const logout = async () => {
    // Cached judge pads contain this organizer's data: drop them with the session.
    navigator.serviceWorker?.controller?.postMessage({ type: "clear-caches" });
    await createClient().auth.signOut();
    router.push("/auth/login");
    router.refresh();
  };

  return (
    <Button variant="outline" size="sm" onClick={logout}>
      Sign out
    </Button>
  );
}
