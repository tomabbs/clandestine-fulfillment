/**
 * Shared fulfillment cost computation for warehouse shipments.
 *
 * All variant and format-cost queries are workspace-scoped to prevent cross-workspace
 * collisions (UNIQUE(workspace_id, sku) on warehouse_product_variants).
 *
 * Batching: .in() queries are chunked at CHUNK_SIZE to stay within PostgREST URL limits.
 * A page of 250 shipments can produce ~750-1000 distinct SKUs — well above safe URL length.
 *
 * Math: intermediate per-item products are rounded to cents before summing to prevent
 * IEEE 754 drift (e.g. 0.1 + 0.2 = 0.30000000000000004).
 */

// biome-ignore lint/suspicious/noExplicitAny: Supabase client is untyped at call sites
type AnySupabaseClient = { from: (table: string) => any };

const CHUNK_SIZE = 250;

/**
 * Normalize Shopify free-text product_type values to the keys used in warehouse_format_costs.
 * Shopify lets merchants enter any string — "12\" Vinyl", "CDR", "7\" Vinyl", etc.
 * This map keeps the runtime fallback in sync with the migration alias list.
 * Values not in the map are returned as-is; if they still miss the cost lookup they
 * land in missingFormatCosts and trigger the amber dot (correct behaviour).
 */
const PRODUCT_TYPE_ALIASES: Record<string, string> = {
  // LP / vinyl
  '12" Vinyl': "LP",
  '2x 12" Vinyl': "LP",
  "Vinyl LP": "LP",
  "2 x Vinyl LP": "LP",
  // CD
  CDR: "CD",
  "2x CD": "CD",
  "2xCD": "CD",
  // Cassette
  "2x Cassette": "Cassette",
  "Cassette,": "Cassette",
  // 7"
  '7" Vinyl': '7"',
  // Apparel
  "T-Shirt/Apparel": "T-Shirt",
  Shirt: "T-Shirt",
  // Other
  Magazine: "Other",
};

function normalizeProductType(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return PRODUCT_TYPE_ALIASES[trimmed] ?? trimmed;
}

export interface ItemInput {
  sku: string | null | undefined;
  quantity: number;
}

export interface FulfillmentCostResult {
  /** postage + materials + pickPack (cents-rounded) */
  total: number;
  postage: number;
  materials: number;
  pickPack: number;
  /** Always 0 for now; reserved for future drop-ship fees */
  dropShip: number;
  /** Always 0 for now; reserved for future insurance fees */
  insurance: number;
  /** True when any item SKU is unresolved or format cost row is missing */
  partial: boolean;
  /** SKUs not found in warehouse_product_variants for this workspace */
  unknownSkus: string[];
  /** Format names found in variants but absent from warehouse_format_costs */
  missingFormatCosts: string[];
  /** SKU → format_name mapping; callers can use this to populate display fields */
  skuFormatMap: Record<string, string | null>;
}

/** Round n to 2 decimal places to suppress IEEE 754 drift. */
export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fetch variant→format and format→cost maps for a set of SKUs in one workspace.
 * Returns the raw maps so callers can reuse them for multiple shipments (batch mode).
 */
export async function batchBuildFormatCostMaps(
  workspaceId: string,
  skus: string[],
  supabase: AnySupabaseClient,
): Promise<{
  variantFormatMap: Record<string, string | null>;
  formatCostLookup: Record<string, { pick_pack_cost: number; material_cost: number }>;
  unknownSkus: string[];
  missingFormatCosts: string[];
}> {
  const uniqueSkus = Array.from(new Set(skus.filter((s) => s.trim() !== "")));

  if (uniqueSkus.length === 0) {
    return {
      variantFormatMap: {},
      formatCostLookup: {},
      unknownSkus: [],
      missingFormatCosts: [],
    };
  }

  // Chunk variant lookups — join warehouse_products to get product_type as fallback
  // for when format_name is NULL. shopify-sync writes product_type to warehouse_products
  // but not format_name to variants; this FK join recovers the format without an extra query.
  const variantRows: Array<{
    sku: string;
    format_name: string | null;
    warehouse_products: { product_type: string | null } | null;
  }> = [];
  for (const skuChunk of chunk(uniqueSkus, CHUNK_SIZE)) {
    const { data } = await supabase
      .from("warehouse_product_variants")
      .select("sku, format_name, warehouse_products(product_type)")
      .eq("workspace_id", workspaceId)
      .in("sku", skuChunk);
    if (data) variantRows.push(...data);
  }

  const variantFormatMap: Record<string, string | null> = {};
  for (const v of variantRows) {
    // Use format_name when set; fall back to parent product's product_type, normalized
    // through PRODUCT_TYPE_ALIASES (e.g. "12\" Vinyl" → "LP"). normalizeProductType
    // also handles trim + empty-string collapse.
    const rawProductType = (v.warehouse_products as { product_type: string | null } | null)
      ?.product_type;
    const productType = normalizeProductType(rawProductType ?? null);
    variantFormatMap[v.sku] = v.format_name || productType;
  }

  const unknownSkus = uniqueSkus.filter((s) => !(s in variantFormatMap));

  const knownFormatNames = Array.from(
    new Set(
      uniqueSkus
        .map((s) => variantFormatMap[s])
        .filter((fn): fn is string => fn != null && fn.trim() !== ""),
    ),
  );

  const formatCostLookup: Record<string, { pick_pack_cost: number; material_cost: number }> = {};
  if (knownFormatNames.length > 0) {
    const formatRows: Array<{
      format_name: string;
      pick_pack_cost: number;
      material_cost: number;
    }> = [];
    for (const fChunk of chunk(knownFormatNames, CHUNK_SIZE)) {
      const { data } = await supabase
        .from("warehouse_format_costs")
        .select("format_name, pick_pack_cost, material_cost")
        .eq("workspace_id", workspaceId)
        .in("format_name", fChunk);
      if (data) formatRows.push(...data);
    }
    for (const fc of formatRows) {
      formatCostLookup[fc.format_name] = {
        pick_pack_cost: Number(fc.pick_pack_cost),
        material_cost: Number(fc.material_cost),
      };
    }
  }

  const resolvedFormatNames = new Set(Object.keys(formatCostLookup));
  const missingFormatCosts = knownFormatNames.filter((fn) => !resolvedFormatNames.has(fn));

  return { variantFormatMap, formatCostLookup, unknownSkus, missingFormatCosts };
}

/**
 * Pure cost computation given pre-built lookup maps.
 * Safe to call in a tight loop (no I/O).
 */
export function computeCostsFromMaps(
  postage: number,
  items: ItemInput[],
  variantFormatMap: Record<string, string | null>,
  formatCostLookup: Record<string, { pick_pack_cost: number; material_cost: number }>,
): {
  materials: number;
  pickPack: number;
  total: number;
  partial: boolean;
  unknownSkus: string[];
  missingFormatCosts: string[];
} {
  const seenSkus = new Set<string>();
  const unknownSkus: string[] = [];
  const missingFormatCosts: string[] = [];

  // pick_pack_cost and material_cost are FLAT PER-SHIPMENT rates stored in warehouse_format_costs.
  // They are charged ONCE per unique format in the shipment — NOT multiplied by item quantity.
  // This matches billing-calculator.ts which does:
  //   totalPickPack += s.pick_pack_cost  (no × totalUnits)
  //   totalMaterials += s.material_cost  (no × totalUnits)
  // The per-item ($0.20) surcharge lives in billing_rules (per_item type) and is applied
  // separately during monthly billing — it is NOT in warehouse_format_costs.
  const chargedFormats = new Set<string>();
  let materialsCents = 0;
  let pickPackCents = 0;

  for (const item of items) {
    if (!item.sku) continue;
    seenSkus.add(item.sku);

    if (!(item.sku in variantFormatMap)) {
      if (!unknownSkus.includes(item.sku)) unknownSkus.push(item.sku);
      continue;
    }

    const fn = variantFormatMap[item.sku];
    if (!fn) {
      // SKU is in the map but format_name is unresolvable after both the direct column
      // and product_type fallback were tried. Treat as unknown so partial=true fires
      // and the amber dot shows — never silently skip.
      // Note: unknownSkus intentionally covers both "SKU not in system" (checked above)
      // and "format unresolvable". If a future diagnostic screen needs to distinguish
      // them, introduce a separate unresolvedFormats array.
      if (!unknownSkus.includes(item.sku)) unknownSkus.push(item.sku);
      continue;
    }

    if (!(fn in formatCostLookup)) {
      if (!missingFormatCosts.includes(fn)) missingFormatCosts.push(fn);
      continue;
    }

    // Charge each format's flat costs exactly once per shipment.
    if (!chargedFormats.has(fn)) {
      chargedFormats.add(fn);
      const costs = formatCostLookup[fn];
      materialsCents += Math.round(costs.material_cost * 100);
      pickPackCents += Math.round(costs.pick_pack_cost * 100);
    }
  }

  const materials = materialsCents / 100;
  const pickPack = pickPackCents / 100;
  const total = roundCents(postage + materials + pickPack);
  const partial = unknownSkus.length > 0 || missingFormatCosts.length > 0;

  return { materials, pickPack, total, partial, unknownSkus, missingFormatCosts };
}

/**
 * Compute fulfillment cost breakdown for a single shipment's items.
 * Does its own DB queries — use batchBuildFormatCostMaps + computeCostsFromMaps
 * when processing many shipments at once.
 */
export async function computeFulfillmentCostBreakdown(
  workspaceId: string,
  postage: number,
  items: ItemInput[],
  supabase: AnySupabaseClient,
): Promise<FulfillmentCostResult> {
  const skus = items.map((i) => i.sku).filter((s): s is string => s != null && s.trim() !== "");

  const { variantFormatMap, formatCostLookup, unknownSkus, missingFormatCosts } =
    await batchBuildFormatCostMaps(workspaceId, skus, supabase);

  const costs = computeCostsFromMaps(postage, items, variantFormatMap, formatCostLookup);

  return {
    total: costs.total,
    postage,
    materials: costs.materials,
    pickPack: costs.pickPack,
    dropShip: 0,
    insurance: 0,
    partial: costs.partial,
    unknownSkus,
    missingFormatCosts,
    skuFormatMap: variantFormatMap,
  };
}
