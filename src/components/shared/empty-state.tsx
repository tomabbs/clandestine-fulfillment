/**
 * EmptyState — friendly icon + title + description + optional CTA.
 * Replaces the bare "No orders match these filters." pattern.
 *
 * Usage:
 *
 *   <EmptyState
 *     icon={Package}
 *     title="No orders yet"
 *     description="Orders will appear here once ShipStation syncs them."
 *     action={
 *       <Button onClick={refresh} size="sm">
 *         <RefreshCw className="h-4 w-4 mr-1.5" /> Refresh now
 *       </Button>
 *     }
 *   />
 */

import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Compact variant for inside table cells. */
  compact?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center text-center min-w-0",
        compact ? "py-6 gap-2" : "py-12 gap-3",
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            "rounded-full bg-muted/60 p-3",
            compact && "p-2",
          )}
        >
          <Icon
            className={cn(
              "text-muted-foreground",
              compact ? "h-5 w-5" : "h-6 w-6",
            )}
          />
        </div>
      )}
      <h3 className={cn("font-semibold text-foreground", compact ? "text-sm" : "text-base")}>
        {title}
      </h3>
      {description && (
        <p
          className={cn(
            "text-muted-foreground max-w-md",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {description}
        </p>
      )}
      {action && <div className={cn("mt-1", compact && "mt-0")}>{action}</div>}
    </div>
  );
}
