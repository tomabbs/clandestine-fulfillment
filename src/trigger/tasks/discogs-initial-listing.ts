/**
 * Create initial Discogs listings for newly-confirmed product mappings.
 *
 * Buffer strategy:
 *   qty ≤ 1  → 0 listings (hold back stock)
 *   qty = 2  → 1 listing
 *   qty ≥ 3  → 2 listings
 *
 * Only runs for mappings that have no active listings yet.
 * For ongoing quantity management, use discogs-listing-replenish.
 *
 * Rule #7: Uses createServiceRoleClient().
 * maxDuration: 300 — rate limit backoffs require extra time.
 */

import { task } from "@trigger.dev/sdk";
import type { DiscogsAuthConfig } from "@/lib/clients/discogs-client";
import { createListing } from "@/lib/clients/discogs-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

function getTargetListingCount(warehouseQty: number): number {
  if (warehouseQty <= 1) return 0;
  if (warehouseQty === 2) return 1;
  return 2; // qty >= 3
}

export const discogsInitialListingTask = task({
  id: "discogs-initial-listing",
  maxDuration: 300,
  run: async (payload: { workspaceId?: string }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = payload.workspaceId
      ? [payload.workspaceId]
      : await getAllWorkspaceIds(supabase);

    let listingsCreated = 0;
    let skipped = 0;

    for (const workspaceId of workspaceIds) {
      const { data: credentials } = await supabase
        .from("discogs_credentials")
        .select(
          "access_token, username, default_condition, default_sleeve_condition, default_allow_offers",
        )
        .eq("workspace_id", workspaceId)
        .single();

      if (!credentials?.access_token || !credentials.username) continue;

      const config: DiscogsAuthConfig = { accessToken: credentials.access_token };

      // Find active mappings with no listings
      const { data: mappings } = await supabase
        .from("discogs_product_mappings")
        .select(`
          id, variant_id, discogs_release_id, condition, sleeve_condition,
          listing_price, allow_offers, listing_comments, target_listing_count
        `)
        .eq("workspace_id", workspaceId)
        .eq("is_active", true)
        .not(
          "id",
          "in",
          `(select mapping_id from discogs_listings where workspace_id = '${workspaceId}' and status = 'For Sale')`,
        )
        .limit(20);

      if (!mappings?.length) continue;

      for (const mapping of mappings) {
        try {
          // Get current inventory
          const { data: inventory } = await supabase
            .from("warehouse_inventory_levels")
            .select("available")
            .eq("workspace_id", workspaceId)
            .eq("variant_id", mapping.variant_id)
            .single();

          const qty = inventory?.available ?? 0;
          const targetCount = getTargetListingCount(qty);

          if (targetCount === 0) {
            skipped++;
            continue;
          }

          // Create the target number of listings
          for (let i = 0; i < targetCount; i++) {
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

            listingsCreated++;
          }
        } catch (err) {
          console.error(
            `[discogs-initial-listing] Failed for mapping ${mapping.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    return { listingsCreated, skipped };
  },
});
