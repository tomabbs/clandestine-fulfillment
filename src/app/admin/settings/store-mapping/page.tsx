"use client";

import { ArrowRight, CheckCircle2, Loader2, RefreshCw, Unlink } from "lucide-react";
import { useState } from "react";
import {
  type AutoMatchSuggestion,
  autoMatchStores,
  getStoreMappings,
  syncStoresFromShipStation,
  unmapStore,
  updateStoreMapping,
} from "@/actions/store-mapping";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

export default function StoreMappingPage() {
  const [suggestions, setSuggestions] = useState<AutoMatchSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const { data: stores, isLoading } = useAppQuery({
    queryKey: queryKeys.storeMappings.list(WORKSPACE_ID),
    queryFn: () => getStoreMappings(WORKSPACE_ID),
    tier: CACHE_TIERS.SESSION,
  });

  const syncMutation = useAppMutation({
    mutationFn: () => syncStoresFromShipStation(WORKSPACE_ID),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const autoMatchMutation = useAppMutation({
    mutationFn: () => autoMatchStores(WORKSPACE_ID),
    invalidateKeys: [],
    onSuccess: (data) => {
      setSuggestions(data);
      setShowSuggestions(true);
    },
  });

  const applyMappingMutation = useAppMutation({
    mutationFn: ({ storeId, orgId }: { storeId: string; orgId: string }) =>
      updateStoreMapping(storeId, orgId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const unmapMutation = useAppMutation({
    mutationFn: (storeId: string) => unmapStore(storeId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const mapped = (stores ?? []).filter((s) => s.org_id);
  const unmapped = (stores ?? []).filter((s) => !s.org_id);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Store Mapping</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={autoMatchMutation.isPending}
            onClick={() => autoMatchMutation.mutate()}
          >
            Auto-Match
          </Button>
          <Button
            variant="outline"
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            Sync from ShipStation
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Stores
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{(stores ?? []).length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Mapped</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-green-600">{mapped.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unmapped</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-amber-600">{unmapped.length}</p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (stores ?? []).length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No ShipStation stores found. Click &ldquo;Sync from ShipStation&rdquo; to import.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Store Name</TableHead>
              <TableHead>Store ID</TableHead>
              <TableHead>Marketplace</TableHead>
              <TableHead>Mapped Org</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(stores ?? []).map((store) => (
              <TableRow key={store.id}>
                <TableCell className="font-medium">{store.store_name ?? "Unnamed"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {store.store_id}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {store.marketplace_name ?? "—"}
                </TableCell>
                <TableCell>
                  {store.org_name ? (
                    <span className="font-medium">{store.org_name}</span>
                  ) : (
                    <span className="text-muted-foreground italic">Unmapped</span>
                  )}
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
                <TableCell>
                  {store.org_id && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={unmapMutation.isPending}
                      onClick={() => unmapMutation.mutate(store.id)}
                    >
                      <Unlink className="h-3 w-3 mr-1" /> Unmap
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Auto-match suggestions dialog */}
      <Dialog open={showSuggestions} onOpenChange={setShowSuggestions}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Auto-Match Suggestions</DialogTitle>
          </DialogHeader>
          {suggestions.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4">
              No matches found. All stores may already be mapped.
            </p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {suggestions.map((s) => (
                <div
                  key={s.storeId}
                  className="flex items-center justify-between border rounded-lg p-3"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{s.storeName}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span>{s.suggestedOrgName}</span>
                    <Badge variant="secondary" className="text-xs">
                      {Math.round(s.confidence * 100)}%
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    disabled={applyMappingMutation.isPending}
                    onClick={() => {
                      applyMappingMutation.mutate({ storeId: s.storeId, orgId: s.suggestedOrgId });
                    }}
                  >
                    Apply
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
