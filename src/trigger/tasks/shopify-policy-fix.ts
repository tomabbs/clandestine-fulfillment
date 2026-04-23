/**
 * Phase 0 / §9.1 D3 — `shopify-policy-fix` Trigger task.
 *
 * Auto-remediation companion to `shopify-policy-audit`. Enqueued by the
 * `auditShopifyPolicy({ fixMode: 'fix_drift' })` Server Action when a staff
 * user explicitly opts to flip drifted SKUs back to DENY.
 *
 * Why a Trigger task and not inline in the Server Action:
 *   - Rule #48: Server Actions never call Shopify mutation APIs directly
 *     (avoids token-family contention with crons).
 *   - Rule #41: Bounded execution — even a small estate fix can hit the
 *     30s soft ceiling once we factor in throttle backoff.
 *   - Trigger queue serialization keeps the fix from racing the daily
 *     audit cron + the per-SKU push tasks.
 *
 * Behavior contract:
 *   - Re-loads the drift set fresh from `client_store_sku_mappings`
 *     (NOT from the inbound payload — the audit might be minutes old).
 *     A SKU's drift is "real" if BOTH `last_inventory_policy = 'CONTINUE'`
 *     AND `preorder_whitelist = false`.
 *   - Resolves each drifted mapping to its `(productId, variantId)` pair
 *     by re-querying Shopify for the inventory_item_id → variant lookup
 *     (we cached `remote_variant_id` + `remote_product_id` at
 *     `autoDiscoverShopifySkus` time, so this is a DB read).
 *   - Calls `productVariantsBulkUpdate` per product (Rule #1: NEVER
 *     productSet for edits) flipping `inventoryPolicy` to DENY.
 *   - Records each successful flip back onto the mapping
 *     (`last_inventory_policy = 'DENY'`, `last_policy_check_at = now()`)
 *     so the next audit run sees a clean slate without a redundant walk.
 *   - Surfaces failures per-SKU on a `warehouse_review_queue` item
 *     (group_key `policy-fix-failed:{workspaceId}:{connectionId}`),
 *     status='healthy' on the sensor when zero failures.
 *
 * Plan: bandcamp_shopify_enterprise_sync_a448cf6a.plan.md §9.1 D3.
 */

import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod/v4";
import {
  type ConnectionShopifyContext,
  connectionShopifyGraphQL,
  ShopifyScopeError,
} from "@/lib/server/shopify-connection-graphql";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

const PAYLOAD_SCHEMA = z.object({
  connectionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  triggeredBy: z.string().uuid(),
});

interface MappingDriftRow {
  id: string;
  remote_sku: string | null;
  remote_variant_id: string | null;
  remote_product_id: string | null;
  remote_inventory_item_id: string | null;
}

interface FixOutcome {
  sku: string;
  variantId: string | null;
  status: "fixed" | "skipped_no_remote_ids" | "failed";
  error?: string;
}

const POLICY_UPDATE_MUTATION = `
  mutation PolicyFix($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id inventoryPolicy }
      userErrors { field message }
    }
  }
`;

interface PolicyUpdateResponse {
  productVariantsBulkUpdate: {
    productVariants: Array<{ id: string; inventoryPolicy: "DENY" | "CONTINUE" }>;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

export const shopifyPolicyFixTask = schemaTask({
  id: "shopify-policy-fix",
  schema: PAYLOAD_SCHEMA,
  queue: shipstationQueue,
  maxDuration: 600,
  run: async (payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    logger.info("shopify-policy-fix started", {
      runId: ctx.run.id,
      connection_id: payload.connectionId,
      triggered_by: payload.triggeredBy,
    });

    const { data: conn, error: connErr } = await supabase
      .from("client_store_connections")
      .select("id, workspace_id, store_url, platform, api_key")
      .eq("id", payload.connectionId)
      .maybeSingle();
    if (connErr) throw new Error(`Connection lookup failed: ${connErr.message}`);
    if (!conn) throw new Error("Connection not found");
    if (conn.platform !== "shopify") {
      throw new Error("shopify-policy-fix only applies to Shopify connections");
    }
    if (!conn.api_key) {
      throw new Error("Connection has no Shopify access token — cannot fix");
    }

    // Re-load the drift set FRESH (not from the inbound payload — the
    // audit that triggered this run could be minutes stale, and a
    // pre-order-whitelist toggle in the meantime should be honored).
    const { data: drifted, error: driftErr } = await supabase
      .from("client_store_sku_mappings")
      .select("id, remote_sku, remote_variant_id, remote_product_id, remote_inventory_item_id")
      .eq("connection_id", payload.connectionId)
      .eq("is_active", true)
      .eq("last_inventory_policy", "CONTINUE")
      .eq("preorder_whitelist", false);
    if (driftErr) throw driftErr;

    if (!drifted?.length) {
      logger.info("shopify-policy-fix: no drift to remediate", { runId: ctx.run.id });
      await supabase.from("sensor_readings").insert({
        workspace_id: conn.workspace_id,
        sensor_name: "trigger:shopify-policy-fix",
        status: "healthy",
        message: `No drift detected on ${conn.store_url}; nothing to fix.`,
        metadata: { connection_id: payload.connectionId, fixed: 0 },
      });
      return { status: "ok", fixed: 0, failed: 0, skipped: 0 };
    }

    const ctx_: ConnectionShopifyContext = {
      storeUrl: conn.store_url,
      accessToken: conn.api_key,
    };

    // Group drift by Shopify productId so each productVariantsBulkUpdate
    // call can carry every drifted variant on the same product in one
    // mutation (Shopify accepts up to 100 variants per call).
    const byProduct = new Map<string, MappingDriftRow[]>();
    const skipped: FixOutcome[] = [];
    for (const row of drifted) {
      if (!row.remote_product_id || !row.remote_variant_id) {
        skipped.push({
          sku: row.remote_sku ?? row.id,
          variantId: row.remote_variant_id,
          status: "skipped_no_remote_ids",
        });
        continue;
      }
      const list = byProduct.get(row.remote_product_id) ?? [];
      list.push(row);
      byProduct.set(row.remote_product_id, list);
    }

    const outcomes: FixOutcome[] = [...skipped];
    const nowIso = new Date().toISOString();

    for (const [productId, rows] of byProduct.entries()) {
      const variantInputs = rows.map((r) => ({
        id: r.remote_variant_id as string,
        inventoryPolicy: "DENY" as const,
      }));

      try {
        const data = await connectionShopifyGraphQL<PolicyUpdateResponse>(
          ctx_,
          POLICY_UPDATE_MUTATION,
          {
            productId,
            variants: variantInputs,
          },
        );

        const userErrors = data.productVariantsBulkUpdate.userErrors ?? [];
        if (userErrors.length > 0) {
          // userErrors are typically per-variant; mark every variant on
          // this product as failed and let the operator triage.
          for (const r of rows) {
            outcomes.push({
              sku: r.remote_sku ?? r.id,
              variantId: r.remote_variant_id,
              status: "failed",
              error: userErrors.map((e) => e.message).join("; "),
            });
          }
          continue;
        }

        // Success — update each mapping's persisted snapshot so the next
        // audit run starts clean without an extra walk.
        for (const r of rows) {
          await supabase
            .from("client_store_sku_mappings")
            .update({ last_inventory_policy: "DENY", last_policy_check_at: nowIso })
            .eq("id", r.id);
          outcomes.push({
            sku: r.remote_sku ?? r.id,
            variantId: r.remote_variant_id,
            status: "fixed",
          });
        }
      } catch (err) {
        const isScope = err instanceof ShopifyScopeError;
        for (const r of rows) {
          outcomes.push({
            sku: r.remote_sku ?? r.id,
            variantId: r.remote_variant_id,
            status: "failed",
            error: isScope
              ? `scope_error: ${(err as ShopifyScopeError).message}`
              : err instanceof Error
                ? err.message
                : String(err),
          });
        }
      }
    }

    const fixed = outcomes.filter((o) => o.status === "fixed").length;
    const failed = outcomes.filter((o) => o.status === "failed").length;
    const skippedCount = outcomes.filter((o) => o.status === "skipped_no_remote_ids").length;

    if (failed > 0) {
      const groupKey = `policy-fix-failed:${conn.workspace_id}:${payload.connectionId}`;
      const failedSkus = outcomes.filter((o) => o.status === "failed").map((o) => o.sku);
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: conn.workspace_id,
        category: "shopify_policy_fix_failed",
        severity: "high",
        title: `Shopify policy auto-fix failed for ${failed} SKU(s) on ${conn.store_url}`,
        description: `Sample SKUs: ${failedSkus.slice(0, 10).join(", ")}${failedSkus.length > 10 ? "…" : ""}. Triggered by user ${payload.triggeredBy}; run ${ctx.run.id}.`,
        metadata: {
          connection_id: payload.connectionId,
          run_id: ctx.run.id,
          failed_count: failed,
          failed_skus_sample: failedSkus.slice(0, 50),
          triggered_by: payload.triggeredBy,
        },
        group_key: groupKey,
      });
    }

    await supabase.from("sensor_readings").insert({
      workspace_id: conn.workspace_id,
      sensor_name: "trigger:shopify-policy-fix",
      status: failed > 0 ? "unhealthy" : "healthy",
      message: `Fixed ${fixed} drift SKU(s) on ${conn.store_url}; ${failed} failed; ${skippedCount} skipped.`,
      metadata: {
        connection_id: payload.connectionId,
        fixed,
        failed,
        skipped: skippedCount,
        triggered_by: payload.triggeredBy,
      },
    });

    logger.info("shopify-policy-fix complete", {
      runId: ctx.run.id,
      fixed,
      failed,
      skipped: skippedCount,
    });

    return { status: "ok", fixed, failed, skipped: skippedCount, outcomes };
  },
});
