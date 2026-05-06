"use server";

/**
 * Pre-order Server Actions.
 *
 * Rule #48: Heavy work (release logic) fires Trigger tasks, not direct API calls.
 */

import { tasks } from "@trigger.dev/sdk";
import { getOrders, refreshBandcampToken } from "@/lib/clients/bandcamp";
import {
  classifyBandcampPreorderSignal,
  getRecentBandcampProductDate,
  getRecentBandcampProductDateEvidence,
  isRecentBandcampProduct,
  summarizeBandcampPreorderSignals,
} from "@/lib/server/bandcamp-preorder-dashboard";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { getTodayNY } from "@/lib/shared/preorder-dates";
import { allocatePreorders } from "@/trigger/lib/preorder-allocation";

export async function getPreorderProducts(filters?: { page?: number; pageSize?: number }) {
  const supabase = await createServerSupabaseClient();
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const { data: variants, count } = await supabase
    .from("warehouse_product_variants")
    .select(
      `
      id, workspace_id, sku, title, format_name, street_date, is_preorder, product_id, bandcamp_option_title,
      warehouse_products!inner(title, vendor, org_id, shopify_product_id),
      bandcamp_product_mappings(bandcamp_url, bandcamp_subdomain, bandcamp_type_name, bandcamp_album_title, bandcamp_member_band_id, raw_api_data)
    `,
      { count: "exact" },
    )
    .eq("is_preorder", true)
    .order("street_date", { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (!variants) return { variants: [], total: 0 };

  // Get pending preorder demand per variant SKU. Count units, not line rows, and exclude
  // orders that are already fulfilled/cancelled so the release list reflects remaining work.
  const skus = variants.map((v) => v.sku);
  const { data: orderItems } = await supabase
    .from("warehouse_order_items")
    .select("sku, quantity, warehouse_orders!inner(id, is_preorder, fulfillment_status)")
    .in("sku", skus);

  const pendingDemandBySku = new Map<string, { orders: Set<string>; units: number }>();
  for (const item of orderItems ?? []) {
    const order = item.warehouse_orders as unknown as {
      id: string | null;
      is_preorder: boolean | null;
      fulfillment_status: string | null;
    };
    if (
      !order?.is_preorder ||
      ["fulfilled", "cancelled"].includes(order.fulfillment_status ?? "")
    ) {
      continue;
    }
    const current = pendingDemandBySku.get(item.sku) ?? { orders: new Set<string>(), units: 0 };
    if (order.id) current.orders.add(order.id);
    current.units += item.quantity;
    pendingDemandBySku.set(item.sku, current);
  }

  // Get inventory levels per SKU
  const { data: inventoryLevels } = await supabase
    .from("warehouse_inventory_levels")
    .select("sku, available")
    .in("sku", skus);

  const inventoryBySku = new Map<string, number>();
  for (const level of inventoryLevels ?? []) {
    inventoryBySku.set(level.sku, level.available);
  }

  const enriched = variants.map((v) => {
    const product = v.warehouse_products as unknown as {
      title: string;
      vendor: string | null;
      org_id: string;
    };
    const bandcampMapping = firstRelated<{
      bandcamp_url: string | null;
      bandcamp_subdomain: string | null;
      bandcamp_type_name: string | null;
      bandcamp_album_title: string | null;
      bandcamp_member_band_id: number | null;
      raw_api_data: Record<string, unknown> | null;
    }>(v.bandcamp_product_mappings);
    const pendingDemand = pendingDemandBySku.get(v.sku);
    const pendingOrderCount = pendingDemand?.orders.size ?? 0;
    const pendingUnits = pendingDemand?.units ?? 0;
    const available = inventoryBySku.get(v.sku) ?? 0;
    const bandcampPackageTitle = stringFromRecord(bandcampMapping?.raw_api_data, "title");
    const bandcampOptionTitle = v.bandcamp_option_title?.trim() || null;
    const bandcampSoldUnits = resolveBandcampSoldUnits(bandcampMapping?.raw_api_data);
    const artistName = resolveReleaseArtistName({
      productTitle: product.title,
      productVendor: product.vendor,
      albumTitle: bandcampMapping?.bandcamp_album_title,
      bandcampSubdomain:
        bandcampMapping?.bandcamp_subdomain ??
        stringFromRecord(bandcampMapping?.raw_api_data, "subdomain"),
    });

    return {
      id: v.id,
      workspace_id: v.workspace_id,
      sku: v.sku,
      variantTitle: v.title,
      formatName: resolveReleaseFormat({
        sku: v.sku,
        formatName: v.format_name,
        bandcampTypeName: bandcampMapping?.bandcamp_type_name,
        title: `${product.title} ${v.title ?? ""}`,
      }),
      bandcampUrl: bandcampMapping?.bandcamp_url ?? null,
      productTitle: resolveBandcampPackageTitle({
        artistName,
        bandcampAlbumTitle: bandcampMapping?.bandcamp_album_title,
        packageTitle: bandcampPackageTitle,
        optionTitle: bandcampOptionTitle,
        fallbackTitle: v.title,
      }),
      bandcampPackageTitle,
      bandcampOptionTitle,
      streetDate: v.street_date,
      pendingOrderCount,
      pendingUnits,
      bandcampSoldUnits,
      liveBandcampOrderCount: 0,
      liveBandcampUnitCount: 0,
      liveBandcampOrderNumbers: [] as string[],
      availableStock: available,
      isShortRisk: pendingUnits > available,
      bandcampMemberBandId: bandcampMapping?.bandcamp_member_band_id ?? null,
    };
  });

  const liveDemandBySku = await fetchLiveBandcampDemand(enriched);
  const enrichedWithLiveDemand = enriched.map((variant) => {
    const liveDemand = liveDemandBySku.get(variant.sku);
    if (!liveDemand) return variant;
    return {
      ...variant,
      liveBandcampOrderCount: liveDemand.orderNumbers.length,
      liveBandcampUnitCount: liveDemand.unitCount,
      liveBandcampOrderNumbers: liveDemand.orderNumbers,
      isShortRisk: Math.max(variant.pendingUnits, liveDemand.unitCount) > variant.availableStock,
    };
  });

  return { variants: enrichedWithLiveDemand, total: count ?? 0 };
}

type BandcampMappingSignalRow = {
  id: string;
  variant_id: string;
  created_at: string;
  bandcamp_subdomain: string | null;
  bandcamp_album_title: string | null;
  bandcamp_url: string | null;
  bandcamp_release_date: string | null;
  bandcamp_new_date: string | null;
  bandcamp_is_preorder: boolean | null;
  bandcamp_type_name: string | null;
  scrape_status: string | null;
  consecutive_failures: number | null;
};

type VariantPreorderProbe = {
  id: string;
  sku: string | null;
  title: string | null;
  format_name: string | null;
  is_preorder: boolean | null;
  street_date: string | null;
};

export async function getBandcampProductDetectionDashboard(filters?: {
  newProductDays?: number;
  limit?: number;
}) {
  const supabase = await createServerSupabaseClient();
  const today = getTodayNY();
  const newProductDays = filters?.newProductDays ?? 30;
  const limit = Math.min(filters?.limit ?? 20, 100);
  const windowStart = getDateDaysAgo(today, newProductDays);

  const { data: newProducts } = await supabase
    .from("bandcamp_product_mappings")
    .select(
      "id, variant_id, created_at, bandcamp_subdomain, bandcamp_album_title, bandcamp_url, bandcamp_release_date, bandcamp_new_date, bandcamp_is_preorder, bandcamp_type_name, scrape_status, consecutive_failures",
    )
    .or(
      `and(bandcamp_release_date.gte.${windowStart}T00:00:00Z,bandcamp_release_date.lte.${today}T23:59:59Z),and(bandcamp_new_date.gte.${windowStart},bandcamp_new_date.lte.${today})`,
    )
    .order("bandcamp_release_date", { ascending: false, nullsFirst: false })
    .order("bandcamp_new_date", { ascending: false, nullsFirst: false })
    .limit(limit * 2);

  const { data: signalRows } = await supabase
    .from("bandcamp_product_mappings")
    .select(
      "id, variant_id, created_at, bandcamp_subdomain, bandcamp_album_title, bandcamp_url, bandcamp_release_date, bandcamp_new_date, bandcamp_is_preorder, bandcamp_type_name, scrape_status, consecutive_failures",
    )
    .or(
      `bandcamp_release_date.gt.${today}T00:00:00Z,bandcamp_new_date.gt.${today},bandcamp_is_preorder.eq.true`,
    )
    .limit(500);

  const allRows = [
    ...((newProducts ?? []) as BandcampMappingSignalRow[]),
    ...((signalRows ?? []) as BandcampMappingSignalRow[]),
  ];
  const variantIds = Array.from(new Set(allRows.map((row) => row.variant_id).filter(Boolean)));
  const variantById = new Map<string, VariantPreorderProbe>();
  for (let i = 0; i < variantIds.length; i += 200) {
    const chunk = variantIds.slice(i, i + 200);
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, title, format_name, is_preorder, street_date")
      .in("id", chunk);
    for (const variant of (variants ?? []) as VariantPreorderProbe[]) {
      variantById.set(variant.id, variant);
    }
  }

  const signalItems = ((signalRows ?? []) as BandcampMappingSignalRow[]).map((row) => {
    const variant = variantById.get(row.variant_id);
    const signalKind = classifyBandcampPreorderSignal({
      today,
      bandcampReleaseDate: row.bandcamp_release_date,
      bandcampNewDate: row.bandcamp_new_date,
      bandcampIsPreorder: row.bandcamp_is_preorder,
    });
    return {
      id: row.id,
      variantId: row.variant_id,
      sku: variant?.sku ?? null,
      formatName: resolveReleaseFormat({
        sku: variant?.sku,
        formatName: variant?.format_name,
        bandcampTypeName: row.bandcamp_type_name,
        title: variant?.title,
      }),
      title: row.bandcamp_album_title ?? variant?.title ?? "Untitled Bandcamp item",
      bandcampSubdomain: row.bandcamp_subdomain,
      bandcampUrl: row.bandcamp_url,
      bandcampReleaseDate: row.bandcamp_release_date,
      bandcampNewDate: row.bandcamp_new_date,
      bandcampIsPreorder: row.bandcamp_is_preorder,
      variantIsPreorder: variant?.is_preorder ?? null,
      variantStreetDate: variant?.street_date ?? null,
      scrapeStatus: row.scrape_status,
      consecutiveFailures: row.consecutive_failures ?? 0,
      signalKind,
      dashboardMiss: signalKind === "current_upcoming" && variant?.is_preorder !== true,
    };
  });

  const newProductItems = ((newProducts ?? []) as BandcampMappingSignalRow[])
    .filter((row) =>
      isRecentBandcampProduct({
        today,
        windowStart,
        bandcampReleaseDate: row.bandcamp_release_date,
        bandcampNewDate: row.bandcamp_new_date,
      }),
    )
    .filter(
      (row) =>
        classifyBandcampPreorderSignal({
          today,
          bandcampReleaseDate: row.bandcamp_release_date,
          bandcampNewDate: row.bandcamp_new_date,
          bandcampIsPreorder: row.bandcamp_is_preorder,
        }) !== "current_upcoming",
    )
    .slice(0, limit)
    .map((row) => {
      const variant = variantById.get(row.variant_id);
      const bandcampProductDate = getRecentBandcampProductDate({
        today,
        windowStart,
        bandcampReleaseDate: row.bandcamp_release_date,
        bandcampNewDate: row.bandcamp_new_date,
      });
      const bandcampProductDateEvidence = getRecentBandcampProductDateEvidence({
        today,
        windowStart,
        bandcampReleaseDate: row.bandcamp_release_date,
        bandcampNewDate: row.bandcamp_new_date,
      });
      return {
        id: row.id,
        variantId: row.variant_id,
        sku: variant?.sku ?? null,
        formatName: resolveReleaseFormat({
          sku: variant?.sku,
          formatName: variant?.format_name,
          bandcampTypeName: row.bandcamp_type_name,
          title: variant?.title,
        }),
        title: row.bandcamp_album_title ?? variant?.title ?? "Untitled Bandcamp item",
        bandcampSubdomain: row.bandcamp_subdomain,
        bandcampUrl: row.bandcamp_url,
        detectedAt: row.created_at,
        bandcampProductDate,
        bandcampProductDateSource: bandcampProductDateEvidence?.source ?? null,
        bandcampReleaseDate: row.bandcamp_release_date,
        bandcampNewDate: row.bandcamp_new_date,
        bandcampIsPreorder: row.bandcamp_is_preorder,
        scrapeStatus: row.scrape_status,
      };
    });

  return {
    today,
    newProductWindowDays: newProductDays,
    newProducts: newProductItems,
    preorderSignals: signalItems,
    summary: {
      newProductsInWindow: newProductItems.length,
      dashboardMisses: signalItems.filter((item) => item.dashboardMiss).length,
      ...summarizeBandcampPreorderSignals(signalItems),
    },
  };
}

function getDateDaysAgo(today: string, days: number) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function firstRelated<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return (value as T | null) ?? null;
}

function resolveReleaseFormat(input: {
  sku: string | null | undefined;
  formatName: string | null | undefined;
  bandcampTypeName: string | null | undefined;
  title: string | null | undefined;
}) {
  return (
    inferFormatFromSku(input.sku) ??
    normalizeFormatName(input.bandcampTypeName) ??
    normalizeFormatName(input.formatName) ??
    inferFormatFromTitle(input.title)
  );
}

function inferFormatFromSku(sku: string | null | undefined) {
  const normalized = sku?.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized.startsWith("CD-")) return "CD";
  if (
    normalized.startsWith("LP-") ||
    normalized.startsWith("2XLP-") ||
    normalized.startsWith("MLP-")
  ) {
    return "LP";
  }
  if (normalized.startsWith("CS-") || normalized.startsWith("TB-")) return "Cassette";
  if (normalized.startsWith("7IN-") || normalized.startsWith("SI-")) return '7"';
  if (normalized.startsWith("SHIRT-") || normalized.startsWith("TS-")) return "T-Shirt";
  return null;
}

function normalizeFormatName(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower.includes("compact disc") || lower === "cd") return "CD";
  if (lower.includes("cassette") || lower === "cs") return "Cassette";
  if (lower.includes("vinyl") || lower.includes("lp")) return "LP";
  if (lower.includes("shirt") || lower.includes("tee")) return "T-Shirt";
  return normalized;
}

function inferFormatFromTitle(title: string | null | undefined) {
  const lower = title?.toLowerCase() ?? "";
  if (lower.includes("compact disc") || /\bcd\b/.test(lower)) return "CD";
  if (lower.includes("cassette") || /\bcs\b/.test(lower)) return "Cassette";
  if (lower.includes("vinyl") || /\blp\b/.test(lower)) return "LP";
  return null;
}

async function fetchLiveBandcampDemand(
  variants: Array<{
    workspace_id?: string | null;
    sku: string;
    streetDate: string | null;
    bandcampMemberBandId: number | null;
    bandcampUrl?: string | null;
    productTitle?: string | null;
    bandcampPackageTitle?: string | null;
    bandcampOptionTitle?: string | null;
  }>,
) {
  const upcomingWithBandcamp = variants.filter(
    (variant) => variant.streetDate && variant.bandcampMemberBandId != null,
  );
  const demandBySku = new Map<string, { orderNumbers: string[]; unitCount: number }>();
  if (upcomingWithBandcamp.length === 0) return demandBySku;

  const supabase = await createServerSupabaseClient();
  const workspaceIds = Array.from(
    new Set(upcomingWithBandcamp.map((variant) => variant.workspace_id).filter(isNonEmptyString)),
  );
  if (workspaceIds.length === 0) return demandBySku;

  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("workspace_id, band_id, member_bands_cache")
    .in("workspace_id", workspaceIds)
    .eq("is_active", true);

  const variantsByMemberBand = new Map<number, typeof upcomingWithBandcamp>();
  for (const variant of upcomingWithBandcamp) {
    if (variant.bandcampMemberBandId == null) continue;
    const list = variantsByMemberBand.get(variant.bandcampMemberBandId) ?? [];
    list.push(variant);
    variantsByMemberBand.set(variant.bandcampMemberBandId, list);
  }

  for (const [memberBandId, bandVariants] of variantsByMemberBand.entries()) {
    const workspaceId = bandVariants.find((variant) => variant.workspace_id)?.workspace_id;
    if (!workspaceId) continue;
    const connection = (connections ?? []).find(
      (candidate) =>
        String(candidate.workspace_id) === workspaceId &&
        (Number(candidate.band_id) === memberBandId ||
          memberBandsCacheContains(candidate.member_bands_cache, memberBandId)),
    );
    if (!connection) continue;

    let orderItems: Awaited<ReturnType<typeof getOrders>>;
    try {
      const accessToken = await refreshBandcampToken(workspaceId);
      orderItems = await getOrders(
        {
          bandId: Number(connection.band_id),
          memberBandId: Number(connection.band_id) === memberBandId ? undefined : memberBandId,
          startTime: "2025-01-01 00:00:00",
          unshippedOnly: true,
        },
        accessToken,
      );
    } catch {
      continue;
    }

    const ordersBySku = new Map<string, { orders: Set<string>; units: number }>();
    for (const item of orderItems) {
      const matchingVariant = findLiveDemandVariantForOrderItem(bandVariants, {
        sku: item.sku,
        itemName: item.item_name,
        itemUrl: item.item_url,
        option: item.option,
      });
      if (!matchingVariant) continue;
      const sku = matchingVariant.sku;
      const current = ordersBySku.get(sku) ?? { orders: new Set<string>(), units: 0 };
      current.orders.add(`BC-${item.payment_id}`);
      current.units += item.quantity ?? 1;
      ordersBySku.set(sku, current);
    }

    for (const [sku, demand] of ordersBySku.entries()) {
      demandBySku.set(sku, {
        orderNumbers: Array.from(demand.orders).sort(),
        unitCount: demand.units,
      });
    }
  }

  return demandBySku;
}

function findLiveDemandVariantForOrderItem(
  variants: Array<{
    sku: string;
    bandcampUrl?: string | null;
    productTitle?: string | null;
    bandcampPackageTitle?: string | null;
    bandcampOptionTitle?: string | null;
  }>,
  item: {
    sku: string | null | undefined;
    itemName: string | null | undefined;
    itemUrl: string | null | undefined;
    option: string | null | undefined;
  },
) {
  const itemSku = item.sku?.trim();
  if (itemSku) {
    const skuMatch = variants.find((variant) => variant.sku === itemSku);
    if (skuMatch) return skuMatch;
  }

  const itemName = normalizeDemandMatchText(item.itemName);
  const itemOption = normalizeDemandMatchText(item.option);
  const itemUrl = item.itemUrl?.trim();

  const textMatches = variants.filter((variant) => {
    const packageTitle = normalizeDemandMatchText(variant.bandcampPackageTitle);
    const optionTitle = normalizeDemandMatchText(variant.bandcampOptionTitle);
    const productTitle = normalizeDemandMatchText(variant.productTitle);

    if (itemOption && optionTitle && itemOption === optionTitle) return true;
    if (itemName && packageTitle && itemName === packageTitle) return true;
    if (itemName && productTitle && itemName === productTitle) return true;
    if (itemName && itemOption && productTitle === `${itemName} ${itemOption}`) return true;
    return false;
  });
  if (textMatches.length === 1) return textMatches[0];

  if (itemUrl) {
    const urlMatches = variants.filter((variant) => variant.bandcampUrl?.trim() === itemUrl);
    if (urlMatches.length === 1) return urlMatches[0];
  }

  return null;
}

function normalizeDemandMatchText(value: string | null | undefined) {
  return (
    value
      ?.toLowerCase()
      .replace(/["“”]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ") ?? ""
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function memberBandsCacheContains(value: unknown, memberBandId: number) {
  if (!Array.isArray(value)) return false;
  return value.some((band) => {
    if (!band || typeof band !== "object") return false;
    return Number((band as { band_id?: unknown }).band_id) === memberBandId;
  });
}

function stringFromRecord(value: Record<string, unknown> | null | undefined, key: string) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function numberFromRecord(value: Record<string, unknown> | null | undefined, key: string) {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function resolveBandcampSoldUnits(value: Record<string, unknown> | null | undefined) {
  const directSold = numberFromRecord(value, "quantity_sold");
  if (directSold != null) return directSold;

  const origins = value?.origin_quantities;
  if (!Array.isArray(origins)) return 0;

  return origins.reduce((sum, origin) => {
    if (!origin || typeof origin !== "object") return sum;
    const sold = (origin as { quantity_sold?: unknown }).quantity_sold;
    return typeof sold === "number" && Number.isFinite(sold) ? sum + sold : sum;
  }, 0);
}

function resolveReleaseArtistName(input: {
  productTitle: string | null | undefined;
  productVendor: string | null | undefined;
  albumTitle: string | null | undefined;
  bandcampSubdomain: string | null | undefined;
}) {
  const productTitle = input.productTitle?.trim();
  const albumTitle = input.albumTitle?.trim();
  if (productTitle && albumTitle) {
    const albumNeedle = normalizeDemandMatchText(albumTitle);
    const titleParts = productTitle.split(/\s[-–—]\s/);
    if (titleParts.length >= 2) {
      const [candidate, ...rest] = titleParts;
      const restText = normalizeDemandMatchText(rest.join(" "));
      if (candidate?.trim() && restText.includes(albumNeedle)) return candidate.trim();
    }
  }

  const vendor = input.productVendor?.trim();
  if (vendor && !isLikelyLabelName(vendor)) return vendor;

  const subdomain = input.bandcampSubdomain?.trim();
  if (subdomain) return titleCaseCompactName(subdomain);

  return null;
}

function isLikelyLabelName(value: string) {
  return /\b(records?|recordings|label|tapes|music|distro|distribution)\b/i.test(value);
}

function titleCaseCompactName(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveBandcampPackageTitle(input: {
  artistName: string | null | undefined;
  bandcampAlbumTitle: string | null | undefined;
  packageTitle: string | null | undefined;
  optionTitle: string | null | undefined;
  fallbackTitle: string | null | undefined;
}) {
  const albumTitle = input.bandcampAlbumTitle?.trim() || null;
  const artistName = input.artistName?.trim() || null;
  const baseTitle =
    [artistName, albumTitle].filter(Boolean).join(" - ") || albumTitle || artistName;
  const packageTitle = input.packageTitle?.trim();
  const optionTitle = input.optionTitle?.trim();
  const suffix = packageTitle || optionTitle || input.fallbackTitle?.trim() || null;

  if (!baseTitle) return suffix ?? "Untitled Bandcamp item";
  if (!suffix || suffix === baseTitle) return baseTitle;
  if (normalizeDemandMatchText(suffix).includes(normalizeDemandMatchText(baseTitle))) return suffix;
  return `${baseTitle} ${suffix}`;
}

export async function manualRelease(variantId: string) {
  const supabase = await createServerSupabaseClient();

  // Fetch workspace_id — required by the task payload
  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("workspace_id")
    .eq("id", variantId)
    .single();

  if (!variant) return { error: "Variant not found" };

  // Trigger single-variant release task (HIGH-3 fix: not the full scheduled job)
  const handle = await tasks.trigger("preorder-release-variant", {
    variant_id: variantId,
    workspace_id: variant.workspace_id,
  });

  return { runId: handle.id, variantId };
}

export async function getPreorderAllocationPreview(variantId: string) {
  const supabase = await createServerSupabaseClient();

  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id, sku, street_date")
    .eq("id", variantId)
    .single();

  if (!variant) return { error: "Variant not found" };

  // Get available inventory
  const { data: inventoryLevel } = await supabase
    .from("warehouse_inventory_levels")
    .select("available")
    .eq("sku", variant.sku)
    .single();

  const availableStock = inventoryLevel?.available ?? 0;

  // Get pending pre-orders FIFO
  const { data: pendingOrders } = await supabase
    .from("warehouse_orders")
    .select("id, created_at, order_number, customer_name")
    .eq("is_preorder", true)
    .is("fulfillment_status", null)
    .order("created_at", { ascending: true });

  if (!pendingOrders || pendingOrders.length === 0) {
    return {
      sku: variant.sku,
      streetDate: variant.street_date,
      availableStock,
      orders: [],
      allocation: {
        allocated: [],
        unallocated: [],
        totalAllocated: 0,
        totalUnallocated: 0,
        isShortShipment: false,
      },
    };
  }

  // Get quantities per order
  const orderIds = pendingOrders.map((o) => o.id);
  const { data: orderItems } = await supabase
    .from("warehouse_order_items")
    .select("order_id, quantity")
    .in("order_id", orderIds)
    .eq("sku", variant.sku);

  const quantityByOrder = new Map<string, number>();
  for (const item of orderItems ?? []) {
    quantityByOrder.set(item.order_id, (quantityByOrder.get(item.order_id) ?? 0) + item.quantity);
  }

  const allocationInput = pendingOrders
    .filter((o) => quantityByOrder.has(o.id))
    .map((order) => ({
      id: order.id,
      created_at: order.created_at,
      quantity: quantityByOrder.get(order.id) ?? 1,
    }));

  const allocation = allocatePreorders(allocationInput, availableStock);

  return {
    sku: variant.sku,
    streetDate: variant.street_date,
    availableStock,
    orders: pendingOrders.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      customerName: o.customer_name,
      quantity: quantityByOrder.get(o.id) ?? 0,
    })),
    allocation,
  };
}
