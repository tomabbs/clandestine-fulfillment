/**
 * Shared per-connection sale-poll runner used by:
 *   - `bandcamp-sale-poll`              (cron every 5 min, iterates ALL connections)
 *   - `bandcamp-sale-poll-per-connection` (event-driven, ONE connection,
 *      fired by the resend-inbound router after a "Bam!"/"Cha-ching!"
 *      email is matched to a specific `inbound_forwarding_address`).
 *
 * Centralizing the body keeps the two task entry points in lock-step:
 *   * Same idempotency contract (`bandcamp-sale:{band_id}:{package_id}:{newSold}`)
 *   * Same post-sale fanout (bandcamp-inventory-push, multi-store-inventory-push,
 *     bundle fanout via triggerBundleFanout)
 *   * Same v2 echo-skip rationale (Rule #65 — see comment block in `pollOne`)
 *   * Same channel_sync_log row shape
 *
 * Rule #9: Callers MUST pin themselves to `bandcampQueue` so the shared
 * concurrencyLimit:1 holds across the cron and event-driven paths.
 * Rule #20: Inventory deltas go through `recordInventoryChange()`.
 * Rule #7: Service-role Supabase client only.
 */

import { tasks } from "@trigger.dev/sdk";
import { getMerchDetails, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { triggerBundleFanout } from "@/lib/server/bundles";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import type { createServiceRoleClient } from "@/lib/server/supabase-server";

type SupabaseServiceClient = ReturnType<typeof createServiceRoleClient>;

export interface PollOneConnectionInput {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  /** Database id of the bandcamp_connections row. */
  connectionId: string;
  /** Bandcamp band id (bigint upstream; getMerchDetails accepts number). */
  bandId: number;
  /** Refreshed OAuth access token for the workspace. */
  accessToken: string;
  /** Trigger run id — surfaced in recordInventoryChange metadata for tracing. */
  runId: string;
}

export interface PollOneConnectionResult {
  salesDetected: number;
  errors: number;
}

/**
 * Run the sale-poll loop for a single bandcamp_connections row.
 *
 * Returns a small counter pair instead of throwing — the cron caller
 * accumulates these into a per-workspace channel_sync_log row, and the
 * event-driven caller logs its own per-connection row.
 */
export async function pollOneBandcampConnection({
  supabase,
  workspaceId,
  connectionId,
  bandId,
  accessToken,
  runId,
}: PollOneConnectionInput): Promise<PollOneConnectionResult> {
  let salesDetected = 0;
  let errors = 0;

  try {
    const merchItems = await getMerchDetails(bandId, accessToken);

    for (const item of merchItems) {
      if (!item.sku || item.quantity_sold == null) continue;

      const { data: mapping } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, variant_id, last_quantity_sold")
        .eq("workspace_id", workspaceId)
        .eq("bandcamp_item_id", item.package_id)
        .single();

      if (!mapping) continue;

      const lastSold = mapping.last_quantity_sold ?? 0;
      const newSold = item.quantity_sold;

      if (newSold > lastSold) {
        const delta = -(newSold - lastSold);

        const { data: variant } = await supabase
          .from("warehouse_product_variants")
          .select("sku")
          .eq("id", mapping.variant_id)
          .single();

        if (variant) {
          const correlationId = `bandcamp-sale:${bandId}:${item.package_id}:${newSold}`;

          const result = await recordInventoryChange({
            workspaceId,
            sku: variant.sku,
            delta,
            source: "bandcamp",
            correlationId,
            metadata: {
              band_id: bandId,
              bandcamp_item_id: item.package_id,
              previous_quantity_sold: lastSold,
              new_quantity_sold: newSold,
              connection_id: connectionId,
              run_id: runId,
            },
          });

          // Trigger immediate push to all channels after a sale —
          // don't wait for the next cron cycle (push tasks are idempotent).
          //
          // ShipStation v2 is INTENTIONALLY OMITTED here (2026-04-13
          // second-pass audit). With ShipStation Inventory Sync active
          // for every connected storefront — including Bandcamp via
          // `warehouse_shipstation_stores` — SS imports the Bandcamp
          // order and decrements v2 natively before this poll fires.
          // Enqueuing `shipstation-v2-decrement` here would double
          // decrement v2, which SS would then push back to Bandcamp,
          // re-emitting the deduction (Rule #65 echo loop).
          //
          // The v2 leg is also echo-skipped inside `fanoutInventoryChange`
          // for `source === 'bandcamp'` — both layers agree. If the
          // operator ever needs the explicit decrement back (e.g. SS
          // Inventory Sync is disabled per-workspace), re-enable here
          // AND remove `'bandcamp'` from `SHIPSTATION_V2_ECHO_SOURCES`
          // in `src/lib/server/inventory-fanout.ts` together —
          // never one without the other.
          //
          // The Phase 5 reconcile sensor remains the safety net: it
          // catches v2 ↔ DB drift if SS Inventory Sync ever misses an
          // import.
          if (result.success && !result.alreadyProcessed) {
            await Promise.allSettled([
              tasks.trigger("bandcamp-inventory-push", {}),
              tasks.trigger("multi-store-inventory-push", {}),
            ]).catch(() => {
              /* non-critical — cron covers it */
            });

            await triggerBundleFanout({
              variantId: mapping.variant_id,
              soldQuantity: Math.abs(delta),
              workspaceId,
              correlationBase: correlationId,
            });
          }

          salesDetected++;
        }

        await supabase
          .from("bandcamp_product_mappings")
          .update({
            last_quantity_sold: newSold,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", mapping.id);
      }
    }

    await supabase
      .from("bandcamp_connections")
      .update({
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connectionId);
  } catch (error) {
    errors++;
    console.error(
      `[bandcamp-sale-poll-runner] Failed for band ${bandId} (connection ${connectionId}):`,
      error instanceof Error ? error.message : error,
    );
  }

  return { salesDetected, errors };
}

/**
 * Convenience wrapper: refresh the workspace's Bandcamp token, then run
 * the per-connection loop. Used by both the per-connection task and the
 * cron task (which calls it once per connection inside its workspace
 * loop).
 *
 * The token-refresh result is returned so the cron caller can re-use it
 * for the remaining connections in the same workspace without re-fetching.
 */
export async function pollOneBandcampConnectionWithFreshToken(
  input: Omit<PollOneConnectionInput, "accessToken">,
): Promise<PollOneConnectionResult & { accessToken: string }> {
  const accessToken = await refreshBandcampToken(input.workspaceId);
  const result = await pollOneBandcampConnection({ ...input, accessToken });
  return { ...result, accessToken };
}
