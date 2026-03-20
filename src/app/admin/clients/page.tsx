"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Box,
  Circle,
  Loader2,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { getUserContext } from "@/actions/auth";
import type { ClientStats } from "@/actions/clients";
import { createClient, getClientPresenceSummary, getClients } from "@/actions/clients";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
    queryFn: getUserContext,
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

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ArrowUpDown className="ml-1 h-3 w-3 inline opacity-40" />;
    return sortDir === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3 inline" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3 inline" />
    );
  }

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

      {/* Search */}
      <div className="relative w-64">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("name")}>
                Client <SortIcon field="name" />
              </TableHead>
              <TableHead
                className="text-right cursor-pointer select-none"
                onClick={() => toggleSort("productCount")}
              >
                Products <SortIcon field="productCount" />
              </TableHead>
              <TableHead
                className="text-right cursor-pointer select-none"
                onClick={() => toggleSort("variantCount")}
              >
                Variants <SortIcon field="variantCount" />
              </TableHead>
              <TableHead
                className="text-right cursor-pointer select-none"
                onClick={() => toggleSort("shipmentsThisMonth")}
              >
                Shipments <SortIcon field="shipmentsThisMonth" />
              </TableHead>
              <TableHead
                className="text-right cursor-pointer select-none"
                onClick={() => toggleSort("lastBillingTotal")}
              >
                Last Billing <SortIcon field="lastBillingTotal" />
              </TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => toggleSort("stripeStatus")}
              >
                Stripe <SortIcon field="stripeStatus" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedClients.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                presence={presenceSummary?.byOrg[client.id]}
                onClick={() => router.push(`/admin/clients/${client.id}`)}
              />
            ))}
            {sortedClients.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No clients found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
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

function ClientRow({
  client,
  presence,
  onClick,
}: {
  client: ClientStats;
  presence?: { online: boolean; onlineCount: number; lastSeenAt: string | null };
  onClick: () => void;
}) {
  return (
    <TableRow className="cursor-pointer" onClick={onClick}>
      <TableCell>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{client.name}</span>
            <Badge variant="outline" className="font-mono text-xs">
              {client.slug}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
      </TableCell>
      <TableCell className="text-right">{client.productCount}</TableCell>
      <TableCell className="text-right">{client.variantCount}</TableCell>
      <TableCell className="text-right">{client.shipmentsThisMonth}</TableCell>
      <TableCell className="text-right">
        {client.lastBillingTotal != null ? formatCurrency(client.lastBillingTotal) : "-"}
      </TableCell>
      <TableCell>
        {client.stripeStatus === "connected" ? (
          <Badge variant="default">Connected</Badge>
        ) : (
          <Badge variant="secondary">No</Badge>
        )}
      </TableCell>
    </TableRow>
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
