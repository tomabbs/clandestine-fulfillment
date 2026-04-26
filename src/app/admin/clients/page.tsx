"use client";

import { AlertTriangle, Box, Circle, Loader2, Plus, Search, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { getUserContext } from "@/actions/auth";
import { createClient, getClientPresenceSummary, getClients } from "@/actions/clients";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { usePresenceTracking } from "@/lib/hooks/use-presence-tracking";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type SortField =
  | "name"
  | "productCount"
  | "variantCount"
  | "shipmentsThisMonth"
  | "lastBillingTotal"
  | "stripeStatus";
type SortDir = "asc" | "desc";

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function ClientsPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showNew, setShowNew] = useState(false);
  const [newClient, setNewClient] = useState({ name: "", slug: "", billingEmail: "" });

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.list(),
    queryFn: () => getClients({ pageSize: 500 }),
    tier: CACHE_TIERS.SESSION,
  });
  const { data: userContext } = useAppQuery({
    queryKey: queryKeys.auth.userContext(),
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.REALTIME,
  });
  const { onlineUsers } = usePresenceTracking({
    userId: userContext?.userId ?? "unknown-user",
    userName: userContext?.userName ?? "Staff User",
    role: userContext?.userRole ?? "staff",
    currentPage: "/admin/clients",
  });

  const createMut = useAppMutation({
    mutationFn: () => createClient(newClient),
    invalidateKeys: [queryKeys.clients.all],
    onSuccess: () => {
      setShowNew(false);
      setNewClient({ name: "", slug: "", billingEmail: "" });
    },
  });

  const sortedClients = useMemo(() => {
    const all = data?.clients ?? [];
    const searchLower = search.toLowerCase();
    const list = search ? all.filter((c) => c.name.toLowerCase().includes(searchLower)) : all;
    return [...list].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortField) {
        case "name":
          return dir * a.name.localeCompare(b.name);
        case "productCount":
          return dir * (a.productCount - b.productCount);
        case "variantCount":
          return dir * (a.variantCount - b.variantCount);
        case "shipmentsThisMonth":
          return dir * (a.shipmentsThisMonth - b.shipmentsThisMonth);
        case "lastBillingTotal":
          return dir * ((a.lastBillingTotal ?? 0) - (b.lastBillingTotal ?? 0));
        case "stripeStatus":
          return dir * a.stripeStatus.localeCompare(b.stripeStatus);
        default:
          return 0;
      }
    });
  }, [data?.clients, sortField, sortDir, search]);
  const orgIds = useMemo(() => (data?.clients ?? []).map((client) => client.id), [data?.clients]);
  const onlineClientUserIds = useMemo(() => {
    const ids = new Set<string>();
    for (const onlineUser of onlineUsers) {
      if (onlineUser.role === "client" || onlineUser.role === "client_admin") {
        ids.add(onlineUser.userId);
      }
    }
    return Array.from(ids);
  }, [onlineUsers]);
  const { data: presenceSummary } = useAppQuery({
    queryKey: queryKeys.clients.presence(orgIds, onlineClientUserIds),
    queryFn: () =>
      getClientPresenceSummary({
        orgIds,
        onlineUserIds: onlineClientUserIds,
      }),
    tier: CACHE_TIERS.REALTIME,
  });

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <Button onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add Client
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Clients
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-muted-foreground" />
              <span className="text-2xl font-bold">{data?.total ?? 0}</span>
              <span className="text-sm text-muted-foreground">{sortedClients.length} shown</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Products
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Box className="h-5 w-5 text-muted-foreground" />
              <span className="text-2xl font-bold">{data?.totalProducts ?? 0}</span>
              <span className="text-sm text-muted-foreground">
                {data?.totalShipmentsThisMonth ?? 0} shipments this month
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Unmatched Shipments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <AlertTriangle
                className={`h-5 w-5 ${(data?.unmatchedShipments ?? 0) > 0 ? "text-red-500" : "text-muted-foreground"}`}
              />
              <span
                className={`text-2xl font-bold ${(data?.unmatchedShipments ?? 0) > 0 ? "text-red-500" : ""}`}
              >
                {data?.unmatchedShipments ?? 0}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search + Sort */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="name">Sort: Client name</option>
          <option value="productCount">Sort: Products</option>
          <option value="variantCount">Sort: Variants</option>
          <option value="shipmentsThisMonth">Sort: Shipments</option>
          <option value="lastBillingTotal">Sort: Last billing</option>
          <option value="stripeStatus">Sort: Stripe status</option>
        </select>
        <select
          value={sortDir}
          onChange={(e) => setSortDir(e.target.value as SortDir)}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>

      {/* Client list */}
      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <BlockList
          className="mt-3"
          items={sortedClients}
          itemKey={(client) => client.id}
          density="ops"
          ariaLabel="Client list"
          renderHeader={({ row: client }) => {
            const presence = presenceSummary?.byOrg[client.id];
            return (
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{client.name}</span>
                  <Badge variant="outline" className="font-mono text-xs">
                    {client.slug}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                  <Circle
                    className={`h-2.5 w-2.5 fill-current ${
                      presence?.online ? "text-green-500" : "text-muted-foreground/60"
                    }`}
                  />
                  {presence?.online
                    ? `${presence.onlineCount} user${presence.onlineCount === 1 ? "" : "s"} online`
                    : presence?.lastSeenAt
                      ? `Last online ${formatTimeSince(new Date(presence.lastSeenAt))}`
                      : "No recent activity"}
                </div>
              </div>
            );
          }}
          renderExceptionZone={({ row: client }) =>
            client.stripeStatus === "connected" ? (
              <Badge variant="default">Stripe connected</Badge>
            ) : (
              <Badge variant="secondary">No Stripe connection</Badge>
            )
          }
          renderBody={({ row: client }) => (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <ClientMetric label="Products" value={String(client.productCount)} mono />
              <ClientMetric label="Variants" value={String(client.variantCount)} mono />
              <ClientMetric
                label="Shipments this month"
                value={String(client.shipmentsThisMonth)}
                mono
              />
              <ClientMetric
                label="Last billing"
                value={
                  client.lastBillingTotal != null ? formatCurrency(client.lastBillingTotal) : "-"
                }
              />
            </div>
          )}
          renderActions={({ row: client }) => (
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/admin/clients/${client.id}`)}
            >
              Open
            </Button>
          )}
          emptyState={<EmptyState icon={Users} title="No clients found" />}
        />
      )}

      {/* Add Client Dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Client</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <Input
              placeholder="Organization name"
              value={newClient.name}
              onChange={(e) =>
                setNewClient((c) => ({
                  ...c,
                  name: e.target.value,
                  slug: e.target.value.toLowerCase().replace(/\s+/g, "-"),
                }))
              }
            />
            <Input
              placeholder="Slug"
              value={newClient.slug}
              onChange={(e) => setNewClient((c) => ({ ...c, slug: e.target.value }))}
              className="font-mono"
            />
            <Input
              type="email"
              placeholder="Billing email (optional)"
              value={newClient.billingEmail}
              onChange={(e) => setNewClient((c) => ({ ...c, billingEmail: e.target.value }))}
            />
            <Button
              className="w-full"
              disabled={!newClient.name || !newClient.slug || createMut.isPending}
              onClick={() => createMut.mutate()}
            >
              {createMut.isPending ? "Creating..." : "Create Client"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ClientMetric({
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

function formatTimeSince(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
