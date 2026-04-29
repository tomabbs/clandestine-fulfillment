/**
 * Order Pages Transition Phase 1 — Direct Order Identity v2 helpers.
 *
 * Pure, well-typed surface for the new identity model. Keeps the resolver
 * and the live-ingest stamping logic in ONE owner file (Rule #58).
 *
 * The resolver is intentionally pure: it takes a candidate set + payload
 * and returns a resolution decision. The async wrapper
 * `recordOrderIdentityV2` writes that decision (plus an optional review
 * row) via PostgREST. Callers are: webhook handlers, pollers, the
 * backfill Trigger task, and the manual-resolution Server Action.
 */

import { normalizeStoreKey, type StoreKeyPlatform } from "@/lib/shared/store-key";

export type IdentityResolutionStatus =
  | "unresolved"
  | "deterministic"
  | "manual"
  | "ambiguous"
  | "live_api_verification_failed"
  | "bandcamp_legacy_null";

export type IdentityReviewReason =
  | "multiple_candidate_connections"
  | "no_candidate_connection"
  | "live_api_verification_failed"
  | "platform_unsupported"
  | "bandcamp_legacy_null";

export interface IdentityResolutionInput {
  /** Logical platform of the order. */
  platform: StoreKeyPlatform;
  /** Raw store identifier (myshopify domain, woo URL, etc.). */
  rawStoreKey: string;
  /** Platform-native order id (Shopify GID, Woo numeric id, BC payment_id, etc.). */
  externalOrderId: string;
  /**
   * The set of candidate `client_store_connections` rows already filtered by
   * (workspace_id, platform, normalized store_key). The resolver picks the
   * right one.
   */
  candidateConnections: Array<{
    id: string;
    storeKey: string;
    isActive: boolean;
  }>;
  /**
   * Optional live-API verification result. When present, the resolver
   * narrows ambiguous candidates to the single connection whose live API
   * call confirmed ownership. When absent, the resolver falls back to
   * candidate-set heuristics.
   */
  liveApiVerification?: {
    status: "ok" | "failed";
    /** Connection that the live API confirmed ownership for. */
    confirmedConnectionId?: string;
    /** Why a `failed` result happened (timeout, 401, 403, 404, …). */
    errorCode?: string;
  };
}

export interface IdentityResolutionDecision {
  status: IdentityResolutionStatus;
  connectionId: string | null;
  /** Stable idempotency key v2 (only set when connectionId is non-null). */
  ingestionIdempotencyKeyV2: string | null;
  /** Notes the resolver wants to persist on `warehouse_orders.identity_resolution_notes`. */
  notes: Record<string, unknown>;
  /** Set when a manual review row should be enqueued. */
  reviewReason?: IdentityReviewReason;
  /** Candidate IDs to surface in the review row. */
  reviewCandidateConnectionIds?: string[];
}

/**
 * Pure resolver — no I/O, no clocks. Drives the live ingest stamping AND
 * the resumable backfill task. Test surface lives in
 * `tests/unit/lib/server/order-identity-v2.test.ts`.
 */
export function resolveOrderIdentityV2(input: IdentityResolutionInput): IdentityResolutionDecision {
  const { platform, rawStoreKey, externalOrderId, candidateConnections, liveApiVerification } =
    input;

  if (platform === "bandcamp") {
    // Bandcamp orders go through `bandcamp_connections`, not
    // `client_store_connections`. Identity v2's `connection_id` is a FK
    // into the latter. Treat every Bandcamp row as `bandcamp_legacy_null`
    // — it stays in the legacy dedup family (`bandcamp_payment_id`) and
    // is excluded from the v2 partial unique index.
    return {
      status: "bandcamp_legacy_null",
      connectionId: null,
      ingestionIdempotencyKeyV2: null,
      notes: { platform, externalOrderId, reason: "bandcamp_legacy_null" },
      reviewReason: undefined,
    };
  }

  let normalizedStoreKey: string;
  try {
    normalizedStoreKey = normalizeStoreKey(platform, rawStoreKey);
  } catch (err) {
    return {
      status: "unresolved",
      connectionId: null,
      ingestionIdempotencyKeyV2: null,
      notes: {
        platform,
        rawStoreKey,
        externalOrderId,
        normalizationError: err instanceof Error ? err.message : String(err),
      },
      reviewReason: "platform_unsupported",
      reviewCandidateConnectionIds: candidateConnections.map((c) => c.id),
    };
  }

  const matchingCandidates = candidateConnections.filter((c) => c.storeKey === normalizedStoreKey);

  if (matchingCandidates.length === 0) {
    return {
      status: "unresolved",
      connectionId: null,
      ingestionIdempotencyKeyV2: null,
      notes: {
        platform,
        rawStoreKey,
        normalizedStoreKey,
        externalOrderId,
        candidateCount: candidateConnections.length,
      },
      reviewReason: "no_candidate_connection",
      reviewCandidateConnectionIds: candidateConnections.map((c) => c.id),
    };
  }

  if (matchingCandidates.length === 1) {
    const winner = matchingCandidates[0];
    if (!winner) {
      return {
        status: "unresolved",
        connectionId: null,
        ingestionIdempotencyKeyV2: null,
        notes: { reason: "internal_state_inconsistency" },
        reviewReason: "no_candidate_connection",
      };
    }
    return {
      status: "deterministic",
      connectionId: winner.id,
      ingestionIdempotencyKeyV2: buildIdempotencyKeyV2({
        platform,
        connectionId: winner.id,
        externalOrderId,
      }),
      notes: { platform, normalizedStoreKey, externalOrderId },
    };
  }

  // Multiple candidates — try live-API verification.
  if (liveApiVerification) {
    if (liveApiVerification.status === "failed") {
      return {
        status: "live_api_verification_failed",
        connectionId: null,
        ingestionIdempotencyKeyV2: null,
        notes: {
          platform,
          normalizedStoreKey,
          externalOrderId,
          candidateCount: matchingCandidates.length,
          errorCode: liveApiVerification.errorCode,
        },
        reviewReason: "live_api_verification_failed",
        reviewCandidateConnectionIds: matchingCandidates.map((c) => c.id),
      };
    }
    if (
      liveApiVerification.status === "ok" &&
      liveApiVerification.confirmedConnectionId &&
      matchingCandidates.some((c) => c.id === liveApiVerification.confirmedConnectionId)
    ) {
      const winner = matchingCandidates.find(
        (c) => c.id === liveApiVerification.confirmedConnectionId,
      );
      if (!winner) {
        return {
          status: "ambiguous",
          connectionId: null,
          ingestionIdempotencyKeyV2: null,
          notes: { reason: "internal_state_inconsistency" },
          reviewReason: "multiple_candidate_connections",
          reviewCandidateConnectionIds: matchingCandidates.map((c) => c.id),
        };
      }
      return {
        status: "deterministic",
        connectionId: winner.id,
        ingestionIdempotencyKeyV2: buildIdempotencyKeyV2({
          platform,
          connectionId: winner.id,
          externalOrderId,
        }),
        notes: {
          platform,
          normalizedStoreKey,
          externalOrderId,
          resolvedVia: "live_api_verification",
        },
      };
    }
  }

  return {
    status: "ambiguous",
    connectionId: null,
    ingestionIdempotencyKeyV2: null,
    notes: {
      platform,
      normalizedStoreKey,
      externalOrderId,
      candidateCount: matchingCandidates.length,
    },
    reviewReason: "multiple_candidate_connections",
    reviewCandidateConnectionIds: matchingCandidates.map((c) => c.id),
  };
}

/**
 * Build the canonical v2 idempotency key. Stable per logical order so
 * webhook + poller retries collapse to the same row via the partial
 * unique index `uq_warehouse_orders_idem_v2`.
 */
export function buildIdempotencyKeyV2(input: {
  platform: StoreKeyPlatform;
  connectionId: string;
  externalOrderId: string;
}): string {
  if (!input.externalOrderId) {
    throw new Error("buildIdempotencyKeyV2: externalOrderId is required");
  }
  return `${input.platform}:${input.connectionId}:${input.externalOrderId}`;
}
