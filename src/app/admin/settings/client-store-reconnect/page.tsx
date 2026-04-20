"use client";

import { CheckCircle2, Globe, Loader2, PlugZap, ShieldAlert, XCircle } from "lucide-react";
import { getStoreConnections, reactivateClientStoreConnection } from "@/actions/store-connections";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

/**
 * Phase 0.8 — admin reactivate page.
 *
 * After the dormancy migration (20260417000003) flips every Shopify /
 * WooCommerce / Squarespace connection `do_not_fanout = true`, ShipStation
 * Inventory Sync becomes the default fanout path for client stores. Staff
 * can selectively opt one connection back into first-party fanout from this
 * page when ShipStation Inventory Sync doesn't cover a specific store.
 *
 * Discogs connections are intentionally excluded — Discogs is mail-order, not
 * inventory fanout, and is never dormant by default.
 */

const STORE_PLATFORMS = ["shopify", "woocommerce", "squarespace"] as const;

export default function ClientStoreReconnectPage() {
  const { data, isLoading, error, refetch } = useAppQuery({
    queryKey: ["admin", "client-store-reconnect"],
    queryFn: () => getStoreConnections({}),
    tier: CACHE_TIERS.SESSION,
  });

  const reactivateMut = useAppMutation({
    mutationFn: (connectionId: string) => reactivateClientStoreConnection({ connectionId }),
    invalidateKeys: [["admin", "client-store-reconnect"]],
    onSuccess: () => {
      refetch();
    },
  });

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Reconnect Client Stores</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  const allConnections = data?.connections ?? [];
  const dormantStoreConnections = allConnections.filter(
    (c) =>
      (STORE_PLATFORMS as readonly string[]).includes(c.platform) &&
      (c.do_not_fanout || c.connection_status !== "active"),
  );
  const activeStoreConnections = allConnections.filter(
    (c) =>
      (STORE_PLATFORMS as readonly string[]).includes(c.platform) &&
      !c.do_not_fanout &&
      c.connection_status === "active",
  );

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Reconnect Client Stores</h1>
        <p className="text-sm text-muted-foreground">
          ShipStation Inventory Sync is the default fanout path for client Shopify, WooCommerce, and
          Squarespace stores. Use this page to opt a specific connection back into first-party
          fanout if ShipStation Inventory Sync doesn't cover its needs. Discogs (mail-order) is
          unaffected.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dormant connections ({dormantStoreConnections.length})</CardTitle>
          <CardDescription>
            These connections will not push inventory or poll orders. The integration code stays
            intact — clicking Reactivate sets <code>do_not_fanout = false</code> and{" "}
            <code>connection_status = 'active'</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : dormantStoreConnections.length === 0 ? (
            <EmptyState
              title="No dormant store connections"
              description="All supported client store connections are currently active."
            />
          ) : (
            <BlockList
              className="mt-3"
              items={dormantStoreConnections}
              itemKey={(conn) => conn.id}
              density="ops"
              ariaLabel="Dormant store connections"
              renderHeader={({ row }) => (
                <div className="min-w-0">
                  <p className="font-medium">{row.org_name}</p>
                  <p className="text-xs text-muted-foreground inline-flex items-center gap-1 capitalize">
                    <Globe className="h-3 w-3" />
                    {row.platform}
                  </p>
                </div>
              )}
              renderExceptionZone={({ row }) => (
                <ConnectionDormancyBadge
                  doNotFanout={row.do_not_fanout}
                  status={row.connection_status}
                />
              )}
              renderBody={({ row }) => (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <ReconnectMetric label="Store URL" value={row.store_url} mono />
                  <ReconnectMetric label="Last error" value={row.last_error ?? "—"} />
                </div>
              )}
              renderActions={({ row }) => (
                <Button
                  size="sm"
                  disabled={reactivateMut.isPending && reactivateMut.variables === row.id}
                  onClick={() => reactivateMut.mutate(row.id)}
                >
                  {reactivateMut.isPending && reactivateMut.variables === row.id ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Reactivating...
                    </>
                  ) : (
                    <>
                      <PlugZap className="h-3 w-3 mr-1" />
                      Reactivate
                    </>
                  )}
                </Button>
              )}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active first-party connections ({activeStoreConnections.length})</CardTitle>
          <CardDescription>
            These connections currently bypass ShipStation Inventory Sync. Use the main{" "}
            <code>/admin/settings/store-connections</code> page to disable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activeStoreConnections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              All store connections are dormant — ShipStation Inventory Sync owns fanout.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {activeStoreConnections.map((conn) => (
                <li key={conn.id} className="flex items-center gap-2">
                  <CheckCircle2 className="h-3 w-3 text-green-600" />
                  <span className="font-medium">{conn.org_name}</span>
                  <span className="text-muted-foreground capitalize">— {conn.platform}</span>
                  <span className="text-muted-foreground text-xs truncate">{conn.store_url}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReconnectMetric({
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
      <p className={mono ? "text-sm font-mono truncate" : "text-sm truncate"}>{value}</p>
    </div>
  );
}

function ConnectionDormancyBadge({
  doNotFanout,
  status,
}: {
  doNotFanout: boolean;
  status: string;
}) {
  if (doNotFanout) {
    return (
      <Badge variant="outline" className="gap-1">
        <ShieldAlert className="h-3 w-3" /> dormant
      </Badge>
    );
  }
  if (status === "disabled_auth_failure") {
    return (
      <Badge variant="outline" className="gap-1">
        <ShieldAlert className="h-3 w-3" /> auth failed
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="outline" className="gap-1">
        <XCircle className="h-3 w-3" /> error
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      {status}
    </Badge>
  );
}
