"use client";

import { Player } from "@remotion/player";
import { useCurrentFrame } from "remotion";
import { FLOW, FlowFrame } from "./flow-scenes";

function FlowComposition() {
  return <FlowFrame frame={useCurrentFrame()} />;
}

/** The animation in a Remotion player: rendered as DOM, looping, with nothing to click. Loaded on demand by flow-preview.tsx. */
export default function FlowPlayer() {
  return (
    <Player
      component={FlowComposition}
      durationInFrames={FLOW.durationInFrames}
      fps={FLOW.fps}
      compositionWidth={FLOW.width}
      compositionHeight={FLOW.height}
      style={{ width: "100%", height: "100%" }}
      autoPlay
      // There is no sound, and an unmuted player waits for the browser's audio to start before it
      // moves. Browsers hold audio back until the first click, which left the animation on its
      // empty first frame (for good under React's Strict Mode in development).
      initiallyMuted
      numberOfSharedAudioTags={0}
      loop
      controls={false}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      acknowledgeRemotionLicense
    />
  );
}
