"use server";

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const componentSchema = z.object({
  componentVariantId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
});

export async function getBundleComponents(bundleVariantId: string) {
  await requireAuth();
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("bundle_components")
    .select(`
      id, quantity, component_variant_id,
      warehouse_product_variants!component_variant_id (
        id, sku, title,
        warehouse_inventory_levels (available, safety_stock),
        warehouse_products!inner (title, vendor)
      )
    `)
    .eq("bundle_variant_id", bundleVariantId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function setBundleComponents(
  bundleVariantId: string,
  components: { componentVariantId: string; quantity: number }[],
) {
  await requireAuth();
  const parsed = components.map((c) => componentSchema.parse(c));
  const supabase = createServiceRoleClient();

  // Resolve workspace_id from the bundle variant
  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("workspace_id")
    .eq("id", bundleVariantId)
    .single();
  if (!variant) throw new Error("Bundle variant not found");

  // Full graph DFS cycle detection — prevents A→B→C→A chains that would cause
  // infinite loops in the bundle MIN calculation and impossible availability math.
  const { data: allExistingComponents } = await supabase
    .from("bundle_components")
    .select("bundle_variant_id, component_variant_id")
    .eq("workspace_id", variant.workspace_id);

  // Build current bundle graph (excluding rows for this bundle which will be replaced)
  const graph = new Map<string, string[]>();
  for (const bc of allExistingComponents ?? []) {
    if (bc.bundle_variant_id === bundleVariantId) continue; // will be replaced
    const children = graph.get(bc.bundle_variant_id) ?? [];
    children.push(bc.component_variant_id);
    graph.set(bc.bundle_variant_id, children);
  }
  // Add proposed new components to the graph for cycle checking
  graph.set(
    bundleVariantId,
    parsed.map((c) => c.componentVariantId),
  );

  // DFS from each proposed component to check if it can reach bundleVariantId
  // O(n × graph_size) — fine for typical catalog sizes (<1000 bundles per workspace)
  function wouldCreateCycle(startComponentId: string): boolean {
    const visited = new Set<string>();
    const stack = [startComponentId];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === bundleVariantId) return true; // cycle detected
      if (visited.has(node)) continue;
      visited.add(node);
      for (const child of graph.get(node) ?? []) stack.push(child);
    }
    return false;
  }

  for (const c of parsed) {
    if (wouldCreateCycle(c.componentVariantId)) {
      throw new Error(
        `Circular reference detected: adding component ${c.componentVariantId} to bundle ` +
          `${bundleVariantId} would create a cycle in the bundle graph.`,
      );
    }
  }

  // Atomic replace: delete existing, insert new
  await supabase.from("bundle_components").delete().eq("bundle_variant_id", bundleVariantId);

  if (parsed.length > 0) {
    const rows = parsed.map((c) => ({
      workspace_id: variant.workspace_id,
      bundle_variant_id: bundleVariantId,
      component_variant_id: c.componentVariantId,
      quantity: c.quantity,
    }));
    const { error } = await supabase.from("bundle_components").insert(rows);
    if (error) throw new Error(error.message);
  }
}

export async function removeBundleComponent(bundleComponentId: string) {
  await requireAuth();
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("bundle_components").delete().eq("id", bundleComponentId);
  if (error) throw new Error(error.message);
}

export async function computeBundleAvailability(bundleVariantId: string, workspaceId: string) {
  await requireAuth();
  const supabase = createServiceRoleClient();

  const [{ data: bundleInv }, { data: ws }, { data: components }] = await Promise.all([
    supabase
      .from("warehouse_inventory_levels")
      .select("available, safety_stock")
      .eq("variant_id", bundleVariantId)
      .single(),
    supabase.from("workspaces").select("default_safety_stock").eq("id", workspaceId).single(),
    supabase
      .from("bundle_components")
      .select(`
        component_variant_id, quantity,
        warehouse_product_variants!component_variant_id (
          sku, title,
          warehouse_inventory_levels (available, safety_stock)
        )
      `)
      .eq("bundle_variant_id", bundleVariantId),
  ]);

  const defaultSafety = ws?.default_safety_stock ?? 3;
  const bundleRaw = bundleInv?.available ?? 0;
  const bundleSafety = (bundleInv?.safety_stock as number | null) ?? defaultSafety;

  const componentDetails = (components ?? []).map((c) => {
    const v = c.warehouse_product_variants as unknown as {
      sku: string;
      title: string | null;
      warehouse_inventory_levels: { available: number }[];
    } | null;
    const compAvail = v?.warehouse_inventory_levels?.[0]?.available ?? 0;
    const contribution = Math.floor(compAvail / c.quantity);
    return {
      componentVariantId: c.component_variant_id,
      sku: v?.sku ?? "",
      title: v?.title ?? null,
      available: compAvail,
      quantityPerBundle: c.quantity,
      contributes: contribution,
    };
  });

  const componentMin =
    componentDetails.length > 0
      ? Math.min(...componentDetails.map((c) => c.contributes))
      : Infinity;

  const effectiveBeforeBuffer =
    componentDetails.length > 0 ? Math.min(bundleRaw, componentMin) : bundleRaw;

  const effectiveAvailable = Math.max(0, effectiveBeforeBuffer - bundleSafety);
  const constrainedBy =
    componentMin < Infinity && componentMin < bundleRaw
      ? (componentDetails.find((c) => c.contributes === componentMin) ?? null)
      : null;

  return {
    rawAvailable: bundleRaw,
    effectiveAvailable,
    constrainedBy,
    components: componentDetails,
  };
}
