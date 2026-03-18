"use client";

import { ArrowLeftIcon, ExternalLinkIcon, Plus, Save } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getProductDetail, updateProduct, updateVariants } from "@/actions/catalog";
import {
  CollabField,
  CollaborativePage,
  PresenceBar,
} from "@/components/shared/collaborative-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type {
  BandcampProductMapping,
  WarehouseInventoryLevel,
  WarehouseProductImage,
  WarehouseProductVariant,
  WarehouseVariantLocation,
} from "@/lib/shared/types";

type VariantLocation = WarehouseVariantLocation & {
  warehouse_locations: { name: string; location_type: string } | null;
};

const STATUS_BADGE: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  draft: "secondary",
  archived: "outline",
};
const PRODUCT_TYPES = ["LP", "CD", "Cassette", "Shirt", "Bundle", "Merch", "Other"];
const WEIGHT_UNITS = ["lb", "oz", "kg", "g"];

interface VariantRowState {
  title: string;
  price: string;
  compareAt: string;
  weight: string;
  weightUnit: string;
  barcode: string;
}

function variantToRow(v: WarehouseProductVariant): VariantRowState {
  return {
    title: v.title ?? "",
    price: v.price != null ? String(v.price) : "",
    compareAt: v.compare_at_price != null ? String(v.compare_at_price) : "",
    weight: v.weight != null ? String(v.weight) : "",
    weightUnit: v.weight_unit ?? "lb",
    barcode: v.barcode ?? "",
  };
}

export default function ProductDetailPage() {
  const { id: productId } = useParams<{ id: string }>();

  const { data: product, isLoading } = useAppQuery({
    queryKey: queryKeys.products.detail(productId),
    queryFn: () => getProductDetail(productId),
    tier: CACHE_TIERS.STABLE,
  });

  // Product edit
  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editVendor, setEditVendor] = useState("");
  const [editType, setEditType] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editStatus, setEditStatus] = useState<"active" | "draft" | "archived">("active");

  const startEdit = useCallback(() => {
    if (!product) return;
    setEditTitle(product.title);
    setEditDesc("");
    setEditVendor(product.vendor ?? "");
    setEditType(product.product_type ?? "");
    setEditTags((product.tags as string[])?.join(", ") ?? "");
    setEditStatus(product.status as "active" | "draft" | "archived");
    setEditMode(true);
  }, [product]);

  const productMut = useAppMutation({
    mutationFn: () =>
      updateProduct(productId, {
        title: editTitle,
        ...(editDesc && { descriptionHtml: editDesc }),
        vendor: editVendor || undefined,
        productType: editType || undefined,
        tags: editTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        status: editStatus,
      }),
    invalidateKeys: [queryKeys.products.detail(productId), queryKeys.products.all],
    onSuccess: () => setEditMode(false),
  });

  // Variant inline edit
  const [vEdits, setVEdits] = useState<Record<string, VariantRowState>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const variants = (product?.warehouse_product_variants ?? []) as WarehouseProductVariant[];

  useEffect(() => {
    if (variants.length > 0 && Object.keys(vEdits).length === 0) {
      const init: Record<string, VariantRowState> = {};
      for (const v of variants) init[v.id] = variantToRow(v);
      setVEdits(init);
    }
  }, [variants, vEdits]);

  const setField = (id: string, f: keyof VariantRowState, val: string) => {
    setVEdits((p) => ({ ...p, [id]: { ...p[id], [f]: val } }));
    setDirty((p) => new Set(p).add(id));
  };

  const variantMut = useAppMutation({
    mutationFn: () => {
      const ups = Array.from(dirty)
        .map((id) => {
          const o = variants.find((v) => v.id === id);
          const e = vEdits[id];
          if (!o || !e) return null;
          return {
            id: o.id,
            shopifyVariantId: o.shopify_variant_id ?? "",
            price: e.price || undefined,
            compareAtPrice: e.compareAt || null,
            weight: e.weight ? Number(e.weight) : undefined,
            weightUnit: e.weightUnit,
            barcode: e.barcode || null,
          };
        })
        .filter(Boolean) as Array<{
        id: string;
        shopifyVariantId: string;
        price?: string;
        compareAtPrice?: string | null;
        weight?: number;
        weightUnit?: string;
        barcode?: string | null;
      }>;
      return updateVariants(productId, ups);
    },
    invalidateKeys: [queryKeys.products.detail(productId), queryKeys.products.all],
    onSuccess: () => setDirty(new Set()),
  });

  if (isLoading)
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Loading product...</p>
      </div>
    );
  if (!product)
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Product not found.</p>
      </div>
    );

  const images = (product.warehouse_product_images ?? []) as WarehouseProductImage[];
  const invLevels = (product.inventoryLevels ?? []) as WarehouseInventoryLevel[];
  const varLocs = (product.variantLocations ?? []) as VariantLocation[];
  const bcMappings = (product.bandcampMappings ?? []) as BandcampProductMapping[];
  const org = product.organizations as { id: string; name: string } | null;

  return (
    <CollaborativePage resourceType="product" resourceId={productId}>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/admin/catalog">
            <Button variant="ghost" size="icon-sm">
              <ArrowLeftIcon className="size-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{product.title}</h1>
              <Badge variant={STATUS_BADGE[product.status] ?? "outline"}>{product.status}</Badge>
              <PresenceBar />
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {org?.name ?? product.vendor ?? "Unknown vendor"}
              {product.shopify_product_id && (
                <>
                  {" · "}
                  <a
                    href={`https://admin.shopify.com/store/kw16ph-t9/products/${product.shopify_product_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                  >
                    Shopify <ExternalLinkIcon className="size-3" />
                  </a>
                </>
              )}
            </p>
          </div>
          {!editMode && (
            <Button variant="outline" onClick={startEdit}>
              Edit Product
            </Button>
          )}
        </div>

        {/* Edit form */}
        {editMode && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Edit Product</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Changes sync to Shopify automatically
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <CollabField name="title">
                  <div className="col-span-2">
                    <label className="text-sm font-medium" htmlFor="ed-title">
                      Title
                    </label>
                    <Input
                      id="ed-title"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.currentTarget.value)}
                    />
                  </div>
                </CollabField>
                <CollabField name="description">
                  <div className="col-span-2">
                    <label className="text-sm font-medium" htmlFor="ed-desc">
                      Description (HTML)
                    </label>
                    <textarea
                      id="ed-desc"
                      rows={5}
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      placeholder="HTML description — syncs to Shopify descriptionHtml"
                      className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm font-mono"
                    />
                  </div>
                </CollabField>
                <CollabField name="vendor">
                  <div>
                    <label className="text-sm font-medium" htmlFor="ed-vendor">
                      Vendor
                    </label>
                    <Input
                      id="ed-vendor"
                      value={editVendor}
                      onChange={(e) => setEditVendor(e.currentTarget.value)}
                    />
                  </div>
                </CollabField>
                <div>
                  <label className="text-sm font-medium" htmlFor="ed-type">
                    Product Type
                  </label>
                  <select
                    id="ed-type"
                    value={editType}
                    onChange={(e) => setEditType(e.target.value)}
                    className="border-input bg-background w-full h-9 rounded-md border px-3 text-sm"
                  >
                    <option value="">Select type...</option>
                    {PRODUCT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                    {editType && !PRODUCT_TYPES.includes(editType) && (
                      <option value={editType}>{editType}</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium" htmlFor="ed-tags">
                    Tags (comma-separated)
                  </label>
                  <Input
                    id="ed-tags"
                    value={editTags}
                    onChange={(e) => setEditTags(e.currentTarget.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium" htmlFor="ed-status">
                    Status
                  </label>
                  <select
                    id="ed-status"
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value as typeof editStatus)}
                    className="border-input bg-background w-full h-9 rounded-md border px-3 text-sm"
                  >
                    <option value="active">Active</option>
                    <option value="draft">Draft</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <Button
                  onClick={() => productMut.mutate(undefined)}
                  disabled={productMut.isPending}
                >
                  <Save className="h-4 w-4 mr-1" />
                  {productMut.isPending ? "Saving..." : "Save Product"}
                </Button>
                <Button variant="outline" onClick={() => setEditMode(false)}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="variants">
          <TabsList>
            <TabsTrigger value="variants">Variants ({variants.length})</TabsTrigger>
            <TabsTrigger value="images">Images ({images.length})</TabsTrigger>
            <TabsTrigger value="inventory">Inventory</TabsTrigger>
            <TabsTrigger value="bandcamp">Bandcamp</TabsTrigger>
          </TabsList>

          {/* Variants — inline editable */}
          <TabsContent value="variants">
            <div className="space-y-3">
              {dirty.size > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => variantMut.mutate(undefined)}
                    disabled={variantMut.isPending}
                  >
                    <Save className="h-3 w-3 mr-1" />
                    {variantMut.isPending
                      ? "Saving..."
                      : `Save ${dirty.size} variant${dirty.size > 1 ? "s" : ""}`}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {dirty.size} unsaved change{dirty.size > 1 ? "s" : ""}
                  </span>
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Option Title</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="w-24">Price</TableHead>
                    <TableHead className="w-24">Compare At</TableHead>
                    <TableHead className="w-20">Weight</TableHead>
                    <TableHead className="w-16">Unit</TableHead>
                    <TableHead>Barcode</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variants.map((v) => {
                    const e = vEdits[v.id];
                    if (!e) return null;
                    return (
                      <TableRow key={v.id} className={dirty.has(v.id) ? "bg-amber-50/50" : ""}>
                        <TableCell>
                          <Input
                            className="h-8 text-sm"
                            value={e.title}
                            onChange={(ev) => setField(v.id, "title", ev.currentTarget.value)}
                          />
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-xs text-muted-foreground">{v.sku}</span>
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 text-sm w-24"
                            type="number"
                            step="0.01"
                            value={e.price}
                            onChange={(ev) => setField(v.id, "price", ev.currentTarget.value)}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 text-sm w-24"
                            type="number"
                            step="0.01"
                            value={e.compareAt}
                            onChange={(ev) => setField(v.id, "compareAt", ev.currentTarget.value)}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 text-sm w-20"
                            type="number"
                            step="0.01"
                            value={e.weight}
                            onChange={(ev) => setField(v.id, "weight", ev.currentTarget.value)}
                          />
                        </TableCell>
                        <TableCell>
                          <select
                            className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                            value={e.weightUnit}
                            onChange={(ev) => setField(v.id, "weightUnit", ev.target.value)}
                          >
                            {WEIGHT_UNITS.map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                          </select>
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 text-sm"
                            value={e.barcode}
                            onChange={(ev) => setField(v.id, "barcode", ev.currentTarget.value)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {variants.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-4 text-muted-foreground">
                        No variants.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <Button variant="outline" size="sm" disabled>
                <Plus className="h-3 w-3 mr-1" /> Add Variant
              </Button>
            </div>
          </TabsContent>

          {/* Images */}
          <TabsContent value="images">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {images
                .sort((a, b) => a.position - b.position)
                .map((img) => (
                  <div key={img.id} className="rounded-lg overflow-hidden border">
                    <Image
                      src={img.src}
                      alt={img.alt ?? product.title}
                      width={300}
                      height={300}
                      className="object-cover w-full aspect-square"
                    />
                    {img.alt && (
                      <p className="px-2 py-1 text-xs text-muted-foreground truncate">{img.alt}</p>
                    )}
                  </div>
                ))}
              {images.length === 0 && (
                <p className="col-span-full text-muted-foreground py-4">No images.</p>
              )}
            </div>
          </TabsContent>

          {/* Inventory */}
          <TabsContent value="inventory">
            <div className="space-y-4">
              {variants.map((v) => {
                const inv = invLevels.find((l) => l.variant_id === v.id);
                const locs = varLocs.filter((vl) => vl.variant_id === v.id);
                return (
                  <Card key={v.id}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">
                        {v.sku} — {v.title ?? "Default"}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {inv ? (
                        <div className="grid grid-cols-3 gap-4 mb-3">
                          <div>
                            <p className="text-xs text-muted-foreground">Available</p>
                            <p className="text-lg font-semibold">{inv.available}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Committed</p>
                            <p className="text-lg font-semibold">{inv.committed}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Incoming</p>
                            <p className="text-lg font-semibold">{inv.incoming}</p>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground mb-3">No inventory data.</p>
                      )}
                      {locs.length > 0 && (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Location</TableHead>
                              <TableHead>Type</TableHead>
                              <TableHead>Quantity</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {locs.map((loc) => (
                              <TableRow key={loc.id}>
                                <TableCell>{loc.warehouse_locations?.name ?? "Unknown"}</TableCell>
                                <TableCell>
                                  {loc.warehouse_locations?.location_type ?? "—"}
                                </TableCell>
                                <TableCell>{loc.quantity}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
              {variants.length === 0 && (
                <p className="text-muted-foreground py-4">No variants to show inventory for.</p>
              )}
            </div>
          </TabsContent>

          {/* Bandcamp */}
          <TabsContent value="bandcamp">
            {bcMappings.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Variant</TableHead>
                    <TableHead>Bandcamp URL</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>New Date</TableHead>
                    <TableHead>Last Qty Sold</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bcMappings.map((m) => {
                    const v = variants.find((x) => x.id === m.variant_id);
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="font-mono text-xs">
                          {v?.sku ?? m.variant_id}
                        </TableCell>
                        <TableCell>
                          {m.bandcamp_url ? (
                            <a
                              href={m.bandcamp_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                            >
                              {m.bandcamp_url} <ExternalLinkIcon className="size-3" />
                            </a>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>{m.bandcamp_type_name ?? "—"}</TableCell>
                        <TableCell>{m.bandcamp_new_date ?? "—"}</TableCell>
                        <TableCell>{m.last_quantity_sold ?? "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground py-4">No Bandcamp mappings for this product.</p>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </CollaborativePage>
  );
}
