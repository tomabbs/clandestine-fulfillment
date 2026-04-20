"use client";

import { Check, Link2, Search, X } from "lucide-react";
import { useState } from "react";
import { confirmMapping, getProductMappings, rejectMapping } from "@/actions/discogs-admin";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type MappingRow = Awaited<ReturnType<typeof getProductMappings>>["mappings"][number];

const MATCH_METHOD_COLORS: Record<string, string> = {
  barcode: "bg-green-100 text-green-800",
  catno: "bg-blue-100 text-blue-800",
  title: "bg-yellow-100 text-yellow-800",
  manual: "bg-purple-100 text-purple-800",
};

export default function DiscogsMatchingPage() {
  const [filters, setFilters] = useState({ search: "", status: "" });

  const { data, isLoading } = useAppQuery({
    queryKey: ["discogs", "mappings", filters],
    queryFn: () => getProductMappings(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const confirmMut = useAppMutation({
    mutationFn: (id: string) => confirmMapping(id),
    invalidateKeys: [["discogs"]],
  });

  const rejectMut = useAppMutation({
    mutationFn: (id: string) => rejectMapping(id),
    invalidateKeys: [["discogs"]],
  });

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Product Matching</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review and confirm auto-matched Discogs releases. Barcode matches are auto-confirmed.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search SKU or title…"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="pl-8 w-56"
          />
        </div>
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All</option>
          <option value="pending">Pending review</option>
          <option value="active">Active</option>
        </select>
      </div>

      <BlockList
        className="mt-3"
        items={(data?.mappings ?? []) as MappingRow[]}
        itemKey={(m) => m.id}
        loading={isLoading}
        density="ops"
        ariaLabel="Discogs product mappings"
        renderHeader={({ row: m }) => {
          const variant = m.warehouse_product_variants as unknown as {
            sku: string;
            title: string | null;
          } | null;
          return (
            <div className="min-w-0">
              <p className="font-mono text-sm">{variant?.sku ?? "—"}</p>
              {variant?.title ? (
                <p className="text-xs text-muted-foreground mt-0.5">{variant.title}</p>
              ) : null}
            </div>
          );
        }}
        renderExceptionZone={({ row: m }) => (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                MATCH_METHOD_COLORS[m.match_method] ?? "bg-gray-100"
              }`}
            >
              {m.match_method}
            </span>
            <Badge variant={m.is_active ? "default" : "outline"}>
              {m.is_active ? "Active" : "Pending"}
            </Badge>
            <Badge variant="secondary">
              {m.match_confidence != null
                ? `${Math.round(Number(m.match_confidence) * 100)}%`
                : "—"}
            </Badge>
          </div>
        )}
        renderBody={({ row: m }) => (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border bg-background/60 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Discogs release
              </p>
              <a
                href={
                  m.discogs_release_url ?? `https://www.discogs.com/release/${m.discogs_release_id}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono text-blue-600 hover:underline inline-flex items-center gap-1"
              >
                #{m.discogs_release_id}
                <Link2 className="h-3 w-3" />
              </a>
            </div>
            <div className="rounded-md border bg-background/60 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Mapping ID
              </p>
              <p className="text-sm font-mono">{m.id}</p>
            </div>
          </div>
        )}
        renderActions={({ row: m }) =>
          !m.is_active ? (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-green-700 border-green-300"
                disabled={confirmMut.isPending}
                onClick={() => confirmMut.mutate(m.id)}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-destructive border-destructive/30"
                disabled={rejectMut.isPending}
                onClick={() => rejectMut.mutate(m.id)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null
        }
        emptyState={
          <EmptyState
            title="No product mappings"
            description="Run discogs-catalog-match to discover matches."
          />
        }
      />
    </div>
  );
}
