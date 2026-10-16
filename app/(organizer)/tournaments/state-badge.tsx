import { Badge } from "@/components/ui/badge";

const LABELS: Record<string, { label: string; variant: "success" | "warning" | "muted" }> = {
  pending: { label: "Not started", variant: "muted" },
  checking_in: { label: "Checking in", variant: "warning" },
  checked_in: { label: "Checked in", variant: "warning" },
  group_stages_underway: { label: "Group stage", variant: "success" },
  group_stages_finalized: { label: "Group stage ended", variant: "warning" },
  underway: { label: "Underway", variant: "success" },
  in_progress: { label: "Underway", variant: "success" },
  awaiting_review: { label: "Awaiting review", variant: "warning" },
  complete: { label: "Complete", variant: "muted" },
  ended: { label: "Complete", variant: "muted" },
};

export function TournamentStateBadge({ state }: { state: string }) {
  const entry = LABELS[state] ?? { label: state.replace(/_/g, " "), variant: "muted" as const };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}
