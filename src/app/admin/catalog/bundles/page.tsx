"use client";

import { AlertTriangle, CheckCircle2, Loader2, Package, RefreshCw } from "lucide-react";
import { useState } from "react";
import { getUserContext } from "@/actions/auth";
import { getBundleComponents, listBundles } from "@/actions/bundle-components";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function BundlesPage() {
  const { data: ctx } = useAppQuery({
    queryKey: queryKeys.auth.userContext(),
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.SESSION,
  });

  const workspaceId = ctx?.workspaceId;

  const {
    data: bundles,
    isLoading,
    refetch,
    isFetching,
  } = useAppQuery({
    queryKey: queryKeys.bundles.list(workspaceId ?? ""),
    queryFn: () => listBundles(workspaceId ?? ""),
    tier: CACHE_TIERS.REALTIME,
    enabled: !!workspaceId,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading || !bundles) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const available = bundles.filter((b) => b.status === "available").length;
  const low = bundles.filter((b) => b.status === "low").length;
  const unavailable = bundles.filter((b) => b.status === "unavailable").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Package className="h-6 w-6" /> Bundle Inventory
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {bundles.length} bundles | {available} available | {low} low stock | {unavailable}{" "}
            unavailable
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {bundles.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <EmptyState
              icon={Package}
              title="No bundles configured"
              description="Bundles are created by linking component variants to a bundle variant."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4">
            <BlockList
              className="mt-2"
              items={bundles}
              itemKey={(bundle) => bundle.bundleVariantId}
              density="ops"
              ariaLabel="Bundle inventory rows"
              expandedKeys={
                expandedId
                  ? new Set<string | number>([expandedId])
                  : (new Set<string | number>() as Set<string | number>)
              }
              onExpandedKeysChange={(keys) => {
                const next = Array.from(keys)[0];
                setExpandedId(next ? String(next) : null);
              }}
              renderHeader={({ row: bundle }) => (
                <div className="min-w-0">
                  <p className="font-medium">{bundle.title}</p>
                  <p className="font-mono text-xs text-muted-foreground">{bundle.sku}</p>
                </div>
              )}
              renderExceptionZone={({ row: bundle }) => (
                <BundleStatusBadge status={bundle.status} />
              )}
              renderBody={({ row: bundle }) => (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <BundleMetric label="Components" value={bundle.componentCount} />
                  <BundleMetric label="Bundle stock" value={bundle.bundleStock} />
                  <BundleMetric label="Effective" value={bundle.effectiveAvailable} />
                  <BundleMetric label="Constrained by" value={bundle.constrainedBy ?? "—"} />
                </div>
              )}
              renderExpanded={({ row: bundle }) => (
                <BundleComponentDetail bundleVariantId={bundle.bundleVariantId} />
              )}
              renderActions={({ toggleExpanded, expanded }) => (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded();
                  }}
                >
                  {expanded ? "Hide components" : "View components"}
                </Button>
              )}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BundleComponentDetail({ bundleVariantId }: { bundleVariantId: string }) {
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.bundles.detail(bundleVariantId),
    queryFn: () => getBundleComponents(bundleVariantId),
    tier: CACHE_TIERS.REALTIME,
  });

  if (isLoading) {
    return (
      <div className="p-4 text-center">
        <Loader2 className="h-4 w-4 animate-spin inline" />
      </div>
    );
  }

  if (!data?.length) {
    return <div className="p-4 text-sm text-muted-foreground">No components found</div>;
  }

  return (
    <div className="bg-muted/30 p-4">
      <p className="text-xs font-medium text-muted-foreground mb-2">Components</p>
      <BlockList
        items={data as Array<Record<string, unknown>>}
        itemKey={(comp) => comp.id as string}
        density="ops"
        ariaLabel="Bundle component rows"
        renderHeader={({ row: comp }) => {
          const variant = comp.warehouse_product_variants as Record<string, unknown> | null;
          const product = variant?.warehouse_products as Record<string, unknown> | null;
          return (
            <div className="min-w-0">
              <p className="text-sm">
                {(product?.title as string) ?? (variant?.title as string) ?? "—"}
              </p>
              <p className="text-xs font-mono text-muted-foreground">
                {(variant?.sku as string) ?? "—"}
              </p>
            </div>
          );
        }}
        renderBody={({ row: comp }) => {
          const variant = comp.warehouse_product_variants as Record<string, unknown> | null;
          const levels = variant?.warehouse_inventory_levels as Record<string, unknown> | null;
          const available = (levels?.available as number) ?? 0;
          const qty = comp.quantity as number;
          const contribution = Math.floor(available / qty);
          return (
            <div className="grid grid-cols-3 gap-3 text-sm">
              <BundleMetric label="Qty per bundle" value={qty} />
              <BundleMetric label="Available" value={available} danger={available <= 0} />
              <BundleMetric label="Contribution" value={contribution} />
            </div>
          );
        }}
      />
    </div>
  );
}

function BundleStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={status === "available" ? "default" : status === "low" ? "secondary" : "destructive"}
      className="text-xs"
    >
      {status === "available" && <CheckCircle2 className="h-3 w-3 mr-1" />}
      {status === "unavailable" && <AlertTriangle className="h-3 w-3 mr-1" />}
      {status}
    </Badge>
  );
}

function BundleMetric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number | string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm ${danger ? "text-destructive font-medium" : ""}`}>{value}</p>
    </div>
  );
}
