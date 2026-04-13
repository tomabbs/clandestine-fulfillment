/**
 * Cross-reference album URLs from sales data to physical merch mappings.
 *
 * Physical merch items have album_title + subdomain from the Merch API.
 * Sales data has item_url (the album page URL) from album, package, and track sales.
 * This function matches them: subdomain + album_title → album page URL.
 *
 * Matches ALL sale types (album, package, track) — package sales alone account
 * for ~34k records and share the same album URL as digital album sales.
 * Including them raises the match rate from ~18% to ~97% for in-stock items.
 *
 * Also re-matches mappings with dead/constructed URLs so sales-backed URLs
 * replace bad constructed ones.
 *
 * Called from: bandcamp-sales-backfill, bandcamp-sales-sync, bandcamp-sync.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function crossReferenceAlbumUrls(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  // Get mappings that need a URL:
  // 1. No URL at all
  // 2. Dead constructed URLs (replace with sales-backed URL)
  const { data: noUrlMappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, bandcamp_album_title, bandcamp_subdomain")
    .eq("workspace_id", workspaceId)
    .not("bandcamp_album_title", "is", null)
    .not("bandcamp_subdomain", "is", null)
    .is("bandcamp_url", null);

  const { data: deadConstructed } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, bandcamp_album_title, bandcamp_subdomain")
    .eq("workspace_id", workspaceId)
    .eq("bandcamp_url_source", "constructed")
    .in("scrape_status", ["dead", "probation"])
    .not("bandcamp_album_title", "is", null)
    .not("bandcamp_subdomain", "is", null);

  const mappings = [...(noUrlMappings ?? []), ...(deadConstructed ?? [])];
  if (!mappings.length) return 0;

  // Build URL lookup from ALL sale types (album + package + track).
  // Paginate to avoid the 1000-row cap.
  const urlLookup = new Map<string, string>();
  let salesOffset = 0;
  while (true) {
    const { data: salesPage } = await supabase
      .from("bandcamp_sales")
      .select("item_url, item_name")
      .eq("workspace_id", workspaceId)
      .not("item_url", "is", null)
      .range(salesOffset, salesOffset + 999);
    if (!salesPage?.length) break;
    for (const sale of salesPage) {
      const match = sale.item_url.match(/https?:\/\/([^.]+)\.bandcamp\.com/);
      if (!match) continue;
      const key = `${match[1].toLowerCase()}|${sale.item_name?.toLowerCase().trim() ?? ""}`;
      if (!urlLookup.has(key)) urlLookup.set(key, sale.item_url);
    }
    if (salesPage.length < 1000) break;
    salesOffset += 1000;
  }

  if (!urlLookup.size) return 0;

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
          bandcamp_url_source: "sales_crossref",
          scrape_status: "active",
          consecutive_failures: 0,
          last_failure_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", m.id);
      if (!error) updated++;
    }
  }

  return updated;
}
