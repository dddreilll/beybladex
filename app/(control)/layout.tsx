import { OutboxSync } from "@/components/offline/outbox-sync";
import { requireOrganizer } from "@/lib/auth";

// The control room follows the venue mockup: its own header instead of the app navigation,
// and always dark like the other screens used during an event.
export default async function ControlLayout({ children }: { children: React.ReactNode }) {
  await requireOrganizer();
  return (
    <div className="dark min-h-svh bg-background text-foreground">
      <OutboxSync />
      {children}
    </div>
  );
}
