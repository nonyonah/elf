import { Badge } from "@/components/ui/badge";
import type { DriftState } from "@/lib/types";

const META: Record<
  DriftState,
  { label: string; variant: "success" | "error" | "warning" | "secondary" }
> = {
  ok: { label: "In sync", variant: "success" },
  drift: { label: "Drift", variant: "error" },
  stale: { label: "Stale", variant: "warning" },
  unknown: { label: "Awaiting data", variant: "secondary" },
};

export function stateLabel(state: DriftState): string {
  return META[state].label;
}

export function StatusPill({
  state,
  size = "default",
}: {
  state: DriftState;
  size?: "default" | "sm" | "lg";
}): React.ReactElement {
  const meta = META[state];
  return (
    <Badge size={size} variant={meta.variant}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {meta.label}
    </Badge>
  );
}
