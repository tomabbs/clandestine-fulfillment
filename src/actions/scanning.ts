"use server";

import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// === Zod Schemas ===

const barcodeSchema = z.string().min(1).max(128);

const countItemSchema = z.object({
  sku: z.string().min(1),
  scannedCount: z.number().int().min(0),
  expectedCount: z.number().int().min(0),
});

const submitCountSchema = z.object({
  locationId: z.string().uuid(),
  counts: z.array(countItemSchema).min(1),
});

const recordReceivingSchema = z.object({
  inboundItemId: z.string().uuid(),
  quantity: z.number().int().min(1),
});

// === Actions ===

export async function lookupBarcode(barcode: string) {
  const parsed = barcodeSchema.safeParse(barcode);
  if (!parsed.success) {
    return { error: "Invalid barcode" };
  }

  const supabase = await createServerSupabaseClient();

  // Search by barcode or SKU
  const { data: variant, error: variantError } = await supabase
    .from("warehouse_product_variants")
    .select("*")
    .or(`barcode.eq.${parsed.data},sku.eq.${parsed.data}`)
    .limit(1)
    .single();

  if (variantError || !variant) {
    return { error: "Product not found" };
  }

  // Fetch product details
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("*")
    .eq("id", variant.product_id)
    .single();

  // Fetch inventory level
  const { data: inventory } = await supabase
    .from("warehouse_inventory_levels")
    .select("*")
    .eq("variant_id", variant.id)
    .single();

  // Fetch all locations for this variant
  const { data: locations } = await supabase
    .from("warehouse_variant_locations")
    .select("*, warehouse_locations(*)")
    .eq("variant_id", variant.id);

  return {
    variant,
    product,
    inventory,
    locations: locations ?? [],
  };
}

export async function submitCount(
  locationId: string,
  counts: Array<{ sku: string; scannedCount: number; expectedCount: number }>,
) {
  const parsed = submitCountSchema.safeParse({ locationId, counts });
  if (!parsed.success) {
    return { error: "Invalid count data", details: parsed.error.flatten() };
  }

  const supabase = await createServerSupabaseClient();

  const mismatches = parsed.data.counts.filter((c) => c.scannedCount !== c.expectedCount);
  const matches = parsed.data.counts.filter((c) => c.scannedCount === c.expectedCount);

  // Create review queue items for mismatches
  if (mismatches.length > 0) {
    const reviewItems = mismatches.map((m) => ({
      category: "count_discrepancy",
      severity: Math.abs(m.scannedCount - m.expectedCount) > 5 ? "high" : ("medium" as const),
      title: `Count mismatch: ${m.sku}`,
      description: `Location count discrepancy. Expected: ${m.expectedCount}, Scanned: ${m.scannedCount}, Difference: ${m.scannedCount - m.expectedCount}`,
      metadata: {
        location_id: parsed.data.locationId,
        sku: m.sku,
        expected: m.expectedCount,
        scanned: m.scannedCount,
        delta: m.scannedCount - m.expectedCount,
      },
      status: "open" as const,
      group_key: `count:${parsed.data.locationId}:${m.sku}`,
      occurrence_count: 1,
    }));

    const { error: reviewError } = await supabase
      .from("warehouse_review_queue")
      .upsert(reviewItems, {
        onConflict: "group_key",
        ignoreDuplicates: false,
      });

    if (reviewError) {
      return { error: "Failed to create review items", details: reviewError.message };
    }
  }

  // Update confirmed counts in warehouse_variant_locations
  for (const match of matches) {
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id")
      .eq("sku", match.sku)
      .limit(1)
      .single();

    if (variant) {
      await supabase
        .from("warehouse_variant_locations")
        .update({ quantity: match.scannedCount })
        .eq("variant_id", variant.id)
        .eq("location_id", parsed.data.locationId);
    }
  }

  return {
    matchedCount: matches.length,
    mismatchCount: mismatches.length,
    mismatches: mismatches.map((m) => ({
      sku: m.sku,
      expected: m.expectedCount,
      scanned: m.scannedCount,
    })),
  };
}

export async function recordReceivingScan(inboundItemId: string, quantity: number) {
  const parsed = recordReceivingSchema.safeParse({ inboundItemId, quantity });
  if (!parsed.success) {
    return { error: "Invalid receiving data", details: parsed.error.flatten() };
  }

  const supabase = await createServerSupabaseClient();

  // Get current inbound item
  const { data: item, error: itemError } = await supabase
    .from("warehouse_inbound_items")
    .select("*")
    .eq("id", parsed.data.inboundItemId)
    .single();

  if (itemError || !item) {
    return { error: "Inbound item not found" };
  }

  const newReceived = (item.received_quantity ?? 0) + parsed.data.quantity;

  const { error: updateError } = await supabase
    .from("warehouse_inbound_items")
    .update({ received_quantity: newReceived })
    .eq("id", parsed.data.inboundItemId);

  if (updateError) {
    return { error: "Failed to update received quantity", details: updateError.message };
  }

  return {
    inboundItemId: parsed.data.inboundItemId,
    sku: item.sku,
    previousReceived: item.received_quantity ?? 0,
    newReceived,
    expectedQuantity: item.expected_quantity,
    isComplete: newReceived >= item.expected_quantity,
    isOver: newReceived > item.expected_quantity,
  };
}
