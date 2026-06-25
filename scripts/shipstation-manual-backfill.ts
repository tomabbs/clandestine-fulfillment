/**
 * Manual ShipStation orders backfill.
 *
 * On-demand catch-up when the scheduled `shipstation-orders-poll` cron has
 * fallen behind. Pulls ShipStation orders modified since the given date and
 * upserts them into the local mirror with the same logic the cron uses
 * (matchShipmentOrg → shipstation_orders + shipstation_order_items).
 *
 * Useful for:
 *   - Disaster recovery if the Trigger.dev cron is down
 *   - Ad-hoc date-range queries (e.g., compute units shipped since X for
 *     inventory math)
 *   - Bulk backfill if a deploy gap left a hole in the mirror
 *
 * Unlike the cron, this script has NO time budget — it'll happily run for
 * hours processing thousands of orders. Idempotent on
 * `(workspace_id, shipstation_order_id)`, so re-running over already-imported
 * orders is a no-op.
 *
 * The script also advances `warehouse_sync_state.last_sync_cursor` at the
 * end so the cron picks up cleanly from where this run finished.
 *
 * Usage:
 *   pnpm tsx scripts/shipstation-manual-backfill.ts --workspace-id <uuid> [--since <ISO date>]
 *
 * Defaults:
 *   --since defaults to the workspace's current `last_sync_cursor` if no flag
 *           is provided; falls back to 7 days ago if the cursor is empty.
 *
 * Created 2026-06-25 after the cron had been stuck on MAX_DURATION_EXCEEDED
 * for ~2 months. The cron itself was fixed (page cap + cursor-by-progress)
 * in the same session, but this script remains the manual escape hatch.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { fetchOrders, type ShipStationOrder } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { matchShipmentOrg } from "@/trigger/lib/match-shipment-org";

interface CliArgs {
  workspaceId: string;
  since: string | null;
}

function parseArgs(): CliArgs {
  const out: { workspaceId: string | null; since: string | null } = {
    workspaceId: null,
    since: null,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--workspace-id" && process.argv[i + 1]) out.workspaceId = process.argv[++i];
    else if (arg === "--since" && process.argv[i + 1]) out.since = process.argv[++i];
    else {
      throw new Error(
        `Unknown argument ${arg}. Usage: pnpm tsx scripts/shipstation-manual-backfill.ts --workspace-id <uuid> [--since <ISO>]`,
      );
    }
  }
  if (!out.workspaceId) throw new Error("--workspace-id is required");
  return { workspaceId: out.workspaceId, since: out.since };
}

async function resolveSince(
  s: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  override: string | null,
): Promise<string> {
  if (override) return new Date(override).toISOString();
  const { data: syncState } = await s
    .from("warehouse_sync_state")
    .select("last_sync_cursor")
    .eq("workspace_id", workspaceId)
    .eq("sync_type", "shipstation_orders_poll")
    .maybeSingle();
  if (syncState?.last_sync_cursor) return new Date(syncState.last_sync_cursor).toISOString();
  // No cursor → 7 days ago
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function upsertOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  ssOrder: ShipStationOrder,
): Promise<"upserted" | "unmatched" | "skipped"> {
  const storeId = ssOrder.advancedOptions?.storeId ?? ssOrder.storeId ?? null;
  const itemSkus = (ssOrder.items ?? [])
    .map((i) => i.sku)
    .filter((s): s is string => !!s && s !== "UNKNOWN");
  const orgMatch = await matchShipmentOrg(supabase, storeId, itemSkus);
  const orgId = orgMatch?.orgId ?? null;
  const tagIds = (ssOrder.tagIds ?? []).filter((n): n is number => typeof n === "number");
  const holdUntilDate = ssOrder.holdUntilDate ? ssOrder.holdUntilDate.slice(0, 10) : null;
  const shipByDate = ssOrder.shipByDate ? ssOrder.shipByDate.slice(0, 10) : null;
  const deliverByDate = ssOrder.advancedOptions?.deliveryDate
    ? ssOrder.advancedOptions.deliveryDate.slice(0, 10)
    : null;
  const allocationStatus = ssOrder.advancedOptions?.allocationStatus ?? null;

  const { data: upserted, error } = await supabase
    .from("shipstation_orders")
    .upsert(
      {
        workspace_id: workspaceId,
        org_id: orgId,
        shipstation_order_id: ssOrder.orderId,
        order_number: ssOrder.orderNumber,
        order_status: ssOrder.orderStatus,
        order_date: ssOrder.orderDate ?? null,
        customer_email: ssOrder.customerEmail ?? null,
        customer_name: ssOrder.customerUsername ?? null,
        ship_to: ssOrder.shipTo ?? null,
        store_id: storeId,
        amount_paid: ssOrder.amountPaid ?? null,
        shipping_paid: ssOrder.shippingAmount ?? null,
        last_modified: ssOrder.modifyDate ?? null,
        synced_at: new Date().toISOString(),
        advanced_options: ssOrder.advancedOptions ?? {},
        tag_ids: tagIds,
        hold_until_date: holdUntilDate,
        ship_by_date: shipByDate,
        deliver_by_date: deliverByDate,
        payment_date: ssOrder.paymentDate ?? null,
        assignee_user_id: ssOrder.userId ?? null,
        allocation_status: allocationStatus,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,shipstation_order_id" },
    )
    .select("id")
    .single();

  if (error || !upserted) {
    console.log(`  UPSERT FAIL order_${ssOrder.orderId} #${ssOrder.orderNumber}: ${error?.message}`);
    return "skipped";
  }

  await supabase
    .from("shipstation_order_items")
    .delete()
    .eq("shipstation_order_id", upserted.id);
  if (ssOrder.items?.length) {
    const itemRows = ssOrder.items.map((it, idx) => ({
      workspace_id: workspaceId,
      shipstation_order_id: upserted.id,
      sku: it.sku ?? null,
      name: it.name ?? null,
      quantity: it.quantity,
      unit_price: it.unitPrice ?? null,
      item_index: idx,
    }));
    const { error: itemsErr } = await supabase
      .from("shipstation_order_items")
      .insert(itemRows);
    if (itemsErr)
      console.log(`  ITEMS FAIL ${ssOrder.orderId}: ${itemsErr.message}`);
  }
  return orgId == null ? "unmatched" : "upserted";
}

async function main() {
  const args = parseArgs();
  const supabase = createServiceRoleClient();
  const since = await resolveSince(supabase, args.workspaceId, args.since);
  console.log(
    `Backfilling ShipStation orders for workspace ${args.workspaceId} modified since ${since}\n`,
  );

  let page = 1;
  let upserted = 0;
  let unmatched = 0;
  let skipped = 0;
  let totalProcessed = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await fetchOrders({
      modifyDateStart: since,
      page,
      pageSize: 250,
      sortBy: "ModifyDate",
      sortDir: "ASC",
    } as Parameters<typeof fetchOrders>[0]);

    if (page === 1) console.log(`Total pages to process: ${result.pages}\n`);
    console.log(`Page ${page}/${result.pages} (${result.orders.length} orders)`);

    for (const o of result.orders) {
      const r = await upsertOrder(supabase, args.workspaceId, o);
      if (r === "upserted") upserted++;
      else if (r === "unmatched") unmatched++;
      else skipped++;
      totalProcessed++;
    }
    if (page % 5 === 0)
      console.log(
        `  >> Running totals: upserted=${upserted} unmatched=${unmatched} skipped=${skipped}`,
      );

    hasMore = page < result.pages;
    page++;
  }

  console.log(`\n=== BACKFILL COMPLETE ===`);
  console.log(`Total orders processed: ${totalProcessed}`);
  console.log(`Upserted (with org_id): ${upserted}`);
  console.log(`Unmatched (org_id NULL): ${unmatched}`);
  console.log(`Skipped (errors):       ${skipped}`);

  const now = new Date().toISOString();
  await supabase
    .from("warehouse_sync_state")
    .update({
      last_sync_cursor: now,
      last_sync_wall_clock: now,
      metadata: {
        last_poll_upserted: upserted,
        last_poll_unmatched: unmatched,
        backlog_remaining: false,
        manual_backfill_at: now,
      },
      updated_at: now,
    })
    .eq("workspace_id", args.workspaceId)
    .eq("sync_type", "shipstation_orders_poll");
  console.log(`Cursor advanced to ${now}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
