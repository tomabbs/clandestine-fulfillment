/**
 * Phase 0.5.5 — backfill warehouse_product_variants.hs_tariff_code from product
 * category data, where available, falling back to the conservative global
 * default for music shipments.
 *
 * Run: npx tsx scripts/backfill-hs-codes.ts [--dry-run] [--workspace=<id>]
 *
 * Logic:
 *   1. Find all warehouse_product_variants where hs_tariff_code is NULL or
 *      equals the legacy default '8523.80' (the previous schema default).
 *   2. Join warehouse_products → bandcamp_product_mappings by product_id and
 *      look at product_category.
 *   3. Map category → HS code using the table in customs-builder.ts.
 *   4. Variants with no category fall back to '8523.80.4000' (vinyl music).
 *   5. Update in batches; never touch a row that already has a non-default code.
 *
 * --dry-run prints the planned changes without writing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { HS_CODE_DEFAULTS, HS_CODE_GLOBAL_FALLBACK } from "../src/lib/shared/customs-builder";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const isDryRun = args.has("--dry-run");
const workspaceArg = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];

const supabase = createClient(url, key, { auth: { persistSession: false } });

const LEGACY_DEFAULT = "8523.80";
const BATCH_SIZE = 500;

async function main() {
  console.log(`[backfill-hs-codes] mode=${isDryRun ? "DRY-RUN" : "WRITE"}`);
  if (workspaceArg) console.log(`[backfill-hs-codes] scoped to workspace ${workspaceArg}`);

  // Fetch variants to update — null OR legacy default = needs backfill.
  let q = supabase
    .from("warehouse_product_variants")
    .select("id, sku, hs_tariff_code, workspace_id")
    .or(`hs_tariff_code.is.null,hs_tariff_code.eq.${LEGACY_DEFAULT}`)
    .limit(50000);
  if (workspaceArg) q = q.eq("workspace_id", workspaceArg);

  const { data: variants, error } = await q;
  if (error) {
    console.error("[backfill-hs-codes] query failed:", error.message);
    process.exit(1);
  }

  if (!variants?.length) {
    console.log("[backfill-hs-codes] No variants to backfill — exiting.");
    return;
  }

  console.log(`[backfill-hs-codes] candidates: ${variants.length}`);

  // Pull category data from bandcamp_product_mappings keyed by variant_id.
  // Chunked because PostgREST .in() filters serialize into the URL and a
  // single 1000-item filter blows past the server-side URL length cap (the
  // earlier "Bad Request" was URL truncation, not a schema-cache miss).
  const VARIANT_BATCH = 200;
  const variantIds = variants.map((v) => v.id);
  const categoryByVariant = new Map<string, string | null>();
  for (let i = 0; i < variantIds.length; i += VARIANT_BATCH) {
    const slice = variantIds.slice(i, i + VARIANT_BATCH);
    const { data: mappings, error: mapErr } = await supabase
      .from("bandcamp_product_mappings")
      .select("variant_id, product_category")
      .in("variant_id", slice);
    if (mapErr) {
      console.warn(
        `[backfill-hs-codes] category lookup batch ${i / VARIANT_BATCH + 1} failed (continuing): ${mapErr.message}`,
      );
      continue;
    }
    for (const m of mappings ?? []) {
      categoryByVariant.set(m.variant_id, m.product_category ?? null);
    }
  }
  console.log(`[backfill-hs-codes] resolved categories for ${categoryByVariant.size} variant(s)`);

  const counts: Record<string, number> = {};
  const updates: Array<{ id: string; sku: string; from: string | null; to: string }> = [];

  for (const v of variants) {
    const category = categoryByVariant.get(v.id)?.toLowerCase().trim() ?? null;
    const hs = (category && HS_CODE_DEFAULTS[category]) || HS_CODE_GLOBAL_FALLBACK;
    counts[hs] = (counts[hs] ?? 0) + 1;
    updates.push({ id: v.id, sku: v.sku, from: v.hs_tariff_code ?? null, to: hs });
  }

  console.log("[backfill-hs-codes] resolution histogram:");
  for (const [code, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code}: ${n}`);
  }

  if (isDryRun) {
    console.log("[backfill-hs-codes] DRY-RUN — no writes. Sample:");
    for (const u of updates.slice(0, 10)) console.log(`  ${u.sku}: ${u.from ?? "NULL"} → ${u.to}`);
    return;
  }

  // Batch updates.
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    // Group by target code to do batched updates per code.
    const byCode = new Map<string, string[]>();
    for (const u of batch) {
      const arr = byCode.get(u.to) ?? [];
      arr.push(u.id);
      byCode.set(u.to, arr);
    }
    for (const [code, ids] of byCode) {
      const { error: updErr } = await supabase
        .from("warehouse_product_variants")
        .update({ hs_tariff_code: code })
        .in("id", ids);
      if (updErr) {
        console.error(`[backfill-hs-codes] update failed for code ${code}:`, updErr.message);
      } else {
        written += ids.length;
      }
    }
    console.log(`[backfill-hs-codes] wrote ${Math.min(i + BATCH_SIZE, updates.length)}/${updates.length}`);
  }

  console.log(`[backfill-hs-codes] DONE — wrote ${written} variant updates`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
