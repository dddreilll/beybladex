import { OutboxSync } from "@/components/offline/outbox-sync";

// A judge tablet's screens. Always dark, like the pad; the outbox keeps unsent taps syncing
// whichever of these pages is open.
export default function JudgeTabletLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark min-h-svh bg-background text-foreground">
      <OutboxSync />
      {children}
    </div>
  );
}
