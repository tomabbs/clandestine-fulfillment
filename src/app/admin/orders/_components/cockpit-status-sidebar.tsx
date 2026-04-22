// Phase 8.1 + 8.2 — Left status sidebar.
//
// Two stacked sections:
//   1. Status buckets (Awaiting Payment / Awaiting Shipment / On Hold / Shipped / Cancelled)
//      — single click sets orderStatus filter; counts come from getStatusBucketCounts.
//   2. Per-client list — orgs with awaiting_shipment counts; click filters orgId.
//      "Unassigned" pseudo-bucket bubbles to top (org_id IS NULL).
"use client";

import { AlertCircle, CheckCircle, Clock, Pause, Truck, User, UserPlus, X } from "lucide-react";
import {
  type CockpitFilters,
  getOrgBucketsForCockpit,
  getStatusBucketCounts,
  type OrgBucketRow,
  type StatusBucketCounts,
} from "@/actions/shipstation-orders";
import { Badge } from "@/components/ui/badge";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

interface CockpitStatusSidebarProps {
  /** Currently active filters — used to highlight the matching bucket. */
  filters: CockpitFilters;
  onPatchFilters: (patch: Partial<CockpitFilters>) => void;
}

const STATUS_BUCKETS: Array<{
  key: keyof StatusBucketCounts;
  label: string;
  Icon: typeof Truck;
}> = [
  { key: "awaiting_payment", label: "Awaiting Payment", Icon: Clock },
  { key: "awaiting_shipment", label: "Awaiting Shipment", Icon: Truck },
  { key: "on_hold", label: "On Hold", Icon: Pause },
  { key: "shipped", label: "Shipped", Icon: CheckCircle },
  { key: "cancelled", label: "Cancelled", Icon: X },
];

export function CockpitStatusSidebar({ filters, onPatchFilters }: CockpitStatusSidebarProps) {
  const statusKey = ["status", filters.orgId ?? "", filters.storeId ?? ""].join(":");
  const orgKey = ["orgs"].join(":");

  const { data: counts } = useAppQuery({
    queryKey: ["cockpit-status-counts", statusKey],
    queryFn: () =>
      getStatusBucketCounts({
        orgId: filters.orgId,
        storeId: filters.storeId,
      }),
    tier: CACHE_TIERS.SESSION,
  });
  const { data: orgs } = useAppQuery({
    queryKey: ["cockpit-org-buckets", orgKey],
    queryFn: () => getOrgBucketsForCockpit(),
    tier: CACHE_TIERS.SESSION,
  });

  const activeStatus = filters.orderStatus ?? "awaiting_shipment";
  const activeOrg = filters.orgId ?? null;
  const assignedToMe = filters.assignedUserId === "me";

  return (
    <aside className="w-60 shrink-0 border-r bg-muted/20 flex flex-col h-full overflow-hidden">
      {/* Phase 9.3 — Assigned-to-me bucket */}
      <div className="p-3 border-b">
        <button
          type="button"
          onClick={() =>
            onPatchFilters({
              assignedUserId: assignedToMe ? undefined : "me",
              page: 1,
            })
          }
          className={`w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors text-left ${
            assignedToMe ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
          }`}
        >
          <span className="inline-flex items-center gap-2">
            <User className="h-3.5 w-3.5 opacity-70" />
            Assigned to me
          </span>
          {assignedToMe && <X className="h-3 w-3 opacity-60" />}
        </button>
      </div>
      <div className="p-3 space-y-1 border-b">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2">
          Status
        </p>
        {STATUS_BUCKETS.map(({ key, label, Icon }) => {
          const count = counts?.[key] ?? 0;
          const isActive = activeStatus === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onPatchFilters({ orderStatus: key, page: 1 })}
              className={`w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors text-left ${
                isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 opacity-70" />
                {label}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="p-3 space-y-1 flex-1 overflow-y-auto">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 flex items-center justify-between">
          <span>Clients</span>
          {activeOrg && (
            <button
              type="button"
              onClick={() => onPatchFilters({ orgId: undefined, page: 1 })}
              className="text-[10px] hover:underline normal-case font-normal tracking-normal"
            >
              clear
            </button>
          )}
        </p>
        <button
          type="button"
          onClick={() => onPatchFilters({ orgId: undefined, page: 1 })}
          className={`w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors text-left ${
            !activeOrg ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
          }`}
        >
          <span>All clients</span>
        </button>
        {(orgs ?? []).map((row: OrgBucketRow) => {
          const orgKeyValue = row.org_id ?? "unassigned";
          const isActive = activeOrg === orgKeyValue;
          return (
            <button
              key={orgKeyValue}
              type="button"
              onClick={() => onPatchFilters({ orgId: orgKeyValue, page: 1 })}
              className={`w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors text-left ${
                isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
              }`}
            >
              <span className="inline-flex items-center gap-1.5 truncate">
                {row.org_id === null ? (
                  <>
                    <UserPlus className="h-3.5 w-3.5 text-amber-600" />
                    <span className="truncate text-amber-700">Unassigned</span>
                  </>
                ) : (
                  <span className="truncate">{row.org_name ?? "—"}</span>
                )}
              </span>
              <Badge variant="outline" className="text-[10px] tabular-nums shrink-0">
                {row.awaiting_shipment_count}
              </Badge>
            </button>
          );
        })}
        {(orgs ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground px-2 py-2 italic">
            <AlertCircle className="h-3 w-3 inline mr-1" />
            No awaiting orders.
          </p>
        )}
      </div>
    </aside>
  );
}
