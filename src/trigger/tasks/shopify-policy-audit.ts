/**
 * Phase 0 / §9.1 D2 — `shopify-policy-audit` Trigger task (AUTHORITATIVE
 * mode).
 *
 * What:
 *   Walks every Shopify variant for every active client_store_connections
 *   row (platform='shopify'), reads `variant.inventoryPolicy` +
 *   `variant.inventoryItem.tracked`, and persists the snapshot back onto
 *   the matching `client_store_sku_mappings` row
 *   (`last_inventory_policy`, `last_policy_check_at`).
 *
 * Why:
 *   `inventoryPolicy = CONTINUE` means Shopify will sell past zero —
 *   guaranteed oversell when our DENY-policy push formula assumes the
 *   merchant honors stock. The audit catches drift introduced by:
 *     (a) merchant-side bulk edits in Shopify admin,
 *     (b) third-party apps that mass-flip CONTINUE for "draft" / "pre-order"
 *         workflows,
 *     (c) imported variants that ignore our productSet defaults.
 *
 * Behavior:
 *   - AUTHORITATIVE mode: this task is the persistence path. The Server
 *     Action (auditShopifyPolicy) shells out to the same helper but for
 *     a single connection and with optional auto-fix.
 *   - Drift = (last_inventory_policy === 'CONTINUE' AND preorder_whitelist
 *     === false). Drift surfaces as the new `policy_drift` Channels health
 *     state (D2 b) AND opens a critical review queue item (group_key
 *     stable per (workspace_id, connection_id) so re-detections increment
 *     occurrence_count rather than spam).
 *   - SKUs flagged `preorder_whitelist=true` in the SKU mapping are
 *     LEGITIMATELY allowed to be CONTINUE (label policy: customers may
 *     order a pre-order while we backorder) — the audit records the value
 *     but does not raise.
 *
 * Idempotency:
 *   - Stable group_key per (workspace_id, connection_id) for the review
 *     queue UPSERT. Re-runs bump occurrence_count.
 *   - Persisted policy snapshot is overwritten every run; we only care
 *     about the LATEST observation, not the history. Operators wanting
 *     history can read `webhook_events` (when the policy flip arrived
 *     via webhook) or the Shopify GraphQL events log.
 *
 * Failure modes:
 *   - ShopifyScopeError → log + sensor `shopify_policy_audit_scope_error`,
 *     do NOT crash the cron — other connections still get audited.
 *   - Throttled / 429 → handled by `connectionShopifyGraphQL` retry loop;
 *     surface as `partial` in the per-connection report.
 *   - Mapping missing remote_inventory_item_id (legacy rows from before
 *     HRD-03) → skipped silently with a count in the report; the
 *     auto-discover Server Action backfills these.
 *
 * Plan: bandcamp_shopify_enterprise_sync_a448cf6a.plan.md §9.1 D2.
 */

import { logger, schedules } from "@trigger.dev/sdk";
import {
  type ConnectionShopifyContext,
  connectionShopifyGraphQL,
  ShopifyScopeError,
} from "@/lib/server/shopify-connection-graphql";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

// ─── GraphQL — variant.inventoryPolicy + inventoryItem.tracked walk ────────
//
// Pinned to `2026-01` here (same as the rest of the per-connection client
// surface). The 2026-04 bump (CAS `changeFromQuantity` + `@idempotent`) is a
// separate sequenced env-var change per X-6, but the policy-audit query is
// API-version-agnostic — `inventoryPolicy` has been stable on the
// `ProductVariant` type since 2024-01.

interface AuditVariantRow {
  productId: string;
  variantId: string;
  sku: string | null;
  inventoryItemId: string | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  inventoryTracked: boolean | null;
}

const AUDIT_QUERY = `
  query PolicyAuditWalk($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT) {
      edges {
        node {
          id
          variants(first: 100) {
            edges {
              node {
                id
                sku
                inventoryPolicy
                inventoryItem { id tracked }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface WalkPage {
  products: {
    edges: Array<{
      node: {
        id: string;
        variants: {
          edges: Array<{
            node: {
              id: string;
              sku: string | null;
              inventoryPolicy: "DENY" | "CONTINUE";
              inventoryItem: { id: string; tracked: boolean | null } | null;
            };
          }>;
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function* iterateAllVariantsForAudit(
  ctx: ConnectionShopifyContext,
): AsyncGenerator<AuditVariantRow[]> {
  let cursor: string | null = null;
  while (true) {
    const data: WalkPage = await connectionShopifyGraphQL<WalkPage>(ctx, AUDIT_QUERY, {
      first: 50,
      after: cursor,
    });

    const flat: AuditVariantRow[] = [];
    for (const { node: product } of data.products.edges) {
      for (const { node: variant } of product.variants.edges) {
        flat.push({
          productId: product.id,
          variantId: variant.id,
          sku: variant.sku?.trim() || null,
          inventoryItemId: variant.inventoryItem?.id ?? null,
          inventoryPolicy: variant.inventoryPolicy,
          inventoryTracked: variant.inventoryItem?.tracked ?? null,
        });
      }
    }
    yield flat;

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
    if (!cursor) break;
  }
}

// ─── Per-connection audit body — exported for the Server Action and tests ─

export interface PolicyAuditConnectionReport {
  connectionId: string;
  workspaceId: string;
  storeUrl: string;
  status: "ok" | "scope_error" | "throttled" | "failed" | "skipped";
  variantsScanned: number;
  mappingsUpdated: number;
  driftCount: number;
  /** Mappings with no remote_inventory_item_id — silently skipped, surfaced as a count for HRD-03 backfill triage. */
  unmappedSkipped: number;
  /** Distinct SKUs with policy=CONTINUE && preorder_whitelist=false — what opens the review queue item. */
  driftSkus: string[];
  error?: string;
}

interface AuditConnectionRow {
  id: string;
  workspace_id: string;
  store_url: string;
  api_key: string | null;
}

/**
 * Audit a single Shopify connection. Pure DB I/O + Shopify reads + DB
 * writes — no review-queue side-effects. The cron (and the Server Action)
 * is responsible for translating the report into review-queue UPSERTs +
 * sensor readings, so unit tests can exercise the audit body without
 * needing a review-queue mock.
 */
export async function auditShopifyConnection(
  supabase: ReturnType<typeof createServiceRoleClient>,
  connection: AuditConnectionRow,
): Promise<PolicyAuditConnectionReport> {
  const baseReport: Omit<PolicyAuditConnectionReport, "status"> = {
    connectionId: connection.id,
    workspaceId: connection.workspace_id,
    storeUrl: connection.store_url,
    variantsScanned: 0,
    mappingsUpdated: 0,
    driftCount: 0,
    unmappedSkipped: 0,
    driftSkus: [],
  };

  if (!connection.api_key) {
    return { ...baseReport, status: "skipped", error: "no_access_token" };
  }

  // Load every active mapping for this connection up front. We index by
  // remote_inventory_item_id to make the Shopify-side join O(variants).
  // Mappings without remote_inventory_item_id are NOT joinable here and
  // get counted as `unmappedSkipped` for HRD-03 backfill triage.
  const { data: mappings, error: mErr } = await supabase
    .from("client_store_sku_mappings")
    .select("id, remote_inventory_item_id, remote_sku, preorder_whitelist")
    .eq("connection_id", connection.id)
    .eq("is_active", true);
  if (mErr) {
    return { ...baseReport, status: "failed", error: `mapping_load_failed: ${mErr.message}` };
  }

  const byInventoryItem = new Map<
    string,
    { id: string; remote_sku: string | null; preorder_whitelist: boolean }
  >();
  let unmappedSkipped = 0;
  for (const m of mappings ?? []) {
    if (!m.remote_inventory_item_id) {
      unmappedSkipped += 1;
      continue;
    }
    byInventoryItem.set(m.remote_inventory_item_id, {
      id: m.id,
      remote_sku: m.remote_sku ?? null,
      preorder_whitelist: m.preorder_whitelist ?? false,
    });
  }

  const ctx: ConnectionShopifyContext = {
    storeUrl: connection.store_url,
    accessToken: connection.api_key,
  };

  let variantsScanned = 0;
  let mappingsUpdated = 0;
  const driftSkus: string[] = [];
  const nowIso = new Date().toISOString();

  try {
    for await (const page of iterateAllVariantsForAudit(ctx)) {
      variantsScanned += page.length;
      for (const v of page) {
        if (!v.inventoryItemId) continue;
        const mapping = byInventoryItem.get(v.inventoryItemId);
        if (!mapping) continue;

        // Persist EVERY observation (DENY or CONTINUE) so the Channels
        // page can show "audited X minutes ago" as a confidence signal.
        const { error: upErr } = await supabase
          .from("client_store_sku_mappings")
          .update({
            last_inventory_policy: v.inventoryPolicy,
            last_policy_check_at: nowIso,
          })
          .eq("id", mapping.id);
        if (upErr) {
          logger.warn("[shopify-policy-audit] mapping update failed", {
            mapping_id: mapping.id,
            connection_id: connection.id,
            error: upErr.message,
          });
          continue;
        }
        mappingsUpdated += 1;

        if (v.inventoryPolicy === "CONTINUE" && !mapping.preorder_whitelist) {
          // Resolve a human-readable SKU for the review queue. Fall back
          // to the variant GID so the row is still actionable.
          driftSkus.push(mapping.remote_sku ?? v.sku ?? v.variantId);
        }
      }
    }
  } catch (err) {
    if (err instanceof ShopifyScopeError) {
      return {
        ...baseReport,
        variantsScanned,
        mappingsUpdated,
        unmappedSkipped,
        status: "scope_error",
        error: err.message,
      };
    }
    return {
      ...baseReport,
      variantsScanned,
      mappingsUpdated,
      unmappedSkipped,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ...baseReport,
    variantsScanned,
    mappingsUpdated,
    unmappedSkipped,
    driftCount: driftSkus.length,
    driftSkus,
    status: "ok",
  };
}

// ─── Review queue + sensor reconciliation ─────────────────────────────────

/**
 * Translate a single per-connection report into:
 *   1. A `warehouse_review_queue` UPSERT keyed on group_key
 *      `policy-drift:{workspace_id}:{connection_id}` (Rule #55 dedup).
 *      OPEN review item when driftSkus.length > 0; otherwise auto-resolve
 *      the matching open row (drift cleared in Shopify since last run).
 *   2. A `sensor_readings` row with status derived from the report:
 *        - ok / driftCount=0 → 'healthy'
 *        - ok / driftCount>0 → 'partial'
 *        - scope_error / throttled / failed → 'unhealthy'
 *        - skipped (no token) → 'unknown'
 */
async function persistConnectionReport(
  supabase: ReturnType<typeof createServiceRoleClient>,
  report: PolicyAuditConnectionReport,
): Promise<void> {
  const groupKey = `policy-drift:${report.workspaceId}:${report.connectionId}`;

  const { data: existing } = await supabase
    .from("warehouse_review_queue")
    .select("id, status, occurrence_count")
    .eq("group_key", groupKey)
    .maybeSingle();

  if (report.status === "ok" && report.driftCount === 0) {
    if (existing && existing.status !== "resolved") {
      await supabase
        .from("warehouse_review_queue")
        .update({
          status: "resolved",
          resolved_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    }
  } else if (report.driftCount > 0) {
    const payload = {
      workspace_id: report.workspaceId,
      category: "shopify_policy_drift",
      severity: "critical" as const,
      title: `Shopify inventoryPolicy=CONTINUE on ${report.driftCount} SKU(s) — oversell risk`,
      description: `Connection ${report.storeUrl} has ${report.driftCount} variant(s) flipped to CONTINUE. Sample SKUs: ${report.driftSkus.slice(0, 10).join(", ")}${
        report.driftSkus.length > 10 ? "…" : ""
      }`,
      metadata: {
        connection_id: report.connectionId,
        store_url: report.storeUrl,
        drift_count: report.driftCount,
        drift_skus_sample: report.driftSkus.slice(0, 50),
      },
      group_key: groupKey,
    };

    if (!existing) {
      await supabase.from("warehouse_review_queue").insert(payload);
    } else if (existing.status === "resolved" || existing.status === "suppressed") {
      await supabase
        .from("warehouse_review_queue")
        .update({
          status: "open",
          resolved_at: null,
          resolved_by: null,
          occurrence_count: (existing.occurrence_count ?? 1) + 1,
          metadata: payload.metadata,
          description: payload.description,
        })
        .eq("id", existing.id);
    } else {
      await supabase
        .from("warehouse_review_queue")
        .update({
          occurrence_count: (existing.occurrence_count ?? 1) + 1,
          metadata: payload.metadata,
          description: payload.description,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    }
  }

  const sensorStatus =
    report.status === "ok" && report.driftCount === 0
      ? "healthy"
      : report.status === "ok"
        ? "partial"
        : report.status === "skipped"
          ? "unknown"
          : "unhealthy";

  await supabase.from("sensor_readings").insert({
    workspace_id: report.workspaceId,
    sensor_name: "trigger:shopify-policy-audit",
    status: sensorStatus,
    message: `${report.storeUrl}: scanned ${report.variantsScanned} variants, updated ${report.mappingsUpdated} mappings, drift=${report.driftCount}${report.error ? ` (${report.error})` : ""}`,
    metadata: {
      connection_id: report.connectionId,
      drift_count: report.driftCount,
      unmapped_skipped: report.unmappedSkipped,
      status: report.status,
    },
  });
}

// ─── Cron task — daily at 04:00 UTC ───────────────────────────────────────

export const shopifyPolicyAuditTask = schedules.task({
  id: "shopify-policy-audit",
  // Reuses the shipstation queue solely as a serialization fence — Shopify
  // GraphQL has its own per-store throttle, but pinning the cron to a queue
  // with concurrencyLimit:1 stops a single cron tick from blowing past
  // Shopify's leaky-bucket if multiple connections hit a paginated walk
  // at the same time. Per-connection retries already live inside
  // connectionShopifyGraphQL; we don't need parallel fan-out here.
  queue: shipstationQueue,
  // Walking 50 products/page × N pages × M connections — plus 1.5s/page
  // throttle headroom — runs in single-digit minutes for a typical estate.
  // 30-min ceiling matches sku-sync-audit and keeps Trigger from killing
  // a stuck run.
  maxDuration: 1800,
  // Daily at 04:00 UTC = 11pm-ish ET. Outside warehouse hours, well after
  // the 02:00 sku-sync-audit, well before the 09:00 deferred-followups
  // cron. Avoids stacking cron-time concurrency on the shared queue.
  cron: "0 4 * * *",
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    logger.info("shopify-policy-audit started", { runId: ctx.run.id });

    const { data: connections, error: cErr } = await supabase
      .from("client_store_connections")
      .select("id, workspace_id, store_url, api_key, connection_status, do_not_fanout")
      .eq("platform", "shopify")
      .in("connection_status", ["active", "pending"]);
    if (cErr) throw cErr;
    if (!connections?.length) {
      logger.warn("shopify-policy-audit: no active Shopify connections");
      return { status: "skipped", reason: "no_connections" };
    }

    let totalDrift = 0;
    let totalScanned = 0;
    const perConnection: PolicyAuditConnectionReport[] = [];

    for (const conn of connections) {
      // We DO audit do_not_fanout connections — the audit reads policy,
      // it doesn't write inventory. Drift is just as dangerous on a
      // paused connection because un-pausing is when oversell happens.
      try {
        const report = await auditShopifyConnection(supabase, conn);
        perConnection.push(report);
        totalScanned += report.variantsScanned;
        totalDrift += report.driftCount;
        await persistConnectionReport(supabase, report);
      } catch (err) {
        // auditShopifyConnection() already catches its own errors and
        // returns status='failed'. This catches truly unexpected throws
        // (bug in our own helper, OOM, etc.) — log and continue so the
        // cron keeps auditing other connections.
        logger.error("[shopify-policy-audit] connection threw", {
          connection_id: conn.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("shopify-policy-audit complete", {
      runId: ctx.run.id,
      connections: connections.length,
      total_scanned: totalScanned,
      total_drift: totalDrift,
    });

    return {
      status: "ok",
      connections: connections.length,
      total_scanned: totalScanned,
      total_drift: totalDrift,
      per_connection: perConnection,
    };
  },
});

// Exported for Server Action + tests.
export { iterateAllVariantsForAudit, persistConnectionReport };
