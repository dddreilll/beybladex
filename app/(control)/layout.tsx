import { OutboxSync } from "@/components/offline/outbox-sync";
import { requireOrganizer } from "@/lib/auth";

// The control room follows the venue mockup: its own header instead of the app navigation.
// It follows the theme switch like the other organizer pages; only the venue screens (judge pad,
// call board, player page) are always dark.
export default async function ControlLayout({ children }: { children: React.ReactNode }) {
  await requireOrganizer();
  return (
    <div className="min-h-svh bg-background text-foreground">
      <OutboxSync />
      {children}
    </div>
  );
}
