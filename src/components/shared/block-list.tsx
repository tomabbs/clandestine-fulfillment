"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/table-skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type BlockKey = string | number;

export interface BlockListActionRunnerState {
  pendingActions: ReadonlySet<string>;
  lastError: string | null;
}

export interface BlockListActionContext<TRow> extends BlockListActionRunnerState {
  row: TRow;
  rowKey: BlockKey;
  runAction: (actionName: string, action: () => Promise<unknown>) => Promise<void>;
}

export interface BlockListBulkRailContext {
  selectedCount: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  clearSelection: () => void;
  toggleSelectAllVisible: () => void;
}

export interface BlockListRowRenderContext<TRow> {
  row: TRow;
  rowKey: BlockKey;
  index: number;
  selectable: boolean;
  selected: boolean;
  expanded: boolean;
  toggleExpanded: () => void;
  actionContext: BlockListActionContext<TRow>;
}

export interface BlockListProps<TRow> {
  items: readonly TRow[];
  totalCount?: number;
  itemKey: (row: TRow, index: number) => BlockKey;
  renderHeader: (ctx: BlockListRowRenderContext<TRow>) => ReactNode;
  renderBody: (ctx: BlockListRowRenderContext<TRow>) => ReactNode;
  renderActions?: (ctx: BlockListRowRenderContext<TRow>) => ReactNode;
  renderExpanded?: (ctx: BlockListRowRenderContext<TRow>) => ReactNode;
  renderExceptionZone?: (ctx: BlockListRowRenderContext<TRow>) => ReactNode;

  selectable?: boolean;
  selectedKeys?: Set<BlockKey>;
  defaultSelectedKeys?: Iterable<BlockKey>;
  onSelectedKeysChange?: (keys: Set<BlockKey>) => void;

  expandedKeys?: Set<BlockKey>;
  defaultExpandedKeys?: Iterable<BlockKey>;
  onExpandedKeysChange?: (keys: Set<BlockKey>) => void;

  density?: "ops" | "standard";
  virtualizeThreshold?: number;
  virtualizationHeightClassName?: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
  footerNode?: ReactNode;
  bulkActionRail?: (ctx: BlockListBulkRailContext) => ReactNode;
  loading?: boolean;
  emptyState?: ReactNode;
  errorState?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

function createSet(keys?: Iterable<BlockKey>): Set<BlockKey> {
  return new Set(keys ?? []);
}

function useControllableSet(options: {
  controlled?: Set<BlockKey>;
  defaultValue?: Iterable<BlockKey>;
  onChange?: (next: Set<BlockKey>) => void;
}) {
  const { controlled, defaultValue, onChange } = options;
  const [internal, setInternal] = useState<Set<BlockKey>>(() => createSet(defaultValue));
  const isControlled = controlled !== undefined;
  const value = isControlled ? controlled : internal;

  const setValue = useCallback(
    (updater: (prev: Set<BlockKey>) => Set<BlockKey>) => {
      const next = updater(value);
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange, value],
  );

  return [value, setValue] as const;
}

export function BlockList<TRow>({
  items,
  totalCount,
  itemKey,
  renderHeader,
  renderBody,
  renderActions,
  renderExpanded,
  renderExceptionZone,
  selectable = false,
  selectedKeys,
  defaultSelectedKeys,
  onSelectedKeysChange,
  expandedKeys,
  defaultExpandedKeys,
  onExpandedKeysChange,
  density = "ops",
  virtualizeThreshold = 200,
  virtualizationHeightClassName = "max-h-[70vh]",
  hasMore = false,
  onLoadMore,
  footerNode,
  bulkActionRail,
  loading = false,
  emptyState,
  errorState,
  className,
  ariaLabel,
}: BlockListProps<TRow>) {
  const [selection, setSelection] = useControllableSet({
    controlled: selectedKeys,
    defaultValue: defaultSelectedKeys,
    onChange: onSelectedKeysChange,
  });
  const [expansion, setExpansion] = useControllableSet({
    controlled: expandedKeys,
    defaultValue: defaultExpandedKeys,
    onChange: onExpandedKeysChange,
  });
  const [pendingActionMap, setPendingActionMap] = useState<Record<string, Set<string>>>({});
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const anchorIndexRef = useRef<number | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const virtualizerParentRef = useRef<HTMLDivElement | null>(null);

  const keysByIndex = useMemo(
    () => items.map((row, index) => itemKey(row, index)),
    [items, itemKey],
  );

  const shouldVirtualize = !loading && items.length >= virtualizeThreshold;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => virtualizerParentRef.current,
    estimateSize: () => (density === "ops" ? 136 : 164),
    overscan: 8,
  });

  const total = totalCount ?? items.length;
  const allVisibleSelected =
    selectable && items.length > 0 && keysByIndex.every((key) => selection.has(key));
  const selectedCount = selection.size;

  const clearSelection = useCallback(() => {
    setSelection(() => new Set<BlockKey>());
  }, [setSelection]);

  const toggleSelectAllVisible = useCallback(() => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const key of keysByIndex) next.delete(key);
        return next;
      }
      for (const key of keysByIndex) next.add(key);
      return next;
    });
  }, [allVisibleSelected, keysByIndex, setSelection]);

  const setSelectionRange = useCallback(
    (fromIndex: number, toIndex: number, selected: boolean) => {
      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      setSelection((prev) => {
        const next = new Set(prev);
        for (let idx = start; idx <= end; idx += 1) {
          const key = keysByIndex[idx];
          if (key === undefined) continue;
          if (selected) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    },
    [keysByIndex, setSelection],
  );

  const toggleRowSelected = useCallback(
    (rowIndex: number, opts?: { shiftKey?: boolean }) => {
      const key = keysByIndex[rowIndex];
      if (key === undefined || !selectable) return;

      if (opts?.shiftKey && anchorIndexRef.current !== null) {
        const shouldSelect = !selection.has(key);
        setSelectionRange(anchorIndexRef.current, rowIndex, shouldSelect);
      } else {
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        anchorIndexRef.current = rowIndex;
      }
    },
    [keysByIndex, selectable, selection, setSelection, setSelectionRange],
  );

  const toggleRowExpanded = useCallback(
    (key: BlockKey) => {
      if (!renderExpanded) return;
      setExpansion((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [renderExpanded, setExpansion],
  );

  const runAction = useCallback(
    async (rowKey: BlockKey, actionName: string, action: () => Promise<unknown>) => {
      const rowKeyString = String(rowKey);
      setLastActionError(null);
      setPendingActionMap((prev) => {
        const pending = new Set(prev[rowKeyString] ?? []);
        pending.add(actionName);
        return { ...prev, [rowKeyString]: pending };
      });
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Action failed";
        setLastActionError(message);
      } finally {
        setPendingActionMap((prev) => {
          const pending = new Set(prev[rowKeyString] ?? []);
          pending.delete(actionName);
          return { ...prev, [rowKeyString]: pending };
        });
      }
    },
    [],
  );

  const defaultBulkRail = useMemo(() => {
    if (!selectable || selectedCount === 0) return null;
    return (
      <div className="sticky top-0 z-10 rounded-md border bg-background/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {selectedCount} selected of {total}
          </span>
          <Button size="sm" variant="outline" onClick={toggleSelectAllVisible}>
            {allVisibleSelected ? "Clear visible" : "Select visible"}
          </Button>
          <Button size="sm" variant="outline" onClick={clearSelection}>
            Clear all
          </Button>
        </div>
      </div>
    );
  }, [
    allVisibleSelected,
    clearSelection,
    selectable,
    selectedCount,
    toggleSelectAllVisible,
    total,
  ]);

  const resolvedBulkRail = useMemo(() => {
    if (selectedCount === 0) return null;
    if (bulkActionRail) {
      return bulkActionRail({
        selectedCount,
        visibleCount: items.length,
        allVisibleSelected,
        clearSelection,
        toggleSelectAllVisible,
      });
    }
    return defaultBulkRail;
  }, [
    allVisibleSelected,
    bulkActionRail,
    clearSelection,
    defaultBulkRail,
    items.length,
    selectedCount,
    toggleSelectAllVisible,
  ]);

  const renderRow = useCallback(
    (row: TRow, index: number, style?: CSSProperties) => {
      const rowKey = itemKey(row, index);
      const selected = selection.has(rowKey);
      const expanded = expansion.has(rowKey);
      const pendingActions = pendingActionMap[String(rowKey)] ?? new Set<string>();
      const context: BlockListRowRenderContext<TRow> = {
        row,
        rowKey,
        index,
        selectable,
        selected,
        expanded,
        toggleExpanded: () => toggleRowExpanded(rowKey),
        actionContext: {
          row,
          rowKey,
          pendingActions,
          lastError: lastActionError,
          runAction: async (actionName, action) => runAction(rowKey, actionName, action),
        },
      };

      const detailsId = `block-list-detail-${String(rowKey).replace(/\W+/g, "_")}`;

      return (
        <div
          ref={shouldVirtualize ? virtualizer.measureElement : undefined}
          data-block-index={index}
          data-slot="block-list-row"
          data-density={density}
          className={cn(
            "rounded-lg border bg-card",
            density === "ops" ? "p-3 md:p-3.5" : "p-4 md:p-5",
            selected && "ring-2 ring-brand/40 border-brand/50",
          )}
          style={style}
        >
          <div className="grid gap-3">
            <div className="flex items-start gap-3 min-w-0">
              {selectable && (
                <input
                  type="checkbox"
                  aria-label={`Select row ${rowKey}`}
                  checked={selected}
                  onChange={() => {}}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleRowSelected(index, { shiftKey: event.shiftKey });
                  }}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-input"
                />
              )}
              <div className="min-w-0 flex-1">{renderHeader(context)}</div>
              {renderActions && <div className="shrink-0">{renderActions(context)}</div>}
            </div>

            {renderExceptionZone && <div className="min-w-0">{renderExceptionZone(context)}</div>}
            <div className="min-w-0">{renderBody(context)}</div>

            {renderExpanded && (
              <div id={detailsId} className={cn("min-w-0", expanded ? "block" : "hidden")}>
                {renderExpanded(context)}
              </div>
            )}
          </div>
        </div>
      );
    },
    [
      density,
      expansion,
      itemKey,
      lastActionError,
      pendingActionMap,
      renderActions,
      renderBody,
      renderExceptionZone,
      renderExpanded,
      renderHeader,
      runAction,
      selectable,
      selection,
      shouldVirtualize,
      toggleRowExpanded,
      toggleRowSelected,
      virtualizer.measureElement,
    ],
  );

  if (loading) {
    return (
      <div className={cn("space-y-2", className)}>
        <TableSkeleton rowCount={Math.min(total || 8, 8)} columnCount={1} />
      </div>
    );
  }

  if (errorState) {
    return <div className={className}>{errorState}</div>;
  }

  if (items.length === 0) {
    return (
      <div className={className}>
        {emptyState ?? (
          <EmptyState title="No results" description="No records match the current filters." />
        )}
      </div>
    );
  }

  return (
    <section className={cn("min-w-0 space-y-3", className)} aria-label={ariaLabel}>
      {lastActionError && (
        <div className="rounded-md border border-red-300/60 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800/70 dark:bg-red-950/30 dark:text-red-200">
          <p className="flex items-center gap-1 font-medium">
            <AlertCircle className="h-4 w-4" />
            Action failed
          </p>
          <p className="mt-1 text-xs">{lastActionError}</p>
        </div>
      )}

      {resolvedBulkRail}

      <div aria-live="polite">
        {shouldVirtualize ? (
          <div
            ref={virtualizerParentRef}
            className={cn("overflow-y-auto min-w-0", virtualizationHeightClassName)}
          >
            <ul
              ref={listRef}
              aria-label={ariaLabel}
              className="relative min-w-0 m-0 list-none p-0"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => (
                <li
                  key={virtualItem.key}
                  className="absolute left-0 top-0 w-full list-none pb-3"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderRow(items[virtualItem.index], virtualItem.index)}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul ref={listRef} aria-label={ariaLabel} className="m-0 list-none space-y-3 p-0">
            {items.map((item, index) => (
              <li key={itemKey(item, index)} className="list-none">
                {renderRow(item, index)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {hasMore && onLoadMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}

      {footerNode}
    </section>
  );
}
