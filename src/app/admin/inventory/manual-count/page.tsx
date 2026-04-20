"use client";

/**
 * Saturday Workstream 2 (2026-04-18) — manual inventory count entry UI.
 *
 * Bulk table editor scoped per-client. Staff:
 *   1. Pick a client.
 *   2. (Optional) search SKU / product title.
 *   3. Edit "New count" inline. Dirty rows pulse with a delta preview chip.
 *   4. "Save changes" submits the batch via submitManualInventoryCounts.
 *   5. If any row returns requires_confirm, a confirm dialog summarizes the
 *      gates that fired and re-submits with force:true on operator approval.
 *   6. blocked_negative rows surface a high-severity review-queue toast with
 *      a deep-link to /admin/review-queue.
 *
 * Per CLAUDE.md Rule #41 we use the page's route segment to bump maxDuration
 * for the rare case of a 200-row batch. The Server Action remains bounded by
 * MAX_ENTRIES_PER_BATCH=200 (about 200ms per row including ShipStation v2
 * enqueue, comfortably under 60s).
 *
 * Per Rule #51 (frozen layout): we ADD a sub-route under /admin/inventory; we
 * do NOT modify the sidebar layout component itself, only its NAV/SETTINGS
 * arrays (which are local state inside the file, not shared layout primitives).
 */

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Save, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type EntryResult,
  getManualCountTable,
  type ManualCountRow,
  submitManualInventoryCounts,
} from "@/actions/manual-inventory-count";
import { getOrganizations } from "@/actions/organizations";
import { BlockList } from "@/components/shared/block-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export const maxDuration = 60;

/** SKU → newCount string (empty/undefined means "leave alone"). */
type DirtyMap = Record<string, string>;

interface ConfirmEntry {
  sku: string;
  newAvailable: number;
  reason: string;
  previousAvailable: number;
}

export default function ManualCountPage() {
  const queryClient = useQueryClient();
  const [orgId, setOrgId] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [dirty, setDirty] = useState<DirtyMap>({});
  const [confirmEntries, setConfirmEntries] = useState<ConfirmEntry[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const orgsQuery = useAppQuery({
    queryKey: ["admin", "manual-count", "orgs"],
    queryFn: () => getOrganizations(),
    tier: CACHE_TIERS.STABLE,
  });

  const tableQuery = useAppQuery({
    queryKey: ["admin", "manual-count", "table", orgId, search],
    queryFn: () =>
      getManualCountTable({ orgId, search: search.trim() || undefined, pageSize: 500 }),
    enabled: !!orgId,
    tier: CACHE_TIERS.REALTIME,
  });

  const submitMutation = useAppMutation({
    mutationFn: async (payload: Array<{ sku: string; newAvailable: number; force?: boolean }>) =>
      submitManualInventoryCounts({ orgId, entries: payload }),
    onSuccess: (result) => {
      handleSubmitResult(result);
      queryClient.invalidateQueries({ queryKey: ["admin", "manual-count", "table"] });
    },
    onError: (err) => {
      toast.error(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  const dirtyEntries = useMemo(() => {
    return Object.entries(dirty)
      .map(([sku, raw]) => {
        const trimmed = raw.trim();
        if (trimmed === "") return null;
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isNaN(parsed) || parsed < 0) return null;
        return { sku, newAvailable: parsed };
      })
      .filter((e): e is { sku: string; newAvailable: number } => e !== null);
  }, [dirty]);

  function handleSubmitResult(result: Awaited<ReturnType<typeof submitManualInventoryCounts>>) {
    const requiresConfirm = result.results.filter((r) => r.status === "requires_confirm");
    const blocked = result.results.filter((r) => r.status === "blocked_negative");

    if (requiresConfirm.length > 0) {
      setConfirmEntries(
        requiresConfirm.map((r) => ({
          sku: r.sku,
          newAvailable: r.newAvailable ?? 0,
          reason: r.reason ?? "unknown",
          previousAvailable: r.previousAvailable ?? 0,
        })),
      );
      setConfirmOpen(true);
    }

    if (result.appliedCount > 0) {
      toast.success(`Applied ${result.appliedCount} count update(s).`);
      setDirty((d) => clearAppliedFromDirty(d, result.results));
    }
    if (blocked.length > 0) {
      toast.error(
        `${blocked.length} row(s) blocked (would land negative). Review queue items created.`,
        {
          action: {
            label: "Open review queue",
            onClick: () => {
              window.location.href = "/admin/review-queue";
            },
          },
        },
      );
    }
    if (result.unknownCount > 0) {
      toast.warning(`${result.unknownCount} unknown SKU(s) skipped.`);
    }
    if (result.errorCount > 0) {
      toast.error(`${result.errorCount} row(s) errored. Check console.`);
    }
  }

  function handleSubmit() {
    if (dirtyEntries.length === 0) {
      toast.info("No changes to submit.");
      return;
    }
    submitMutation.mutate(dirtyEntries);
  }

  function handleConfirmAll() {
    submitMutation.mutate(
      confirmEntries.map((e) => ({ sku: e.sku, newAvailable: e.newAvailable, force: true })),
    );
    setConfirmEntries([]);
    setConfirmOpen(false);
  }

  function handleConfirmCancel() {
    setConfirmEntries([]);
    setConfirmOpen(false);
  }

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Manual count entry</h1>
          <p className="text-sm text-muted-foreground">
            Live on-hand counts. Pushes immediately to Bandcamp and ShipStation v2 (respects
            fanout-guard rollout). Negative results are hard-blocked.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/inventory"
            className="text-sm text-muted-foreground hover:text-foreground underline"
          >
            Back to inventory
          </Link>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
        <div className="space-y-1 min-w-[260px]">
          <span className="text-xs text-muted-foreground">Client</span>
          <Select value={orgId} onValueChange={(v) => setOrgId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a client" />
            </SelectTrigger>
            <SelectContent>
              {(orgsQuery.data ?? []).map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 flex-1">
          <span className="text-xs text-muted-foreground">Search SKU or title</span>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter rows…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              disabled={!orgId}
            />
          </div>
        </div>

        <Button
          onClick={handleSubmit}
          disabled={submitMutation.isPending || dirtyEntries.length === 0}
          className="shrink-0"
        >
          {submitMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Save {dirtyEntries.length > 0 ? `(${dirtyEntries.length})` : ""}
            </>
          )}
        </Button>
      </div>

      {!orgId ? (
        <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          Pick a client above to start counting.
        </div>
      ) : tableQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={`skel-mc-${i.toString()}`} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <CountTable
          rows={tableQuery.data?.rows ?? []}
          dirty={dirty}
          setDirty={setDirty}
          disabled={submitMutation.isPending}
        />
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !o && handleConfirmCancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Confirm {confirmEntries.length} unusual count{confirmEntries.length === 1 ? "" : "s"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              These entries triggered a safety gate. Confirm to apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[40vh] overflow-y-auto space-y-1 text-sm">
            {confirmEntries.map((e) => (
              <div
                key={e.sku}
                className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-muted/40"
              >
                <span className="font-mono text-xs truncate">{e.sku}</span>
                <span className="text-muted-foreground text-xs">
                  {e.previousAvailable} → <strong>{e.newAvailable}</strong>
                </span>
                <Badge variant="outline" className="text-xs">
                  {confirmReasonLabel(e.reason)}
                </Badge>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleConfirmCancel}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmAll}>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Confirm all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CountTable({
  rows,
  dirty,
  setDirty,
  disabled,
}: {
  rows: ManualCountRow[];
  dirty: DirtyMap;
  setDirty: React.Dispatch<React.SetStateAction<DirtyMap>>;
  disabled: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
        No SKUs match.
      </div>
    );
  }
  return (
    <BlockList
      className="mt-3"
      items={rows}
      itemKey={(row) => row.variantId}
      density="ops"
      ariaLabel="Manual inventory count rows"
      renderHeader={({ row }) => (
        <div className="min-w-0">
          <p className="font-mono text-xs">{row.sku}</p>
          <p className="text-sm">{row.productTitle}</p>
          {row.variantTitle ? (
            <p className="text-xs text-muted-foreground">{row.variantTitle}</p>
          ) : null}
        </div>
      )}
      renderExceptionZone={({ row }) => {
        const raw = dirty[row.sku] ?? "";
        const parsed = raw === "" ? null : Number.parseInt(raw, 10);
        const isValidNumber = parsed !== null && !Number.isNaN(parsed) && parsed >= 0;
        const delta = isValidNumber ? (parsed as number) - row.currentAvailable : 0;
        const inProgress = row.countStatus === "count_in_progress";
        const needsConfirm = isValidNumber && Math.abs(delta) > 10;
        return (
          <div className="flex flex-wrap items-center gap-2">
            {isValidNumber && delta !== 0 ? (
              <Badge variant={delta > 0 ? "default" : "destructive"} className="font-mono text-xs">
                {delta > 0 ? "+" : ""}
                {delta}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs">
                No change
              </Badge>
            )}
            {inProgress ? (
              <Badge variant="outline" className="text-xs text-amber-700 border-amber-300">
                Count in progress
              </Badge>
            ) : needsConfirm ? (
              <Badge variant="outline" className="text-xs text-amber-700 border-amber-300">
                Will confirm
              </Badge>
            ) : null}
          </div>
        );
      }}
      renderBody={({ row }) => {
        const raw = dirty[row.sku] ?? "";
        const parsed = raw === "" ? null : Number.parseInt(raw, 10);
        const isValidNumber = parsed !== null && !Number.isNaN(parsed) && parsed >= 0;
        const delta = isValidNumber ? (parsed as number) - row.currentAvailable : 0;
        const inProgress = row.countStatus === "count_in_progress";
        return (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
            <ManualCountMetric label="Format" value={row.formatName ?? "—"} />
            <ManualCountMetric label="Current" value={String(row.currentAvailable)} mono />
            <div className="rounded-md border bg-background/60 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">New count</p>
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                value={raw}
                onChange={(e) =>
                  setDirty((d) => ({ ...d, [row.sku]: e.target.value.replace(/[^0-9]/g, "") }))
                }
                className="mt-1 h-8 w-full text-right font-mono"
                placeholder={String(row.currentAvailable)}
                disabled={disabled || inProgress}
              />
            </div>
            <ManualCountMetric
              label="Delta"
              value={isValidNumber && delta !== 0 ? `${delta > 0 ? "+" : ""}${delta}` : "—"}
              mono
            />
          </div>
        );
      }}
    />
  );
}

function ManualCountMetric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? "text-sm font-mono" : "text-sm"}>{value}</p>
    </div>
  );
}

function clearAppliedFromDirty(prev: DirtyMap, results: EntryResult[]): DirtyMap {
  const next = { ...prev };
  for (const r of results) {
    if (r.status === "applied" || r.status === "no_change") {
      delete next[r.sku];
    }
  }
  return next;
}

function confirmReasonLabel(reason: string): string {
  switch (reason) {
    case "high_delta":
      return "Δ > 10";
    case "rising_from_zero":
      return "0 → +";
    case "falling_to_zero":
      return "→ 0";
    default:
      return reason;
  }
}
