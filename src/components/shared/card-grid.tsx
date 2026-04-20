/**
 * CardGrid — responsive horizontal card row that wraps as window narrows.
 *
 * Pure CSS — no JS measurement, no breakpoint math. Uses CSS grid
 * `repeat(auto-fit, minmax(MIN, MAX))` so cards stay the right size at
 * every viewport.
 *
 * `auto-fit` (default) collapses unused tracks → 2 cards in a 4-card-wide
 *   grid will sit at their natural width with empty space on the right
 *   instead of stretching awkwardly. Reviewer round 1 specifically
 *   flagged this case.
 *
 * `auto-fill` keeps all tracks reserved → cards stretch to fill. Use
 *   when you want consistent card sizing across all viewports
 *   (catalog browse where every tile should look the same).
 *
 * Usage:
 *
 *   <CardGrid items={artists} minCardWidth={280} maxCardWidth={400}>
 *     {(artist) => (
 *       <Card>
 *         <CardHeader><CardTitle>{artist.name}</CardTitle></CardHeader>
 *         <CardContent>...</CardContent>
 *       </Card>
 *     )}
 *   </CardGrid>
 *
 * Recommended page-type settings (from plan section 3e):
 *   - Dashboard KPI tiles    → minCardWidth 240, auto-fit
 *   - Clients list (~15)     → minCardWidth 280, auto-fit
 *   - Catalog (50+)          → minCardWidth 220, maxCardWidth 300, auto-fill
 *   - Stat-row header (3-4)  → minCardWidth 240, maxCardWidth 400, auto-fit
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CardGridProps<T> {
  items: readonly T[];
  children: (item: T, index: number) => ReactNode;
  /** Minimum card width in pixels before wrap. Default 280. */
  minCardWidth?: number;
  /** Optional max card width in pixels — caps stretch in sparse rows. */
  maxCardWidth?: number;
  /** Default 'auto-fit' (collapses empty tracks). 'auto-fill' keeps tracks reserved. */
  fillStrategy?: "auto-fit" | "auto-fill";
  /** Gap between cards (Tailwind utility class). Default 'gap-4'. */
  gap?: string;
  /** Key extractor — defaults to index. Provide for stable React keys when items reorder. */
  itemKey?: (item: T, index: number) => string | number;
  className?: string;
}

export function CardGrid<T>({
  items,
  children,
  minCardWidth = 280,
  maxCardWidth,
  fillStrategy = "auto-fit",
  gap = "gap-4",
  itemKey,
  className,
}: CardGridProps<T>) {
  // Build CSS grid template via inline style — avoids needing a JS resize
  // observer. CSS handles all the responsive math.
  const maxValue = maxCardWidth ? `${maxCardWidth}px` : "1fr";
  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${fillStrategy}, minmax(${minCardWidth}px, ${maxValue}))`,
  };
  return (
    <div
      data-slot="card-grid"
      data-fill-strategy={fillStrategy}
      className={cn(gap, "min-w-0", className)}
      style={style}
    >
      {items.map((item, index) => {
        const key = itemKey ? itemKey(item, index) : index;
        return (
          <div key={key} data-slot="card-grid-item" className="min-w-0">
            {children(item, index)}
          </div>
        );
      })}
    </div>
  );
}
