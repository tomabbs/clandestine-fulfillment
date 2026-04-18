import { tasks } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "./supabase-server";

/**
 * Bundle availability math (Phase 2.5(b) — extracted from
 * `bandcamp-inventory-push.ts` per Patch A7). Pure functions so every fanout
 * site (Bandcamp, multi-store, ShipStation v2 — when Phase 4 wires v2 fanout)
 * derives bundle quantities from one source of truth.
 *
 * The math: a bundle SKU's effective availability is the MIN of:
 *  - the bundle's own on-hand `warehouse_inventory_levels.available`
 *    (so an operator manually counting the bundle row is respected), and
 *  - the per-component minimum: `floor(component_available / per_unit_qty)`
 *    across every component the bundle requires.
 *
 * Components are pulled once per workspace and cached in a Map keyed by
 * `component_variant_id`. Callers that don't have the bundle stock on hand
 * (e.g. the v2 drift sensor reading directly from ShipStation) pass
 * `Number.POSITIVE_INFINITY` so the result is purely component-derived.
 */
export interface BundleComponentSpec {
  component_variant_id: string;
  quantity: number;
}

/**
 * Per-component minimum, ignoring the bundle's own on-hand. Returns
 * `Number.POSITIVE_INFINITY` when `components` is empty so callers can chain
 * with `Math.min(bundleStock, computeBundleAvailability(...))` and fall back to
 * the bundle stock unchanged.
 */
export function computeBundleAvailability(
  components: BundleComponentSpec[],
  componentInventory: Map<string, { available: number }>,
): number {
  if (components.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(
    ...components.map((c) => {
      const inv = componentInventory.get(c.component_variant_id);
      const available = inv?.available ?? 0;
      const perUnit = c.quantity > 0 ? c.quantity : 1;
      return Math.floor(available / perUnit);
    }),
  );
}

/**
 * Final bundle availability for fanout: `MIN(bundle_stock, component_min)`,
 * floored at 0. Equivalent to the inlined `bandcamp-inventory-push.ts` math
 * (line range previously near 230-240 of that file). Callers may pass
 * `Number.POSITIVE_INFINITY` for `bundleStockOnHand` to derive purely from
 * components (drift sensor pattern).
 */
export function computeEffectiveBundleAvailable(
  bundleStockOnHand: number,
  components: BundleComponentSpec[],
  componentInventory: Map<string, { available: number }>,
): number {
  const componentMin = computeBundleAvailability(components, componentInventory);
  return Math.min(bundleStockOnHand, Math.max(0, componentMin));
}

export async function isBundleVariant(
  variantId: string,
  cache?: Map<string, boolean>,
): Promise<boolean> {
  if (cache?.has(variantId)) return cache.get(variantId)!;
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("bundle_components")
    .select("id")
    .eq("bundle_variant_id", variantId)
    .limit(1);
  const result = (data?.length ?? 0) > 0;
  cache?.set(variantId, result);
  return result;
}

export async function triggerBundleFanout(params: {
  variantId: string;
  soldQuantity: number;
  workspaceId: string;
  correlationBase: string;
  cache?: Map<string, boolean>;
}): Promise<{ triggered: boolean; runId?: string; error?: string }> {
  try {
    const isBundle = await isBundleVariant(params.variantId, params.cache);
    if (!isBundle) return { triggered: false };

    const handle = await tasks.trigger("bundle-component-fanout", {
      bundleVariantId: params.variantId,
      soldQuantity: params.soldQuantity,
      workspaceId: params.workspaceId,
      correlationBase: params.correlationBase,
    });

    return { triggered: true, runId: handle.id };
  } catch (err) {
    return { triggered: false, error: String(err) };
  }
}
