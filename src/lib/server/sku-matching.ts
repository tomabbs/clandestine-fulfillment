import { createHash } from "node:crypto";
import { computeEffectiveBandcampAvailableByOption } from "@/lib/server/bandcamp-effective-available";
import {
  type MusicVariantDescriptors,
  parseMusicVariantDescriptors,
} from "@/lib/server/music-variant-descriptors";
import {
  type ConnectionShopifyContext,
  getInventoryLevelsAtLocation,
  iterateAllVariants,
} from "@/lib/server/shopify-connection-graphql";
import {
  buildCandidateEvidence,
  type CandidateEvidence,
  classifyEvidenceGates,
  type DisqualifierCode,
  type EvidenceGateResult,
} from "@/lib/server/sku-candidate-evidence";
import type { StockSignal } from "@/lib/server/stock-reliability";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { normalizeBarcode, normalizeProductText, normalizeSku } from "@/lib/shared/utils";

export type MatchMethod =
  | "existing_mapping"
  | "exact_sku"
  | "exact_barcode"
  | "title_vendor_format"
  | "manual";

export type ConfidenceTier = "deterministic" | "strong" | "possible" | "weak" | "conflict";

export type SkuMatchingRowStatus =
  | "matched_active"
  | "needs_review_no_candidate"
  | "needs_review_low_confidence"
  | "needs_review_multiple_candidates"
  | "remote_only_unmapped"
  | "conflict_duplicate_remote"
  | "conflict_duplicate_canonical"
  | "conflict_existing_sku_sync"
  | "shopify_not_ready";

export type RemoteCatalogFetchState =
  | "ok"
  | "timeout"
  | "rate_limited"
  | "auth_expired"
  | "api_error"
  | "not_supported";

export interface RemoteCatalogItem {
  platform: "shopify" | "woocommerce" | "squarespace";
  remoteProductId: string;
  remoteVariantId: string | null;
  remoteInventoryItemId: string | null;
  remoteSku: string | null;
  productTitle: string;
  variantTitle: string | null;
  combinedTitle: string;
  productType: string | null;
  productUrl: string | null;
  price: number | null;
  barcode: string | null;
  quantity: number | null;
}

export interface BandcampMappingForSelection {
  id: string;
  bandcamp_url: string | null;
  created_at: string;
  updated_at?: string | null;
}

export type RemoteTargetSelectionResult =
  | { ok: true; target: RemoteCatalogItem | null }
  | {
      ok: false;
      code: "ambiguous_remote_target";
      message: string;
      matches: RemoteCatalogItem[];
    };

export interface RemoteCatalogResult {
  state: RemoteCatalogFetchState;
  items: RemoteCatalogItem[];
  error: string | null;
  fetchedAt: string | null;
}

export const REMOTE_CATALOG_TIMEOUTS_MS = {
  shopify: 30_000,
  // Northern Spy's Woo catalog is small in item count but slow per page
  // (~2.5s/page before variations), so 20s falsely marks a healthy store
  // as timed out during SKU review bootstrap.
  woocommerce: 55_000,
  squarespace: 15_000,
} as const;

export interface CanonicalCandidateSignalSource {
  variantId: string;
  sku: string;
  barcode: string | null;
  artist: string | null;
  title: string;
  bandcampTitle: string | null;
  format: string | null;
  variantTitle: string | null;
  optionValue: string | null;
  isPreorder: boolean;
  price: number | null;
  bandcampOptionId: number | null;
  bandcampOptionTitle: string | null;
  bandcampOriginQuantities: unknown;
}

export interface RankedSkuCandidate {
  remote: RemoteCatalogItem;
  score: number;
  matchMethod: MatchMethod | "manual";
  confidenceTier: ConfidenceTier;
  reasons: string[];
  disqualifiers: string[];
  /**
   * Structured per-candidate evidence (plan §1691–1740). Populated only
   * when `rankSkuCandidates` is called with `evidenceContext`. Existing
   * callers that omit the context see `undefined` here and are
   * unaffected — this is purely additive.
   */
  evidence?: CandidateEvidence;
  /**
   * Gate classification of `evidence` (plan §1732–1737). Populated
   * only when `evidence` is populated. `overall` is the recommended
   * outcome; `disqualifiers` is the machine-readable list that
   * explains any non-`pass` result.
   */
  evidenceGates?: EvidenceGateResult;
  /**
   * Machine-readable copy of `evidenceGates.disqualifiers` exposed at
   * the candidate root so downstream consumers that only care about
   * disqualifier codes don't have to reach into `evidenceGates`.
   */
  disqualifierCodes?: ReadonlyArray<DisqualifierCode>;
}

/**
 * Optional context passed to `rankSkuCandidates()` to enable the
 * §1691–1740 structured evidence shape. When omitted, the ranker
 * behaves exactly as before (score + reasons + disqualifiers only)
 * — every existing caller remains source- and behavior-compatible.
 */
export interface RankSkuEvidenceContext {
  /** Canonical-side parsed descriptors. If omitted, ranker parses from
   *  the canonical title/variant automatically. */
  canonicalDescriptors?: MusicVariantDescriptors | null;
  /** Canonical-side identity signals (uniqueness, verified remote id,
   *  verified Bandcamp option, prior safe mapping). All default to
   *  false when omitted — a strict posture consistent with the plan's
   *  "gate cannot be bypassed" invariant. */
  identity?: {
    canonicalSkuUniqueWithinOrg?: boolean;
    remoteSkuUniqueWithinConnection?: (remote: RemoteCatalogItem) => boolean;
    verifiedRemoteId?: (remote: RemoteCatalogItem) => boolean;
    verifiedBandcampOption?: boolean;
    priorMappingId?: string | null;
  };
  /** Per-remote operational lookups. All default to null/unknown tier. */
  operational?: {
    warehouseStock?: StockSignal | null;
    remoteStock?: (remote: RemoteCatalogItem) => StockSignal | null;
    stockedAtDefaultLocation?: (remote: RemoteCatalogItem) => boolean | null;
  };
  /** Per-remote negative-evidence hints. Defaults to all-false. */
  negative?: {
    nonOperationalRow?: (remote: RemoteCatalogItem) => boolean;
    duplicateRemote?: (remote: RemoteCatalogItem) => boolean;
    duplicateCanonicalSku?: boolean;
    genericTitle?: (remote: RemoteCatalogItem) => boolean;
  };
  /** Gate-classifier options — identical to `classifyEvidenceGates`. */
  gateOptions?: {
    enforceShopifyDefaultLocation?: boolean;
    /** Override platform; defaults to `remote.platform` per candidate. */
    platform?: "shopify" | "woocommerce" | "squarespace";
  };
}

function toPriceNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function classifyRemoteCatalogError(error: unknown): {
  state: RemoteCatalogFetchState;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("timeout")) return { state: "timeout", message };
  if (lower.includes("429") || lower.includes("throttled") || lower.includes("rate")) {
    return { state: "rate_limited", message };
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("scope")) {
    return { state: "auth_expired", message };
  }
  return { state: "api_error", message };
}

/**
 * Shopify digital/intangible variants must not enter the SKU Matching remote
 * candidate set — overlapping barcodes with physical LPs/cassettes produces
 * false top candidates.
 *
 * We do **not** rely on GraphQL `requiresShipping` anymore: Shopify has
 * removed/churned that field across `ProductVariant` / queryable `InventoryItem`,
 * which previously caused whole-catalog fetch failures for staff review.
 * Filtering uses title-shape heuristics; `requiresShipping === false` is still
 * honored when a caller supplies it (tests / future REST enrichment).
 *
 * Exported for unit tests (`iterateAllVariants` passes `requiresShipping: null`).
 */
export function shouldExcludeShopifyVariantFromSkuMatchingCatalog(row: {
  requiresShipping: boolean | null;
  productTitle: string;
  variantTitle: string | null;
}): boolean {
  if (row.requiresShipping === false) return true;
  const vt = row.variantTitle?.trim().toLowerCase() ?? "";
  if (vt === "digital") return true;
  const product = row.productTitle.trim();
  if (/\s-\sDigital$/i.test(product)) return true;
  const combined = `${product} ${row.variantTitle?.trim() ?? ""}`.trim();
  if (/\s-\sDigital$/i.test(combined)) return true;
  return false;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchShopifyCatalog(
  connection: ClientStoreConnection,
): Promise<RemoteCatalogItem[]> {
  if (!connection.api_key) throw new Error("Shopify connection missing access token");
  const ctx: ConnectionShopifyContext = {
    storeUrl: connection.store_url,
    accessToken: connection.api_key,
  };

  const storefrontBaseUrl = connection.store_url.replace(/\/admin\/?$/, "").replace(/\/$/, "");
  const items: RemoteCatalogItem[] = [];
  for await (const page of iterateAllVariants(ctx, { pageSize: 50 })) {
    for (const row of page) {
      if (
        shouldExcludeShopifyVariantFromSkuMatchingCatalog({
          requiresShipping: row.requiresShipping,
          productTitle: row.productTitle,
          variantTitle: row.variantTitle,
        })
      ) {
        continue;
      }
      items.push({
        platform: "shopify",
        remoteProductId: row.productId,
        remoteVariantId: row.variantId,
        remoteInventoryItemId: row.inventoryItemId,
        remoteSku: row.sku,
        productTitle: row.productTitle,
        variantTitle: row.variantTitle,
        combinedTitle: [row.productTitle, row.variantTitle].filter(Boolean).join(" - "),
        productType: row.productType,
        productUrl: row.productHandle
          ? `${storefrontBaseUrl}/products/${encodeURIComponent(row.productHandle)}`
          : null,
        price: row.price,
        barcode: row.barcode,
        quantity: null,
      });
    }
  }

  return items;
}

async function fetchWooCatalog(connection: ClientStoreConnection): Promise<RemoteCatalogItem[]> {
  if (!connection.api_key || !connection.api_secret) {
    throw new Error("WooCommerce connection missing credentials");
  }
  const { listCatalogItems } = await import("@/lib/clients/woocommerce-client");
  const items = await listCatalogItems({
    consumerKey: connection.api_key,
    consumerSecret: connection.api_secret,
    siteUrl: connection.store_url,
    preferredAuthMode: connection.preferred_auth_mode ?? null,
  });

  return items.map((item) => ({
    platform: "woocommerce",
    remoteProductId: String(item.productId),
    remoteVariantId: item.variationId ? String(item.variationId) : null,
    remoteInventoryItemId: null,
    remoteSku: item.sku,
    productTitle: item.name,
    variantTitle: item.variationId ? item.name : null,
    combinedTitle: item.name,
    productType: null,
    productUrl: item.permalink,
    price: toPriceNumber(item.price),
    barcode: null,
    quantity: item.stock_quantity,
  }));
}

async function fetchSquarespaceCatalog(
  connection: ClientStoreConnection,
): Promise<RemoteCatalogItem[]> {
  if (!connection.api_key) throw new Error("Squarespace connection missing API key");
  const { listCatalogItems } = await import("@/lib/clients/squarespace-client");
  const items = await listCatalogItems(connection.api_key);

  return items.map((item) => ({
    platform: "squarespace",
    remoteProductId: item.productId,
    remoteVariantId: item.variantId,
    remoteInventoryItemId: null,
    remoteSku: item.sku,
    productTitle: item.productName,
    variantTitle: item.variantName,
    combinedTitle: [item.productName, item.variantName].filter(Boolean).join(" - "),
    productType: item.productType,
    productUrl: item.productUrl,
    price: null,
    barcode: null,
    quantity: item.quantity,
  }));
}

export async function fetchRemoteCatalogWithTimeout(
  connection: ClientStoreConnection,
): Promise<RemoteCatalogResult> {
  if (
    connection.platform !== "shopify" &&
    connection.platform !== "woocommerce" &&
    connection.platform !== "squarespace"
  ) {
    return {
      state: "not_supported",
      items: [],
      error: `Platform ${connection.platform} is not supported in SKU matching`,
      fetchedAt: null,
    };
  }

  try {
    const items =
      connection.platform === "shopify"
        ? await withTimeout(fetchShopifyCatalog(connection), REMOTE_CATALOG_TIMEOUTS_MS.shopify)
        : connection.platform === "woocommerce"
          ? await withTimeout(fetchWooCatalog(connection), REMOTE_CATALOG_TIMEOUTS_MS.woocommerce)
          : await withTimeout(
              fetchSquarespaceCatalog(connection),
              REMOTE_CATALOG_TIMEOUTS_MS.squarespace,
            );

    return {
      state: "ok",
      items,
      error: null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const classified = classifyRemoteCatalogError(error);
    return {
      state: classified.state,
      items: [],
      error: classified.message,
      fetchedAt: null,
    };
  }
}

function buildCanonicalTitles(canonical: CanonicalCandidateSignalSource): string[] {
  return [
    canonical.bandcampTitle,
    canonical.title,
    canonical.variantTitle,
    canonical.optionValue,
    canonical.bandcampOptionTitle,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function hasBandcampOptionStock(canonical: CanonicalCandidateSignalSource): boolean {
  if (!canonical.bandcampOptionId) return false;
  const optionAvailability = computeEffectiveBandcampAvailableByOption(
    canonical.bandcampOriginQuantities,
  );
  return (optionAvailability.get(canonical.bandcampOptionId) ?? 0) > 0;
}

function classifyCandidate(score: number, disqualifiers: string[]): ConfidenceTier {
  if (disqualifiers.length > 0) return "conflict";
  if (score >= 100) return "deterministic";
  if (score >= 65) return "strong";
  if (score >= 35) return "possible";
  return "weak";
}

function mappingTimestamp(value: BandcampMappingForSelection): number {
  const timestamp = Date.parse(value.updated_at ?? value.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function pickPrimaryBandcampMapping<T extends BandcampMappingForSelection>(
  raw: T | T[] | null | undefined,
): T | null {
  const mappings = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean);
  if (mappings.length === 0) return null;

  return (
    [...mappings].sort((a, b) => {
      const aHasUrl = Boolean(a.bandcamp_url?.trim());
      const bHasUrl = Boolean(b.bandcamp_url?.trim());
      if (aHasUrl !== bHasUrl) return aHasUrl ? -1 : 1;

      const timestampDelta = mappingTimestamp(b) - mappingTimestamp(a);
      if (timestampDelta !== 0) return timestampDelta;

      return b.id.localeCompare(a.id);
    })[0] ?? null
  );
}

export function selectConnectionScopedRemoteTarget(input: {
  items: readonly RemoteCatalogItem[];
  remoteInventoryItemId?: string | null;
  remoteVariantId?: string | null;
  remoteProductId?: string | null;
  remoteSku?: string | null;
}): RemoteTargetSelectionResult {
  const byInventoryItem = input.remoteInventoryItemId
    ? input.items.find((item) => item.remoteInventoryItemId === input.remoteInventoryItemId)
    : null;
  if (byInventoryItem) return { ok: true, target: byInventoryItem };

  const byVariant = input.remoteVariantId
    ? input.items.find((item) => item.remoteVariantId === input.remoteVariantId)
    : null;
  if (byVariant) return { ok: true, target: byVariant };

  if (!input.remoteProductId) return { ok: true, target: null };

  const productMatches = input.items.filter(
    (item) => item.remoteProductId === input.remoteProductId,
  );
  if (productMatches.length <= 1) {
    return { ok: true, target: productMatches[0] ?? null };
  }

  const normalizedRemoteSku = normalizeSku(input.remoteSku);
  if (normalizedRemoteSku) {
    const skuMatches = productMatches.filter(
      (item) => normalizeSku(item.remoteSku) === normalizedRemoteSku,
    );
    if (skuMatches.length === 1) return { ok: true, target: skuMatches[0] ?? null };
  }

  return {
    ok: false,
    code: "ambiguous_remote_target",
    message:
      "Multiple variants found without a unique SKU. Please add SKUs in Shopify before matching.",
    matches: productMatches,
  };
}

export function rankSkuCandidates(
  canonical: CanonicalCandidateSignalSource,
  remoteItems: RemoteCatalogItem[],
  evidenceContext?: RankSkuEvidenceContext,
): RankedSkuCandidate[] {
  const normalizedCanonicalSku = normalizeSku(canonical.sku);
  const normalizedCanonicalBarcode = normalizeBarcode(canonical.barcode);
  const normalizedArtist = normalizeProductText(canonical.artist);
  const normalizedFormat = normalizeProductText(canonical.format);
  const canonicalTitles = buildCanonicalTitles(canonical).map(normalizeProductText).filter(Boolean);
  const optionHasStock = hasBandcampOptionStock(canonical);

  const canonicalDescriptors = evidenceContext
    ? (evidenceContext.canonicalDescriptors ??
      parseMusicVariantDescriptors({
        title: [canonical.title, canonical.variantTitle, canonical.optionValue]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(" - "),
      }))
    : null;

  const ranked = remoteItems
    .map((remote): RankedSkuCandidate => {
      const reasons: string[] = [];
      const disqualifiers: string[] = [];
      let score = 0;
      let matchMethod: MatchMethod | "manual" = "manual";

      const normalizedRemoteSku = normalizeSku(remote.remoteSku);
      const normalizedRemoteBarcode = normalizeBarcode(remote.barcode);
      const normalizedRemoteTitle = normalizeProductText(remote.combinedTitle);
      const normalizedRemoteProductTitle = normalizeProductText(remote.productTitle);
      const normalizedRemoteVariantTitle = normalizeProductText(remote.variantTitle);
      const normalizedRemoteType = normalizeProductText(remote.productType);

      if (!normalizedRemoteSku && !normalizedRemoteBarcode) {
        disqualifiers.push("blank_sku_no_other_id");
      }

      if (
        normalizedCanonicalSku &&
        normalizedRemoteSku &&
        normalizedCanonicalSku === normalizedRemoteSku
      ) {
        score += 100;
        matchMethod = "exact_sku";
        reasons.push("Exact SKU match");
      }

      if (
        normalizedCanonicalBarcode &&
        normalizedRemoteBarcode &&
        normalizedCanonicalBarcode === normalizedRemoteBarcode
      ) {
        score += 95;
        matchMethod = "exact_barcode";
        reasons.push("Exact barcode / UPC match");
      }

      if (normalizedArtist) {
        const artistMatched =
          normalizedRemoteTitle.includes(normalizedArtist) ||
          normalizedRemoteProductTitle.includes(normalizedArtist);
        if (artistMatched) {
          score += 12;
          reasons.push("Artist / vendor text aligns");
        }
      }

      const titleMatched = canonicalTitles.some(
        (title) =>
          normalizedRemoteTitle.includes(title) ||
          normalizedRemoteProductTitle.includes(title) ||
          normalizedRemoteVariantTitle.includes(title),
      );
      if (titleMatched) {
        score += 30;
        reasons.push("Title / Bandcamp title aligns");
      }

      if (normalizedFormat) {
        const formatMatched =
          normalizedRemoteTitle.includes(normalizedFormat) ||
          normalizedRemoteVariantTitle.includes(normalizedFormat) ||
          normalizedRemoteType.includes(normalizedFormat);
        if (formatMatched) {
          score += 16;
          reasons.push("Format / type aligns");
        }
      }

      const optionNeedle = normalizeProductText(
        canonical.optionValue ?? canonical.bandcampOptionTitle ?? canonical.variantTitle,
      );
      if (
        optionNeedle &&
        (normalizedRemoteVariantTitle.includes(optionNeedle) ||
          normalizedRemoteTitle.includes(optionNeedle))
      ) {
        score += 14;
        reasons.push("Variant / option text aligns");
      }

      if (canonical.isPreorder) {
        score += 2;
        reasons.push("Canonical row is a preorder");
      }

      if (canonical.price != null && remote.price != null) {
        const delta = Math.abs(canonical.price - remote.price);
        if (delta === 0) {
          score += 8;
          reasons.push("Exact price match");
        } else if (delta <= 1) {
          score += 4;
          reasons.push("Price is within $1");
        }
      }

      if (optionHasStock) {
        score += 5;
        reasons.push("Bandcamp option has positive effective origin stock");
      }

      if (!titleMatched && !normalizedRemoteSku && !normalizedRemoteBarcode) {
        disqualifiers.push("title_only_or_weaker_match");
      }

      const confidenceTier = classifyCandidate(score, disqualifiers);
      if (
        matchMethod === "manual" &&
        confidenceTier === "strong" &&
        titleMatched &&
        normalizedArtist &&
        normalizedFormat
      ) {
        matchMethod = "title_vendor_format";
      }

      const base: RankedSkuCandidate = {
        remote,
        score,
        matchMethod,
        confidenceTier,
        reasons,
        disqualifiers,
      };

      if (!evidenceContext) return base;

      const remoteDescriptors = parseMusicVariantDescriptors({
        title: [remote.productTitle, remote.variantTitle]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(" - "),
      });
      const evidence = buildCandidateEvidence({
        canonical: {
          sku: canonical.sku,
          barcode: canonical.barcode,
          descriptors: canonicalDescriptors,
          priorMappingId: evidenceContext.identity?.priorMappingId ?? null,
        },
        remote: {
          sku: remote.remoteSku,
          barcode: remote.barcode,
          combinedTitle: remote.combinedTitle,
          descriptors: remoteDescriptors,
          platform: remote.platform,
        },
        identitySignals: {
          verifiedRemoteId: evidenceContext.identity?.verifiedRemoteId?.(remote) ?? false,
          verifiedBandcampOption: evidenceContext.identity?.verifiedBandcampOption ?? false,
          canonicalSkuUniqueWithinOrg:
            evidenceContext.identity?.canonicalSkuUniqueWithinOrg ?? false,
          remoteSkuUniqueWithinConnection:
            evidenceContext.identity?.remoteSkuUniqueWithinConnection?.(remote) ?? false,
        },
        operationalSignals: {
          warehouseStock: evidenceContext.operational?.warehouseStock ?? null,
          remoteStock: evidenceContext.operational?.remoteStock?.(remote) ?? null,
          stockedAtDefaultLocation:
            evidenceContext.operational?.stockedAtDefaultLocation?.(remote) ?? null,
        },
        negativeSignals: {
          genericTitle: evidenceContext.negative?.genericTitle?.(remote) ?? false,
          nonOperationalRow: evidenceContext.negative?.nonOperationalRow?.(remote) ?? false,
          duplicateCanonicalSku: evidenceContext.negative?.duplicateCanonicalSku ?? false,
          duplicateRemote: evidenceContext.negative?.duplicateRemote?.(remote) ?? false,
        },
      });

      const gates = classifyEvidenceGates(evidence, {
        enforceShopifyDefaultLocation:
          evidenceContext.gateOptions?.enforceShopifyDefaultLocation ?? true,
        platform: evidenceContext.gateOptions?.platform ?? remote.platform,
      });

      return {
        ...base,
        evidence,
        evidenceGates: gates,
        disqualifierCodes: gates.disqualifiers,
      };
    })
    .filter((candidate) => candidate.score > 0 || candidate.disqualifiers.length > 0)
    .sort(
      (a, b) => b.score - a.score || a.remote.combinedTitle.localeCompare(b.remote.combinedTitle),
    );

  return ranked;
}

export function buildCandidateFingerprint(input: {
  variantId: string;
  canonicalSku: string;
  canonicalBarcode: string | null;
  remoteProductId: string | null;
  remoteVariantId: string | null;
  remoteInventoryItemId: string | null;
  remoteSku: string | null;
  existingMappingId: string | null;
  existingMappingUpdatedAt: string | null;
  conflictCount?: number;
  disqualifiers?: readonly string[];
}): string {
  const conflictCount = input.disqualifiers
    ? [...input.disqualifiers].sort((a, b) => a.localeCompare(b)).length
    : (input.conflictCount ?? 0);
  const serialized = JSON.stringify({
    variantId: input.variantId,
    canonicalSku: normalizeSku(input.canonicalSku),
    canonicalBarcode: normalizeBarcode(input.canonicalBarcode),
    remoteProductId: input.remoteProductId ?? null,
    remoteVariantId: input.remoteVariantId ?? null,
    remoteInventoryItemId: input.remoteInventoryItemId ?? null,
    remoteSku: normalizeSku(input.remoteSku),
    existingMappingId: input.existingMappingId ?? null,
    existingMappingUpdatedAt: input.existingMappingUpdatedAt ?? null,
    conflictCount,
  });

  return createHash("sha256").update(serialized).digest("hex").slice(0, 24);
}

export async function classifyShopifyReadiness(input: {
  connection: ClientStoreConnection;
  remoteInventoryItemId: string | null;
}): Promise<{
  state:
    | "ready_at_default_location"
    | "missing_default_location"
    | "missing_remote_inventory_item_id"
    | "not_stocked_at_default_location"
    | "location_read_failed";
  available: number | null;
  message: string;
}> {
  if (!input.connection.default_location_id) {
    return {
      state: "missing_default_location",
      available: null,
      message: "Select a default Shopify location before activating this mapping.",
    };
  }
  if (!input.remoteInventoryItemId) {
    return {
      state: "missing_remote_inventory_item_id",
      available: null,
      message: "Run Shopify SKU discovery so this mapping captures the inventory item id.",
    };
  }
  if (!input.connection.api_key) {
    return {
      state: "location_read_failed",
      available: null,
      message: "Shopify connection has no access token.",
    };
  }

  try {
    const levels = await getInventoryLevelsAtLocation(
      {
        storeUrl: input.connection.store_url,
        accessToken: input.connection.api_key,
      },
      [
        input.remoteInventoryItemId.startsWith("gid://shopify/InventoryItem/")
          ? input.remoteInventoryItemId
          : `gid://shopify/InventoryItem/${input.remoteInventoryItemId}`,
      ],
      input.connection.default_location_id.startsWith("gid://shopify/Location/")
        ? input.connection.default_location_id
        : `gid://shopify/Location/${input.connection.default_location_id}`,
    );

    const value = levels.get(
      input.remoteInventoryItemId.startsWith("gid://shopify/InventoryItem/")
        ? input.remoteInventoryItemId
        : `gid://shopify/InventoryItem/${input.remoteInventoryItemId}`,
    );

    if (value == null) {
      return {
        state: "not_stocked_at_default_location",
        available: null,
        message: "Inventory item exists but is not stocked at the selected default location.",
      };
    }

    return {
      state: "ready_at_default_location",
      available: value,
      message: "Inventory item is active at the selected default location.",
    };
  } catch (error) {
    return {
      state: "location_read_failed",
      available: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
