"use client";

import { ArrowLeft, ExternalLink, Loader2, Package, Save } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getClientProductDetail, updateClientProduct } from "@/actions/catalog";
import { BlockList } from "@/components/shared/block-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const PRODUCT_TYPES = ["LP", "CD", "Cassette", "Shirt", "Bundle", "Merch", "Other"];

export default function PortalCatalogDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const {
    data: product,
    isLoading,
    error,
  } = useAppQuery({
    queryKey: [...queryKeys.clientReleases.list(), "detail", id],
    queryFn: () => getClientProductDetail(id),
    tier: CACHE_TIERS.SESSION,
  });

  const [form, setForm] = useState({
    title: "",
    descriptionHtml: "",
    productType: "",
    tags: "",
    status: "draft" as "active" | "draft" | "archived",
  });
  const [hydrated, setHydrated] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (product) {
      setForm({
        title: product.title ?? "",
        descriptionHtml:
          ((product as unknown as Record<string, unknown>).description_html as string) ?? "",
        productType: product.product_type ?? "",
        tags: Array.isArray(product.tags) ? (product.tags as string[]).join(", ") : "",
        status: (product.status as "active" | "draft" | "archived") ?? "draft",
      });
    }
  }, [product]);

  const { mutateAsync: save, isPending: saving } = useAppMutation({
    mutationFn: async () => {
      await updateClientProduct(id, {
        title: form.title,
        descriptionHtml: form.descriptionHtml,
        productType: form.productType,
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        status: form.status,
      });
    },
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    invalidateKeys: [[...queryKeys.clientReleases.list(), "detail", id]],
  });

  const handleSave = useCallback(async () => {
    await save();
  }, [save]);

  if (!hydrated || isLoading) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error
            ? error.message
            : "Product not found or you don\u2019t have access to it."}
        </p>
      </div>
    );
  }

  const images = (product.warehouse_product_images ?? []) as Array<{
    id: string;
    src: string;
    alt: string | null;
    position: number;
  }>;
  const primaryImage = [...images].sort((a, b) => a.position - b.position)[0];
  const variants = (product.warehouse_product_variants ?? []) as Array<{
    id: string;
    sku: string;
    title: string | null;
    price: number | null;
    format_name: string | null;
    street_date: string | null;
    is_preorder: boolean;
    warehouse_inventory_levels: Array<{ available: number; committed: number; incoming: number }>;
  }>;

  const shopifyUrl = product.shopify_product_id
    ? `https://admin.shopify.com/products/${product.shopify_product_id.replace(/\D/g, "")}`
    : null;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Back + title */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/portal/catalog")}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to Catalog
        </Button>
      </div>

      <div className="flex items-start gap-4">
        {primaryImage ? (
          <Image
            src={primaryImage.src}
            alt={primaryImage.alt ?? product.title}
            width={80}
            height={80}
            className="rounded-lg object-cover border shrink-0"
          />
        ) : (
          <div className="h-20 w-20 shrink-0 rounded-lg border bg-muted flex items-center justify-center">
            <Package className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-tight">{product.title}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{product.vendor}</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant={product.status === "active" ? "default" : "secondary"}>
              {product.status}
            </Badge>
            {shopifyUrl && (
              <Link
                href={shopifyUrl}
                target="_blank"
                className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground"
              >
                Shopify <ExternalLink className="h-3 w-3" />
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Edit form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Edit Listing</CardTitle>
          <p className="text-xs text-muted-foreground">
            Changes sync to your Clandestine Shopify store automatically.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="desc">Description (HTML)</Label>
            <Textarea
              id="desc"
              value={form.descriptionHtml}
              onChange={(e) => setForm((f) => ({ ...f, descriptionHtml: e.target.value }))}
              rows={5}
              placeholder="HTML description — syncs to Shopify descriptionHtml"
              className="font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="type">Product Type</Label>
              <select
                id="type"
                value={form.productType}
                onChange={(e) => setForm((f) => ({ ...f, productType: e.target.value }))}
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              >
                <option value="">—</option>
                {PRODUCT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                value={form.status}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    status: e.target.value as "active" | "draft" | "archived",
                  }))
                }
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              >
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tags">Tags (comma-separated)</Label>
            <Input
              id="tags"
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              placeholder="vinyl, limited edition, jazz"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Changes
            </Button>
            {saved && <span className="text-sm text-green-600">Saved successfully</span>}
          </div>
        </CardContent>
      </Card>

      {/* Variants — read-only (pricing set by Clandestine) */}
      {variants.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Variants</CardTitle>
            <p className="text-xs text-muted-foreground">
              Pricing and inventory are managed by Clandestine. Contact support to update these.
            </p>
          </CardHeader>
          <CardContent className="p-4">
            <BlockList
              items={variants}
              itemKey={(v) => v.id}
              density="ops"
              ariaLabel="Product variants"
              renderHeader={({ row: v }) => (
                <div className="min-w-0">
                  <p className="font-mono text-xs">{v.sku}</p>
                  <p className="text-sm text-muted-foreground">{v.format_name ?? v.title ?? "—"}</p>
                </div>
              )}
              renderExceptionZone={({ row: v }) => (
                <Badge variant="outline">{v.price != null ? `$${v.price.toFixed(2)}` : "—"}</Badge>
              )}
              renderBody={({ row: v }) => {
                const inv = v.warehouse_inventory_levels?.[0];
                return (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <VariantMetric label="Available" value={inv?.available ?? 0} />
                    <VariantMetric label="Committed" value={inv?.committed ?? 0} />
                  </div>
                );
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function VariantMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-mono">{value}</p>
    </div>
  );
}
