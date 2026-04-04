"use server";

import { z } from "zod/v4";
import { buildBandcampAlbumUrl } from "@/lib/clients/bandcamp-scraper";
import { fetchDigDeeper, bandcampArtUrl, type DigDeeperItem } from "@/lib/clients/bandcamp-discover";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

import type { BandcampConnection, BandcampProductMapping } from "@/lib/shared/types";
import { matchTagToTaxonomy } from "@/lib/shared/genre-taxonomy";

// Rule #48: No Server Action may call the Bandcamp API directly.
// Force Sync MUST enqueue via Trigger task through the shared bandcampQueue.

// === Zod schemas (Rule #5) ===

const createConnectionSchema = z.object({
  workspaceId: z.string().uuid(),
  orgId: z.string().uuid(),
  bandId: z.number().int().positive(),
  bandName: z.string().min(1),
  bandUrl: z.string().url().nullable().optional(),
});

const deleteConnectionSchema = z.object({
  connectionId: z.string().uuid(),
});

// === Helper ===

async function requireAuth() {
  const supabase = await createServerSupabaseClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("Unauthorized");

  // Fetch the user's record to get org_id and workspace_id
  const serviceClient = createServiceRoleClient();
  const { data: userRecord, error: userError } = await serviceClient
    .from("users")
    .select("id, org_id, workspace_id")
    .eq("auth_user_id", authData.user.id)
    .single();

  if (userError || !userRecord) {
    throw new Error("User record not found");
  }

  return { supabase, user: authData.user, userRecord };
}

// === Connection management ===

export async function createBandcampConnection(rawData: {
  workspaceId: string;
  orgId: string;
  bandId: number;
  bandName: string;
  bandUrl?: string | null;
}): Promise<BandcampConnection> {
  await requireAuth();
  const data = createConnectionSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Verify the org exists and belongs to this workspace
  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .select("id, workspace_id")
    .eq("id", data.orgId)
    .single();

  if (orgError || !org) throw new Error("Organization not found");
  if (org.workspace_id !== data.workspaceId)
    throw new Error("Organization does not belong to this workspace");

  const { data: connection, error } = await serviceClient
    .from("bandcamp_connections")
    .upsert(
      {
        workspace_id: data.workspaceId,
        org_id: data.orgId,
        band_id: data.bandId,
        band_name: data.bandName,
        band_url: data.bandUrl ?? null,
        is_active: true,
      },
      { onConflict: "workspace_id,band_id" },
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to create Bandcamp connection: ${error.message}`);

  return connection as BandcampConnection;
}

export async function deleteBandcampConnection(rawData: {
  connectionId: string;
}): Promise<{ success: true }> {
  await requireAuth();
  const data = deleteConnectionSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Soft-delete: mark inactive rather than hard delete
  const { error } = await serviceClient
    .from("bandcamp_connections")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", data.connectionId);

  if (error) throw new Error(`Failed to delete Bandcamp connection: ${error.message}`);

  return { success: true };
}

export async function getOrganizationsForWorkspace(
  workspaceId: string,
): Promise<Array<{ id: string; name: string }>> {
  try {
    await requireAuth();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) return [];
    throw error;
  }
  const serviceClient = createServiceRoleClient();

  const { data: orgs, error } = await serviceClient
    .from("organizations")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to fetch organizations: ${error.message}`);

  return (orgs ?? []) as Array<{ id: string; name: string }>;
}

export async function triggerBandcampSync(workspaceId?: string): Promise<{ taskRunId: string }> {
  const { userRecord } = await requireAuth();
  const wsId = workspaceId ?? userRecord.workspace_id;

  // Dynamic import to avoid bundling trigger SDK in client
  const { tasks } = await import("@trigger.dev/sdk");
  const handle = await tasks.trigger("bandcamp-sync", { workspaceId: wsId });

  return { taskRunId: handle.id };
}

export async function getBandcampSyncStatus() {
  let supabase: Awaited<ReturnType<typeof requireAuth>>["supabase"];
  let workspaceId = "";
  try {
    const auth = await requireAuth();
    supabase = auth.supabase;
    workspaceId = auth.userRecord.workspace_id;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) {
      return {
        lastMerchSync: null,
        lastSalePoll: null,
        lastInventoryPush: null,
        recentLogs: [],
      };
    }
    throw error;
  }

  const { data: recentLogs } = await supabase
    .from("channel_sync_log")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("channel", "bandcamp")
    .order("created_at", { ascending: false })
    .limit(20);

  const logs = recentLogs ?? [];

  // Derive last completed times per sync_type from logs
  const lastMerchSync = logs.find((l) => l.sync_type === "merch_sync" && l.status !== "started");
  const lastSalePoll = logs.find((l) => l.sync_type === "sale_poll" && l.status !== "started");
  const lastInventoryPush = logs.find(
    (l) => l.sync_type === "inventory_push" && l.status !== "started",
  );

  return {
    lastMerchSync: lastMerchSync?.completed_at ?? null,
    lastSalePoll: lastSalePoll?.completed_at ?? null,
    lastInventoryPush: lastInventoryPush?.completed_at ?? null,
    recentLogs: logs,
  };
}

export async function getBandcampAccounts(workspaceId: string): Promise<
  Array<
    BandcampConnection & {
      memberArtistCount: number;
      merchItemCount: number;
    }
  >
> {
  try {
    await requireAuth();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) return [];
    throw error;
  }
  const serviceClient = createServiceRoleClient();

  const { data: connections, error } = await serviceClient
    .from("bandcamp_connections")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch Bandcamp accounts: ${error.message}`);

  // Get mapping counts per connection's org
  const results = await Promise.all(
    (connections ?? []).map(async (conn) => {
      const cache = conn.member_bands_cache as Record<string, unknown> | null;
      const memberBands = (cache?.member_bands as unknown[]) ?? [];

      const { count } = await serviceClient
        .from("bandcamp_product_mappings")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);

      return {
        ...conn,
        memberArtistCount: memberBands.length,
        merchItemCount: count ?? 0,
      } as BandcampConnection & { memberArtistCount: number; merchItemCount: number };
    }),
  );

  return results;
}

export async function getBandcampMappings(
  orgId: string,
): Promise<Array<BandcampProductMapping & { variant_sku: string; variant_title: string | null }>> {
  try {
    await requireAuth();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) return [];
    throw error;
  }
  const serviceClient = createServiceRoleClient();

  const { data: mappings, error } = await serviceClient
    .from("bandcamp_product_mappings")
    .select("*, warehouse_product_variants(sku, title)")
    .eq("workspace_id", orgId);

  if (error) throw new Error(`Failed to fetch Bandcamp mappings: ${error.message}`);

  return (mappings ?? []).map((m) => {
    const variant = m.warehouse_product_variants as unknown as {
      sku: string;
      title: string | null;
    } | null;
    return {
      ...m,
      variant_sku: variant?.sku ?? "",
      variant_title: variant?.title ?? null,
      warehouse_product_variants: undefined,
    } as BandcampProductMapping & { variant_sku: string; variant_title: string | null };
  });
}

/**
 * Immediately queue scrape tasks for ALL pending items in one Bandcamp connection.
 *
 * Use after adding a new client connection (50-150 titles).
 * Without this: new clients wait for cron cycles (~90 min for 150 items).
 * With this: all items queued immediately, ~5 min to complete.
 *
 * Rule #48: No direct Bandcamp API calls — enqueues via Trigger task.
 */
export async function triggerBandcampConnectionBackfill(connectionId: string) {
  // RBAC: verify user belongs to same workspace as the connection
  const { userRecord } = await requireAuth();
  if (!userRecord) throw new Error("User record not found");
  const serviceClient = createServiceRoleClient();

  const { data: conn } = await serviceClient
    .from("bandcamp_connections")
    .select("band_id, band_url, workspace_id, member_bands_cache")
    .eq("id", connectionId)
    .single();
  if (!conn) throw new Error("Connection not found");

  if (conn.workspace_id !== userRecord.workspace_id) {
    throw new Error("Unauthorized: connection belongs to a different workspace");
  }

  const directSubdomain = (conn.band_url ?? "").replace("https://", "").split(".")[0];

  // Build member_band_id → subdomain lookup
  interface MemberBandEntry {
    band_id: number;
  }
  const memberBandSubdomain = new Map<number, string>();
  memberBandSubdomain.set(conn.band_id as number, directSubdomain);

  let memberBandsArr: MemberBandEntry[] = [];
  try {
    const raw = conn.member_bands_cache;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed?.member_bands))
      memberBandsArr = parsed.member_bands as MemberBandEntry[];
    else if (Array.isArray(parsed)) memberBandsArr = parsed as MemberBandEntry[];
  } catch {
    /* ignore parse errors — proceed with direct band only */
  }

  for (const mb of memberBandsArr) {
    if (typeof mb?.band_id === "number") memberBandSubdomain.set(mb.band_id, directSubdomain);
  }

  // Find all pending mappings for this connection's bands
  const memberBandIds = Array.from(memberBandSubdomain.keys());
  const { data: pending } = await serviceClient
    .from("bandcamp_product_mappings")
    .select("id, bandcamp_url, variant_id, bandcamp_member_band_id")
    .eq("workspace_id", conn.workspace_id)
    .in("bandcamp_member_band_id", memberBandIds)
    .or("bandcamp_type_name.is.null,bandcamp_about.is.null");

  if (!pending?.length) return { triggered: 0, connectionId };

  // Resolve product titles for URL construction (Group 2 items without URL)
  const noUrlIds = (pending ?? []).filter((m) => !m.bandcamp_url).map((m) => m.variant_id);
  const { data: variants } =
    noUrlIds.length > 0
      ? await serviceClient
          .from("warehouse_product_variants")
          .select("id, warehouse_products!inner(title)")
          .in("id", noUrlIds)
      : { data: [] };

  const titleByVariant = new Map(
    (variants ?? []).map((v) => [
      v.id,
      (v.warehouse_products as unknown as { title: string }).title,
    ]),
  );

  // Import Trigger task (lazy to avoid circular in server actions)
  const { bandcampScrapePageTask } = await import("@/trigger/tasks/bandcamp-sync");

  let triggered = 0;
  for (const m of pending ?? []) {
    let scrapeUrl = m.bandcamp_url as string | null;

    if (!scrapeUrl) {
      const memberBandId = m.bandcamp_member_band_id as number | null;
      const subdomain = memberBandId
        ? (memberBandSubdomain.get(memberBandId) ?? directSubdomain)
        : directSubdomain;
      if (!subdomain) continue;

      const rawTitle = titleByVariant.get(m.variant_id) ?? "";
      const withoutArtist = rawTitle.includes(" - ")
        ? rawTitle.split(" - ").slice(1).join(" - ")
        : rawTitle;
      const albumTitle = withoutArtist
        .replace(
          /\s+(\d*x?LP|CD|Cassette|Tape|7"|10"|12"|Box Set|Vinyl|Picture Disc|Flexi|SACD|DVD|Blu-ray|Limited Edition|Standard Edition|Deluxe Edition)[^a-zA-Z0-9]*$/i,
          "",
        )
        .trim();

      scrapeUrl = buildBandcampAlbumUrl(subdomain, albumTitle);
      if (!scrapeUrl) continue;

      // Idempotency guard: only write URL if not already set
      const { data: urlWritten } = await serviceClient
        .from("bandcamp_product_mappings")
        .update({
          bandcamp_url: scrapeUrl,
          bandcamp_url_source: "constructed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", m.id)
        .is("bandcamp_url", null)
        .select("id")
        .single();

      if (!urlWritten) continue;
    }

    await bandcampScrapePageTask.trigger({
      url: scrapeUrl,
      mappingId: m.id,
      workspaceId: conn.workspace_id,
      urlIsConstructed: !m.bandcamp_url,
      urlSource: m.bandcamp_url ? "orders_api" : "constructed",
    });
    triggered++;
  }

  // Log progress to channel_sync_log for admin visibility
  await serviceClient.from("channel_sync_log").insert({
    workspace_id: conn.workspace_id,
    channel: "bandcamp",
    sync_type: "connection_backfill",
    status: triggered > 0 ? "completed" : "skipped",
    items_processed: triggered,
    items_failed: 0,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  });

  return { triggered, connectionId };
}

// === Bandcamp Health dashboard (API + scraper + sales) ===

export async function getBandcampScraperHealth(workspaceId: string) {
  const supabase = createServiceRoleClient();

  // ── All mapping data for coverage calculations ──
  const { data: mappings } = await supabase
    .from("bandcamp_product_mappings")
    .select(
      "id, bandcamp_url, bandcamp_url_source, bandcamp_subdomain, bandcamp_album_title, bandcamp_price, bandcamp_art_url, bandcamp_about, bandcamp_credits, bandcamp_tracks, bandcamp_options, bandcamp_origin_quantities, bandcamp_catalog_number, bandcamp_upc, raw_api_data, bandcamp_image_url, bandcamp_new_date",
    )
    .eq("workspace_id", workspaceId);

  const t = mappings?.length ?? 0;

  // API data coverage
  const apiCoverage = {
    subdomain: mappings?.filter((m) => m.bandcamp_subdomain).length ?? 0,
    albumTitle: mappings?.filter((m) => m.bandcamp_album_title).length ?? 0,
    price: mappings?.filter((m) => m.bandcamp_price != null).length ?? 0,
    releaseDate: mappings?.filter((m) => m.bandcamp_new_date).length ?? 0,
    image: mappings?.filter((m) => m.bandcamp_image_url).length ?? 0,
    originQuantities: mappings?.filter((m) => m.bandcamp_origin_quantities).length ?? 0,
    rawApiData: mappings?.filter((m) => m.raw_api_data).length ?? 0,
    options: mappings?.filter((m) => m.bandcamp_options).length ?? 0,
  };

  // Scraper coverage
  const scraperCoverage = {
    artUrl: mappings?.filter((m) => m.bandcamp_art_url).length ?? 0,
    about: mappings?.filter((m) => m.bandcamp_about && m.bandcamp_about !== "").length ?? 0,
    credits: mappings?.filter((m) => m.bandcamp_credits && m.bandcamp_credits !== "").length ?? 0,
    tracks: mappings?.filter((m) => m.bandcamp_tracks).length ?? 0,
  };

  // Sales data coverage
  const salesCoverage = {
    catalogNumber: mappings?.filter((m) => m.bandcamp_catalog_number).length ?? 0,
    upc: mappings?.filter((m) => m.bandcamp_upc).length ?? 0,
  };

  // URL breakdown by source
  const urlSources = { scraper_verified: 0, constructed: 0, orders_api: 0, none: 0 };
  for (const m of mappings ?? []) {
    if (!m.bandcamp_url) urlSources.none++;
    else if (m.bandcamp_url_source === "scraper_verified") urlSources.scraper_verified++;
    else if (m.bandcamp_url_source === "constructed") urlSources.constructed++;
    else if (m.bandcamp_url_source === "orders_api") urlSources.orders_api++;
    else urlSources.orders_api++;
  }
  const totalWithUrl = t - urlSources.none;

  // ── Sync pipeline: latest per sync_type ──
  const { data: allLogs } = await supabase
    .from("channel_sync_log")
    .select("sync_type, status, items_processed, items_failed, created_at, metadata")
    .eq("workspace_id", workspaceId)
    .eq("channel", "bandcamp")
    .order("created_at", { ascending: false })
    .limit(100);

  const syncPipeline: Array<{
    syncType: string;
    status: string;
    itemsProcessed: number;
    itemsFailed: number;
    createdAt: string;
    metadata: unknown;
  }> = [];
  const seenTypes = new Set<string>();
  for (const l of allLogs ?? []) {
    if (l.sync_type === "scrape_page") continue;
    if (!seenTypes.has(l.sync_type)) {
      seenTypes.add(l.sync_type);
      syncPipeline.push({
        syncType: l.sync_type,
        status: l.status,
        itemsProcessed: l.items_processed,
        itemsFailed: l.items_failed,
        createdAt: l.created_at,
        metadata: l.metadata,
      });
    }
  }

  // Scrape page stats (last hour aggregate)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentScrapes = (allLogs ?? []).filter(
    (l) => l.sync_type === "scrape_page" && l.created_at >= oneHourAgo,
  );
  const scrapeStats = {
    total: recentScrapes.length,
    success: recentScrapes.filter((l) => l.status === "completed").length,
    failed: recentScrapes.filter((l) => l.status === "failed").length,
    blocked: recentScrapes.filter((l) => {
      const hs = (l.metadata as Record<string, unknown>)?.httpStatus;
      return hs === 403 || hs === 429;
    }).length,
  };

  // ── Pre-orders ──
  const { data: preorders } = await supabase
    .from("warehouse_product_variants")
    .select("id, sku, street_date, warehouse_products!inner(id, title)")
    .eq("workspace_id", workspaceId)
    .eq("is_preorder", true)
    .order("street_date", { ascending: true });

  const preorderList = (preorders ?? []).map((p) => ({
    variantId: p.id,
    productId: (p.warehouse_products as unknown as { id: string }).id,
    title: (p.warehouse_products as unknown as { title: string }).title,
    sku: p.sku,
    streetDate: p.street_date,
  }));

  // ── Sales backfill progress ──
  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("id, band_name")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  const { data: backfillStates } = await supabase
    .from("bandcamp_sales_backfill_state")
    .select("connection_id, status, total_transactions, last_processed_date, last_error");

  const stateMap = new Map((backfillStates ?? []).map((s) => [s.connection_id, s]));
  const backfillProgress = (connections ?? []).map((c) => {
    const s = stateMap.get(c.id);
    return {
      connectionId: c.id,
      bandName: c.band_name,
      status: s?.status ?? "pending",
      totalTransactions: s?.total_transactions ?? 0,
      lastProcessedDate: s?.last_processed_date ?? null,
      lastError: s?.last_error ?? null,
    };
  });

  // Sales totals
  const { count: totalSales } = await supabase
    .from("bandcamp_sales")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);

  const { data: buyerEmails } = await supabase
    .from("bandcamp_sales")
    .select("buyer_email")
    .eq("workspace_id", workspaceId)
    .not("buyer_email", "is", null);
  const uniqueBuyers = new Set((buyerEmails ?? []).map((e) => e.buyer_email)).size;

  // ── Sensor readings ──
  const { data: sensorReadings } = await supabase
    .from("sensor_readings")
    .select("sensor_name, status, value, message, created_at")
    .eq("workspace_id", workspaceId)
    .in("sensor_name", [
      "sync.bandcamp_stale",
      "bandcamp.merch_sync_log_stale",
      "bandcamp.scraper_review_open",
      "bandcamp.scrape_block_rate",
    ])
    .order("created_at", { ascending: false })
    .limit(10);

  // ── Open issues ──
  const { data: reviewItems, count: reviewCount } = await supabase
    .from("warehouse_review_queue")
    .select("id, title, severity, group_key, metadata, created_at", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("category", "bandcamp_scraper")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(25);

  return {
    total: t,
    apiCoverage,
    scraperCoverage,
    salesCoverage,
    urlSources,
    totalWithUrl,
    syncPipeline,
    scrapeStats,
    preorders: preorderList,
    backfillProgress,
    totalSales: totalSales ?? 0,
    uniqueBuyers,
    sensorReadings: sensorReadings ?? [],
    reviewItems: reviewItems ?? [],
    reviewCount: reviewCount ?? 0,
  };
}

// === Sales history + backfill status ===

export async function getBandcampSalesOverview(workspaceId: string) {
  const supabase = createServiceRoleClient();

  // Per-connection summary
  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("id, band_name, band_url")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  const connectionStats = [];
  for (const conn of connections ?? []) {
    const { count: totalSales } = await supabase
      .from("bandcamp_sales")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", conn.id);

    let totalRevenue = 0;
    let currency = "USD";
    let revOffset = 0;
    const REV_PAGE = 1000;
    while (true) {
      const { data: revPage } = await supabase
        .from("bandcamp_sales")
        .select("net_amount, currency")
        .eq("connection_id", conn.id)
        .not("net_amount", "is", null)
        .range(revOffset, revOffset + REV_PAGE - 1);
      if (!revPage?.length) break;
      for (const r of revPage) {
        totalRevenue += Number(r.net_amount) || 0;
        if (revOffset === 0 && !currency) currency = r.currency ?? "USD";
      }
      if (revPage.length < REV_PAGE) break;
      revOffset += REV_PAGE;
    }

    const { count: refundCount } = await supabase
      .from("bandcamp_sales")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", conn.id)
      .eq("payment_state", "refunded");

    const { data: backfillState } = await supabase
      .from("bandcamp_sales_backfill_state")
      .select("status, total_transactions, last_processed_date, completed_at, last_error")
      .eq("connection_id", conn.id)
      .single();

    connectionStats.push({
      connectionId: conn.id,
      bandName: conn.band_name,
      bandUrl: conn.band_url,
      totalSales: totalSales ?? 0,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      currency,
      refundCount: refundCount ?? 0,
      backfillStatus: backfillState?.status ?? "pending",
      backfillTransactions: backfillState?.total_transactions ?? 0,
      backfillLastDate: backfillState?.last_processed_date ?? null,
      backfillCompletedAt: backfillState?.completed_at ?? null,
      backfillError: backfillState?.last_error ?? null,
    });
  }

  // Overall totals
  const { count: grandTotal } = await supabase
    .from("bandcamp_sales")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);

  // Per-item breakdown: group by item_name + artist + item_type + package
  // Paginate to fetch all rows (Supabase default limit is 1000)
  const allSales: Array<{
    item_name: string | null; artist: string | null; item_type: string | null;
    package: string | null; item_url: string | null; sku: string | null;
    catalog_number: string | null; net_amount: string | null; quantity: number | null;
    connection_id: string; currency: string | null;
  }> = [];
  let salesOffset = 0;
  const SALES_PAGE = 1000;
  while (true) {
    const { data: page } = await supabase
      .from("bandcamp_sales")
      .select(
        "item_name, artist, item_type, package, item_url, sku, catalog_number, net_amount, quantity, connection_id, currency",
      )
      .eq("workspace_id", workspaceId)
      .range(salesOffset, salesOffset + SALES_PAGE - 1);
    if (!page?.length) break;
    allSales.push(...page);
    if (page.length < SALES_PAGE) break;
    salesOffset += SALES_PAGE;
  }

  const connNameMap = new Map((connections ?? []).map((c) => [c.id, c.band_name]));

  // Load tag data from mappings (join via variant SKU)
  const { data: tagMappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("bandcamp_tags, bandcamp_tag_norms, bandcamp_primary_genre, warehouse_product_variants!inner(sku)")
    .eq("workspace_id", workspaceId)
    .not("bandcamp_tag_norms", "is", null);

  const tagBySku = new Map<string, { tags: string[]; tagNorms: string[]; primaryGenre: string | null }>();
  for (const m of tagMappings ?? []) {
    const sku = (m.warehouse_product_variants as unknown as { sku: string })?.sku;
    if (sku) {
      tagBySku.set(sku, {
        tags: (m.bandcamp_tags as string[]) ?? [],
        tagNorms: (m.bandcamp_tag_norms as string[]) ?? [],
        primaryGenre: m.bandcamp_primary_genre as string | null,
      });
    }
  }

  const itemMap = new Map<
    string,
    {
      itemName: string;
      artist: string;
      itemType: string;
      package: string | null;
      itemUrl: string | null;
      sku: string | null;
      catalogNumber: string | null;
      currency: string;
      connectionId: string;
      bandName: string;
      totalUnits: number;
      totalRevenue: number;
      saleCount: number;
      tags: string[];
      tagNorms: string[];
      bcGenre: string | null;
      dspGenre: string | null;
      subGenre: string | null;
    }
  >();

  for (const sale of allSales) {
    const key = `${sale.connection_id}|${sale.item_name}|${sale.artist}|${sale.item_type}|${sale.package ?? ""}`;
    const existing = itemMap.get(key);
    if (existing) {
      existing.totalUnits += sale.quantity ?? 0;
      existing.totalRevenue += Number(sale.net_amount) || 0;
      existing.saleCount++;
      if (!existing.itemUrl && sale.item_url) existing.itemUrl = sale.item_url;
      if (!existing.sku && sale.sku) existing.sku = sale.sku;
      if (!existing.catalogNumber && sale.catalog_number)
        existing.catalogNumber = sale.catalog_number;
    } else {
      const tagData = sale.sku ? tagBySku.get(sale.sku) : undefined;
      const taxonomy = tagData?.tagNorms.length ? matchTagToTaxonomy(tagData.tagNorms) : { bcGenre: null, dspGenre: null, subGenre: null };

      itemMap.set(key, {
        itemName: sale.item_name ?? "Unknown",
        artist: sale.artist ?? "Unknown",
        itemType: sale.item_type ?? "unknown",
        package: sale.package ?? null,
        itemUrl: sale.item_url ?? null,
        sku: sale.sku ?? null,
        catalogNumber: sale.catalog_number ?? null,
        currency: sale.currency ?? "USD",
        connectionId: sale.connection_id,
        bandName: connNameMap.get(sale.connection_id) ?? "Unknown",
        totalUnits: sale.quantity ?? 0,
        totalRevenue: Number(sale.net_amount) || 0,
        saleCount: 1,
        tags: tagData?.tags ?? [],
        tagNorms: tagData?.tagNorms ?? [],
        bcGenre: tagData?.primaryGenre ?? taxonomy.bcGenre,
        dspGenre: taxonomy.dspGenre,
        subGenre: taxonomy.subGenre,
      });
    }
  }

  const items = Array.from(itemMap.values())
    .map((i) => ({ ...i, totalRevenue: Math.round(i.totalRevenue * 100) / 100 }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);

  const untaggedCount = items.filter((i) => !i.tagNorms.length).length;

  return { connections: connectionStats, grandTotalSales: grandTotal ?? 0, items, untaggedCount };
}

export async function getBandcampFullItemData(variantId: string) {
  const supabase = createServiceRoleClient();

  const { data: mapping } = await supabase
    .from("bandcamp_product_mappings")
    .select("*")
    .eq("variant_id", variantId)
    .single();

  if (!mapping) return null;

  // Get variant SKU for sales lookup
  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("sku")
    .eq("id", variantId)
    .single();

  let salesByVariant = null;
  if (variant?.sku) {
    const { data: skuSales } = await supabase
      .from("bandcamp_sales")
      .select("sale_date, quantity, net_amount, currency, payment_state, catalog_number, upc, isrc")
      .eq("workspace_id", mapping.workspace_id)
      .eq("sku", variant.sku)
      .order("sale_date", { ascending: false })
      .limit(100);

    const totalUnits = (skuSales ?? []).reduce((s, r) => s + (r.quantity ?? 0), 0);
    const totalRevenue = (skuSales ?? []).reduce((s, r) => s + (Number(r.net_amount) || 0), 0);
    const refunds = (skuSales ?? []).filter((r) => r.payment_state === "refunded").length;

    salesByVariant = {
      totalUnits,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      refunds,
      lastSaleDate: skuSales?.[0]?.sale_date ?? null,
      catalogNumber: skuSales?.find((r) => r.catalog_number)?.catalog_number ?? null,
      upc: skuSales?.find((r) => r.upc)?.upc ?? null,
      isrc: skuSales?.find((r) => r.isrc)?.isrc ?? null,
      recentSales: (skuSales ?? []).slice(0, 10),
    };
  }

  return { mapping, salesByVariant };
}

// === Trending (dig_deeper) ===

const trendingCache = new Map<string, { data: unknown; fetchedAt: number }>();
const TRENDING_CACHE_TTL_MS = 180_000; // 3 minutes

export async function getBandcampTrending(
  workspaceId: string,
  params: {
    tags: string[];
    sort?: "pop" | "new" | "rec" | "surprise" | "top";
    format?: "all" | "digital" | "vinyl" | "cd" | "cassette";
    page?: number;
  },
) {
  const cacheKey = JSON.stringify(params);
  const cached = trendingCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TRENDING_CACHE_TTL_MS) {
    return cached.data as { items: unknown[]; moreAvailable: boolean; formatSummary: { vinyl: number; cd: number; cassette: number; digital: number }; tagName?: string };
  }

  const result = await fetchDigDeeper(params.tags, {
    sort: params.sort,
    format: params.format,
    page: params.page,
  });

  if (!result?.ok) {
    if (cached) return cached.data;
    return { items: [], moreAvailable: false, formatSummary: { vinyl: 0, cd: 0, cassette: 0, digital: 0 } };
  }

  const supabase = createServiceRoleClient();
  const { data: connBands } = await supabase
    .from("bandcamp_connections")
    .select("band_id, band_name")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  const clientBandIds = new Map((connBands ?? []).map((c) => [c.band_id, c.band_name]));

  const items = result.items.map((item: DigDeeperItem) => {
    const isClient = clientBandIds.has(item.band_id);
    return {
      title: item.title,
      artist: item.artist,
      bandName: item.band_name,
      genre: item.genre,
      url: item.tralbum_url,
      bandUrl: item.band_url,
      artUrl: bandcampArtUrl(item.art_id, 5),
      artUrlSmall: bandcampArtUrl(item.art_id, 2),
      featuredTrack: item.featured_track_title,
      isPreorder: item.is_preorder ?? false,
      comments: item.num_comments,
      isClientArtist: isClient,
      clientBandName: isClient ? clientBandIds.get(item.band_id) : null,
      packages: (item.packages ?? []).map((p) => ({
        typeStr: p.type_str,
        isVinyl: p.is_vinyl,
        price: p.price.amount / 100,
        currency: p.price.currency,
      })),
      bandId: item.band_id,
      subdomain: item.subdomain,
    };
  });

  let vinyl = 0, cd = 0, cassette = 0, digital = 0;
  for (const item of items) {
    const types = new Set(item.packages.map((p: { typeStr: string }) => p.typeStr));
    if (types.has("vinyl") || item.packages.some((p: { isVinyl: boolean }) => p.isVinyl)) vinyl++;
    if (types.has("cd")) cd++;
    if (types.has("cassette")) cassette++;
    if (item.packages.length === 0) digital++;
  }

  const response = {
    items,
    moreAvailable: result.more_available,
    formatSummary: { vinyl, cd, cassette, digital },
    tagName: result.discover_spec?.tag_pretty_name ?? params.tags[0],
  };

  trendingCache.set(cacheKey, { data: response, fetchedAt: Date.now() });
  return response;
}
