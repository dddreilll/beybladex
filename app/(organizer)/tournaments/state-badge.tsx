import { Badge } from "@/components/ui/badge";
import type { TournamentState } from "@/lib/tournament/format";

const LABELS: Record<TournamentState, { label: string; variant: "success" | "warning" | "muted" }> = {
  pending: { label: "Not started", variant: "muted" },
  group_stage: { label: "Group stage", variant: "success" },
  between_stages: { label: "Group stage ended", variant: "warning" },
  underway: { label: "Underway", variant: "success" },
  complete: { label: "Complete", variant: "muted" },
};

export function TournamentStateBadge({ state }: { state: TournamentState }) {
  const entry = LABELS[state] ?? { label: state, variant: "muted" as const };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}
