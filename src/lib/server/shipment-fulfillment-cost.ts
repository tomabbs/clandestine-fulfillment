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

/**
 * Title keyword patterns for last-resort format extraction.
 * Used when a SKU is completely absent from warehouse_product_variants (e.g. Squarespace
 * placeholder IDs like SQ6720646) and we only have the item's product_title to work with.
 * Order matters: more specific patterns run first (7" before generic vinyl).
 */
const TITLE_FORMAT_KEYWORDS: Array<{ pattern: RegExp; format: string }> = [
  { pattern: /\b7["\u201c\u2033]|\bseven[\s-]inch\b/i, format: '7"' },
  { pattern: /\b(2xlp|2x\s*12["\u201c]|double\s*lp|dlp)\b/i, format: "LP" },
  { pattern: /\b(lp|12["\u201c]\s*vinyl|vinyl\s*lp|vinyl\s*record)\b/i, format: "LP" },
  { pattern: /\b(cdr?|compact\s*disc)\b/i, format: "CD" },
  { pattern: /\b(cassette|cass(?!etto)|tape)\b/i, format: "Cassette" },
  { pattern: /\b(t-?shirt|tee\b|apparel)\b/i, format: "T-Shirt" },
];

/**
 * Extract a format name from a human-readable product or variant title.
 * Returns null when no keyword matches — callers should treat null as unresolvable.
 */
export function extractFormatFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  for (const { pattern, format } of TITLE_FORMAT_KEYWORDS) {
    if (pattern.test(title)) return format;
  }
  return null;
}

/** Normalize a title for fuzzy comparison: lowercase, strip format words and punctuation. */
function normalizeTitleForMatching(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(lp|cd|cdr|ep|cassette|tape|vinyl|12"|10"|7"|split|dlp|2xlp|album|single)\b/gi, "")
    .replace(/[""'`\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Jaccard word-overlap similarity between two titles (0–1).
 * Also handles containment: if the shorter normalized title (≥10 chars) is contained
 * in the longer, score = shorter.length / longer.length.
 */
function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitleForMatching(a);
  const nb = normalizeTitleForMatching(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 10 && longer.includes(shorter)) {
    return shorter.length / longer.length;
  }

  const wordsA = new Set(na.split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(nb.split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const arrA = Array.from(wordsA);
  const intersection = arrA.filter((w) => wordsB.has(w)).length;
  const union = new Set([...arrA, ...Array.from(wordsB)]).size;
  return intersection / union;
}

export interface ItemInput {
  sku: string | null | undefined;
  quantity: number;
  /** Product title from the order line item (e.g. from warehouse_shipment_items). Used as
   *  fallback to extract a format when the SKU is absent from warehouse_product_variants. */
  product_title?: string | null;
  /** Variant title (e.g. "Black Vinyl", "Ltd Edition"). Appended to product_title for matching. */
  variant_title?: string | null;
  /** Staff-assigned format override from warehouse_shipment_items.format_name_override.
   *  Highest priority — bypasses all automatic resolution when set. */
  format_override?: string | null;
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
 *
 * itemTitleMap (optional): sku → combined product+variant title. When a SKU is absent from
 * warehouse_product_variants (e.g. Squarespace placeholder IDs like "SQ6720646"), the function
 * runs two additional fallback passes before marking the SKU as unknown:
 *   Pass 1 — keyword extraction from itemTitleMap[sku] (e.g. "Joy Guidry - AMEN LP" → "LP")
 *   Pass 2 — fuzzy product title match against warehouse_products (Jaccard ≥ 0.6, min 10 chars)
 *
 * overrideMap (optional): sku → format_name from warehouse_shipment_items.format_name_override.
 * Staff-assigned overrides have the highest priority and bypass all automatic resolution.
 * SKUs present in overrideMap skip DB variant queries entirely.
 */
export async function batchBuildFormatCostMaps(
  workspaceId: string,
  skus: string[],
  supabase: AnySupabaseClient,
  itemTitleMap?: Record<string, string | null>,
  overrideMap?: Record<string, string>,
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

  // Pre-seed with staff overrides (highest priority). These SKUs skip the DB variant lookup
  // entirely — the override is the definitive format for this shipment item.
  const variantFormatMap: Record<string, string | null> = {};
  if (overrideMap) {
    for (const [sku, format] of Object.entries(overrideMap)) {
      if (format) variantFormatMap[sku] = format;
    }
  }

  // Only query the DB for SKUs not already resolved by an override.
  const skusToQuery = uniqueSkus.filter((s) => !(s in variantFormatMap));

  // Chunk variant lookups — join warehouse_products to get product_type as fallback
  // for when format_name is NULL. shopify-sync writes product_type to warehouse_products
  // but not format_name to variants; this FK join recovers the format without an extra query.
  const variantRows: Array<{
    sku: string;
    format_name: string | null;
    warehouse_products: { product_type: string | null } | null;
  }> = [];
  for (const skuChunk of chunk(skusToQuery, CHUNK_SIZE)) {
    const { data } = await supabase
      .from("warehouse_product_variants")
      .select("sku, format_name, warehouse_products(product_type)")
      .eq("workspace_id", workspaceId)
      .in("sku", skuChunk);
    if (data) variantRows.push(...data);
  }
  for (const v of variantRows) {
    // Use format_name when set; fall back to parent product's product_type, normalized
    // through PRODUCT_TYPE_ALIASES (e.g. "12\" Vinyl" → "LP"). normalizeProductType
    // also handles trim + empty-string collapse.
    const rawProductType = (v.warehouse_products as { product_type: string | null } | null)
      ?.product_type;
    const productType = normalizeProductType(rawProductType ?? null);
    variantFormatMap[v.sku] = v.format_name || productType;
  }

  // Title-based fallback for SKUs completely absent from warehouse_product_variants.
  // Two passes: (1) keyword extraction, (2) fuzzy product title match.
  // Only runs when the caller provides itemTitleMap.
  if (itemTitleMap) {
    const missingFromVariants = uniqueSkus.filter((sku) => !(sku in variantFormatMap));

    if (missingFromVariants.length > 0) {
      // Pass 1: title keyword extraction (LP/CD/Cassette/etc. in the item title)
      const stillUnresolved: string[] = [];
      for (const sku of missingFromVariants) {
        const title = itemTitleMap[sku];
        const format = extractFormatFromTitle(title);
        if (format) {
          variantFormatMap[sku] = format;
        } else {
          stillUnresolved.push(sku);
        }
      }

      // Pass 2: fuzzy match against warehouse_products.title for SKUs with a title
      // but no keyword hit. Fetches all product titles once (workspace-scoped).
      const needsFuzzy = stillUnresolved.filter((sku) => !!itemTitleMap[sku]);
      if (needsFuzzy.length > 0) {
        const { data: products } = await supabase
          .from("warehouse_products")
          .select("title, product_type")
          .eq("workspace_id", workspaceId);

        for (const sku of needsFuzzy) {
          const itemTitle = itemTitleMap[sku];
          if (!itemTitle) continue;

          let bestScore = 0.6; // minimum similarity threshold
          let bestProductType: string | null = null;

          for (const product of products ?? []) {
            if (!product.title) continue;
            const score = titleSimilarity(itemTitle, product.title);
            if (score > bestScore) {
              bestScore = score;
              bestProductType = product.product_type ?? null;
            }
          }

          if (bestProductType) {
            variantFormatMap[sku] = normalizeProductType(bestProductType);
          }
        }
      }
    }
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

  // Build sku→title map from ItemInput for title-based fallback resolution.
  // Combines product_title + variant_title so "Joy Guidry - AMEN" + "LP" gives "Joy Guidry - AMEN LP".
  const itemTitleMap: Record<string, string | null> = {};
  const overrideMap: Record<string, string> = {};
  for (const item of items) {
    if (!item.sku) continue;
    const parts = [item.product_title, item.variant_title].filter(
      (p): p is string => !!p && p.trim() !== "",
    );
    itemTitleMap[item.sku] = parts.length > 0 ? parts.join(" ") : null;
    if (item.format_override) overrideMap[item.sku] = item.format_override;
  }

  const { variantFormatMap, formatCostLookup, unknownSkus, missingFormatCosts } =
    await batchBuildFormatCostMaps(workspaceId, skus, supabase, itemTitleMap, overrideMap);

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
