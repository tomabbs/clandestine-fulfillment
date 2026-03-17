/**
 * Monthly billing — cron 1st of month at 2 AM EST.
 *
 * Rule #22: Billing math in TS (billing-calculator.ts), row locking in Postgres (persist_billing_snapshot RPC).
 * Rule #29: Billing snapshot immutability — once created, monetary totals never change.
 * Rule #34: Adjustments go to warehouse_billing_adjustments only.
 * Rule #7: Uses createServiceRoleClient().
 *
 * On any org failure: log error, create review queue item, continue to next org.
 */

import { schedules } from "@trigger.dev/sdk";
import { calculateBillingForOrg } from "@/lib/clients/billing-calculator";
import { createInvoice } from "@/lib/clients/stripe-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"; // TODO: multi-workspace

export interface MonthlyBillingResult {
  orgsProcessed: number;
  orgsFailed: number;
  totalRevenue: number;
}

export function getPreviousMonthPeriod(now: Date) {
  const currentMonth = now.getUTCMonth(); // 0-indexed
  const currentYear = now.getUTCFullYear();
  const year = currentMonth === 0 ? currentYear - 1 : currentYear;
  const month = currentMonth === 0 ? 12 : currentMonth; // 1-indexed previous month
  const label = `${year}-${String(month).padStart(2, "0")}`;
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { label, start, end };
}

export const monthlyBillingTask = schedules.task({
  id: "monthly-billing",
  cron: {
    pattern: "0 2 1 * *",
    timezone: "America/New_York",
  },
  maxDuration: 600,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const period = getPreviousMonthPeriod(new Date());
    const startedAt = new Date().toISOString();

    let orgsProcessed = 0;
    let orgsFailed = 0;
    let totalRevenue = 0;

    // Get all orgs in workspace
    const { data: orgs } = await supabase
      .from("organizations")
      .select("id, name, billing_email")
      .eq("workspace_id", WORKSPACE_ID);

    if (!orgs || orgs.length === 0) {
      return { orgsProcessed: 0, orgsFailed: 0, totalRevenue: 0 };
    }

    for (const org of orgs) {
      try {
        // Calculate billing snapshot
        const snapshot = await calculateBillingForOrg(supabase, WORKSPACE_ID, org.id, period);

        // Persist via RPC (Rule #22)
        const { data: snapshotId, error: rpcError } = await supabase.rpc(
          "persist_billing_snapshot",
          {
            p_workspace_id: WORKSPACE_ID,
            p_org_id: org.id,
            p_billing_period: period.label,
            p_snapshot_data: snapshot,
            p_grand_total: snapshot.totals.grand_total,
            p_total_shipping: snapshot.totals.total_shipping,
            p_total_pick_pack: snapshot.totals.total_pick_pack,
            p_total_materials: snapshot.totals.total_materials,
            p_total_storage: snapshot.totals.total_storage,
            p_total_adjustments: snapshot.totals.total_adjustments,
          },
        );

        if (rpcError) {
          throw new Error(`persist_billing_snapshot RPC failed: ${rpcError.message}`);
        }

        // Mark included shipments as billed
        const includedIds = snapshot.included_shipments.map((s) => s.shipment_id);
        if (includedIds.length > 0) {
          await supabase
            .from("warehouse_shipments")
            .update({ billed: true, updated_at: new Date().toISOString() })
            .in("id", includedIds);
        }

        // Create Stripe invoice if org has billing_email (proxy for Stripe customer)
        if (org.billing_email && snapshot.totals.grand_total > 0) {
          try {
            const stripeItems = buildStripeLineItems(snapshot);
            const invoice = await createInvoice(
              org.billing_email, // In production, this would be a Stripe customer ID
              stripeItems,
              {
                org_id: org.id,
                billing_period: period.label,
                snapshot_id: String(snapshotId),
              },
            );

            // Update snapshot with Stripe invoice ID
            await supabase
              .from("warehouse_billing_snapshots")
              .update({ stripe_invoice_id: invoice.id })
              .eq("id", snapshotId);
          } catch (stripeError) {
            // Stripe failure shouldn't block the billing snapshot
            console.error(
              `[monthly-billing] Stripe invoice failed for org ${org.id}:`,
              stripeError instanceof Error ? stripeError.message : stripeError,
            );
          }
        }

        totalRevenue += snapshot.totals.grand_total;
        orgsProcessed++;
      } catch (error) {
        orgsFailed++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[monthly-billing] Failed for org ${org.id}: ${errorMsg}`);

        await supabase.from("warehouse_review_queue").insert({
          workspace_id: WORKSPACE_ID,
          org_id: org.id,
          category: "billing",
          severity: "high",
          title: `Monthly billing failed: ${org.name}`,
          description: `Billing for period ${period.label} failed. Error: ${errorMsg}`,
          metadata: {
            org_id: org.id,
            billing_period: period.label,
            error: errorMsg,
            run_id: ctx.run.id,
          },
          group_key: `billing_failed:${org.id}:${period.label}`,
          status: "open",
        });
      }
    }

    await supabase.from("channel_sync_log").insert({
      workspace_id: WORKSPACE_ID,
      channel: "billing",
      sync_type: "monthly_billing",
      status: orgsFailed > 0 ? "partial" : "completed",
      items_processed: orgsProcessed,
      items_failed: orgsFailed,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });

    return { orgsProcessed, orgsFailed, totalRevenue };
  },
});

function buildStripeLineItems(
  snapshot: Awaited<ReturnType<typeof calculateBillingForOrg>>,
): Array<{ description: string; amount: number }> {
  const items: Array<{ description: string; amount: number }> = [];

  if (snapshot.totals.total_shipping > 0) {
    items.push({
      description: `Shipping — ${snapshot.included_shipments.length} shipments`,
      amount: Math.round(snapshot.totals.total_shipping * 100),
    });
  }
  if (snapshot.totals.total_pick_pack > 0) {
    items.push({
      description: "Pick & Pack",
      amount: Math.round(snapshot.totals.total_pick_pack * 100),
    });
  }
  if (snapshot.totals.total_materials > 0) {
    items.push({
      description: "Materials",
      amount: Math.round(snapshot.totals.total_materials * 100),
    });
  }
  if (snapshot.totals.total_storage > 0) {
    items.push({
      description: `Storage — ${snapshot.storage_line_items.length} SKUs`,
      amount: Math.round(snapshot.totals.total_storage * 100),
    });
  }
  if (snapshot.totals.total_adjustments !== 0) {
    items.push({
      description: "Adjustments",
      amount: Math.round(snapshot.totals.total_adjustments * 100),
    });
  }

  return items;
}
