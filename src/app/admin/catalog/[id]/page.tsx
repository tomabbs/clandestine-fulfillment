"use client";

import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { getProductDetail, updateProduct, updateVariants } from "@/actions/catalog";
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

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  draft: "secondary",
  archived: "outline",
};

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const productId = params.id;

  const { data: product, isLoading } = useAppQuery({
    queryKey: queryKeys.products.detail(productId),
    queryFn: () => getProductDetail(productId),
    tier: CACHE_TIERS.STABLE,
  });

  // Edit state
  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editProductType, setEditProductType] = useState("");
  const [editTags, setEditTags] = useState("");

  const startEdit = useCallback(() => {
    if (!product) return;
    setEditTitle(product.title);
    setEditProductType(product.product_type ?? "");
    setEditTags((product.tags as string[])?.join(", ") ?? "");
    setEditMode(true);
  }, [product]);

  // Rule #1: productUpdate, NOT productSet
  const productMutation = useAppMutation({
    mutationFn: () =>
      updateProduct(productId, {
        title: editTitle,
        productType: editProductType || undefined,
        tags: editTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    invalidateKeys: [queryKeys.products.detail(productId), queryKeys.products.all],
    onSuccess: () => setEditMode(false),
  });

  // Variant edit state
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [variantPrice, setVariantPrice] = useState("");
  const [variantCompareAt, setVariantCompareAt] = useState("");
  const [variantWeight, setVariantWeight] = useState("");

  const startVariantEdit = useCallback((variant: WarehouseProductVariant) => {
    setEditingVariantId(variant.id);
    setVariantPrice(variant.price?.toString() ?? "");
    setVariantCompareAt(variant.compare_at_price?.toString() ?? "");
    setVariantWeight(variant.weight?.toString() ?? "");
  }, []);

  // Rule #1: productVariantsBulkUpdate, NOT productSet
  const variantMutation = useAppMutation({
    mutationFn: () => {
      const variant = (product?.warehouse_product_variants as WarehouseProductVariant[])?.find(
        (v) => v.id === editingVariantId,
      );
      if (!variant) throw new Error("Variant not found");
      return updateVariants(productId, [
        {
          id: variant.id,
          shopifyVariantId: variant.shopify_variant_id ?? "",
          price: variantPrice || undefined,
          compareAtPrice: variantCompareAt || null,
          weight: variantWeight ? Number(variantWeight) : undefined,
        },
      ]);
    },
    invalidateKeys: [queryKeys.products.detail(productId), queryKeys.products.all],
    onSuccess: () => setEditingVariantId(null),
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Loading product...</p>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Product not found.</p>
      </div>
    );
  }

  const variants = (product.warehouse_product_variants ?? []) as WarehouseProductVariant[];
  const images = (product.warehouse_product_images ?? []) as WarehouseProductImage[];
  const inventoryLevels = (product.inventoryLevels ?? []) as WarehouseInventoryLevel[];
  const variantLocations = (product.variantLocations ?? []) as VariantLocation[];
  const bandcampMappings = (product.bandcampMappings ?? []) as BandcampProductMapping[];
  const org = product.organizations as { id: string; name: string } | null;

  return (
    <div className="p-6 space-y-6">
      {/* Back link + header */}
      <div className="flex items-center gap-3">
        <Link href="/admin/catalog">
          <Button variant="ghost" size="icon-sm">
            <ArrowLeftIcon className="size-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{product.title}</h1>
            <Badge variant={STATUS_VARIANTS[product.status] ?? "outline"}>{product.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {org?.name ?? product.vendor ?? "Unknown vendor"}
            {product.shopify_product_id && (
              <>
                {" · "}
                <a
                  href={`https://${product.shopify_handle ? "" : "admin.shopify.com"}/products/${product.shopify_product_id}`}
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
            <CardTitle>Edit Product</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-sm font-medium" htmlFor="edit-title">
                Title
              </label>
              <Input
                id="edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.currentTarget.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="edit-type">
                Product Type
              </label>
              <Input
                id="edit-type"
                value={editProductType}
                onChange={(e) => setEditProductType(e.currentTarget.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="edit-tags">
                Tags (comma-separated)
              </label>
              <Input
                id="edit-tags"
                value={editTags}
                onChange={(e) => setEditTags(e.currentTarget.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => productMutation.mutate(undefined)}
                disabled={productMutation.isPending}
              >
                {productMutation.isPending ? "Saving..." : "Save"}
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
          <TabsTrigger value="variants">Variants</TabsTrigger>
          <TabsTrigger value="images">Images</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="bandcamp">Bandcamp</TabsTrigger>
        </TabsList>

        {/* Variants Tab */}
        <TabsContent value="variants">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Compare At</TableHead>
                <TableHead>Barcode</TableHead>
                <TableHead>Weight</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Pre-Order</TableHead>
                <TableHead>Street Date</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((variant) => (
                <TableRow key={variant.id}>
                  {editingVariantId === variant.id ? (
                    <>
                      <TableCell className="font-mono text-xs">{variant.sku}</TableCell>
                      <TableCell>{variant.title ?? "—"}</TableCell>
                      <TableCell>
                        <Input
                          className="w-24"
                          value={variantPrice}
                          onChange={(e) => setVariantPrice(e.currentTarget.value)}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          className="w-24"
                          value={variantCompareAt}
                          onChange={(e) => setVariantCompareAt(e.currentTarget.value)}
                        />
                      </TableCell>
                      <TableCell>{variant.barcode ?? "—"}</TableCell>
                      <TableCell>
                        <Input
                          className="w-20"
                          value={variantWeight}
                          onChange={(e) => setVariantWeight(e.currentTarget.value)}
                        />
                      </TableCell>
                      <TableCell>{variant.format_name ?? "—"}</TableCell>
                      <TableCell>{variant.is_preorder ? "Yes" : "No"}</TableCell>
                      <TableCell>{variant.street_date ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="xs"
                            onClick={() => variantMutation.mutate(undefined)}
                            disabled={variantMutation.isPending}
                          >
                            Save
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setEditingVariantId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="font-mono text-xs">{variant.sku}</TableCell>
                      <TableCell>{variant.title ?? "—"}</TableCell>
                      <TableCell>
                        {variant.price != null ? `$${Number(variant.price).toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell>
                        {variant.compare_at_price != null
                          ? `$${Number(variant.compare_at_price).toFixed(2)}`
                          : "—"}
                      </TableCell>
                      <TableCell>{variant.barcode ?? "—"}</TableCell>
                      <TableCell>
                        {variant.weight != null ? `${variant.weight} ${variant.weight_unit}` : "—"}
                      </TableCell>
                      <TableCell>{variant.format_name ?? "—"}</TableCell>
                      <TableCell>{variant.is_preorder ? "Yes" : "No"}</TableCell>
                      <TableCell>{variant.street_date ?? "—"}</TableCell>
                      <TableCell>
                        <Button size="xs" variant="ghost" onClick={() => startVariantEdit(variant)}>
                          Edit
                        </Button>
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
              {variants.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-4 text-muted-foreground">
                    No variants.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TabsContent>

        {/* Images Tab */}
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

        {/* Inventory Tab */}
        <TabsContent value="inventory">
          <div className="space-y-4">
            {variants.map((variant) => {
              const inv = inventoryLevels.find((l) => l.variant_id === variant.id);
              const locations = variantLocations.filter((vl) => vl.variant_id === variant.id);

              return (
                <Card key={variant.id} size="sm">
                  <CardHeader>
                    <CardTitle>
                      {variant.sku} — {variant.title ?? "Default"}
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

                    {locations.length > 0 && (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Location</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Quantity</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {locations.map((loc) => (
                            <TableRow key={loc.id}>
                              <TableCell>{loc.warehouse_locations?.name ?? "Unknown"}</TableCell>
                              <TableCell>{loc.warehouse_locations?.location_type ?? "—"}</TableCell>
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

        {/* Bandcamp Tab */}
        <TabsContent value="bandcamp">
          {bandcampMappings.length > 0 ? (
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
                {bandcampMappings.map((mapping) => {
                  const variant = variants.find((v) => v.id === mapping.variant_id);
                  return (
                    <TableRow key={mapping.id}>
                      <TableCell className="font-mono text-xs">
                        {variant?.sku ?? mapping.variant_id}
                      </TableCell>
                      <TableCell>
                        {mapping.bandcamp_url ? (
                          <a
                            href={mapping.bandcamp_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                          >
                            {mapping.bandcamp_url}
                            <ExternalLinkIcon className="size-3" />
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{mapping.bandcamp_type_name ?? "—"}</TableCell>
                      <TableCell>{mapping.bandcamp_new_date ?? "—"}</TableCell>
                      <TableCell>{mapping.last_quantity_sold ?? "—"}</TableCell>
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
  );
}
