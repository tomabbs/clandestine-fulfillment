"use client";

/**
 * Phase 5 §9.6 D2 — /admin/settings/safety-stock
 *
 * Workspace for editing per-channel safety stock + preorder_whitelist.
 *
 * Layout:
 *   • Channel picker (Tabs) — storefront connections + internal channels
 *     (bandcamp, clandestine_shopify). Inline drift badge per storefront.
 *   • Toolbar — search, dirty-edit count, Save / Discard, Import CSV,
 *     Audit history.
 *   • Table — paginated, inline-editable safety_stock; storefront rows
 *     also show inline preorder_whitelist toggle (read-only here, edit
 *     via row drawer to capture a reason).
 *   • Row drawer (Sheet) — per-SKU edit panel: safety_stock numeric +
 *     preorder_whitelist switch + reason + per-SKU audit history.
 *   • CSV modal (Dialog) — textarea/file input → preview rows with
 *     create/update/delete/no-op classification → commit button.
 *   • Audit drawer (Sheet) — workspace-wide history filtered by channel
 *     + SKU.
 *
 * Data flow: every read is a Server Action via useAppQuery; every write
 * is a Server Action via useAppMutation. No direct Supabase calls from
 * the client.
 *
 * Per CLAUDE.md Rule #54 we keep Server Actions bounded — bulk save is
 * capped at SAFETY_STOCK_MAX_BULK_EDITS (200) and the UI splits
 * larger CSV imports client-side before calling the action.
 */

import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  History,
  Loader2,
  Save,
  Search,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type BulkEditResult,
  type ChannelTarget,
  type CsvPreviewResult,
  commitSafetyStockCsv,
  listSafetyStockAuditLog,
  listSafetyStockChannels,
  listSafetyStockEntries,
  previewSafetyStockCsv,
  type SafetyStockChannelSummary,
  type SafetyStockEdit,
  type SafetyStockEntry,
  updateSafetyStockBulk,
} from "@/actions/safety-stock";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import {
  type INTERNAL_SAFETY_STOCK_CHANNELS,
  SAFETY_STOCK_MAX_BULK_EDITS,
  SAFETY_STOCK_MAX_VALUE,
  SAFETY_STOCK_REASON_MAX_LENGTH,
} from "@/lib/shared/constants";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { WarehouseSafetyStockAuditLog } from "@/lib/shared/types";

// ─── Query keys (page-local) ─────────────────────────────────────────────────

const QK = {
  channels: ["safety-stock", "channels"] as const,
  entries: (pickerKey: string, page: number, search: string, onlyDirty: boolean) =>
    ["safety-stock", "entries", pickerKey, page, search, onlyDirty] as const,
  auditWorkspace: (page: number, sku: string, pickerKey: string | null) =>
    ["safety-stock", "audit", "workspace", page, sku, pickerKey] as const,
  auditPerSku: (sku: string, pickerKey: string) =>
    ["safety-stock", "audit", "sku", pickerKey, sku] as const,
};

const PAGE_SIZE = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickerKeyToTarget(pickerKey: string): ChannelTarget {
  const [kind, value] = pickerKey.split(":", 2);
  if (kind === "storefront") return { kind: "storefront", connectionId: value ?? "" };
  if (kind === "internal") {
    const channelName = value as (typeof INTERNAL_SAFETY_STOCK_CHANNELS)[number];
    return { kind: "internal", channelName };
  }
  throw new Error(`pickerKeyToTarget: unknown kind ${kind}`);
}

function fmtTimestamp(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.valueOf())) return ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function clampSafetyStockInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 0 || n > SAFETY_STOCK_MAX_VALUE) return null;
  return n;
}

// ─── Top-level page ──────────────────────────────────────────────────────────

export default function SafetyStockPage() {
  const channelsQuery = useAppQuery<SafetyStockChannelSummary[]>({
    queryKey: QK.channels,
    queryFn: () => listSafetyStockChannels({}),
    tier: CACHE_TIERS.SESSION,
  });

  const channels = channelsQuery.data ?? [];
  const [pickerKey, setPickerKey] = useState<string | null>(null);

  // Auto-select first available channel once they load.
  useEffect(() => {
    if (!pickerKey && channels.length > 0 && channels[0]) {
      setPickerKey(channels[0].pickerKey);
    }
  }, [pickerKey, channels]);

  const activeChannel = useMemo(
    () => channels.find((c) => c.pickerKey === pickerKey) ?? null,
    [channels, pickerKey],
  );

  const [csvOpen, setCsvOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);

  return (
    <PageShell
      title="Safety Stock"
      description="Reserve buffer per channel before pushing inventory upstream. Edits are audited."
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAuditOpen(true)}
            disabled={channels.length === 0}
          >
            <History className="mr-1 h-4 w-4" />
            Audit history
          </Button>
          <Button size="sm" onClick={() => setCsvOpen(true)} disabled={!activeChannel}>
            <Upload className="mr-1 h-4 w-4" />
            Import CSV
          </Button>
        </>
      }
    >
      {channelsQuery.isLoading ? (
        <ChannelPickerSkeleton />
      ) : channels.length === 0 ? (
        <EmptyState
          title="No channels available"
          description="Connect a storefront under Settings → Store Connections, or sync at least one Bandcamp/Shopify product to start configuring safety stock."
        />
      ) : (
        <>
          <ChannelPicker channels={channels} activeKey={pickerKey} onSelect={setPickerKey} />

          {activeChannel && (
            <ChannelEditor
              channel={activeChannel}
              onOpenCsv={() => setCsvOpen(true)}
              onOpenAudit={() => setAuditOpen(true)}
            />
          )}
        </>
      )}

      {activeChannel && (
        <CsvImportDialog open={csvOpen} onOpenChange={setCsvOpen} channel={activeChannel} />
      )}

      <AuditDrawer
        open={auditOpen}
        onOpenChange={setAuditOpen}
        channels={channels}
        defaultPickerKey={pickerKey}
      />
    </PageShell>
  );
}

// ─── Channel picker ──────────────────────────────────────────────────────────

function ChannelPickerSkeleton() {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {[1, 2, 3].map((k) => (
        <Skeleton key={k} className="h-16 w-44 shrink-0 rounded-md" />
      ))}
    </div>
  );
}

function ChannelPicker({
  channels,
  activeKey,
  onSelect,
}: {
  channels: SafetyStockChannelSummary[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
      {channels.map((c) => {
        const isActive = c.pickerKey === activeKey;
        return (
          <button
            type="button"
            key={c.pickerKey}
            onClick={() => onSelect(c.pickerKey)}
            className={`shrink-0 rounded-md border px-3 py-2 text-left transition-colors min-w-[180px] ${
              isActive
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border bg-card hover:border-primary/50 hover:bg-accent/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{c.label}</span>
              {c.kind === "storefront" && c.connectionStatus !== "active" && (
                <Badge variant="outline" className="text-[10px] uppercase">
                  {c.connectionStatus}
                </Badge>
              )}
            </div>
            {c.subtitle && (
              <div className="text-xs text-muted-foreground truncate">{c.subtitle}</div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Badge variant="secondary" className="text-[10px]">
                {c.rowsWithSafetyStock} reserved
              </Badge>
              {c.kind === "storefront" && c.policyDriftCount > 0 && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-amber-500 text-amber-600"
                  title="SKUs with Shopify inventoryPolicy=CONTINUE that aren't whitelisted as preorders"
                >
                  <AlertTriangle className="h-3 w-3 mr-0.5" />
                  {c.policyDriftCount} drift
                </Badge>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Channel editor (toolbar + table + drawer) ───────────────────────────────

interface PendingEdit {
  sku: string;
  newSafetyStock: number;
  prevSafetyStock: number;
}

function ChannelEditor({
  channel,
  onOpenCsv: _onOpenCsv,
  onOpenAudit: _onOpenAudit,
}: {
  channel: SafetyStockChannelSummary;
  onOpenCsv: () => void;
  onOpenAudit: () => void;
}) {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [onlyDirty, setOnlyDirty] = useState(false);
  const [pendingEdits, setPendingEdits] = useState<Map<string, PendingEdit>>(new Map());
  const [drawerSku, setDrawerSku] = useState<string | null>(null);

  // Reset state when switching channels.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on channel change
  useEffect(() => {
    setPage(1);
    setSearch("");
    setSearchInput("");
    setOnlyDirty(false);
    setPendingEdits(new Map());
    setDrawerSku(null);
  }, [channel.pickerKey]);

  // Debounce search input → search.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const target = useMemo(() => pickerKeyToTarget(channel.pickerKey), [channel.pickerKey]);

  const entriesQuery = useAppQuery<{
    entries: SafetyStockEntry[];
    total: number;
    page: number;
    pageSize: number;
  }>({
    queryKey: QK.entries(channel.pickerKey, page, search, onlyDirty),
    queryFn: () =>
      listSafetyStockEntries({
        channel: target,
        page,
        pageSize: PAGE_SIZE,
        search: search || undefined,
        onlyWithSafetyStock: onlyDirty || undefined,
      }),
    tier: CACHE_TIERS.SESSION,
  });

  const saveMutation = useAppMutation<
    BulkEditResult,
    Error,
    { edits: SafetyStockEdit[]; reason?: string }
  >({
    mutationFn: ({ edits, reason }) =>
      updateSafetyStockBulk({
        channel: target,
        edits,
        reason,
        source: "ui_bulk",
      }),
    invalidateKeys: [
      ["safety-stock", "channels"],
      ["safety-stock", "entries", channel.pickerKey],
      ["safety-stock", "audit"],
    ],
    onSuccess: (res) => {
      const parts = [
        res.applied > 0 && `${res.applied} applied`,
        res.skippedNoChange > 0 && `${res.skippedNoChange} no-op`,
        res.errors > 0 && `${res.errors} error${res.errors === 1 ? "" : "s"}`,
      ].filter(Boolean);
      toast[res.errors > 0 ? "warning" : "success"](
        `Safety stock saved — ${parts.join(", ") || "no changes"}`,
      );
      if (res.errors === 0) {
        setPendingEdits(new Map());
      } else {
        // Drop only the rows that succeeded; keep failed rows so the operator can retry.
        setPendingEdits((prev) => {
          const next = new Map(prev);
          for (const o of res.outcomes) {
            if (o.status === "applied" || o.status === "skipped_no_change") {
              next.delete(o.sku);
            }
          }
          return next;
        });
      }
    },
    onError: (err) => toast.error(`Save failed — ${err.message}`),
  });

  const stagedEdits = Array.from(pendingEdits.values());
  const dirtyCount = stagedEdits.filter((e) => e.newSafetyStock !== e.prevSafetyStock).length;

  function applyInlineEdit(sku: string, prev: number, next: number) {
    setPendingEdits((m) => {
      const copy = new Map(m);
      if (next === prev) {
        copy.delete(sku);
      } else {
        copy.set(sku, { sku, newSafetyStock: next, prevSafetyStock: prev });
      }
      return copy;
    });
  }

  function discardAll() {
    setPendingEdits(new Map());
    toast.info("Discarded pending edits");
  }

  function saveAll() {
    if (dirtyCount === 0) {
      toast.info("No changes to save");
      return;
    }
    if (dirtyCount > SAFETY_STOCK_MAX_BULK_EDITS) {
      toast.error(
        `Too many changes (${dirtyCount}). Max ${SAFETY_STOCK_MAX_BULK_EDITS} per save — please apply in batches.`,
      );
      return;
    }
    const edits: SafetyStockEdit[] = stagedEdits
      .filter((e) => e.newSafetyStock !== e.prevSafetyStock)
      .map((e) => ({ sku: e.sku, newSafetyStock: e.newSafetyStock }));
    saveMutation.mutate({ edits });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search SKU or product…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
        <Button
          variant={onlyDirty ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setOnlyDirty((v) => !v);
            setPage(1);
          }}
        >
          Only with safety stock
        </Button>
        <div className="flex-1" />
        {dirtyCount > 0 && (
          <>
            <Badge variant="secondary" className="text-xs">
              {dirtyCount} pending
            </Badge>
            <Button variant="outline" size="sm" onClick={discardAll}>
              <Undo2 className="mr-1 h-4 w-4" />
              Discard
            </Button>
          </>
        )}
        <Button size="sm" onClick={saveAll} disabled={dirtyCount === 0 || saveMutation.isPending}>
          {saveMutation.isPending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-1 h-4 w-4" />
          )}
          Save {dirtyCount > 0 ? `(${dirtyCount})` : ""}
        </Button>
      </div>

      <EntriesTable
        channel={channel}
        query={entriesQuery}
        pendingEdits={pendingEdits}
        onInlineEdit={applyInlineEdit}
        onOpenRow={setDrawerSku}
      />

      <PaginationBar
        page={page}
        pageSize={PAGE_SIZE}
        total={entriesQuery.data?.total ?? 0}
        onChange={setPage}
        loading={entriesQuery.isFetching}
      />

      {drawerSku && (
        <RowDrawer
          channel={channel}
          target={target}
          sku={drawerSku}
          entry={entriesQuery.data?.entries.find((e) => e.sku === drawerSku) ?? null}
          pendingNewValue={pendingEdits.get(drawerSku)?.newSafetyStock ?? null}
          onClose={() => setDrawerSku(null)}
        />
      )}
    </>
  );
}

// ─── Entries table ───────────────────────────────────────────────────────────

function EntriesTable({
  channel,
  query,
  pendingEdits,
  onInlineEdit,
  onOpenRow,
}: {
  channel: SafetyStockChannelSummary;
  query: ReturnType<
    typeof useAppQuery<{
      entries: SafetyStockEntry[];
      total: number;
      page: number;
      pageSize: number;
    }>
  >;
  pendingEdits: Map<string, PendingEdit>;
  onInlineEdit: (sku: string, prev: number, next: number) => void;
  onOpenRow: (sku: string) => void;
}) {
  const isStorefront = channel.kind === "storefront";

  if (query.isLoading) {
    return (
      <div className="border rounded-md">
        <div className="space-y-2 p-4">
          {[1, 2, 3, 4, 5].map((k) => (
            <Skeleton key={k} className="h-9 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="border border-destructive/50 rounded-md p-4 text-sm text-destructive">
        Failed to load entries: {(query.error as Error).message}
      </div>
    );
  }

  const entries = query.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <EmptyState
        title="No SKUs found"
        description="Try clearing your search or toggling 'Only with safety stock'."
      />
    );
  }

  return (
    <div className="border rounded-md overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px]">SKU</TableHead>
            <TableHead>Product</TableHead>
            <TableHead className="text-right w-[90px]">Available</TableHead>
            <TableHead className="text-right w-[120px]">Safety stock</TableHead>
            {isStorefront && <TableHead className="w-[110px]">Preorder</TableHead>}
            {isStorefront && <TableHead className="w-[120px]">Policy</TableHead>}
            <TableHead className="w-[140px]">Last edit</TableHead>
            <TableHead className="w-[60px] text-right">{""}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e) => {
            const pending = pendingEdits.get(e.sku);
            const currentValue = pending?.newSafetyStock ?? e.safetyStock;
            const isDirty = pending && pending.newSafetyStock !== pending.prevSafetyStock;
            const isPolicyDrift =
              isStorefront && e.lastInventoryPolicy === "CONTINUE" && e.preorderWhitelist === false;

            return (
              <TableRow key={e.sku} className={isDirty ? "bg-amber-50/40" : undefined}>
                <TableCell className="font-mono text-xs">{e.sku}</TableCell>
                <TableCell className="text-sm truncate max-w-[280px]" title={e.productTitle ?? ""}>
                  {e.productTitle ?? <span className="text-muted-foreground italic">untitled</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{e.available}</TableCell>
                <TableCell className="text-right">
                  <SafetyStockInput
                    value={currentValue}
                    isDirty={!!isDirty}
                    onCommit={(next) => onInlineEdit(e.sku, e.safetyStock, next)}
                  />
                </TableCell>
                {isStorefront && (
                  <TableCell>
                    {e.preorderWhitelist ? (
                      <Badge variant="outline" className="text-[10px]">
                        whitelisted
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                {isStorefront && (
                  <TableCell>
                    {e.lastInventoryPolicy ? (
                      isPolicyDrift ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] border-amber-500 text-amber-700"
                          title="Shopify is set to CONTINUE but this SKU isn't whitelisted as a preorder"
                        >
                          <AlertTriangle className="h-3 w-3 mr-0.5" />
                          {e.lastInventoryPolicy}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {e.lastInventoryPolicy}
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground">never audited</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="text-xs text-muted-foreground">
                  {fmtTimestamp(e.lastSafetyEditAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => onOpenRow(e.sku)}>
                    Open
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function SafetyStockInput({
  value,
  isDirty,
  onCommit,
}: {
  value: number;
  isDirty: boolean;
  onCommit: (next: number) => void;
}) {
  const [local, setLocal] = useState(String(value));

  useEffect(() => {
    setLocal(String(value));
  }, [value]);

  function stageIfValid(raw: string) {
    const n = clampSafetyStockInput(raw);
    if (n !== null && n !== value) {
      onCommit(n);
    }
  }

  function commit() {
    const n = clampSafetyStockInput(local);
    if (n === null) {
      // Invalid — revert.
      setLocal(String(value));
      toast.error(`Safety stock must be 0–${SAFETY_STOCK_MAX_VALUE}`);
      return;
    }
    setLocal(String(n));
    if (n !== value) onCommit(n);
  }

  return (
    <Input
      value={local}
      onChange={(e) => {
        const next = e.target.value;
        setLocal(next);
        // Stage valid edits immediately so the page-level Save button
        // reflects dirty state even before the field blurs.
        stageIfValid(next);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setLocal(String(value));
          e.currentTarget.blur();
        }
      }}
      className={`h-8 text-right tabular-nums w-20 ml-auto ${
        isDirty ? "border-amber-500 ring-1 ring-amber-200" : ""
      }`}
      inputMode="numeric"
    />
  );
}

function PaginationBar({
  page,
  pageSize,
  total,
  onChange,
  loading,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (next: number) => void;
  loading: boolean;
}) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>
        {loading
          ? "Loading…"
          : total === 0
            ? "0 results"
            : `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page <= 1 || loading}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-2 tabular-nums">
          {page} / {last}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(Math.min(last, page + 1))}
          disabled={page >= last || loading}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Row drawer (per-SKU detail) ─────────────────────────────────────────────

function RowDrawer({
  channel,
  target,
  sku,
  entry,
  pendingNewValue,
  onClose,
}: {
  channel: SafetyStockChannelSummary;
  target: ChannelTarget;
  sku: string;
  entry: SafetyStockEntry | null;
  pendingNewValue: number | null;
  onClose: () => void;
}) {
  const isStorefront = channel.kind === "storefront";
  const initialValue = pendingNewValue ?? entry?.safetyStock ?? 0;
  const [val, setVal] = useState(String(initialValue));
  const [whitelist, setWhitelist] = useState<boolean>(entry?.preorderWhitelist ?? false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    setVal(String(pendingNewValue ?? entry?.safetyStock ?? 0));
    setWhitelist(entry?.preorderWhitelist ?? false);
    setReason("");
  }, [pendingNewValue, entry]);

  const auditQuery = useAppQuery<{
    entries: WarehouseSafetyStockAuditLog[];
    total: number;
  }>({
    queryKey: QK.auditPerSku(sku, channel.pickerKey),
    queryFn: () =>
      listSafetyStockAuditLog({
        sku,
        channelKind: channel.kind,
        connectionId: channel.connectionId ?? undefined,
        channelName:
          (channel.channelName as (typeof INTERNAL_SAFETY_STOCK_CHANNELS)[number] | null) ??
          undefined,
        page: 1,
        pageSize: 25,
      }),
    tier: CACHE_TIERS.REALTIME,
  });

  const saveMutation = useAppMutation<BulkEditResult, Error, void>({
    mutationFn: () => {
      const n = clampSafetyStockInput(val);
      if (n === null) {
        throw new Error(`Safety stock must be 0–${SAFETY_STOCK_MAX_VALUE}`);
      }
      const edit: SafetyStockEdit = { sku, newSafetyStock: n };
      if (isStorefront) {
        edit.newPreorderWhitelist = whitelist;
      }
      return updateSafetyStockBulk({
        channel: target,
        edits: [edit],
        reason: reason.trim() || undefined,
        source: "ui_inline",
      });
    },
    invalidateKeys: [
      ["safety-stock", "channels"],
      ["safety-stock", "entries", channel.pickerKey],
      ["safety-stock", "audit"],
    ],
    onSuccess: (res) => {
      const o = res.outcomes[0];
      if (o?.status === "error") {
        toast.error(`Save failed — ${o.error}`);
        return;
      }
      toast.success(o?.status === "skipped_no_change" ? "No changes" : "Saved");
      onClose();
    },
    onError: (err) => toast.error(`Save failed — ${err.message}`),
  });

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle className="font-mono text-base break-all">{sku}</SheetTitle>
          <SheetDescription>
            {entry?.productTitle ?? "Untitled product"} · {channel.label}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto space-y-4 px-4 py-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Stat label="Available" value={entry?.available ?? 0} />
            <Stat label="Saved safety stock" value={entry?.safetyStock ?? 0} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="row-safety-stock" className="text-xs uppercase tracking-wide">
              Safety stock
            </Label>
            <Input
              id="row-safety-stock"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              inputMode="numeric"
              className="tabular-nums"
            />
            <p className="text-[11px] text-muted-foreground">
              Range 0–{SAFETY_STOCK_MAX_VALUE.toLocaleString()}. Reduces effective sellable on this
              channel.
            </p>
          </div>

          {isStorefront && (
            <div className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="space-y-0.5 min-w-0">
                <Label htmlFor="row-preorder" className="text-sm">
                  Preorder whitelist
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Exempts this SKU from the daily Shopify policy audit (allows
                  inventoryPolicy=CONTINUE on legitimate preorders).
                </p>
              </div>
              <Switch id="row-preorder" checked={whitelist} onCheckedChange={setWhitelist} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="row-reason" className="text-xs uppercase tracking-wide">
              Reason (optional)
            </Label>
            <Textarea
              id="row-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={SAFETY_STOCK_REASON_MAX_LENGTH}
              rows={2}
              placeholder="Why are you changing this? (recorded in audit log)"
            />
            <p className="text-[10px] text-muted-foreground text-right">
              {reason.length} / {SAFETY_STOCK_REASON_MAX_LENGTH}
            </p>
          </div>

          <div className="space-y-2 pt-2 border-t">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <ClipboardList className="h-3.5 w-3.5" />
              Audit history
            </h3>
            <AuditList
              loading={auditQuery.isLoading}
              entries={auditQuery.data?.entries ?? []}
              compact
            />
          </div>
        </div>

        <div className="border-t px-4 py-3 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="mr-1 h-4 w-4" />
            Cancel
          </Button>
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            Save row
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border bg-muted/30 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

// ─── CSV import dialog ───────────────────────────────────────────────────────

function CsvImportDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: SafetyStockChannelSummary;
}) {
  const [csv, setCsv] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<CsvPreviewResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const target = useMemo(() => pickerKeyToTarget(channel.pickerKey), [channel.pickerKey]);

  // Reset dialog state when reopening or switching channels.
  useEffect(() => {
    if (!open) {
      setCsv("");
      setReason("");
      setPreview(null);
    }
  }, [open]);

  const previewMutation = useAppMutation<CsvPreviewResult, Error, void>({
    mutationFn: () => previewSafetyStockCsv({ channel: target, csv }),
    onSuccess: (res) => setPreview(res),
    onError: (err) => toast.error(`Preview failed — ${err.message}`),
  });

  const commitMutation = useAppMutation<BulkEditResult, Error, void>({
    mutationFn: () => {
      if (!preview) throw new Error("No preview yet");
      const edits: SafetyStockEdit[] = preview.rows
        .filter(
          (r) =>
            r.changeKind === "create" || r.changeKind === "update" || r.changeKind === "delete",
        )
        .map((r) => {
          const e: SafetyStockEdit = { sku: r.sku, newSafetyStock: r.newSafetyStock };
          if (channel.kind === "storefront" && r.newPreorderWhitelist !== null) {
            e.newPreorderWhitelist = r.newPreorderWhitelist;
          }
          return e;
        });
      if (edits.length === 0) throw new Error("Nothing to commit (all rows are no-op or error)");
      if (edits.length > SAFETY_STOCK_MAX_BULK_EDITS) {
        throw new Error(
          `Too many edits (${edits.length}). Max ${SAFETY_STOCK_MAX_BULK_EDITS} per import — please split the file.`,
        );
      }
      return commitSafetyStockCsv({
        channel: target,
        edits,
        reason: reason.trim() || undefined,
      });
    },
    invalidateKeys: [
      ["safety-stock", "channels"],
      ["safety-stock", "entries", channel.pickerKey],
      ["safety-stock", "audit"],
    ],
    onSuccess: (res) => {
      const parts = [
        res.applied > 0 && `${res.applied} applied`,
        res.skippedNoChange > 0 && `${res.skippedNoChange} no-op`,
        res.errors > 0 && `${res.errors} error${res.errors === 1 ? "" : "s"}`,
      ].filter(Boolean);
      toast[res.errors > 0 ? "warning" : "success"](
        `CSV import — ${parts.join(", ") || "no changes"}`,
      );
      if (res.errors === 0) {
        onOpenChange(false);
      }
    },
    onError: (err) => toast.error(`Import failed — ${err.message}`),
  });

  function handleFile(file: File) {
    file.text().then((text) => {
      setCsv(text);
      setPreview(null);
    });
  }

  const cssBySummary = (n: number, color: string) =>
    n > 0 ? `text-${color}-600 font-semibold` : "text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import safety stock — {channel.label}</DialogTitle>
          <DialogDescription>
            Header row required: <code>sku,safety_stock</code>
            {channel.kind === "storefront" && (
              <>
                {" "}
                or <code>sku,safety_stock,preorder_whitelist</code>
              </>
            )}
            . Max {SAFETY_STOCK_MAX_BULK_EDITS} rows per import.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              Choose file…
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            <span className="text-xs text-muted-foreground">or paste CSV below</span>
          </div>

          <Textarea
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(null);
            }}
            placeholder={`sku,safety_stock\nLP-001,5\nCD-002,0`}
            className="font-mono text-xs h-32"
          />

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => previewMutation.mutate()}
              disabled={!csv.trim() || previewMutation.isPending}
            >
              {previewMutation.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Preview
            </Button>
            {preview && (
              <div className="flex items-center gap-3 text-xs">
                <span className={cssBySummary(preview.summary.create, "emerald")}>
                  +{preview.summary.create} create
                </span>
                <span className={cssBySummary(preview.summary.update, "blue")}>
                  ~{preview.summary.update} update
                </span>
                <span className={cssBySummary(preview.summary.delete, "rose")}>
                  −{preview.summary.delete} delete
                </span>
                <span className="text-muted-foreground">{preview.summary.noChange} no-op</span>
                <span className={cssBySummary(preview.summary.error, "amber")}>
                  {preview.summary.error} error
                </span>
              </div>
            )}
          </div>

          {preview && preview.rows.length > 0 && (
            <div className="border rounded-md">
              <ScrollArea className="h-64">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[160px]">SKU</TableHead>
                      <TableHead className="text-right w-[80px]">Now</TableHead>
                      <TableHead className="text-right w-[80px]">→ New</TableHead>
                      <TableHead className="w-[110px]">Action</TableHead>
                      <TableHead>Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((r, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: CSV preview rows are read-only and ordering is stable; SKU alone isn't unique because the same SKU can legitimately appear on multiple lines (operator typo) and we want to surface every row.
                      <TableRow key={`${r.sku}-${i}`}>
                        <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {r.currentSafetyStock ?? "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {r.newSafetyStock}
                        </TableCell>
                        <TableCell>
                          <ChangeKindBadge kind={r.changeKind} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.error ??
                            (r.newPreorderWhitelist !== null
                              ? `whitelist=${r.newPreorderWhitelist}`
                              : "")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="csv-reason" className="text-xs uppercase tracking-wide">
              Reason (optional)
            </Label>
            <Input
              id="csv-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={SAFETY_STOCK_REASON_MAX_LENGTH}
              placeholder="e.g. quarterly preorder reservation refresh"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => commitMutation.mutate()}
            disabled={!preview || commitMutation.isPending}
          >
            {commitMutation.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-1 h-4 w-4" />
            )}
            Commit changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeKindBadge({
  kind,
}: {
  kind: "create" | "update" | "delete" | "no_change" | "error";
}) {
  const map = {
    create: { label: "create", cls: "border-emerald-500 text-emerald-700" },
    update: { label: "update", cls: "border-blue-500 text-blue-700" },
    delete: { label: "delete", cls: "border-rose-500 text-rose-700" },
    no_change: { label: "no-op", cls: "text-muted-foreground" },
    error: { label: "error", cls: "border-amber-500 text-amber-700" },
  } as const;
  const c = map[kind];
  return (
    <Badge variant="outline" className={`text-[10px] ${c.cls}`}>
      {c.label}
    </Badge>
  );
}

// ─── Audit drawer ────────────────────────────────────────────────────────────

function AuditDrawer({
  open,
  onOpenChange,
  channels,
  defaultPickerKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: SafetyStockChannelSummary[];
  defaultPickerKey: string | null;
}) {
  const [pickerKey, setPickerKey] = useState<string | null>(defaultPickerKey);
  const [skuFilter, setSkuFilter] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (open) {
      setPickerKey(defaultPickerKey);
      setSkuFilter("");
      setPage(1);
    }
  }, [open, defaultPickerKey]);

  const filterChannel = pickerKey ? channels.find((c) => c.pickerKey === pickerKey) : null;

  const auditQuery = useAppQuery<{
    entries: WarehouseSafetyStockAuditLog[];
    total: number;
  }>({
    queryKey: QK.auditWorkspace(page, skuFilter, pickerKey),
    queryFn: () =>
      listSafetyStockAuditLog({
        page,
        pageSize: 50,
        channelKind: filterChannel?.kind,
        connectionId: filterChannel?.connectionId ?? undefined,
        channelName:
          (filterChannel?.channelName as (typeof INTERNAL_SAFETY_STOCK_CHANNELS)[number] | null) ??
          undefined,
        sku: skuFilter.trim() || undefined,
      }),
    tier: CACHE_TIERS.REALTIME,
    enabled: open,
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col">
        <SheetHeader>
          <SheetTitle>Safety stock audit log</SheetTitle>
          <SheetDescription>Every edit through this workspace, newest first.</SheetDescription>
        </SheetHeader>

        <div className="px-4 py-2 space-y-2 border-b">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={pickerKey ?? ""}
              onChange={(e) => {
                setPickerKey(e.target.value || null);
                setPage(1);
              }}
              className="h-9 rounded-md border bg-background px-2 text-sm flex-1 min-w-[160px]"
            >
              <option value="">All channels</option>
              {channels.map((c) => (
                <option key={c.pickerKey} value={c.pickerKey}>
                  {c.label}
                </option>
              ))}
            </select>
            <Input
              placeholder="Filter by SKU…"
              value={skuFilter}
              onChange={(e) => {
                setSkuFilter(e.target.value);
                setPage(1);
              }}
              className="h-9 flex-1 min-w-[140px]"
            />
          </div>
          <PaginationBar
            page={page}
            pageSize={50}
            total={auditQuery.data?.total ?? 0}
            onChange={setPage}
            loading={auditQuery.isFetching}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          <AuditList
            loading={auditQuery.isLoading}
            entries={auditQuery.data?.entries ?? []}
            compact={false}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AuditList({
  loading,
  entries,
  compact,
}: {
  loading: boolean;
  entries: WarehouseSafetyStockAuditLog[];
  compact: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No audit entries.</p>;
  }
  return (
    <ul className="space-y-2">
      {entries.map((a) => {
        const channelLabel =
          a.channel_kind === "internal" ? (a.channel_name ?? "internal") : "storefront";
        const fromTo = `${a.prev_safety_stock ?? "—"} → ${a.new_safety_stock}`;
        return (
          <li key={a.id} className="rounded border p-2 text-xs space-y-1 bg-card">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono break-all">{a.sku}</span>
              <span className="text-muted-foreground tabular-nums">
                {fmtTimestamp(a.changed_at)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-[10px]">
                {channelLabel}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {a.source}
              </Badge>
              <span className="tabular-nums">safety: {fromTo}</span>
              {a.prev_preorder_whitelist !== a.new_preorder_whitelist &&
                a.new_preorder_whitelist !== null && (
                  <span>preorder: {String(a.new_preorder_whitelist)}</span>
                )}
            </div>
            {!compact && a.reason && (
              <p className="text-muted-foreground italic break-words">{a.reason}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
