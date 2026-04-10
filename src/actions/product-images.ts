"use server";

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { WarehouseProductImage } from "@/lib/shared/types";

// === Zod schemas (Rule #5) ===

const uploadSchema = z.object({
  productId: z.string().uuid(),
  alt: z.string().max(500).optional(),
});

const reorderSchema = z.object({
  productId: z.string().uuid(),
  imageIds: z.array(z.string().uuid()).min(1),
});

const deleteSchema = z.object({
  imageId: z.string().uuid(),
});

const setFeaturedSchema = z.object({
  productId: z.string().uuid(),
  imageId: z.string().uuid(),
});

// === Helpers ===

const BUCKET = "product-images";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Upload a product image to Supabase Storage, insert DB row,
 * and push to Shopify via productUpdate.
 *
 * Rule #68: browser uploads directly to Storage, but staff portal
 * images are small enough (<10 MB) to go through Server Actions.
 */
export async function uploadProductImage(
  rawData: { productId: string; alt?: string },
  formData: FormData,
): Promise<WarehouseProductImage> {
  const { userRecord } = await requireAuth();
  const data = uploadSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Validate file
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file provided");
  if (file.size > MAX_FILE_SIZE) throw new Error("File exceeds 10 MB limit");
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}. Allowed: JPEG, PNG, WebP, GIF`);
  }

  // Verify product exists and belongs to user's workspace
  const { data: product, error: productErr } = await serviceClient
    .from("warehouse_products")
    .select("id, workspace_id, shopify_product_id")
    .eq("id", data.productId)
    .eq("workspace_id", userRecord.workspace_id)
    .single();

  if (productErr || !product) throw new Error("Product not found");

  // Determine next position
  const { count } = await serviceClient
    .from("warehouse_product_images")
    .select("id", { count: "exact", head: true })
    .eq("product_id", data.productId);

  const position = count ?? 0;

  // Upload to Supabase Storage
  const ext = file.name.split(".").pop() ?? "jpg";
  const storagePath = `${userRecord.workspace_id}/${data.productId}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadErr } = await serviceClient.storage
    .from(BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });

  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

  // Get public URL
  const { data: urlData } = serviceClient.storage.from(BUCKET).getPublicUrl(storagePath);
  const publicUrl = urlData.publicUrl;

  // Insert DB row
  const { data: image, error: insertErr } = await serviceClient
    .from("warehouse_product_images")
    .insert({
      product_id: data.productId,
      workspace_id: userRecord.workspace_id,
      position,
      src: publicUrl,
      alt: data.alt ?? null,
    })
    .select()
    .single();

  if (insertErr || !image) throw new Error(`Failed to save image: ${insertErr?.message}`);

  // Push to Shopify if connected (non-blocking — Shopify failure doesn't roll back).
  // productUpdate+images was removed in 2024-01; use productCreateMedia instead.
  if (product.shopify_product_id) {
    try {
      const { productCreateMedia } = await import("@/lib/clients/shopify-client");
      await productCreateMedia(product.shopify_product_id, [
        { originalSource: publicUrl, alt: data.alt ?? "", mediaContentType: "IMAGE" },
      ]);
    } catch {
      // Shopify push is best-effort; image is saved locally regardless
    }
  }

  // If this is the first image, set it as the product's featured image
  if (position === 0) {
    await serviceClient
      .from("warehouse_products")
      .update({ images: [{ src: publicUrl }], updated_at: new Date().toISOString() })
      .eq("id", data.productId);
  }

  return image as WarehouseProductImage;
}

/**
 * Reorder product images by setting position based on array order.
 */
export async function reorderProductImages(rawData: {
  productId: string;
  imageIds: string[];
}): Promise<{ success: true }> {
  await requireAuth();
  const data = reorderSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  for (let i = 0; i < data.imageIds.length; i++) {
    await serviceClient
      .from("warehouse_product_images")
      .update({ position: i })
      .eq("id", data.imageIds[i])
      .eq("product_id", data.productId);
  }

  // Update featured image URL to the first image in the new order
  const { data: firstImage } = await serviceClient
    .from("warehouse_product_images")
    .select("src")
    .eq("id", data.imageIds[0])
    .single();

  if (firstImage) {
    await serviceClient
      .from("warehouse_products")
      .update({ images: [{ src: firstImage.src }], updated_at: new Date().toISOString() })
      .eq("id", data.productId);
  }

  return { success: true };
}

/**
 * Delete a product image from Storage and DB.
 * Does NOT delete from Shopify (Shopify manages its own image lifecycle).
 */
export async function deleteProductImage(rawData: { imageId: string }): Promise<{ success: true }> {
  await requireAuth();
  const data = deleteSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Fetch image to get storage path and product context
  const { data: image, error: fetchErr } = await serviceClient
    .from("warehouse_product_images")
    .select("id, product_id, src, position")
    .eq("id", data.imageId)
    .single();

  if (fetchErr || !image) throw new Error("Image not found");

  // Extract storage path from public URL
  const bucketUrl = `/storage/v1/object/public/${BUCKET}/`;
  const urlIndex = image.src.indexOf(bucketUrl);
  if (urlIndex !== -1) {
    const storagePath = image.src.slice(urlIndex + bucketUrl.length);
    await serviceClient.storage.from(BUCKET).remove([storagePath]);
  }

  // Delete DB row
  const { error: deleteErr } = await serviceClient
    .from("warehouse_product_images")
    .delete()
    .eq("id", data.imageId);

  if (deleteErr) throw new Error(`Failed to delete image: ${deleteErr.message}`);

  // If this was the featured image (position 0), promote the next one
  if (image.position === 0) {
    const { data: nextImage } = await serviceClient
      .from("warehouse_product_images")
      .select("src")
      .eq("product_id", image.product_id)
      .order("position", { ascending: true })
      .limit(1)
      .single();

    await serviceClient
      .from("warehouse_products")
      .update({
        images: nextImage ? [{ src: nextImage.src }] : [],
        updated_at: new Date().toISOString(),
      })
      .eq("id", image.product_id);
  }

  return { success: true };
}

/**
 * Set a specific image as the featured (position 0) image.
 * Shifts other images' positions accordingly.
 */
export async function setFeaturedImage(rawData: {
  productId: string;
  imageId: string;
}): Promise<{ success: true }> {
  await requireAuth();
  const data = setFeaturedSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Get all images for the product, ordered by current position
  const { data: images, error: fetchErr } = await serviceClient
    .from("warehouse_product_images")
    .select("id, position, src")
    .eq("product_id", data.productId)
    .order("position", { ascending: true });

  if (fetchErr || !images?.length) throw new Error("No images found");

  const targetImage = images.find((img) => img.id === data.imageId);
  if (!targetImage) throw new Error("Image not found for this product");

  // Build new order: target first, then the rest in their existing order
  const reordered = [targetImage, ...images.filter((img) => img.id !== data.imageId)];

  for (let i = 0; i < reordered.length; i++) {
    await serviceClient
      .from("warehouse_product_images")
      .update({ position: i })
      .eq("id", reordered[i].id);
  }

  // Update product's featured image URL
  await serviceClient
    .from("warehouse_products")
    .update({ images: [{ src: targetImage.src }], updated_at: new Date().toISOString() })
    .eq("id", data.productId);

  return { success: true };
}
