// One-shot dedup + normalize for warehouse_products.shopify_product_id.
//
// Background — the 2026-04-20 audit found 1,452 duplicate groups
// (2,905 rows) caused by mixed-format Shopify IDs:
//   "9947238072635"                          (numeric, REST format)
//   "gid://shopify/Product/9947238072635"    (GID, GraphQL format)
//
// String-equality dedup couldn't see them as the same row, so a re-sync
// in the new format created brand-new product rows next to the existing
// ones. Variants stayed attached to the OLD row (variant inserts are keyed
// on (workspace_id, sku) so they upserted into existing variant rows
// without re-targeting), leaving the NEW product row with 0 variants.
//
// What this script does:
//   1. Find every duplicate group (same workspace_id + same NORMALIZED ID)
//   2. KEEP the row with more variants (or the older row if tied) —
//      that's the one variants are attached to
//   3. DELETE the other row(s)
//   4. Then UPDATE every remaining row to use the canonical numeric format
//
// Safety:
//   - --dry-run prints what it would do, no DB writes
//   - Idempotent — safe to re-run
//   - Per-row logging for full audit trail
//
// Usage:
//   pnpm tsx scripts/dedup-shopify-products.ts --dry-run
//   pnpm tsx scripts/dedup-shopify-products.ts            (live)
//   pnpm tsx scripts/dedup-shopify-products.ts --workspace=<id>

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { normalizeShopifyProductId } from "../src/lib/shared/shopify-id";

interface Args {
  dryRun: boolean;
  workspaceId: string | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { dryRun: false, workspaceId: null };
  for (const a of args) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--workspace=")) out.workspaceId = a.slice("--workspace=".length);
  }
  return out;
}

interface ProductRow {
  id: string;
  workspace_id: string;
  org_id: string | null;
  shopify_product_id: string;
  created_at: string;
}

async function main() {
  const args = parseArgs();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    process.exit(1);
  }
  const s = createClient(url, key);
  console.log(`[dedup-shopify-products] dryRun=${args.dryRun} workspace=${args.workspaceId ?? "all"}`);

  // ── Phase 1: pull every row with a shopify_product_id (paginated) ────────
  const all: ProductRow[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    let q = s
      .from("warehouse_products")
      .select("id, workspace_id, org_id, shopify_product_id, created_at")
      .not("shopify_product_id", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);
    const { data, error } = await q;
    if (error) {
      console.error("FATAL: select failed:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    all.push(...(data as ProductRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`[dedup-shopify-products] scanned ${all.length} rows with shopify_product_id`);

  // ── Phase 2: count variants per product so we know which row to keep ─────
  // CRITICAL bug found 2026-04-20 (post-mortem): the previous version of
  // this script batched product IDs in slices of 5000 and ran one .in()
  // query per slice. Supabase caps each response at 1000 rows by default,
  // so when a slice had >1000 matching variants the count silently
  // truncated to 1000 — causing the wrong row to be "kept" in any group
  // where both rows had 0 counted variants. The result was 21 deleted
  // Hologram variants (cascade) before we noticed.
  // Fix: paginate the variant scan separately and count over ALL rows.
  const variantCounts = new Map<string, number>();
  let vFrom = 0;
  for (;;) {
    const { data, error } = await s
      .from("warehouse_product_variants")
      .select("product_id")
      .order("id")
      .range(vFrom, vFrom + PAGE - 1);
    if (error) {
      console.error("FATAL: variant scan failed:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const v of data) {
      const k = v.product_id as string | null;
      if (!k) continue;
      variantCounts.set(k, (variantCounts.get(k) ?? 0) + 1);
    }
    if (data.length < PAGE) break;
    vFrom += PAGE;
  }
  console.log(`[dedup-shopify-products] counted variants across ${variantCounts.size} products`);

  // ── Phase 3: group by (workspace_id, normalized_id) ──────────────────────
  const byKey = new Map<string, ProductRow[]>();
  for (const r of all) {
    const k = `${r.workspace_id}|${normalizeShopifyProductId(r.shopify_product_id)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  const dupeGroups = Array.from(byKey.values()).filter((g) => g.length > 1);
  console.log(
    `[dedup-shopify-products] duplicate groups: ${dupeGroups.length}; rows in groups: ${dupeGroups.reduce((a, g) => a + g.length, 0)}; would delete: ${dupeGroups.reduce((a, g) => a + (g.length - 1), 0)}`,
  );

  // ── Phase 4: per-group, KEEP the row with most variants (tiebreak: oldest) ──
  const toDelete: string[] = [];
  const toReKey: Array<{ id: string; from: string; to: string }> = [];
  for (const group of dupeGroups) {
    const sorted = [...group].sort((a, b) => {
      const va = variantCounts.get(a.id) ?? 0;
      const vb = variantCounts.get(b.id) ?? 0;
      if (vb !== va) return vb - va; // most variants first
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime(); // oldest first
    });
    const keep = sorted[0];
    const drop = sorted.slice(1);
    for (const d of drop) toDelete.push(d.id);
    // If kept row's ID is not already normalized, queue a re-key.
    const canonical = normalizeShopifyProductId(keep.shopify_product_id);
    if (canonical && canonical !== keep.shopify_product_id) {
      toReKey.push({ id: keep.id, from: keep.shopify_product_id, to: canonical });
    }
  }

  // ── Phase 5: also normalize SINGLE-row groups (no dupes, but still GID format) ──
  for (const [, group] of byKey) {
    if (group.length !== 1) continue;
    const r = group[0];
    const canonical = normalizeShopifyProductId(r.shopify_product_id);
    if (canonical && canonical !== r.shopify_product_id) {
      toReKey.push({ id: r.id, from: r.shopify_product_id, to: canonical });
    }
  }

  console.log(`[dedup-shopify-products] plan:`);
  console.log(`  delete duplicate rows: ${toDelete.length}`);
  console.log(`  normalize remaining IDs (GID -> numeric): ${toReKey.length}`);

  if (args.dryRun) {
    console.log("[dedup-shopify-products] dry-run — exiting without DB writes");
    return;
  }

  // ── Phase 6: execute. Deletes first (so re-key doesn't hit unique conflict) ──
  const DPAGE = 200;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += DPAGE) {
    const slice = toDelete.slice(i, i + DPAGE);
    const { error } = await s.from("warehouse_products").delete().in("id", slice);
    if (error) {
      console.warn(`  delete chunk ${i / DPAGE + 1}: ${error.message}`);
      continue;
    }
    deleted += slice.length;
    process.stdout.write(`  deleted ${deleted}/${toDelete.length}\r`);
  }
  process.stdout.write("\n");

  // Re-keys: one per row (different `to` value each time, so no batch).
  let updated = 0;
  let updateErrors = 0;
  for (const r of toReKey) {
    const { error } = await s
      .from("warehouse_products")
      .update({ shopify_product_id: r.to, updated_at: new Date().toISOString() })
      .eq("id", r.id);
    if (error) {
      // 23505 = UNIQUE constraint hit (something raced). Skip and continue.
      if (error.code === "23505") {
        updateErrors++;
        continue;
      }
      console.warn(`  re-key ${r.id} failed: ${error.message}`);
      updateErrors++;
      continue;
    }
    updated++;
    if (updated % 100 === 0) process.stdout.write(`  re-keyed ${updated}/${toReKey.length}\r`);
  }
  process.stdout.write("\n");

  console.log(`[dedup-shopify-products] DONE`);
  console.log(`  rows deleted: ${deleted}`);
  console.log(`  rows re-keyed (GID -> numeric): ${updated}`);
  console.log(`  re-key errors (incl. 23505): ${updateErrors}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
