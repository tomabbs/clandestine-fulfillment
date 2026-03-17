"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  Mail,
  Plug,
  RefreshCw,
  Search,
  ShieldAlert,
  ShoppingBag,
  Store,
  XCircle,
} from "lucide-react";
import { useCallback, useState } from "react";
import {
  autoDiscoverSkus,
  createStoreConnection,
  disableStoreConnection,
  getSkuMappings,
  getStoreConnections,
  testStoreConnection,
} from "@/actions/store-connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import type { ClientStoreConnection, ConnectionStatus, StorePlatform } from "@/lib/shared/types";

// === Health state helpers (Rule #52) ===

function statusBadge(status: ConnectionStatus) {
  switch (status) {
    case "active":
      return (
        <Badge variant="default" className="bg-green-600">
          <CheckCircle2 className="mr-1 h-3 w-3" /> Active
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="secondary">
          <Clock className="mr-1 h-3 w-3" /> Pending
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <AlertCircle className="mr-1 h-3 w-3" /> Error
        </Badge>
      );
    case "disabled_auth_failure":
      return (
        <Badge variant="destructive">
          <ShieldAlert className="mr-1 h-3 w-3" /> Auth Failed
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function platformIcon(platform: StorePlatform) {
  switch (platform) {
    case "shopify":
      return <ShoppingBag className="h-4 w-4 text-green-600" />;
    case "woocommerce":
      return <Store className="h-4 w-4 text-purple-600" />;
    case "squarespace":
      return <ExternalLink className="h-4 w-4 text-gray-800 dark:text-gray-200" />;
    case "bigcommerce":
      return <Store className="h-4 w-4 text-blue-600" />;
    default:
      return <Plug className="h-4 w-4" />;
  }
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString();
}

// Rule #53: Circuit breaker display
function circuitBreakerIndicator(conn: ClientStoreConnection) {
  if (conn.connection_status === "disabled_auth_failure") {
    return (
      <Badge variant="destructive" className="text-xs">
        <ShieldAlert className="mr-1 h-3 w-3" /> Disabled (Auth)
      </Badge>
    );
  }
  if (conn.do_not_fanout) {
    return (
      <Badge variant="outline" className="text-xs text-amber-600 border-amber-600">
        <AlertCircle className="mr-1 h-3 w-3" /> Fanout Paused
      </Badge>
    );
  }
  return null;
}

// === SKU Mappings sub-component ===

function SkuMappingsPanel({ connectionId }: { connectionId: string }) {
  const { data: mappings, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: [...queryKeys.storeConnections.all, "mappings", connectionId] as const,
    queryFn: () => getSkuMappings(connectionId),
  });

  if (isLoading) {
    return (
      <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading mappings...
      </div>
    );
  }

  if (!mappings || mappings.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No SKU mappings. Use Auto-Discover to create them.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Local SKU</TableHead>
          <TableHead>Remote SKU</TableHead>
          <TableHead>Last Pushed Qty</TableHead>
          <TableHead>Last Pushed At</TableHead>
          <TableHead>Active</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mappings.map((m) => (
          <TableRow key={m.id}>
            <TableCell className="font-mono text-sm">{m.variant_sku}</TableCell>
            <TableCell className="font-mono text-sm">{m.remote_sku ?? "—"}</TableCell>
            <TableCell>{m.last_pushed_quantity ?? "—"}</TableCell>
            <TableCell className="text-xs">{formatTimestamp(m.last_pushed_at)}</TableCell>
            <TableCell>{m.is_active ? "Yes" : "No"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// === Connection Row ===

function ConnectionRow({
  conn,
  isExpanded,
  onToggle,
  testMutation,
  discoverMutation,
  disableMutation,
}: {
  conn: ConnectionWithMeta;
  isExpanded: boolean;
  onToggle: () => void;
  testMutation: { mutate: (id: string) => void; isPending: boolean };
  discoverMutation: { mutate: (id: string) => void; isPending: boolean };
  disableMutation: { mutate: (id: string) => void; isPending: boolean };
}) {
  return (
    <>
      <TableRow>
        <TableCell>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onToggle}>
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        </TableCell>
        <TableCell>
          <span className="flex items-center gap-2">
            {platformIcon(conn.platform)}
            <span className="capitalize">{conn.platform}</span>
          </span>
        </TableCell>
        <TableCell className="text-sm font-mono max-w-48 truncate">{conn.store_url}</TableCell>
        <TableCell>{statusBadge(conn.connection_status)}</TableCell>
        <TableCell className="text-xs">{formatTimestamp(conn.last_webhook_at)}</TableCell>
        <TableCell className="text-xs">{formatTimestamp(conn.last_poll_at)}</TableCell>
        <TableCell className="text-xs max-w-32 truncate text-destructive">
          {conn.last_error ?? "—"}
        </TableCell>
        <TableCell>{circuitBreakerIndicator(conn)}</TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => testMutation.mutate(conn.id)}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              <span className="ml-1">Test</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => discoverMutation.mutate(conn.id)}
              disabled={discoverMutation.isPending}
            >
              {discoverMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Search className="h-3 w-3" />
              )}
              <span className="ml-1">Discover</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => disableMutation.mutate(conn.id)}
              disabled={disableMutation.isPending || conn.connection_status === "error"}
            >
              <XCircle className="h-3 w-3" />
              <span className="ml-1">Disable</span>
            </Button>
            <Button variant="outline" size="sm">
              <Mail className="h-3 w-3" />
              <span className="ml-1">Setup Email</span>
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {isExpanded && (
        <TableRow>
          <TableCell colSpan={9} className="bg-muted/30 p-0">
            <div className="p-4">
              <h4 className="text-sm font-medium mb-2">SKU Mappings ({conn.sku_mapping_count})</h4>
              <SkuMappingsPanel connectionId={conn.id} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// === Main component ===

type ConnectionWithMeta = ClientStoreConnection & {
  org_name: string;
  sku_mapping_count: number;
};

export function StoreConnectionsContent() {
  const [addOpen, setAddOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newConn, setNewConn] = useState({
    orgId: "",
    platform: "" as StorePlatform | "",
    storeUrl: "",
  });

  const { data, isLoading, refetch } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.storeConnections.all,
    queryFn: () => getStoreConnections(),
  });

  const connections = data?.connections ?? [];

  // Group by org
  const groupedByOrg = connections.reduce<Record<string, ConnectionWithMeta[]>>((acc, conn) => {
    const key = conn.org_name || conn.org_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(conn);
    return acc;
  }, {});

  const createMutation = useAppMutation({
    mutationFn: (data: { orgId: string; platform: StorePlatform; storeUrl: string }) =>
      createStoreConnection(data),
    invalidateKeys: [queryKeys.storeConnections.all],
  });

  const testMutation = useAppMutation({
    mutationFn: (id: string) => testStoreConnection(id),
    invalidateKeys: [queryKeys.storeConnections.all],
  });

  const disableMutation = useAppMutation({
    mutationFn: (id: string) => disableStoreConnection(id),
    invalidateKeys: [queryKeys.storeConnections.all],
  });

  const discoverMutation = useAppMutation({
    mutationFn: (id: string) => autoDiscoverSkus(id),
    invalidateKeys: [queryKeys.storeConnections.all],
  });

  const handleAdd = useCallback(async () => {
    if (!newConn.orgId || !newConn.platform || !newConn.storeUrl) return;
    await createMutation.mutateAsync({
      orgId: newConn.orgId,
      platform: newConn.platform as StorePlatform,
      storeUrl: newConn.storeUrl,
    });
    setNewConn({ orgId: "", platform: "", storeUrl: "" });
    setAddOpen(false);
  }, [newConn, createMutation]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading connections...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>

        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plug className="mr-2 h-4 w-4" /> Add Connection
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Store Connection</DialogTitle>
              <DialogDescription>
                Create a new connection to sync inventory with a client store.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="org-id">Organization ID</Label>
                <Input
                  id="org-id"
                  value={newConn.orgId}
                  onChange={(e) => setNewConn((p) => ({ ...p, orgId: e.target.value }))}
                  placeholder="org-uuid"
                />
              </div>
              <div>
                <Label htmlFor="platform">Platform</Label>
                <Select
                  value={newConn.platform}
                  onValueChange={(v) => setNewConn((p) => ({ ...p, platform: v as StorePlatform }))}
                >
                  <SelectTrigger id="platform">
                    <SelectValue placeholder="Select platform" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="shopify">Shopify</SelectItem>
                    <SelectItem value="squarespace">Squarespace</SelectItem>
                    <SelectItem value="woocommerce">WooCommerce</SelectItem>
                    <SelectItem value="bigcommerce">BigCommerce</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="store-url">Store URL</Label>
                <Input
                  id="store-url"
                  value={newConn.storeUrl}
                  onChange={(e) => setNewConn((p) => ({ ...p, storeUrl: e.target.value }))}
                  placeholder="https://store.example.com"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAdd} disabled={createMutation.isPending}>
                {createMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Connections grouped by org */}
      {Object.keys(groupedByOrg).length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No store connections configured.
          </CardContent>
        </Card>
      ) : (
        Object.entries(groupedByOrg).map(([orgName, orgConns]) => (
          <Card key={orgName}>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">{orgName}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Platform</TableHead>
                    <TableHead>Store URL</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Webhook</TableHead>
                    <TableHead>Last Poll</TableHead>
                    <TableHead>Last Error</TableHead>
                    <TableHead>Circuit</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orgConns.map((conn) => (
                    <ConnectionRow
                      key={conn.id}
                      conn={conn}
                      isExpanded={expandedId === conn.id}
                      onToggle={() => setExpandedId(expandedId === conn.id ? null : conn.id)}
                      testMutation={testMutation}
                      discoverMutation={discoverMutation}
                      disableMutation={disableMutation}
                    />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
