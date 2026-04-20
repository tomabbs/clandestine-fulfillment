/**
 * TableSkeleton — shimmer-animated rows for loading states.
 *
 * Replaces the spinning Loader2 + text pattern. Renders N skeleton
 * rows that match the column-count layout of the parent table.
 *
 * Usage inside a <Table>:
 *
 *   <TableBody>
 *     {isLoading
 *       ? <TableSkeleton rowCount={10} columnCount={6} />
 *       : data.map((row) => <TableRow>...</TableRow>)}
 *   </TableBody>
 */

import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface TableSkeletonProps {
  rowCount?: number;
  columnCount: number;
  /** Optional per-column min width hints for more realistic skeleton. */
  columnWidths?: Array<string | undefined>;
}

export function TableSkeleton({
  rowCount = 8,
  columnCount,
  columnWidths,
}: TableSkeletonProps) {
  return (
    <>
      {Array.from({ length: rowCount }).map((_, rowIdx) => (
        <TableRow
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are stable in skeleton
          key={`skel-${rowIdx}`}
        >
          {Array.from({ length: columnCount }).map((__, colIdx) => (
            <TableCell
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are stable in skeleton
              key={`skel-${rowIdx}-${colIdx}`}
              className="py-3"
            >
              <div
                className={cn(
                  "skeleton-shimmer h-4",
                  columnWidths?.[colIdx] ?? "w-3/4",
                )}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/**
 * SkeletonBar — single shimmer rectangle for use anywhere outside a table.
 */
export function SkeletonBar({
  className,
  height = "h-4",
}: {
  className?: string;
  height?: string;
}) {
  return <div className={cn("skeleton-shimmer", height, className)} />;
}
