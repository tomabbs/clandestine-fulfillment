/**
 * Cross-reference album URLs from digital sales to physical merch mappings.
 *
 * Physical merch items have album_title + subdomain from the Merch API.
 * Digital album sales have item_url (the album page URL) from the Sales API.
 * This function matches them: subdomain + album_title → album page URL.
 *
 * Called from: bandcamp-sales-backfill, bandcamp-sales-sync, bandcamp-sync.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function crossReferenceAlbumUrls(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  // Get mappings that have album_title + subdomain but no URL
  const { data: mappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, bandcamp_album_title, bandcamp_subdomain")
    .eq("workspace_id", workspaceId)
    .not("bandcamp_album_title", "is", null)
    .not("bandcamp_subdomain", "is", null)
    .is("bandcamp_url", null);

  if (!mappings?.length) return 0;

  // Get unique album URLs from digital sales
  const { data: albumSales } = await supabase
    .from("bandcamp_sales")
    .select("item_url, item_name")
    .eq("workspace_id", workspaceId)
    .eq("item_type", "album")
    .not("item_url", "is", null);

  if (!albumSales?.length) return 0;

  // Build lookup: "subdomain|album_title_lowercase" → URL
  const urlLookup = new Map<string, string>();
  for (const sale of albumSales) {
    const match = sale.item_url.match(/https?:\/\/([^.]+)\.bandcamp\.com/);
    if (!match) continue;
    const key = match[1].toLowerCase() + "|" + (sale.item_name?.toLowerCase().trim() ?? "");
    if (!urlLookup.has(key)) urlLookup.set(key, sale.item_url);
  }

  // Match mappings to album URLs and write
  let updated = 0;
  for (const m of mappings) {
    const key =
      (m.bandcamp_subdomain?.toLowerCase() ?? "") +
      "|" +
      (m.bandcamp_album_title?.toLowerCase().trim() ?? "");
    const url = urlLookup.get(key);
    if (url) {
      const { error } = await supabase
        .from("bandcamp_product_mappings")
        .update({
          bandcamp_url: url,
          bandcamp_url_source: "orders_api",
          updated_at: new Date().toISOString(),
        })
        .eq("id", m.id);
      if (!error) updated++;
    }
  }

  return updated;
}
