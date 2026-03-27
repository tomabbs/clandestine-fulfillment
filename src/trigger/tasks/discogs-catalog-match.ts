/**
 * Match warehouse products to Discogs releases.
 *
 * Auto-matches by barcode, then catalogue number, then title+artist.
 * Staff confirms matches via /admin/discogs/matching UI.
 * Confirmed matches are used by discogs-initial-listing to create listings.
 *
 * Uses discogs_credentials (Clandestine master account).
 *
 * Rule #7: Uses createServiceRoleClient().
 * maxDuration: 300 — rate limit backoffs require extra time.
 */

import { task } from "@trigger.dev/sdk";
import type { DiscogsAuthConfig } from "@/lib/clients/discogs-client";
import { searchReleases } from "@/lib/clients/discogs-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const discogsCatalogMatchTask = task({
  id: "discogs-catalog-match",
  maxDuration: 300,
  run: async (payload: { workspaceId?: string; variantId?: string }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = payload.workspaceId
      ? [payload.workspaceId]
      : await getAllWorkspaceIds(supabase);

    let matched = 0;
    let unmatched = 0;

    for (const workspaceId of workspaceIds) {
      const { data: credentials } = await supabase
        .from("discogs_credentials")
        .select("access_token")
        .eq("workspace_id", workspaceId)
        .single();

      if (!credentials?.access_token) continue;

      const config: DiscogsAuthConfig = { accessToken: credentials.access_token };

      // Find variants without a Discogs mapping
      let variantsQuery = supabase
        .from("warehouse_product_variants")
        .select(`id, sku, barcode, warehouse_products!inner(id, title, vendor, org_id)`)
        .eq("workspace_id", workspaceId)
        .not(
          "id",
          "in",
          `(select variant_id from discogs_product_mappings where workspace_id = '${workspaceId}')`,
        )
        .limit(50);

      if (payload.variantId) {
        variantsQuery = variantsQuery.eq("id", payload.variantId);
      }

      const { data: variants } = await variantsQuery;
      if (!variants?.length) continue;

      for (const variant of variants) {
        const product = variant.warehouse_products as unknown as {
          id: string;
          title: string;
          vendor: string | null;
          org_id: string;
        };

        let releases: Awaited<ReturnType<typeof searchReleases>> = [];
        let matchMethod: "barcode" | "catno" | "title" = "title";
        let matchConfidence = 0;

        try {
          // Try barcode first (highest confidence)
          if (variant.barcode) {
            releases = await searchReleases(config, { barcode: variant.barcode, perPage: 5 });
            if (releases.length > 0) {
              matchMethod = "barcode";
              matchConfidence = 0.95;
            }
          }

          // Try title + artist (lowest confidence, needs staff review)
          if (releases.length === 0 && product.title) {
            releases = await searchReleases(config, {
              title: product.title,
              artist: product.vendor ?? undefined,
              format: "Vinyl",
              perPage: 5,
            });
            if (releases.length > 0) {
              matchMethod = "title";
              matchConfidence = 0.5;
            }
          }

          if (releases.length > 0) {
            const topRelease = releases[0]!;

            await supabase.from("discogs_product_mappings").upsert(
              {
                workspace_id: workspaceId,
                product_id: product.id,
                variant_id: variant.id,
                discogs_release_id: topRelease.id,
                discogs_master_id: topRelease.master_id ?? null,
                discogs_release_url: topRelease.resource_url,
                match_method: matchMethod,
                match_confidence: matchConfidence,
                matched_at: new Date().toISOString(),
                is_active: matchMethod === "barcode", // Auto-activate only barcode matches
                updated_at: new Date().toISOString(),
              },
              { onConflict: "workspace_id,variant_id" },
            );

            matched++;
          } else {
            unmatched++;
          }
        } catch (err) {
          console.error(`[discogs-catalog-match] Failed for variant ${variant.id}:`, err);
          unmatched++;
        }
      }
    }

    return { matched, unmatched };
  },
});
