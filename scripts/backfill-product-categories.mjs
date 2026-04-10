/**
 * Backfill product_category for all bandcamp_product_mappings.
 *
 * Usage:
 *   node scripts/backfill-product-categories.mjs --dry-run   (preview)
 *   node scripts/backfill-product-categories.mjs --apply      (write)
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const isDryRun = !process.argv.includes("--apply");

const BUNDLE = /bundle|combo|\b2.?pack\b|\blp\s*\+\s*/i;
const VINYL = /vinyl|lp|record|test press|lathe/i;
const CD = /compact disc|\bcd\b|digipack|digipak/i;
const CASSETTE = /cassette|tape|\bcs\b/i;
const APPAREL = /t-shirt|shirt|tee|hoodie|sweater|sweatshirt|hat|cap|apparel|longsleeve|long sleeve|crewneck/i;
const MERCH = /bag|tote|poster|print|sticker|pin|patch|button|zine|book|magazine|slipmat|bandana|usb|flash drive/i;

function classify(typeName, url, title) {
  const combined = `${(typeName ?? "").normalize("NFKC").toLowerCase()} ${(title ?? "").normalize("NFKC").toLowerCase()}`;
  if (BUNDLE.test(combined)) return "bundle";
  if (VINYL.test(combined)) return "vinyl";
  if (CD.test(combined)) return "cd";
  if (CASSETTE.test(combined)) return "cassette";
  if (APPAREL.test(combined)) return "apparel";
  if (MERCH.test(combined)) return "merch";
  if (url) {
    try {
      const path = new URL(url).pathname;
      if (path.startsWith("/merch/")) return APPAREL.test(combined) ? "apparel" : "merch";
      if (path.startsWith("/album/")) return "other";
    } catch { /* malformed */ }
  }
  return "other";
}

async function main() {
  console.log(`Backfill product categories (${isDryRun ? "DRY RUN" : "LIVE APPLY"})\n`);
  const stats = { vinyl: 0, cd: 0, cassette: 0, apparel: 0, merch: 0, bundle: 0, other: 0 };
  let offset = 0;
  let total = 0;

  while (true) {
    const { data } = await sb.from("bandcamp_product_mappings")
      .select("id, bandcamp_type_name, bandcamp_url, raw_api_data")
      .is("product_category", null)
      .range(offset, offset + 99);
    if (!data?.length) break;

    for (const m of data) {
      const raw = m.raw_api_data ? (typeof m.raw_api_data === "string" ? JSON.parse(m.raw_api_data) : m.raw_api_data) : {};
      const cat = classify(m.bandcamp_type_name ?? raw.type_name, m.bandcamp_url, raw.title);
      stats[cat]++;
      total++;

      if (!isDryRun) {
        await sb.from("bandcamp_product_mappings").update({ product_category: cat }).eq("id", m.id);
      }
    }
    if (data.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 50));
  }

  console.log("Category distribution:");
  for (const [cat, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log("  " + cat.padEnd(12) + String(count).padStart(5));
  }
  console.log("\n  Total:", total);
  if (isDryRun) console.log("\n  (dry run — run with --apply to write)");
}

main().catch(e => { console.error(e); process.exit(1); });
