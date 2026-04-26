/**
 * Phase 4b (finish-line plan v4) — Shared utilities (Rule #57).
 *
 * Per Rule #57, standard formatting / class merging / date helpers all live
 * here. Feature directories MUST NOT create their own `helpers.ts` /
 * `formatters.ts` / `money.ts` — add to this file instead. The
 * `src/lib/utils.ts` legacy file re-exports from here for one cycle so
 * existing import paths keep working until call sites migrate.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Bandcamp order `line_items` JSON often repeats `shipping` on each row;
 * take the max. Returns null when the input is malformed or all rows are
 * non-positive.
 */
export function maxShippingFromOrderLineItems(lineItems: unknown): number | null {
  if (!Array.isArray(lineItems)) return null;
  let m = 0;
  for (const row of lineItems) {
    if (row && typeof row === "object" && "shipping" in row) {
      const v = Number((row as { shipping?: unknown }).shipping);
      if (!Number.isNaN(v)) m = Math.max(m, v);
    }
  }
  return m > 0 ? m : null;
}

/**
 * Compact "X ago" relative-time formatter used by inventory / catalog /
 * support list views. Returns "just now" for any non-positive or
 * non-finite duration so callers don't have to guard.
 *
 * Rule #57: do NOT inline equivalent helpers in feature code — import this.
 */
export function formatRelativeTimeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Normalize a SKU for cross-system identity comparison.
 * Preserve internal separators, but collapse surrounding whitespace and casing.
 */
export function normalizeSku(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalize a barcode / UPC / GTIN to digits-only form.
 */
export function normalizeBarcode(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\D+/g, "");
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalize product text for equality / fuzzy-lite comparisons.
 * This is intentionally conservative: punctuation and casing are removed,
 * but token order is preserved so title-only similarity never becomes
 * deterministic identity.
 */
export function normalizeProductText(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Autonomous SKU matcher — placeholder SKU detector.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Hard disqualifiers, not penalties" +
 *       §"New helpers this plan introduces".
 *
 * Returns `true` when a remote SKU is semantically empty enough that a
 * textual equality match with a canonical warehouse SKU would be
 * meaningless. Callers treat `true` as a HARD DISQUALIFIER, not a
 * penalty:
 *   - `rankSkuCandidates()` refuses to promote a candidate to
 *     `auto_live_inventory_alias` or `auto_database_identity_match`
 *     when the matching side is a placeholder (still allowed to produce
 *     `auto_shadow_identity_match` / `auto_holdout_for_evidence`).
 *   - `evaluateOrderForHold()` holds the order with reason
 *     `placeholder_sku_detected` when any order line carries one.
 *
 * The set mirrors the examples in the plan plus the Squarespace
 * auto-generated `SQ####` prefix that `sku-sync-audit.ts` already
 * classifies as "placeholder_squarespace" (Phase 5 observation). Short
 * all-digit strings up through 3 digits are considered placeholders
 * because they are rows a human typed into Shopify or WooCommerce when
 * they ran out of ideas — they almost never correspond to a real SKU in
 * this domain.
 */
const PLACEHOLDER_LITERALS = new Set<string>([
  "",
  "0",
  "-",
  "--",
  "n/a",
  "na",
  "none",
  "null",
  "tbd",
  "tba",
  "unknown",
  "placeholder",
  "default",
  "test",
  "sample",
]);

export function isPlaceholderSku(value: string | null | undefined): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;

  const lowered = trimmed.toLowerCase();
  if (PLACEHOLDER_LITERALS.has(lowered)) return true;

  // All-digit strings of 3 characters or fewer are placeholders (e.g.,
  // "1", "4", "55"). Real SKUs are almost never that short, and every
  // real "1"/"4" observed in production has been a placeholder.
  if (/^\d{1,3}$/.test(trimmed)) return true;

  // Squarespace-style auto-generated "SQ#####" SKUs — already treated
  // as placeholder by sku-sync-audit.ts.
  if (/^SQ\d+$/i.test(trimmed)) return true;

  return false;
}
