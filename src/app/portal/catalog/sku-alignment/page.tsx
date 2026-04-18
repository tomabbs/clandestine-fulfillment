"use client";

import { CheckCircle2, Loader2, Send } from "lucide-react";
import { useState } from "react";
import {
  listClientSkuMismatches,
  type SkuConflictRow,
  suggestCanonicalSku,
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

function describeMismatch(row: SkuConflictRow): { label: string; sku: string }[] {
  const items: { label: string; sku: string }[] = [];
  if (row.our_sku) items.push({ label: "Clandestine warehouse SKU", sku: row.our_sku });
  if (row.shopify_sku) items.push({ label: "Your Shopify SKU", sku: row.shopify_sku });
  if (row.squarespace_sku) items.push({ label: "Your Squarespace SKU", sku: row.squarespace_sku });
  if (row.woocommerce_sku) items.push({ label: "Your WooCommerce SKU", sku: row.woocommerce_sku });
  if (row.bandcamp_sku) items.push({ label: "Bandcamp SKU", sku: row.bandcamp_sku });
  if (row.shipstation_sku) items.push({ label: "ShipStation SKU", sku: row.shipstation_sku });
  return items;
}

function ConflictCard({ row }: { row: SkuConflictRow }) {
  const [suggestion, setSuggestion] = useState(row.suggested_canonical_sku ?? row.our_sku ?? "");

  const mutation = useAppMutation({
    mutationFn: (next: string) =>
      suggestCanonicalSku({
        conflictId: row.id,
        suggestedCanonicalSku: next.trim(),
      }),
    invalidateKeys: [["client-sku-mismatches"]],
  });

  const items = describeMismatch(row);
  const submitted = row.status === "client_suggested" && !mutation.isPending && !mutation.data;
  const justSubmitted = !!mutation.data;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              {row.example_product_title ?? "(no product title)"}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Detected {new Date(row.detected_at).toLocaleDateString()} ·{" "}
              {row.conflict_type.replace(/_/g, " ")}
            </p>
          </div>
          <Badge variant={SEVERITY_BADGE[row.severity] ?? "default"}>{row.severity}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="mb-1 text-sm font-medium">SKUs we see across systems</p>
          <ul className="space-y-1 text-sm">
            {items.map((it) => (
              <li
                key={`${it.label}:${it.sku}`}
                className="flex items-center justify-between border-b py-1 last:border-0"
              >
                <span className="text-muted-foreground">{it.label}</span>
                <code className="text-xs">{it.sku}</code>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <Label htmlFor={`suggest-${row.id}`}>Which SKU is correct?</Label>
          <p className="mb-2 text-xs text-muted-foreground">
            Suggest the SKU you'd like everything aligned to. Clandestine staff will review and
            apply — your stores will not be touched until staff approves.
          </p>
          <div className="flex gap-2">
            <Input
              id={`suggest-${row.id}`}
              value={suggestion}
              onChange={(e) => setSuggestion(e.target.value)}
              placeholder="Canonical SKU"
            />
            <Button
              onClick={() => mutation.mutate(suggestion)}
              disabled={
                mutation.isPending ||
                suggestion.trim().length === 0 ||
                row.status === "resolved" ||
                row.status === "ignored"
              }
            >
              {mutation.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-1 h-4 w-4" />
              )}
              Suggest
            </Button>
          </div>
          {mutation.isError ? (
            <p className="mt-1 text-xs text-destructive">
              {(mutation.error as Error).message ?? "Suggestion failed"}
            </p>
          ) : null}
          {justSubmitted ? (
            <p className="mt-1 flex items-center gap-1 text-xs text-green-700">
              <CheckCircle2 className="h-3 w-3" />
              Sent to Clandestine staff for review
            </p>
          ) : submitted ? (
            <p className="mt-1 flex items-center gap-1 text-xs text-blue-700">
              <CheckCircle2 className="h-3 w-3" />
              Suggested previously: <code>{row.suggested_canonical_sku}</code> · awaiting staff
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SkuAlignmentPage() {
  const { data: rows, isLoading } = useAppQuery({
    queryKey: ["client-sku-mismatches"],
    queryFn: () => listClientSkuMismatches(),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading || !rows) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">SKU alignment</h1>
        <p className="text-sm text-muted-foreground">
          We've detected SKU differences between your stores and our warehouse. Suggest the correct
          SKU for each item — Clandestine staff reviews and applies. Your stores are never modified
          directly; we add aliases in ShipStation so all systems route inventory to the right master
          record.
        </p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No SKU mismatches detected. Everything is aligned. The audit runs daily.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {rows.map((row) => (
            <ConflictCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
