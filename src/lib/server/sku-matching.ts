import { createHash } from "node:crypto";
import { computeEffectiveBandcampAvailableByOption } from "@/lib/server/bandcamp-effective-available";
import {
  type MusicFormat,
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

/** Staff review: disqualifier when parsed physical medium disagrees with warehouse format. */
export const PHYSICAL_FORMAT_MISMATCH_DISQUALIFIER = "physical_format_mismatch";

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

/** Vinyl sizes + LP share one fulfillment bucket vs cassette / CD / digital / apparel. */
export type PhysicalMediaFamily =
  | "vinyl"
  | "cassette"
  | "cd"
  | "digital"
  | "apparel"
  | "other"
  | "unknown";

export function physicalMediaFamily(format: MusicFormat): PhysicalMediaFamily {
  switch (format) {
    case "lp":
    case "7inch":
    case "10inch":
    case "12inch":
      return "vinyl";
    case "cassette":
      return "cassette";
    case "cd":
      return "cd";
    case "digital":
      return "digital";
    case "shirt":
    case "hoodie":
      return "apparel";
    case "unknown":
      return "unknown";
    default:
      return "other";
  }
}

/** True when both sides have a definite medium and buckets differ (LP vs cassette, CD vs vinyl, …). */
export function physicalMediumFamiliesDisagree(a: MusicFormat, b: MusicFormat): boolean {
  const fa = physicalMediaFamily(a);
  const fb = physicalMediaFamily(b);
  if (fa === "unknown" || fb === "unknown") return false;
  if (fa === "other" || fb === "other") return false;
  return fa !== fb;
}

const TITLE_TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "for",
  "to",
  "records",
  "record",
  "recordings",
  "label",
  "music",
  "lp",
  "vinyl",
  "cassette",
  "cs",
  "cd",
  "compact",
  "disc",
  "digital",
  "download",
  "default",
  "title",
  "variant",
  "blue",
  "black",
  "white",
  "clear",
  "red",
  "green",
  "yellow",
  "orange",
  "purple",
  "pink",
]);

function normalizedTokens(value: string | null | undefined): string[] {
  return normalizeProductText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

export function skuMatchingTitleTokens(canonical: CanonicalCandidateSignalSource): string[] {
  const preferredTitle = canonical.bandcampTitle?.trim() || canonical.title;
  const artistTokens = new Set(normalizedTokens(canonical.artist));
  const seen = new Set<string>();

  return normalizedTokens(preferredTitle).filter((token) => {
    if (token.length < 3) return false;
    if (TITLE_TOKEN_STOP_WORDS.has(token)) return false;
    if (artistTokens.has(token)) return false;
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

function remoteContainsTitleToken(remote: RemoteCatalogItem, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const remoteTokens = new Set(
    normalizedTokens([remote.productTitle, remote.variantTitle, remote.productType].join(" ")),
  );
  return tokens.some((token) => remoteTokens.has(token));
}

export function skuMatchingCanonicalDescriptorTitle(
  canonical: CanonicalCandidateSignalSource,
): string {
  // `warehouse_product_variants.format_name` is the canonical physical format.
  // Do not mix in variant text here: rows can carry stale/contradictory option
  // labels such as "BLUE CASSETTE" while the warehouse format is LP.
  if (canonical.format?.trim()) return canonical.format.trim();
  return [canonical.title, canonical.bandcampTitle, canonical.variantTitle, canonical.optionValue]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" - ");
}

export function skuMatchingRemoteDescriptorTitle(remote: RemoteCatalogItem): string {
  return [remote.productTitle, remote.variantTitle, remote.productType]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" - ");
}

export function skuMatchingPhysicalFormatMismatch(
  canonical: CanonicalCandidateSignalSource,
  remote: RemoteCatalogItem,
): boolean {
  const cDesc = parseMusicVariantDescriptors({
    title: skuMatchingCanonicalDescriptorTitle(canonical),
  });
  const rDesc = parseMusicVariantDescriptors({ title: skuMatchingRemoteDescriptorTitle(remote) });
  return physicalMediumFamiliesDisagree(cDesc.format, rDesc.format);
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
  return [canonical.bandcampTitle, canonical.title].filter((value): value is string =>
    Boolean(value?.trim()),
  );
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
  const canonicalTitleTokens = skuMatchingTitleTokens(canonical);
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

      const exactTitleMatched = canonicalTitles.some(
        (title) =>
          normalizedRemoteTitle.includes(title) ||
          normalizedRemoteProductTitle.includes(title) ||
          normalizedRemoteVariantTitle.includes(title),
      );
      const titleTokenMatched = remoteContainsTitleToken(remote, canonicalTitleTokens);
      const titleMatched = exactTitleMatched || titleTokenMatched;
      if (titleMatched) {
        score += 30;
        reasons.push(exactTitleMatched ? "Title / Bandcamp title aligns" : "Title word overlaps");
      }

      const canonicalDescriptor = parseMusicVariantDescriptors({
        title: skuMatchingCanonicalDescriptorTitle(canonical),
      });
      const remoteDescriptor = parseMusicVariantDescriptors({
        title: skuMatchingRemoteDescriptorTitle(remote),
      });
      const samePhysicalFamily =
        physicalMediaFamily(canonicalDescriptor.format) !== "unknown" &&
        physicalMediaFamily(remoteDescriptor.format) !== "unknown" &&
        physicalMediaFamily(canonicalDescriptor.format) ===
          physicalMediaFamily(remoteDescriptor.format);
      const rawFormatMatched =
        normalizedFormat &&
        (normalizedRemoteTitle.includes(normalizedFormat) ||
          normalizedRemoteVariantTitle.includes(normalizedFormat) ||
          normalizedRemoteType.includes(normalizedFormat));
      if (samePhysicalFamily || rawFormatMatched) {
        score += 16;
        reasons.push(samePhysicalFamily ? "Physical format family aligns" : "Format / type aligns");
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

      if (!titleMatched && !normalizedRemoteSku && !normalizedRemoteBarcode) {
        disqualifiers.push("no_title_token_overlap");
      }

      if (skuMatchingPhysicalFormatMismatch(canonical, remote)) {
        disqualifiers.push(PHYSICAL_FORMAT_MISMATCH_DISQUALIFIER);
        reasons.push("Physical medium differs from warehouse (LP vs cassette, CD vs vinyl, etc.)");
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
    .sort((a, b) => {
      const formatClash = (r: RankedSkuCandidate) =>
        r.disqualifiers.includes(PHYSICAL_FORMAT_MISMATCH_DISQUALIFIER);
      const clashA = formatClash(a);
      const clashB = formatClash(b);
      if (clashA !== clashB) return clashA ? 1 : -1;
      const byScore = b.score - a.score;
      if (byScore !== 0) return byScore;
      return a.remote.combinedTitle.localeCompare(b.remote.combinedTitle);
    });

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
