"use server";

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import {
  estimateOrderVolume,
  getInventoryLevelsAtLocation,
  iterateAllVariants,
} from "@/lib/server/shopify-connection-graphql";
import {
  type RegisterWebhookSubscriptionsResult,
  registerWebhookSubscriptions,
} from "@/lib/server/shopify-webhook-subscriptions";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";
import type {
  ClientStoreConnection,
  ClientStoreSkuMapping,
  ConnectionStatus,
  StorePlatform,
} from "@/lib/shared/types";

// HRD-09.2: pin a single API version for client-store Shopify reads invoked
// from Server Actions. The OAuth callback also uses this version implicitly
// (Shopify pins the version per-app, not per-request — we just have to use the
// same version here that the app config declares).
const SHOPIFY_API_VERSION = "2026-01";

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

// ============================================================================
// HRD-35 — Per-client Custom-distribution app onboarding (staff-side)
//
// The staff workflow for a brand-new Shopify connection is:
//   1) Create a Custom-distribution app inside the client's Shopify Partner
//      organization (manual, in Shopify's Partner Dashboard).
//   2) Paste the Client ID + Client Secret into the Clandestine admin UI.
//      → setShopifyAppCredentials
//   3) Click an install link generated against the per-connection app + the
//      client's myshopify domain.
//      → generateShopifyInstallUrl
//   4) Complete the OAuth consent flow in Shopify; the callback at
//      /api/oauth/shopify upserts the access token onto the connection row
//      with do_not_fanout=true (Phase 0.8 default).
//   5) Pick a default Shopify location for inventory ops.
//      → listShopifyLocations + setShopifyDefaultLocation
//   6) Run autoDiscoverSkus + dry-run reconciliation (HRD-04 — separate slug),
//      then call reactivateClientStoreConnection to flip do_not_fanout=false.
//
// All actions in this section are STAFF-ONLY (require requireAuth + isStaff).
// They never call Shopify with the env-singleton credentials — the per-
// connection token is always used.
// ============================================================================

const setShopifyAppCredentialsSchema = z.object({
  connectionId: z.string().uuid(),
  shopifyAppClientId: z.string().min(1, "Client ID is required"),
  shopifyAppClientSecret: z.string().min(1, "Client Secret is required"),
});

/**
 * HRD-35 step 2 — store the per-connection Shopify Custom-distribution app
 * credentials. The secret column is named `*_encrypted` so the deferred
 * encryption-at-rest work (slug `client-store-credentials-at-rest-encryption`)
 * is a behavior change, not a column rename. Today the column carries
 * plaintext.
 */
export async function setShopifyAppCredentials(input: {
  connectionId: string;
  shopifyAppClientId: string;
  shopifyAppClientSecret: string;
}): Promise<{ success: true }> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = setShopifyAppCredentialsSchema.parse(input);

  const serviceClient = createServiceRoleClient();
  const { data: existing, error: fetchErr } = await serviceClient
    .from("client_store_connections")
    .select("id, platform")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (fetchErr) throw new Error(`Connection lookup failed: ${fetchErr.message}`);
  if (!existing) throw new Error("Connection not found");
  if (existing.platform !== "shopify") {
    throw new Error("setShopifyAppCredentials only applies to Shopify connections");
  }

  const { error } = await serviceClient
    .from("client_store_connections")
    .update({
      shopify_app_client_id: data.shopifyAppClientId,
      shopify_app_client_secret_encrypted: data.shopifyAppClientSecret,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.connectionId);
  if (error) throw new Error(`Failed to set Shopify app credentials: ${error.message}`);

  return { success: true };
}

/**
 * HRD-35 step 3 — generate the install URL for a per-connection Shopify
 * Custom-distribution app. Encodes the connection_id into the OAuth state so
 * the callback knows which app credentials to use for HMAC verification and
 * token exchange. The state nonce itself is stored server-side by the OAuth
 * route's Phase A (HRD-35.1) — not by this action — so we don't have to
 * coordinate writes across two Server Actions.
 *
 * Returns the URL the operator clicks to start the install. We deliberately do
 * NOT redirect from this Server Action — the operator wants a URL they can
 * inspect, share over Slack, or paste into a different browser session if
 * Shopify forces a re-auth.
 */
const generateShopifyInstallUrlSchema = z.object({
  connectionId: z.string().uuid(),
  shopDomain: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+\.myshopify\.com$/i, "shopDomain must be the bare myshopify.com hostname"),
});

export async function generateShopifyInstallUrl(input: {
  connectionId: string;
  shopDomain: string;
}): Promise<{ installUrl: string; usesPerConnectionApp: boolean }> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = generateShopifyInstallUrlSchema.parse(input);

  const serviceClient = createServiceRoleClient();
  const { data: connection, error } = await serviceClient
    .from("client_store_connections")
    .select("id, org_id, platform, shopify_app_client_id, shopify_app_client_secret_encrypted")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (error) throw new Error(`Connection lookup failed: ${error.message}`);
  if (!connection) throw new Error("Connection not found");
  if (connection.platform !== "shopify") {
    throw new Error("generateShopifyInstallUrl only applies to Shopify connections");
  }

  const usesPerConnectionApp = Boolean(
    connection.shopify_app_client_id && connection.shopify_app_client_secret_encrypted,
  );
  if (!usesPerConnectionApp) {
    // Per HRD-35, every new client should use a per-connection Custom-
    // distribution app. Surface this gap loudly rather than silently falling
    // back to env credentials.
    throw new Error(
      "Per-connection Shopify app credentials are not configured. Run setShopifyAppCredentials first.",
    );
  }

  const params = new URLSearchParams({
    shop: data.shopDomain,
    org_id: connection.org_id,
    connection_id: connection.id,
  });

  return {
    installUrl: `${env().NEXT_PUBLIC_APP_URL}/api/oauth/shopify?${params.toString()}`,
    usesPerConnectionApp: true,
  };
}

/**
 * HRD-35 step 5a — list Shopify locations for the connection so staff can pick
 * a default location for inventory ops. Uses the per-connection token; never
 * calls Clandestine's own Shopify env-singleton.
 *
 * Northern Spy probe finding (2026-04-21): single-location stores are common.
 * The UI should auto-select the only location in this case.
 */
const listShopifyLocationsSchema = z.object({
  connectionId: z.string().uuid(),
});

export type ShopifyLocationSummary = {
  id: string; // numeric REST id (NOT the GraphQL gid)
  name: string;
  active: boolean;
  city: string | null;
  countryCode: string | null;
};

export async function listShopifyLocations(input: {
  connectionId: string;
}): Promise<ShopifyLocationSummary[]> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = listShopifyLocationsSchema.parse(input);

  const serviceClient = createServiceRoleClient();
  const { data: conn, error } = await serviceClient
    .from("client_store_connections")
    .select("api_key, store_url, platform")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (error) throw new Error(`Connection lookup failed: ${error.message}`);
  if (!conn) throw new Error("Connection not found");
  if (conn.platform !== "shopify") {
    throw new Error("listShopifyLocations only applies to Shopify connections");
  }
  if (!conn.api_key) {
    throw new Error("Connection has no Shopify access token — complete the OAuth install first");
  }

  const url = `${conn.store_url.replace(/\/$/, "")}/admin/api/${SHOPIFY_API_VERSION}/locations.json`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": conn.api_key,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 403 || res.status === 401) {
    throw new Error(
      `Shopify rejected the locations call (${res.status}). The connection's offline token most likely lacks the read_locations scope — re-install the Shopify app to grant updated scopes.`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify locations fetch failed: HTTP ${res.status} | ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    locations: Array<{
      id: number;
      name: string;
      active: boolean;
      city?: string | null;
      country_code?: string | null;
    }>;
  };

  return json.locations.map((l) => ({
    id: String(l.id),
    name: l.name,
    active: l.active,
    city: l.city ?? null,
    countryCode: l.country_code ?? null,
  }));
}

/**
 * HRD-35 step 5b — persist the staff-selected default location on the
 * connection row. HRD-05 enforcement (incoming inventory webhooks with
 * `location_id != default_location_id` are persisted as `wrong_location` and
 * not applied) lives in `process-client-store-webhook` and is wired up in a
 * separate session.
 */
const setShopifyDefaultLocationSchema = z.object({
  connectionId: z.string().uuid(),
  locationId: z.string().min(1),
});

export async function setShopifyDefaultLocation(input: {
  connectionId: string;
  locationId: string;
}): Promise<{ success: true }> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = setShopifyDefaultLocationSchema.parse(input);

  // Defense-in-depth: confirm the supplied locationId is in the live Shopify
  // location list. Catches typos and stale UI state. Reuses the listing
  // helper so the same scope/token resolution applies.
  const locations = await listShopifyLocations({ connectionId: data.connectionId });
  const match = locations.find((l) => l.id === data.locationId);
  if (!match) {
    throw new Error(
      `Location ${data.locationId} is not in the Shopify locations list for this connection.`,
    );
  }
  if (!match.active) {
    throw new Error(
      `Location ${data.locationId} (${match.name}) is INACTIVE in Shopify. Pick an active location.`,
    );
  }

  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient
    .from("client_store_connections")
    .update({
      default_location_id: data.locationId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.connectionId);
  if (error) throw new Error(`Failed to set default location: ${error.message}`);

  return { success: true };
}

// ============================================================================
// HRD-35 step 6 / HRD-03 — autoDiscoverShopifySkus
//
// Walks every product variant in the connected Shopify store and matches
// each Shopify SKU against `warehouse_product_variants.sku` for the
// connection's workspace. Populates `client_store_sku_mappings` with the
// remote_product_id / remote_variant_id / remote_inventory_item_id triple
// needed by inventory webhooks (HRD-03 unique-index protection enforced via
// idx_sku_mappings_connection_inventory_item from migration 20260422000001).
//
// SUPERSEDES the legacy `autoDiscoverSkus` (above) FOR SHOPIFY ONLY. The
// legacy function is kept for Squarespace + WooCommerce code paths until
// those platforms get their own per-platform discoverers. The new function:
//   - uses GraphQL (variants.json REST is being deprecated 2025-10),
//   - captures `inventoryItem.id` so HRD-03 webhook resolution works,
//   - detects duplicate SKUs across Shopify variants (Rule #8 violation),
//   - reports unmatched + warehouse-not-in-Shopify counts for HRD-04 staging.
//
// HRD-04 prerequisite: the dry-run reconciliation Server Action consumes the
// mappings produced by this discovery pass. Calling discovery without later
// running dry-run is fine; calling dry-run with no mappings yields an empty
// matched-set, which is the correct degenerate behavior.
//
// Read-only against Shopify. Writes only to client_store_sku_mappings.
// Never enables / deactivates inventory tracking, never touches inventory
// quantities — that's the dry-run (read) and the live webhook handler (write).
// ============================================================================

const autoDiscoverShopifySkusSchema = z.object({
  connectionId: z.string().uuid(),
});

export type AutoDiscoverShopifySkusReport = {
  connectionId: string;
  shopifyVariantsScanned: number;
  shopifyProductsScanned: number;
  warehouseSkusInWorkspace: number;
  matched: number;
  newMappingsCreated: number;
  existingMappingsUpdated: number;
  shopifyVariantsWithoutSku: number;
  shopifyVariantsWithoutInventoryItem: number;
  /** Shopify SKUs that don't exist in the workspace's warehouse_product_variants. Hard error per HRD-04 — the operator must reconcile before flipping fanout. */
  unmatchedShopifySkus: string[];
  /** Same SKU appearing on >1 Shopify variant in this store. Per Rule #8 this is a data error in Shopify; surfaced for staff review. */
  duplicateShopifySkus: Array<{ sku: string; variantIds: string[] }>;
  /** Workspace SKUs that exist on warehouse_product_variants but were NOT found in Shopify. Informational — these may be Bandcamp-only or ShipStation-only. */
  warehouseSkusNotInShopify: string[];
  durationMs: number;
};

/**
 * Discover Shopify SKUs and persist mappings. Idempotent — re-running on
 * the same connection updates existing rows in place (matched on the
 * `(connection_id, remote_inventory_item_id)` unique index added by migration
 * 20260422000001).
 *
 * SKU normalization: trim() only. We do NOT lowercase or strip zero-width
 * chars here — `shipstation-export.ts` does that for export-side dedup, but
 * for matching we want byte-exact equality with `warehouse_product_variants.sku`
 * to avoid silently merging two warehouse rows that DO have a meaningful case
 * or whitespace difference.
 */
export async function autoDiscoverShopifySkus(input: {
  connectionId: string;
}): Promise<AutoDiscoverShopifySkusReport> {
  const startedAt = Date.now();
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = autoDiscoverShopifySkusSchema.parse(input);

  const serviceClient = createServiceRoleClient();

  // 1) Load the connection (auth, store_url, workspace_id).
  const { data: conn, error: connErr } = await serviceClient
    .from("client_store_connections")
    .select("id, workspace_id, store_url, platform, api_key")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (connErr) throw new Error(`Connection lookup failed: ${connErr.message}`);
  if (!conn) throw new Error("Connection not found");
  if (conn.platform !== "shopify") {
    throw new Error("autoDiscoverShopifySkus only applies to Shopify connections");
  }
  if (!conn.api_key) {
    throw new Error("Connection has no Shopify access token — complete the OAuth install first");
  }

  // 2) Load the workspace's SKU universe. Returns Map<sku, variantId>.
  //    Loading ALL active variants in one query — the universe is bounded
  //    (~3k variants observed at 2026-04 export) so this is cheap.
  const { data: variants, error: variantsErr } = await serviceClient
    .from("warehouse_product_variants")
    .select("id, sku")
    .eq("workspace_id", conn.workspace_id)
    .not("sku", "is", null);
  if (variantsErr) throw new Error(`Variant universe load failed: ${variantsErr.message}`);

  const skuToVariantId = new Map<string, string>();
  for (const v of variants ?? []) {
    if (typeof v.sku !== "string") continue;
    const trimmed = v.sku.trim();
    if (!trimmed) continue;
    // First-row wins on workspace-side collisions (Rule #31 should prevent these
    // from existing at all — surface in unmatched if they do).
    if (!skuToVariantId.has(trimmed)) {
      skuToVariantId.set(trimmed, v.id);
    }
  }

  // 3) Walk Shopify variants. Build candidate match list + duplicate detector.
  const shopifySkuSeen = new Map<string, string[]>(); // sku → variantIds
  const candidateMatches: Array<{
    sku: string;
    variantId: string; // warehouse variant id
    remoteVariantId: string;
    remoteProductId: string;
    remoteInventoryItemId: string;
  }> = [];
  let shopifyVariantsScanned = 0;
  let shopifyProductsScanned = 0;
  let shopifyVariantsWithoutSku = 0;
  let shopifyVariantsWithoutInventoryItem = 0;

  // Track unique product ids for the count.
  const productIdsSeen = new Set<string>();

  for await (const page of iterateAllVariants({
    storeUrl: conn.store_url,
    accessToken: conn.api_key,
  })) {
    for (const v of page) {
      shopifyVariantsScanned++;
      productIdsSeen.add(v.productId);

      if (!v.sku) {
        shopifyVariantsWithoutSku++;
        continue;
      }
      if (!v.inventoryItemId) {
        shopifyVariantsWithoutInventoryItem++;
        continue;
      }

      const seenForSku = shopifySkuSeen.get(v.sku) ?? [];
      seenForSku.push(v.variantId);
      shopifySkuSeen.set(v.sku, seenForSku);

      const warehouseVariantId = skuToVariantId.get(v.sku);
      if (!warehouseVariantId) continue;

      candidateMatches.push({
        sku: v.sku,
        variantId: warehouseVariantId,
        remoteVariantId: v.variantId,
        remoteProductId: v.productId,
        remoteInventoryItemId: v.inventoryItemId,
      });
    }
  }
  shopifyProductsScanned = productIdsSeen.size;

  // 4) Detect duplicate SKUs in Shopify (Rule #8 violation).
  const duplicateShopifySkus: Array<{ sku: string; variantIds: string[] }> = [];
  for (const [sku, variantIds] of shopifySkuSeen.entries()) {
    if (variantIds.length > 1) {
      duplicateShopifySkus.push({ sku, variantIds });
    }
  }

  // 5) Persist mappings — upsert keyed on (connection_id, remote_inventory_item_id)
  //    so re-runs are idempotent. We DO NOT delete pre-existing mappings whose
  //    remote_inventory_item_id no longer appears in Shopify; those are handled
  //    by a separate cleanup pass (deferred). Staff can manually deactivate via
  //    the existing UI if needed.
  let newMappingsCreated = 0;
  let existingMappingsUpdated = 0;

  if (candidateMatches.length > 0) {
    // Pre-load existing mappings keyed by (remote_inventory_item_id) for this
    // connection so we can compute new vs updated counts deterministically.
    const { data: existing } = await serviceClient
      .from("client_store_sku_mappings")
      .select("id, remote_inventory_item_id")
      .eq("connection_id", conn.id)
      .not("remote_inventory_item_id", "is", null);
    const existingItemIds = new Set<string>();
    for (const row of existing ?? []) {
      if (row.remote_inventory_item_id) existingItemIds.add(row.remote_inventory_item_id);
    }

    // Chunk inserts to keep PostgREST URL-length bounded.
    const CHUNK = 500;
    for (let i = 0; i < candidateMatches.length; i += CHUNK) {
      const chunk = candidateMatches.slice(i, i + CHUNK);
      const payloads = chunk.map((m) => ({
        workspace_id: conn.workspace_id,
        connection_id: conn.id,
        variant_id: m.variantId,
        remote_sku: m.sku,
        remote_product_id: m.remoteProductId,
        remote_variant_id: m.remoteVariantId,
        remote_inventory_item_id: m.remoteInventoryItemId,
        is_active: true,
        updated_at: new Date().toISOString(),
      }));

      const { error: upsertErr } = await serviceClient
        .from("client_store_sku_mappings")
        .upsert(payloads, {
          onConflict: "connection_id,remote_inventory_item_id",
          ignoreDuplicates: false,
        });
      if (upsertErr) {
        throw new Error(
          `Mapping upsert failed at chunk offset ${i}: ${upsertErr.message}. Aborting — partial state may remain on prior chunks.`,
        );
      }

      for (const m of chunk) {
        if (existingItemIds.has(m.remoteInventoryItemId)) {
          existingMappingsUpdated++;
        } else {
          newMappingsCreated++;
        }
      }
    }
  }

  // 6) Compute report sets.
  const matchedSkus = new Set(candidateMatches.map((c) => c.sku));
  const unmatchedShopifySkus: string[] = [];
  for (const sku of shopifySkuSeen.keys()) {
    if (!skuToVariantId.has(sku)) unmatchedShopifySkus.push(sku);
  }
  unmatchedShopifySkus.sort();

  const warehouseSkusNotInShopify: string[] = [];
  for (const sku of skuToVariantId.keys()) {
    if (!matchedSkus.has(sku)) warehouseSkusNotInShopify.push(sku);
  }
  warehouseSkusNotInShopify.sort();

  return {
    connectionId: conn.id,
    shopifyVariantsScanned,
    shopifyProductsScanned,
    warehouseSkusInWorkspace: skuToVariantId.size,
    matched: candidateMatches.length,
    newMappingsCreated,
    existingMappingsUpdated,
    shopifyVariantsWithoutSku,
    shopifyVariantsWithoutInventoryItem,
    unmatchedShopifySkus: unmatchedShopifySkus.slice(0, 200), // cap for serializability
    duplicateShopifySkus: duplicateShopifySkus.slice(0, 100),
    warehouseSkusNotInShopify: warehouseSkusNotInShopify.slice(0, 200),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Convenience getter — returns the cached SKU mapping summary for a connection
 * without re-walking Shopify. Used by the dialog to show "X SKUs mapped" state
 * on dialog open before the operator clicks Discover.
 */
export async function getSkuMappingSummary(input: { connectionId: string }): Promise<{
  totalMappings: number;
  withInventoryItemId: number;
  lastDiscoveredAt: string | null;
}> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = z.object({ connectionId: z.string().uuid() }).parse(input);

  const serviceClient = createServiceRoleClient();
  const { data: rows, error } = await serviceClient
    .from("client_store_sku_mappings")
    .select("id, remote_inventory_item_id, updated_at")
    .eq("connection_id", data.connectionId)
    .eq("is_active", true);

  if (error) throw new Error(`Mapping summary load failed: ${error.message}`);

  const totalMappings = rows?.length ?? 0;
  const withInventoryItemId = (rows ?? []).filter((r) => r.remote_inventory_item_id).length;
  const lastDiscoveredAt = (rows ?? []).reduce<string | null>((max, r) => {
    if (!r.updated_at) return max;
    if (max === null || r.updated_at > max) return r.updated_at;
    return max;
  }, null);

  return { totalMappings, withInventoryItemId, lastDiscoveredAt };
}

// Note: ShopifyScopeError is thrown by autoDiscoverShopifySkus when the per-connection
// access token is missing the read_products / read_inventory scope. The dialog
// catches all errors generically; the .message includes the missing scope name
// so the operator knows to re-install the app. We deliberately do NOT re-export
// the class from this Server Action file — Next.js "use server" files may only
// export async functions, and re-exporting a class would break the build.

// ============================================================================
// HRD-09.2 — webhook auto-register (operator-controlled)
//
// Registers the four required Shopify webhook topics against the per-
// connection app's offline token, then persists the resulting subscription
// IDs + Shopify-pinned apiVersion onto `client_store_connections.metadata`.
//
// Operator-controlled: NOT auto-fired on OAuth callback. The dialog exposes
// a "Register webhooks" button. We only ever call Shopify with the per-
// connection token — never the env-singleton.
//
// Idempotent at the Shopify level (the helper looks for a pre-existing
// (topic, callbackUrl) tuple before creating). Idempotent at the metadata
// level (we replace the whole `webhook_subscriptions` array on each run so
// re-registration after a callback URL change converges the persisted view).
// ============================================================================

const registerShopifyWebhookSubscriptionsSchema = z.object({
  connectionId: z.string().uuid(),
});

export type RegisterShopifyWebhookSubscriptionsReport = RegisterWebhookSubscriptionsResult & {
  callbackUrl: string;
  /** Whichever apiVersion all created subscriptions resolved to. Null when nothing succeeded. */
  apiVersionPinned: string | null;
  /** True when one or more subscriptions report a different apiVersion handle. Surfaces drift the deferred shopify-webhook-health-check task will catch on its own; surfacing it here lets the operator notice immediately. */
  apiVersionDrift: boolean;
  registeredAt: string;
};

export async function registerShopifyWebhookSubscriptions(input: {
  connectionId: string;
}): Promise<RegisterShopifyWebhookSubscriptionsReport> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = registerShopifyWebhookSubscriptionsSchema.parse(input);

  const serviceClient = createServiceRoleClient();
  const { data: conn, error: connErr } = await serviceClient
    .from("client_store_connections")
    .select("id, store_url, platform, api_key, metadata")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (connErr) throw new Error(`Connection lookup failed: ${connErr.message}`);
  if (!conn) throw new Error("Connection not found");
  if (conn.platform !== "shopify") {
    throw new Error("registerShopifyWebhookSubscriptions only applies to Shopify connections");
  }
  if (!conn.api_key) {
    throw new Error("Connection has no Shopify access token — complete the OAuth install first");
  }

  // Single canonical callback URL per connection. Both `connection_id` and
  // `platform` are query-string params on the live route; passing them here
  // means the route handler's `searchParams.get("connection_id")` resolves
  // even when Shopify forwards no other identifying header.
  const callbackUrl = `${env().NEXT_PUBLIC_APP_URL}/api/webhooks/client-store?connection_id=${conn.id}&platform=shopify`;

  const result = await registerWebhookSubscriptions(
    { storeUrl: conn.store_url, accessToken: conn.api_key },
    callbackUrl,
  );

  const apiVersions = new Set(result.registered.map((r) => r.apiVersion));
  const apiVersionPinned = result.registered[0]?.apiVersion ?? null;
  const apiVersionDrift = apiVersions.size > 1;
  const registeredAt = new Date().toISOString();

  // Merge into existing metadata rather than replacing — other code paths
  // (channel-sync logging, do_not_fanout flag rollouts, etc.) may write to
  // unrelated metadata keys. JSON-merge is structural so a stale array or
  // unrelated key never gets clobbered.
  const existingMeta = (
    conn.metadata && typeof conn.metadata === "object"
      ? (conn.metadata as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;
  const nextMeta = {
    ...existingMeta,
    webhook_callback_url: callbackUrl,
    webhook_subscriptions: result.registered.map((r) => ({
      id: r.id,
      topic: r.topic,
      apiVersion: r.apiVersion,
      callbackUrl: r.callbackUrl,
      reused: r.reused,
      registeredAt,
    })),
    webhook_register_failures: result.failed.length > 0 ? result.failed : undefined,
    webhook_register_last_run_at: registeredAt,
  };

  const { error: updateErr } = await serviceClient
    .from("client_store_connections")
    .update({ metadata: nextMeta, updated_at: registeredAt })
    .eq("id", data.connectionId);
  if (updateErr) {
    throw new Error(`Failed to persist webhook subscription metadata: ${updateErr.message}`);
  }

  return {
    ...result,
    callbackUrl,
    apiVersionPinned,
    apiVersionDrift,
    registeredAt,
  };
}

// ============================================================================
// HRD-04 + HRD-18 — runDirectShopifyDryRun
//
// Read-only reconciliation between local DB and remote Shopify for a single
// connection. Operator-controlled gate before flipping `do_not_fanout=false`.
//
// Three independent passes, all read-only:
//   A) Membership scan (full Shopify variant walk, same source as Step 4).
//      Surfaces the four HRD-04 fatal classes:
//        a) shopifyOnlySkus       — in Shopify, not in warehouse_product_variants
//        b) warehouseOnlySkus     — in warehouse, not in Shopify
//        c) duplicateShopifySkus  — same SKU on >1 Shopify variant (Rule #8)
//        d) shopifyVariantsWithoutSku — Shopify variant with empty SKU
//
//   B) Quantity drift sample (default 50 mapped SKUs, max 200). Calls
//      Shopify GraphQL nodes(ids:) for each remote_inventory_item_id and
//      compares against warehouse_inventory_levels.available. Returns
//      drift[] with per-SKU diffs sorted by absolute magnitude.
//
//   C) Bandwidth estimate (HRD-18). Cheap ordersCount over last 30 days,
//      computes avgDailyOrders, estimatedDailyWebhooks (× 2 for orders/create
//      + inventory_levels/update), peakHourlyRate (× 3 burst factor), and a
//      recommendation field used by the Section 0.D Thursday runbook.
//
// SC-1 success criteria: drift count ≤ 2% of sample size on the import
// target store within 1 hour of the baseline import.
//
// NEVER mutates Shopify or warehouse state. NEVER calls inventoryActivate
// (that's the live push path's job, HRD-26). The dry-run report is the
// artifact — operator reviews it and either flips `do_not_fanout=false` or
// remediates the surfaced issues first.
// ============================================================================

const runDirectShopifyDryRunSchema = z.object({
  connectionId: z.string().uuid(),
  sampleSize: z.number().int().min(1).max(200).optional(),
  /** HRD-18 disable for testing — skips the ordersCount call. */
  skipBandwidthEstimate: z.boolean().optional(),
});

export type DirectShopifyDryRunDriftRow = {
  sku: string;
  remoteInventoryItemId: string;
  localAvailable: number;
  remoteAvailable: number | null;
  diff: number;
  /** "diff" if numeric mismatch, "remote_not_stocked_at_location" if Shopify reported no level at default_location_id (HRD-26 will lazy-activate on first push), "remote_node_missing" if the inventory item GID was deleted between mapping and dry-run. */
  reason: "diff" | "remote_not_stocked_at_location" | "remote_node_missing";
};

export type DirectShopifyDryRunReport = {
  connectionId: string;
  defaultLocationId: string;
  generatedAt: string;
  durationMs: number;

  /** Membership pass (A) — same shape as autoDiscover's report. */
  membership: {
    shopifyVariantsScanned: number;
    shopifyProductsScanned: number;
    warehouseSkusInWorkspace: number;
    matchedSkus: number;
    shopifyOnlySkus: string[];
    warehouseOnlySkus: string[];
    duplicateShopifySkus: Array<{ sku: string; variantIds: string[] }>;
    shopifyVariantsWithoutSku: number;
    shopifyVariantsWithoutInventoryItem: number;
  };

  /** Quantity drift pass (B). */
  drift: {
    sampleSize: number;
    sampled: number;
    matched: number;
    drifted: number;
    rows: DirectShopifyDryRunDriftRow[];
  };

  /** Bandwidth estimate pass (C). Null when skipped or when ordersCount fails. */
  bandwidthEstimate: {
    windowDays: number;
    ordersInWindow: number;
    avgDailyOrders: number;
    estimatedDailyWebhooks: number;
    peakHourlyRate: number;
    recommendation: "safe_to_proceed" | "gradual_rollout";
  } | null;

  /** Aggregate verdict — `ok=true` only when zero fatal classes detected. */
  verdict: {
    ok: boolean;
    fatalReasons: string[];
    warnings: string[];
  };
};

export async function runDirectShopifyDryRun(input: {
  connectionId: string;
  sampleSize?: number;
  skipBandwidthEstimate?: boolean;
}): Promise<DirectShopifyDryRunReport> {
  const startedAt = Date.now();
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = runDirectShopifyDryRunSchema.parse(input);
  const sampleSize = data.sampleSize ?? 50;

  const serviceClient = createServiceRoleClient();

  // 1) Load the connection.
  const { data: conn, error: connErr } = await serviceClient
    .from("client_store_connections")
    .select("id, workspace_id, store_url, platform, api_key, default_location_id")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (connErr) throw new Error(`Connection lookup failed: ${connErr.message}`);
  if (!conn) throw new Error("Connection not found");
  if (conn.platform !== "shopify") {
    throw new Error("runDirectShopifyDryRun only applies to Shopify connections");
  }
  if (!conn.api_key) {
    throw new Error("Connection has no Shopify access token — complete the OAuth install first");
  }
  if (!conn.default_location_id) {
    throw new Error(
      "Connection has no default_location_id — complete Step 3 (default location) first",
    );
  }

  const ctx = { storeUrl: conn.store_url, accessToken: conn.api_key };

  // 2) PASS A — membership scan. Same walk as autoDiscover (read-only).
  const { data: variants, error: variantsErr } = await serviceClient
    .from("warehouse_product_variants")
    .select("id, sku")
    .eq("workspace_id", conn.workspace_id)
    .not("sku", "is", null);
  if (variantsErr) {
    throw new Error(`Variant universe load failed: ${variantsErr.message}`);
  }
  const warehouseSkus = new Set<string>();
  for (const v of variants ?? []) {
    if (typeof v.sku === "string" && v.sku.trim()) warehouseSkus.add(v.sku.trim());
  }

  const shopifySkuSeen = new Map<string, string[]>();
  const productIdsSeen = new Set<string>();
  let shopifyVariantsScanned = 0;
  let shopifyVariantsWithoutSku = 0;
  let shopifyVariantsWithoutInventoryItem = 0;

  for await (const page of iterateAllVariants(ctx)) {
    for (const v of page) {
      shopifyVariantsScanned++;
      productIdsSeen.add(v.productId);
      if (!v.sku) {
        shopifyVariantsWithoutSku++;
        continue;
      }
      if (!v.inventoryItemId) {
        shopifyVariantsWithoutInventoryItem++;
        continue;
      }
      const seen = shopifySkuSeen.get(v.sku) ?? [];
      seen.push(v.variantId);
      shopifySkuSeen.set(v.sku, seen);
    }
  }

  const matchedSkuSet = new Set<string>();
  const shopifyOnly: string[] = [];
  for (const sku of shopifySkuSeen.keys()) {
    if (warehouseSkus.has(sku)) matchedSkuSet.add(sku);
    else shopifyOnly.push(sku);
  }
  const warehouseOnly: string[] = [];
  for (const sku of warehouseSkus) {
    if (!matchedSkuSet.has(sku)) warehouseOnly.push(sku);
  }
  shopifyOnly.sort();
  warehouseOnly.sort();

  const duplicateShopifySkus: Array<{ sku: string; variantIds: string[] }> = [];
  for (const [sku, variantIds] of shopifySkuSeen.entries()) {
    if (variantIds.length > 1) duplicateShopifySkus.push({ sku, variantIds });
  }

  // 3) PASS B — quantity drift sample. Pull mappings, sample, fetch remote
  //    available, compare against warehouse_inventory_levels.available.
  const { data: mappings, error: mappingsErr } = await serviceClient
    .from("client_store_sku_mappings")
    .select("remote_sku, remote_inventory_item_id")
    .eq("connection_id", conn.id)
    .eq("is_active", true)
    .not("remote_inventory_item_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(sampleSize);
  if (mappingsErr) {
    throw new Error(`Mapping load failed: ${mappingsErr.message}`);
  }

  const sample = (mappings ?? []).filter(
    (m): m is { remote_sku: string; remote_inventory_item_id: string } =>
      typeof m.remote_sku === "string" && typeof m.remote_inventory_item_id === "string",
  );

  const driftRows: DirectShopifyDryRunDriftRow[] = [];
  let driftMatched = 0;

  if (sample.length > 0) {
    const remoteLevels = await getInventoryLevelsAtLocation(
      ctx,
      sample.map((s) => s.remote_inventory_item_id),
      conn.default_location_id,
    );

    // Local inventory lookup — workspace-scoped, sku-keyed.
    const sampleSkus = sample.map((s) => s.remote_sku);
    const { data: localLevels, error: localErr } = await serviceClient
      .from("warehouse_inventory_levels")
      .select("sku, available")
      .in("sku", sampleSkus);
    if (localErr) {
      throw new Error(`Local inventory load failed: ${localErr.message}`);
    }
    const localBySku = new Map<string, number>();
    for (const row of localLevels ?? []) {
      if (typeof row.sku === "string" && typeof row.available === "number") {
        localBySku.set(row.sku, row.available);
      }
    }

    for (const m of sample) {
      const localAvailable = localBySku.get(m.remote_sku) ?? 0;
      if (!remoteLevels.has(m.remote_inventory_item_id)) {
        driftRows.push({
          sku: m.remote_sku,
          remoteInventoryItemId: m.remote_inventory_item_id,
          localAvailable,
          remoteAvailable: null,
          diff: localAvailable,
          reason: "remote_node_missing",
        });
        continue;
      }
      const remoteAvailable = remoteLevels.get(m.remote_inventory_item_id);
      if (remoteAvailable === null || remoteAvailable === undefined) {
        driftRows.push({
          sku: m.remote_sku,
          remoteInventoryItemId: m.remote_inventory_item_id,
          localAvailable,
          remoteAvailable: null,
          diff: localAvailable,
          reason: "remote_not_stocked_at_location",
        });
        continue;
      }
      const diff = localAvailable - remoteAvailable;
      if (diff === 0) {
        driftMatched++;
        continue;
      }
      driftRows.push({
        sku: m.remote_sku,
        remoteInventoryItemId: m.remote_inventory_item_id,
        localAvailable,
        remoteAvailable,
        diff,
        reason: "diff",
      });
    }
  }

  // Sort drift rows by absolute diff DESC so the worst drift is at the top.
  driftRows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // 4) PASS C — bandwidth estimate (HRD-18). Optional, fail-soft.
  let bandwidthEstimate: DirectShopifyDryRunReport["bandwidthEstimate"] = null;
  if (!data.skipBandwidthEstimate) {
    try {
      bandwidthEstimate = await estimateOrderVolume(ctx, 30);
    } catch (err) {
      // Bandwidth estimate is informational — never fail the dry-run on it.
      console.warn(
        `[runDirectShopifyDryRun] ordersCount failed for connection ${conn.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5) Verdict aggregation.
  const fatalReasons: string[] = [];
  const warnings: string[] = [];
  if (duplicateShopifySkus.length > 0) {
    fatalReasons.push(
      `duplicate_shopify_skus:${duplicateShopifySkus.length} (Rule #8 — same SKU on >1 Shopify variant)`,
    );
  }
  if (shopifyOnly.length > 0) {
    fatalReasons.push(
      `shopify_only_skus:${shopifyOnly.length} (Shopify SKUs absent from warehouse_product_variants — webhook resolution will fail)`,
    );
  }
  if (shopifyVariantsWithoutSku > 0) {
    fatalReasons.push(
      `shopify_variants_without_sku:${shopifyVariantsWithoutSku} (variant has no SKU — inventory webhooks cannot route)`,
    );
  }
  if (warehouseOnly.length > 0) {
    warnings.push(
      `warehouse_only_skus:${warehouseOnly.length} (likely Bandcamp-only or legacy — informational)`,
    );
  }
  if (shopifyVariantsWithoutInventoryItem > 0) {
    warnings.push(
      `shopify_variants_without_inventory_item:${shopifyVariantsWithoutInventoryItem} (variant has SKU but no inventoryItem — Shopify-side data error)`,
    );
  }
  if (sample.length === 0) {
    warnings.push(
      "drift_sample_empty (no client_store_sku_mappings with remote_inventory_item_id — run Step 4 SKU discovery first)",
    );
  }
  if (sample.length > 0) {
    const driftPct = (driftRows.length / sample.length) * 100;
    if (driftPct > 2) {
      fatalReasons.push(
        `drift_above_threshold:${driftRows.length}/${sample.length} (${driftPct.toFixed(1)}% > SC-1 ceiling 2%)`,
      );
    } else if (driftRows.length > 0) {
      warnings.push(
        `drift_within_threshold:${driftRows.length}/${sample.length} (${driftPct.toFixed(1)}% — under SC-1 ceiling)`,
      );
    }
  }
  if (bandwidthEstimate?.recommendation === "gradual_rollout") {
    warnings.push(
      `bandwidth_high:${bandwidthEstimate.estimatedDailyWebhooks.toFixed(0)} webhooks/day estimated — Section 0.D recommends staggering this connection's flip`,
    );
  }

  return {
    connectionId: conn.id,
    defaultLocationId: conn.default_location_id,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    membership: {
      shopifyVariantsScanned,
      shopifyProductsScanned: productIdsSeen.size,
      warehouseSkusInWorkspace: warehouseSkus.size,
      matchedSkus: matchedSkuSet.size,
      shopifyOnlySkus: shopifyOnly.slice(0, 200),
      warehouseOnlySkus: warehouseOnly.slice(0, 200),
      duplicateShopifySkus: duplicateShopifySkus.slice(0, 100),
      shopifyVariantsWithoutSku,
      shopifyVariantsWithoutInventoryItem,
    },
    drift: {
      sampleSize,
      sampled: sample.length,
      matched: driftMatched,
      drifted: driftRows.length,
      rows: driftRows.slice(0, 100),
    },
    bandwidthEstimate,
    verdict: {
      ok: fatalReasons.length === 0,
      fatalReasons,
      warnings,
    },
  };
}
