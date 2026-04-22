/**
 * PageToolbar — filter / search / actions row primitive.
 *
 * Defaults to flex-wrap so child controls reflow gracefully on narrow
 * screens. Stops the recurring "header bleeds off-screen" bug.
 *
 * Usage:
 *
 *   <PageToolbar>
 *     <Input placeholder="Search..." className="flex-1 min-w-[200px] max-w-xs" />
 *     <Select>...</Select>
 *     <Select>...</Select>
 *     <PageToolbar.Actions>
 *       <Button>Export</Button>
 *     </PageToolbar.Actions>
 *   </PageToolbar>
 *
 * The `.Actions` slot pushes its children to the right (margin-left: auto)
 * so primary CTAs visually separate from filters.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageToolbarProps {
  children: ReactNode;
  className?: string;
}

export function PageToolbar({ children, className }: PageToolbarProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 min-w-0", className)}>{children}</div>
  );
}

export interface PageToolbarActionsProps {
  children: ReactNode;
  className?: string;
}

function PageToolbarActions({ children, className }: PageToolbarActionsProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 ml-auto", className)}>{children}</div>
  );
}

PageToolbar.Actions = PageToolbarActions;
