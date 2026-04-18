/**
 * Compute the "effective" Bandcamp availability for a mapping — i.e. the sum
 * of origin allocations across all origins, NOT the customer-facing TOP
 * `quantity_available`.
 *
 * Per Part 9 audit findings (plan §9): some merchants set a non-zero baseline
 * on Bandcamp products (e.g. Lord Spikeheart's MOSH PIT POWER tee shows 100
 * in stock for marketing reasons but the actual us-controlled allocation is
 * 0). The TOP quantity is `baseline + sum(origin_allocations)`. Seeding
 * ShipStation from TOP would inflate inventory by the merchant baseline.
 *
 * Phase 3 seed selection rule: only seed a SKU if its effective available
 * (origin sum) is > 0. Mappings with a non-zero baseline AND zero origin
 * allocation will have `push_mode = 'blocked_baseline'` and are filtered out
 * earlier in the pipeline; this helper is the source of truth for the
 * quantity to push when push_mode = 'normal' AND we want to seed.
 *
 * Returns 0 if the data is missing or malformed (defensive — treat unknown
 * shapes as "do not seed").
 */

interface OriginQuantitiesShape {
  origin_id?: number | null;
  option_quantities?: Array<{
    option_id?: number | null;
    quantity_available?: number | null;
  }> | null;
}

/**
 * Sum every `quantity_available` across every origin's `option_quantities`
 * entries. For package-level products there is a single placeholder option
 * entry per origin; for option-level products there's one entry per
 * (origin, option) pair.
 *
 * The pure function can be unit-tested against fixture data without a DB.
 */
export function computeEffectiveBandcampAvailable(originQuantities: unknown): number {
  if (!Array.isArray(originQuantities)) return 0;

  const origins = originQuantities as OriginQuantitiesShape[];
  let sum = 0;
  for (const origin of origins) {
    if (!Array.isArray(origin.option_quantities)) continue;
    for (const oq of origin.option_quantities) {
      const q = Number(oq.quantity_available);
      if (Number.isFinite(q) && q > 0) sum += q;
    }
  }
  return sum;
}

/**
 * Per-option breakdown for option-level products (e.g. shirts with sizes).
 * The map key is the Bandcamp `option_id`; values are the summed origin
 * allocations for that option. Package-level products yield an empty map.
 *
 * Used by the seed task to push the right quantity per-SKU when a mapping
 * has `bandcamp_option_skus[]` populated (each option corresponds to a
 * distinct ShipStation SKU per CLAUDE.md Rule #8 sized-items exception).
 */
export function computeEffectiveBandcampAvailableByOption(
  originQuantities: unknown,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(originQuantities)) return out;

  const origins = originQuantities as OriginQuantitiesShape[];
  for (const origin of origins) {
    if (!Array.isArray(origin.option_quantities)) continue;
    for (const oq of origin.option_quantities) {
      if (oq.option_id == null) continue;
      const q = Number(oq.quantity_available);
      if (!Number.isFinite(q) || q <= 0) continue;
      out.set(oq.option_id, (out.get(oq.option_id) ?? 0) + q);
    }
  }
  return out;
}

/**
 * Decide the quantity to seed `warehouse_inventory_levels.available` from for a
 * Bandcamp merch item on first ingest (Phase 1 follow-up #2 — the warehouse
 * seed correction that gates Phase 4).
 *
 * Decision tree (in order):
 *  1. If `origin_quantities` is a non-empty array: trust the origin sum, even
 *     if it is 0. A zero origin sum with a non-zero TOP `quantity_available` is
 *     EXACTLY the baseline-anomaly case Part 9 documents (the merchant set a
 *     marketing-only baseline; we should NOT seed any units). Phase 1's audit
 *     also flips `push_mode` to `blocked_baseline` for these mappings, so they
 *     are filtered out of Phase 3's ShipStation seed and Phase 4's outbound
 *     fanout — the warehouse is the last layer that needs the correction.
 *  2. If `origin_quantities` is missing/null/non-array but TOP > 0: fall back
 *     to TOP and tag the source as `top_fallback` so the seed metadata records
 *     the heuristic used. Single-origin merchants without origin tracking land
 *     here.
 *  3. Otherwise: 0 (no seed).
 *
 * The returned `source` is logged in `recordInventoryChange()` metadata so
 * operations can grep `warehouse_inventory_activity` for `top_fallback` seeds
 * and chase merchants who haven't backfilled origin metadata.
 */
export function computeBandcampSeedQuantity(merchItem: {
  quantity_available?: number | null;
  origin_quantities?: unknown;
}): { effective: number; source: "origin_sum" | "top_fallback" | "zero" } {
  if (Array.isArray(merchItem.origin_quantities) && merchItem.origin_quantities.length > 0) {
    return {
      effective: computeEffectiveBandcampAvailable(merchItem.origin_quantities),
      source: "origin_sum",
    };
  }
  const top = Number(merchItem.quantity_available);
  if (Number.isFinite(top) && top > 0) {
    return { effective: top, source: "top_fallback" };
  }
  return { effective: 0, source: "zero" };
}
