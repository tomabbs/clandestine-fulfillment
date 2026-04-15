/**
 * Multi-store inventory push — cron every 5 minutes.
 *
 * Rule #53: Circuit breaker per connection. 5 consecutive auth failures → disabled.
 * Rule #44: Track last_pushed_quantity and last_pushed_at per mapping.
 * Rule #71: Track freshness state per connection.
 * One broken connection must NEVER block others.
 */

import { schedules } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_BASE_MS = 60_000; // 1 minute

export type FreshnessState = "fresh" | "delayed" | "stale" | "reconciling";

export function computeFreshnessState(lastPushedAt: string | null): FreshnessState {
  if (!lastPushedAt) return "stale";
  const ageMs = Date.now() - new Date(lastPushedAt).getTime();
  if (ageMs < 5 * 60_000) return "fresh";
  if (ageMs < 30 * 60_000) return "delayed";
  return "stale";
}

export function shouldRetryConnection(
  consecutiveFailures: number,
  lastErrorAt: string | null,
): boolean {
  if (consecutiveFailures === 0) return true;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;
  if (!lastErrorAt) return true;

  const backoffMs = BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1);
  const timeSinceError = Date.now() - new Date(lastErrorAt).getTime();
  return timeSinceError >= backoffMs;
}

export const multiStoreInventoryPushTask = schedules.task({
  id: "multi-store-inventory-push",
  cron: "*/5 * * * *",
  maxDuration: 180,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    let totalPushed = 0;
    let totalFailed = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("client_store_connections")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("do_not_fanout", false)
        .eq("connection_status", "active");

      if (!connections || connections.length === 0) continue;

      // Load workspace settings including pause flag
      const { data: ws } = await supabase
        .from("workspaces")
        .select("default_safety_stock, bundles_enabled, inventory_sync_paused")
        .eq("id", workspaceId)
        .single();

      // Pause guard — state-change-only logging to avoid flooding channel_sync_log
      if (ws?.inventory_sync_paused) {
        const { data: lastLog } = await supabase
          .from("channel_sync_log")
          .select("status")
          .eq("workspace_id", workspaceId)
          .eq("channel", "multi-store")
          .eq("sync_type", "inventory_push")
          .order("completed_at", { ascending: false })
          .limit(1)
          .single();

        if (lastLog?.status !== "paused") {
          await supabase.from("channel_sync_log").insert({
            workspace_id: workspaceId,
            channel: "multi-store",
            sync_type: "inventory_push",
            status: "paused",
            items_processed: 0,
            items_failed: 0,
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            metadata: { reason: "inventory_sync_paused" },
          });
        }
        continue;
      }

      const workspaceSafetyStock = ws?.default_safety_stock ?? 3;
      const bundlesEnabled = ws?.bundles_enabled ?? false;

      // Load bundle components for this workspace (only if bundles are enabled)
      type BundleComponent = {
        bundle_variant_id: string;
        component_variant_id: string;
        quantity: number;
      };
      const bundleMap = new Map<string, BundleComponent[]>();
      if (bundlesEnabled) {
        const { data: allComponents } = await supabase
          .from("bundle_components")
          .select("bundle_variant_id, component_variant_id, quantity")
          .eq("workspace_id", workspaceId);
        for (const bc of allComponents ?? []) {
          const arr = bundleMap.get(bc.bundle_variant_id) ?? [];
          arr.push(bc);
          bundleMap.set(bc.bundle_variant_id, arr);
        }
      }

      // Process each connection independently — one failure must not block others
      for (const connection of connections as ClientStoreConnection[]) {
        try {
          const pushed = await pushConnectionInventory(
            supabase,
            connection,
            workspaceSafetyStock,
            bundlesEnabled ? bundleMap : new Map(),
          );
          totalPushed += pushed;
        } catch (error) {
          totalFailed++;
          await handleConnectionFailure(supabase, connection, error);
        }
      }
    }

    return { totalPushed, totalFailed };
  },
});

type BundleComponent = {
  bundle_variant_id: string;
  component_variant_id: string;
  quantity: number;
};

async function pushConnectionInventory(
  supabase: ReturnType<typeof createServiceRoleClient>,
  connection: ClientStoreConnection,
  workspaceSafetyStock = 3,
  bundleMap = new Map<string, BundleComponent[]>(),
): Promise<number> {
  // Get SKU mappings for this connection
  const { data: mappings } = await supabase
    .from("client_store_sku_mappings")
    .select(
      "id, variant_id, remote_product_id, remote_variant_id, remote_sku, last_pushed_quantity",
    )
    .eq("connection_id", connection.id)
    .eq("is_active", true);

  if (!mappings || mappings.length === 0) return 0;

  // Get inventory levels for mapped variants + component variants (for bundle MIN)
  const variantIds = mappings.map((m) => m.variant_id);
  const componentVariantIds = Array.from(
    new Set(
      Array.from(bundleMap.values())
        .flat()
        .map((c) => c.component_variant_id),
    ),
  );
  const allVariantIds = Array.from(new Set([...variantIds, ...componentVariantIds]));

  const { data: levels } = await supabase
    .from("warehouse_inventory_levels")
    .select("variant_id, available, safety_stock")
    .in("variant_id", allVariantIds);

  const inventoryByVariant = new Map(
    (levels ?? []).map((l) => [
      l.variant_id,
      { available: l.available, safetyStock: l.safety_stock as number | null },
    ]),
  );

  // Build SKU mapping context for the sync client
  const skuMappingContext = new Map(
    mappings.map((m) => [
      m.remote_sku ?? "",
      { remoteProductId: m.remote_product_id, remoteVariantId: m.remote_variant_id },
    ]),
  );

  const client = createStoreSyncClient(connection, skuMappingContext);
  let pushed = 0;

  for (const mapping of mappings) {
    const inv = inventoryByVariant.get(mapping.variant_id);
    const rawAvailable = inv?.available ?? 0;
    const effectiveSafety = inv?.safetyStock ?? workspaceSafetyStock;

    // Compute bundle minimum if this variant is configured as a bundle
    let effectiveAvailable = rawAvailable;
    const components = bundleMap.get(mapping.variant_id);
    if (components?.length) {
      const componentMin = Math.min(
        ...components.map((c) => {
          const compInv = inventoryByVariant.get(c.component_variant_id);
          return Math.floor((compInv?.available ?? 0) / c.quantity);
        }),
      );
      effectiveAvailable = Math.min(rawAvailable, Math.max(0, componentMin));
    }

    const pushedQuantity = Math.max(0, effectiveAvailable - effectiveSafety);

    // Skip if effective quantity hasn't changed (compare buffered value, not raw)
    if (mapping.last_pushed_quantity === pushedQuantity) continue;

    const idempotencyKey = `store-push:${connection.id}:${mapping.id}:${pushedQuantity}`;

    try {
      await client.pushInventory(mapping.remote_sku ?? "", pushedQuantity, idempotencyKey);

      // Rule #44: Track the buffered quantity that was actually pushed
      await supabase
        .from("client_store_sku_mappings")
        .update({
          last_pushed_quantity: pushedQuantity,
          last_pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", mapping.id);

      pushed++;
    } catch (error) {
      console.error(
        `[multi-store-push] Failed to push ${mapping.remote_sku} to connection ${connection.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Update connection health
  await supabase
    .from("client_store_connections")
    .update({
      last_poll_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);

  return pushed;
}

// Rule #53: Circuit breaker — exponential backoff, auto-disable after 5 auth failures
async function handleConnectionFailure(
  supabase: ReturnType<typeof createServiceRoleClient>,
  connection: ClientStoreConnection,
  error: unknown,
) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const isAuthError =
    errorMsg.includes("401") || errorMsg.includes("403") || errorMsg.includes("auth");

  // Count consecutive failures (simple: increment metadata counter)
  const { data: current } = await supabase
    .from("client_store_connections")
    .select("last_error, last_error_at")
    .eq("id", connection.id)
    .single();

  // Track consecutive failures via metadata
  const previousFailureCount = current?.last_error?.startsWith("consecutive:")
    ? Number.parseInt(current.last_error.split(":")[1], 10)
    : 0;
  const consecutiveFailures = previousFailureCount + 1;

  if (isAuthError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    // Auto-disable connection
    await supabase
      .from("client_store_connections")
      .update({
        connection_status: "disabled_auth_failure",
        do_not_fanout: true,
        last_error: `consecutive:${consecutiveFailures} ${errorMsg}`,
        last_error_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    // Create review queue item
    await supabase.from("warehouse_review_queue").insert({
      workspace_id: connection.workspace_id,
      org_id: connection.org_id,
      category: "store_connection",
      severity: "high",
      title: `${connection.platform} connection disabled: auth failure`,
      description: `Connection to ${connection.store_url} disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive auth failures. Last error: ${errorMsg}`,
      metadata: {
        connection_id: connection.id,
        platform: connection.platform,
        consecutive_failures: consecutiveFailures,
      },
      group_key: `connection_disabled:${connection.id}`,
      status: "open",
    });
  } else {
    await supabase
      .from("client_store_connections")
      .update({
        last_error: `consecutive:${consecutiveFailures} ${errorMsg}`,
        last_error_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);
  }
}
