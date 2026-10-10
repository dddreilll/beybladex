import { OutboxSync } from "@/components/offline/outbox-sync";
import { requireOrganizer } from "@/lib/auth";

// Full-screen surfaces for the venue (judge pad). Always dark, for contrast under arena lighting.
export default async function JudgeLayout({ children }: { children: React.ReactNode }) {
  await requireOrganizer();
  return (
    <div className="dark min-h-svh bg-background text-foreground">
      <OutboxSync />
      {children}
    </div>
  );
}
