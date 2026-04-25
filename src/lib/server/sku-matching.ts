import { createHash } from "node:crypto";
import { computeEffectiveBandcampAvailableByOption } from "@/lib/server/bandcamp-effective-available";
import {
  type ConnectionShopifyContext,
  getInventoryLevelsAtLocation,
  iterateAllVariants,
} from "@/lib/server/shopify-connection-graphql";
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

export interface RemoteCatalogResult {
  state: RemoteCatalogFetchState;
  items: RemoteCatalogItem[];
  error: string | null;
  fetchedAt: string | null;
}

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

  const items: RemoteCatalogItem[] = [];
  for await (const page of iterateAllVariants(ctx, { pageSize: 50 })) {
    for (const row of page) {
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
        productUrl: null,
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
  const timeoutsMs: Record<string, number> = {
    shopify: 30_000,
    woocommerce: 20_000,
    squarespace: 15_000,
  };

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
        ? await withTimeout(fetchShopifyCatalog(connection), timeoutsMs.shopify)
        : connection.platform === "woocommerce"
          ? await withTimeout(fetchWooCatalog(connection), timeoutsMs.woocommerce)
          : await withTimeout(fetchSquarespaceCatalog(connection), timeoutsMs.squarespace);

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

export function rankSkuCandidates(
  canonical: CanonicalCandidateSignalSource,
  remoteItems: RemoteCatalogItem[],
): RankedSkuCandidate[] {
  const normalizedCanonicalSku = normalizeSku(canonical.sku);
  const normalizedCanonicalBarcode = normalizeBarcode(canonical.barcode);
  const normalizedArtist = normalizeProductText(canonical.artist);
  const normalizedFormat = normalizeProductText(canonical.format);
  const canonicalTitles = buildCanonicalTitles(canonical).map(normalizeProductText).filter(Boolean);
  const optionHasStock = hasBandcampOptionStock(canonical);

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

      return {
        remote,
        score,
        matchMethod,
        confidenceTier,
        reasons,
        disqualifiers,
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
  conflictCount: number;
}): string {
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
    conflictCount: input.conflictCount,
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
