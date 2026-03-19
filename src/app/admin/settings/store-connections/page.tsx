"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Globe,
  Loader2,
  Plug,
  Plus,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { getUserContext } from "@/actions/auth";
import { getOrganizationsForWorkspace } from "@/actions/bandcamp";
import {
  type ConnectionFilters,
  createStoreConnection,
  disableStoreConnection,
  getStoreConnections,
  testStoreConnection,
} from "@/actions/store-connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { ConnectionStatus, StorePlatform } from "@/lib/shared/types";

const STATUS_BADGE: Record<
  ConnectionStatus,
  { variant: "default" | "secondary" | "outline"; icon: typeof CheckCircle2 }
> = {
  active: { variant: "default", icon: CheckCircle2 },
  pending: { variant: "secondary", icon: Activity },
  disabled_auth_failure: { variant: "outline", icon: ShieldAlert },
  error: { variant: "outline", icon: XCircle },
};

const PLATFORM_LABELS: Record<StorePlatform, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  squarespace: "Squarespace",
  bigcommerce: "BigCommerce",
};

function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const cfg = STATUS_BADGE[status] ?? STATUS_BADGE.error;
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.variant} className="gap-1">
      <Icon className="h-3 w-3" /> {status.replace(/_/g, " ")}
    </Badge>
  );
}

function TimeAgo({ date }: { date: string | null }) {
  if (!date) return <span className="text-muted-foreground">Never</span>;
  return <span className="text-muted-foreground text-xs">{new Date(date).toLocaleString()}</span>;
}

export default function StoreConnectionsPage() {
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState<StorePlatform | "">("");
  const [statusFilter, setStatusFilter] = useState<ConnectionStatus | "">("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newConn, setNewConn] = useState({
    orgId: "",
    platform: "" as StorePlatform | "",
    storeUrl: "",
  });

  const { data: ctx } = useAppQuery({
    queryKey: ["user-context"],
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });
  const workspaceId = ctx?.workspaceId ?? "";

  const filters: ConnectionFilters = {
    ...(workspaceId && { workspaceId }),
    ...(platformFilter && { platform: platformFilter }),
    ...(statusFilter && { status: statusFilter }),
  };

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.storeConnections.list(JSON.stringify(filters)),
    queryFn: () => getStoreConnections(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: orgs } = useAppQuery({
    queryKey: ["organizations", workspaceId],
    queryFn: () => getOrganizationsForWorkspace(workspaceId),
    tier: CACHE_TIERS.STABLE,
    enabled: !!workspaceId && showAddDialog,
  });

  const testMutation = useAppMutation({
    mutationFn: (id: string) => testStoreConnection(id),
    invalidateKeys: [queryKeys.storeConnections.all],
    onSettled: () => setTestingId(null),
  });

  const disableMutation = useAppMutation({
    mutationFn: (id: string) => disableStoreConnection(id),
    invalidateKeys: [queryKeys.storeConnections.all],
  });

  const createMutation = useAppMutation({
    mutationFn: (data: { orgId: string; platform: StorePlatform; storeUrl: string }) =>
      createStoreConnection(data),
    invalidateKeys: [queryKeys.storeConnections.all],
    onSuccess: () => {
      setShowAddDialog(false);
      setNewConn({ orgId: "", platform: "", storeUrl: "" });
    },
  });

  // Group connections by org
  const connections = data?.connections ?? [];
  const filtered = search
    ? connections.filter(
        (c) =>
          c.org_name.toLowerCase().includes(search.toLowerCase()) ||
          c.store_url.toLowerCase().includes(search.toLowerCase()),
      )
    : connections;

  const byOrg = new Map<string, typeof filtered>();
  for (const conn of filtered) {
    const orgName = conn.org_name || "Unmapped";
    const list = byOrg.get(orgName) ?? [];
    list.push(conn);
    byOrg.set(orgName, list);
  }

  const canCreate = newConn.orgId && newConn.platform && newConn.storeUrl.startsWith("http");

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Store Connections</h1>
        <Button onClick={() => setShowAddDialog(true)} disabled={!workspaceId}>
          <Plus className="h-4 w-4 mr-1" /> Add Connection
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search org or URL..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value as StorePlatform | "")}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All platforms</option>
          <option value="shopify">Shopify</option>
          <option value="woocommerce">WooCommerce</option>
          <option value="squarespace">Squarespace</option>
          <option value="bigcommerce">BigCommerce</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ConnectionStatus | "")}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="pending">Pending</option>
          <option value="disabled_auth_failure">Auth Failure</option>
          <option value="error">Error</option>
        </select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          <Plug className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>No store connections found.</p>
          <p className="text-sm mt-1">
            Click &ldquo;Add Connection&rdquo; to create a new connection for a client store.
          </p>
        </div>
      ) : (
        Array.from(byOrg.entries()).map(([orgName, conns]) => (
          <div key={orgName} className="space-y-2">
            <h2 className="text-lg font-medium flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              {orgName}
              <span className="text-sm text-muted-foreground font-normal">
                ({conns.length} connection{conns.length !== 1 ? "s" : ""})
              </span>
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Platform</TableHead>
                  <TableHead>Store URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">SKU Mappings</TableHead>
                  <TableHead>Last Webhook</TableHead>
                  <TableHead>Last Poll</TableHead>
                  <TableHead>Last Error</TableHead>
                  <TableHead className="w-36" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {conns.map((conn) => (
                  <TableRow key={conn.id}>
                    <TableCell>
                      <Badge variant="secondary">
                        {PLATFORM_LABELS[conn.platform] ?? conn.platform}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs max-w-[200px] truncate">
                      {conn.store_url}
                    </TableCell>
                    <TableCell>
                      <ConnectionStatusBadge status={conn.connection_status} />
                    </TableCell>
                    <TableCell className="text-right">{conn.sku_mapping_count}</TableCell>
                    <TableCell>
                      <TimeAgo date={conn.last_webhook_at} />
                    </TableCell>
                    <TableCell>
                      <TimeAgo date={conn.last_poll_at} />
                    </TableCell>
                    <TableCell>
                      {conn.last_error ? (
                        <span
                          className="text-xs text-red-600 max-w-[160px] truncate block"
                          title={conn.last_error}
                        >
                          <AlertTriangle className="h-3 w-3 inline mr-1" />
                          {conn.last_error}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">None</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={testMutation.isPending && testingId === conn.id}
                          onClick={() => {
                            setTestingId(conn.id);
                            testMutation.mutate(conn.id);
                          }}
                        >
                          {testMutation.isPending && testingId === conn.id ? "Testing..." : "Test"}
                        </Button>
                        {conn.connection_status === "active" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={disableMutation.isPending}
                            onClick={() => disableMutation.mutate(conn.id)}
                          >
                            Disable
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))
      )}

      {/* Add Connection Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Store Connection</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <Label htmlFor="add-org">Organization (Client)</Label>
              <select
                id="add-org"
                value={newConn.orgId}
                onChange={(e) => setNewConn((c) => ({ ...c, orgId: e.target.value }))}
                className="border-input bg-background w-full h-9 rounded-md border px-3 text-sm mt-1"
              >
                <option value="">Select an organization...</option>
                {(orgs ?? []).map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="add-platform">Platform</Label>
              <select
                id="add-platform"
                value={newConn.platform}
                onChange={(e) =>
                  setNewConn((c) => ({ ...c, platform: e.target.value as StorePlatform | "" }))
                }
                className="border-input bg-background w-full h-9 rounded-md border px-3 text-sm mt-1"
              >
                <option value="">Select platform...</option>
                <option value="shopify">Shopify</option>
                <option value="woocommerce">WooCommerce</option>
                <option value="squarespace">Squarespace</option>
                <option value="bigcommerce">BigCommerce</option>
              </select>
            </div>
            <div>
              <Label htmlFor="add-url">Store URL</Label>
              <Input
                id="add-url"
                type="url"
                placeholder="https://store.example.com"
                value={newConn.storeUrl}
                onChange={(e) => setNewConn((c) => ({ ...c, storeUrl: e.target.value }))}
                className="mt-1"
              />
            </div>
            <Button
              className="w-full"
              disabled={!canCreate || createMutation.isPending}
              onClick={() =>
                createMutation.mutate({
                  orgId: newConn.orgId,
                  platform: newConn.platform as StorePlatform,
                  storeUrl: newConn.storeUrl,
                })
              }
            >
              {createMutation.isPending ? "Creating..." : "Add Connection"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
