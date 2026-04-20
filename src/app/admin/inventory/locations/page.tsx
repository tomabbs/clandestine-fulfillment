"use client";

/**
 * Sunday Workstream 3 follow-up (slug ws3-3g-locations-admin-page) —
 * standalone warehouse-locations admin page.
 *
 * Centralises operator workflows that previously required the count panel:
 *   - Search + filter (active-only / location_type) the full list.
 *   - See the ShipStation v2 mirror state per row at a glance (Synced /
 *     Mirror failed / Local-only / Conflict resolved).
 *   - One-click retry on rows with shipstation_sync_error
 *     (calls retryShipstationLocationSync).
 *   - Create a single location inline via a dialog (calls createLocation).
 *   - Create a numbered range via a dialog (calls createLocationRange — the
 *     Server Action auto-routes to the bulk-create-locations Trigger task
 *     when size > 30 per Rule #41).
 *   - Deactivate locations (blocked Server-side when any
 *     warehouse_variant_locations.quantity > 0 references the row).
 *
 * INTENTIONALLY NOT IN SCOPE for this MVP (deferred to a future polish pass):
 *   - Inline rename. The Server Action calls ShipStation FIRST on rename
 *     (v4 hardening) and the failure UX needs more thought than 1hr buys.
 *   - Bulk operations beyond create-range.
 *   - Per-location inventory drilldown — that lives on /admin/inventory.
 *
 * Per CLAUDE.md Rule #51 we ADD a sub-route under /admin/inventory; the
 * sidebar layout component is untouched apart from its NAV_ITEMS array.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type CreateLocationRangeResult,
  createLocation,
  createLocationRange,
  deactivateLocation,
  listLocations,
  retryShipstationLocationSync,
  type WarehouseLocationRow,
} from "@/actions/locations";
import { BlockList } from "@/components/shared/block-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const LOCATION_TYPES = ["shelf", "bin", "floor", "staging"] as const;
type LocationType = (typeof LOCATION_TYPES)[number];

type SyncBadge = "synced" | "local_only" | "error" | "no_v2_configured";

function syncBadgeFor(row: WarehouseLocationRow): SyncBadge {
  if (row.shipstation_sync_error) return "error";
  if (row.shipstation_inventory_location_id) return "synced";
  // We can't tell from the row alone whether v2 is configured for the
  // workspace — the action does. We collapse "no v2 + no mirror" and
  // "v2 configured + never synced" into one "Local only" badge, which is
  // operationally accurate (operator can hit Retry to find out which one).
  return "local_only";
}

function relativeTimeShort(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function LocationsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [typeFilter, setTypeFilter] = useState<"all" | LocationType>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);

  const list = useAppQuery({
    queryKey: ["admin", "locations", "list", { activeOnly, search }],
    queryFn: () => listLocations({ activeOnly, search: search.trim() || undefined }),
    tier: CACHE_TIERS.REALTIME,
  });

  const filteredRows = useMemo(() => {
    const rows = list.data ?? [];
    if (typeFilter === "all") return rows;
    return rows.filter((r) => r.location_type === typeFilter);
  }, [list.data, typeFilter]);

  const counts = useMemo(() => {
    const rows = filteredRows;
    return {
      total: rows.length,
      synced: rows.filter((r) => syncBadgeFor(r) === "synced").length,
      errors: rows.filter((r) => syncBadgeFor(r) === "error").length,
      localOnly: rows.filter((r) => syncBadgeFor(r) === "local_only").length,
    };
  }, [filteredRows]);

  const retryMutation = useAppMutation({
    mutationFn: (id: string) => retryShipstationLocationSync(id),
    onSuccess: (result, id) => {
      if (result.alreadySynced) {
        toast.info("Already synced — refreshing list.");
      } else if (result.ok) {
        toast.success("ShipStation mirror created.");
      } else {
        toast.error(`Retry failed: ${result.error ?? "unknown error"}`);
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "locations"] });
      void id;
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "NO_V2_WAREHOUSE") {
        toast.error("Workspace has no ShipStation v2 warehouse configured.");
      } else {
        toast.error(`Retry failed: ${msg}`);
      }
    },
  });

  const deactivateMutation = useAppMutation({
    mutationFn: (id: string) => deactivateLocation(id),
    onSuccess: () => {
      toast.success("Location deactivated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "locations"] });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "LOCATION_HAS_INVENTORY") {
        toast.error(
          "Cannot deactivate: this location still has inventory. Move or zero it out first.",
        );
      } else {
        toast.error(`Deactivate failed: ${msg}`);
      }
    },
  });

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Warehouse locations</h1>
          <p className="text-sm text-muted-foreground">
            Our app is the source of truth — every change mirrors one-way to ShipStation v2. Failed
            mirrors stay queryable here with a one-click retry.
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

      <div className="flex flex-col lg:flex-row gap-2 items-stretch lg:items-end">
        <div className="space-y-1 flex-1 min-w-[240px]">
          <span className="text-xs text-muted-foreground">Search by name</span>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="A-01, BIN-12…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </div>

        <div className="space-y-1 min-w-[160px]">
          <span className="text-xs text-muted-foreground">Type</span>
          <Select
            value={typeFilter}
            onValueChange={(v) => setTypeFilter((v ?? "all") as "all" | LocationType)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {LOCATION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 min-w-[140px]">
          <span className="text-xs text-muted-foreground">Status</span>
          <Select
            value={activeOnly ? "active" : "all"}
            onValueChange={(v) => setActiveOnly(v === "active")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active only</SelectItem>
              <SelectItem value="all">Active + inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-end gap-2 ml-auto">
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger
              render={
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  New location
                </Button>
              }
            />
            <CreateLocationDialog onClose={() => setCreateOpen(false)} />
          </Dialog>

          <Dialog open={rangeOpen} onOpenChange={setRangeOpen}>
            <DialogTrigger
              render={
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  New range
                </Button>
              }
            />
            <CreateRangeDialog onClose={() => setRangeOpen(false)} />
          </Dialog>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>{counts.total} location(s)</span>
        <span className="text-emerald-600 dark:text-emerald-400">{counts.synced} synced</span>
        {counts.errors > 0 ? (
          <span className="text-red-600 dark:text-red-400">{counts.errors} mirror error(s)</span>
        ) : null}
        {counts.localOnly > 0 ? <span>{counts.localOnly} local only</span> : null}
      </div>

      {list.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={`skel-loc-${i.toString()}`} className="h-10 w-full" />
          ))}
        </div>
      ) : list.error ? (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200">
          Failed to load locations: {String(list.error)}
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No locations match the current filters. Use “New location” or “New range” to create some.
        </div>
      ) : (
        <BlockList
          className="mt-3"
          items={filteredRows}
          itemKey={(row) => row.id}
          density="ops"
          ariaLabel="Warehouse locations"
          renderHeader={({ row }) => (
            <div className="min-w-0">
              <p className="font-medium">
                {row.name}
                {!row.is_active ? (
                  <Badge variant="outline" className="ml-2 text-xs">
                    inactive
                  </Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">{row.location_type}</p>
            </div>
          )}
          renderExceptionZone={({ row }) => (
            <div className="flex items-center gap-2">
              <SyncStateCell row={row} badge={syncBadgeFor(row)} />
              <Badge variant="outline" className="text-xs">
                {row.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
          )}
          renderBody={({ row }) => (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <LocationMetric label="Barcode" value={row.barcode ?? "—"} mono />
              <LocationMetric
                label="Last synced"
                value={relativeTimeShort(row.shipstation_synced_at) ?? "—"}
              />
              <LocationMetric label="Location ID" value={row.id} mono />
            </div>
          )}
          renderActions={({ row }) => {
            const badge = syncBadgeFor(row);
            return (
              <div className="flex items-center gap-1">
                {badge === "error" || badge === "local_only" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={retryMutation.isPending}
                    onClick={() => retryMutation.mutate(row.id)}
                    title="Retry ShipStation v2 mirror"
                  >
                    {retryMutation.isPending && retryMutation.variables === row.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    <span className="ml-1 hidden sm:inline">Retry</span>
                  </Button>
                ) : null}
                {row.is_active ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={deactivateMutation.isPending}
                    onClick={() => deactivateMutation.mutate(row.id)}
                    title="Deactivate (blocked if any inventory references this location)"
                  >
                    Deactivate
                  </Button>
                ) : null}
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

function LocationMetric({
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

// ─── SyncStateCell ──────────────────────────────────────────────────────────

function SyncStateCell({ row, badge }: { row: WarehouseLocationRow; badge: SyncBadge }) {
  if (badge === "synced") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        Synced
      </span>
    );
  }
  if (badge === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300"
        title={row.shipstation_sync_error ?? undefined}
      >
        <XCircle className="h-3 w-3" />
        Mirror failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <ArrowUpRight className="h-3 w-3" />
      Local only
    </span>
  );
}

// ─── CreateLocationDialog ───────────────────────────────────────────────────

function CreateLocationDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [locationType, setLocationType] = useState<LocationType>("shelf");
  const [barcode, setBarcode] = useState("");

  const create = useAppMutation({
    mutationFn: () =>
      createLocation({
        name: name.trim(),
        locationType,
        barcode: barcode.trim() || undefined,
      }),
    onSuccess: (result) => {
      if (result.warning === "shipstation_mirror_failed") {
        toast.warning(
          `Created locally. ShipStation mirror failed (${result.error ?? "unknown"}). Use Retry on the row.`,
        );
      } else if (result.warning === "shipstation_mirror_resolved_existing") {
        toast.success("Created locally. Resolved to existing ShipStation location.");
      } else if (result.warning === "no_v2_warehouse_configured") {
        toast.success("Created locally. No ShipStation v2 warehouse configured for mirror.");
      } else {
        toast.success("Location created and mirrored to ShipStation.");
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "locations"] });
      setName("");
      setBarcode("");
      onClose();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "LOCATION_ALREADY_EXISTS") {
        toast.error("A location with that name already exists.");
      } else if (msg.startsWith("INVALID_LOCATION_TYPE")) {
        toast.error("Invalid location type.");
      } else {
        toast.error(`Create failed: ${msg}`);
      }
    },
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create location</DialogTitle>
        <DialogDescription>
          Mirrored one-way to ShipStation v2. A 409 conflict resolves to the existing upstream
          location automatically.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="A-01"
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <Label>Type</Label>
          <Select
            value={locationType}
            onValueChange={(v) => setLocationType((v ?? "shelf") as LocationType)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCATION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Barcode (optional)</Label>
          <Input value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="—" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
          {create.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Create
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ─── CreateRangeDialog ──────────────────────────────────────────────────────

function CreateRangeDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState("A-");
  const [fromIndex, setFromIndex] = useState("1");
  const [toIndex, setToIndex] = useState("10");
  const [padWidth, setPadWidth] = useState("2");
  const [locationType, setLocationType] = useState<LocationType>("shelf");

  const size = useMemo(() => {
    const f = Number.parseInt(fromIndex, 10);
    const t = Number.parseInt(toIndex, 10);
    if (Number.isNaN(f) || Number.isNaN(t)) return 0;
    return Math.max(0, t - f + 1);
  }, [fromIndex, toIndex]);

  const create = useAppMutation({
    mutationFn: () =>
      createLocationRange({
        prefix: prefix.trim(),
        fromIndex: Number.parseInt(fromIndex, 10),
        toIndex: Number.parseInt(toIndex, 10),
        locationType,
        padWidth: padWidth.trim() ? Number.parseInt(padWidth, 10) : undefined,
      }),
    onSuccess: (result: CreateLocationRangeResult) => {
      if (result.mode === "trigger") {
        toast.success(
          `Range of ${result.size} routed to bulk task (${result.taskRunId}). Refreshing as rows land.`,
          { duration: 8000 },
        );
      } else {
        const created = result.results.filter((r) => r.status === "created").length;
        const exists = result.results.filter((r) => r.status === "exists").length;
        const errors = result.results.filter((r) => r.status === "error").length;
        if (errors > 0) {
          toast.warning(
            `Inline range done: ${created} created, ${exists} already existed, ${errors} error(s).`,
          );
        } else {
          toast.success(
            `Inline range done: ${created} created${exists > 0 ? `, ${exists} already existed` : ""}.`,
          );
        }
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "locations"] });
      onClose();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "EMPTY_RANGE") {
        toast.error("Range is empty (toIndex must be ≥ fromIndex).");
      } else if (msg.startsWith("INVALID_LOCATION_TYPE")) {
        toast.error("Invalid location type.");
      } else {
        toast.error(`Create-range failed: ${msg}`);
      }
    },
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create location range</DialogTitle>
        <DialogDescription>
          Inline for {"\u2264"} 30 entries (300 ms throttle). Larger ranges route to the
          bulk-create-locations Trigger task per Rule #41.
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1 col-span-2">
          <Label>Prefix</Label>
          <Input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="A-"
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <Label>From</Label>
          <Input
            type="number"
            value={fromIndex}
            onChange={(e) => setFromIndex(e.target.value)}
            min={0}
          />
        </div>
        <div className="space-y-1">
          <Label>To</Label>
          <Input
            type="number"
            value={toIndex}
            onChange={(e) => setToIndex(e.target.value)}
            min={0}
          />
        </div>
        <div className="space-y-1">
          <Label>Pad width</Label>
          <Input
            type="number"
            value={padWidth}
            onChange={(e) => setPadWidth(e.target.value)}
            min={0}
          />
        </div>
        <div className="space-y-1">
          <Label>Type</Label>
          <Select
            value={locationType}
            onValueChange={(v) => setLocationType((v ?? "shelf") as LocationType)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCATION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {size > 30 ? (
          <>
            <AlertTriangle className="h-3 w-3 text-amber-500" />
            Range of {size} {">"} 30 — will route to Trigger task.
          </>
        ) : size > 0 ? (
          <>Range of {size} — inline.</>
        ) : (
          <>Pick a non-empty range.</>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => create.mutate()} disabled={size === 0 || create.isPending}>
          {create.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Create {size > 0 ? `(${size})` : ""}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
