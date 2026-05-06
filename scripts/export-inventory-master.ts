/**
 * scripts/export-inventory-master.ts
 *
 * Exports a single Excel workbook (.xlsx) containing every variant in the
 * warehouse database, joined with org / inventory level / per-location stock /
 * Bandcamp metadata / Shopify product context.
 *
 * Purpose: hand staff one document they can use to perform a physical
 * inventory count and re-import to seed counts. Also flags every row with
 * any missing data points so we can fix the data while we're in there.
 *
 * Read-only. No DB writes. No external API calls.
 *
 * Output:
 *   reports/inventory-master/inventory-master-<timestamp>.xlsx
 *
 * Sheets:
 *   1. Inventory Master      — one row per variant; primary working sheet
 *   2. Validation Summary    — counts of missing/empty fields by category
 *   3. Locations Reference   — list of all warehouse_locations (valid names)
 *   4. README                — column descriptions + reimport instructions
 *
 * Run:
 *   npx tsx scripts/export-inventory-master.ts
 *   npx tsx scripts/export-inventory-master.ts --workspace-id <uuid>
 */

import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

type CliArgs = {
  workspaceId: string | null;
  out: string | null;
};

function parseArgs(): CliArgs {
  const args: CliArgs = { workspaceId: null, out: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--workspace-id" && process.argv[i + 1]) {
      args.workspaceId = process.argv[++i];
    } else if (a === "--out" && process.argv[i + 1]) {
      args.out = process.argv[++i];
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gidToNumeric(gid: string | null): string | null {
  if (!gid) return null;
  const m = gid.match(/(\d+)$/);
  return m ? m[1] : gid;
}

function shopifyAdminUrl(
  shopifyProductId: string | null,
  storeUrl: string,
): string | null {
  const numeric = gidToNumeric(shopifyProductId);
  if (!numeric) return null;
  // SHOPIFY_STORE_URL is typically https://<shop>.myshopify.com
  try {
    const u = new URL(storeUrl);
    return `https://${u.hostname}/admin/products/${numeric}`;
  } catch {
    return null;
  }
}

/**
 * Best-effort artist/title split from product title.
 * Order of preference:
 *   1. " - "  → "Artist - Title"
 *   2. " — "  → en-dash variant
 *   3. fall back to vendor + full title
 */
function splitArtistTitle(
  rawTitle: string,
  vendor: string | null,
  bandcampAlbumTitle: string | null,
): { artist: string; title: string; confidence: "high" | "medium" | "low" } {
  const t = rawTitle.trim();

  // Strongest signal: bandcamp_album_title is set → we know the album, so the
  // remainder of the title is artist.
  if (bandcampAlbumTitle && t.includes(bandcampAlbumTitle)) {
    const artist = t
      .replace(bandcampAlbumTitle, "")
      .replace(/\s*[-—–]\s*$/, "")
      .replace(/^\s*[-—–]\s*/, "")
      .trim();
    if (artist && artist !== t) {
      return { artist, title: bandcampAlbumTitle, confidence: "high" };
    }
  }

  // " - " split (the " " padding matters — avoids hyphenated words)
  for (const sep of [" - ", " — ", " – "]) {
    const idx = t.indexOf(sep);
    if (idx > 0 && idx < t.length - sep.length) {
      const left = t.slice(0, idx).trim();
      const right = t.slice(idx + sep.length).trim();
      if (left.length >= 1 && right.length >= 1) {
        return { artist: left, title: right, confidence: "medium" };
      }
    }
  }

  // No separator. Fall back to vendor as artist if present.
  if (vendor && vendor.trim()) {
    return { artist: vendor.trim(), title: t, confidence: "low" };
  }
  return { artist: "", title: t, confidence: "low" };
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "";
  return Number(n).toFixed(2);
}

function fmtBool(b: boolean | null | undefined): string {
  if (b === true) return "Y";
  if (b === false) return "N";
  return "";
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  // Keep ISO date for date-only columns; full ISO for timestamps.
  return s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const sb = createServiceRoleClient();
  const storeUrl = process.env.SHOPIFY_STORE_URL ?? "";

  console.log("[export-inventory-master] loading data...");

  // 1. Variants + product + org (single denormalized read)
  // We page in chunks to be safe regardless of catalog size.
  type VariantRow = {
    id: string;
    product_id: string;
    workspace_id: string;
    sku: string;
    title: string | null;
    price: number | null;
    compare_at_price: number | null;
    cost: number | null;
    barcode: string | null;
    weight: number | null;
    weight_unit: string | null;
    option1_name: string | null;
    option1_value: string | null;
    format_name: string | null;
    street_date: string | null;
    is_preorder: boolean | null;
    bandcamp_url: string | null;
    shopify_variant_id: string | null;
    shopify_inventory_item_id: string | null;
    bandcamp_option_id: number | null;
    bandcamp_option_title: string | null;
    created_at: string;
    updated_at: string;
    warehouse_products: {
      id: string;
      title: string;
      vendor: string | null;
      product_type: string | null;
      status: string | null;
      tags: string[] | null;
      shopify_product_id: string | null;
      shopify_handle: string | null;
      bandcamp_upc: string | null;
      synced_at: string | null;
      org_id: string | null;
      organizations: {
        id: string;
        name: string;
        slug: string;
        pirate_ship_name: string | null;
      } | null;
    } | null;
  };

  const variants: VariantRow[] = [];
  const PAGE = 1000;
  let from = 0;
  let lastBatch = PAGE;
  while (lastBatch === PAGE) {
    let q = sb
      .from("warehouse_product_variants")
      .select(
        `
        id, product_id, workspace_id, sku, title, price, compare_at_price, cost,
        barcode, weight, weight_unit, option1_name, option1_value, format_name,
        street_date, is_preorder, bandcamp_url, shopify_variant_id,
        shopify_inventory_item_id, bandcamp_option_id, bandcamp_option_title,
        created_at, updated_at,
        warehouse_products(
          id, title, vendor, product_type, status, tags, shopify_product_id,
          shopify_handle, bandcamp_upc, synced_at, org_id,
          organizations(id, name, slug, pirate_ship_name)
        )
      `,
      )
      .order("sku", { ascending: true })
      .range(from, from + PAGE - 1);
    if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);
    const { data, error } = await q;
    if (error) throw new Error(`variants query failed: ${error.message}`);
    const batch = (data ?? []) as unknown as VariantRow[];
    variants.push(...batch);
    lastBatch = batch.length;
    from += PAGE;
  }
  console.log(`  loaded ${variants.length} variants`);

  // 2. Inventory levels keyed by variant_id
  const variantIds = variants.map((v) => v.id);
  type LevelRow = {
    variant_id: string;
    available: number;
    committed: number;
    incoming: number;
    updated_at: string;
  };
  const levelsByVariant = new Map<string, LevelRow>();
  const IN_CHUNK = 200;
  for (let i = 0; i < variantIds.length; i += IN_CHUNK) {
    const chunk = variantIds.slice(i, i + IN_CHUNK);
    const { data, error } = await sb
      .from("warehouse_inventory_levels")
      .select("variant_id, available, committed, incoming, updated_at")
      .in("variant_id", chunk);
    if (error) throw new Error(`levels query failed: ${error.message}`);
    for (const r of (data ?? []) as LevelRow[]) levelsByVariant.set(r.variant_id, r);
  }
  console.log(`  loaded ${levelsByVariant.size} inventory levels`);

  // 3. Per-variant location quantities (joined to location names)
  type VarLocRow = {
    variant_id: string;
    quantity: number;
    warehouse_locations: { name: string; barcode: string | null } | null;
  };
  const locsByVariant = new Map<
    string,
    Array<{ name: string; barcode: string | null; quantity: number }>
  >();
  for (let i = 0; i < variantIds.length; i += IN_CHUNK) {
    const chunk = variantIds.slice(i, i + IN_CHUNK);
    const { data, error } = await sb
      .from("warehouse_variant_locations")
      .select("variant_id, quantity, warehouse_locations!inner(name, barcode)")
      .in("variant_id", chunk);
    if (error) throw new Error(`variant_locations query failed: ${error.message}`);
    for (const r of (data ?? []) as unknown as VarLocRow[]) {
      const loc = r.warehouse_locations;
      if (!loc) continue;
      const arr = locsByVariant.get(r.variant_id) ?? [];
      arr.push({ name: loc.name, barcode: loc.barcode, quantity: r.quantity });
      locsByVariant.set(r.variant_id, arr);
    }
  }
  console.log(`  loaded location entries for ${locsByVariant.size} variants`);

  // 4. Bandcamp mappings (for type, URL, album title) keyed by variant_id
  type MappingRow = {
    variant_id: string;
    bandcamp_type_name: string | null;
    bandcamp_url: string | null;
    bandcamp_album_title: string | null;
    bandcamp_member_band_id: number | null;
    push_mode: string | null;
    product_category: string | null;
  };
  const mappingsByVariant = new Map<string, MappingRow>();
  const memberBandIds = new Set<number>();
  for (let i = 0; i < variantIds.length; i += IN_CHUNK) {
    const chunk = variantIds.slice(i, i + IN_CHUNK);
    const { data, error } = await sb
      .from("bandcamp_product_mappings")
      .select(
        "variant_id, bandcamp_type_name, bandcamp_url, bandcamp_album_title, bandcamp_member_band_id, push_mode, product_category",
      )
      .in("variant_id", chunk);
    if (error) throw new Error(`bandcamp mappings query failed: ${error.message}`);
    for (const r of (data ?? []) as MappingRow[]) {
      mappingsByVariant.set(r.variant_id, r);
      if (r.bandcamp_member_band_id) memberBandIds.add(r.bandcamp_member_band_id);
    }
  }
  console.log(`  loaded ${mappingsByVariant.size} bandcamp mappings`);

  // 5. Bandcamp band_name lookup (the artist/account display name)
  type BandRow = { band_id: number; band_name: string | null };
  const bandNameByBandId = new Map<number, string>();
  if (memberBandIds.size > 0) {
    const { data, error } = await sb
      .from("bandcamp_connections")
      .select("band_id, band_name")
      .in("band_id", Array.from(memberBandIds));
    if (error) throw new Error(`bandcamp connections query failed: ${error.message}`);
    for (const r of (data ?? []) as BandRow[]) {
      if (r.band_name) bandNameByBandId.set(r.band_id, r.band_name);
    }
  }
  console.log(`  loaded ${bandNameByBandId.size} bandcamp band names`);

  // 6. Workspace lookup (display the workspace slug for clarity)
  const workspaceIds = Array.from(new Set(variants.map((v) => v.workspace_id)));
  const wsByid = new Map<string, { name: string; slug: string }>();
  if (workspaceIds.length > 0) {
    const { data, error } = await sb
      .from("workspaces")
      .select("id, name, slug")
      .in("id", workspaceIds);
    if (error) throw new Error(`workspaces query failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{
      id: string;
      name: string;
      slug: string;
    }>) {
      wsByid.set(r.id, { name: r.name, slug: r.slug });
    }
  }

  // 7. All warehouse_locations (for the Locations Reference sheet)
  type AllLocRow = {
    workspace_id: string;
    name: string;
    barcode: string | null;
    location_type: string;
    is_active: boolean | null;
  };
  let allLocations: AllLocRow[] = [];
  {
    let q = sb
      .from("warehouse_locations")
      .select("workspace_id, name, barcode, location_type, is_active")
      .order("name", { ascending: true });
    if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);
    const { data, error } = await q;
    if (error) throw new Error(`locations query failed: ${error.message}`);
    allLocations = (data ?? []) as AllLocRow[];
  }
  console.log(`  loaded ${allLocations.length} warehouse_locations`);

  // -----------------------------------------------------------------------
  // Build the inventory master rows
  // -----------------------------------------------------------------------

  type SheetRow = Record<string, string | number>;
  const masterRows: SheetRow[] = [];

  const validationCounters: Record<string, number> = {
    missing_format: 0,
    missing_price: 0,
    missing_cost: 0,
    missing_vendor: 0,
    missing_artist: 0,
    missing_org: 0,
    null_org_id_in_db: 0,
    missing_locations: 0,
    locations_present_but_zero_qty: 0,
    locations_below_system_available: 0,
    missing_barcode: 0,
    missing_bandcamp_url: 0,
    missing_shopify_product_id: 0,
    parse_low_confidence: 0,
    archived_status: 0,
    draft_status: 0,
  };

  let rowIdx = 1;
  for (const v of variants) {
    const p = v.warehouse_products;
    const org = p?.organizations ?? null;
    if (!p) continue; // shouldn't happen — variant FK enforces product
    if (p.org_id == null) validationCounters.null_org_id_in_db++;
    const level = levelsByVariant.get(v.id) ?? null;
    const locs = locsByVariant.get(v.id) ?? [];
    const mapping = mappingsByVariant.get(v.id) ?? null;
    const ws = wsByid.get(v.workspace_id);
    const bandcampArtist =
      mapping?.bandcamp_member_band_id != null
        ? bandNameByBandId.get(mapping.bandcamp_member_band_id) ?? null
        : null;

    const split = splitArtistTitle(
      p.title,
      p.vendor,
      mapping?.bandcamp_album_title ?? null,
    );
    // Prefer the bandcamp band/account name if it differs cleanly from "label"
    // patterns. We keep the parsed artist when it likely names the actual
    // recording artist (e.g., title was "Foo Band - Album"); we ONLY swap to
    // bandcampArtist when parser confidence is "low" — it's the better
    // fallback than vendor.
    const finalArtist =
      split.confidence === "low" && bandcampArtist ? bandcampArtist : split.artist;

    const variantDetail =
      v.bandcamp_option_title ??
      v.option1_value ??
      (v.title && v.title !== "Default Title" ? v.title : "");

    const systemAvailable = level?.available ?? 0;
    const locationsTotal = locs.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
    const locationsCell = locs
      .map((l) => `${l.name}=${l.quantity}`)
      .join("; ");

    const tagsCsv = (p.tags ?? []).join(",");
    const shopifyAdmin = shopifyAdminUrl(p.shopify_product_id, storeUrl);

    // -------- validation flags --------
    const missing: string[] = [];
    if (!v.format_name || v.format_name.trim() === "") {
      missing.push("format");
      validationCounters.missing_format++;
    }
    if (v.price == null || Number(v.price) === 0) {
      missing.push("price");
      validationCounters.missing_price++;
    }
    if (v.cost == null) {
      missing.push("cost");
      validationCounters.missing_cost++;
    }
    if (!p.vendor || p.vendor.trim() === "") {
      missing.push("vendor");
      validationCounters.missing_vendor++;
    }
    if (!finalArtist || finalArtist.trim() === "") {
      missing.push("artist");
      validationCounters.missing_artist++;
    }
    if (!org?.name) {
      missing.push(p.org_id == null ? "org_unassigned" : "org_lookup_failed");
      validationCounters.missing_org++;
    }
    if (locs.length === 0) {
      missing.push("locations");
      validationCounters.missing_locations++;
    } else if (locationsTotal === 0 && systemAvailable > 0) {
      missing.push("location_qty=0_but_system>0");
      validationCounters.locations_present_but_zero_qty++;
    } else if (locationsTotal > 0 && locationsTotal < systemAvailable) {
      missing.push("location_qty<system_available");
      validationCounters.locations_below_system_available++;
    }
    if (!v.barcode || v.barcode.trim() === "") {
      missing.push("barcode");
      validationCounters.missing_barcode++;
    }
    if (mapping && (!mapping.bandcamp_url || mapping.bandcamp_url.trim() === "")) {
      missing.push("bandcamp_url");
      validationCounters.missing_bandcamp_url++;
    }
    if (!p.shopify_product_id) {
      missing.push("shopify_product_id");
      validationCounters.missing_shopify_product_id++;
    }
    if (split.confidence === "low") validationCounters.parse_low_confidence++;
    if (p.status === "archived") validationCounters.archived_status++;
    if (p.status === "draft") validationCounters.draft_status++;

    masterRows.push({
      "Row #": rowIdx++,
      SKU: v.sku,
      Format: v.format_name ?? "",
      Artist: finalArtist,
      "Album / Product Title": split.title || p.title,
      "Variant Detail": variantDetail,
      "Account / Label": org?.name ?? (p.org_id == null ? "(unassigned)" : ""),
      Vendor: p.vendor ?? "",
      "System Available": systemAvailable,
      "NEW COUNT": "", // staff fills in
      "Warehouse Locations (name=qty;...)": locationsCell,
      "Locations Total": locationsTotal,
      Price: fmtMoney(v.price),
      Cost: fmtMoney(v.cost),
      "Compare-At Price": fmtMoney(v.compare_at_price),
      Barcode: v.barcode ?? "",
      "Bandcamp UPC": p.bandcamp_upc ?? "",
      Weight: v.weight == null ? "" : Number(v.weight),
      "Weight Unit": v.weight_unit ?? "",
      "Bandcamp Type": mapping?.bandcamp_type_name ?? "",
      "Bandcamp Push Mode": mapping?.push_mode ?? "",
      "Bandcamp URL": mapping?.bandcamp_url ?? v.bandcamp_url ?? "",
      "Shopify Admin URL": shopifyAdmin ?? "",
      "Shopify Handle": p.shopify_handle ?? "",
      "Product Status": p.status ?? "",
      "Product Type": p.product_type ?? "",
      Tags: tagsCsv,
      "Street Date": fmtDate(v.street_date),
      "Is Preorder": fmtBool(v.is_preorder),
      "Title Parse Confidence": split.confidence,
      "Original Product Title": p.title,
      "Workspace Slug": ws?.slug ?? "",
      "Missing Fields": missing.join(", "),
      Notes: "", // staff fills in
      // Reimport key columns (kept at the END so they don't crowd the visible workspace)
      "_variant_id": v.id,
      "_product_id": p.id,
      "_org_id": org?.id ?? "",
      "_workspace_id": v.workspace_id,
      "_committed": level?.committed ?? 0,
      "_incoming": level?.incoming ?? 0,
      "_created_at": fmtDate(v.created_at),
      "_updated_at": fmtDate(v.updated_at),
      "_synced_at": fmtDate(p.synced_at),
    });
  }

  // -----------------------------------------------------------------------
  // Validation summary
  // -----------------------------------------------------------------------

  const totalRows = masterRows.length;
  const summaryRows: SheetRow[] = [
    { Metric: "Total variants", Count: totalRows, "% of total": "100.0%" },
    { Metric: "", Count: "", "% of total": "" },
  ];
  for (const [k, n] of Object.entries(validationCounters)) {
    const pct = totalRows > 0 ? ((n / totalRows) * 100).toFixed(1) + "%" : "";
    summaryRows.push({ Metric: k.replace(/_/g, " "), Count: n, "% of total": pct });
  }

  // Per-org SKU count + top labels
  const orgCounts = new Map<string, number>();
  for (const v of variants) {
    const p = v.warehouse_products;
    const name =
      p?.organizations?.name ?? (p?.org_id == null ? "(unassigned)" : "(no org)");
    orgCounts.set(name, (orgCounts.get(name) ?? 0) + 1);
  }
  const topOrgs = Array.from(orgCounts.entries()).sort((a, b) => b[1] - a[1]);

  summaryRows.push({ Metric: "", Count: "", "% of total": "" });
  summaryRows.push({ Metric: "— Top accounts/labels by variant count —", Count: "", "% of total": "" });
  for (const [name, n] of topOrgs.slice(0, 30)) {
    const pct = totalRows > 0 ? ((n / totalRows) * 100).toFixed(1) + "%" : "";
    summaryRows.push({ Metric: name, Count: n, "% of total": pct });
  }

  // Format distribution
  const fmtCounts = new Map<string, number>();
  for (const v of variants) {
    const f = v.format_name ?? "(missing)";
    fmtCounts.set(f, (fmtCounts.get(f) ?? 0) + 1);
  }
  summaryRows.push({ Metric: "", Count: "", "% of total": "" });
  summaryRows.push({ Metric: "— Format distribution —", Count: "", "% of total": "" });
  for (const [f, n] of Array.from(fmtCounts.entries()).sort((a, b) => b[1] - a[1])) {
    const pct = totalRows > 0 ? ((n / totalRows) * 100).toFixed(1) + "%" : "";
    summaryRows.push({ Metric: f, Count: n, "% of total": pct });
  }

  // Status distribution
  const statusCounts = new Map<string, number>();
  for (const v of variants) {
    const s = v.warehouse_products?.status ?? "(null)";
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  summaryRows.push({ Metric: "", Count: "", "% of total": "" });
  summaryRows.push({ Metric: "— Product status distribution —", Count: "", "% of total": "" });
  for (const [s, n] of Array.from(statusCounts.entries()).sort((a, b) => b[1] - a[1])) {
    const pct = totalRows > 0 ? ((n / totalRows) * 100).toFixed(1) + "%" : "";
    summaryRows.push({ Metric: s, Count: n, "% of total": pct });
  }

  // -----------------------------------------------------------------------
  // Locations reference sheet
  // -----------------------------------------------------------------------

  const locationRows: SheetRow[] = allLocations.map((l) => ({
    Name: l.name,
    Barcode: l.barcode ?? "",
    Type: l.location_type,
    Active: fmtBool(l.is_active),
    "Workspace ID": l.workspace_id,
  }));

  // -----------------------------------------------------------------------
  // README sheet
  // -----------------------------------------------------------------------

  const readmeRows: SheetRow[] = [
    { Field: "Generated at", Value: new Date().toISOString() },
    { Field: "Total variants exported", Value: totalRows },
    { Field: "Workspace filter", Value: args.workspaceId ?? "(all workspaces)" },
    { Field: "", Value: "" },
    { Field: "INVENTORY MASTER SHEET — column guide", Value: "" },
    { Field: "SKU", Value: "Stable key. Do NOT edit during count — used to match rows on reimport." },
    { Field: "Format", Value: "Canonical format set: LP, CD, Cassette, 7\", T-Shirt, Other. Edit if wrong." },
    { Field: "Artist", Value: "Best-effort parsed from product title. Edit if wrong." },
    { Field: "Album / Product Title", Value: "Best-effort parsed. Edit if wrong." },
    { Field: "Variant Detail", Value: "Size / colour / option label (e.g. 'Small', 'Black')." },
    { Field: "Account / Label", Value: "organizations.name in DB." },
    { Field: "Vendor", Value: "Shopify vendor (warehouse_products.vendor)." },
    { Field: "System Available", Value: "What the database currently believes is on hand." },
    { Field: "NEW COUNT", Value: "*** FILL THIS IN during inventory. Numeric. Blank = not counted yet. ***" },
    { Field: "Warehouse Locations (name=qty;...)", Value: "Existing per-location entries. Format: 'A1=4; B7=2'." },
    { Field: "Locations Total", Value: "Sum of all per-location quantities (auto)." },
    { Field: "Price", Value: "Selling price (USD). warehouse_product_variants.price." },
    { Field: "Cost", Value: "Wholesale/landed cost (USD). warehouse_product_variants.cost." },
    { Field: "Barcode", Value: "Variant barcode. Blank for many records — fill in if known." },
    { Field: "Bandcamp UPC", Value: "Album-level UPC if scraped from Bandcamp." },
    { Field: "Weight + Weight Unit", Value: "Used for shipping rate quotes." },
    { Field: "Bandcamp Type / URL / Push Mode", Value: "From bandcamp_product_mappings. URL is the canonical purchase page." },
    { Field: "Shopify Admin URL", Value: "Click to open the product directly in Shopify admin." },
    { Field: "Product Status", Value: "active | draft | archived. Drafts won't be on the storefront." },
    { Field: "Tags", Value: "Comma-separated Shopify tags." },
    { Field: "Missing Fields", Value: "Auto-detected gaps. Use this column to drive cleanup." },
    { Field: "Notes", Value: "*** Free text — write whatever you want during the count. ***" },
    { Field: "_variant_id / _product_id / _org_id / _workspace_id", Value: "Stable IDs used to match on reimport. DO NOT EDIT." },
    { Field: "", Value: "" },
    { Field: "REIMPORT BEHAVIOUR (when the import script lands)", Value: "" },
    { Field: "Match key", Value: "Primary: _variant_id. Fallback: workspace_id + SKU." },
    { Field: "What gets written", Value: "NEW COUNT → recordInventoryChange() with delta = NEW COUNT - current DB available, source='baseline_import', fanout.suppress=true." },
    { Field: "Other editable columns", Value: "Format, Artist, Title, Variant Detail, Vendor, Price, Cost, Barcode, Weight, Tags, Notes will be diffed and applied if changed." },
    { Field: "Locations", Value: "Editing the 'Warehouse Locations' cell rebuilds warehouse_variant_locations for that variant. New location names auto-create rows in warehouse_locations." },
    { Field: "Skipped fields", Value: "All columns prefixed with _ are read-only context for matching/audit." },
  ];

  // -----------------------------------------------------------------------
  // Write workbook
  // -----------------------------------------------------------------------

  const wb = XLSX.utils.book_new();

  const masterSheet = XLSX.utils.json_to_sheet(masterRows);
  // Sensible default column widths so the sheet is readable on first open.
  masterSheet["!cols"] = [
    { wch: 6 }, // Row #
    { wch: 22 }, // SKU
    { wch: 10 }, // Format
    { wch: 26 }, // Artist
    { wch: 38 }, // Title
    { wch: 16 }, // Variant Detail
    { wch: 24 }, // Account/Label
    { wch: 18 }, // Vendor
    { wch: 10 }, // System Available
    { wch: 12 }, // NEW COUNT
    { wch: 36 }, // Locations
    { wch: 10 }, // Locations Total
    { wch: 9 }, // Price
    { wch: 9 }, // Cost
    { wch: 12 }, // Compare-At
    { wch: 14 }, // Barcode
    { wch: 14 }, // UPC
    { wch: 8 }, // Weight
    { wch: 6 }, // Weight Unit
    { wch: 18 }, // Bandcamp Type
    { wch: 14 }, // Push Mode
    { wch: 40 }, // Bandcamp URL
    { wch: 56 }, // Shopify Admin URL
    { wch: 28 }, // Shopify Handle
    { wch: 9 }, // Status
    { wch: 14 }, // Product Type
    { wch: 30 }, // Tags
    { wch: 12 }, // Street Date
    { wch: 8 }, // Preorder
    { wch: 10 }, // Confidence
    { wch: 38 }, // Original title
    { wch: 14 }, // Workspace
    { wch: 32 }, // Missing fields
    { wch: 30 }, // Notes
  ];
  // Freeze header + first 2 columns (Row#, SKU) so they stay visible when scrolling.
  masterSheet["!freeze"] = { xSplit: 2, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, masterSheet, "Inventory Master");

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 50 }, { wch: 10 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, "Validation Summary");

  const locationsSheet = XLSX.utils.json_to_sheet(locationRows);
  locationsSheet["!cols"] = [{ wch: 24 }, { wch: 18 }, { wch: 10 }, { wch: 8 }, { wch: 38 }];
  XLSX.utils.book_append_sheet(wb, locationsSheet, "Locations Reference");

  const readmeSheet = XLSX.utils.json_to_sheet(readmeRows);
  readmeSheet["!cols"] = [{ wch: 44 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, readmeSheet, "README");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const outDir = join(process.cwd(), "reports", "inventory-master");
  mkdirSync(outDir, { recursive: true });
  const outPath = args.out ?? join(outDir, `inventory-master-${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  // -----------------------------------------------------------------------
  // Console summary
  // -----------------------------------------------------------------------

  console.log("");
  console.log(`Wrote ${outPath}`);
  console.log("");
  console.log(`Total variants:            ${totalRows}`);
  console.log(`Distinct accounts/labels:  ${orgCounts.size}`);
  console.log(`Distinct workspaces:       ${workspaceIds.length}`);
  console.log(`Distinct locations:        ${allLocations.length}`);
  console.log("");
  console.log("Missing-data flags (per row, can co-occur):");
  for (const [k, n] of Object.entries(validationCounters)) {
    const pct = totalRows > 0 ? ((n / totalRows) * 100).toFixed(1) + "%" : "";
    console.log(`  ${k.padEnd(34)} ${String(n).padStart(5)}  (${pct})`);
  }
  console.log("");
  console.log("Top 10 accounts/labels by variant count:");
  for (const [name, n] of topOrgs.slice(0, 10)) {
    console.log(`  ${name.padEnd(40)} ${String(n).padStart(5)}`);
  }
  console.log("");
  console.log("Format distribution:");
  for (const [f, n] of Array.from(fmtCounts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f.padEnd(20)} ${String(n).padStart(5)}`);
  }
}

main().catch((err) => {
  console.error("[export-inventory-master] FAILED:", err);
  process.exit(1);
});
