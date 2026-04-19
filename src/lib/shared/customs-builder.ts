/**
 * Phase 0.5.4 + 0.5.5 — Build EasyPost customs_items[] from real order data.
 *
 * The previous flow declared every international shipment as
 *   "Vinyl Records / qty 1 / value $25 / HS 8523.80"
 * regardless of what was actually in the box. That under-declared CD/cassette
 * shipments and over-declared single-item orders, occasionally tripped customs
 * holds, and made multi-item declarations technically false.
 *
 * The shape produced by buildCustomsItems() lines up 1:1 with the
 * customsItems[] field on CreateShipmentInput in easypost-client.ts.
 *
 * HS code resolution priority:
 *   1. variant.hs_tariff_code (set by backfill-hs-codes.ts or staff)
 *   2. category-based default from HS_CODE_DEFAULTS
 *   3. global fallback "8523.80" (sound recordings, conservative)
 *
 * NOTE: Phase 0.5.5 uses the EXISTING warehouse_product_variants.hs_tariff_code
 * column added in 20260325000001_v72_schema_updates.sql. We do NOT add a duplicate
 * "hs_code" column.
 */

export interface CustomsLineItemInput {
  sku: string | null | undefined;
  /** Display title (used as customs description fallback when override absent). */
  title: string | null | undefined;
  quantity: number;
  /** Unit price in USD. Line value = quantity × unitPrice. */
  unitPrice: number;
  /** Optional staff override that beats the title (e.g. "Vinyl Record - 1 piece"). */
  customsDescriptionOverride?: string | null;
}

export interface VariantCustomsData {
  sku: string;
  hsTariffCode: string | null | undefined;
  /** Optional product category from bandcamp_product_mappings (e.g. "vinyl", "cd", "tshirt"). */
  productCategory?: string | null;
}

/**
 * Conservative US-Schedule-B / HTS export defaults by product category. See
 * plan Phase 0.5.5 for the source table and ops/legal sign-off note.
 */
export const HS_CODE_DEFAULTS: Record<string, string> = {
  vinyl: "8523.80.4000",
  cd: "8523.49.4000",
  cassette: "8523.29.4000",
  tshirt: "6109.10.0004",
  apparel: "6109.10.0004",
  book: "4901.99.0093",
  zine: "4901.99.0093",
  poster: "4911.91.4040",
  print: "4911.91.4040",
  patches: "7117.19.9000",
  pins: "7117.19.9000",
};

/** Final fallback when no per-variant code and no category match exists. */
export const HS_CODE_GLOBAL_FALLBACK = "8523.80.4000";

export function resolveHsCode(variant: VariantCustomsData | undefined | null): string {
  const explicit = variant?.hsTariffCode?.trim();
  if (explicit) return explicit;
  const cat = variant?.productCategory?.toLowerCase().trim();
  if (cat && HS_CODE_DEFAULTS[cat]) return HS_CODE_DEFAULTS[cat] ?? HS_CODE_GLOBAL_FALLBACK;
  return HS_CODE_GLOBAL_FALLBACK;
}

export interface BuildCustomsItemsArgs {
  /** Order line items, in the order they should appear on the customs declaration. */
  lineItems: CustomsLineItemInput[];
  /** Variant lookup by SKU. SKUs not in the map fall through to defaults. */
  variantsBySku: Map<string, VariantCustomsData>;
  /** Total parcel weight in oz. Distributed proportionally to quantity. */
  totalWeightOz: number;
}

export interface BuiltCustomsItem {
  description: string;
  quantity: number;
  weight: number; // oz, per-line proportional share
  value: number; // USD, per-line line total (qty × unit price), rounded to 2dp
  hsTariffNumber: string;
  originCountry: string;
}

export function buildCustomsItems(args: BuildCustomsItemsArgs): BuiltCustomsItem[] {
  const items = args.lineItems.filter((li) => li.quantity > 0);
  if (items.length === 0) return [];

  const totalUnits = items.reduce((sum, li) => sum + li.quantity, 0);
  const safeTotalWeight = Math.max(0.1, args.totalWeightOz); // avoid 0-weight customs entries

  return items.map((li) => {
    const variant = li.sku ? args.variantsBySku.get(li.sku) : undefined;
    const hs = resolveHsCode(variant);
    const description =
      (li.customsDescriptionOverride?.trim() || li.title?.trim()) ?? "Merchandise";
    const lineWeight = totalUnits > 0 ? (safeTotalWeight * li.quantity) / totalUnits : safeTotalWeight;
    const lineValue = roundTo2(li.quantity * (li.unitPrice ?? 0));
    return {
      description,
      quantity: li.quantity,
      weight: roundTo2(Math.max(0.1, lineWeight)),
      value: lineValue,
      hsTariffNumber: hs,
      originCountry: "US",
    };
  });
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Phase 0.5.6 — parcel dimension aggregation across line items ─────────────

export interface VariantDimensions {
  sku: string;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
}

export interface ParcelDimensionResult {
  /** Inches. Null when no variant in the shipment supplied dimensions. */
  length: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Aggregator: take MAX dimension on each axis as a conservative default.
 *
 * If a shipment contains a 7" single + an LP + a CD, the LP dimensions win on
 * length/width and the LP also wins on height (both are flat at ~2in). This
 * over-estimates packed dimensions but never under-estimates dim-weight.
 *
 * Returns nulls when no variant supplied any dimension; caller falls back to
 * the global 13×13×2 default in easypost-client.ts.
 */
export function aggregateParcelDimensions(
  skus: Array<string | null | undefined>,
  dimsBySku: Map<string, VariantDimensions>,
): ParcelDimensionResult {
  const collected: VariantDimensions[] = [];
  for (const sku of skus) {
    if (!sku) continue;
    const d = dimsBySku.get(sku);
    if (d && (d.lengthIn != null || d.widthIn != null || d.heightIn != null)) {
      collected.push(d);
    }
  }
  if (collected.length === 0) return { length: null, width: null, height: null };

  const maxOf = (key: "lengthIn" | "widthIn" | "heightIn"): number | null => {
    const vals = collected.map((d) => d[key]).filter((n): n is number => typeof n === "number");
    return vals.length > 0 ? Math.max(...vals) : null;
  };

  return {
    length: maxOf("lengthIn"),
    width: maxOf("widthIn"),
    height: maxOf("heightIn"),
  };
}
