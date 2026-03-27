/**
 * Keep Discogs listings in sync with warehouse inventory.
 *
 * Buffer strategy:
 *   qty ≤ 1  → 0 listings (remove all)
 *   qty = 2  → 1 listing
 *   qty ≥ 3  → 2 listings
 *
 * Runs hourly to ensure listings match current stock.
 * Creates or deletes listings to reach the target count.
 *
 * Rule #7: Uses createServiceRoleClient().
 * maxDuration: 300 — rate limit backoffs require extra time.
 */

import { schedules, task } from "@trigger.dev/sdk";
import type { DiscogsAuthConfig } from "@/lib/clients/discogs-client";
import { createListing, deleteListing } from "@/lib/clients/discogs-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

function getTargetListingCount(warehouseQty: number): number {
  if (warehouseQty <= 1) return 0;
  if (warehouseQty === 2) return 1;
  return 2;
}

async function runReplenish(payload: { workspaceId?: string }): Promise<{
  created: number;
  deleted: number;
  unchanged: number;
}> {
  const supabase = createServiceRoleClient();
  const workspaceIds = payload.workspaceId
    ? [payload.workspaceId]
    : await getAllWorkspaceIds(supabase);

  let created = 0;
  let deleted = 0;
  let unchanged = 0;

  for (const workspaceId of workspaceIds) {
    const { data: credentials } = await supabase
      .from("discogs_credentials")
      .select(
        "access_token, username, default_condition, default_sleeve_condition, default_allow_offers",
      )
      .eq("workspace_id", workspaceId)
      .single();

    if (!credentials?.access_token) continue;

    const config: DiscogsAuthConfig = { accessToken: credentials.access_token };

    const { data: mappings } = await supabase
      .from("discogs_product_mappings")
      .select(
        "id, variant_id, discogs_release_id, condition, sleeve_condition, listing_price, allow_offers, listing_comments",
      )
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .limit(50);

    if (!mappings?.length) continue;

    for (const mapping of mappings) {
      try {
        const [invResult, listingsResult] = await Promise.all([
          supabase
            .from("warehouse_inventory_levels")
            .select("available")
            .eq("workspace_id", workspaceId)
            .eq("variant_id", mapping.variant_id)
            .single(),
          supabase
            .from("discogs_listings")
            .select("id, discogs_listing_id")
            .eq("mapping_id", mapping.id)
            .eq("status", "For Sale"),
        ]);

        const qty = invResult.data?.available ?? 0;
        const targetCount = getTargetListingCount(qty);
        const activeListings = listingsResult.data ?? [];
        const currentCount = activeListings.length;

        if (currentCount === targetCount) {
          unchanged++;
          continue;
        }

        if (targetCount > currentCount) {
          // Create additional listings
          const toCreate = targetCount - currentCount;
          for (let i = 0; i < toCreate; i++) {
            const { listingId } = await createListing(config, {
              releaseId: mapping.discogs_release_id,
              condition: mapping.condition ?? credentials.default_condition ?? "Mint (M)",
              sleeveCondition:
                mapping.sleeve_condition ?? credentials.default_sleeve_condition ?? "Mint (M)",
              price: mapping.listing_price ?? 0,
              status: "For Sale",
              comments: mapping.listing_comments ?? undefined,
              allowOffers: mapping.allow_offers ?? credentials.default_allow_offers ?? true,
            });

            await supabase.from("discogs_listings").insert({
              workspace_id: workspaceId,
              mapping_id: mapping.id,
              discogs_listing_id: listingId,
              status: "For Sale",
              price: mapping.listing_price ?? 0,
              condition: mapping.condition ?? credentials.default_condition,
              sleeve_condition: mapping.sleeve_condition ?? credentials.default_sleeve_condition,
            });

            created++;
          }
        } else {
          // Delete excess listings (oldest first)
          const toDelete = currentCount - targetCount;
          const listingsToDelete = activeListings.slice(0, toDelete);

          for (const listing of listingsToDelete) {
            await deleteListing(config, listing.discogs_listing_id);

            await supabase
              .from("discogs_listings")
              .update({ status: "Deleted", deleted_at: new Date().toISOString() })
              .eq("id", listing.id);

            deleted++;
          }
        }
      } catch (err) {
        console.error(
          `[discogs-listing-replenish] Failed for mapping ${mapping.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { created, deleted, unchanged };
}

export const discogsListingReplenishTask = task({
  id: "discogs-listing-replenish",
  maxDuration: 300,
  run: async (payload: { workspaceId?: string }) => runReplenish(payload),
});

export const discogsListingReplenishSchedule = schedules.task({
  id: "discogs-listing-replenish-cron",
  cron: "0 * * * *", // hourly
  maxDuration: 300,
  run: async () => runReplenish({}),
});
