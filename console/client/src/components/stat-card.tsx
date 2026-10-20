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
    <Card className="gap-1 p-4">
      <div className="leading-tight text-[13px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "font-heading font-semibold text-2xl leading-none tabular-nums tracking-tight",
          tone === "error" && "text-destructive-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "success" && "text-success-foreground",
        )}
      >
        {value}
      </div>
      {hint === undefined ? null : (
        <div className="leading-tight text-[13px] text-muted-foreground">{hint}</div>
      )}
    </Card>
  );
}
