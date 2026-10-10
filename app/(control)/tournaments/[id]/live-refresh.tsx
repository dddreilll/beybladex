"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the control room when judges, results or the queue change it from other devices. */
export function LiveRefresh({ slug, version }: { slug: string; version: number }) {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/public/${slug}/board`, { headers: { "If-None-Match": `W/"v${version}"` }, cache: "no-store" });
          if (res.status === 200) {
            router.refresh();
            return; // the refreshed page mounts a new poller with the new version
          }
        } catch {}
      }
      if (!stopped) timer = setTimeout(tick, 4000);
    };
    timer = setTimeout(tick, 4000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [slug, version, router]);
  return null;
}
