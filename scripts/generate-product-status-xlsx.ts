#!/usr/bin/env tsx
/**
 * generate-product-status-xlsx
 *
 * Operator-facing Excel report capturing the current matching state of
 * the catalog after a SKU-matching pass. Sheets:
 *
 *   1. Summary           — connection counts + matched / unmatched totals
 *   2. Warehouse Products — canonical warehouse_products + variants + on-hand
 *   3. Unmatched Shopify  — remote Shopify products NOT in client_store_sku_mappings
 *   4. Unmatched Woo      — same, for WooCommerce client connections
 *   5. Unmatched Bandcamp — Bandcamp packages NOT in bandcamp_product_mappings
 *   6. Bandcamp Stock     — current Bandcamp-mapped variants + warehouse on-hand
 *
 * Live API calls:
 *   - Shopify / Woo / Squarespace via fetchRemoteCatalogWithTimeout
 *     (uses the canonical sku-matching code path so the report mirrors
 *     what /admin/settings/sku-matching sees)
 *   - Bandcamp via refreshBandcampToken + getMerchDetails (per band +
 *     each member band cached on the connection)
 *
 * Output: reports/product-status/product-status-<ISO>.xlsx
 *
 * Usage:
 *   pnpm tsx scripts/generate-product-status-xlsx.ts
 *   # or restrict by org name:
 *   ORG="Northern Spy Records" pnpm tsx scripts/generate-product-status-xlsx.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { getMerchDetails, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { fetchRemoteCatalogWithTimeout } from "@/lib/server/sku-matching";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { normalizeSku } from "@/lib/shared/utils";

type OrgRow = { id: string; name: string | null };
type ConnectionRow = ClientStoreConnection & {
  organizations?: OrgRow | OrgRow[] | null;
};
type BandcampConnection = {
  id: string;
  workspace_id: string;
  org_id: string;
  band_id: number;
  band_name: string | null;
  is_active: boolean;
  member_bands_cache: Array<{ band_id: number; name: string }> | null;
  organizations?: OrgRow | OrgRow[] | null;
};

type VariantRow = {
  id: string;
  product_id: string;
  sku: string;
  title: string | null;
  format_name: string | null;
  option1_value: string | null;
  barcode: string | null;
  price: number | null;
  warehouse_products: { id: string; title: string; vendor: string | null; org_id: string | null } | null;
  warehouse_inventory_levels: { available: number; committed: number }[] | null;
  bandcamp_product_mappings: Array<{
    id: string;
    bandcamp_item_id: number | null;
    bandcamp_url: string | null;
    bandcamp_member_band_id: number | null;
    bandcamp_album_title?: string | null;
    bandcamp_origin_quantities?: unknown;
  }> | null;
  client_store_sku_mappings: Array<{
    id: string;
    connection_id: string;
    is_active: boolean;
    remote_product_id: string | null;
    remote_variant_id: string | null;
    remote_sku: string | null;
  }> | null;
};

const ORG_FILTER = process.env.ORG?.trim() || null;

function normalize(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, " ").slice(0, 30).trim() || "Sheet";
}
function unwrapOrg(c: { organizations?: OrgRow | OrgRow[] | null }): OrgRow | null {
  const o = c.organizations;
  if (!o) return null;
  return Array.isArray(o) ? o[0] ?? null : o;
}
function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function main() {
  const supabase = createServiceRoleClient();
  const startedAt = new Date().toISOString();

  // ─── Load connections ────────────────────────────────────────────
  const { data: clientConns, error: ccErr } = (await supabase
    .from("client_store_connections")
    .select(
      "id, workspace_id, org_id, platform, store_url, api_key, api_secret, webhook_url, webhook_secret, connection_status, last_webhook_at, last_poll_at, last_error_at, last_error, do_not_fanout, created_at, updated_at, organizations(id, name)",
    )
    .eq("connection_status", "active")) as {
    data: ConnectionRow[] | null;
    error: { message: string } | null;
  };
  if (ccErr) throw new Error(`client_store_connections fetch: ${ccErr.message}`);

  const { data: bcConns, error: bcErr } = (await supabase
    .from("bandcamp_connections")
    .select(
      "id, workspace_id, org_id, band_id, band_name, is_active, member_bands_cache, organizations(id, name)",
    )
    .eq("is_active", true)) as {
    data: BandcampConnection[] | null;
    error: { message: string } | null;
  };
  if (bcErr) throw new Error(`bandcamp_connections fetch: ${bcErr.message}`);

  const filteredClient = (clientConns ?? []).filter(
    (c) => !ORG_FILTER || unwrapOrg(c)?.name === ORG_FILTER,
  );
  const filteredBandcamp = (bcConns ?? []).filter(
    (c) => !ORG_FILTER || unwrapOrg(c)?.name === ORG_FILTER,
  );

  console.log(
    `[product-status] connections — client=${filteredClient.length} bandcamp=${filteredBandcamp.length}` +
      (ORG_FILTER ? ` (filtered by org=${ORG_FILTER})` : ""),
  );

  // ─── Load canonical warehouse data ───────────────────────────────
  console.log("[product-status] loading warehouse variants…");
  const variants: VariantRow[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = (await supabase
      .from("warehouse_product_variants")
      .select(
        "id, product_id, sku, title, format_name, option1_value, barcode, price, " +
          "warehouse_products!inner(id, title, vendor, org_id), " +
          "warehouse_inventory_levels(available, committed), " +
          "bandcamp_product_mappings(id, bandcamp_item_id, bandcamp_url, bandcamp_member_band_id, bandcamp_album_title, bandcamp_origin_quantities), " +
          "client_store_sku_mappings(id, connection_id, is_active, remote_product_id, remote_variant_id, remote_sku)",
      )
      .range(from, from + PAGE - 1)) as { data: VariantRow[] | null; error: { message: string } | null };
    if (error) throw new Error(`warehouse_product_variants fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    variants.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`[product-status] loaded ${variants.length} variants`);

  // Optional org-name filter on the canonical side: keep variants whose
  // product.org_id maps to one of the connection orgs (if filtering).
  const orgIdFilter = ORG_FILTER
    ? new Set(
        [...filteredClient.map(unwrapOrg), ...filteredBandcamp.map(unwrapOrg)]
          .filter((o): o is OrgRow => !!o)
          .map((o) => o.id),
      )
    : null;
  const variantsScoped = orgIdFilter
    ? variants.filter((v) => v.warehouse_products?.org_id && orgIdFilter.has(v.warehouse_products.org_id))
    : variants;

  // ─── SHEET 2: Warehouse Products ─────────────────────────────────
  const sheetWarehouse = variantsScoped.map((v) => {
    const inv = asArray(v.warehouse_inventory_levels)[0];
    const wp = v.warehouse_products;
    const bcMaps = asArray(v.bandcamp_product_mappings).map((m) => m.bandcamp_url || `bc:${m.bandcamp_item_id}`);
    const csMaps = asArray(v.client_store_sku_mappings).filter((m) => m.is_active);
    return {
      product_title: wp?.title ?? null,
      vendor: wp?.vendor ?? null,
      org_id: wp?.org_id ?? null,
      sku: v.sku,
      barcode: v.barcode,
      variant_title: v.title,
      format: v.format_name,
      option1: v.option1_value,
      price: v.price,
      available: inv?.available ?? null,
      committed: inv?.committed ?? null,
      bandcamp_links: bcMaps.join(" | "),
      client_store_mappings: csMaps.length,
      variant_id: v.id,
      product_id: v.product_id,
    };
  });

  // ─── SHEETS 3-4: Unmatched per client_store_connection ──────────
  const unmatchedShopifyRows: Record<string, unknown>[] = [];
  const unmatchedWooRows: Record<string, unknown>[] = [];
  const unmatchedSqRows: Record<string, unknown>[] = [];

  // index existing mappings by (connection_id, remote_product_id+remote_variant_id) and remote_sku
  const mappingByConnAndRemote = new Map<string, true>();
  const mappingByConnAndSku = new Map<string, true>();
  for (const v of variants) {
    for (const m of asArray(v.client_store_sku_mappings)) {
      if (!m.is_active) continue;
      if (m.remote_product_id) {
        mappingByConnAndRemote.set(
          `${m.connection_id}|${m.remote_product_id}|${m.remote_variant_id ?? ""}`,
          true,
        );
      }
      if (m.remote_sku) {
        mappingByConnAndSku.set(`${m.connection_id}|${normalizeSku(m.remote_sku)}`, true);
      }
    }
  }

  for (const conn of filteredClient) {
    const orgName = unwrapOrg(conn)?.name ?? "(unknown org)";
    console.log(`[product-status] fetching ${conn.platform} catalog: ${conn.store_url}`);
    let result;
    try {
      result = await fetchRemoteCatalogWithTimeout(conn);
    } catch (e) {
      console.warn(`[product-status]  -> failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (result.state === "timeout" && conn.platform === "woocommerce") {
      console.warn(
        "[product-status]  -> Woo timed out under default budget, retrying with direct client (no timeout)…",
      );
      try {
        const { listCatalogItems } = await import("@/lib/clients/woocommerce-client");
        const items = await listCatalogItems({
          consumerKey: conn.api_key as string,
          consumerSecret: conn.api_secret as string,
          siteUrl: conn.store_url,
          preferredAuthMode: conn.preferred_auth_mode ?? null,
        });
        result = {
          state: "ok",
          fetchedAt: new Date().toISOString(),
          error: null,
          items: items.map((item) => ({
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
            price:
              typeof item.price === "string"
                ? Number.parseFloat(item.price) || null
                : (item.price as number | null) ?? null,
            barcode: null,
            quantity: item.stock_quantity,
          })),
        };
      } catch (e) {
        console.warn(`[product-status]  -> Woo retry failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }
    if (result.state !== "ok") {
      console.warn(`[product-status]  -> non-OK state=${result.state} error=${result.error}`);
      continue;
    }
    console.log(`[product-status]  -> ${result.items.length} remote items, computing unmatched…`);
    for (const item of result.items) {
      const remoteKey = `${conn.id}|${item.remoteProductId}|${item.remoteVariantId ?? ""}`;
      const skuKey = item.remoteSku ? `${conn.id}|${normalizeSku(item.remoteSku)}` : null;
      const mapped =
        mappingByConnAndRemote.has(remoteKey) || (skuKey && mappingByConnAndSku.has(skuKey));
      if (mapped) continue;
      const row = {
        org: orgName,
        platform: item.platform,
        store: conn.store_url,
        product_title: item.productTitle,
        variant_title: item.variantTitle,
        combined_title: item.combinedTitle,
        product_type: item.productType,
        remote_sku: item.remoteSku,
        barcode: item.barcode,
        price: item.price,
        quantity_remote: item.quantity,
        product_url: item.productUrl,
        remote_product_id: item.remoteProductId,
        remote_variant_id: item.remoteVariantId,
        remote_inventory_item_id: item.remoteInventoryItemId,
      };
      if (item.platform === "shopify") unmatchedShopifyRows.push(row);
      else if (item.platform === "woocommerce") unmatchedWooRows.push(row);
      else unmatchedSqRows.push(row);
    }
  }

  // ─── SHEET 5: Unmatched Bandcamp ─────────────────────────────────
  const mappedBandcampPackages = new Set<string>(); // key: `${band_id}|${package_id}`
  const variantByBandcampPkg = new Map<string, VariantRow>();
  for (const v of variants) {
    for (const m of asArray(v.bandcamp_product_mappings)) {
      if (m.bandcamp_item_id == null) continue;
      // Mappings can store either the parent band_id or member_band_id;
      // we treat the package_id alone as the global key + also add scoped
      // (band_id|pkg) variants per connection for cross-check.
      const pkgKey = `${m.bandcamp_member_band_id ?? "*"}|${m.bandcamp_item_id}`;
      mappedBandcampPackages.add(pkgKey);
      mappedBandcampPackages.add(`*|${m.bandcamp_item_id}`);
      variantByBandcampPkg.set(`*|${m.bandcamp_item_id}`, v);
    }
  }

  const unmatchedBandcampRows: Record<string, unknown>[] = [];
  const bandcampStockRows: Record<string, unknown>[] = [];
  const bandcampErrors: Record<string, unknown>[] = [];

  for (const conn of filteredBandcamp) {
    const orgName = unwrapOrg(conn)?.name ?? "(unknown org)";
    console.log(`[product-status] bandcamp: ${conn.band_name} (band_id=${conn.band_id})`);
    let token: string;
    try {
      token = await refreshBandcampToken(conn.workspace_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[product-status]  -> token refresh failed: ${msg}`);
      bandcampErrors.push({ connection: conn.band_name, band_id: conn.band_id, kind: "token_refresh", error: msg });
      continue;
    }
    const bandsToFetch: Array<{ band_id: number; name: string }> = [
      { band_id: conn.band_id, name: conn.band_name ?? `band ${conn.band_id}` },
    ];
    if (Array.isArray(conn.member_bands_cache)) {
      for (const mb of conn.member_bands_cache) {
        if (mb.band_id !== conn.band_id) bandsToFetch.push(mb);
      }
    }
    for (const band of bandsToFetch) {
      try {
        const items = await getMerchDetails(band.band_id, token);
        console.log(`[product-status]  -> ${band.name} (${band.band_id}): ${items.length} packages`);
        for (const item of items) {
          const pkgKey = `${band.band_id}|${item.package_id}`;
          const globalKey = `*|${item.package_id}`;
          const isMapped =
            mappedBandcampPackages.has(pkgKey) || mappedBandcampPackages.has(globalKey);
          if (!isMapped) {
            unmatchedBandcampRows.push({
              org: orgName,
              connection: conn.band_name,
              band_id: band.band_id,
              band_name: band.name,
              package_id: item.package_id,
              title: item.title,
              album_title: item.album_title,
              item_type: item.item_type,
              sku: item.sku,
              price: item.price,
              currency: item.currency,
              quantity_available: item.quantity_available,
              quantity_sold: item.quantity_sold,
              new_date: item.new_date,
              url: item.url,
              option_count: item.options?.length ?? 0,
              option_skus: (item.options ?? [])
                .map((o) => o.sku ?? `opt:${o.option_id}`)
                .join(" | "),
            });
          }
          // Bandcamp stock row — emit one per package option (if any) or
          // one for the package; the warehouse on-hand is sourced from the
          // mapped variant when present.
          const v = variantByBandcampPkg.get(globalKey) ?? null;
          const inv = v ? asArray(v.warehouse_inventory_levels)[0] : undefined;
          if (item.options && item.options.length > 0) {
            for (const opt of item.options) {
              bandcampStockRows.push({
                org: orgName,
                connection: conn.band_name,
                band_id: band.band_id,
                band_name: band.name,
                package_id: item.package_id,
                package_title: item.title,
                option_id: opt.option_id,
                option_title: opt.title,
                bandcamp_sku: opt.sku,
                bc_quantity_available: opt.quantity_available,
                bc_quantity_sold: opt.quantity_sold,
                warehouse_sku: v?.sku ?? null,
                warehouse_available: inv?.available ?? null,
                warehouse_committed: inv?.committed ?? null,
                mapped: isMapped,
                url: item.url,
              });
            }
          } else {
            bandcampStockRows.push({
              org: orgName,
              connection: conn.band_name,
              band_id: band.band_id,
              band_name: band.name,
              package_id: item.package_id,
              package_title: item.title,
              option_id: null,
              option_title: null,
              bandcamp_sku: item.sku,
              bc_quantity_available: item.quantity_available,
              bc_quantity_sold: item.quantity_sold,
              warehouse_sku: v?.sku ?? null,
              warehouse_available: inv?.available ?? null,
              warehouse_committed: inv?.committed ?? null,
              mapped: isMapped,
              url: item.url,
            });
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[product-status]  -> band ${band.band_id}: ${msg}`);
        bandcampErrors.push({
          connection: conn.band_name,
          band_id: band.band_id,
          band_name: band.name,
          kind: "merch_details",
          error: msg,
        });
      }
    }
  }

  // ─── SHEET 1: Summary ────────────────────────────────────────────
  const summary: Record<string, unknown>[] = [
    { metric: "Generated at", value: startedAt },
    { metric: "Org filter", value: ORG_FILTER ?? "(all orgs)" },
    { metric: "", value: "" },
    { metric: "Warehouse variants (canonical)", value: variantsScoped.length },
    {
      metric: "Variants with on-hand > 0",
      value: variantsScoped.filter((v) => (asArray(v.warehouse_inventory_levels)[0]?.available ?? 0) > 0).length,
    },
    {
      metric: "Variants with at least one client_store_sku_mapping (active)",
      value: variantsScoped.filter((v) => asArray(v.client_store_sku_mappings).some((m) => m.is_active)).length,
    },
    {
      metric: "Variants with at least one bandcamp_product_mapping",
      value: variantsScoped.filter((v) => asArray(v.bandcamp_product_mappings).length > 0).length,
    },
    { metric: "", value: "" },
    { metric: "Client store connections (active)", value: filteredClient.length },
    { metric: "Bandcamp connections (active)", value: filteredBandcamp.length },
    { metric: "Unmatched Shopify products", value: unmatchedShopifyRows.length },
    { metric: "Unmatched WooCommerce products", value: unmatchedWooRows.length },
    { metric: "Unmatched Squarespace products", value: unmatchedSqRows.length },
    { metric: "Unmatched Bandcamp packages", value: unmatchedBandcampRows.length },
    { metric: "Bandcamp stock rows", value: bandcampStockRows.length },
    { metric: "Bandcamp fetch errors", value: bandcampErrors.length },
  ];

  // ─── Build workbook ──────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  function appendSheet(name: string, rows: Record<string, unknown>[]) {
    const sheetName = normalize(name);
    if (rows.length === 0) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[`(empty) ${name}`]]), sheetName);
      return;
    }
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  appendSheet("Summary", summary);
  appendSheet("Warehouse Products", sheetWarehouse);
  appendSheet("Unmatched Shopify", unmatchedShopifyRows);
  appendSheet("Unmatched Woo", unmatchedWooRows);
  if (unmatchedSqRows.length > 0) appendSheet("Unmatched Squarespace", unmatchedSqRows);
  appendSheet("Unmatched Bandcamp", unmatchedBandcampRows);
  appendSheet("Bandcamp Stock", bandcampStockRows);
  if (bandcampErrors.length > 0) appendSheet("Bandcamp Errors", bandcampErrors);

  const stamp = startedAt.replace(/[:.]/g, "-");
  const dir = join(process.cwd(), "reports", "product-status");
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `product-status-${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  console.log("\n=== Report written ===");
  console.log(outPath);
  console.log(`  Warehouse variants:       ${sheetWarehouse.length}`);
  console.log(`  Unmatched Shopify:        ${unmatchedShopifyRows.length}`);
  console.log(`  Unmatched Woo:            ${unmatchedWooRows.length}`);
  if (unmatchedSqRows.length) console.log(`  Unmatched Squarespace:    ${unmatchedSqRows.length}`);
  console.log(`  Unmatched Bandcamp:       ${unmatchedBandcampRows.length}`);
  console.log(`  Bandcamp stock rows:      ${bandcampStockRows.length}`);
  if (bandcampErrors.length) console.log(`  Bandcamp errors:          ${bandcampErrors.length}`);
}

main().catch((e) => {
  console.error("[product-status] FATAL:", e);
  process.exit(1);
});
