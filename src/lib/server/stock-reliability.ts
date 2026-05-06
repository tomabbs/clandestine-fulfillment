/**
 * Autonomous SKU matcher — stock-signal reliability tiers + ATP.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Stock signal reliability tiers" + §"ATP, not raw available"
 *       + §"Stock stability gate" + §"New helpers this plan introduces".
 *
 * Design shape:
 *   * `StockSignal` is the structured record that replaces bare integers
 *     throughout the ranker and hold evaluator. Every remote-stock
 *     reading carries its source, both timestamps (remote + local), and
 *     a tier classification.
 *   * `classifyStockTier()` downgrades remote claims whose local age
 *     exceeds 15min / 60min windows, and hard-caps to `cached_only` when
 *     remote clock skew exceeds 1 hour (the "WordPress NTP broken"
 *     failure mode).
 *   * `computeFreshness()` implements the skew-aware freshness used by
 *     `classifyStockTier()` and persisted on decision rows so staff can
 *     see whether a remote clock anomaly influenced the decision.
 *   * `atpOf()` is the only function that converts raw `available` into
 *     ATP for numeric comparison. `rankSkuCandidates()` is BANNED from
 *     reading `signal.value` directly (enforced by lint guard in Phase 1
 *     scripts/lint).
 *   * `isStockStableFor()` is the stability gate consumed by the ranker
 *     tiebreak branch and the hold-queue severity upgrade. Default
 *     windows are 4 hours (warehouse) and 6 hours (remote).
 *
 * Purity contract:
 *   All exports here are pure-ish — the only impure call is `Date.now()`
 *   inside `computeFreshness()` / `classifyStockTier()`, which is the
 *   documented freshness reference clock. Tests set the clock to a fixed
 *   epoch via `vi.useFakeTimers()`.
 */

export type StockTier =
  | "authoritative"
  | "fresh_remote"
  | "fresh_remote_unbounded"
  | "remote_stale"
  | "cached_only"
  | "unknown";

export type StockSource =
  | "warehouse_inventory_levels"
  | "shopify_graphql"
  | "woocommerce_rest"
  | "squarespace_api"
  | "cache"
  | "last_push"
  | "unknown";

/**
 * Structured stock reading. Every remote source MUST set
 * `observedAtLocal` at the moment the fetch returns — CI lint guards
 * enforce that (Phase 1 scripts/lint/sku-stock-signal-observed-at-local.sh).
 */
export interface StockSignal {
  /**
   * Raw remote / warehouse value. May be null for unbounded listings.
   * Ranker code MUST NOT compare this directly — call `atpOf()`.
   */
  value: number | null;
  /**
   * Remote-claimed timestamp. Subject to remote clock skew.
   */
  observedAt: string | null;
  /**
   * Local timestamp captured when the fetch returned. Always trusted.
   * Required on non-authoritative signals.
   */
  observedAtLocal: string | null;
  source: StockSource;
  tier: StockTier;
  /**
   * Present on `fresh_remote_unbounded` signals — explicit flag from the
   * remote API that the listing is sellable without a quantity. MUST be
   * true to enter that tier; large-integer values (`999999`) are never
   * a substitute.
   */
  isUnbounded?: boolean;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const SIXTY_MIN_MS = 60 * 60 * 1000;
const ONE_HOUR_SKEW_MS = 60 * 60 * 1000;
const FIVE_MIN_SKEW_MS = 5 * 60 * 1000;

/**
 * Skew-aware freshness computation. See plan §"Clock-skew handling"
 * and release gate context comments.
 *
 *   * If only the local clock is available, trust it.
 *   * If remote/local differ by more than 5 min, trust the local clock
 *     and record the skew for audit.
 *   * If within 5 min, use the remote timestamp directly.
 */
export function computeFreshness(raw: StockSignal): {
  freshnessMs: number;
  clockSkewMs: number;
  trustClock: "remote" | "local" | "neither";
} {
  if (!raw.observedAtLocal) {
    return { freshnessMs: Number.POSITIVE_INFINITY, clockSkewMs: 0, trustClock: "neither" };
  }
  const localFetchTime = new Date(raw.observedAtLocal).getTime();
  if (!Number.isFinite(localFetchTime)) {
    return { freshnessMs: Number.POSITIVE_INFINITY, clockSkewMs: 0, trustClock: "neither" };
  }
  const nowMs = Date.now();
  const remoteClaimTime = raw.observedAt ? new Date(raw.observedAt).getTime() : null;
  const localAgeMs = nowMs - localFetchTime;

  if (remoteClaimTime === null || !Number.isFinite(remoteClaimTime)) {
    return { freshnessMs: localAgeMs, clockSkewMs: 0, trustClock: "local" };
  }
  const skewMs = remoteClaimTime - localFetchTime;

  if (Math.abs(skewMs) > FIVE_MIN_SKEW_MS) {
    return { freshnessMs: localAgeMs, clockSkewMs: skewMs, trustClock: "local" };
  }

  return {
    freshnessMs: nowMs - remoteClaimTime,
    clockSkewMs: skewMs,
    trustClock: "remote",
  };
}

/**
 * Classify a stock signal into the six reliability tiers. The caller
 * passes in the raw signal; `classifyStockTier()` is idempotent and
 * self-contained so it can be re-run over persisted decision rows.
 */
export function classifyStockTier(raw: StockSignal): StockTier {
  if (raw.source === "warehouse_inventory_levels") return "authoritative";

  if (raw.isUnbounded === true) return "fresh_remote_unbounded";

  if (!raw.observedAtLocal) return "unknown";

  const { freshnessMs, clockSkewMs } = computeFreshness(raw);

  if (Math.abs(clockSkewMs) > ONE_HOUR_SKEW_MS) return "cached_only";

  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) return "unknown";

  if (freshnessMs < FIFTEEN_MIN_MS) return "fresh_remote";
  if (freshnessMs < SIXTY_MIN_MS) return "remote_stale";
  return "cached_only";
}

/**
 * Convert a stock signal + committed units into ATP (available-to-
 * promise). This is the ONLY function that may return a number suitable
 * for numeric comparison in the ranker / hold evaluator.
 *
 *   * Authoritative warehouse signals: `MAX(0, value - committed - safetyStock)`.
 *   * Fresh/stale remote signals: pass-through value (remote ATP is
 *     approximated as `value` because remote platforms don't expose a
 *     first-party committed counter).
 *   * Unbounded / cached_only / unknown: return `null`. Callers MUST
 *     skip numeric tiebreak rather than default to zero or a large
 *     number.
 */
export function atpOf(signal: StockSignal, committed: number, safetyStock = 0): number | null {
  switch (signal.tier) {
    case "authoritative": {
      const base = typeof signal.value === "number" ? signal.value : 0;
      return Math.max(0, base - Math.max(0, committed) - Math.max(0, safetyStock));
    }
    case "fresh_remote":
    case "remote_stale": {
      if (typeof signal.value !== "number" || !Number.isFinite(signal.value)) return null;
      return Math.max(0, signal.value);
    }
    case "fresh_remote_unbounded":
    case "cached_only":
      return null;
    default:
      return null;
  }
}

/**
 * Shape of the historical readings the stability gate consumes. Mirrors
 * the `stock_stability_readings` table written by the
 * `stock-stability-sampler` task (Phase 1+). Test code can construct
 * this in-memory.
 */
export interface StockHistoryReadings {
  readings: Array<{ observedAt: string; value: number | null }>;
}

const STABILITY_WINDOWS_MS = {
  tiebreak: 4 * 60 * 60 * 1000,
  boost: 6 * 60 * 60 * 1000,
  // Promotion gate used by sku-alias-promotion.ts (SKU-AUTO-8). Matches
  // the `boost` window by default because promotion is a stronger,
  // slower-cadence decision than a ranker tiebreak — we want at least 6
  // hours of identical readings before flipping a shadow identity match
  // into a live inventory alias.
  promotion: 6 * 60 * 60 * 1000,
} as const;

/**
 * Stability gate: a stock value is "stable" if every reading inside the
 * window matches the current signal value (within the same finite
 * bucket). Empty history ⇒ not stable (plan: "falls back to no data").
 */
export function isStockStableFor(
  window: keyof typeof STABILITY_WINDOWS_MS,
  signal: StockSignal,
  history: StockHistoryReadings,
  referenceNow: Date = new Date(),
): boolean {
  if (signal.tier === "fresh_remote_unbounded") {
    // Unbounded never participates in a numeric tiebreak; stability is
    // meaningless.
    return false;
  }
  if (signal.value === null || !Number.isFinite(signal.value)) return false;

  const readings = Array.isArray(history?.readings) ? history.readings : [];
  if (readings.length === 0) return false;

  const cutoffMs = referenceNow.getTime() - STABILITY_WINDOWS_MS[window];

  const inWindow = readings.filter((r) => {
    const t = new Date(r.observedAt).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });

  if (inWindow.length === 0) return false;

  return inWindow.every((r) => r.value === signal.value);
}

/**
 * Helper used in tests to materialize a fully-formed StockSignal with
 * tier auto-classified. Not consumed by production code (production
 * callers set the tier explicitly because the classifier is called at
 * ingest time, not ranker time).
 */
export function makeStockSignal(
  partial: Omit<StockSignal, "tier"> & { tier?: StockTier },
): StockSignal {
  const tier = partial.tier ?? classifyStockTier({ ...partial, tier: "unknown" });
  return { ...partial, tier };
}
