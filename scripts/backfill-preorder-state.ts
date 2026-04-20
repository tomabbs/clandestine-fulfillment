// One-shot backfill — re-derive preorder_state for every awaiting_shipment
// shipstation_orders row.
//
// Why this exists: the original preorder-tab-refresh cron only re-evaluated
// orders that were ALREADY in 'preorder' or 'ready' state (Phase 5.3 bug),
// so orders ingested before a variant was marked is_preorder=true would stay
// at preorder_state='none' forever. This script fixes the historical data.
//
// Safe to re-run; idempotent. Re-uses applyPreorderState so the logic stays
// in one place.
//
// Usage:
//   pnpm tsx scripts/backfill-preorder-state.ts --dry-run
//   pnpm tsx scripts/backfill-preorder-state.ts            (live)
//   pnpm tsx scripts/backfill-preorder-state.ts --workspace=<id>
//   pnpm tsx scripts/backfill-preorder-state.ts --include-shipped
//                                                (also re-derives shipped/cancelled)

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { deriveOrderPreorderState } from "../src/lib/shared/order-preorder";

interface Args {
  dryRun: boolean;
  workspaceId: string | null;
  includeNonAwaiting: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { dryRun: false, workspaceId: null, includeNonAwaiting: false };
  for (const a of args) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--include-shipped") out.includeNonAwaiting = true;
    else if (a.startsWith("--workspace=")) out.workspaceId = a.slice("--workspace=".length);
  }
  return out;
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

  console.log(
    `[backfill-preorder-state] dryRun=${args.dryRun} workspace=${args.workspaceId ?? "all"} includeNonAwaiting=${args.includeNonAwaiting}`,
  );

  // Pull candidate orders. Default = awaiting_shipment only (the only status
  // where preorder tabs are actionable).
  let q = s.from("shipstation_orders").select("id, workspace_id, order_status, preorder_state");
  if (!args.includeNonAwaiting) q = q.eq("order_status", "awaiting_shipment");
  if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);
  const { data: orders, error } = await q.limit(20000);
  if (error) {
    console.error("FATAL: order select failed:", error.message);
    process.exit(1);
  }
  if (!orders || orders.length === 0) {
    console.log("[backfill-preorder-state] no orders to process");
    return;
  }
  console.log(`[backfill-preorder-state] candidates: ${orders.length}`);

  // Pre-load the workspace's active preorder variants once per workspace.
  const variantsByWs = new Map<string, Map<string, { sku: string; is_preorder: boolean | null; street_date: string | null }>>();
  const workspaceIds = Array.from(new Set(orders.map((o) => o.workspace_id as string)));
  for (const ws of workspaceIds) {
    const { data: vs } = await s
      .from("warehouse_product_variants")
      .select("sku, is_preorder, street_date")
      .eq("workspace_id", ws)
      .eq("is_preorder", true)
      .limit(20000);
    const lookup = new Map<string, { sku: string; is_preorder: boolean | null; street_date: string | null }>();
    for (const v of vs ?? []) lookup.set(v.sku as string, v as never);
    variantsByWs.set(ws, lookup);
    console.log(`  workspace ${ws.slice(0, 8)}: ${lookup.size} active preorder variants loaded`);
  }

  // For each order, fetch items, derive, update if changed.
  let scanned = 0;
  let promotedToPreorder = 0;
  let promotedToReady = 0;
  let demotedToNone = 0;
  let unchanged = 0;
  let errors = 0;

  // Pull items in chunks for performance — 200 orders at a time.
  const CHUNK = 200;
  for (let i = 0; i < orders.length; i += CHUNK) {
    const slice = orders.slice(i, i + CHUNK);
    const sliceIds = slice.map((o) => o.id as string);
    const { data: items } = await s
      .from("shipstation_order_items")
      .select("shipstation_order_id, sku")
      .in("shipstation_order_id", sliceIds);
    const itemsByOrder = new Map<string, Array<{ sku: string | null }>>();
    for (const it of items ?? []) {
      const oid = it.shipstation_order_id as string;
      if (!itemsByOrder.has(oid)) itemsByOrder.set(oid, []);
      itemsByOrder.get(oid)!.push({ sku: (it.sku as string | null) ?? null });
    }

    for (const order of slice) {
      scanned++;
      const ws = order.workspace_id as string;
      const previous = order.preorder_state as "none" | "preorder" | "ready";
      const orderItems = itemsByOrder.get(order.id as string) ?? [];
      const lookup = variantsByWs.get(ws) ?? new Map();
      // Filter the lookup down to JUST the variants present in this order
      // so we're not making the function scan the whole workspace catalog.
      const orderSkus = new Set(orderItems.map((it) => it.sku).filter((s): s is string => !!s));
      const orderLookup = new Map<string, { sku: string; is_preorder: boolean | null; street_date: string | null }>();
      for (const sku of orderSkus) {
        const v = lookup.get(sku);
        if (v) orderLookup.set(sku, v);
      }
      const derived = deriveOrderPreorderState({
        items: orderItems,
        variantLookup: orderLookup,
      });
      if (derived.preorder_state === previous) {
        unchanged++;
        continue;
      }
      if (previous === "none" && derived.preorder_state === "preorder") promotedToPreorder++;
      else if (previous === "none" && derived.preorder_state === "ready") promotedToReady++;
      else if (derived.preorder_state === "none") demotedToNone++;

      if (args.dryRun) continue;
      const { error: updErr } = await s
        .from("shipstation_orders")
        .update({
          preorder_state: derived.preorder_state,
          preorder_release_date: derived.preorder_release_date,
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.id as string);
      if (updErr) {
        errors++;
        console.warn(`  update failed for order ${order.id}: ${updErr.message}`);
      }
    }
    process.stdout.write(`  processed ${Math.min(i + CHUNK, orders.length)}/${orders.length}\r`);
  }
  process.stdout.write("\n");

  console.log("[backfill-preorder-state] DONE");
  console.log(`  scanned             : ${scanned}`);
  console.log(`  promoted none→preorder: ${promotedToPreorder}`);
  console.log(`  promoted none→ready : ${promotedToReady}`);
  console.log(`  demoted to none     : ${demotedToNone}`);
  console.log(`  unchanged           : ${unchanged}`);
  console.log(`  errors              : ${errors}`);
  if (args.dryRun) console.log("  (dry-run — no DB writes)");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
