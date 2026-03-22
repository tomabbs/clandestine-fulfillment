"use client";

import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getUserContext } from "@/actions/auth";
import { createClient } from "@/actions/clients";
import {
  type AutoMatchSuggestion,
  autoMatchStores,
  getStoreMappings,
  reprocessUnmatchedShipments,
  syncStoresFromShipStation,
  unmapStore,
  updateStoreMapping,
} from "@/actions/store-mapping";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// --- Searchable org selector with "Add New Client" ---

function OrgSelector({
  value,
  orgName,
  orgs,
  onSelect,
  onClear,
  onAddNew,
  disabled,
}: {
  value: string | null;
  orgName: string | null;
  orgs: Array<{ id: string; name: string }>;
  onSelect: (orgId: string) => void;
  onClear: () => void;
  onAddNew: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const filtered = search
    ? orgs.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : orgs;

  if (!open) {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-left justify-start font-normal min-w-[180px]"
          onClick={() => {
            setOpen(true);
            setSearch("");
          }}
          disabled={disabled}
        >
          <span className={value ? "" : "text-muted-foreground"}>
            {value ? (orgName ?? "Unknown") : "Assign client..."}
          </span>
        </Button>
        {value && (
          <button
            type="button"
            onClick={onClear}
            className="p-1 text-muted-foreground hover:text-foreground"
            disabled={disabled}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <Input
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="Search clients..."
        className="h-8 text-sm w-[220px]"
      />
      <div className="absolute z-30 mt-1 w-[220px] max-h-48 overflow-y-auto bg-popover border rounded-md shadow-lg">
        <button
          type="button"
          className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent border-b"
          onClick={() => {
            onClear();
            setOpen(false);
          }}
        >
          (Unassigned)
        </button>
        {filtered.length === 0 && search ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No clients match</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No clients found.</div>
        ) : (
          filtered.map((org) => (
            <button
              key={org.id}
              type="button"
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors ${org.id === value ? "bg-accent font-medium" : ""}`}
              onClick={() => {
                onSelect(org.id);
                setOpen(false);
              }}
            >
              {org.name}
            </button>
          ))
        )}
        <button
          type="button"
          className="w-full text-left px-3 py-1.5 text-sm text-primary hover:bg-accent border-t flex items-center gap-1"
          onClick={() => {
            setOpen(false);
            onAddNew();
          }}
        >
          <Plus className="h-3 w-3" /> Add New Client
        </button>
      </div>
    </div>
  );
}

// --- Main page ---

export default function StoreMappingPage() {
  const [suggestions, setSuggestions] = useState<AutoMatchSuggestion[]>([]);
  const [showNewClientDialog, setShowNewClientDialog] = useState(false);
  const [pendingStoreId, setPendingStoreId] = useState<string | null>(null);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: ctx } = useAppQuery({
    queryKey: ["user-context"],
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });
  const workspaceId = ctx?.workspaceId ?? "";

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.storeMappings.list(workspaceId),
    queryFn: () => getStoreMappings(workspaceId),
    tier: CACHE_TIERS.SESSION,
    enabled: !!workspaceId,
  });
  // Handle both old cached format (array) and new format (object)
  const mappingData = data;
  const stores = Array.isArray(mappingData) ? mappingData : (mappingData?.stores ?? []);
  const orgs = Array.isArray(mappingData) ? [] : (mappingData?.orgs ?? []);

  useEffect(() => {
    console.log(
      "[StoreMappingPage] data received - stores:",
      stores?.length,
      "orgs:",
      orgs?.length,
    );
  }, [stores, orgs]);

  const syncMutation = useAppMutation({
    mutationFn: () => syncStoresFromShipStation(workspaceId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const autoMatchMutation = useAppMutation({
    mutationFn: () => autoMatchStores(workspaceId),
    invalidateKeys: [],
    onSuccess: (data) => setSuggestions(data),
  });

  const assignMutation = useAppMutation({
    mutationFn: ({ storeId, orgId }: { storeId: string; orgId: string }) =>
      updateStoreMapping(storeId, orgId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const unmapMutation = useAppMutation({
    mutationFn: (storeId: string) => unmapStore(storeId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const reprocessMutation = useAppMutation({
    mutationFn: () => reprocessUnmatchedShipments(workspaceId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const totalCount = stores.length;
  const mappedCount = stores.filter((s) => s.org_id).length;
  const unmappedCount = totalCount - mappedCount;
  const pct = totalCount > 0 ? Math.round((mappedCount / totalCount) * 100) : 0;

  const acceptSuggestion = (s: AutoMatchSuggestion) => {
    assignMutation.mutate({ storeId: s.storeId, orgId: s.suggestedOrgId });
    setSuggestions((prev) => prev.filter((x) => x.storeId !== s.storeId));
  };

  const openNewClientDialog = (storeId: string) => {
    setPendingStoreId(storeId);
    setNewClientName("");
    setNewClientEmail("");
    setCreateError(null);
    setShowNewClientDialog(true);
  };

  const handleCreateClient = async () => {
    if (!newClientName.trim()) return;
    setCreateError(null);
    try {
      const result = await createClient({
        name: newClientName.trim(),
        slug: newClientName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
        billingEmail: newClientEmail.trim() || undefined,
      });
      if (pendingStoreId) {
        assignMutation.mutate({ storeId: pendingStoreId, orgId: result.orgId });
      }
      setShowNewClientDialog(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create client");
    }
  };

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Store Mapping</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Map ShipStation stores to organizations for automatic shipment routing
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            {syncMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Sync Stores
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={autoMatchMutation.isPending}
            onClick={() => {
              setSuggestions([]);
              autoMatchMutation.mutate();
            }}
          >
            {autoMatchMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Zap className="h-4 w-4 mr-1" />
            )}
            Auto-Match
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={reprocessMutation.isPending}
            onClick={() => reprocessMutation.mutate()}
          >
            {reprocessMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4 mr-1" />
            )}
            Reprocess Unmatched
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <div className="flex items-center gap-4 px-4 py-3 border rounded-lg">
          <span className="text-sm font-medium">
            {mappedCount}/{totalCount} stores mapped
          </span>
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden max-w-xs">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {unmappedCount > 0 ? (
            <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> {unmappedCount} unmapped
            </span>
          ) : (
            <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
              <Check className="h-3.5 w-3.5" /> All mapped
            </span>
          )}
        </div>
      )}

      {/* Auto-match suggestions */}
      {suggestions.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-200 dark:border-amber-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-600" />
              <span className="text-sm font-medium">
                Auto-Match Suggestions ({suggestions.length})
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSuggestions([])}
              className="text-muted-foreground hover:text-foreground p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="divide-y divide-amber-200 dark:divide-amber-800">
            {suggestions.map((s) => (
              <div key={s.storeId} className="px-4 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{s.storeName}</span>
                  <ArrowRight className="inline h-3 w-3 mx-2 text-muted-foreground" />
                  <span className="text-sm">{s.suggestedOrgName}</span>
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {Math.round(s.confidence * 100)}%
                  </Badge>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    onClick={() => acceptSuggestion(s)}
                    disabled={assignMutation.isPending}
                  >
                    <Check className="h-3 w-3 mr-1" /> Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSuggestions((p) => p.filter((x) => x.storeId !== s.storeId))}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Store table */}
      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : totalCount === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No ShipStation stores found. Click &ldquo;Sync Stores&rdquo; to import.
        </div>
      ) : (
        <div className="[&>[data-slot=table-container]]:overflow-visible">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Store Name</TableHead>
                <TableHead>Store ID</TableHead>
                <TableHead>Marketplace</TableHead>
                <TableHead>Assigned Client</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((store) => (
                <TableRow key={store.id}>
                  <TableCell className="font-medium">{store.store_name ?? "Unnamed"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {store.store_id}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {store.marketplace_name ?? "—"}
                  </TableCell>
                  <TableCell className="overflow-visible">
                    <OrgSelector
                      value={store.org_id ?? null}
                      orgName={store.org_name ?? null}
                      orgs={orgs}
                      onSelect={(orgId) => assignMutation.mutate({ storeId: store.id, orgId })}
                      onClear={() => unmapMutation.mutate(store.id)}
                      onAddNew={() => openNewClientDialog(store.id)}
                      disabled={assignMutation.isPending || unmapMutation.isPending}
                    />
                  </TableCell>
                  <TableCell>
                    {store.org_id ? (
                      <Badge variant="default" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Mapped
                      </Badge>
                    ) : (
                      <Badge variant="outline">Unmapped</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add New Client Dialog */}
      <Dialog open={showNewClientDialog} onOpenChange={setShowNewClientDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Client</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <label htmlFor="new-client-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="new-client-name"
                autoFocus
                placeholder="e.g. Northern Spy Records"
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateClient();
                }}
              />
            </div>
            <div>
              <label htmlFor="new-client-email" className="text-sm font-medium">
                Billing Email (optional)
              </label>
              <Input
                id="new-client-email"
                type="email"
                placeholder="billing@label.com"
                value={newClientEmail}
                onChange={(e) => setNewClientEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateClient();
                }}
              />
            </div>
            {createError && <p className="text-sm text-red-500">{createError}</p>}
            <Button
              className="w-full"
              disabled={!newClientName.trim()}
              onClick={handleCreateClient}
            >
              Create & Assign
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
