import { requireOrganizer } from "@/lib/auth";

// Signed-in pages. Each page renders the shared header (components/page-shell.tsx), which holds
// the side navigation; there is no top navigation bar.
export default async function OrganizerLayout({ children }: { children: React.ReactNode }) {
  await requireOrganizer();
  return <div className="min-h-svh bg-background">{children}</div>;
}
