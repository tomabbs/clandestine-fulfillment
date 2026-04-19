// Phase 5.1 — Order-level preorder state derivation.
//
// Reads each line item's variant {is_preorder, street_date} and collapses
// to a single per-order state used by the cockpit tabs:
//
//   "none"      → no preorder lines.
//   "preorder"  → at least one preorder line whose street_date is > today + READY_WINDOW_DAYS.
//   "ready"     → all preorder lines are preorders AND every street_date is in (today, today + READY_WINDOW_DAYS].
//                 i.e. shipping window has opened, nothing too far out.
//
// Edge cases (Phase 5.5):
//   - Mixed cart with one preorder + one in-stock: still "preorder" / "ready" if
//     the preorder line is unshipped (the in-stock line ships with it; we don't
//     split the order).
//   - All preorder, multiple dates: state controlled by the LATEST date.
//   - Missing variant for a SKU: treat as not-preorder (don't block label
//     printing). Logged via the caller, not here.
//   - Variants with is_preorder=true but street_date already in the past: treat
//     as not-preorder ("released" — should ship normally).
//
// preorder_release_date returned is always the MAX street_date across the
// preorder lines, so the cockpit "Preorders Ready to Ship" tab can sort by
// upcoming release.

import { getTodayNY } from "@/lib/shared/preorder-dates";

export const PREORDER_READY_WINDOW_DAYS = 7;

export interface PreorderVariantRecord {
  /** Match by SKU. */
  sku: string;
  is_preorder: boolean | null;
  /** YYYY-MM-DD or ISO timestamp; null if unset. */
  street_date: string | null;
}

export interface PreorderLineItem {
  sku: string | null | undefined;
}

export interface DeriveOrderPreorderStateArgs {
  items: PreorderLineItem[];
  /** Map keyed by SKU. Missing entries are treated as not-preorder (see edge cases). */
  variantLookup: Map<string, PreorderVariantRecord>;
  /** Inject today (NY YYYY-MM-DD) for testability. Defaults to getTodayNY(). */
  today?: string;
  /** Inject the ready window (default 7 days) for testability. */
  readyWindowDays?: number;
}

export interface OrderPreorderState {
  preorder_state: "none" | "preorder" | "ready";
  /**
   * MAX street_date across all preorder lines (YYYY-MM-DD), or null when
   * preorder_state === "none".
   */
  preorder_release_date: string | null;
}

/**
 * Phase 5.1 — collapse line items + variants into a single preorder state.
 *
 * Pure function; safe to call from server actions, trigger tasks, and tests.
 */
export function deriveOrderPreorderState(args: DeriveOrderPreorderStateArgs): OrderPreorderState {
  const today = args.today ?? getTodayNY();
  const window = args.readyWindowDays ?? PREORDER_READY_WINDOW_DAYS;

  // Cutoff = today + window (inclusive). Computed in NY day arithmetic so
  // boundary days flip at NY midnight, consistent with isFutureReleaseDate.
  const cutoffNY = (() => {
    const [y, m, d] = today.split("-").map(Number);
    const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    anchor.setUTCDate(anchor.getUTCDate() + window);
    return anchor.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  })();

  const preorderDates: string[] = [];

  for (const item of args.items) {
    if (!item.sku) continue;
    const variant = args.variantLookup.get(item.sku);
    if (!variant) continue;
    if (!variant.is_preorder) continue;
    if (!variant.street_date) continue;
    const dateOnly = variant.street_date.slice(0, 10);
    // Released (street_date <= today) → not a preorder anymore. We do the
    // comparison inline (not via isFutureReleaseDate) so the injected `today`
    // arg flows through for tests + cron-driven re-derivations.
    if (!(dateOnly > today)) continue;
    preorderDates.push(dateOnly);
  }

  if (preorderDates.length === 0) {
    return { preorder_state: "none", preorder_release_date: null };
  }

  // Latest street date across all preorder lines (alphabetical sort works on YYYY-MM-DD).
  const maxDate = preorderDates.sort()[preorderDates.length - 1] ?? null;
  if (!maxDate) return { preorder_state: "none", preorder_release_date: null };

  // "ready" iff EVERY preorder line is within (today, cutoff]. The MAX date
  // being <= cutoff implies all dates are <= cutoff (since today < everything
  // in this list — released items were filtered above).
  const isReady = maxDate <= cutoffNY;

  return {
    preorder_state: isReady ? "ready" : "preorder",
    preorder_release_date: maxDate,
  };
}
