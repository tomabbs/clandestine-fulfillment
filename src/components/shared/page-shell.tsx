/**
 * PageShell — standard page-level wrapper for admin + portal routes.
 *
 * Encapsulates the responsive defaults so individual pages don't need
 * to hand-roll `<div className="p-6 space-y-6">` (which is the pattern
 * that historically forgot `min-w-0` and led to silent clipping).
 *
 * Usage:
 *
 *   <PageShell
 *     title="Inventory"
 *     description="..."
 *     actions={<Button>Export CSV</Button>}
 *     toolbar={<PageToolbar>...</PageToolbar>}
 *   >
 *     <ResponsiveTable ... />
 *   </PageShell>
 *
 * Variants:
 *   maxWidth?: "lg" | "xl" | "full" (default "full")
 *     "lg"   = constrained ~896px (forms, scan)
 *     "xl"   = constrained ~1280px (settings detail pages)
 *     "full" = no max-width (data lists)
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageShellProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  maxWidth?: "lg" | "xl" | "full";
  className?: string;
}

const MAX_WIDTH_CLASS = {
  lg: "max-w-4xl",
  xl: "max-w-7xl",
  full: "max-w-full",
} as const;

export function PageShell({
  title,
  description,
  actions,
  toolbar,
  children,
  maxWidth = "full",
  className,
}: PageShellProps) {
  return (
    <div
      className={cn(
        // min-w-0 is critical so the shell can shrink inside its flex parent
        // (admin/portal layout's <main flex-1 min-w-0>). Without it, any
        // wide child (table, form) would push the layout past the viewport.
        "min-w-0 p-4 sm:p-6 space-y-4 sm:space-y-6",
        MAX_WIDTH_CLASS[maxWidth],
        maxWidth !== "full" && "mx-auto w-full",
        className,
      )}
    >
      {/* Header — title + actions. flex-wrap so action buttons reflow on narrow. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>
        )}
      </header>

      {toolbar && <div className="min-w-0">{toolbar}</div>}

      <div className="min-w-0">{children}</div>
    </div>
  );
}
