/**
 * One-time title correction for Bandcamp-mapped products.
 *
 * Rebuilds product titles using the correct artist name (from member_bands_cache)
 * and album title (from bandcamp_product_mappings).
 *
 * Usage:
 *   npx tsx scripts/fix-product-titles.ts --dry-run
 *   npx tsx scripts/fix-product-titles.ts --apply
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import "dotenv/config";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (!apply && !dryRun) {
  console.error("Usage: npx tsx scripts/fix-product-titles.ts [--dry-run|--apply]");
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOPIFY_URL = process.env.SHOPIFY_STORE_URL!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN!;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-01";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function normalizeFormat(itemType: string | null | undefined): string | null {
  if (!itemType) return null;
  const t = itemType.toLowerCase().trim();
  if (t.includes("vinyl") || t === "lp" || t.includes("2xlp")) return "LP";
  if (t.includes("cassette") || t === "tape" || t.includes("ltd. cassette")) return "Cassette";
  if (t.includes("cd") || t.includes("compact disc") || t.includes("digipak")) return "CD";
  if (t.includes('7"') || t.includes("7-inch")) return '7"';
  if (t.includes("shirt") || t.includes("apparel") || t.includes("hoodie")) return null;
  if (t.includes("poster") || t.includes("bag") || t.includes("hat") || t.includes("zine")) return null;
  return null;
}

function buildTitle(
  artistName: string,
  albumTitle: string | null,
  itemTitle: string,
  formatType: string | null,
): string {
  const artist = artistName?.trim();
  if (!artist) return itemTitle;

  if (albumTitle?.trim()) {
    const album = albumTitle.trim();
    const format = normalizeFormat(formatType);
    const needsFormat = format && !album.includes(format);
    return needsFormat ? `${artist} - ${album} ${format}` : `${artist} - ${album}`;
  }

  if (artist !== itemTitle) {
    return `${artist} - ${itemTitle}`;
  }
  return itemTitle;
}

async function shopifyUpdateTitle(shopifyProductId: string, newTitle: string): Promise<boolean> {
  const res = await fetch(`${SHOPIFY_URL}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({
      query: `mutation UpdateTitle($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }`,
      variables: { input: { id: shopifyProductId, title: newTitle } },
    }),
  });

  if (!res.ok) return false;
  const json = (await res.json()) as {
    data?: { productUpdate?: { userErrors?: { message: string }[] } };
  };
  return !(json.data?.productUpdate?.userErrors?.length);
}

async function fetchAll(table: string, select: string) {
  let all: Record<string, unknown>[] = [];
  let page = 0;
  while (true) {
    const { data } = await supabase
      .from(table)
      .select(select)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data || data.length === 0) break;
    all = all.concat(data as unknown as Record<string, unknown>[]);
    page++;
  }
  return all;
}

async function main() {
  console.log(`\nProduct Title Fix — ${dryRun ? "DRY RUN" : "APPLY MODE"}\n`);

  // Build member_band_id → artist name map
  const allConns = await fetchAll("bandcamp_connections", "band_id, band_name, member_bands_cache");
  const memberMap = new Map<number, string>();
  const labelBandIds = new Set<number>();
  for (const c of allConns) {
    const bandId = c.band_id as number;
    const bandName = c.band_name as string;
    memberMap.set(bandId, bandName);
    labelBandIds.add(bandId);
    const cache = c.member_bands_cache as Record<string, unknown> | null;
    if (cache) {
      const parsed = typeof cache === "string" ? JSON.parse(cache) : cache;
      const members = (parsed?.member_bands ?? (Array.isArray(parsed) ? parsed : [])) as Array<{
        band_id: number;
        name: string;
      }>;
      for (const mb of members) {
        if (mb.band_id && mb.name) memberMap.set(mb.band_id, mb.name);
      }
    }
  }
  console.log(`Member band name map: ${memberMap.size} entries`);

  // Get workspace
  const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!ws) {
    console.error("No workspace");
    process.exit(1);
  }
  const workspaceId = ws.id as string;

  // Load all data
  const mappings = await fetchAll(
    "bandcamp_product_mappings",
    "variant_id, bandcamp_member_band_id, bandcamp_album_title, bandcamp_type_name, authority_status, raw_api_data",
  );
  const variants = await fetchAll("warehouse_product_variants", "id, sku, title, product_id");
  const products = await fetchAll("warehouse_products", "id, title, vendor, shopify_product_id");
  const variantMap = new Map(variants.map((v) => [v.id as string, v]));
  const productMap = new Map(products.map((p) => [p.id as string, p]));

  console.log(`Mappings: ${mappings.length}, Variants: ${variants.length}, Products: ${products.length}`);

  let corrected = 0;
  let skippedCorrect = 0;
  let skippedAuthority = 0;
  let unresolvable = 0;
  let shopifyUpdated = 0;
  let shopifyFailed = 0;
  let altTextUpdated = 0;
  const unresolvableRows: Array<{ sku: string; currentTitle: string; memberBandId: number }> = [];
  const changes: Array<{ productId: string; oldTitle: string; newTitle: string; sku: string; shopifyId: string | null }> = [];

  for (const m of mappings) {
    const authorityStatus = m.authority_status as string;
    if (authorityStatus !== "bandcamp_initial") {
      skippedAuthority++;
      continue;
    }

    const variant = variantMap.get(m.variant_id as string);
    if (!variant) continue;
    const product = productMap.get(variant.product_id as string);
    if (!product) continue;

    const memberBandId = m.bandcamp_member_band_id as number | null;
    if (!memberBandId) continue;

    const artistName = memberMap.get(memberBandId);
    if (!artistName) {
      unresolvable++;
      unresolvableRows.push({
        sku: variant.sku as string,
        currentTitle: product.title as string,
        memberBandId,
      });
      continue;
    }

    const albumTitle = m.bandcamp_album_title as string | null;
    const formatType = m.bandcamp_type_name as string | null;
    const rawItemTitle = (m as Record<string, unknown>).raw_api_data
      ? ((m as Record<string, unknown>).raw_api_data as Record<string, string>).title
      : null;
    const itemTitle = rawItemTitle ?? (variant.title as string);
    const newTitle = buildTitle(artistName, albumTitle, itemTitle, formatType);
    const currentTitle = product.title as string;

    if (currentTitle === newTitle) {
      skippedCorrect++;
      continue;
    }

    const currentHasDash = currentTitle.includes(" - ");
    const currentStartsWithLabel = labelBandIds.size > 0 && [...allConns].some(
      (c) => currentTitle.toUpperCase().startsWith(((c.band_name as string) ?? "").toUpperCase() + " - "),
    );
    if (currentHasDash && !currentStartsWithLabel) {
      skippedCorrect++;
      continue;
    }

    const shopifyId = product.shopify_product_id as string | null;

    changes.push({
      productId: product.id as string,
      oldTitle: currentTitle,
      newTitle,
      sku: variant.sku as string,
      shopifyId,
    });

    if (apply) {
      // Update DB title
      await supabase
        .from("warehouse_products")
        .update({ title: newTitle, updated_at: new Date().toISOString() })
        .eq("id", product.id as string);

      // Update alt text on primary image
      const { data: primaryImg } = await supabase
        .from("warehouse_product_images")
        .select("id")
        .eq("product_id", product.id as string)
        .eq("position", 0)
        .maybeSingle();

      if (primaryImg) {
        const altText = `${newTitle} - Album Art`.slice(0, 255);
        await supabase
          .from("warehouse_product_images")
          .update({ alt: altText })
          .eq("id", primaryImg.id);
        altTextUpdated++;
      }

      // Set authority_status to warehouse_reviewed
      await supabase
        .from("bandcamp_product_mappings")
        .update({ authority_status: "warehouse_reviewed", updated_at: new Date().toISOString() })
        .eq("variant_id", m.variant_id as string);

      // Update Shopify if product has a Shopify ID
      if (shopifyId) {
        await new Promise((r) => setTimeout(r, 300));
        const ok = await shopifyUpdateTitle(shopifyId, newTitle);
        if (ok) shopifyUpdated++;
        else shopifyFailed++;
      }
    }

    corrected++;
  }

  // Log to channel_sync_log
  if (apply && corrected > 0) {
    await supabase.from("channel_sync_log").insert({
      workspace_id: workspaceId,
      channel: "bandcamp",
      sync_type: "title_correction",
      status: "completed",
      items_processed: corrected,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      metadata: {
        corrected,
        skippedCorrect,
        skippedAuthority,
        unresolvable,
        shopifyUpdated,
        shopifyFailed,
        altTextUpdated,
      },
    });
  }

  // Write changes CSV
  if (changes.length > 0) {
    const csvDir = path.join(process.cwd(), "reports");
    fs.mkdirSync(csvDir, { recursive: true });
    const csvPath = path.join(csvDir, `title-corrections-${new Date().toISOString().split("T")[0]}.csv`);
    const lines = [
      "sku,old_title,new_title,shopify_id",
      ...changes.map(
        (c) =>
          `"${c.sku}","${c.oldTitle.replace(/"/g, '""')}","${c.newTitle.replace(/"/g, '""')}","${c.shopifyId ?? ""}"`,
      ),
    ];
    fs.writeFileSync(csvPath, lines.join("\n"));
    console.log(`Changes CSV: ${csvPath}`);
  }

  // Write unresolvable CSV
  if (unresolvableRows.length > 0) {
    const csvDir = path.join(process.cwd(), "reports");
    fs.mkdirSync(csvDir, { recursive: true });
    const csvPath = path.join(csvDir, `title-unresolvable-${new Date().toISOString().split("T")[0]}.csv`);
    const lines = [
      "sku,current_title,member_band_id",
      ...unresolvableRows.map(
        (r) => `"${r.sku}","${r.currentTitle.replace(/"/g, '""')}",${r.memberBandId}`,
      ),
    ];
    fs.writeFileSync(csvPath, lines.join("\n"));
    console.log(`Unresolvable CSV: ${csvPath}`);
  }

  console.log(`\n=== TITLE FIX SUMMARY (${dryRun ? "DRY RUN" : "APPLIED"}) ===`);
  console.log(`Total mappings:        ${mappings.length}`);
  console.log(`Corrected:             ${corrected}`);
  console.log(`Already correct:       ${skippedCorrect}`);
  console.log(`Skipped (authority):   ${skippedAuthority}`);
  console.log(`Unresolvable artist:   ${unresolvable}`);
  if (apply) {
    console.log(`Shopify updated:       ${shopifyUpdated}`);
    console.log(`Shopify failed:        ${shopifyFailed}`);
    console.log(`Alt text updated:      ${altTextUpdated}`);
  }
  console.log();
}

main().catch((err) => {
  console.error("Title fix failed:", err);
  process.exit(1);
});
