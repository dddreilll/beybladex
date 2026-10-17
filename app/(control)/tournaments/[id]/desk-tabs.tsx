import Link from "next/link";
import { TAB_LABELS, type DeskTab } from "@/lib/desk-tabs";
import { cn } from "@/lib/utils";

/**
 * The Desk's tabs, as links: the open one is in the address, so a reload, the back button and the
 * Desk's live refresh all keep it. With a single tab there is nothing to switch, so no bar.
 */
export function DeskTabs({ tabs, open, counts, hrefFor }: { tabs: DeskTab[]; open: DeskTab; counts: Partial<Record<DeskTab, number>>; hrefFor: (tab: DeskTab) => string }) {
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Desk sections" className="overflow-x-auto border-b">
      <ul className="flex gap-1">
        {tabs.map((tab) => (
          <li key={tab}>
            <Link
              href={hrefFor(tab)}
              scroll={false}
              aria-current={tab === open ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-semibold",
                tab === open ? "border-primary-text text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {TAB_LABELS[tab]}
              {counts[tab] !== undefined && <span className="font-normal tabular-nums text-muted-foreground">{counts[tab]}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
