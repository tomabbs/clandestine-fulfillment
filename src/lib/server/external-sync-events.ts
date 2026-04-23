import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * `external_sync_events` ledger helper (plan §1.4.2).
 *
 * Every external mutation (ShipStation v2 inventory ops, Bandcamp
 * `update_quantities` / `update_sku`, ShipStation v1 alias add/remove,
 * Clandestine Shopify SKU rename) MUST flow through this helper. The
 * UNIQUE (system, correlation_id, sku, action) constraint provides
 * idempotency: a duplicate retry collides on insert and the caller learns
 * the operation is already in flight or completed.
 *
 * Usage shape:
 *
 *   const claim = await beginExternalSync(sb, {
 *     system: 'shipstation_v1',
 *     correlation_id: ctx.run.id,
 *     sku,
 *     action: 'alias_add',
 *     request_body: payload,
 *   });
 *   if (!claim.acquired) return; // duplicate retry — bail out
 *   try {
 *     const response = await ssV1.putProduct(...);
 *     await markExternalSyncSuccess(sb, claim.id, response);
 *   } catch (err) {
 *     await markExternalSyncError(sb, claim.id, err);
 *     throw err;
 *   }
 *
 * The helper deliberately does NOT hide the lifecycle behind a callback —
 * call-sites need explicit control because they often interleave the API
 * call with mutex acquisition, pre-image capture, and post-write verify.
 */

export type ExternalSyncSystem =
  | "shipstation_v1"
  | "shipstation_v2"
  | "bandcamp"
  | "clandestine_shopify"
  // Phase 1 §9.2 D1 — per-platform per-SKU push paths. Distinct systems
  // (vs a single "client_store") so analytics on external_sync_events can
  // segment by storefront without parsing metadata. Migration:
  // 20260424000003_external_sync_events_client_store.sql.
  | "client_store_shopify"
  | "client_store_squarespace"
  | "client_store_woocommerce";

export type ExternalSyncAction =
  | "increment"
  | "decrement"
  | "adjust"
  | "modify"
  // Phase 1 §9.2 D1/D2 — absolute-quantity push verb. Used by the new
  // client-store + clandestine focused-push tasks for the legacy
  // (non-CAS) path.
  | "set"
  // Phase 1 §9.2 D5 — Shopify Compare-And-Set absolute write. Distinct
  // verb from `set` so analytics can isolate CAS mismatch frequency,
  // exhaustion rate, and p99 latency without filtering by metadata.
  // One ledger row per logical adjustment; per-attempt history in
  // response_body.attempts[]. Migration:
  // 20260427000001_external_sync_events_cas_set.sql.
  | "cas_set"
  | "alias_add"
  | "alias_remove"
  | "sku_rename";

export interface BeginExternalSyncInput {
  system: ExternalSyncSystem;
  /**
   * Stable per-logical-operation. NEVER a random UUID per network call
   * (CLAUDE.md Rule #15). For task retries: the task run ID. For
   * webhook-driven writes: the webhook id + line item id. For sale-poll
   * decrements: the Bandcamp sale id.
   */
  correlation_id: string;
  sku: string;
  action: ExternalSyncAction;
  request_body?: unknown;
}

export type BeginExternalSyncResult =
  | {
      acquired: true;
      id: string;
    }
  | {
      acquired: false;
      reason: "already_in_flight" | "already_succeeded" | "already_errored";
      existing_id: string;
      existing_status: "in_flight" | "success" | "error";
    };

/**
 * Insert an `in_flight` row. If the (system, correlation_id, sku, action)
 * key already exists, return the existing row's status so the caller can
 * decide what to do (skip on success, retry-with-backoff on in_flight,
 * etc.).
 */
export async function beginExternalSync(
  supabase: SupabaseClient,
  input: BeginExternalSyncInput,
): Promise<BeginExternalSyncResult> {
  const { data, error } = await supabase
    .from("external_sync_events")
    .insert({
      system: input.system,
      correlation_id: input.correlation_id,
      sku: input.sku,
      action: input.action,
      status: "in_flight",
      request_body: input.request_body ?? null,
    })
    .select("id")
    .single();

  if (!error && data) {
    return { acquired: true, id: data.id };
  }

  // Postgres unique-violation (`23505`) means a row already exists. Fetch
  // it so the caller can react. Any other error bubbles up.
  if (error.code !== "23505") {
    throw error;
  }

  const { data: existing, error: lookupError } = await supabase
    .from("external_sync_events")
    .select("id,status")
    .eq("system", input.system)
    .eq("correlation_id", input.correlation_id)
    .eq("sku", input.sku)
    .eq("action", input.action)
    .single();

  if (lookupError || !existing) {
    throw lookupError ?? new Error("external_sync_events conflict but row not found");
  }

  const reasonMap = {
    in_flight: "already_in_flight",
    success: "already_succeeded",
    error: "already_errored",
  } as const;

  return {
    acquired: false,
    reason: reasonMap[existing.status as keyof typeof reasonMap],
    existing_id: existing.id,
    existing_status: existing.status,
  };
}

export async function markExternalSyncSuccess(
  supabase: SupabaseClient,
  id: string,
  response_body?: unknown,
): Promise<void> {
  const { error } = await supabase
    .from("external_sync_events")
    .update({
      status: "success",
      completed_at: new Date().toISOString(),
      response_body: response_body ?? null,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function markExternalSyncError(
  supabase: SupabaseClient,
  id: string,
  err: unknown,
  response_body?: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const { error } = await supabase
    .from("external_sync_events")
    .update({
      status: "error",
      completed_at: new Date().toISOString(),
      response_body: response_body ?? { message },
    })
    .eq("id", id);
  if (error) throw error;
}
