import { FREE_TIER_MONTHLY_REQUESTS } from "@/lib/config";
import { cn } from "@/lib/utils";

/** Our own count of Challonge requests this month (the Developer Portal counter lags). */
export function BudgetMeter({ used, limit = FREE_TIER_MONTHLY_REQUESTS, className }: { used: number; limit?: number; className?: string }) {
  const ratio = Math.min(used / limit, 1);
  const tone = ratio >= 0.9 ? "bg-destructive" : ratio >= 0.7 ? "bg-warning" : "bg-primary";
  return (
    <div className={cn("flex min-w-56 flex-col gap-1.5", className)}>
      <div className="flex justify-between gap-4 text-sm">
        <span className="text-muted-foreground">Challonge API budget</span>
        <span className="font-semibold tabular-nums">
          {used} / {limit}
        </span>
      </div>
      <div
        role="meter"
        aria-label="Challonge API requests used this month"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full", tone)} style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">This month · counted by this app</span>
    </div>
  );
}
