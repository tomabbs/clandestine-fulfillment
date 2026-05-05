"use client";

import {
  Activity,
  CheckCircle2,
  Globe,
  Pencil,
  Plug,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  createStoreConnection,
  deleteStoreConnection,
  disableStoreConnection,
  type getStoreConnections,
  testStoreConnection,
  updateStoreConnection,
} from "@/actions/store-connections";
import { ConfigureShopifyAppDialog } from "@/components/admin/configure-shopify-app-dialog";
import { BlockList } from "@/components/shared/block-list";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/sonner";
import { useAppMutation } from "@/lib/hooks/use-app-query";
import type { ConnectionStatus, StorePlatform } from "@/lib/shared/types";

type StoreConnectionRow = Awaited<ReturnType<typeof getStoreConnections>>["connections"][number];

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
  discogs: "Discogs",
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

function WooWebhookChecklist({ conn }: { conn: StoreConnectionRow }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  const callbackUrl = `${origin}/api/webhooks/client-store?platform=woocommerce&connection_id=${conn.id}`;
  return (
    <div className="md:col-span-3 rounded-md border border-dashed bg-muted/30 p-3 text-xs">
      <p className="font-medium text-sm">WooCommerce webhook checklist</p>
      <p className="mt-1 text-muted-foreground">
        Register these topics in WooCommerce Admin now; programmatic registration is deferred until
        the auth fallback is proven on this connection.
      </p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div>
          <p className="font-medium">Callback URL</p>
          <p className="font-mono break-all">{callbackUrl}</p>
        </div>
        <div>
          <p className="font-medium">Required topics</p>
          <p className="font-mono break-words">
            order.created, order.updated, product.created, product.updated
          </p>
        </div>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        <ConnectionMetric
          label="Last webhook"
          value={conn.last_webhook_at ? new Date(conn.last_webhook_at).toLocaleString() : "Never"}
        />
        <ConnectionMetric
          label="Poll succeeded"
          value={
            conn.last_poll_succeeded_at
              ? new Date(conn.last_poll_succeeded_at).toLocaleString()
              : "Never"
          }
        />
        <ConnectionMetric
          label="Poll failures"
          value={String(conn.consecutive_poll_failures ?? 0)}
          danger={(conn.consecutive_poll_failures ?? 0) > 0}
        />
      </div>
    </div>
  );
}

export function StoreConnectionsClient({
  initialConnections,
  organizations,
}: {
  initialConnections: StoreConnectionRow[];
  organizations: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState<StorePlatform | "">("");
  const [statusFilter, setStatusFilter] = useState<ConnectionStatus | "">("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [configureShopifyId, setConfigureShopifyId] = useState<string | null>(null);
  const [editingConn, setEditingConn] = useState<StoreConnectionRow | null>(null);
  const [editForm, setEditForm] = useState({
    storeUrl: "",
    webhookUrl: "",
    webhookSecret: "",
    clearWebhookSecret: false,
  });
  const [deleteTarget, setDeleteTarget] = useState<StoreConnectionRow | null>(null);
  const [newConn, setNewConn] = useState({
    orgId: "",
    platform: "" as StorePlatform | "",
    storeUrl: "",
  });

  const openEditDialog = (conn: StoreConnectionRow) => {
    setEditingConn(conn);
    setEditForm({
      storeUrl: conn.store_url,
      webhookUrl: conn.webhook_url ?? "",
      webhookSecret: "",
      clearWebhookSecret: false,
    });
  };

  const testMutation = useAppMutation({
    mutationFn: (id: string) => testStoreConnection(id),
    onSuccess: () => router.refresh(),
    onSettled: () => setTestingId(null),
  });

  const disableMutation = useAppMutation({
    mutationFn: (id: string) => disableStoreConnection(id),
    onSuccess: () => router.refresh(),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Disable failed"),
  });

  const updateMutation = useAppMutation({
    mutationFn: (args: { id: string; payload: Parameters<typeof updateStoreConnection>[1] }) =>
      updateStoreConnection(args.id, args.payload),
    onSuccess: () => {
      setEditingConn(null);
      toast.success("Connection updated");
      router.refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Update failed"),
  });

  const deleteMutation = useAppMutation({
    mutationFn: (id: string) => deleteStoreConnection(id),
    onSuccess: () => {
      setDeleteTarget(null);
      toast.success("Connection deleted");
      router.refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  const createMutation = useAppMutation({
    mutationFn: (data: { orgId: string; platform: StorePlatform; storeUrl: string }) =>
      createStoreConnection(data),
    onSuccess: () => {
      setShowAddDialog(false);
      setNewConn({ orgId: "", platform: "", storeUrl: "" });
      router.refresh();
    },
  });

  const connections = initialConnections.filter((conn) => {
    if (platformFilter && conn.platform !== platformFilter) return false;
    if (statusFilter && conn.connection_status !== statusFilter) return false;
    return true;
  });

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
  const webhookUrlTrimmed = editForm.webhookUrl.trim();
  const webhookUrlOk = webhookUrlTrimmed === "" || /^https?:\/\/.+/i.test(webhookUrlTrimmed);
  const canSaveEdit =
    Boolean(editingConn) &&
    editForm.storeUrl.trim().startsWith("http") &&
    webhookUrlOk &&
    !(editForm.clearWebhookSecret && editForm.webhookSecret.trim().length > 0);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Store Connections</h1>
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add Connection
        </Button>
      </div>

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

      {filtered.length === 0 ? (
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
            <BlockList
              className="mt-2"
              items={conns}
              itemKey={(conn) => conn.id}
              density="ops"
              ariaLabel={`${orgName} store connections`}
              renderHeader={({ row: conn }) => (
                <div className="min-w-0">
                  <p>
                    <Badge variant="secondary">
                      {PLATFORM_LABELS[conn.platform] ?? conn.platform}
                    </Badge>
                  </p>
                  <p className="mt-1 font-mono text-xs truncate max-w-[280px]">{conn.store_url}</p>
                </div>
              )}
              renderExceptionZone={({ row: conn }) => (
                <div className="flex flex-wrap items-center gap-2">
                  <ConnectionStatusBadge status={conn.connection_status} />
                  <Badge variant="outline">{conn.sku_mapping_count} SKU mappings</Badge>
                  {conn.do_not_fanout && (
                    <Badge variant="outline" className="gap-1">
                      <ShieldAlert className="h-3 w-3" /> Dormant
                    </Badge>
                  )}
                  {conn.platform === "shopify" && conn.default_location_id && (
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      loc {conn.default_location_id}
                    </Badge>
                  )}
                </div>
              )}
              renderBody={({ row: conn }) => (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <ConnectionMetric
                    label="Last webhook"
                    value={
                      conn.last_webhook_at
                        ? new Date(conn.last_webhook_at).toLocaleString()
                        : "Never"
                    }
                  />
                  <ConnectionMetric
                    label="Last poll"
                    value={
                      conn.last_poll_at ? new Date(conn.last_poll_at).toLocaleString() : "Never"
                    }
                  />
                  <ConnectionMetric
                    label="Last error"
                    value={conn.last_error ?? "None"}
                    danger={Boolean(conn.last_error)}
                  />
                  {conn.platform === "woocommerce" && <WooWebhookChecklist conn={conn} />}
                </div>
              )}
              renderActions={({ row: conn }) => (
                <div className="flex flex-wrap gap-1 justify-end">
                  <Button variant="outline" size="sm" onClick={() => openEditDialog(conn)}>
                    <Pencil className="h-3.5 w-3.5 mr-1" aria-hidden /> Edit
                  </Button>
                  {conn.platform === "shopify" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfigureShopifyId(conn.id)}
                    >
                      Configure App
                    </Button>
                  )}
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
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive border-destructive/40 hover:bg-destructive/10"
                    disabled={deleteMutation.isPending}
                    onClick={() => setDeleteTarget(conn)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" aria-hidden /> Delete
                  </Button>
                </div>
              )}
            />
          </div>
        ))
      )}

      {configureShopifyId &&
        (() => {
          const conn = initialConnections.find((c) => c.id === configureShopifyId);
          if (!conn) return null;
          return (
            <ConfigureShopifyAppDialog
              open
              onOpenChange={(open) => {
                if (!open) setConfigureShopifyId(null);
              }}
              connection={{
                id: conn.id,
                org_id: conn.org_id,
                org_name: conn.org_name,
                store_url: conn.store_url,
                api_key: conn.api_key,
                shopify_app_client_id: conn.shopify_app_client_id,
                shopify_app_client_secret_encrypted: conn.shopify_app_client_secret_encrypted,
                default_location_id: conn.default_location_id,
                do_not_fanout: conn.do_not_fanout,
              }}
            />
          );
        })()}

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete store connection?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently remove{" "}
              <span className="font-medium text-foreground">{deleteTarget?.store_url}</span>? Active
              SKU mappings and integration rows tied to this connection will be deleted (database
              cascade). Warehouse orders keep history but lose{" "}
              <code className="text-xs">connection_id</code> linkage after the delete runs.
              {deleteTarget && deleteTarget.sku_mapping_count > 0 ? (
                <>
                  {" "}
                  This connection currently has <strong>{deleteTarget.sku_mapping_count}</strong>{" "}
                  SKU mapping
                  {deleteTarget.sku_mapping_count === 1 ? "" : "s"}.
                </>
              ) : null}
              {deleteTarget &&
              (deleteTarget.cutover_state === "shadow" ||
                deleteTarget.cutover_state === "direct") ? (
                <>
                  {" "}
                  <span className="text-destructive font-medium">
                    Cutover must be rolled back to &apos;legacy&apos; before deletion.
                  </span>
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={Boolean(
                !deleteTarget ||
                  deleteMutation.isPending ||
                  (deleteTarget &&
                    (deleteTarget.cutover_state === "shadow" ||
                      deleteTarget.cutover_state === "direct")),
              )}
              onClick={() => {
                if (!deleteTarget) return;
                deleteMutation.mutate(deleteTarget.id);
              }}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(editingConn)} onOpenChange={(open) => !open && setEditingConn(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit store connection</DialogTitle>
          </DialogHeader>
          {editingConn ? (
            <div className="space-y-3 pt-2">
              <div>
                <Label htmlFor="edit-url">Store URL</Label>
                <Input
                  id="edit-url"
                  type="url"
                  className="mt-1 font-mono text-xs"
                  value={editForm.storeUrl}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, storeUrl: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="edit-webhook-url">Webhook callback URL (optional)</Label>
                <Input
                  id="edit-webhook-url"
                  type="url"
                  className="mt-1 font-mono text-xs"
                  placeholder="https://…"
                  value={editForm.webhookUrl}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, webhookUrl: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Leave empty to clear. WooCommerce signing uses the webhook secret fields below
                  when set.
                </p>
              </div>
              <div>
                <Label htmlFor="edit-webhook-secret">Webhook signing secret (optional)</Label>
                <Input
                  id="edit-webhook-secret"
                  type="password"
                  autoComplete="new-password"
                  className="mt-1 font-mono text-xs"
                  placeholder="Leave blank to keep unchanged"
                  value={editForm.webhookSecret}
                  disabled={editForm.clearWebhookSecret}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, webhookSecret: e.target.value }))
                  }
                />
              </div>
              <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
                <Checkbox
                  checked={editForm.clearWebhookSecret}
                  onCheckedChange={(checked) => {
                    const isClear = Boolean(checked);
                    setEditForm((prev) => ({
                      ...prev,
                      clearWebhookSecret: isClear,
                      webhookSecret: isClear ? "" : prev.webhookSecret,
                    }));
                  }}
                />
                <span>Clear stored webhook signing secret</span>
              </label>
              <Button
                className="w-full"
                disabled={!canSaveEdit || updateMutation.isPending || !editingConn}
                onClick={() => {
                  if (!editingConn) return;
                  const wu = editForm.webhookUrl.trim();
                  const payload: Parameters<typeof updateStoreConnection>[1] = {
                    storeUrl: editForm.storeUrl.trim(),
                    webhookUrl: wu === "" ? null : wu,
                  };
                  if (editForm.clearWebhookSecret) payload.webhookSecret = null;
                  else if (editForm.webhookSecret.trim()) {
                    payload.webhookSecret = editForm.webhookSecret.trim();
                  }
                  updateMutation.mutate({ id: editingConn.id, payload });
                }}
              >
                {updateMutation.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

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
                {organizations.map((org) => (
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

      <Toaster closeButton position="top-center" richColors />
    </div>
  );
}

function ConnectionMetric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm truncate ${danger ? "text-red-600" : ""}`}>{value}</p>
    </div>
  );
}
