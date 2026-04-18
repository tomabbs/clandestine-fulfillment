"use server";

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type {
  ClientStoreConnection,
  ClientStoreSkuMapping,
  ConnectionStatus,
  StorePlatform,
} from "@/lib/shared/types";

// === Zod schemas (Rule #5) ===

const connectionFiltersSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  orgId: z.string().optional(),
  platform: z.enum(["shopify", "woocommerce", "squarespace", "bigcommerce", "discogs"]).optional(),
  status: z.enum(["pending", "active", "disabled_auth_failure", "error"]).optional(),
});

export type ConnectionFilters = z.infer<typeof connectionFiltersSchema>;

const createConnectionSchema = z.object({
  orgId: z.string().min(1),
  platform: z.enum(["shopify", "woocommerce", "squarespace", "bigcommerce", "discogs"]),
  storeUrl: z.string().url(),
});

const updateConnectionSchema = z.object({
  storeUrl: z.string().url().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookSecret: z.string().nullable().optional(),
});

// === Server Actions ===

/**
 * List store connections with health status columns (Rule #28).
 */
export async function getStoreConnections(rawFilters?: ConnectionFilters): Promise<{
  connections: Array<ClientStoreConnection & { org_name: string; sku_mapping_count: number }>;
}> {
  await requireAuth();
  const filters = connectionFiltersSchema.parse(rawFilters ?? {});
  const serviceClient = createServiceRoleClient();

  let query = serviceClient
    .from("client_store_connections")
    .select("*, organizations!inner(name)")
    .order("created_at", { ascending: false });

  if (filters.workspaceId) query = query.eq("workspace_id", filters.workspaceId);
  if (filters.orgId) query = query.eq("org_id", filters.orgId);
  if (filters.platform) query = query.eq("platform", filters.platform);
  if (filters.status) query = query.eq("connection_status", filters.status);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch store connections: ${error.message}`);

  const connections = data ?? [];

  // Fetch SKU mapping counts per connection
  const connectionIds = connections.map((c) => c.id);
  const mappingCounts: Record<string, number> = {};

  if (connectionIds.length > 0) {
    const { data: countData } = await serviceClient
      .from("client_store_sku_mappings")
      .select("connection_id", { count: "exact", head: false })
      .in("connection_id", connectionIds)
      .eq("is_active", true);

    if (countData) {
      for (const row of countData) {
        const cid = row.connection_id as string;
        mappingCounts[cid] = (mappingCounts[cid] ?? 0) + 1;
      }
    }
  }

  return {
    connections: connections.map((c) => {
      const org = c.organizations as unknown as { name: string };
      return {
        ...c,
        organizations: undefined,
        org_name: org?.name ?? "",
        sku_mapping_count: mappingCounts[c.id] ?? 0,
      } as ClientStoreConnection & { org_name: string; sku_mapping_count: number };
    }),
  };
}

/**
 * Create a new pending store connection.
 */
export async function createStoreConnection(rawData: {
  orgId: string;
  platform: StorePlatform;
  storeUrl: string;
}): Promise<ClientStoreConnection> {
  await requireAuth();
  const data = createConnectionSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Derive workspace_id from org
  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .select("workspace_id")
    .eq("id", data.orgId)
    .single();

  if (orgError || !org) throw new Error("Organization not found");

  const { data: connection, error } = await serviceClient
    .from("client_store_connections")
    .insert({
      workspace_id: org.workspace_id,
      org_id: data.orgId,
      platform: data.platform,
      store_url: data.storeUrl,
      connection_status: "pending" as ConnectionStatus,
      do_not_fanout: true,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create connection: ${error.message}`);

  return connection as ClientStoreConnection;
}

/**
 * Edit connection details.
 */
export async function updateStoreConnection(
  connectionId: string,
  rawData: { storeUrl?: string; webhookUrl?: string | null; webhookSecret?: string | null },
): Promise<{ success: true }> {
  await requireAuth();
  const data = updateConnectionSchema.parse(rawData);

  const serviceClient = createServiceRoleClient();

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.storeUrl !== undefined) update.store_url = data.storeUrl;
  if (data.webhookUrl !== undefined) update.webhook_url = data.webhookUrl;
  if (data.webhookSecret !== undefined) update.webhook_secret = data.webhookSecret;

  const { error } = await serviceClient
    .from("client_store_connections")
    .update(update)
    .eq("id", connectionId);

  if (error) throw new Error(`Failed to update connection: ${error.message}`);

  return { success: true };
}

/**
 * Phase 0.8 — admin "Reactivate" for dormant client store connections.
 *
 * The dormancy migration (20260417000003) marks every Shopify / WooCommerce /
 * Squarespace connection `do_not_fanout = true` so ShipStation Inventory Sync
 * becomes the canonical fanout path. Staff use this Server Action from
 * /admin/settings/client-store-reconnect to opt a single connection back into
 * first-party fanout (e.g. when ShipStation Inventory Sync doesn't cover a
 * specific edge case for that store).
 *
 * Side effects:
 *   - Sets do_not_fanout = false (the gate at client-store-fanout-gate.ts
 *     starts allowing pushes immediately on the next cron tick).
 *   - Sets connection_status = 'active' so the multi-store-push WHERE clause
 *     also matches the row again.
 *   - Clears last_error and last_error_at so the circuit breaker
 *     (handleConnectionFailure in multi-store-inventory-push) starts a fresh
 *     consecutive-failure count from zero.
 *   - Writes a `channel_sync_log` audit row tagged with the actor's user id.
 *
 * No deactivate variant — for that, use `disableStoreConnection` (below).
 */
export async function reactivateClientStoreConnection(input: {
  connectionId: string;
}): Promise<{ success: true }> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = z.object({ connectionId: z.string().uuid() }).parse(input);
  const serviceClient = createServiceRoleClient();

  const { data: connection, error: fetchError } = await serviceClient
    .from("client_store_connections")
    .select("workspace_id, platform, store_url")
    .eq("id", data.connectionId)
    .single();
  if (fetchError || !connection) throw new Error("Connection not found");

  const now = new Date().toISOString();
  const { error: updateError } = await serviceClient
    .from("client_store_connections")
    .update({
      do_not_fanout: false,
      connection_status: "active" as ConnectionStatus,
      last_error: null,
      last_error_at: null,
      updated_at: now,
    })
    .eq("id", data.connectionId);

  if (updateError) {
    throw new Error(`Failed to reactivate connection: ${updateError.message}`);
  }

  // Audit trail — channel_sync_log is the canonical activity log and is
  // already used by the multi-store push for state-change reporting.
  await serviceClient.from("channel_sync_log").insert({
    workspace_id: connection.workspace_id,
    channel: "multi-store",
    sync_type: "reactivate",
    status: "completed",
    items_processed: 1,
    started_at: now,
    completed_at: now,
    metadata: {
      connection_id: data.connectionId,
      platform: connection.platform,
      store_url: connection.store_url,
      actor_user_id: auth.userRecord.id,
      action: "reactivate",
    },
  });

  return { success: true };
}

/**
 * Disable a connection — sets status to error and stops fanout.
 * Rule #53: do_not_fanout stops inventory pushes to degraded connections.
 */
export async function disableStoreConnection(connectionId: string): Promise<{ success: true }> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { error } = await serviceClient
    .from("client_store_connections")
    .update({
      connection_status: "error" as ConnectionStatus,
      do_not_fanout: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);

  if (error) throw new Error(`Failed to disable connection: ${error.message}`);

  return { success: true };
}

/**
 * Test a store connection by attempting an API call.
 * Updates last_poll_at on success, last_error on failure.
 * Rule #52: typed health states.
 */
export async function testStoreConnection(
  connectionId: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data: connection, error: fetchError } = await serviceClient
    .from("client_store_connections")
    .select("*")
    .eq("id", connectionId)
    .single();

  if (fetchError || !connection) throw new Error("Connection not found");

  const conn = connection as ClientStoreConnection;
  const now = new Date().toISOString();

  try {
    switch (conn.platform) {
      case "squarespace": {
        if (!conn.api_key) throw new Error("Missing API key");
        const { getInventory } = await import("@/lib/clients/squarespace-client");
        await getInventory(conn.api_key, conn.store_url);
        break;
      }
      case "woocommerce": {
        if (!conn.api_key || !conn.api_secret) throw new Error("Missing credentials");
        const { getOrders } = await import("@/lib/clients/woocommerce-client");
        await getOrders(
          { consumerKey: conn.api_key, consumerSecret: conn.api_secret, siteUrl: conn.store_url },
          { perPage: 1 },
        );
        break;
      }
      case "shopify": {
        // Shopify client store test — simple REST call
        if (!conn.api_key) throw new Error("Missing API key");
        const res = await fetch(`${conn.store_url}/admin/api/2026-01/shop.json`, {
          headers: { "X-Shopify-Access-Token": conn.api_key },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        break;
      }
      default:
        throw new Error(`Test not supported for platform: ${conn.platform}`);
    }

    // Success — update health columns
    await serviceClient
      .from("client_store_connections")
      .update({
        last_poll_at: now,
        connection_status: "active" as ConnectionStatus,
        last_error: null,
        last_error_at: null,
        updated_at: now,
      })
      .eq("id", connectionId);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    await serviceClient
      .from("client_store_connections")
      .update({
        last_error: message,
        last_error_at: now,
        updated_at: now,
      })
      .eq("id", connectionId);

    return { success: false, error: message };
  }
}

/**
 * Get SKU mappings for a connection.
 * Rule #44: includes last_pushed_quantity and last_pushed_at.
 */
export async function getSkuMappings(
  connectionId: string,
): Promise<Array<ClientStoreSkuMapping & { variant_sku: string; variant_title: string | null }>> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("client_store_sku_mappings")
    .select("*, warehouse_product_variants(sku, title)")
    .eq("connection_id", connectionId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch SKU mappings: ${error.message}`);

  return (data ?? []).map((m) => {
    const variant = m.warehouse_product_variants as unknown as {
      sku: string;
      title: string | null;
    } | null;
    return {
      ...m,
      variant_sku: variant?.sku ?? "",
      variant_title: variant?.title ?? null,
      warehouse_product_variants: undefined,
    } as ClientStoreSkuMapping & { variant_sku: string; variant_title: string | null };
  });
}

/**
 * Auto-discover remote SKUs and match to warehouse variants.
 * Creates client_store_sku_mappings for matches.
 */
export async function autoDiscoverSkus(
  connectionId: string,
): Promise<{ matched: number; unmatched: number }> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data: connection, error: connError } = await serviceClient
    .from("client_store_connections")
    .select("*")
    .eq("id", connectionId)
    .single();

  if (connError || !connection) throw new Error("Connection not found");

  const conn = connection as ClientStoreConnection;

  // Fetch remote products/inventory to get SKUs
  let remoteSkus: Array<{
    sku: string;
    remoteProductId: string;
    remoteVariantId: string | null;
  }> = [];

  switch (conn.platform) {
    case "squarespace": {
      if (!conn.api_key) throw new Error("Missing API key");
      const { getInventory } = await import("@/lib/clients/squarespace-client");
      const inventory = await getInventory(conn.api_key, conn.store_url);
      remoteSkus = inventory
        .filter((i) => i.sku)
        .map((i) => ({
          sku: i.sku as string,
          remoteProductId: i.variantId,
          remoteVariantId: i.variantId,
        }));
      break;
    }
    case "woocommerce": {
      if (!conn.api_key || !conn.api_secret) throw new Error("Missing credentials");
      // WooCommerce doesn't have a bulk "get all products" with SKU easily,
      // so we fetch paginated products
      const credentials = {
        consumerKey: conn.api_key,
        consumerSecret: conn.api_secret,
        siteUrl: conn.store_url,
      };
      // Fetch first page of products (limited to prevent timeout — Rule #41)
      const res = await fetch(
        `${conn.store_url.replace(/\/$/, "")}/wp-json/wc/v3/products?per_page=100`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64")}`,
          },
        },
      );
      if (!res.ok) throw new Error(`WooCommerce fetch error: ${res.status}`);
      const products = (await res.json()) as Array<{
        id: number;
        sku: string;
      }>;
      remoteSkus = products
        .filter((p) => p.sku)
        .map((p) => ({
          sku: p.sku,
          remoteProductId: String(p.id),
          remoteVariantId: null,
        }));
      break;
    }
    case "shopify": {
      if (!conn.api_key) throw new Error("Missing API key");
      const shopifyUrl = conn.store_url.replace(/\/$/, "");
      const shopifyHeaders = { "X-Shopify-Access-Token": conn.api_key };

      // Paginate through all products
      let pageUrl: string | null =
        `${shopifyUrl}/admin/api/2026-01/products.json?limit=250&fields=id,variants`;
      while (pageUrl) {
        const res: Response = await fetch(pageUrl, { headers: shopifyHeaders });
        if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
        const { products } = (await res.json()) as {
          products: Array<{
            id: number;
            variants: Array<{ id: number; sku: string }>;
          }>;
        };

        for (const product of products) {
          for (const variant of product.variants ?? []) {
            if (variant.sku) {
              remoteSkus.push({
                sku: variant.sku,
                remoteProductId: String(product.id),
                remoteVariantId: String(variant.id),
              });
            }
          }
        }

        // Handle pagination via Link header
        const linkHeader: string | null = res.headers.get("Link");
        const nextMatch: RegExpMatchArray | null | undefined =
          linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
        pageUrl = nextMatch?.[1] ?? null;
      }
      break;
    }
    default:
      throw new Error(`Auto-discover not supported for platform: ${conn.platform}`);
  }

  if (remoteSkus.length === 0) {
    return { matched: 0, unmatched: 0 };
  }

  // Fetch warehouse variants by SKU for this org
  const { data: variants } = await serviceClient
    .from("warehouse_product_variants")
    .select("id, sku, warehouse_products!inner(org_id)")
    .in(
      "sku",
      remoteSkus.map((r) => r.sku),
    );

  const variantsBysku = new Map<string, string>();
  for (const v of variants ?? []) {
    const product = v.warehouse_products as unknown as { org_id: string };
    if (product?.org_id === conn.org_id) {
      variantsBysku.set(v.sku, v.id);
    }
  }

  let matched = 0;
  let unmatched = 0;

  for (const remote of remoteSkus) {
    const variantId = variantsBysku.get(remote.sku);
    if (variantId) {
      // Upsert mapping (Rule #39: don't crash on conflicts)
      await serviceClient.from("client_store_sku_mappings").upsert(
        {
          workspace_id: conn.workspace_id,
          connection_id: connectionId,
          variant_id: variantId,
          remote_product_id: remote.remoteProductId,
          remote_variant_id: remote.remoteVariantId,
          remote_sku: remote.sku,
          is_active: true,
        },
        { onConflict: "connection_id,variant_id" },
      );
      matched++;
    } else {
      unmatched++;
    }
  }

  return { matched, unmatched };
}
