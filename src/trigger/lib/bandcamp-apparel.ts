/**
 * Phase A: Bandcamp apparel multi-variant helpers.
 *
 * When a Bandcamp merch package exposes multiple `options[]` entries with their
 * own SKU + quantity (typically apparel sizes), every option must materialize as
 * a first-class `warehouse_product_variants` row + Shopify variant — NOT as
 * metadata on a single umbrella variant. These helpers detect that shape and
 * normalize it into something the sync task can fan out cleanly.
 */

export interface BandcampOptionLite {
  option_id?: number | null;
  sku?: string | null;
  title?: string | null;
  quantity_available?: number | null;
  origin_id?: number | null;
}

export interface NormalizedOption {
  optionId: number | null;
  sku: string;
  title: string;
  quantityAvailable: number;
}

/**
 * Returns a normalized option list when a merch package looks like a multi-SKU
 * package (e.g. apparel sizes). Returns `null` when there's a single unique
 * option SKU or none — those still flow through the legacy umbrella path.
 *
 * Detection rules:
 *   1. options[] must contain >= 2 entries with non-empty SKUs after trim.
 *   2. After dedup by uppercase SKU, there must still be >= 2 unique SKUs.
 *      (Some Bandcamp accounts list the same package SKU per option for tracking.
 *      Those are still single-variant packages from our perspective.)
 *   3. SKUs must differ from the package-level SKU when the package SKU exists,
 *      OR there must be an explicit per-option SKU. (Captured implicitly by
 *      requiring options to carry their own SKU strings.)
 */
export function detectMultiVariantOptions(
  options: BandcampOptionLite[] | null | undefined,
): NormalizedOption[] | null {
  if (!options || options.length === 0) return null;

  const cleaned: NormalizedOption[] = [];
  for (const opt of options) {
    const sku = (opt.sku ?? "").trim();
    if (sku.length === 0) continue;
    cleaned.push({
      optionId: opt.option_id ?? null,
      sku,
      title: (opt.title ?? "").trim(),
      quantityAvailable: typeof opt.quantity_available === "number" ? opt.quantity_available : 0,
    });
  }

  if (cleaned.length < 2) return null;

  // Dedup by uppercase SKU; keep insertion order for the first occurrence.
  const seen = new Set<string>();
  const unique: NormalizedOption[] = [];
  for (const o of cleaned) {
    const key = o.sku.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(o);
  }
  if (unique.length < 2) return null;

  return unique;
}

/**
 * Pick a Shopify option name based on option titles. Apparel sizes land on
 * "Size"; obvious color tokens land on "Color"; everything else falls back to
 * the safe generic "Variant" so we never silently use "Title" for multi-option
 * products (which would collapse into a single-variant Shopify product).
 */
export function inferOptionName(titles: string[]): string {
  const lower = titles.map((t) => t.toLowerCase().trim()).filter(Boolean);
  if (lower.length === 0) return "Variant";

  const SIZE_TOKENS = new Set([
    "xs",
    "s",
    "small",
    "m",
    "medium",
    "l",
    "large",
    "xl",
    "xxl",
    "2xl",
    "3xl",
    "4xl",
    "5xl",
    "youth s",
    "youth m",
    "youth l",
    "one size",
    "os",
  ]);
  const COLOR_TOKENS = new Set([
    "black",
    "white",
    "red",
    "blue",
    "green",
    "yellow",
    "orange",
    "purple",
    "pink",
    "grey",
    "gray",
    "brown",
    "navy",
    "olive",
    "tan",
    "cream",
    "burgundy",
  ]);

  const sizeHits = lower.filter((t) => SIZE_TOKENS.has(t)).length;
  if (sizeHits / lower.length >= 0.5) return "Size";

  const colorHits = lower.filter((t) =>
    Array.from(COLOR_TOKENS).some((c) => t === c || t.startsWith(`${c} `) || t.endsWith(` ${c}`)),
  ).length;
  if (colorHits / lower.length >= 0.5) return "Color";

  return "Variant";
}

/** Title fallback for an option that arrived without a `title` string. */
export function optionDisplayValue(o: NormalizedOption, index: number): string {
  if (o.title.length > 0) return o.title;
  return `Option ${index + 1}`;
}
