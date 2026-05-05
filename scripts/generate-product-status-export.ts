#!/usr/bin/env tsx
/**
 * Product Status Export — per-label breakdowns
 *
 * The Northern Spy Shopify connection is an UMBRELLA storefront that hosts product
 * listings for four labels (Northern Spy Records, NNA Tapes, Egghunt Records, Across
 * the Horizon). Each label also has its own Bandcamp connection. True Panther has its
 * own Shopify storefront and its own Bandcamp connection.
 *
 * This export builds the catalog matrix per label so you can see, for each label,
 * which warehouse SKUs are visible on Bandcamp vs. Shopify vs. neither.
 *
 * Workbook tabs:
 *   1. Summary                                — per-label counts + global totals
 *   2. {Label} (X-Channel)                    — one tab per label: every warehouse variant for that label
 *                                                with Bandcamp + Shopify presence + status + onhand
 *   3. Shopify Unmatched - Northern Spy       — live remote products on the umbrella with NO active warehouse mapping
 *                                                (these can't be label-attributed because there's no warehouse linkage yet)
 *   4. Shopify Unmatched - True Panther       — same, for the True Panther storefront
 *   5. Bandcamp Stock (Mapped)                — every bandcamp_product_mappings row + warehouse SKU + onhand + label
 *   6. BC Unmatched - Apparel Umbrella        — Rule #79 tracked_as_metadata rows (multi-option SKUs) + label
 *   7. BC Unmatched - No Inventory            — mappings whose variant has 0 onhand and no recorded sales + label
 *   8. BC Unmatched - Review Queue            — open bandcamp_scraper / bandcamp_sync / sku_collision review items + label inferred from metadata
 *   9. BC Cross-Attribution Drift             — bandcamp_product_mappings whose member_band_id implies one label
 *                                                but whose warehouse variant belongs to a DIFFERENT org
 *
 * Run: pnpm tsx scripts/generate-product-status-export.ts
 * Out: reports/product-status/product-status-{YYYY-MM-DD-HHMM}.xlsx
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { fetchRemoteCatalogWithTimeout, type RemoteCatalogItem } from "@/lib/server/sku-matching";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { normalizeSku } from "@/lib/shared/utils";

// ─────────────────────────────────────────────────────────────────────────────────
// Label registry
// ─────────────────────────────────────────────────────────────────────────────────

type LabelSpec = {
  name: string;
  bandId: number;
  shopifyConnectionOrgName: string;
};

const LABELS: LabelSpec[] = [
  { name: "Northern Spy Records", bandId: 2239475326, shopifyConnectionOrgName: "Northern Spy Records" },
  { name: "NNA Tapes",            bandId: 1547924804, shopifyConnectionOrgName: "Northern Spy Records" },
  { name: "Egghunt Records",      bandId:  265181677, shopifyConnectionOrgName: "Northern Spy Records" },
  { name: "Across the Horizon",   bandId: 1430196613, shopifyConnectionOrgName: "Northern Spy Records" },
  { name: "True Panther",         bandId:  702768315, shopifyConnectionOrgName: "True Panther" },
];

// ─────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────

type ConnectionRow = ClientStoreConnection & {
  organizations?: { name: string } | { name: string }[] | null;
};

type MappingRow = {
  id: string;
  variant_id: string;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_sku: string | null;
  remote_inventory_item_id?: string | null;
  is_active: boolean;
  connection_id: string;
};

type VariantRow = {
  id: string;
  sku: string | null;
  title: string | null;
  option1_value: string | null;
  format_name: string | null;
  product_id: string;
  warehouse_products: { title: string | null; vendor: string | null; org_id: string | null } | null;
};

type InventoryRow = {
  variant_id: string;
  available: number | null;
  committed: number | null;
};

type BandcampMappingRow = {
  id: string;
  variant_id: string;
  workspace_id: string;
  bandcamp_item_id: number | null;
  bandcamp_item_type: string | null;
  bandcamp_member_band_id: number | null;
  bandcamp_subdomain: string | null;
  bandcamp_url: string | null;
  bandcamp_album_title: string | null;
  bandcamp_type_name: string | null;
  bandcamp_release_date: string | null;
  bandcamp_new_date: string | null;
  bandcamp_price: number | null;
  bandcamp_currency: string | null;
  bandcamp_catalog_number: string | null;
  bandcamp_upc: string | null;
  bandcamp_options: unknown;
  bandcamp_option_skus: string[] | null;
  bandcamp_origin_quantities: unknown;
  authority_status: string | null;
  scrape_status: string | null;
  consecutive_failures: number | null;
  push_mode: string | null;
  last_quantity_sold: number | null;
  last_synced_at: string | null;
  product_category: string | null;
};

type ReviewQueueRow = {
  id: string;
  category: string;
  severity: string;
  status: string;
  title: string | null;
  description: string | null;
  group_key: string | null;
  occurrence_count: number | null;
  org_id: string | null;
  created_at: string;
  sla_due_at: string | null;
  metadata: Record<string, unknown> | null;
};

const PAGE = 1000;

// ─────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────

function asSingleOrg(value: ConnectionRow["organizations"]): string {
  if (!value) return "n/a";
  if (Array.isArray(value)) return value[0]?.name ?? "n/a";
  return value.name ?? "n/a";
}

function bandcampStockBucket(available: number, committed: number, lastSold: number | null): string {
  const onhand = available + committed;
  if (onhand <= 0 && (lastSold ?? 0) <= 0) return "no_inventory_no_sales";
  if (onhand <= 0 && (lastSold ?? 0) > 0) return "out_of_stock_with_sales_history";
  if (onhand > 0 && onhand < 5) return "low";
  if (onhand >= 5 && onhand < 25) return "medium";
  return "stocked";
}

async function paginate<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE - 1;
    const rows = await fetchPage(from, to);
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from > 100_000) {
      throw new Error(`Pagination runaway for ${label} at ${from}`);
    }
  }
  return out;
}

function buildMappingKeys(mapping: MappingRow): string[] {
  const keys: string[] = [];
  if (mapping.remote_inventory_item_id) keys.push(mapping.remote_inventory_item_id);
  if (mapping.remote_variant_id) keys.push(mapping.remote_variant_id);
  if (mapping.remote_product_id) keys.push(mapping.remote_product_id);
  const sku = normalizeSku(mapping.remote_sku);
  if (sku) keys.push(sku);
  return keys;
}

function remoteCatalogKeys(item: RemoteCatalogItem): string[] {
  const keys: string[] = [];
  if (item.remoteInventoryItemId) keys.push(item.remoteInventoryItemId);
  if (item.remoteVariantId) keys.push(item.remoteVariantId);
  if (item.remoteProductId) keys.push(item.remoteProductId);
  const sku = normalizeSku(item.remoteSku);
  if (sku) keys.push(sku);
  return keys;
}

function flattenOptions(options: unknown): string {
  if (!options) return "";
  if (Array.isArray(options)) {
    return options
      .map((opt) => {
        if (opt && typeof opt === "object") {
          const o = opt as { name?: string; option_name?: string; value?: string; option_value?: string };
          const name = o.name ?? o.option_name ?? "";
          const value = o.value ?? o.option_value ?? "";
          return [name, value].filter(Boolean).join(":");
        }
        return String(opt);
      })
      .filter(Boolean)
      .join(" | ");
  }
  return JSON.stringify(options);
}

function flattenOriginQuantities(value: unknown): string {
  if (!value) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function safeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, "-").slice(0, 31);
}

// ─────────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────────

async function loadShopifyConnections(workspaceId: string): Promise<ConnectionRow[]> {
  const supabase = createServiceRoleClient();
  const targetOrgs = ["Northern Spy Records", "True Panther"];
  const out: ConnectionRow[] = [];
  for (const orgName of targetOrgs) {
    const { data: orgRow, error: orgErr } = await supabase
      .from("organizations")
      .select("id")
      .eq("name", orgName)
      .maybeSingle();
    if (orgErr) throw orgErr;
    if (!orgRow) continue;
    const { data, error } = await supabase
      .from("client_store_connections")
      .select("*, organizations(name)")
      .eq("workspace_id", workspaceId)
      .eq("org_id", orgRow.id)
      .eq("platform", "shopify")
      .order("created_at", { ascending: true });
    if (error) throw error;
    for (const row of (data ?? []) as ConnectionRow[]) out.push(row);
  }
  return out;
}

async function loadActiveMappingsForConnection(connectionId: string): Promise<MappingRow[]> {
  const supabase = createServiceRoleClient();
  return paginate<MappingRow>(async (from, to) => {
    const { data, error } = await supabase
      .from("client_store_sku_mappings")
      .select(
        "id, variant_id, remote_product_id, remote_variant_id, remote_sku, remote_inventory_item_id, is_active, connection_id",
      )
      .eq("connection_id", connectionId)
      .eq("is_active", true)
      .order("variant_id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as MappingRow[];
  }, `client_store_sku_mappings(${connectionId})`);
}

async function loadBandcampMappings(workspaceId: string): Promise<BandcampMappingRow[]> {
  const supabase = createServiceRoleClient();
  return paginate<BandcampMappingRow>(async (from, to) => {
    const { data, error } = await supabase
      .from("bandcamp_product_mappings")
      .select(
        "id, variant_id, workspace_id, bandcamp_item_id, bandcamp_item_type, bandcamp_member_band_id, bandcamp_subdomain, bandcamp_url, bandcamp_album_title, bandcamp_type_name, bandcamp_release_date, bandcamp_new_date, bandcamp_price, bandcamp_currency, bandcamp_catalog_number, bandcamp_upc, bandcamp_options, bandcamp_option_skus, bandcamp_origin_quantities, authority_status, scrape_status, consecutive_failures, push_mode, last_quantity_sold, last_synced_at, product_category",
      )
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true })
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as BandcampMappingRow[];
  }, "bandcamp_product_mappings");
}

async function loadVariantsByIds(variantIds: string[]): Promise<Map<string, VariantRow>> {
  const supabase = createServiceRoleClient();
  const out = new Map<string, VariantRow>();
  const unique = Array.from(new Set(variantIds.filter((id): id is string => Boolean(id))));
  const chunkSize = 200;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("warehouse_product_variants")
      .select(
        "id, sku, title, option1_value, format_name, product_id, warehouse_products(title, vendor, org_id)",
      )
      .in("id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as VariantRow[]) {
      out.set(row.id, row);
    }
  }
  return out;
}

async function loadVariantsForOrg(orgId: string): Promise<VariantRow[]> {
  const supabase = createServiceRoleClient();
  return paginate<VariantRow>(async (from, to) => {
    const { data, error } = await supabase
      .from("warehouse_product_variants")
      .select(
        "id, sku, title, option1_value, format_name, product_id, warehouse_products!inner(title, vendor, org_id)",
      )
      .eq("warehouse_products.org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as unknown as VariantRow[];
  }, `variants(org=${orgId})`);
}

async function loadInventoryByVariantIds(variantIds: string[]): Promise<Map<string, InventoryRow>> {
  const supabase = createServiceRoleClient();
  const out = new Map<string, InventoryRow>();
  const unique = Array.from(new Set(variantIds.filter((id): id is string => Boolean(id))));
  const chunkSize = 200;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("warehouse_inventory_levels")
      .select("variant_id, available, committed")
      .in("variant_id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as InventoryRow[]) {
      out.set(row.variant_id, row);
    }
  }
  return out;
}

async function loadReviewQueueBandcamp(workspaceId: string): Promise<ReviewQueueRow[]> {
  const supabase = createServiceRoleClient();
  const categories = ["bandcamp_scraper", "bandcamp_sync", "sku_collision"];
  const out: ReviewQueueRow[] = [];
  for (const category of categories) {
    const rows = await paginate<ReviewQueueRow>(async (from, to) => {
      const { data, error } = await supabase
        .from("warehouse_review_queue")
        .select(
          "id, category, severity, status, title, description, group_key, occurrence_count, org_id, created_at, sla_due_at, metadata",
        )
        .eq("workspace_id", workspaceId)
        .eq("category", category)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as ReviewQueueRow[];
    }, `warehouse_review_queue(${category})`);
    out.push(...rows);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Sheet builders
// ─────────────────────────────────────────────────────────────────────────────────

async function buildShopifyUnmatchedSheet(
  connection: ConnectionRow,
): Promise<{
  rows: Record<string, unknown>[];
  remoteCount: number;
  mappingCount: number;
  remoteItems: RemoteCatalogItem[];
  mappings: MappingRow[];
}> {
  const orgLabel = asSingleOrg(connection.organizations as ConnectionRow["organizations"]);
  console.log(`[shopify] ${orgLabel} (${connection.id.slice(0, 8)}) — fetching live catalog…`);
  const result = await fetchRemoteCatalogWithTimeout(connection);
  if (result.state !== "ok") {
    console.warn(
      `[shopify] ${orgLabel} catalog fetch state=${result.state}: ${result.error ?? "(no error)"}`,
    );
    return {
      rows: [
        {
          connection: orgLabel,
          status: `catalog_unavailable:${result.state}`,
          error: result.error ?? "",
          fetched_at: result.fetchedAt ?? "",
        },
      ],
      remoteCount: 0,
      mappingCount: 0,
      remoteItems: [],
      mappings: [],
    };
  }
  const remoteItems = result.items;
  console.log(`[shopify] ${orgLabel} live catalog rows: ${remoteItems.length}`);
  const mappings = await loadActiveMappingsForConnection(connection.id);
  console.log(`[shopify] ${orgLabel} active mappings: ${mappings.length}`);

  const matchedKeys = new Set<string>();
  for (const m of mappings) {
    for (const k of buildMappingKeys(m)) matchedKeys.add(k);
  }

  const unmatched = remoteItems.filter((item) => {
    const keys = remoteCatalogKeys(item);
    return !keys.some((k) => matchedKeys.has(k));
  });

  console.log(`[shopify] ${orgLabel} unmatched remote products: ${unmatched.length}`);

  const rows = unmatched.map((item) => ({
    connection: orgLabel,
    store_url: connection.store_url,
    product_title: item.productTitle,
    variant_title: item.variantTitle ?? "",
    combined_title: item.combinedTitle,
    remote_sku: item.remoteSku ?? "",
    barcode: item.barcode ?? "",
    product_type: item.productType ?? "",
    price: item.price ?? "",
    inventory_quantity: item.quantity ?? "",
    product_url: item.productUrl ?? "",
    remote_product_id: item.remoteProductId,
    remote_variant_id: item.remoteVariantId ?? "",
    remote_inventory_item_id: item.remoteInventoryItemId ?? "",
    fetched_at: result.fetchedAt ?? "",
  }));

  rows.sort((a, b) => String(a.combined_title).localeCompare(String(b.combined_title)));

  return { rows, remoteCount: remoteItems.length, mappingCount: mappings.length, remoteItems, mappings };
}

type LabelMatrixRow = {
  warehouse_sku: string;
  variant_title: string;
  format: string;
  warehouse_product_title: string;
  status: "both" | "bandcamp_only" | "shopify_only" | "neither";
  bandcamp_present: boolean;
  bandcamp_url: string;
  bandcamp_album_title: string;
  bandcamp_type_name: string;
  bandcamp_item_id: number | string;
  bandcamp_price: number | string;
  bandcamp_authority: string;
  shopify_present: boolean;
  shopify_remote_sku: string;
  shopify_remote_product_id: string;
  shopify_remote_variant_id: string;
  shopify_connection: string;
  available: number;
  committed: number;
  onhand: number;
  variant_id: string;
};

type LabelMatrixSummary = {
  label: string;
  totalVariants: number;
  both: number;
  bandcampOnly: number;
  shopifyOnly: number;
  neither: number;
  bcMappingsForLabel: number;
  bcMappingsCrossOrg: number;
};

function buildLabelMatrix(
  spec: LabelSpec,
  orgIdByName: Map<string, string>,
  variantsByOrg: Map<string, VariantRow[]>,
  bandcampMappings: BandcampMappingRow[],
  shopifyMappingsByConnection: Map<string, MappingRow[]>,
  connectionByOrgName: Map<string, ConnectionRow>,
  inventory: Map<string, InventoryRow>,
): { rows: LabelMatrixRow[]; summary: LabelMatrixSummary } {
  const orgId = orgIdByName.get(spec.name) ?? "";
  const variants = variantsByOrg.get(orgId) ?? [];
  const shopifyConnection = connectionByOrgName.get(spec.shopifyConnectionOrgName);
  const shopifyMappings = shopifyConnection
    ? shopifyMappingsByConnection.get(shopifyConnection.id) ?? []
    : [];

  const bcByVariant = new Map<string, BandcampMappingRow>();
  let bcMappingsForLabel = 0;
  let bcMappingsCrossOrg = 0;
  for (const m of bandcampMappings) {
    if (m.bandcamp_member_band_id !== spec.bandId) continue;
    bcMappingsForLabel++;
    bcByVariant.set(m.variant_id, m);
  }

  const shopifyByVariant = new Map<string, MappingRow>();
  for (const m of shopifyMappings) shopifyByVariant.set(m.variant_id, m);

  const variantIdSet = new Set(variants.map((v) => v.id));

  // Cross-org: BC mappings for this band that point to a variant whose product
  // belongs to a DIFFERENT org. Count for the summary; the row is excluded from this
  // matrix (it'll surface in the dedicated BC Cross-Attribution Drift tab).
  for (const m of bandcampMappings) {
    if (m.bandcamp_member_band_id !== spec.bandId) continue;
    if (!variantIdSet.has(m.variant_id)) bcMappingsCrossOrg++;
  }

  const rows: LabelMatrixRow[] = variants.map((v) => {
    const bc = bcByVariant.get(v.id);
    const sh = shopifyByVariant.get(v.id);
    const inv = inventory.get(v.id);
    const available = inv?.available ?? 0;
    const committed = inv?.committed ?? 0;

    const bandcampPresent = Boolean(bc);
    const shopifyPresent = Boolean(sh);
    const status: LabelMatrixRow["status"] = bandcampPresent && shopifyPresent
      ? "both"
      : bandcampPresent
        ? "bandcamp_only"
        : shopifyPresent
          ? "shopify_only"
          : "neither";

    return {
      warehouse_sku: v.sku ?? "",
      variant_title: v.title ?? "",
      format: v.format_name ?? "",
      warehouse_product_title: v.warehouse_products?.title ?? "",
      status,
      bandcamp_present: bandcampPresent,
      bandcamp_url: bc?.bandcamp_url ?? "",
      bandcamp_album_title: bc?.bandcamp_album_title ?? "",
      bandcamp_type_name: bc?.bandcamp_type_name ?? "",
      bandcamp_item_id: bc?.bandcamp_item_id ?? "",
      bandcamp_price: bc?.bandcamp_price ?? "",
      bandcamp_authority: bc?.authority_status ?? "",
      shopify_present: shopifyPresent,
      shopify_remote_sku: sh?.remote_sku ?? "",
      shopify_remote_product_id: sh?.remote_product_id ?? "",
      shopify_remote_variant_id: sh?.remote_variant_id ?? "",
      shopify_connection: shopifyConnection
        ? asSingleOrg(shopifyConnection.organizations as ConnectionRow["organizations"])
        : "",
      available,
      committed,
      onhand: available + committed,
      variant_id: v.id,
    };
  });

  // Sort: gaps first (bandcamp_only, shopify_only), then both, then neither — stable by SKU
  const statusOrder = { bandcamp_only: 0, shopify_only: 1, both: 2, neither: 3 } as const;
  rows.sort((a, b) => {
    const c = statusOrder[a.status] - statusOrder[b.status];
    if (c !== 0) return c;
    return String(a.warehouse_sku).localeCompare(String(b.warehouse_sku));
  });

  const summary: LabelMatrixSummary = {
    label: spec.name,
    totalVariants: rows.length,
    both: rows.filter((r) => r.status === "both").length,
    bandcampOnly: rows.filter((r) => r.status === "bandcamp_only").length,
    shopifyOnly: rows.filter((r) => r.status === "shopify_only").length,
    neither: rows.filter((r) => r.status === "neither").length,
    bcMappingsForLabel,
    bcMappingsCrossOrg,
  };

  return { rows, summary };
}

function inferLabelFromBcMapping(
  m: BandcampMappingRow,
  bandIdToLabel: Map<number, string>,
  variantOwnerOrg: string | null,
  orgNameById: Map<string, string>,
): string {
  if (m.bandcamp_member_band_id != null && bandIdToLabel.has(m.bandcamp_member_band_id)) {
    return bandIdToLabel.get(m.bandcamp_member_band_id) ?? "";
  }
  if (variantOwnerOrg) return orgNameById.get(variantOwnerOrg) ?? "";
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = new Date().toISOString().slice(0, 16).replace(":", "-").replace("T", "-");
  const outDir = join(process.cwd(), "reports", "product-status");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `product-status-${stamp}.xlsx`);

  const supabase = createServiceRoleClient();
  const { data: workspaces, error: wsErr } = await supabase
    .from("workspaces")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1);
  if (wsErr) throw wsErr;
  const workspace = workspaces?.[0];
  if (!workspace) throw new Error("No workspace found");
  console.log(`[ws] ${workspace.name} (${workspace.id})`);

  // Org name ↔ id maps for everything
  const { data: orgsRows, error: orgsErr } = await supabase.from("organizations").select("id, name");
  if (orgsErr) throw orgsErr;
  const orgNameById = new Map<string, string>(
    (orgsRows ?? []).map((row) => [row.id as string, (row.name as string) ?? ""]),
  );
  const orgIdByName = new Map<string, string>(
    (orgsRows ?? []).map((row) => [(row.name as string) ?? "", row.id as string]),
  );
  const bandIdToLabel = new Map<number, string>(LABELS.map((l) => [l.bandId, l.name]));

  // ─── Shopify connections + per-connection live catalog ───
  const shopifyConns = await loadShopifyConnections(workspace.id);
  const connectionByOrgName = new Map<string, ConnectionRow>();
  const shopifyResults: Array<{
    label: string;
    sheet: string;
    storeUrl: string;
    rows: Record<string, unknown>[];
    remoteCount: number;
    mappingCount: number;
  }> = [];
  const shopifyMappingsByConnection = new Map<string, MappingRow[]>();

  for (const conn of shopifyConns) {
    const orgLabel = asSingleOrg(conn.organizations as ConnectionRow["organizations"]);
    connectionByOrgName.set(orgLabel, conn);
    const sheet = safeSheetName(`Shopify Unmatched - ${orgLabel.replace(/\s+Records?$/i, "")}`);
    const result = await buildShopifyUnmatchedSheet(conn);
    shopifyResults.push({
      label: orgLabel,
      sheet,
      storeUrl: conn.store_url,
      rows: result.rows,
      remoteCount: result.remoteCount,
      mappingCount: result.mappingCount,
    });
    shopifyMappingsByConnection.set(conn.id, result.mappings);
  }

  // ─── Bandcamp mappings + variants + inventory ───
  console.log("[bandcamp] loading mappings…");
  const bandcampMappings = await loadBandcampMappings(workspace.id);
  console.log(`[bandcamp] mappings: ${bandcampMappings.length}`);

  const bcVariantIds = bandcampMappings.map((m) => m.variant_id);
  console.log("[bandcamp] loading mapped variants…");
  const bcVariants = await loadVariantsByIds(bcVariantIds);
  console.log(`[bandcamp] variants: ${bcVariants.size}`);

  // ─── Per-label warehouse variants (full org catalog, not just BC-linked) ───
  const variantsByOrg = new Map<string, VariantRow[]>();
  for (const spec of LABELS) {
    const orgId = orgIdByName.get(spec.name);
    if (!orgId) {
      console.warn(`[label] ${spec.name}: org not found, skipping`);
      continue;
    }
    console.log(`[label] ${spec.name} — loading warehouse variants for org…`);
    const variants = await loadVariantsForOrg(orgId);
    console.log(`[label] ${spec.name}: variants=${variants.length}`);
    variantsByOrg.set(orgId, variants);
  }

  // Combined inventory across BC variants + per-label org variants
  const allVariantIds = new Set<string>(bcVariantIds);
  for (const variants of variantsByOrg.values()) for (const v of variants) allVariantIds.add(v.id);
  console.log(`[inv] loading inventory for ${allVariantIds.size} variants…`);
  const inventory = await loadInventoryByVariantIds(Array.from(allVariantIds));
  console.log(`[inv] inventory rows: ${inventory.size}`);

  // ─── Build the workbook ───
  const wb = XLSX.utils.book_new();
  const labelSheetNames: string[] = [];
  const labelSummaries: LabelMatrixSummary[] = [];

  for (const spec of LABELS) {
    const { rows, summary } = buildLabelMatrix(
      spec,
      orgIdByName,
      variantsByOrg,
      bandcampMappings,
      shopifyMappingsByConnection,
      connectionByOrgName,
      inventory,
    );
    labelSummaries.push(summary);
    const sheetName = safeSheetName(`${spec.name} (X-Channel)`);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
    labelSheetNames.push(sheetName);
    console.log(
      `[label] ${spec.name}: total=${summary.totalVariants}  both=${summary.both}  bc_only=${summary.bandcampOnly}  sh_only=${summary.shopifyOnly}  neither=${summary.neither}  bc_cross_org=${summary.bcMappingsCrossOrg}`,
    );
  }

  // ─── Shopify unmatched per connection ───
  for (const r of shopifyResults) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(r.rows), r.sheet);
  }

  // ─── BC Stock (Mapped) — with label column ───
  const stockRows = bandcampMappings.map((m) => {
    const v = bcVariants.get(m.variant_id);
    const inv = inventory.get(m.variant_id);
    const available = inv?.available ?? 0;
    const committed = inv?.committed ?? 0;
    const optionSkus = Array.isArray(m.bandcamp_option_skus) ? m.bandcamp_option_skus : [];
    const bcLabel = m.bandcamp_member_band_id ? bandIdToLabel.get(m.bandcamp_member_band_id) ?? "" : "";
    const variantOwnerOrg = v?.warehouse_products?.org_id ?? null;
    const variantOwnerName = variantOwnerOrg ? orgNameById.get(variantOwnerOrg) ?? "" : "";
    return {
      bc_label_inferred: bcLabel,
      warehouse_org: variantOwnerName,
      cross_attribution: bcLabel && variantOwnerName && bcLabel !== variantOwnerName ? "yes" : "",
      bandcamp_subdomain: m.bandcamp_subdomain ?? "",
      bandcamp_band_id: m.bandcamp_member_band_id ?? "",
      bandcamp_album_title: m.bandcamp_album_title ?? "",
      bandcamp_type_name: m.bandcamp_type_name ?? "",
      bandcamp_item_type: m.bandcamp_item_type ?? "",
      bandcamp_release_date: m.bandcamp_release_date ?? "",
      bandcamp_url: m.bandcamp_url ?? "",
      warehouse_sku: v?.sku ?? "",
      warehouse_variant_title: v?.title ?? "",
      warehouse_format: v?.format_name ?? "",
      warehouse_product_title: v?.warehouse_products?.title ?? "",
      warehouse_vendor: v?.warehouse_products?.vendor ?? "",
      bandcamp_price: m.bandcamp_price ?? "",
      bandcamp_currency: m.bandcamp_currency ?? "",
      available,
      committed,
      onhand: available + committed,
      stock_bucket: bandcampStockBucket(available, committed, m.last_quantity_sold),
      last_quantity_sold: m.last_quantity_sold ?? "",
      authority_status: m.authority_status ?? "",
      scrape_status: m.scrape_status ?? "",
      push_mode: m.push_mode ?? "",
      bandcamp_catalog_number: m.bandcamp_catalog_number ?? "",
      bandcamp_upc: m.bandcamp_upc ?? "",
      bandcamp_option_skus_count: optionSkus.length,
      bandcamp_option_skus: optionSkus.join(", "),
      bandcamp_options_summary: flattenOptions(m.bandcamp_options),
      bandcamp_origin_quantities: flattenOriginQuantities(m.bandcamp_origin_quantities),
      last_synced_at: m.last_synced_at ?? "",
      mapping_id: m.id,
      bandcamp_item_id: m.bandcamp_item_id ?? "",
      variant_id: m.variant_id,
    };
  });
  stockRows.sort((a, b) => {
    const cmp = String(a.bc_label_inferred).localeCompare(String(b.bc_label_inferred));
    if (cmp !== 0) return cmp;
    return String(a.bandcamp_album_title).localeCompare(String(b.bandcamp_album_title));
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stockRows), "Bandcamp Stock (Mapped)");

  // ─── BC Apparel Umbrella ───
  const umbrellaRows = bandcampMappings
    .filter((m) => Array.isArray(m.bandcamp_option_skus) && (m.bandcamp_option_skus?.length ?? 0) >= 2)
    .map((m) => {
      const v = bcVariants.get(m.variant_id);
      const inv = inventory.get(m.variant_id);
      const bcLabel = m.bandcamp_member_band_id ? bandIdToLabel.get(m.bandcamp_member_band_id) ?? "" : "";
      const variantOwnerName = v?.warehouse_products?.org_id
        ? orgNameById.get(v.warehouse_products.org_id) ?? ""
        : "";
      return {
        bc_label_inferred: bcLabel,
        warehouse_org: variantOwnerName,
        bandcamp_subdomain: m.bandcamp_subdomain ?? "",
        bandcamp_album_title: m.bandcamp_album_title ?? "",
        bandcamp_type_name: m.bandcamp_type_name ?? "",
        bandcamp_url: m.bandcamp_url ?? "",
        warehouse_sku_umbrella: v?.sku ?? "",
        warehouse_product_title: v?.warehouse_products?.title ?? "",
        umbrella_available: inv?.available ?? 0,
        umbrella_committed: inv?.committed ?? 0,
        option_sku_count: (m.bandcamp_option_skus ?? []).length,
        option_skus: (m.bandcamp_option_skus ?? []).join(", "),
        bandcamp_options_summary: flattenOptions(m.bandcamp_options),
        bandcamp_origin_quantities: flattenOriginQuantities(m.bandcamp_origin_quantities),
        bandcamp_price: m.bandcamp_price ?? "",
        last_synced_at: m.last_synced_at ?? "",
        mapping_id: m.id,
        bandcamp_item_id: m.bandcamp_item_id ?? "",
      };
    });
  umbrellaRows.sort((a, b) => Number(b.option_sku_count) - Number(a.option_sku_count));
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(umbrellaRows),
    "BC Unmatched - Apparel Umbrella",
  );

  // ─── BC No Inventory ───
  const noInventoryRows = bandcampMappings
    .filter((m) => {
      const inv = inventory.get(m.variant_id);
      const onhand = (inv?.available ?? 0) + (inv?.committed ?? 0);
      const sold = m.last_quantity_sold ?? 0;
      return onhand <= 0 && sold <= 0;
    })
    .map((m) => {
      const v = bcVariants.get(m.variant_id);
      const bcLabel = m.bandcamp_member_band_id ? bandIdToLabel.get(m.bandcamp_member_band_id) ?? "" : "";
      const variantOwnerName = v?.warehouse_products?.org_id
        ? orgNameById.get(v.warehouse_products.org_id) ?? ""
        : "";
      return {
        bc_label_inferred: bcLabel,
        warehouse_org: variantOwnerName,
        bandcamp_subdomain: m.bandcamp_subdomain ?? "",
        bandcamp_album_title: m.bandcamp_album_title ?? "",
        bandcamp_type_name: m.bandcamp_type_name ?? "",
        bandcamp_release_date: m.bandcamp_release_date ?? "",
        bandcamp_url: m.bandcamp_url ?? "",
        warehouse_sku: v?.sku ?? "",
        warehouse_product_title: v?.warehouse_products?.title ?? "",
        bandcamp_price: m.bandcamp_price ?? "",
        scrape_status: m.scrape_status ?? "",
        consecutive_failures: m.consecutive_failures ?? 0,
        authority_status: m.authority_status ?? "",
        last_synced_at: m.last_synced_at ?? "",
        mapping_id: m.id,
        bandcamp_item_id: m.bandcamp_item_id ?? "",
      };
    });
  noInventoryRows.sort((a, b) => {
    const cmp = String(a.bc_label_inferred).localeCompare(String(b.bc_label_inferred));
    if (cmp !== 0) return cmp;
    return String(a.bandcamp_album_title).localeCompare(String(b.bandcamp_album_title));
  });
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(noInventoryRows),
    "BC Unmatched - No Inventory",
  );

  // ─── BC Review Queue ───
  const reviewRows = await loadReviewQueueBandcamp(workspace.id);
  const reviewSheet = reviewRows.map((r) => {
    // Try to infer the label from metadata.band_id or org_id on the queue row
    let label = "";
    const meta = r.metadata as Record<string, unknown> | null;
    const metaBandId = meta && typeof meta === "object" ? meta["bandcamp_member_band_id"] ?? meta["band_id"] : null;
    if (typeof metaBandId === "number" && bandIdToLabel.has(metaBandId)) {
      label = bandIdToLabel.get(metaBandId) ?? "";
    } else if (r.org_id) {
      label = orgNameById.get(r.org_id) ?? "";
    }
    return {
      label_inferred: label,
      category: r.category,
      severity: r.severity,
      title: r.title ?? "",
      description: r.description ?? "",
      org: r.org_id ? orgNameById.get(r.org_id) ?? "" : "",
      occurrence_count: r.occurrence_count ?? 1,
      created_at: r.created_at,
      sla_due_at: r.sla_due_at ?? "",
      group_key: r.group_key ?? "",
      metadata: r.metadata ? JSON.stringify(r.metadata) : "",
      review_id: r.id,
    };
  });
  reviewSheet.sort((a, b) => {
    const cmp = String(a.label_inferred).localeCompare(String(b.label_inferred));
    if (cmp !== 0) return cmp;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reviewSheet), "BC Unmatched - Review Queue");

  // ─── BC Cross-Attribution Drift ───
  const driftRows: Record<string, unknown>[] = [];
  const labelOrgIds = new Set(LABELS.map((l) => orgIdByName.get(l.name)).filter(Boolean) as string[]);
  for (const m of bandcampMappings) {
    if (m.bandcamp_member_band_id == null || !bandIdToLabel.has(m.bandcamp_member_band_id)) continue;
    const expectedLabel = bandIdToLabel.get(m.bandcamp_member_band_id) ?? "";
    const expectedOrgId = orgIdByName.get(expectedLabel);
    const v = bcVariants.get(m.variant_id);
    const variantOrgId = v?.warehouse_products?.org_id ?? null;
    if (!variantOrgId || variantOrgId === expectedOrgId) continue;
    const inv = inventory.get(m.variant_id);
    driftRows.push({
      bc_label_expected: expectedLabel,
      warehouse_org_actual: orgNameById.get(variantOrgId) ?? "(unknown)",
      warehouse_org_in_label_set: labelOrgIds.has(variantOrgId) ? "yes" : "no (likely auto-stub)",
      warehouse_sku: v?.sku ?? "",
      warehouse_product_title: v?.warehouse_products?.title ?? "",
      bandcamp_album_title: m.bandcamp_album_title ?? "",
      bandcamp_type_name: m.bandcamp_type_name ?? "",
      bandcamp_url: m.bandcamp_url ?? "",
      bandcamp_band_id: m.bandcamp_member_band_id,
      onhand: (inv?.available ?? 0) + (inv?.committed ?? 0),
      authority_status: m.authority_status ?? "",
      last_synced_at: m.last_synced_at ?? "",
      mapping_id: m.id,
      bandcamp_item_id: m.bandcamp_item_id ?? "",
      variant_id: m.variant_id,
    });
  }
  driftRows.sort((a, b) => String(a.bc_label_expected).localeCompare(String(b.bc_label_expected)));
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(driftRows),
    "BC Cross-Attribution Drift",
  );

  // ─── Summary ───
  const stockedCount = stockRows.filter((r) => Number(r.onhand) > 0).length;
  const totalAvailable = stockRows.reduce((acc, row) => acc + Number(row.available || 0), 0);
  const totalCommitted = stockRows.reduce((acc, row) => acc + Number(row.committed || 0), 0);
  const totalOnhand = totalAvailable + totalCommitted;

  const summarySheet: Record<string, unknown>[] = [
    { metric: "Workspace", value: workspace.name },
    { metric: "Generated at", value: new Date().toISOString() },
    { metric: "", value: "" },
    { metric: "── Per-Label cross-channel breakdown ──", value: "" },
  ];
  for (const s of labelSummaries) {
    summarySheet.push({ metric: `${s.label} — total warehouse variants`, value: s.totalVariants });
    summarySheet.push({ metric: `${s.label} — both BC + Shopify`, value: s.both });
    summarySheet.push({ metric: `${s.label} — Bandcamp ONLY (no Shopify)`, value: s.bandcampOnly });
    summarySheet.push({ metric: `${s.label} — Shopify ONLY (no Bandcamp)`, value: s.shopifyOnly });
    summarySheet.push({ metric: `${s.label} — neither (warehouse-only)`, value: s.neither });
    summarySheet.push({ metric: `${s.label} — BC mappings tagged to this band`, value: s.bcMappingsForLabel });
    summarySheet.push({
      metric: `${s.label} — BC mappings on a DIFFERENT org's variant (drift)`,
      value: s.bcMappingsCrossOrg,
    });
    summarySheet.push({ metric: "", value: "" });
  }

  summarySheet.push({ metric: "── Shopify (live catalog vs active mappings) ──", value: "" });
  for (const r of shopifyResults) {
    summarySheet.push({ metric: `${r.label} — store URL`, value: r.storeUrl });
    summarySheet.push({ metric: `${r.label} — live catalog products`, value: r.remoteCount });
    summarySheet.push({ metric: `${r.label} — active mappings`, value: r.mappingCount });
    summarySheet.push({
      metric: `${r.label} — UNMATCHED on Shopify (no warehouse linkage)`,
      value: r.rows.filter((row) => row.product_title).length,
    });
    summarySheet.push({ metric: "", value: "" });
  }

  summarySheet.push({ metric: "── Global Bandcamp ──", value: "" });
  summarySheet.push({ metric: "Total bandcamp_product_mappings", value: bandcampMappings.length });
  summarySheet.push({ metric: "Mappings currently stocked (onhand > 0)", value: stockedCount });
  summarySheet.push({ metric: "Mappings with no inventory + no sales", value: noInventoryRows.length });
  summarySheet.push({ metric: "Apparel-umbrella mappings (≥2 option SKUs)", value: umbrellaRows.length });
  summarySheet.push({ metric: "Open BC-related review queue items", value: reviewRows.length });
  summarySheet.push({ metric: "Cross-attribution drift rows", value: driftRows.length });
  summarySheet.push({ metric: "Total Bandcamp available / committed / onhand", value: `${totalAvailable} / ${totalCommitted} / ${totalOnhand}` });
  summarySheet.push({ metric: "", value: "" });

  summarySheet.push({ metric: "── Sheet legend ──", value: "" });
  summarySheet.push({
    metric: "{Label} (X-Channel)",
    value: "Every warehouse variant for that label, with Bandcamp + Shopify presence + status (both / bandcamp_only / shopify_only / neither). Sorted with gaps first.",
  });
  summarySheet.push({
    metric: "Shopify Unmatched - {connection}",
    value: "Live Shopify products with no active client_store_sku_mappings entry on that storefront. Cannot be label-attributed because no warehouse linkage exists yet.",
  });
  summarySheet.push({
    metric: "Bandcamp Stock (Mapped)",
    value: "Every bandcamp_product_mappings row + label inferred from band_id + warehouse SKU + onhand.",
  });
  summarySheet.push({
    metric: "BC Unmatched - Apparel Umbrella",
    value: "Rule #79 tracked_as_metadata: rows where bandcamp_option_skus has ≥2 entries (size variants not yet first-class warehouse SKUs).",
  });
  summarySheet.push({
    metric: "BC Unmatched - No Inventory",
    value: "Mappings whose warehouse variant has 0 onhand AND no recorded sales (likely never received).",
  });
  summarySheet.push({
    metric: "BC Unmatched - Review Queue",
    value: "Open warehouse_review_queue items in bandcamp_scraper / bandcamp_sync / sku_collision categories.",
  });
  summarySheet.push({
    metric: "BC Cross-Attribution Drift",
    value: "Bandcamp mappings whose member_band_id implies one label but whose warehouse variant belongs to a different org. Usually means the variant was auto-created during sync and never reassigned.",
  });

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summarySheet), "Summary");

  // Final order: Summary first, then per-label tabs, then Shopify unmatched, then BC tabs, then drift
  const order = [
    "Summary",
    ...labelSheetNames,
    ...shopifyResults.map((r) => r.sheet),
    "Bandcamp Stock (Mapped)",
    "BC Unmatched - Apparel Umbrella",
    "BC Unmatched - No Inventory",
    "BC Unmatched - Review Queue",
    "BC Cross-Attribution Drift",
  ];
  wb.SheetNames = order.filter((n) => wb.SheetNames.includes(n));

  XLSX.writeFile(wb, outPath);

  console.log(`\n✓ Wrote ${outPath}`);
  console.log("\n--- Per-label cross-channel ---");
  for (const s of labelSummaries) {
    console.log(
      `  ${s.label.padEnd(24)} variants=${String(s.totalVariants).padStart(4)}  both=${String(s.both).padStart(3)}  bc_only=${String(s.bandcampOnly).padStart(3)}  sh_only=${String(s.shopifyOnly).padStart(3)}  neither=${String(s.neither).padStart(4)}  bc_drift=${s.bcMappingsCrossOrg}`,
    );
  }
  console.log("\n--- Shopify catalog ---");
  for (const r of shopifyResults) {
    const unmatched = r.rows.filter((row) => row.product_title).length;
    console.log(
      `  ${r.label.padEnd(24)} live=${r.remoteCount}  mappings=${r.mappingCount}  UNMATCHED=${unmatched}`,
    );
  }
  console.log("\n--- Global Bandcamp ---");
  console.log(`  mappings=${bandcampMappings.length}  stocked=${stockedCount}  no_inv=${noInventoryRows.length}  umbrella=${umbrellaRows.length}  review=${reviewRows.length}  drift=${driftRows.length}`);
  console.log(`  Bandcamp totals — available=${totalAvailable}  committed=${totalCommitted}  onhand=${totalOnhand}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
