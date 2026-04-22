/**
 * HRD-01 — monotonic timestamp guard for client-store webhooks.
 *
 * Problem this solves: Shopify (and Woo, and Squarespace) deliver webhooks
 * out of order under retry. If we process an OLDER `inventory_levels/update`
 * after a NEWER one for the same `inventory_item_id`, we silently roll back
 * the latest truth to a stale value. The same applies to `orders/updated`
 * superseding `orders/create`.
 *
 * Design (per migration 20260422000001 §C):
 *   - We do NOT add a separate cursor table.
 *   - Instead, every successfully-processed `webhook_events` row carries
 *     `last_seen_at = <event timestamp>`. We extract `(connection_id, topic,
 *     entity_id)` from the payload, look up the most-recent prior
 *     `last_seen_at` for that key in `webhook_events`, and reject the current
 *     delivery if its timestamp is older.
 *   - Stale events get `status='stale_dropped'` (audit retained, no side
 *     effects).
 *
 * Where this runs: in the `process-client-store-webhook` Trigger task, AFTER
 * the dormancy gate and BEFORE any topic dispatch. Keeping it in the task
 * (not the Route Handler) preserves Rule #66 (route returns <500ms).
 *
 * Two design notes worth flagging:
 *   1. We stash `entity_id` into the current row's metadata before the guard
 *      query so future webhooks for the same entity can find this row. The
 *      route handler stays topic-agnostic.
 *   2. The guard query is `LIMIT 1` over a topic + JSONB extract. With <1k
 *      webhooks/day per workspace this is fine without a custom index;
 *      `webhook_events_platform_created_at` already prunes the scan. A
 *      dedicated `(platform, topic, (metadata->>'connection_id'),
 *      (metadata->>'entity_id'), last_seen_at DESC)` index is queued as a
 *      future hardening migration if/when we cross 10k webhooks/day.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface EventContext {
  /** Stable entity identifier, e.g. inventory_item_id, order_id, refund_id. */
  entityId: string | null;
  /** Platform-emitted timestamp (ISO 8601). Falls back to `null` if absent. */
  eventTimestamp: string | null;
}

export interface MonotonicGuardResult {
  stale: boolean;
  /** Most-recent timestamp we previously processed for this entity, if any. */
  priorTimestamp: string | null;
  /** Timestamp of the current event, if extractable. */
  currentTimestamp: string | null;
  /** Entity id we keyed on. */
  entityId: string | null;
  /** Reason the guard returned its verdict (for diagnostics). */
  reason:
    | "stale_dropped"
    | "first_event_for_entity"
    | "newer_than_prior"
    | "missing_entity_id"
    | "missing_timestamp";
}

/**
 * Extract `(entityId, eventTimestamp)` from a webhook payload + headers.
 *
 * Per-topic mapping (unknown topics return `null`s, which short-circuits the
 * guard with `reason='missing_entity_id'` — i.e. fail-OPEN, not fail-closed,
 * because the alternative is silently dropping every webhook of an
 * unrecognized topic).
 */
export function extractEventContext(
  platform: string,
  topic: string,
  payload: Record<string, unknown>,
  headers: { triggeredAt?: string | null } = {},
): EventContext {
  const t = topic.toLowerCase();

  let entityId: string | null = null;
  if (t.includes("inventory")) {
    entityId =
      (payload.inventory_item_id as string | number | undefined)?.toString() ??
      (payload.id as string | number | undefined)?.toString() ??
      null;
  } else if (t.includes("refund")) {
    entityId =
      (payload.id as string | number | undefined)?.toString() ??
      (payload.order_id as string | number | undefined)?.toString() ??
      null;
  } else if (t.includes("order")) {
    entityId =
      (payload.id as string | number | undefined)?.toString() ??
      (payload.order_id as string | number | undefined)?.toString() ??
      null;
  } else {
    entityId = (payload.id as string | number | undefined)?.toString() ?? null;
  }

  // Prefer the platform-injected delivery timestamp when present (Shopify
  // sends `X-Shopify-Triggered-At`; Woo/Squarespace don't). Fall back to the
  // payload's `updated_at` / `date_modified` / `modifiedOn`.
  let eventTimestamp: string | null = null;
  if (headers.triggeredAt) {
    eventTimestamp = headers.triggeredAt;
  } else if (typeof payload.updated_at === "string") {
    eventTimestamp = payload.updated_at;
  } else if (typeof payload.date_modified_gmt === "string") {
    eventTimestamp = `${payload.date_modified_gmt}Z`;
  } else if (typeof payload.date_modified === "string") {
    eventTimestamp = payload.date_modified;
  } else if (typeof payload.modifiedOn === "string") {
    eventTimestamp = payload.modifiedOn;
  } else if (typeof payload.created_at === "string") {
    eventTimestamp = payload.created_at;
  }

  // Normalize platform parameter usage to silence unused-var lint.
  void platform;

  return { entityId, eventTimestamp };
}

/**
 * Run the monotonic guard query against `webhook_events`.
 *
 * IMPORTANT: callers must have already stashed `entity_id` into the current
 * row's `metadata` (see `stashEntityIdOnCurrentRow`) so the lookup query can
 * exclude the current row by id while still finding it via metadata for
 * future deliveries.
 */
export async function checkMonotonicGuard(
  supabase: SupabaseClient,
  params: {
    currentEventId: string;
    platform: string;
    topic: string;
    connectionId: string;
    context: EventContext;
  },
): Promise<MonotonicGuardResult> {
  const { entityId, eventTimestamp } = params.context;

  if (!entityId) {
    return {
      stale: false,
      priorTimestamp: null,
      currentTimestamp: eventTimestamp,
      entityId: null,
      reason: "missing_entity_id",
    };
  }
  if (!eventTimestamp) {
    return {
      stale: false,
      priorTimestamp: null,
      currentTimestamp: null,
      entityId,
      reason: "missing_timestamp",
    };
  }

  const { data: prior } = await supabase
    .from("webhook_events")
    .select("id, last_seen_at")
    .eq("platform", params.platform)
    .eq("topic", params.topic)
    .eq("metadata->>connection_id", params.connectionId)
    .eq("metadata->>entity_id", entityId)
    .neq("id", params.currentEventId)
    .not("last_seen_at", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const priorTimestamp = (prior?.last_seen_at as string | null | undefined) ?? null;
  if (!priorTimestamp) {
    return {
      stale: false,
      priorTimestamp: null,
      currentTimestamp: eventTimestamp,
      entityId,
      reason: "first_event_for_entity",
    };
  }

  const stale = new Date(eventTimestamp).getTime() < new Date(priorTimestamp).getTime();
  return {
    stale,
    priorTimestamp,
    currentTimestamp: eventTimestamp,
    entityId,
    reason: stale ? "stale_dropped" : "newer_than_prior",
  };
}

/**
 * Persist `entity_id` onto the current `webhook_events` row's metadata so
 * later guards for the same entity can find it. Merges with existing
 * metadata (preserves connection_id, payload, etc.).
 *
 * NOTE: this is a single Postgres UPDATE, not a transactional read-modify-
 * write. That's fine because metadata is append-only for this code path — no
 * other writer touches `metadata.entity_id` for the same row.
 */
export async function stashEntityIdOnCurrentRow(
  supabase: SupabaseClient,
  eventId: string,
  existingMetadata: Record<string, unknown>,
  entityId: string,
): Promise<void> {
  await supabase
    .from("webhook_events")
    .update({
      metadata: { ...existingMetadata, entity_id: entityId },
    })
    .eq("id", eventId);
}

/**
 * Mark the current row as stale-dropped and write the diagnostic context.
 * The audit row stays in webhook_events forever for forensics.
 */
export async function markStaleDropped(
  supabase: SupabaseClient,
  eventId: string,
  existingMetadata: Record<string, unknown>,
  guard: MonotonicGuardResult,
): Promise<void> {
  await supabase
    .from("webhook_events")
    .update({
      status: "stale_dropped",
      metadata: {
        ...existingMetadata,
        stale_dropped: {
          at: new Date().toISOString(),
          prior_timestamp: guard.priorTimestamp,
          current_timestamp: guard.currentTimestamp,
          entity_id: guard.entityId,
        },
      },
    })
    .eq("id", eventId);
}

/**
 * Write the event's timestamp to `last_seen_at` after successful processing.
 * Future deliveries for the same entity will compare their timestamp against
 * this value via `checkMonotonicGuard`.
 */
export async function writeLastSeenAt(
  supabase: SupabaseClient,
  eventId: string,
  eventTimestamp: string,
): Promise<void> {
  await supabase.from("webhook_events").update({ last_seen_at: eventTimestamp }).eq("id", eventId);
}
