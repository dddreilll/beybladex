import Link from "next/link";
import { CircleCheck, ListOrdered, Network, Trophy, Users, type LucideIcon } from "lucide-react";
import { TAB_LABELS, type DeskTab } from "@/lib/desk-tabs";
import { cn } from "@/lib/utils";

const ICONS: Record<DeskTab, LucideIcon> = { queue: ListOrdered, standings: Trophy, players: Users, completed: CircleCheck, bracket: Network };

/**
 * The Desk's tabs, as a rail down its left side on a wide screen and, on a narrow one, above the
 * content, wrapping onto a second line rather than hiding a tab off the edge. They are links: the open tab is in the address, so a reload, the back button and the
 * Desk's live refresh all keep it. With a single tab there is nothing to switch, so no rail.
 */
export function DeskTabs({ tabs, open, counts, hrefFor }: { tabs: DeskTab[]; open: DeskTab; counts: Partial<Record<DeskTab, number>>; hrefFor: (tab: DeskTab) => string }) {
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Desk sections" className="w-full lg:sticky lg:top-6 lg:w-52 lg:flex-none">
      <ul className="flex flex-wrap gap-1 border-b pb-2 lg:flex-col lg:flex-nowrap lg:border-b-0 lg:pb-0">
        {tabs.map((tab) => {
          const Icon = ICONS[tab];
          const current = tab === open;
          return (
            <li key={tab} className="shrink-0">
              <Link
                href={hrefFor(tab)}
                scroll={false}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex min-h-11 items-center gap-3 whitespace-nowrap rounded-lg px-3 text-sm font-semibold",
                  // The open tab: a card behind it and, in the rail, a lime bar on its left edge.
                  current
                    ? "border bg-card text-foreground lg:before:absolute lg:before:inset-y-2 lg:before:-left-px lg:before:w-1 lg:before:rounded-full lg:before:bg-primary-text"
                    : "border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", current && "text-primary-text")} aria-hidden />
                {TAB_LABELS[tab]}
                {counts[tab] !== undefined && <span className="ml-auto pl-2 font-normal tabular-nums text-muted-foreground">{counts[tab]}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
