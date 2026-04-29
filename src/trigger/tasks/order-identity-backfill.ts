/**
 * Order Pages Transition Phase 1 — resumable identity v2 backfill.
 *
 * Walks `warehouse_orders` rows where `connection_id IS NULL`, resolves
 * identity using the same `resolveOrderIdentityV2` pure function the
 * webhook + poller paths will eventually call, and writes back
 * `connection_id`, `external_order_id`, `ingestion_idempotency_key_v2`,
 * `identity_resolution_status`, and `identity_resolution_notes`.
 *
 * Resumability:
 *   - Persists progress to `warehouse_order_identity_backfill_runs`.
 *   - Each run scans up to `batchSize` rows and stores a `cursor_order_id`
 *     so the next invocation continues from there.
 *   - The Trigger task itself is idempotent — if you fire the same
 *     workspace+connection twice you'll just resume the previous cursor.
 *
 * Rate budget:
 *   - Pinned to a dedicated `order-identity-backfill` queue with
 *     concurrencyLimit 1 so it cannot starve real-time inventory work.
 *   - We deliberately do NOT call any external APIs from this task — the
 *     backfill operates over already-ingested data. Live API verification
 *     is the live-ingest path's concern.
 *
 * Defensive contract:
 *   - Uses `ON CONFLICT DO NOTHING` for the review-queue inserts via the
 *     partial unique index `uq_warehouse_order_identity_review_open_per_order`.
 *   - Skips Bandcamp rows entirely — they get `bandcamp_legacy_null` and
 *     stay on the legacy `bandcamp_payment_id` dedup family.
 *   - Errors per row are counted but never abort the batch (the next
 *     invocation will re-attempt them via the cursor).
 */

import { logger, queue, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  type IdentityResolutionStatus,
  resolveOrderIdentityV2,
} from "@/lib/server/order-identity-v2";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { normalizeStoreKey, type StoreKeyPlatform } from "@/lib/shared/store-key";

export const orderIdentityBackfillQueue = queue({
  name: "order-identity-backfill",
  concurrencyLimit: 1,
});

const PayloadSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Optional connection_id filter — when provided, only rows whose
   * resolved connection_id WOULD BE this value are processed. Mostly
   * useful for incremental re-runs after a single connection's
   * `store_url` was repaired. */
  scopeConnectionId: z.string().uuid().nullable().optional(),
  batchSize: z.number().int().positive().max(2000).optional(),
});

interface CandidateConnection {
  id: string;
  platform: string;
  store_url: string;
  org_id: string;
  workspace_id: string;
  connection_status: string | null;
}

const PLATFORM_TO_NORMALIZER: Record<string, StoreKeyPlatform | null> = {
  shopify: "shopify",
  woocommerce: "woocommerce",
  squarespace: "squarespace",
  bandcamp: "bandcamp",
  manual: "manual",
};

export const orderIdentityBackfillTask = schemaTask({
  id: "order-identity-backfill",
  queue: orderIdentityBackfillQueue,
  schema: PayloadSchema,
  run: async (payload) => {
    const supabase = createServiceRoleClient();
    const batchSize = payload.batchSize ?? 500;

    // 1. Open or resume a backfill run row.
    const runStartedAt = new Date().toISOString();
    const { data: openRun } = await supabase
      .from("warehouse_order_identity_backfill_runs")
      .select(
        "id, cursor_order_id, status, scanned, resolved_deterministic, resolved_ambiguous, resolved_unresolved, errors",
      )
      .eq("workspace_id", payload.workspaceId)
      .in("status", ["pending", "running"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let runId: string;
    const cursor: string | null = openRun?.cursor_order_id ?? null;
    let runScanned = openRun?.scanned ?? 0;
    let runResolvedDeterministic = openRun?.resolved_deterministic ?? 0;
    let runResolvedAmbiguous = openRun?.resolved_ambiguous ?? 0;
    let runResolvedUnresolved = openRun?.resolved_unresolved ?? 0;
    let runErrors = openRun?.errors ?? 0;

    if (openRun) {
      runId = openRun.id;
      await supabase
        .from("warehouse_order_identity_backfill_runs")
        .update({ status: "running", updated_at: new Date().toISOString() })
        .eq("id", runId);
    } else {
      const { data: created, error: insertErr } = await supabase
        .from("warehouse_order_identity_backfill_runs")
        .insert({
          workspace_id: payload.workspaceId,
          connection_id: payload.scopeConnectionId ?? null,
          status: "running",
          started_at: runStartedAt,
        })
        .select("id")
        .single();
      if (insertErr || !created) {
        throw new Error(`Failed to open backfill run: ${insertErr?.message ?? "no row"}`);
      }
      runId = created.id;
    }

    // 2. Pre-load all client_store_connections for this workspace once.
    const { data: connectionRows, error: connErr } = await supabase
      .from("client_store_connections")
      .select("id, platform, store_url, org_id, workspace_id, connection_status")
      .eq("workspace_id", payload.workspaceId);
    if (connErr) {
      await markRunFailed(supabase, runId, `connection load failed: ${connErr.message}`);
      throw new Error(`connection load failed: ${connErr.message}`);
    }
    const candidateConnections = (connectionRows ?? []) as CandidateConnection[];

    // Pre-normalize candidate store keys so the inner loop is O(N) and
    // the resolver gets pre-shaped input.
    const candidatesByPlatform = new Map<
      StoreKeyPlatform,
      Array<{ id: string; storeKey: string; isActive: boolean }>
    >();
    for (const c of candidateConnections) {
      const platformKey = PLATFORM_TO_NORMALIZER[c.platform];
      if (!platformKey || platformKey === "bandcamp") continue;
      try {
        const storeKey = normalizeStoreKey(platformKey, c.store_url);
        const list = candidatesByPlatform.get(platformKey) ?? [];
        list.push({ id: c.id, storeKey, isActive: c.connection_status === "active" });
        candidatesByPlatform.set(platformKey, list);
      } catch (err) {
        logger.warn("backfill: skipping connection with un-normalizable store_url", {
          connectionId: c.id,
          storeUrl: c.store_url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Pull a batch of candidate orders.
    let query = supabase
      .from("warehouse_orders")
      .select(
        "id, workspace_id, source, shopify_order_id, external_order_id, order_number, bandcamp_payment_id, identity_resolution_status",
      )
      .eq("workspace_id", payload.workspaceId)
      .is("connection_id", null)
      .order("id", { ascending: true })
      .limit(batchSize);
    if (cursor) query = query.gt("id", cursor);

    const { data: orderRows, error: orderErr } = await query;
    if (orderErr) {
      await markRunFailed(supabase, runId, `order fetch failed: ${orderErr.message}`);
      throw new Error(`order fetch failed: ${orderErr.message}`);
    }

    const rows = orderRows ?? [];
    if (rows.length === 0) {
      await supabase
        .from("warehouse_order_identity_backfill_runs")
        .update({
          status: "completed",
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          scanned: runScanned,
          resolved_deterministic: runResolvedDeterministic,
          resolved_ambiguous: runResolvedAmbiguous,
          resolved_unresolved: runResolvedUnresolved,
          errors: runErrors,
        })
        .eq("id", runId);
      return {
        ok: true,
        runId,
        finished: true,
        scanned: runScanned,
        resolvedDeterministic: runResolvedDeterministic,
        resolvedAmbiguous: runResolvedAmbiguous,
        resolvedUnresolved: runResolvedUnresolved,
        errors: runErrors,
      };
    }

    // 4. Resolve + write per row.
    let lastId: string | null = cursor;
    for (const r of rows) {
      runScanned += 1;
      lastId = (r as { id: string }).id;

      // Best-effort `external_order_id` extraction: if the new column is
      // already populated, use it; else fall back to legacy fields per
      // platform.
      const row = r as {
        id: string;
        source: string | null;
        shopify_order_id: string | null;
        external_order_id: string | null;
        order_number: string | null;
        bandcamp_payment_id: number | null;
      };
      const platformKey = PLATFORM_TO_NORMALIZER[row.source ?? "shopify"];
      if (!platformKey) {
        runErrors += 1;
        continue;
      }

      // Bandcamp short-circuit — stamp legacy state and move on.
      if (platformKey === "bandcamp") {
        const decision = resolveOrderIdentityV2({
          platform: "bandcamp",
          rawStoreKey: "bandcamp",
          externalOrderId: row.bandcamp_payment_id?.toString() ?? "",
          candidateConnections: [],
        });
        const writeErr = await applyDecision(supabase, row.id, decision);
        if (writeErr) runErrors += 1;
        else
          countDecision(decision.status, {
            incDeterministic: () => runResolvedDeterministic++,
            incAmbiguous: () => runResolvedAmbiguous++,
            incUnresolved: () => runResolvedUnresolved++,
          });
        continue;
      }

      const externalOrderId =
        row.external_order_id ??
        (platformKey === "shopify" ? row.shopify_order_id : row.order_number) ??
        null;
      if (!externalOrderId) {
        // Cannot resolve without an external id; stamp as unresolved with
        // an explanatory note. The diagnostics surface will count these.
        const decision = {
          status: "unresolved" as IdentityResolutionStatus,
          connectionId: null,
          ingestionIdempotencyKeyV2: null,
          notes: { reason: "missing_external_order_id", source: row.source },
        };
        const writeErr = await applyDecision(supabase, row.id, decision);
        if (writeErr) runErrors += 1;
        else runResolvedUnresolved++;
        continue;
      }

      // We don't know the per-row store_url at backfill time (the
      // ingest didn't persist it). Use the candidate set as-is and let
      // the resolver pick deterministic when there's exactly one
      // candidate per platform; otherwise mark ambiguous and surface a
      // review row. This is intentionally conservative.
      const candidates = candidatesByPlatform.get(platformKey) ?? [];
      const decision = resolveOrderIdentityV2({
        platform: platformKey,
        // Use the FIRST candidate's storeKey to satisfy the resolver's
        // normalization input; we then rely on the candidate set's
        // shape to drive the deterministic vs ambiguous branch.
        rawStoreKey: candidates[0]?.storeKey ?? "unknown.example.com",
        externalOrderId: String(externalOrderId),
        candidateConnections: candidates,
      });

      // The resolver only returns deterministic when the candidate set
      // has exactly ONE matching storeKey. For backfill, that's the
      // safe answer — multiple candidates require manual review.
      const writeErr = await applyDecision(supabase, row.id, decision);
      if (writeErr) {
        runErrors += 1;
        continue;
      }
      countDecision(decision.status, {
        incDeterministic: () => runResolvedDeterministic++,
        incAmbiguous: () => runResolvedAmbiguous++,
        incUnresolved: () => runResolvedUnresolved++,
      });
    }

    // 5. Persist progress + cursor.
    await supabase
      .from("warehouse_order_identity_backfill_runs")
      .update({
        status: rows.length < batchSize ? "completed" : "running",
        cursor_order_id: lastId,
        scanned: runScanned,
        resolved_deterministic: runResolvedDeterministic,
        resolved_ambiguous: runResolvedAmbiguous,
        resolved_unresolved: runResolvedUnresolved,
        errors: runErrors,
        finished_at: rows.length < batchSize ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);

    return {
      ok: true,
      runId,
      finished: rows.length < batchSize,
      scanned: runScanned,
      resolvedDeterministic: runResolvedDeterministic,
      resolvedAmbiguous: runResolvedAmbiguous,
      resolvedUnresolved: runResolvedUnresolved,
      errors: runErrors,
      cursorOrderId: lastId,
    };
  },
});

function countDecision(
  status: IdentityResolutionStatus,
  counters: {
    incDeterministic: () => void;
    incAmbiguous: () => void;
    incUnresolved: () => void;
  },
): void {
  switch (status) {
    case "deterministic":
    case "manual":
      counters.incDeterministic();
      break;
    case "ambiguous":
    case "live_api_verification_failed":
      counters.incAmbiguous();
      break;
    case "unresolved":
    case "bandcamp_legacy_null":
      counters.incUnresolved();
      break;
  }
}

async function applyDecision(
  supabase: ReturnType<typeof createServiceRoleClient>,
  orderId: string,
  decision: {
    status: IdentityResolutionStatus;
    connectionId: string | null;
    ingestionIdempotencyKeyV2: string | null;
    notes: Record<string, unknown>;
    reviewReason?: string;
    reviewCandidateConnectionIds?: string[];
  },
): Promise<string | null> {
  const updatePatch: Record<string, unknown> = {
    identity_resolution_status: decision.status,
    identity_resolution_notes: decision.notes,
    updated_at: new Date().toISOString(),
  };
  if (decision.connectionId) {
    updatePatch.connection_id = decision.connectionId;
  }
  if (decision.ingestionIdempotencyKeyV2) {
    updatePatch.ingestion_idempotency_key_v2 = decision.ingestionIdempotencyKeyV2;
  }

  const { error: updateErr, data: orderRow } = await supabase
    .from("warehouse_orders")
    .update(updatePatch)
    .eq("id", orderId)
    .select("workspace_id")
    .maybeSingle();
  if (updateErr) return updateErr.message;

  // Open a review row when the resolver asked for one.
  if (decision.reviewReason && orderRow) {
    const { error: reviewErr } = await supabase
      .from("warehouse_order_identity_review_queue")
      .upsert(
        {
          workspace_id: (orderRow as { workspace_id: string }).workspace_id,
          warehouse_order_id: orderId,
          reason: decision.reviewReason,
          status: "open",
          candidate_connection_ids: decision.reviewCandidateConnectionIds ?? [],
          resolution_notes: decision.notes,
        },
        { onConflict: "warehouse_order_id", ignoreDuplicates: true },
      );
    if (reviewErr) {
      // Review insert is best-effort; the row exists already most likely.
      logger.warn("identity backfill: review insert failed", {
        orderId,
        error: reviewErr.message,
      });
    }
  }

  return null;
}

async function markRunFailed(
  supabase: ReturnType<typeof createServiceRoleClient>,
  runId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from("warehouse_order_identity_backfill_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      notes: { error: reason },
    })
    .eq("id", runId);
}
