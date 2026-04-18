"use client";

import { ArrowLeftIcon, CheckCircle2, Loader2, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  applyAliasResolution,
  getSkuConflict,
  ignoreSkuConflict,
  type SkuConflictRow,
} from "@/actions/sku-conflicts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const SEVERITY_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
};

interface PlatformSku {
  label: string;
  value: string;
  recommendedAs: "master" | "alias" | "either";
}

/**
 * Surface every non-null platform SKU on the conflict so staff can pick
 * which is the master and which becomes the alias. The "recommendedAs"
 * hint nudges toward the safe default: our DB SKU is the master (it's the
 * one we control authoritatively); channel SKUs become aliases. Staff can
 * still override.
 */
function collectPlatformSkus(row: SkuConflictRow): PlatformSku[] {
  const skus: PlatformSku[] = [];
  if (row.our_sku) skus.push({ label: "Our DB", value: row.our_sku, recommendedAs: "master" });
  if (row.shipstation_sku)
    skus.push({ label: "ShipStation", value: row.shipstation_sku, recommendedAs: "either" });
  if (row.bandcamp_sku)
    skus.push({ label: "Bandcamp", value: row.bandcamp_sku, recommendedAs: "alias" });
  if (row.shopify_sku)
    skus.push({ label: "Shopify (client)", value: row.shopify_sku, recommendedAs: "alias" });
  if (row.squarespace_sku)
    skus.push({
      label: "Squarespace (client)",
      value: row.squarespace_sku,
      recommendedAs: "alias",
    });
  if (row.woocommerce_sku)
    skus.push({
      label: "WooCommerce (client)",
      value: row.woocommerce_sku,
      recommendedAs: "alias",
    });
  if (row.suggested_canonical_sku)
    skus.push({
      label: "Client-suggested canonical",
      value: row.suggested_canonical_sku,
      recommendedAs: "master",
    });
  return skus;
}

export default function SkuConflictDetailPage() {
  const params = useParams();
  const router = useRouter();
  const conflictId = String(params.id);

  const {
    data: conflict,
    isLoading,
    refetch,
  } = useAppQuery({
    queryKey: ["sku-conflicts", "detail", conflictId],
    queryFn: () => getSkuConflict(conflictId),
    tier: CACHE_TIERS.REALTIME,
    enabled: !!conflictId,
  });

  const [masterSku, setMasterSku] = useState("");
  const [aliasSku, setAliasSku] = useState("");

  // Pre-fill from the conflict's most-likely defaults the first time we
  // get data: master = our DB SKU; alias = first non-DB SKU.
  useEffect(() => {
    if (!conflict) return;
    if (!masterSku && conflict.our_sku) setMasterSku(conflict.our_sku);
    if (!aliasSku) {
      const candidate =
        conflict.shipstation_sku ??
        conflict.shopify_sku ??
        conflict.squarespace_sku ??
        conflict.woocommerce_sku ??
        conflict.bandcamp_sku ??
        "";
      if (candidate && candidate !== conflict.our_sku) setAliasSku(candidate);
    }
  }, [conflict, masterSku, aliasSku]);

  const applyMutation = useAppMutation({
    mutationFn: () =>
      applyAliasResolution({
        conflictId,
        masterSku: masterSku.trim(),
        aliasSku: aliasSku.trim(),
      }),
    invalidateKeys: [["sku-conflicts"]],
    onSuccess: () => {
      refetch();
    },
  });

  const ignoreMutation = useAppMutation({
    mutationFn: () => ignoreSkuConflict(conflictId),
    invalidateKeys: [["sku-conflicts"]],
    onSuccess: () => router.push("/admin/catalog/sku-conflicts"),
  });

  if (isLoading || !conflict) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const skus = collectPlatformSkus(conflict);
  const canApply =
    masterSku.trim().length > 0 &&
    aliasSku.trim().length > 0 &&
    masterSku.trim() !== aliasSku.trim() &&
    conflict.status !== "resolved" &&
    !applyMutation.isPending;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/admin/catalog/sku-conflicts"
          className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[0.8rem] font-medium hover:bg-muted"
        >
          <ArrowLeftIcon className="h-4 w-4" /> Back to queue
        </Link>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SKU Conflict</h1>
          <p className="text-sm text-muted-foreground">
            {conflict.example_product_title ?? "(no product title)"}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant={SEVERITY_BADGE[conflict.severity] ?? "default"}>
            {conflict.severity}
          </Badge>
          <Badge variant="outline">{conflict.status}</Badge>
          <Badge variant="outline">{conflict.conflict_type}</Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Detected SKUs across platforms</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {skus.length === 0 ? (
            <p className="text-sm text-muted-foreground">No SKU values populated on this row.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {skus.map((s) => (
                <li
                  key={`${s.label}:${s.value}`}
                  className="flex items-center justify-between border-b py-2 last:border-0"
                >
                  <div>
                    <div className="font-medium">{s.label}</div>
                    <code className="text-xs text-muted-foreground">{s.value}</code>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setMasterSku(s.value)}
                      disabled={conflict.status === "resolved"}
                    >
                      Use as master
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAliasSku(s.value)}
                      disabled={conflict.status === "resolved"}
                    >
                      Use as alias
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Apply resolution: add ShipStation alias</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This enqueues the <code>sku-rectify-via-alias</code> Trigger task. It looks up the
            ShipStation v1 product by master SKU, holds a per-product Redis mutex, snapshots the
            full pre-image, adds the alias, then re-GETs to verify. No client store is touched.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="master-sku">Master SKU (owns inventory in ShipStation)</Label>
              <Input
                id="master-sku"
                value={masterSku}
                onChange={(e) => setMasterSku(e.target.value)}
                placeholder="e.g. LILA-AV1-SE"
                disabled={conflict.status === "resolved"}
              />
            </div>
            <div>
              <Label htmlFor="alias-sku">Alias SKU (the channel's SKU to add)</Label>
              <Input
                id="alias-sku"
                value={aliasSku}
                onChange={(e) => setAliasSku(e.target.value)}
                placeholder="e.g. LILAAV1SE"
                disabled={conflict.status === "resolved"}
              />
            </div>
          </div>
          {applyMutation.isError ? (
            <div className="text-sm text-destructive">
              {(applyMutation.error as Error).message ?? "Apply failed"}
            </div>
          ) : null}
          {applyMutation.data ? (
            <div className="text-sm text-green-700">
              Queued. Trigger run id: <code>{applyMutation.data.taskRunId}</code>
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => ignoreMutation.mutate()}
              disabled={ignoreMutation.isPending || conflict.status === "resolved"}
            >
              <XCircle className="mr-1 h-4 w-4" />
              Ignore conflict
            </Button>
            <Button onClick={() => applyMutation.mutate()} disabled={!canApply}>
              {applyMutation.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-4 w-4" />
              )}
              Apply alias add
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
