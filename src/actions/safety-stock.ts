"use server";

/**
 * Phase 5 §9.6 D2 — per-channel safety stock Server Actions.
 *
 * Surface contract:
 *   • Storefront connections (Shopify clients, WooCommerce, Squarespace,
 *     BigCommerce) edit `client_store_sku_mappings.safety_stock` per
 *     (connection, SKU). One row per mapping.
 *   • Internal channels (`bandcamp`, `clandestine_shopify`, future) edit
 *     `warehouse_safety_stock_per_channel.safety_stock` per
 *     (workspace, variant, channel). Sparse — rows with safety_stock=0
 *     are deleted to keep the table dense for the §9.6 push helper.
 *
 * Every edit writes a row to `warehouse_safety_stock_audit_log`
 * (migration `20260427000004_safety_stock_audit_log.sql`) so operators
 * can trace who changed what and why. This is NOT a DB trigger — the
 * Server Action provides the `reason` and `source` fields the UI
 * captures, which a trigger cannot see.
 *
 * Design choices recorded for the half-day review:
 *   • Bulk edits are best-effort per-SKU rather than all-or-nothing.
 *     Reason: a 200-SKU CSV import that fails on row 73 because one
 *     SKU was renamed should still apply rows 1-72 + 74-200 and
 *     surface row 73 as an error in the response. The audit log
 *     captures every successful application atomically with each row
 *     write (best-effort, but the audit row is part of the same
 *     PostgREST request when possible).
 *   • CSV preview/commit is split into two Server Actions so the
 *     operator sees a diff before committing. Same shape as the
 *     `previewBulkOrderImport` flow elsewhere in the codebase.
 *   • Internal-channel deletes (safety_stock=0 + existing row) emit
 *     an audit row with `new_safety_stock=0` so the history shows the
 *     reversion. The DB row is then deleted.
 *
 * Rule #6 — companion test at `tests/unit/actions/safety-stock.test.ts`.
 * Rule #20 — safety_stock is a POLICY column, NOT an inventory delta.
 *   This file does NOT route through `recordInventoryChange()`; it
 *   never touches `available`, `committed_quantity`, or Redis.
 */

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
// Constants live in src/lib/shared/constants.ts because Next.js 14 forbids
// non-async exports from `"use server"` files (commit f72f752 captured the
// same lesson for MIN_SAMPLE_COUNT_FOR_CUTOVER + friends). Re-importing
// under the same names keeps every existing in-file reference working.
import {
  INTERNAL_SAFETY_STOCK_CHANNELS,
  type InternalSafetyStockChannel,
  SAFETY_STOCK_MAX_BULK_EDITS,
  SAFETY_STOCK_MAX_VALUE,
  SAFETY_STOCK_REASON_MAX_LENGTH,
} from "@/lib/shared/constants";
// CSV parser lives outside this file for the same Next.js 14 reason
// (functions exported from "use server" must be async; parseCsv is sync).
import { parseCsv } from "@/lib/shared/safety-stock-csv";
import type {
  SafetyStockAuditChannelKind,
  SafetyStockAuditSource,
  WarehouseSafetyStockAuditLog,
} from "@/lib/shared/types";

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** A safety-stock channel target. Discriminated union mirrors the
 *  `channel_kind` discriminator on the audit log table — the UI passes
 *  one of these two shapes and every action knows exactly which surface
 *  to write to. */
const channelTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("storefront"),
    connectionId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("internal"),
    channelName: z.enum(INTERNAL_SAFETY_STOCK_CHANNELS),
  }),
]);
export type ChannelTarget = z.infer<typeof channelTargetSchema>;

const listChannelsInputSchema = z.object({}).strict();

const listEntriesInputSchema = z.object({
  channel: channelTargetSchema,
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  /** Optional SKU or product-title substring filter. Case-insensitive. */
  search: z.string().max(200).optional(),
  /** When true, only return rows whose safety_stock > 0. Used by the
   *  "edited rows" tab in the UI. */
  onlyWithSafetyStock: z.boolean().optional(),
});

const editSchema = z.object({
  sku: z.string().min(1).max(120),
  newSafetyStock: z.number().int().min(0).max(SAFETY_STOCK_MAX_VALUE),
  /** Storefront-only — internal channels do NOT have preorder_whitelist
   *  (it lives only on the storefront mapping table). When the UI
   *  submits this for an internal channel target, the action ignores
   *  it rather than rejecting — keeps the client API uniform. */
  newPreorderWhitelist: z.boolean().optional(),
});
export type SafetyStockEdit = z.infer<typeof editSchema>;

const updateBulkInputSchema = z.object({
  channel: channelTargetSchema,
  edits: z.array(editSchema).min(1).max(SAFETY_STOCK_MAX_BULK_EDITS),
  reason: z.string().max(SAFETY_STOCK_REASON_MAX_LENGTH).optional(),
  source: z.enum(["ui_inline", "ui_bulk", "ui_csv"]).default("ui_bulk"),
});

const previewCsvInputSchema = z.object({
  channel: channelTargetSchema,
  csv: z.string().min(1).max(200_000),
});

const commitCsvInputSchema = z.object({
  channel: channelTargetSchema,
  edits: z.array(editSchema).min(1).max(SAFETY_STOCK_MAX_BULK_EDITS),
  reason: z.string().max(SAFETY_STOCK_REASON_MAX_LENGTH).optional(),
});

const listAuditInputSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  /** Optional filters. When `connectionId` is set, also forces
   *  `channelKind='storefront'`. When `channelName` is set, also forces
   *  `channelKind='internal'`. The UI normalizes this; the action
   *  rejects contradictory combinations to fail loud on bugs. */
  channelKind: z.enum(["storefront", "internal"]).optional(),
  connectionId: z.string().uuid().optional(),
  channelName: z.enum(INTERNAL_SAFETY_STOCK_CHANNELS).optional(),
  sku: z.string().max(120).optional(),
});

// ─── Public types (re-exported for the page) ─────────────────────────────────

export interface SafetyStockChannelSummary {
  /** Stable picker key — `storefront:{connectionId}` or `internal:{name}`. */
  pickerKey: string;
  kind: SafetyStockAuditChannelKind;
  /** Storefront only. */
  connectionId: string | null;
  /** Internal only. */
  channelName: string | null;
  /** Human label for the picker. */
  label: string;
  /** Subtitle (org name for storefront; "Bandcamp" / "Clandestine
   *  Shopify" for internal). */
  subtitle: string | null;
  /** Storefront only — surfaces to the picker so it can render an
   *  inline status badge. */
  connectionStatus: string | null;
  /** Storefront only — count of mappings with `last_inventory_policy='CONTINUE'
   *  AND preorder_whitelist=false` (drift). Used by the inline drift
   *  badge on the picker. */
  policyDriftCount: number;
  /** Count of rows with safety_stock > 0 on this channel. Used to show
   *  "12 SKUs reserved" style stat. */
  rowsWithSafetyStock: number;
}

export interface SafetyStockEntry {
  variantId: string;
  sku: string;
  productTitle: string | null;
  available: number;
  /** Storefront only. */
  connectionId: string | null;
  /** The current safety_stock on this row (0 when no row exists for
   *  internal channels). */
  safetyStock: number;
  /** Storefront only — null for internal channels. */
  preorderWhitelist: boolean | null;
  /** Storefront only — surfaces the policy-drift badge inline so the
   *  operator can see CONTINUE-without-whitelist rows without leaving
   *  the page. */
  lastInventoryPolicy: string | null;
  lastPolicyCheckAt: string | null;
  /** Last time THIS row's safety_stock was edited (NULL = never via
   *  this UI). Sourced from the audit log's most recent row for the
   *  (channel, sku) pair. */
  lastSafetyEditAt: string | null;
  lastSafetyEditBy: string | null;
}

export interface ListEntriesResult {
  entries: SafetyStockEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BulkEditOutcome {
  sku: string;
  status: "applied" | "skipped_no_change" | "error";
  error?: string;
  prevSafetyStock?: number;
  newSafetyStock?: number;
  prevPreorderWhitelist?: boolean;
  newPreorderWhitelist?: boolean;
}

export interface BulkEditResult {
  applied: number;
  skippedNoChange: number;
  errors: number;
  outcomes: BulkEditOutcome[];
}

export interface CsvPreviewRow {
  sku: string;
  /** What the row looks like today; null when the SKU isn't found in
   *  the workspace. */
  currentSafetyStock: number | null;
  currentPreorderWhitelist: boolean | null;
  /** Parsed-from-CSV proposed values. */
  newSafetyStock: number;
  newPreorderWhitelist: boolean | null;
  changeKind: "create" | "update" | "delete" | "no_change" | "error";
  error: string | null;
}

export interface CsvPreviewResult {
  rows: CsvPreviewRow[];
  summary: {
    create: number;
    update: number;
    delete: number;
    noChange: number;
    error: number;
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface AuthedContext {
  workspaceId: string;
  userId: string;
  supabase: ReturnType<typeof createServiceRoleClient>;
}

async function requireStaffContext(actionName: string): Promise<AuthedContext> {
  const { isStaff, userRecord } = await requireAuth();
  if (!isStaff) {
    throw new Error(`${actionName}: staff-only`);
  }
  return {
    workspaceId: userRecord.workspace_id,
    userId: userRecord.id,
    supabase: createServiceRoleClient(),
  };
}

/** Validate the channel target makes sense for the caller's workspace.
 *  For storefront targets, asserts the connection exists and belongs to
 *  the same workspace. Returns the resolved label fields (used by the
 *  audit log + result payloads). */
async function resolveChannelTarget(
  ctx: AuthedContext,
  target: ChannelTarget,
  actionName: string,
): Promise<
  | {
      kind: "storefront";
      connectionId: string;
      platform: string;
      storeUrl: string | null;
      connectionStatus: string;
    }
  | { kind: "internal"; channelName: InternalSafetyStockChannel }
> {
  if (target.kind === "internal") {
    return { kind: "internal", channelName: target.channelName };
  }
  const { data, error } = await ctx.supabase
    .from("client_store_connections")
    .select("id, workspace_id, platform, store_url, connection_status")
    .eq("id", target.connectionId)
    .maybeSingle();
  if (error) throw new Error(`${actionName}: connection lookup failed: ${error.message}`);
  if (!data) throw new Error(`${actionName}: connection not found: ${target.connectionId}`);
  if ((data.workspace_id as string) !== ctx.workspaceId) {
    throw new Error(
      `${actionName}: connection does not belong to caller workspace (cross-workspace access denied)`,
    );
  }
  return {
    kind: "storefront",
    connectionId: data.id as string,
    platform: data.platform as string,
    storeUrl: (data.store_url as string | null) ?? null,
    connectionStatus: data.connection_status as string,
  };
}

// ─── listSafetyStockChannels ─────────────────────────────────────────────────

/**
 * Returns every channel the operator can edit safety stock for, in
 * picker order: storefront connections first (grouped by org name via
 * the embedded join), internal channels appended at the end.
 *
 * For each storefront, computes the policy-drift count
 * (`last_inventory_policy='CONTINUE' AND preorder_whitelist=false`)
 * inline so the picker can render an inline drift badge — the partial
 * index `idx_sku_mappings_policy_drift` (migration 20260424000001)
 * makes this O(matching rows), not a full table scan.
 */
export async function listSafetyStockChannels(
  rawInput: z.input<typeof listChannelsInputSchema> = {},
): Promise<SafetyStockChannelSummary[]> {
  listChannelsInputSchema.parse(rawInput);
  const ctx = await requireStaffContext("listSafetyStockChannels");

  const { data: connections, error: connErr } = await ctx.supabase
    .from("client_store_connections")
    .select("id, platform, store_url, connection_status, organizations!inner(name)")
    .eq("workspace_id", ctx.workspaceId)
    .order("created_at", { ascending: true });
  if (connErr) {
    throw new Error(`listSafetyStockChannels: connections query failed: ${connErr.message}`);
  }

  const connectionIds = (connections ?? []).map((c) => c.id as string);

  // Aggregate counts per connection in a single round-trip per metric.
  // PostgREST doesn't expose GROUP BY directly, so we pull the matching
  // rows and count in TS — fast for the workspace sizes we see (10s of
  // connections, low thousands of mappings). If a workspace ever has
  // >100 connections, swap to an RPC.
  const driftCountByConn: Record<string, number> = {};
  const stockedCountByConn: Record<string, number> = {};
  if (connectionIds.length > 0) {
    const { data: drift, error: driftErr } = await ctx.supabase
      .from("client_store_sku_mappings")
      .select("connection_id")
      .in("connection_id", connectionIds)
      .eq("last_inventory_policy", "CONTINUE")
      .eq("preorder_whitelist", false);
    if (driftErr) {
      throw new Error(`listSafetyStockChannels: drift count failed: ${driftErr.message}`);
    }
    for (const row of drift ?? []) {
      const k = row.connection_id as string;
      driftCountByConn[k] = (driftCountByConn[k] ?? 0) + 1;
    }
    const { data: stocked, error: stockedErr } = await ctx.supabase
      .from("client_store_sku_mappings")
      .select("connection_id")
      .in("connection_id", connectionIds)
      .gt("safety_stock", 0);
    if (stockedErr) {
      throw new Error(`listSafetyStockChannels: stocked count failed: ${stockedErr.message}`);
    }
    for (const row of stocked ?? []) {
      const k = row.connection_id as string;
      stockedCountByConn[k] = (stockedCountByConn[k] ?? 0) + 1;
    }
  }

  const summaries: SafetyStockChannelSummary[] = (connections ?? []).map((c) => {
    // PostgREST embeds the joined org as either an object (when the
    // foreign key is single-target) or a single-element array. Handle
    // both shapes defensively.
    const orgRaw = (c as unknown as { organizations: unknown }).organizations;
    const orgName: string | null = Array.isArray(orgRaw)
      ? ((orgRaw[0] as { name?: string } | undefined)?.name ?? null)
      : ((orgRaw as { name?: string } | null)?.name ?? null);
    return {
      pickerKey: `storefront:${c.id}`,
      kind: "storefront",
      connectionId: c.id as string,
      channelName: null,
      label: (c.store_url as string | null) ?? `${c.platform} connection`,
      subtitle: orgName,
      connectionStatus: c.connection_status as string,
      policyDriftCount: driftCountByConn[c.id as string] ?? 0,
      rowsWithSafetyStock: stockedCountByConn[c.id as string] ?? 0,
    };
  });

  // Internal channel rows (Bandcamp + Clandestine Shopify). One picker
  // entry per known channel; `rowsWithSafetyStock` shows how many SKUs
  // currently have a non-zero reserve on that channel.
  for (const channelName of INTERNAL_SAFETY_STOCK_CHANNELS) {
    const { data: rows, error } = await ctx.supabase
      .from("warehouse_safety_stock_per_channel")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("channel", channelName)
      .gt("safety_stock", 0);
    if (error) {
      throw new Error(
        `listSafetyStockChannels: internal channel '${channelName}' count failed: ${error.message}`,
      );
    }
    summaries.push({
      pickerKey: `internal:${channelName}`,
      kind: "internal",
      connectionId: null,
      channelName,
      label: channelName === "bandcamp" ? "Bandcamp" : "Clandestine Shopify",
      subtitle: "Internal channel",
      connectionStatus: null,
      policyDriftCount: 0,
      rowsWithSafetyStock: rows?.length ?? 0,
    });
  }

  return summaries;
}

// ─── listSafetyStockEntries ──────────────────────────────────────────────────

/**
 * Paged list of editable rows for one channel.
 *
 * Storefront query path: paginate over `client_store_sku_mappings`
 * for the connection. Joined to the variant + product for the SKU and
 * title display, and to inventory_levels for the `available` column.
 *
 * Internal channel path: paginate over `warehouse_product_variants`
 * for the workspace (the source-of-truth surface for "every SKU"),
 * left-joined to the sparse safety-stock table. Rows without a safety
 * row report `safetyStock=0`. Search filters apply in both modes.
 */
export async function listSafetyStockEntries(
  rawInput: z.infer<typeof listEntriesInputSchema>,
): Promise<ListEntriesResult> {
  const input = listEntriesInputSchema.parse(rawInput);
  const ctx = await requireStaffContext("listSafetyStockEntries");
  const resolved = await resolveChannelTarget(ctx, input.channel, "listSafetyStockEntries");

  const offset = (input.page - 1) * input.pageSize;
  const search = input.search?.trim();

  if (resolved.kind === "storefront") {
    let query = ctx.supabase
      .from("client_store_sku_mappings")
      .select(
        // Embed variant → product (title) and variant → inventory_levels
        // (available). PostgREST resolves these via the FKs.
        "id, variant_id, safety_stock, preorder_whitelist, last_inventory_policy, last_policy_check_at, warehouse_product_variants!inner(id, sku, warehouse_products!inner(title), warehouse_inventory_levels(available))",
        { count: "exact" },
      )
      .eq("connection_id", resolved.connectionId)
      .eq("is_active", true);

    if (input.onlyWithSafetyStock) {
      query = query.gt("safety_stock", 0);
    }
    if (search) {
      // Filter on the embedded variant.sku OR product.title via PostgREST
      // `or` on the joined columns. The pattern is the same as
      // store-mapping uses for cross-table search.
      query = query.or(
        `sku.ilike.%${search}%,warehouse_product_variants.warehouse_products.title.ilike.%${search}%`,
        { foreignTable: "warehouse_product_variants" },
      );
    }
    const { data, count, error } = await query
      .order("id", { ascending: true })
      .range(offset, offset + input.pageSize - 1);
    if (error) {
      throw new Error(`listSafetyStockEntries: storefront query failed: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as Array<{
      variant_id: string;
      safety_stock: number;
      preorder_whitelist: boolean;
      last_inventory_policy: string | null;
      last_policy_check_at: string | null;
      warehouse_product_variants: {
        id: string;
        sku: string;
        warehouse_products: { title: string | null } | { title: string | null }[];
        warehouse_inventory_levels: { available: number } | { available: number }[] | null;
      };
    }>;

    const entries: SafetyStockEntry[] = rows.map((r) => {
      const variant = r.warehouse_product_variants;
      const product = Array.isArray(variant.warehouse_products)
        ? (variant.warehouse_products[0] ?? null)
        : variant.warehouse_products;
      const level = Array.isArray(variant.warehouse_inventory_levels)
        ? (variant.warehouse_inventory_levels[0] ?? null)
        : variant.warehouse_inventory_levels;
      return {
        variantId: variant.id,
        sku: variant.sku,
        productTitle: product?.title ?? null,
        available: level?.available ?? 0,
        connectionId: resolved.connectionId,
        safetyStock: r.safety_stock,
        preorderWhitelist: r.preorder_whitelist,
        lastInventoryPolicy: r.last_inventory_policy,
        lastPolicyCheckAt: r.last_policy_check_at,
        lastSafetyEditAt: null,
        lastSafetyEditBy: null,
      };
    });

    const enriched = await enrichLastEditTimestamps(ctx, entries, {
      kind: "storefront",
      connectionId: resolved.connectionId,
    });

    return {
      entries: enriched,
      total: count ?? entries.length,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  // Internal channel path — variants are the spine.
  let variantQuery = ctx.supabase
    .from("warehouse_product_variants")
    .select("id, sku, warehouse_products!inner(title), warehouse_inventory_levels(available)", {
      count: "exact",
    })
    .eq("workspace_id", ctx.workspaceId);
  if (search) {
    variantQuery = variantQuery.or(
      `sku.ilike.%${search}%,warehouse_products.title.ilike.%${search}%`,
    );
  }
  const {
    data: variants,
    count,
    error: vErr,
  } = await variantQuery
    .order("sku", { ascending: true })
    .range(offset, offset + input.pageSize - 1);
  if (vErr) {
    throw new Error(`listSafetyStockEntries: internal variant query failed: ${vErr.message}`);
  }

  const variantIds = (variants ?? []).map((v) => v.id as string);
  const safetyByVariant: Record<string, number> = {};
  if (variantIds.length > 0) {
    const { data: safetyRows, error: sErr } = await ctx.supabase
      .from("warehouse_safety_stock_per_channel")
      .select("variant_id, safety_stock")
      .eq("workspace_id", ctx.workspaceId)
      .eq("channel", resolved.channelName)
      .in("variant_id", variantIds);
    if (sErr) {
      throw new Error(`listSafetyStockEntries: safety_stock fetch failed: ${sErr.message}`);
    }
    for (const r of safetyRows ?? []) {
      safetyByVariant[r.variant_id as string] = r.safety_stock as number;
    }
  }

  let entries: SafetyStockEntry[] = (variants ?? []).map((v) => {
    const productRaw = (v as unknown as { warehouse_products: unknown }).warehouse_products;
    const product = Array.isArray(productRaw)
      ? (productRaw[0] as { title: string | null } | null)
      : (productRaw as { title: string | null } | null);
    const levelRaw = (v as unknown as { warehouse_inventory_levels: unknown })
      .warehouse_inventory_levels;
    const level = Array.isArray(levelRaw)
      ? ((levelRaw[0] as { available: number } | null) ?? null)
      : ((levelRaw as { available: number } | null) ?? null);
    return {
      variantId: v.id as string,
      sku: v.sku as string,
      productTitle: product?.title ?? null,
      available: level?.available ?? 0,
      connectionId: null,
      safetyStock: safetyByVariant[v.id as string] ?? 0,
      preorderWhitelist: null,
      lastInventoryPolicy: null,
      lastPolicyCheckAt: null,
      lastSafetyEditAt: null,
      lastSafetyEditBy: null,
    };
  });

  if (input.onlyWithSafetyStock) {
    entries = entries.filter((e) => e.safetyStock > 0);
  }

  const enriched = await enrichLastEditTimestamps(ctx, entries, {
    kind: "internal",
    channelName: resolved.channelName,
  });

  return {
    entries: enriched,
    total: count ?? enriched.length,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/** Best-effort enrichment of last-edited-at/by per entry from the audit
 *  log. Fails open (returns entries unchanged) if the audit log query
 *  errors — operators should never be blocked from editing because of
 *  a stale telemetry read. */
async function enrichLastEditTimestamps(
  ctx: AuthedContext,
  entries: SafetyStockEntry[],
  channel: { kind: "storefront"; connectionId: string } | { kind: "internal"; channelName: string },
): Promise<SafetyStockEntry[]> {
  const skus = entries.map((e) => e.sku);
  if (skus.length === 0) return entries;

  let query = ctx.supabase
    .from("warehouse_safety_stock_audit_log")
    .select(
      "sku, changed_at, changed_by, users:users!warehouse_safety_stock_audit_log_changed_by_fkey(name)",
    )
    .eq("workspace_id", ctx.workspaceId)
    .in("sku", skus)
    .order("changed_at", { ascending: false });
  if (channel.kind === "storefront") {
    query = query.eq("connection_id", channel.connectionId);
  } else {
    query = query.eq("channel_name", channel.channelName);
  }
  const { data, error } = await query.limit(skus.length * 5);
  if (error || !data) return entries;

  const latestBySku = new Map<string, { at: string; by: string | null }>();
  for (const row of data as Array<{
    sku: string;
    changed_at: string;
    changed_by: string | null;
    users?: { name: string | null } | { name: string | null }[] | null;
  }>) {
    if (latestBySku.has(row.sku)) continue;
    const u = Array.isArray(row.users) ? (row.users[0] ?? null) : (row.users ?? null);
    latestBySku.set(row.sku, {
      at: row.changed_at,
      by: u?.name ?? null,
    });
  }

  return entries.map((e) => {
    const hit = latestBySku.get(e.sku);
    if (!hit) return e;
    return { ...e, lastSafetyEditAt: hit.at, lastSafetyEditBy: hit.by };
  });
}

// ─── updateSafetyStockBulk ───────────────────────────────────────────────────

/**
 * Apply 1-200 safety_stock edits in a single Server Action call.
 *
 * Per-SKU best-effort semantics — see file-header note. Each edit is
 * independent: a SKU lookup miss or DB error on row 73 does not block
 * rows 74+.
 *
 * Audit log writes are paired with each successful application as a
 * single batched insert at the end (one PostgREST round-trip for the
 * whole batch's audit, regardless of edit count). If the audit insert
 * fails, the edit applications are left in place — the source-of-truth
 * tables are still correct — and the action returns successfully but
 * surfaces the audit failure in the response. This is intentional:
 * losing an audit row is preferable to losing the operator's edits.
 */
export async function updateSafetyStockBulk(
  rawInput: z.infer<typeof updateBulkInputSchema>,
): Promise<BulkEditResult> {
  const input = updateBulkInputSchema.parse(rawInput);
  const ctx = await requireStaffContext("updateSafetyStockBulk");
  const resolved = await resolveChannelTarget(ctx, input.channel, "updateSafetyStockBulk");

  // 1) Resolve every SKU to its variant_id within this workspace.
  const skus = Array.from(new Set(input.edits.map((e) => e.sku)));
  const { data: variantRows, error: vErr } = await ctx.supabase
    .from("warehouse_product_variants")
    .select("id, sku")
    .eq("workspace_id", ctx.workspaceId)
    .in("sku", skus);
  if (vErr) {
    throw new Error(`updateSafetyStockBulk: variant lookup failed: ${vErr.message}`);
  }
  const variantBySku = new Map<string, string>();
  for (const v of variantRows ?? []) variantBySku.set(v.sku as string, v.id as string);

  // 2) Read current values for every (channel, sku) pair so we can
  //    compute prev_* fields for the audit log + skip no-op edits.
  const variantIds = Array.from(variantBySku.values());
  const currentBySku = new Map<
    string,
    { safetyStock: number; preorderWhitelist: boolean | null }
  >();

  if (variantIds.length > 0) {
    if (resolved.kind === "storefront") {
      const { data, error } = await ctx.supabase
        .from("client_store_sku_mappings")
        .select(
          "variant_id, safety_stock, preorder_whitelist, warehouse_product_variants!inner(sku)",
        )
        .eq("connection_id", resolved.connectionId)
        .in("variant_id", variantIds);
      if (error) throw new Error(`updateSafetyStockBulk: mapping read failed: ${error.message}`);
      for (const r of data ?? []) {
        const variant = (
          r as unknown as { warehouse_product_variants: { sku: string } | { sku: string }[] }
        ).warehouse_product_variants;
        const sku = Array.isArray(variant) ? variant[0]?.sku : variant.sku;
        if (!sku) continue;
        currentBySku.set(sku, {
          safetyStock: r.safety_stock as number,
          preorderWhitelist: (r.preorder_whitelist as boolean | null) ?? false,
        });
      }
    } else {
      const { data, error } = await ctx.supabase
        .from("warehouse_safety_stock_per_channel")
        .select("variant_id, safety_stock, warehouse_product_variants!inner(sku)")
        .eq("workspace_id", ctx.workspaceId)
        .eq("channel", resolved.channelName)
        .in("variant_id", variantIds);
      if (error) throw new Error(`updateSafetyStockBulk: channel read failed: ${error.message}`);
      for (const r of data ?? []) {
        const variant = (
          r as unknown as { warehouse_product_variants: { sku: string } | { sku: string }[] }
        ).warehouse_product_variants;
        const sku = Array.isArray(variant) ? variant[0]?.sku : variant.sku;
        if (!sku) continue;
        currentBySku.set(sku, {
          safetyStock: r.safety_stock as number,
          preorderWhitelist: null,
        });
      }
    }
  }

  // 3) Walk the edits and apply each one. Collect outcomes + audit
  //    rows for the final batch insert.
  const outcomes: BulkEditOutcome[] = [];
  const auditRows: Array<{
    workspace_id: string;
    channel_kind: SafetyStockAuditChannelKind;
    connection_id: string | null;
    channel_name: string | null;
    variant_id: string;
    sku: string;
    prev_safety_stock: number | null;
    new_safety_stock: number;
    prev_preorder_whitelist: boolean | null;
    new_preorder_whitelist: boolean | null;
    reason: string | null;
    source: SafetyStockAuditSource;
    changed_by: string;
  }> = [];

  for (const edit of input.edits) {
    const variantId = variantBySku.get(edit.sku);
    if (!variantId) {
      outcomes.push({ sku: edit.sku, status: "error", error: "SKU not found in workspace" });
      continue;
    }
    const current = currentBySku.get(edit.sku);
    const prevSafety = current?.safetyStock ?? null;
    const prevWhitelist = current?.preorderWhitelist ?? null;
    const newWhitelist =
      resolved.kind === "storefront" ? (edit.newPreorderWhitelist ?? prevWhitelist ?? false) : null;

    const safetyChanged = (prevSafety ?? 0) !== edit.newSafetyStock;
    const whitelistChanged =
      resolved.kind === "storefront" && (prevWhitelist ?? false) !== (newWhitelist ?? false);
    if (!safetyChanged && !whitelistChanged) {
      outcomes.push({
        sku: edit.sku,
        status: "skipped_no_change",
        prevSafetyStock: prevSafety ?? 0,
        newSafetyStock: edit.newSafetyStock,
        prevPreorderWhitelist: prevWhitelist ?? undefined,
        newPreorderWhitelist: newWhitelist ?? undefined,
      });
      continue;
    }

    let writeErr: string | null = null;
    if (resolved.kind === "storefront") {
      // Storefront: UPDATE the existing mapping row. If no row exists
      // for this (connection, variant) yet, the operator hit "Add SKU"
      // outside this flow first — we fail this edit and let them fix
      // upstream. (We don't INSERT mappings here because mappings carry
      // remote_product_id / remote_variant_id metadata that this UI
      // doesn't have.)
      if (current === undefined) {
        outcomes.push({
          sku: edit.sku,
          status: "error",
          error:
            "No mapping exists for this SKU on this connection (use Store Connections to map first)",
        });
        continue;
      }
      const { error } = await ctx.supabase
        .from("client_store_sku_mappings")
        .update({
          safety_stock: edit.newSafetyStock,
          preorder_whitelist: newWhitelist ?? false,
          updated_at: new Date().toISOString(),
        })
        .eq("connection_id", resolved.connectionId)
        .eq("variant_id", variantId);
      if (error) writeErr = error.message;
    } else {
      // Internal channel: UPSERT when newSafetyStock>0, DELETE row
      // when newSafetyStock=0 (keeps the table sparse).
      if (edit.newSafetyStock === 0 && current !== undefined) {
        const { error } = await ctx.supabase
          .from("warehouse_safety_stock_per_channel")
          .delete()
          .eq("workspace_id", ctx.workspaceId)
          .eq("channel", resolved.channelName)
          .eq("variant_id", variantId);
        if (error) writeErr = error.message;
      } else if (edit.newSafetyStock > 0) {
        const { error } = await ctx.supabase.from("warehouse_safety_stock_per_channel").upsert(
          {
            workspace_id: ctx.workspaceId,
            variant_id: variantId,
            channel: resolved.channelName,
            safety_stock: edit.newSafetyStock,
            updated_by: ctx.userId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,variant_id,channel" },
        );
        if (error) writeErr = error.message;
      }
      // (newSafetyStock=0 + no current row) — no-op already caught
      // by safetyChanged check above.
    }

    if (writeErr) {
      outcomes.push({ sku: edit.sku, status: "error", error: writeErr });
      continue;
    }

    outcomes.push({
      sku: edit.sku,
      status: "applied",
      prevSafetyStock: prevSafety ?? 0,
      newSafetyStock: edit.newSafetyStock,
      prevPreorderWhitelist: prevWhitelist ?? undefined,
      newPreorderWhitelist: newWhitelist ?? undefined,
    });
    auditRows.push({
      workspace_id: ctx.workspaceId,
      channel_kind: resolved.kind,
      connection_id: resolved.kind === "storefront" ? resolved.connectionId : null,
      channel_name: resolved.kind === "internal" ? resolved.channelName : null,
      variant_id: variantId,
      sku: edit.sku,
      prev_safety_stock: prevSafety,
      new_safety_stock: edit.newSafetyStock,
      prev_preorder_whitelist: resolved.kind === "storefront" ? (prevWhitelist ?? null) : null,
      new_preorder_whitelist: resolved.kind === "storefront" ? (newWhitelist ?? null) : null,
      reason: input.reason ?? null,
      source: input.source,
      changed_by: ctx.userId,
    });
  }

  // 4) One batched audit insert. Best-effort — see file header.
  if (auditRows.length > 0) {
    const { error: auditErr } = await ctx.supabase
      .from("warehouse_safety_stock_audit_log")
      .insert(auditRows);
    if (auditErr) {
      // Stamp every applied outcome with an audit-failure note so the
      // UI can surface it. Source-of-truth writes are intact.
      for (const o of outcomes) {
        if (o.status === "applied") {
          o.error = `audit log insert failed (data is correct): ${auditErr.message}`;
        }
      }
    }
  }

  return {
    applied: outcomes.filter((o) => o.status === "applied").length,
    skippedNoChange: outcomes.filter((o) => o.status === "skipped_no_change").length,
    errors: outcomes.filter((o) => o.status === "error").length,
    outcomes,
  };
}

// ─── previewSafetyStockCsv + commitSafetyStockCsv ────────────────────────────

/**
 * Parse a CSV blob and produce a preview of what would change. Does
 * NOT write anything. The UI shows this preview, the operator confirms,
 * and `commitSafetyStockCsv` is called with the parsed rows.
 *
 * Expected CSV format (case-insensitive header):
 *   sku,safety_stock[,preorder_whitelist]
 *
 * The third column is optional; missing/empty preserves the current
 * value (storefront) or is ignored (internal).
 */
export async function previewSafetyStockCsv(
  rawInput: z.infer<typeof previewCsvInputSchema>,
): Promise<CsvPreviewResult> {
  const input = previewCsvInputSchema.parse(rawInput);
  const ctx = await requireStaffContext("previewSafetyStockCsv");
  const resolved = await resolveChannelTarget(ctx, input.channel, "previewSafetyStockCsv");

  const cells = parseCsv(input.csv);
  if (cells.length === 0) {
    return { rows: [], summary: { create: 0, update: 0, delete: 0, noChange: 0, error: 0 } };
  }

  // Header row — case-insensitive match.
  const header = cells[0].map((c) => c.trim().toLowerCase());
  const skuIdx = header.indexOf("sku");
  const safetyIdx = header.indexOf("safety_stock");
  const whitelistIdx = header.indexOf("preorder_whitelist");
  if (skuIdx < 0 || safetyIdx < 0) {
    throw new Error(
      "previewSafetyStockCsv: header row must contain `sku` and `safety_stock` columns",
    );
  }

  const dataRows = cells.slice(1);
  const skus = dataRows.map((r) => (r[skuIdx] ?? "").trim()).filter((s) => s.length > 0);

  // Resolve variants for these SKUs in this workspace.
  const variantBySku = new Map<string, string>();
  if (skus.length > 0) {
    const { data, error } = await ctx.supabase
      .from("warehouse_product_variants")
      .select("id, sku")
      .eq("workspace_id", ctx.workspaceId)
      .in("sku", skus);
    if (error) {
      throw new Error(`previewSafetyStockCsv: variant lookup failed: ${error.message}`);
    }
    for (const v of data ?? []) variantBySku.set(v.sku as string, v.id as string);
  }
  const variantIds = Array.from(variantBySku.values());

  // Pull current values to compute the diff.
  const currentBySku = new Map<
    string,
    { safetyStock: number; preorderWhitelist: boolean | null }
  >();
  if (variantIds.length > 0) {
    if (resolved.kind === "storefront") {
      const { data, error } = await ctx.supabase
        .from("client_store_sku_mappings")
        .select(
          "variant_id, safety_stock, preorder_whitelist, warehouse_product_variants!inner(sku)",
        )
        .eq("connection_id", resolved.connectionId)
        .in("variant_id", variantIds);
      if (error) {
        throw new Error(`previewSafetyStockCsv: storefront read failed: ${error.message}`);
      }
      for (const r of data ?? []) {
        const variant = (
          r as unknown as { warehouse_product_variants: { sku: string } | { sku: string }[] }
        ).warehouse_product_variants;
        const sku = Array.isArray(variant) ? variant[0]?.sku : variant.sku;
        if (!sku) continue;
        currentBySku.set(sku, {
          safetyStock: r.safety_stock as number,
          preorderWhitelist: (r.preorder_whitelist as boolean | null) ?? false,
        });
      }
    } else {
      const { data, error } = await ctx.supabase
        .from("warehouse_safety_stock_per_channel")
        .select("variant_id, safety_stock, warehouse_product_variants!inner(sku)")
        .eq("workspace_id", ctx.workspaceId)
        .eq("channel", resolved.channelName)
        .in("variant_id", variantIds);
      if (error) {
        throw new Error(`previewSafetyStockCsv: channel read failed: ${error.message}`);
      }
      for (const r of data ?? []) {
        const variant = (
          r as unknown as { warehouse_product_variants: { sku: string } | { sku: string }[] }
        ).warehouse_product_variants;
        const sku = Array.isArray(variant) ? variant[0]?.sku : variant.sku;
        if (!sku) continue;
        currentBySku.set(sku, {
          safetyStock: r.safety_stock as number,
          preorderWhitelist: null,
        });
      }
    }
  }

  const summary = { create: 0, update: 0, delete: 0, noChange: 0, error: 0 };
  const rows: CsvPreviewRow[] = dataRows.map((cellsRow, index) => {
    const sku = (cellsRow[skuIdx] ?? "").trim();
    const safetyRaw = (cellsRow[safetyIdx] ?? "").trim();
    const whitelistRaw = whitelistIdx >= 0 ? (cellsRow[whitelistIdx] ?? "").trim() : "";

    if (!sku) {
      summary.error += 1;
      return {
        sku,
        currentSafetyStock: null,
        currentPreorderWhitelist: null,
        newSafetyStock: 0,
        newPreorderWhitelist: null,
        changeKind: "error",
        error: `row ${index + 2}: empty sku`,
      };
    }
    const safety = Number.parseInt(safetyRaw, 10);
    if (!Number.isFinite(safety) || safety < 0 || safety > SAFETY_STOCK_MAX_VALUE) {
      summary.error += 1;
      return {
        sku,
        currentSafetyStock: null,
        currentPreorderWhitelist: null,
        newSafetyStock: 0,
        newPreorderWhitelist: null,
        changeKind: "error",
        error: `row ${index + 2}: safety_stock must be an integer 0..${SAFETY_STOCK_MAX_VALUE}`,
      };
    }
    const whitelist =
      whitelistRaw === "" ? null : ["true", "1", "yes", "y"].includes(whitelistRaw.toLowerCase());
    const variantId = variantBySku.get(sku);
    if (!variantId) {
      summary.error += 1;
      return {
        sku,
        currentSafetyStock: null,
        currentPreorderWhitelist: null,
        newSafetyStock: safety,
        newPreorderWhitelist: whitelist,
        changeKind: "error",
        error: `row ${index + 2}: SKU not found in workspace`,
      };
    }
    const current = currentBySku.get(sku);
    const currentSafety = current?.safetyStock ?? 0;
    const currentWhitelist = current?.preorderWhitelist ?? null;
    const safetyChanged = currentSafety !== safety;
    const whitelistChanged =
      resolved.kind === "storefront" &&
      whitelist !== null &&
      (currentWhitelist ?? false) !== whitelist;

    let kind: CsvPreviewRow["changeKind"];
    if (!safetyChanged && !whitelistChanged) {
      kind = "no_change";
      summary.noChange += 1;
    } else if (resolved.kind === "internal" && current === undefined && safety > 0) {
      kind = "create";
      summary.create += 1;
    } else if (resolved.kind === "internal" && safety === 0 && current !== undefined) {
      kind = "delete";
      summary.delete += 1;
    } else {
      kind = "update";
      summary.update += 1;
    }
    return {
      sku,
      currentSafetyStock: currentSafety,
      currentPreorderWhitelist: currentWhitelist,
      newSafetyStock: safety,
      newPreorderWhitelist: whitelist,
      changeKind: kind,
      error: null,
    };
  });

  return { rows, summary };
}

/**
 * Commit a previewed CSV import. Pass-through to `updateSafetyStockBulk`
 * with `source='ui_csv'`. Validation is re-run via the bulk action's
 * Zod schema as defence-in-depth — the operator's preview could have
 * been mutated client-side before commit.
 */
export async function commitSafetyStockCsv(
  rawInput: z.infer<typeof commitCsvInputSchema>,
): Promise<BulkEditResult> {
  const input = commitCsvInputSchema.parse(rawInput);
  return updateSafetyStockBulk({
    channel: input.channel,
    edits: input.edits,
    reason: input.reason,
    source: "ui_csv",
  });
}

// ─── listSafetyStockAuditLog ─────────────────────────────────────────────────

/** Read the audit log for the workspace, filtered + paged for the
 *  drawer UI. Uses `z.input<...>` so callers can omit defaulted fields
 *  (page/pageSize) — those are filled in by `.parse()`. */
export async function listSafetyStockAuditLog(
  rawInput: z.input<typeof listAuditInputSchema> = {},
): Promise<{ entries: WarehouseSafetyStockAuditLog[]; total: number }> {
  const input = listAuditInputSchema.parse(rawInput);
  const ctx = await requireStaffContext("listSafetyStockAuditLog");

  // Reject contradictory filter combinations early.
  if (input.connectionId && input.channelKind === "internal") {
    throw new Error(
      "listSafetyStockAuditLog: connectionId implies channelKind='storefront' but caller passed 'internal'",
    );
  }
  if (input.channelName && input.channelKind === "storefront") {
    throw new Error(
      "listSafetyStockAuditLog: channelName implies channelKind='internal' but caller passed 'storefront'",
    );
  }

  let query = ctx.supabase
    .from("warehouse_safety_stock_audit_log")
    .select("*", { count: "exact" })
    .eq("workspace_id", ctx.workspaceId);

  if (input.channelKind) query = query.eq("channel_kind", input.channelKind);
  if (input.connectionId) query = query.eq("connection_id", input.connectionId);
  if (input.channelName) query = query.eq("channel_name", input.channelName);
  if (input.sku) query = query.eq("sku", input.sku);

  const offset = (input.page - 1) * input.pageSize;
  const { data, count, error } = await query
    .order("changed_at", { ascending: false })
    .range(offset, offset + input.pageSize - 1);
  if (error) {
    throw new Error(`listSafetyStockAuditLog: query failed: ${error.message}`);
  }

  return {
    entries: (data ?? []) as WarehouseSafetyStockAuditLog[],
    total: count ?? data?.length ?? 0,
  };
}
