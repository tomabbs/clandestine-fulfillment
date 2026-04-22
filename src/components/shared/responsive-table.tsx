/**
 * ResponsiveTable — single primitive that renders as a real table on
 * md+ and as stacked cards on <md.
 *
 * Two rendering strategies:
 *
 * 1. **CSS-toggle (default)** — same `<table>` DOM in both modes; a
 *    media query in globals.css rewrites the layout to block-level
 *    cards below md, with column labels injected via `td[data-label]
 *    ::before { content: attr(data-label); }`. No DOM duplication.
 *    React composition (StatusBadge, action menus, etc.) works the
 *    same in both modes.
 *
 * 2. **mobileRowRender escape hatch** — for complex rows where the
 *    CSS-toggle is awkward (image-heavy rows, multi-line custom
 *    layouts, deeply nested content). When provided, desktop
 *    renders the table; mobile renders a CardGrid of the bespoke
 *    row component.
 *
 * Reviewer-driven hardening:
 *   - Dynamic colSpan from visible-column count (no hardcoded magic).
 *   - Density mode (`ops` | `browse`) sets row padding via data attr.
 *   - Loading + empty + error states as first-class props.
 *   - Selectable rows with checkbox column + `onSelectionChange`.
 *
 * Usage:
 *
 *   <ResponsiveTable
 *     rows={items}
 *     getRowId={(row) => row.id}
 *     columns={[
 *       { key: "title",     label: "Product",   primary: true },
 *       { key: "sku",       label: "SKU",       mono: true },
 *       { key: "available", label: "Available", align: "right", hideBelow: "lg" },
 *       { key: "status",    label: "Status",
 *           render: (row) => <StatusBadge intent="success">{row.status}</StatusBadge> },
 *       { key: "actions",   label: "",          isActions: true,
 *           render: (row) => <RowActions row={row} /> },
 *     ]}
 *     rowExpand={(row) => <ItemDetail row={row} />}
 *     loading={isLoading}
 *     emptyState={<EmptyState icon={Package} title="No items" />}
 *     density="ops"
 *   />
 */

"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { CardGrid } from "@/components/shared/card-grid";
import { TableSkeleton } from "@/components/shared/table-skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type ResponsiveTableBreakpoint = "sm" | "md" | "lg" | "xl";

export interface ResponsiveTableColumn<TRow> {
  /** Stable column key. Used for React keys + as fallback for `data-label`. */
  key: string;
  /** Visible column header. Also injected as the `::before` label on phone cards. */
  label: string;
  /** Primary column — becomes the card title on phone. Exactly one column should be primary. */
  primary?: boolean;
  /** True for the actions column — renders as a footer row inside the card on phone. */
  isActions?: boolean;
  /** Column hides below this breakpoint on desktop (e.g. "lg" hides until lg+). */
  hideBelow?: ResponsiveTableBreakpoint;
  /** Right-align the cell content (e.g., currency columns). */
  align?: "left" | "center" | "right";
  /** Use monospace font for the cell content (SKUs, IDs). */
  mono?: boolean;
  /** Custom cell renderer. If omitted, `row[key]` is rendered as text. */
  render?: (row: TRow, rowIndex: number) => ReactNode;
  /** Optional className for the cell. */
  cellClassName?: string;
  /** Optional className for the header. */
  headClassName?: string;
}

export interface ResponsiveTableProps<TRow> {
  rows: readonly TRow[];
  columns: Array<ResponsiveTableColumn<TRow>>;
  /** Stable row id extractor — required for React keys + selection. */
  getRowId: (row: TRow) => string | number;
  /** Optional click handler — clicking a row toggles its expanded state. */
  rowExpand?: (row: TRow) => ReactNode;
  /** Selection. */
  selectable?: boolean;
  selectedIds?: Set<string | number>;
  onSelectionChange?: (selectedIds: Set<string | number>) => void;
  /** Loading state — renders TableSkeleton. */
  loading?: boolean;
  /** Number of skeleton rows when loading. Default 8. */
  loadingRowCount?: number;
  /** Empty state element rendered when rows is empty and loading is false. */
  emptyState?: ReactNode;
  /** Row density. Default "ops" (denser, for processing pages). */
  density?: "ops" | "browse";
  /** Phone escape hatch — when provided, mobile renders CardGrid of this instead of CSS-toggle. */
  mobileRowRender?: (row: TRow, rowIndex: number) => ReactNode;
  /** Min card width when using mobileRowRender. Default 280. */
  mobileRowMinWidth?: number;
  /** Optional className for the outer wrapper. */
  className?: string;
  /** ARIA-label / caption for the table. */
  ariaLabel?: string;
}

// Map column hideBelow → Tailwind utility classes for `<th>` and `<td>`.
const HIDE_BELOW_CLASS: Record<ResponsiveTableBreakpoint, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

const ALIGN_CLASS = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

// Used only for dynamic colSpan calculation. We can't measure the actual
// viewport from the server, so we count ALL columns regardless of hideBelow.
// The empty/expand row spans all columns; hidden cells contribute zero
// width but must be in the colSpan for layout consistency.

export function ResponsiveTable<TRow>({
  rows,
  columns,
  getRowId,
  rowExpand,
  selectable = false,
  selectedIds,
  onSelectionChange,
  loading = false,
  loadingRowCount = 8,
  emptyState,
  density = "ops",
  mobileRowRender,
  mobileRowMinWidth = 280,
  className,
  ariaLabel,
}: ResponsiveTableProps<TRow>) {
  const [expandedRowId, setExpandedRowId] = useState<string | number | null>(null);

  // Dynamic colSpan — counts checkbox column too. Used for empty-state and
  // expand rows so they always span the full width regardless of which
  // columns are toggled visible.
  const visibleColCount = useMemo(() => {
    return columns.length + (selectable ? 1 : 0);
  }, [columns, selectable]);

  function toggleSelectRow(id: string | number) {
    if (!selectable || !onSelectionChange) return;
    const next = new Set(selectedIds ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  }

  function toggleSelectAll() {
    if (!selectable || !onSelectionChange) return;
    const allIds = rows.map((r) => getRowId(r));
    const allSelected = allIds.every((id) => selectedIds?.has(id));
    onSelectionChange(allSelected ? new Set() : new Set(allIds));
  }

  // ── Mobile escape hatch — CardGrid of mobileRowRender ─────────────────
  // Hides the desktop table at <md, shows CardGrid only at <md.
  const mobileEscape = mobileRowRender ? (
    <div className="md:hidden min-w-0">
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: loadingRowCount }).map((_, i) => (
            <div key={`mobile-skel-${i}`} className="skeleton-shimmer h-24" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        (emptyState ?? null)
      ) : (
        <CardGrid
          items={rows}
          minCardWidth={mobileRowMinWidth}
          fillStrategy="auto-fit"
          itemKey={(row) => getRowId(row)}
        >
          {(row, idx) => mobileRowRender(row, idx)}
        </CardGrid>
      )}
    </div>
  ) : null;

  // ── Desktop table (and default mobile via CSS toggle when no escape hatch) ──
  const tableEl = (
    <div
      data-slot="responsive-table"
      data-density={density}
      data-zebra-rows={density === "ops" ? "true" : undefined}
      className={cn(
        // .responsive-table is the CSS-toggle hook. When mobileRowRender is
        // provided, hide the table entirely on phone (mobileEscape takes over).
        mobileRowRender ? "hidden md:block" : "responsive-table",
        "min-w-0",
        className,
      )}
    >
      <div className="border rounded-lg overflow-x-auto">
        <Table aria-label={ariaLabel}>
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select all rows"
                    checked={rows.length > 0 && rows.every((r) => selectedIds?.has(getRowId(r)))}
                    onCheckedChange={toggleSelectAll}
                  />
                </TableHead>
              )}
              {rowExpand && <TableHead className="w-8" />}
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={cn(
                    col.hideBelow && HIDE_BELOW_CLASS[col.hideBelow],
                    col.align && ALIGN_CLASS[col.align],
                    col.headClassName,
                  )}
                >
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableSkeleton
                rowCount={loadingRowCount}
                columnCount={visibleColCount + (rowExpand ? 1 : 0)}
              />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={visibleColCount + (rowExpand ? 1 : 0)} className="p-0">
                  {emptyState ?? null}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, rowIdx) => {
                const id = getRowId(row);
                const isExpanded = expandedRowId === id;
                const isSelected = selectedIds?.has(id) ?? false;
                return (
                  <Fragment key={id}>
                    <TableRow
                      data-row-id={id}
                      data-selected={isSelected || undefined}
                      className={cn(rowExpand && "cursor-pointer")}
                      onClick={
                        rowExpand ? () => setExpandedRowId(isExpanded ? null : id) : undefined
                      }
                    >
                      {selectable && (
                        <TableCell
                          className="w-10"
                          onClick={(e) => e.stopPropagation()}
                          data-label="Select"
                        >
                          <Checkbox
                            aria-label={`Select row ${id}`}
                            checked={isSelected}
                            onCheckedChange={() => toggleSelectRow(id)}
                          />
                        </TableCell>
                      )}
                      {rowExpand && (
                        <TableCell className="w-8" data-label="Expand">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                      )}
                      {columns.map((col) => (
                        <TableCell
                          key={col.key}
                          // data-label drives the ::before pseudo-element
                          // injection on phone (CSS toggle).
                          data-label={col.label}
                          // data-primary marks the cell that becomes the
                          // card title (full-width, larger, no label prefix).
                          data-primary={col.primary || undefined}
                          // data-actions marks the actions cell that becomes
                          // the card footer.
                          data-actions={col.isActions || undefined}
                          className={cn(
                            col.hideBelow && HIDE_BELOW_CLASS[col.hideBelow],
                            col.align && ALIGN_CLASS[col.align],
                            col.mono && "font-mono text-xs",
                            col.cellClassName,
                          )}
                        >
                          {col.render
                            ? col.render(row, rowIdx)
                            : ((row as unknown as Record<string, ReactNode>)[col.key] ?? null)}
                        </TableCell>
                      ))}
                    </TableRow>
                    {isExpanded && rowExpand && (
                      <TableRow data-row-expand-of={id}>
                        <TableCell
                          // Spans every visible column (incl checkbox + expand
                          // chevron). Never hardcoded — computed from
                          // visibleColCount.
                          colSpan={visibleColCount + 1}
                          className="bg-muted/30 p-4 align-top"
                        >
                          {rowExpand(row)}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );

  return (
    <>
      {tableEl}
      {mobileEscape}
    </>
  );
}
