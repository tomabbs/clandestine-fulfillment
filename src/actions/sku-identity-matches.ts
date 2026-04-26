"use server";

import { z } from "zod/v4";
import { requireStaff } from "@/lib/server/auth-context";
import {
  FULL_OUTCOME_STATES,
  STORED_IDENTITY_OUTCOME_STATES,
} from "@/lib/server/sku-outcome-transitions";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// Phase 6 — Slice 6.E
// Staff read model over `client_store_product_identity_matches` +
// `sku_outcome_transitions`.
//
// Contract:
//   * STAFF-ONLY surface — `requireStaff()` gates every action. RLS on
//     the identity table allows authenticated-staff reads; the action
//     ALSO constrains every query to the caller's workspace as
//     defense-in-depth against a leaked service-role grant.
//   * READ-ONLY. Promotion, demotion, and state transitions live in
//     Phase-5 Trigger tasks / the Phase-3A promote wrapper / the
//     `apply_sku_outcome_transition` RPC. This module never mutates
//     identity rows or transition audit rows — if a staff user wants to
//     force an outcome change they go through the (future) human-review
//     action, not through the admin-UI surface.
//   * ID-ONLY JOIN BOUNDARY. List queries return `connection_id`,
//     `variant_id`, `org_id`, and `promoted_alias_id` as opaque IDs;
//     name/URL lookups happen through the dedicated
//     `store-connections.ts` / variant actions.
//   * Bounded page sizes. `listIdentityMatches` caps at 200 rows per
//     page; `getIdentityMatchDetail` caps at 200 transition-history
//     rows per request.

const LIST_MAX_LIMIT = 200;
const DETAIL_MAX_TRANSITIONS = 200;

const identityOutcomeStateSchema = z.enum(STORED_IDENTITY_OUTCOME_STATES);

const listIdentityMatchesInputSchema = z.object({
  connectionId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  outcomeState: identityOutcomeStateSchema.optional(),
  canonicalResolutionState: z
    .enum([
      "resolved_to_variant",
      "remote_only_unresolved",
      "non_operational",
      "rejected_non_match",
      "unresolved",
    ])
    .optional(),
  remoteListingState: z
    .enum([
      "sellable_product",
      "remote_only",
      "non_operational",
      "placeholder_sku",
      "fetch_incomplete",
      "duplicate_remote",
      "archived_remote",
    ])
    .optional(),
  platform: z.enum(["shopify", "woocommerce", "squarespace"]).optional(),
  isActive: z.boolean().optional(),
  evaluatedAfter: z.string().datetime().optional(),
  evaluatedBefore: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  offset: z.number().int().min(0).default(0),
});

export type ListIdentityMatchesInput = z.input<typeof listIdentityMatchesInputSchema>;

export interface IdentityMatchListRow {
  id: string;
  workspace_id: string;
  org_id: string;
  connection_id: string;
  platform: "shopify" | "woocommerce" | "squarespace";
  variant_id: string | null;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_inventory_item_id: string | null;
  remote_sku: string | null;
  remote_fingerprint: string | null;
  outcome_state: (typeof STORED_IDENTITY_OUTCOME_STATES)[number];
  canonical_resolution_state: string;
  remote_listing_state: string | null;
  match_method: string;
  match_confidence: string;
  evidence_hash: string;
  warehouse_stock_at_match: number | null;
  remote_stock_at_match: number | null;
  remote_stock_listed_at_match: boolean | null;
  state_version: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_evaluated_at: string;
  evaluation_count: number;
  promoted_to_alias_at: string | null;
  promoted_alias_id: string | null;
  created_by_method: string | null;
}

export interface ListIdentityMatchesResult {
  rows: IdentityMatchListRow[];
  total: number;
  limit: number;
  offset: number;
  groupedByOutcomeState: Record<string, number>;
}

/**
 * Paginated list of identity matches for the caller's workspace. All
 * filters are applied server-side; the optional `isActive` filter
 * defaults to unset so both active and soft-deactivated rows surface —
 * most admin dashboards want only `is_active=true`, but
 * post-mortem investigations need to see the deactivated history too.
 *
 * Rows returned here never participate in fanout (lint guard
 * `scripts/lint/sku-identity-no-fanout.sh` — this file is explicitly
 * whitelisted because the surface is read-only).
 */
export async function listIdentityMatches(
  rawInput: ListIdentityMatchesInput = {},
): Promise<ListIdentityMatchesResult> {
  const { workspaceId } = await requireStaff();
  const input = listIdentityMatchesInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("client_store_product_identity_matches")
    .select(
      "id, workspace_id, org_id, connection_id, platform, variant_id, remote_product_id, remote_variant_id, remote_inventory_item_id, remote_sku, remote_fingerprint, outcome_state, canonical_resolution_state, remote_listing_state, match_method, match_confidence, evidence_hash, warehouse_stock_at_match, remote_stock_at_match, remote_stock_listed_at_match, state_version, is_active, created_at, updated_at, last_evaluated_at, evaluation_count, promoted_to_alias_at, promoted_alias_id, created_by_method",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId);

  if (input.connectionId !== undefined) {
    query = query.eq("connection_id", input.connectionId);
  }
  if (input.variantId !== undefined) {
    query = query.eq("variant_id", input.variantId);
  }
  if (input.outcomeState !== undefined) {
    query = query.eq("outcome_state", input.outcomeState);
  }
  if (input.canonicalResolutionState !== undefined) {
    query = query.eq("canonical_resolution_state", input.canonicalResolutionState);
  }
  if (input.remoteListingState !== undefined) {
    query = query.eq("remote_listing_state", input.remoteListingState);
  }
  if (input.platform !== undefined) {
    query = query.eq("platform", input.platform);
  }
  if (input.isActive !== undefined) {
    query = query.eq("is_active", input.isActive);
  }
  if (input.evaluatedAfter !== undefined) {
    query = query.gte("last_evaluated_at", input.evaluatedAfter);
  }
  if (input.evaluatedBefore !== undefined) {
    query = query.lte("last_evaluated_at", input.evaluatedBefore);
  }

  const { data, count, error } = await query
    .order("last_evaluated_at", { ascending: false })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw new Error(`listIdentityMatches failed: ${error.message}`);
  }

  const rows = (data ?? []) as IdentityMatchListRow[];

  const groupedByOutcomeState: Record<string, number> = {};
  for (const row of rows) {
    groupedByOutcomeState[row.outcome_state] = (groupedByOutcomeState[row.outcome_state] ?? 0) + 1;
  }

  return {
    rows,
    total: count ?? 0,
    limit: input.limit,
    offset: input.offset,
    groupedByOutcomeState,
  };
}

const getIdentityMatchDetailInputSchema = z.object({
  identityMatchId: z.string().uuid(),
  transitionsLimit: z.number().int().min(1).max(DETAIL_MAX_TRANSITIONS).default(50),
});

export type GetIdentityMatchDetailInput = z.input<typeof getIdentityMatchDetailInputSchema>;

export interface IdentityMatchDetail extends IdentityMatchListRow {
  evidence_snapshot: Record<string, unknown>;
}

export interface IdentityMatchTransitionRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  variant_id: string | null;
  from_state: string | null;
  to_state: string;
  trigger:
    | "evidence_gate"
    | "stock_change"
    | "human_review"
    | "fetch_recovery"
    | "periodic_revaluation";
  reason_code: string;
  evidence_snapshot: Record<string, unknown>;
  identity_match_id: string | null;
  alias_id: string | null;
  triggered_by: string | null;
  triggered_at: string;
}

export interface GetIdentityMatchDetailResult {
  match: IdentityMatchDetail;
  transitions: IdentityMatchTransitionRow[];
  transitionsTotal: number;
  transitionsLimit: number;
}

/**
 * Detail read for a single identity match. Returns the full row
 * (including `evidence_snapshot`) and its transition history from
 * `sku_outcome_transitions`, sorted newest-first. The UI renders the
 * transition history as a timeline so staff can answer "why did this
 * row land in `auto_reject_non_match`?" without pivoting to raw SQL.
 *
 * The full outcome-state alphabet (`FULL_OUTCOME_STATES` — includes
 * `auto_live_inventory_alias`) is exposed so the UI's legality-grid
 * renderer can show cross-table states even though those states never
 * appear on identity rows themselves.
 */
export async function getIdentityMatchDetail(
  rawInput: GetIdentityMatchDetailInput,
): Promise<GetIdentityMatchDetailResult> {
  const { workspaceId } = await requireStaff();
  const input = getIdentityMatchDetailInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  const { data: matchRow, error: matchErr } = await supabase
    .from("client_store_product_identity_matches")
    .select(
      "id, workspace_id, org_id, connection_id, platform, variant_id, remote_product_id, remote_variant_id, remote_inventory_item_id, remote_sku, remote_fingerprint, outcome_state, canonical_resolution_state, remote_listing_state, match_method, match_confidence, evidence_snapshot, evidence_hash, warehouse_stock_at_match, remote_stock_at_match, remote_stock_listed_at_match, state_version, is_active, created_at, updated_at, last_evaluated_at, evaluation_count, promoted_to_alias_at, promoted_alias_id, created_by_method",
    )
    .eq("id", input.identityMatchId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (matchErr) {
    throw new Error(`getIdentityMatchDetail read failed: ${matchErr.message}`);
  }
  if (!matchRow) {
    throw new Error("Identity match not found");
  }

  const {
    data: transitionRows,
    count,
    error: txErr,
  } = await supabase
    .from("sku_outcome_transitions")
    .select(
      "id, workspace_id, connection_id, variant_id, from_state, to_state, trigger, reason_code, evidence_snapshot, identity_match_id, alias_id, triggered_by, triggered_at",
      { count: "exact" },
    )
    .eq("identity_match_id", input.identityMatchId)
    .eq("workspace_id", workspaceId)
    .order("triggered_at", { ascending: false })
    .limit(input.transitionsLimit);

  if (txErr) {
    throw new Error(`getIdentityMatchDetail transitions read failed: ${txErr.message}`);
  }

  return {
    match: matchRow as IdentityMatchDetail,
    transitions: (transitionRows ?? []) as IdentityMatchTransitionRow[],
    transitionsTotal: count ?? 0,
    transitionsLimit: input.transitionsLimit,
  };
}

/**
 * Re-exported copy of the full outcome-state alphabet so the admin UI
 * can render state badges without importing from `@/lib/server/*`
 * directly (keeps the client bundle clean).
 */
export const IDENTITY_OUTCOME_STATES = STORED_IDENTITY_OUTCOME_STATES;
export const FULL_OUTCOME_STATE_ALPHABET = FULL_OUTCOME_STATES;
