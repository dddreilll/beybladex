import { OutboxSync } from "@/components/offline/outbox-sync";
import { SideNav } from "@/components/side-nav";
import { requireOrganizer } from "@/lib/auth";
import { monthlyUsage } from "@/lib/challonge/budget";
import { getConnection } from "@/lib/challonge/connection";

type HeaderProps = {
  title: string;
  /** Small line under the title, e.g. the tournament name. */
  subtitle?: string;
  /** Page-specific items on the right: status chips, buttons. */
  children?: React.ReactNode;
};

/**
 * The header bar every signed-in page shares: menu button, title, actions. Moving between
 * sections goes through the side navigation. The header loads what the navigation shows on
 * every page (the account and the Challonge API budget), so pages don't each have to.
 */
export async function PageHeader({ title, subtitle, children }: HeaderProps) {
  const organizer = await requireOrganizer();
  const connection = await getConnection(organizer.id);
  const requestsUsed = connection ? await monthlyUsage(connection.id) : null;

  return (
    <header className="border-b bg-card">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
        <SideNav email={organizer.email} requestsUsed={requestsUsed} />
        <div className="flex min-w-[12rem] flex-1 flex-col">
          <h1 className="font-display text-3xl font-bold leading-tight">{title}</h1>
          {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    </header>
  );
}

/** Header plus the page body, laid out like the control room: full width with the same padding. */
export function PageShell({ children, actions, ...header }: Omit<HeaderProps, "children"> & { actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <PageHeader {...header}>{actions}</PageHeader>
      <div className="px-4 sm:px-6">
        <OutboxSync banner />
      </div>
      <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
