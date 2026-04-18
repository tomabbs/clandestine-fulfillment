"use client";

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ignoreSkuConflict, listSkuConflicts, type SkuConflictRow } from "@/actions/sku-conflicts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type StatusFilter = "open" | "client_suggested" | "resolved" | "ignored" | "all";

const SEVERITY_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
};

const STATUS_BADGE: Record<string, "default" | "secondary" | "outline"> = {
  open: "default",
  client_suggested: "default",
  resolved: "secondary",
  ignored: "outline",
};

function formatPlatformsRow(row: SkuConflictRow): string {
  const parts: string[] = [];
  if (row.our_sku) parts.push(`DB: ${row.our_sku}`);
  if (row.shipstation_sku) parts.push(`SS: ${row.shipstation_sku}`);
  if (row.bandcamp_sku) parts.push(`BC: ${row.bandcamp_sku}`);
  if (row.shopify_sku) parts.push(`Shopify: ${row.shopify_sku}`);
  if (row.squarespace_sku) parts.push(`SQ: ${row.squarespace_sku}`);
  if (row.woocommerce_sku) parts.push(`WC: ${row.woocommerce_sku}`);
  return parts.join("  •  ") || "—";
}

export default function SkuConflictsPage() {
  const [status, setStatus] = useState<StatusFilter>("open");

  const {
    data: conflicts,
    isLoading,
    refetch,
    isFetching,
  } = useAppQuery({
    queryKey: ["sku-conflicts", "list", status],
    queryFn: () => listSkuConflicts({ status: status === "all" ? undefined : status, limit: 200 }),
    tier: CACHE_TIERS.REALTIME,
  });

  const ignoreMutation = useAppMutation({
    mutationFn: (id: string) => ignoreSkuConflict(id),
    invalidateKeys: [["sku-conflicts"]],
  });

  const open = conflicts?.filter((c) => c.status === "open").length ?? 0;
  const suggested = conflicts?.filter((c) => c.status === "client_suggested").length ?? 0;
  const resolved = conflicts?.filter((c) => c.status === "resolved").length ?? 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SKU Sync Conflicts</h1>
          <p className="text-sm text-muted-foreground">
            Detected mismatches across our DB, ShipStation, Bandcamp, and client stores. Resolution
            adds an alias to ShipStation rather than renaming SKUs in client systems.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Open
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{open}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-blue-500" />
              Client suggested
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{suggested}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Resolved (this view)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{resolved}</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Filter:</span>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="client_suggested">Client suggested</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="ignored">Ignored</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading || !conflicts ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : conflicts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No SKU conflicts found for this filter. The audit task runs daily at 02:00 UTC.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Severity</TableHead>
                  <TableHead className="w-[160px]">Type</TableHead>
                  <TableHead>SKUs across platforms</TableHead>
                  <TableHead className="w-[200px]">Title</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead className="w-[80px] text-right">Count</TableHead>
                  <TableHead className="w-[180px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conflicts.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Badge variant={SEVERITY_BADGE[row.severity] ?? "default"}>
                        {row.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.conflict_type}</TableCell>
                    <TableCell className="text-xs">{formatPlatformsRow(row)}</TableCell>
                    <TableCell
                      className="truncate text-xs text-muted-foreground"
                      title={row.example_product_title ?? ""}
                    >
                      {row.example_product_title ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[row.status] ?? "outline"}>{row.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {row.occurrence_count ?? 1}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/admin/catalog/sku-conflicts/${row.id}`}
                          className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[0.8rem] font-medium text-primary-foreground hover:bg-primary/80"
                        >
                          Review
                        </Link>
                        {row.status === "open" || row.status === "client_suggested" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={ignoreMutation.isPending}
                            onClick={() => ignoreMutation.mutate(row.id)}
                          >
                            <XCircle className="mr-1 h-3 w-3" />
                            Ignore
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
