"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import { FlowPoster } from "./flow-poster";

// Remotion stays out of the page's first load: the player arrives after the page has rendered.
const FlowPlayer = dynamic(() => import("./flow-player"), { ssr: false, loading: () => <FlowPoster /> });

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** The hero's animation of a match moving from the pad to the board, or a still of it for reduced motion. */
export function FlowPreview() {
  // On the server and while hydrating there is no player yet, so both start from the still.
  const still = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => true,
  );
  return (
    <div
      role="img"
      aria-label="A judge taps Burst on the pad, the result is sent to Challonge, the next player gets a push that they're up, and the board calls their match."
      className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border bg-card [container-type:inline-size]"
    >
      {still ? <FlowPoster /> : <FlowPlayer />}
    </div>
  );
}
