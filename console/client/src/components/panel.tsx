import type * as React from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function Panel({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  flush = false,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  flush?: boolean;
}): React.ReactElement {
  const hasHeader = title !== undefined || action !== undefined;
  return (
    <Card className={cn("gap-0 overflow-hidden", className)}>
      {hasHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            {title === undefined ? null : (
              <div className="font-heading font-semibold text-sm">{title}</div>
            )}
            {description === undefined ? null : (
              <div className="mt-0.5 text-[13px] text-muted-foreground">
                {description}
              </div>
            )}
          </div>
          {action === undefined ? null : (
            <div className="flex items-center gap-2">{action}</div>
          )}
        </div>
      ) : null}
      {flush ? (
        children
      ) : (
        <div className={cn("p-4", contentClassName)}>{children}</div>
      )}
    </Card>
  );
}
