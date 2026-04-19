/**
 * Phase 0.3 — Local-outbox idempotency for EasyPost label purchases.
 *
 * The contract:
 *
 *   purchaseLabelIdempotent(args, buyFn)
 *
 *     1. Compute a stable idempotency key from INPUTS only (never EP response).
 *     2. INSERT into label_purchase_attempts ON CONFLICT DO NOTHING.
 *        - If the row already exists AND succeeded=true → return the cached
 *          response. EasyPost is NEVER called again.
 *        - If the row already exists AND succeeded=false → another in-flight
 *          attempt or a previous failure that we're choosing not to auto-retry.
 *          Return that previous error so the caller can surface it.
 *        - If the insert won → we own this attempt; proceed to buy.
 *     3. Call buyFn() (the actual EP Shipment.buy wrapper).
 *     4. UPDATE the row with succeeded=true + response_json.
 *     5. Return the response.
 *
 * The key MUST be derived from STABLE INPUTS only. Banned: EP shipment.id,
 * EP rate.id, tracking_code, internal "pending" UUIDs.
 *
 * Recommended key shape:
 *   easypost-buy:{workspace_id}:{order_external_id}:{rate_signature}
 *
 * where rate_signature = hash({carrier, service, rate, currency, carrier_account_id}).
 *
 * Cross-references: plan Appendix J.3 (DDL), J.5 (rules), J.6 scenarios E + F.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RateSignatureInput {
  carrier: string;
  service: string;
  rate: number | string;
  currency?: string | null;
  carrierAccountId?: string | null;
}

export function computeRateSignature(input: RateSignatureInput): string {
  // Normalize to a deterministic JSON string. Lowercase carrier so "USPS" and
  // "usps" hash identically. Round rate to 2 decimal places so penny drift
  // doesn't change the key.
  const rateNum =
    typeof input.rate === "string" ? Number.parseFloat(input.rate) : input.rate;
  const canonical = {
    c: input.carrier.toLowerCase(),
    s: input.service,
    r: Number.isFinite(rateNum) ? rateNum.toFixed(2) : String(input.rate),
    cu: (input.currency ?? "USD").toUpperCase(),
    ca: input.carrierAccountId ?? "default",
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export interface IdempotencyKeyInput {
  workspaceId: string;
  orderExternalId: string;
  rateSignature: string;
}

export function buildIdempotencyKey(input: IdempotencyKeyInput): string {
  return `easypost-buy:${input.workspaceId}:${input.orderExternalId}:${input.rateSignature}`;
}

export type OrderSource = "fulfillment" | "mailorder" | "shipstation";

export interface PurchaseAttemptArgs {
  workspaceId: string;
  orderExternalId: string;
  orderSource: OrderSource;
  rate: RateSignatureInput;
  /** EP shipment id from the freshly-created shipment. Stored for audit only — NOT in the key. */
  easypostShipmentId: string;
}

export interface PurchaseAttemptResult<TResponse> {
  /** True when EasyPost.Shipment.buy was actually called in this invocation. False when we returned a cached prior success. */
  bought: boolean;
  response: TResponse;
  attemptId: string;
  idempotencyKey: string;
}

/**
 * Wrap a Shipment.buy call in the idempotency outbox.
 *
 * `buyFn` MUST be the function that calls EP.Shipment.buy. The helper guarantees
 * `buyFn` is invoked at most once per (workspace_id, idempotency_key).
 */
export async function purchaseLabelIdempotent<TResponse>(
  supabase: SupabaseClient,
  args: PurchaseAttemptArgs,
  buyFn: () => Promise<TResponse>,
): Promise<PurchaseAttemptResult<TResponse>> {
  const rateSignature = computeRateSignature(args.rate);
  const idempotencyKey = buildIdempotencyKey({
    workspaceId: args.workspaceId,
    orderExternalId: args.orderExternalId,
    rateSignature,
  });

  // ── Read-before-write: did we already buy this exact key? ───────────────────
  const { data: existing } = await supabase
    .from("label_purchase_attempts")
    .select("id, succeeded, response_json, error_text")
    .eq("workspace_id", args.workspaceId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existing?.succeeded === true && existing.response_json) {
    return {
      bought: false,
      response: existing.response_json as TResponse,
      attemptId: existing.id,
      idempotencyKey,
    };
  }

  if (existing && existing.succeeded === false) {
    // A prior attempt failed and never succeeded. Surface it; do NOT auto-retry
    // EP — caller decides whether to clear & retry under a new key.
    throw new IdempotencyPriorFailureError(
      idempotencyKey,
      existing.id,
      existing.error_text ?? "previous attempt failed (no error_text)",
    );
  }

  // ── Reserve the slot. ON CONFLICT acts as the cross-process lock. ──────────
  const { data: inserted, error: insertErr } = await supabase
    .from("label_purchase_attempts")
    .insert({
      workspace_id: args.workspaceId,
      order_external_id: args.orderExternalId,
      order_source: args.orderSource,
      shipment_id: args.easypostShipmentId,
      idempotency_key: idempotencyKey,
      rate_signature: rateSignature,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    // Likely a UNIQUE-violation race with a concurrent attempt. Re-read.
    const { data: raced } = await supabase
      .from("label_purchase_attempts")
      .select("id, succeeded, response_json, error_text")
      .eq("workspace_id", args.workspaceId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (raced?.succeeded === true && raced.response_json) {
      return {
        bought: false,
        response: raced.response_json as TResponse,
        attemptId: raced.id,
        idempotencyKey,
      };
    }

    throw new Error(
      `[label-purchase-idempotency] Could not reserve slot and no prior success found: ${insertErr?.message ?? "unknown"}`,
    );
  }

  // ── We own the slot. Call EP exactly once. ─────────────────────────────────
  let response: TResponse;
  try {
    response = await buyFn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from("label_purchase_attempts")
      .update({
        succeeded: false,
        error_text: msg,
        attempt_finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", inserted.id);
    throw err;
  }

  // ── Stamp success. From here forward, retries are no-ops. ──────────────────
  // Best-effort: if the UPDATE itself fails, the EP charge already succeeded
  // — caller logs it; reconciliation will pick up the row with succeeded=false
  // but a real tracking_code in response_json (we still try to write it).
  const trackingNumber =
    typeof response === "object" && response !== null && "tracking_code" in response
      ? String((response as { tracking_code: unknown }).tracking_code)
      : null;

  await supabase
    .from("label_purchase_attempts")
    .update({
      succeeded: true,
      response_json: response as unknown as Record<string, unknown>,
      tracking_number: trackingNumber,
      attempt_finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", inserted.id);

  return {
    bought: true,
    response,
    attemptId: inserted.id,
    idempotencyKey,
  };
}

export class IdempotencyPriorFailureError extends Error {
  readonly idempotencyKey: string;
  readonly attemptId: string;

  constructor(idempotencyKey: string, attemptId: string, prior: string) {
    super(`Prior attempt failed for idempotency key ${idempotencyKey}: ${prior}`);
    this.name = "IdempotencyPriorFailureError";
    this.idempotencyKey = idempotencyKey;
    this.attemptId = attemptId;
  }
}
