/**
 * Phase 1 §9.2 D5 — Shopify CAS hot-path retry loop.
 *
 * Wraps `setShopifyInventoryWithCompare` with a 3-attempt
 * read→compute→CAS loop. The contract is:
 *
 *   1. **Read** Shopify's actual `available` for (inventoryItemId,
 *      locationId).
 *   2. **Compute** the desired absolute write via the caller-supplied
 *      `computeDesired(remoteAvailable)` callback. The callback owns
 *      the channel's effective_sellable formula, ATP, safety stock —
 *      this helper is transport-only.
 *   3. **CAS** via `setShopifyInventoryWithCompare` with idempotency
 *      key `{baseIdempotencyKey}` (no suffix on attempt 1) /
 *      `{baseIdempotencyKey}:retry{N}` on attempts 2-3. Each retry MUST
 *      have a distinct idempotency key — Shopify's `@idempotent` directive
 *      would otherwise return the prior CAS-failed result instead of
 *      attempting the new CAS.
 *   4. On `compare_mismatch`: backoff 50/150/400ms, re-read, recompute,
 *      retry. Up to `maxAttempts` (default 3).
 *   5. On 3-attempts-exhausted: mark the ledger row `error`, upsert a
 *      `cas_exhausted` `warehouse_review_queue` item (severity `medium`,
 *      group_key per workspace+sku so back-to-back exhaustions on the
 *      same SKU bump occurrence_count instead of flooding the queue),
 *      and return `{ ok: false, reason: "exhausted" }`. The caller is
 *      expected to NOT throw on exhaustion (the task succeeded — it
 *      just couldn't reconcile a hot SKU within 3 attempts; the
 *      reconcile sweep will catch it).
 *   6. Non-CAS GraphQL errors (transport/auth/throttle, malformed input)
 *      propagate up and are caught at the task framework — they're not
 *      race conditions and a retry won't help.
 *
 * Why a separate helper (vs. inlining in each push task):
 *   Pass 2 has TWO Shopify call sites (`clandestine-shopify-push-on-sku`
 *   and `client-store-push-on-sku` Shopify path) PLUS Pass 3 reconcile
 *   auto-fix. Three sites that all need the same retry semantics, the
 *   same idempotency-key shape, the same per-attempt audit row, and the
 *   same review-queue dedup. Three copies = three drift surfaces. One
 *   helper = one truth (Rule #58).
 *
 * Single ledger row per logical adjustment:
 *   The helper takes ONE `external_sync_events.id` (already acquired by
 *   the caller via `beginExternalSync({ action: "cas_set", ... })`) and
 *   accumulates per-attempt info in memory, persisting the full
 *   `attempts[]` array to `response_body` on the terminal
 *   markSuccess/markError. We deliberately do NOT issue a Postgres
 *   UPDATE per attempt — three writes per CAS push would double the
 *   DB load on the hot path. The downside (mid-task crash loses attempt
 *   history) is acceptable: the next task retry starts a fresh ledger
 *   row anyway.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@trigger.dev/sdk";

import {
  makeCasIdempotencyKey,
  type SetShopifyInventoryWithCompareResult,
  type ShopifyCasTransport,
  setShopifyInventoryWithCompare,
} from "@/lib/clients/shopify-cas";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { markExternalSyncError, markExternalSyncSuccess } from "@/lib/server/external-sync-events";
import {
  type ConnectionShopifyContext,
  connectionShopifyGraphQL,
} from "@/lib/server/shopify-connection-graphql";

/**
 * Backoff schedule between CAS attempts, in milliseconds. Tuned for
 * Shopify's median RTT (~80ms) — the first retry comes BEFORE another
 * webhook is likely to land, the second after one has, the third for
 * the rare "two more webhooks landed in the same 200ms window" case.
 *
 * Exposed as a constant so tests can spy on it without monkey-patching
 * `setTimeout`.
 */
export const CAS_RETRY_BACKOFF_MS = [50, 150, 400] as const;

export const CAS_DEFAULT_MAX_ATTEMPTS = 3;

/**
 * One CAS attempt's outcome — accumulated in memory and persisted to
 * `external_sync_events.response_body.attempts[]` on terminal mark.
 */
export interface CasAttemptRecord {
  attempt: number;
  expectedQuantity: number;
  desiredQuantity: number;
  idempotencyKey: string;
  /** Wall-clock ms between read-start and CAS-result (excludes backoff). */
  durationMs: number;
  outcome: "success" | "compare_mismatch";
  /** Shopify's reported actual on mismatch (null when message can't be parsed). */
  actualQuantity?: number | null;
  /** Verbatim Shopify message on mismatch. */
  message?: string;
  /** Shopify adjustment group ID on success. */
  adjustmentGroupId?: string | null;
  /** Resulting absolute quantity on success. */
  newQuantity?: number;
}

export type CasRetryLoopResult =
  | {
      ok: true;
      finalNewQuantity: number;
      attempts: CasAttemptRecord[];
      adjustmentGroupId: string | null;
    }
  | {
      ok: false;
      reason: "exhausted";
      attempts: CasAttemptRecord[];
      lastActualQuantity: number | null;
    };

export interface SetShopifyInventoryCasParams {
  /** Service-role Supabase client (writes review queue + ledger updates). */
  supabase: SupabaseClient;

  /** CAS transport: env-singleton (Clandestine) or per-connection (client store). */
  transport: ShopifyCasTransport;

  /** Shopify GIDs for the inventory adjustment. */
  inventoryItemId: string;
  locationId: string;

  /** Owning workspace — for review queue rows. */
  workspaceId: string;
  /** Optional org_id for review queue (denormalized so the queue UI can filter by client). */
  orgId?: string | null;
  /** SKU under adjustment — for idempotency key + review queue title. */
  sku: string;

  /**
   * Stable correlation ID per logical adjustment (Rule #15) — feeds
   * `makeCasIdempotencyKey` and the review queue group_key. NEVER a
   * random UUID per network call.
   */
  correlationId: string;

  /** Which CAS namespace this write belongs to (clandestine vs client-store). */
  system: "clandestine_shopify" | "client_store_shopify";

  /**
   * Pre-acquired `external_sync_events.id` (caller did
   * `beginExternalSync({ action: "cas_set", ... })`). The helper marks
   * it success or error on terminal outcome.
   */
  ledgerId: string;

  /**
   * Caller-owned formula. Given the just-read remote `available`,
   * returns the absolute value we want Shopify to land at. Pure or
   * async — both supported. The helper does NOT cache the result;
   * each retry calls again with a fresh remote read, so a sale
   * between attempts moves the desired value with the truth.
   */
  computeDesired: (remoteAvailable: number) => number | Promise<number>;

  /** Optional override for Shopify's adjustment ledger `reason` enum. */
  reason?: string;

  /** Test seam — defaults to CAS_DEFAULT_MAX_ATTEMPTS. */
  maxAttempts?: number;

  /**
   * Test seam — defaults to a real `setTimeout`. Tests pass a no-op
   * to skip backoff sleeps.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Read Shopify's actual `available` value for (inventoryItemId,
 * locationId). Routes through the right transport so per-connection
 * stores use their own offline token, not the env-singleton.
 *
 * Exported for the contract test + reconcile sweep — both want the same
 * "single source of truth" read shape.
 */
export async function readShopifyAvailable(
  transport: ShopifyCasTransport,
  inventoryItemId: string,
  locationId: string,
): Promise<number> {
  const query = `
    query ReadInventoryAvailable($inventoryItemId: ID!, $locationId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }
  `;

  type Resp = {
    inventoryItem: {
      inventoryLevel: {
        quantities: Array<{ name: string; quantity: number }>;
      } | null;
    } | null;
  };

  const data =
    transport.kind === "env_singleton"
      ? await shopifyGraphQL<Resp>(query, { inventoryItemId, locationId })
      : await connectionShopifyGraphQL<Resp>(transport.ctx as ConnectionShopifyContext, query, {
          inventoryItemId,
          locationId,
        });

  const row = data.inventoryItem?.inventoryLevel?.quantities?.find((q) => q.name === "available");
  if (!row) {
    throw new Error(
      `Shopify inventoryLevel.quantities[available] missing for inventoryItem=${inventoryItemId} location=${locationId}`,
    );
  }
  return row.quantity;
}

/**
 * Hot-path CAS retry loop. See module docstring for the contract.
 *
 * Returns `{ok: true, ...}` on a clean write (any attempt 1-3). Returns
 * `{ok: false, reason: "exhausted", ...}` after maxAttempts CAS
 * mismatches. Throws on non-CAS errors (transport, auth, malformed
 * input) — those bubble to the Trigger.dev task framework's catchError.
 */
export async function setShopifyInventoryCas(
  params: SetShopifyInventoryCasParams,
): Promise<CasRetryLoopResult> {
  const maxAttempts = params.maxAttempts ?? CAS_DEFAULT_MAX_ATTEMPTS;
  const sleep = params.sleep ?? defaultSleep;

  const baseIdempotencyKey = makeCasIdempotencyKey(params.system, params.correlationId, params.sku);

  const attempts: CasAttemptRecord[] = [];
  let lastActualQuantity: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    const remoteAvailable = await readShopifyAvailable(
      params.transport,
      params.inventoryItemId,
      params.locationId,
    );
    const desired = await params.computeDesired(remoteAvailable);

    const idempotencyKey =
      attempt === 1
        ? baseIdempotencyKey
        : makeCasIdempotencyKey(
            params.system,
            params.correlationId,
            params.sku,
            attempt - 1, // attempt 2 → :retry1, attempt 3 → :retry2
          );

    let result: SetShopifyInventoryWithCompareResult;
    try {
      result = await setShopifyInventoryWithCompare(params.transport, {
        inventoryItemId: params.inventoryItemId,
        locationId: params.locationId,
        expectedQuantity: remoteAvailable,
        desiredQuantity: desired,
        idempotencyKey,
        reason: params.reason,
      });
    } catch (err) {
      // Non-CAS error (transport/auth/malformed input). Mark the ledger
      // error with whatever attempts we've accumulated so far, then
      // re-throw — the task framework retries the whole task.
      await markExternalSyncError(params.supabase, params.ledgerId, err, {
        attempts,
        last_attempt_idempotency_key: idempotencyKey,
        last_attempt: attempt,
      });
      throw err;
    }

    const durationMs = Date.now() - startedAt;

    if (result.ok) {
      attempts.push({
        attempt,
        expectedQuantity: remoteAvailable,
        desiredQuantity: desired,
        idempotencyKey,
        durationMs,
        outcome: "success",
        adjustmentGroupId: result.adjustmentGroupId,
        newQuantity: result.newQuantity,
      });
      await markExternalSyncSuccess(params.supabase, params.ledgerId, {
        attempts,
        final_new_quantity: result.newQuantity,
        adjustment_group_id: result.adjustmentGroupId,
      });
      return {
        ok: true,
        finalNewQuantity: result.newQuantity,
        attempts,
        adjustmentGroupId: result.adjustmentGroupId,
      };
    }

    // CAS mismatch — record, log, sleep (if not last attempt), retry.
    lastActualQuantity = result.actualQuantity;
    attempts.push({
      attempt,
      expectedQuantity: remoteAvailable,
      desiredQuantity: desired,
      idempotencyKey,
      durationMs,
      outcome: "compare_mismatch",
      actualQuantity: result.actualQuantity,
      message: result.message,
    });

    logger.info("[shopify-cas-retry] compare_mismatch", {
      sku: params.sku,
      correlationId: params.correlationId,
      attempt,
      expected: remoteAvailable,
      actual: result.actualQuantity,
      desired,
    });

    if (attempt < maxAttempts) {
      // Backoff: index `attempt - 1` because attempt 1 → backoff[0]
      // (between attempt 1 and attempt 2). Last attempt has no backoff
      // since the loop exits.
      const backoffMs = CAS_RETRY_BACKOFF_MS[attempt - 1] ?? 0;
      if (backoffMs > 0) await sleep(backoffMs);
    }
  }

  // Exhausted — record terminal outcome on the ledger AND upsert a
  // review queue item so staff can investigate the hot SKU.
  await markExternalSyncError(params.supabase, params.ledgerId, "cas_exhausted", {
    attempts,
    cas_exhausted: true,
    last_actual_quantity: lastActualQuantity,
  });

  await upsertCasExhaustedReviewItem(params.supabase, {
    workspaceId: params.workspaceId,
    orgId: params.orgId,
    sku: params.sku,
    system: params.system,
    correlationId: params.correlationId,
    attempts,
    lastActualQuantity,
  });

  logger.warn("[shopify-cas-retry] exhausted after max attempts", {
    sku: params.sku,
    correlationId: params.correlationId,
    attempts: attempts.length,
    lastActual: lastActualQuantity,
  });

  return {
    ok: false,
    reason: "exhausted",
    attempts,
    lastActualQuantity,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Upsert (severity:medium) review queue row keyed by
 * `cas_exhausted:{workspace}:{system}:{sku}`. Repeated exhaustions
 * bump occurrence_count in-place rather than flooding the queue with
 * duplicates (Rule #55 dedup).
 */
async function upsertCasExhaustedReviewItem(
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    orgId?: string | null;
    sku: string;
    system: "clandestine_shopify" | "client_store_shopify";
    correlationId: string;
    attempts: CasAttemptRecord[];
    lastActualQuantity: number | null;
  },
): Promise<void> {
  const groupKey = `cas_exhausted:${params.workspaceId}:${params.system}:${params.sku}`;
  const { error } = await supabase.from("warehouse_review_queue").upsert(
    {
      workspace_id: params.workspaceId,
      org_id: params.orgId ?? null,
      category: "cas_exhausted",
      severity: "medium",
      title: `Shopify CAS exhausted on SKU ${params.sku}`,
      description:
        `Compare-and-set inventory write to ${params.system} could not converge ` +
        `after ${params.attempts.length} attempts for SKU ${params.sku}. ` +
        `This usually means concurrent webhook traffic is racing the push. ` +
        `The reconcile sweep will retry — staff intervention is only needed if ` +
        `this fires repeatedly on the same SKU.`,
      metadata: {
        sku: params.sku,
        system: params.system,
        correlation_id: params.correlationId,
        attempts: params.attempts,
        last_actual_quantity: params.lastActualQuantity,
        max_attempts_reached: true,
      },
      group_key: groupKey,
      status: "open",
      occurrence_count: 1,
    },
    {
      onConflict: "group_key",
      ignoreDuplicates: false,
    },
  );

  if (error) {
    // Non-fatal: failing to write the review queue row should NOT
    // mask the CAS exhaustion result. Log and continue.
    logger.error("[shopify-cas-retry] failed to upsert review queue item", {
      sku: params.sku,
      groupKey,
      error: error.message,
    });
  }
}
