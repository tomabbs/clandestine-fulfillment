"use server";

import { z } from "zod/v4";
import { requireClient } from "@/lib/server/auth-context";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// Phase 6 — Slice 6.F
// Client-facing read surface for `/portal/stock-exceptions`.
//
// Contract:
//   * CLIENT-ONLY. `requireClient()` gates every action so only
//     authenticated org members can read. Staff are intentionally
//     rejected here — staff use the admin identity-matches surface
//     (Slice 6.E) which surfaces every outcome_state, not just
//     `client_stock_exception`.
//   * ORG-SCOPED. Every query filters on `org_id=:caller.orgId` as
//     defense-in-depth layered on top of the
//     `client_select_identity_matches` RLS policy (migration
//     20260428000001 §"Section B"). If the service-role grant ever
//     leaked into this path, the explicit org_id filter still prevents
//     cross-org data exposure.
//   * READ-ONLY. Clients cannot mutate identity-match state from the
//     portal. If they spot a genuine error they submit a support
//     message (existing surface).
//   * HIDES REMOTE DETAILS. The portal surface intentionally omits
//     `remote_fingerprint`, `evidence_snapshot`, and
//     `remote_inventory_item_id` — clients don't need those internals,
//     and we avoid leaking any fingerprint that could be used as a
//     cross-store linkage signal by a different client.
//   * Bounded page sizes. `listClientStockExceptions` caps at 100 rows
//     per request. Default page size is 25.

const LIST_MAX_LIMIT = 100;

const listClientStockExceptionsInputSchema = z.object({
  connectionId: z.string().uuid().optional(),
  platform: z.enum(["shopify", "woocommerce", "squarespace"]).optional(),
  limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(25),
  offset: z.number().int().min(0).default(0),
});

export type ListClientStockExceptionsInput = z.input<typeof listClientStockExceptionsInputSchema>;

export interface ClientStockExceptionRow {
  id: string;
  connection_id: string;
  platform: "shopify" | "woocommerce" | "squarespace";
  variant_id: string | null;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_sku: string | null;
  warehouse_stock_at_match: number | null;
  remote_stock_at_match: number | null;
  remote_stock_listed_at_match: boolean | null;
  last_evaluated_at: string;
  evaluation_count: number;
  created_at: string;
}

export interface ListClientStockExceptionsResult {
  rows: ClientStockExceptionRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * List identity rows currently in `client_stock_exception` state for
 * the caller's org. These are rows where the autonomous matcher
 * reliably identified the remote listing as a client variant, but
 * warehouse ATP hit zero while the remote channel is still listing
 * positive stock — i.e., the client is selling inventory we can't
 * fulfill. The portal surfaces this so clients can correct mis-listed
 * availability on their storefront before oversells ship.
 *
 * Rows are returned sorted by `last_evaluated_at` DESC so the most
 * recently (re)evaluated exceptions appear first; that mirrors what
 * clients intuitively expect ("new issues on top").
 */
export async function listClientStockExceptions(
  rawInput: ListClientStockExceptionsInput = {},
): Promise<ListClientStockExceptionsResult> {
  const { orgId } = await requireClient();
  const input = listClientStockExceptionsInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("client_store_product_identity_matches")
    .select(
      "id, connection_id, platform, variant_id, remote_product_id, remote_variant_id, remote_sku, warehouse_stock_at_match, remote_stock_at_match, remote_stock_listed_at_match, last_evaluated_at, evaluation_count, created_at",
      { count: "exact" },
    )
    .eq("org_id", orgId)
    .eq("outcome_state", "client_stock_exception")
    .eq("is_active", true);

  if (input.connectionId !== undefined) {
    query = query.eq("connection_id", input.connectionId);
  }
  if (input.platform !== undefined) {
    query = query.eq("platform", input.platform);
  }

  const { data, count, error } = await query
    .order("last_evaluated_at", { ascending: false })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw new Error(`listClientStockExceptions failed: ${error.message}`);
  }

  return {
    rows: (data ?? []) as ClientStockExceptionRow[],
    total: count ?? 0,
    limit: input.limit,
    offset: input.offset,
  };
}
