import type * as React from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "error" | "warning" | "success";
}): React.ReactElement {
  return (
    <Card className="gap-1.5 p-5">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div
        className={cn(
          "font-heading text-3xl font-semibold tabular-nums tracking-tight",
          tone === "error" && "text-destructive-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "success" && "text-success-foreground",
        )}
      >
        {value}
      </div>
      {hint === undefined ? null : (
        <div className="text-muted-foreground text-xs">{hint}</div>
      )}
    </Card>
  );
}
