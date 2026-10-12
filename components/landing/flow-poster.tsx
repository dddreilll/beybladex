import { APP_NAME } from "@/lib/config";

const eyebrow = "text-[3cqw] font-bold uppercase leading-none tracking-widest text-muted-foreground";

/**
 * A still of the animation's last scene, the board calling the match: shown while the player
 * loads, and instead of it for people who ask for reduced motion. Sized in container units so it
 * scales with its box the way the player does.
 */
export function FlowPoster() {
  return (
    <div aria-hidden className="dark absolute inset-[4.67cqw] flex flex-col justify-center gap-[3.3cqw] rounded-[4cqw] border bg-background p-[4cqw] text-foreground">
      <span className={eyebrow}>{APP_NAME} Board · Venue TV</span>
      <div className="flex flex-col gap-[1.5cqw] rounded-[2.7cqw] bg-primary px-[4cqw] py-[4.5cqw] text-primary-foreground">
        <span className="text-[3cqw] font-bold uppercase leading-none tracking-widest">Now calling · Stadium 2</span>
        <span className="font-display text-[7cqw] font-bold leading-none">
          Alex <span className="text-[4cqw] opacity-60">vs</span> Sam
        </span>
      </div>
      <div className="grid grid-cols-2 gap-[2cqw]">
        <div className="flex flex-col gap-[1.7cqw] rounded-[2.7cqw] border bg-card p-[2.7cqw]">
          <span className={eyebrow}>On deck</span>
          <span className="text-[3.8cqw] font-semibold leading-none">Quinn vs Drew</span>
        </div>
        <div className="flex flex-col gap-[1.7cqw] rounded-[2.7cqw] border bg-card p-[2.7cqw]">
          <span className={eyebrow}>In the hole</span>
          <span className="text-[3.8cqw] font-semibold leading-none">Casey vs Robin</span>
        </div>
      </div>
    </div>
  );
}
