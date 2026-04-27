"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod/v4";
import {
  activateShopifyInventoryAtLocation,
  extractNumericShopifyLocationId,
} from "@/lib/clients/store-sync-client";
import { requireAuth, requireStaff } from "@/lib/server/auth-context";
import {
  buildCandidateFingerprint,
  classifyShopifyReadiness,
  fetchRemoteCatalogWithTimeout,
  pickPrimaryBandcampMapping,
  type RankedSkuCandidate,
  type RemoteCatalogFetchState,
  type RemoteCatalogItem,
  rankSkuCandidates,
  type SkuMatchingRowStatus,
  selectConnectionScopedRemoteTarget,
} from "@/lib/server/sku-matching";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { getWorkspaceFlags, invalidateWorkspaceFlags } from "@/lib/server/workspace-flags";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { normalizeSku } from "@/lib/shared/utils";

const SUPPORTED_PLATFORMS = ["shopify", "woocommerce", "squarespace"] as const;

const connectionInputSchema = z.object({
  connectionId: z.string().uuid(),
});

const previewInputSchema = z.object({
  connectionId: z.string().uuid(),
  variantId: z.string().uuid(),
  remoteVariantId: z.string().min(1).nullable().optional(),
  remoteInventoryItemId: z.string().min(1).nullable().optional(),
  remoteProductId: z.string().min(1).nullable().optional(),
  remoteSku: z.string().max(255).nullable().optional(),
});

const upsertMatchInputSchema = z.object({
  connectionId: z.string().uuid(),
  variantId: z.string().uuid(),
  remoteProductId: z.string().min(1).nullable().optional(),
  remoteVariantId: z.string().min(1).nullable().optional(),
  remoteInventoryItemId: z.string().min(1).nullable().optional(),
  remoteSku: z.string().max(255).nullable().optional(),
  fingerprint: z.string().min(8),
  matchMethod: z.enum([
    "existing_mapping",
    "exact_sku",
    "exact_barcode",
    "title_vendor_format",
    "manual",
  ]),
  matchConfidence: z.enum(["deterministic", "strong", "possible", "weak", "conflict"]),
  notes: z.string().max(1000).nullable().optional(),
  matchReasons: z.array(z.string().max(200)).max(20).default([]),
  candidateSnapshot: z
    .object({
      remoteTitle: z.string().nullable().optional(),
      reasons: z.array(z.string()).optional(),
      disqualifiers: z.array(z.string()).optional(),
      score: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

const deactivateMatchInputSchema = z.object({
  mappingId: z.string().uuid(),
  reason: z.string().min(1).max(160),
  notes: z.string().max(1000).nullable().optional(),
});

const acceptExactMatchesInputSchema = z.object({
  connectionId: z.string().uuid(),
  items: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        remoteProductId: z.string().nullable().optional(),
        remoteVariantId: z.string().nullable().optional(),
        remoteInventoryItemId: z.string().nullable().optional(),
        remoteSku: z.string().nullable().optional(),
        fingerprint: z.string().min(8),
      }),
    )
    .max(200),
});

type CanonicalVariantRow = {
  id: string;
  sku: string;
  barcode: string | null;
  title: string | null;
  price: number | null;
  option1_value: string | null;
  format_name: string | null;
  bandcamp_option_id: number | null;
  bandcamp_option_title: string | null;
  is_preorder: boolean | null;
  product_id: string;
  warehouse_products:
    | {
        id: string;
        title: string;
        vendor: string | null;
      }
    | {
        id: string;
        title: string;
        vendor: string | null;
      }[]
    | null;
  bandcamp_product_mappings:
    | {
        id: string;
        bandcamp_album_title: string | null;
        bandcamp_url: string | null;
        bandcamp_origin_quantities: unknown;
        bandcamp_item_id: number | null;
        created_at: string;
        updated_at: string | null;
      }[]
    | null;
  warehouse_inventory_levels:
    | {
        available: number;
        committed: number;
      }[]
    | null;
};

type ExistingMappingRow = {
  id: string;
  variant_id: string;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_inventory_item_id: string | null;
  remote_sku: string | null;
  is_active: boolean;
  updated_at: string;
  match_method?: string | null;
  match_confidence?: string | null;
  matched_at?: string | null;
  matched_by?: string | null;
};

type DiscogsOverlayRow = {
  variant_id: string | null;
  discogs_release_id: number;
  discogs_release_url: string | null;
  match_method: string;
  match_confidence: number | null;
  is_active: boolean;
};

type ConflictSummaryRow = {
  canonical_sku: string | null;
  remote_key: string | null;
  mapping_ids: string[] | null;
  row_count: number | null;
  reason: string | null;
};

export interface SkuMatchingConnectionSummary {
  id: string;
  orgId: string;
  orgName: string;
  platform: ClientStoreConnection["platform"];
  storeUrl: string;
  connectionStatus: string;
  activeMappingCount: number;
  isShopifyReady: boolean;
  defaultLocationId: string | null;
}

export interface SkuMatchingClientSummary {
  id: string;
  name: string;
  connectionCount: number;
}

export interface SkuMatchingRow {
  variantId: string;
  productId: string;
  canonicalSku: string;
  artist: string | null;
  canonicalTitle: string;
  bandcampTitle: string | null;
  bandcampUrl: string | null;
  format: string | null;
  variantTitle: string | null;
  barcode: string | null;
  price: number | null;
  available: number;
  committed: number;
  existingMappingId: string | null;
  remoteSku: string | null;
  remoteProductId: string | null;
  remoteVariantId: string | null;
  remoteInventoryItemId: string | null;
  matchMethod: string | null;
  matchConfidence: string | null;
  topCandidate: RankedSkuCandidate | null;
  rowStatus: SkuMatchingRowStatus;
  candidateFingerprint: string;
  discogs: {
    releaseId: number;
    releaseUrl: string | null;
    matchMethod: string;
    matchConfidence: number | null;
    isActive: boolean;
  } | null;
}

export interface SkuMatchingWorkspaceData {
  featureEnabled: boolean;
  connection: SkuMatchingConnectionSummary;
  remoteCatalogState: RemoteCatalogFetchState;
  remoteCatalogError: string | null;
  fetchedAt: string | null;
  rows: SkuMatchingRow[];
  remoteOnlyRows: RemoteCatalogItem[];
  matchedCount: number;
  needsReviewCount: number;
  remoteOnlyCount: number;
  conflictCount: number;
  canonicalDuplicateConflicts: ConflictSummaryRow[];
  remoteDuplicateConflicts: ConflictSummaryRow[];
  existingSyncConflicts: Array<{
    id: string;
    conflict_type: string;
    severity: string;
    our_sku: string | null;
    example_product_title: string | null;
    status: string;
  }>;
}

async function insertSkuMatchingPerfEvent(input: {
  workspaceId: string;
  connectionId: string;
  actorId?: string | null;
  eventType: string;
  durationMs?: number | null;
  rowCount?: number | null;
  matchedCount?: number | null;
  needsReviewCount?: number | null;
  remoteOnlyCount?: number | null;
  conflictCount?: number | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    const supabase = createServiceRoleClient();
    await supabase.from("sku_matching_perf_events").insert({
      workspace_id: input.workspaceId,
      connection_id: input.connectionId,
      actor_id: input.actorId ?? null,
      event_type: input.eventType,
      duration_ms: input.durationMs ?? null,
      row_count: input.rowCount ?? null,
      matched_count: input.matchedCount ?? null,
      needs_review_count: input.needsReviewCount ?? null,
      remote_only_count: input.remoteOnlyCount ?? null,
      conflict_count: input.conflictCount ?? null,
      metadata: input.metadata ?? {},
    });
  } catch {
    // Best-effort telemetry only.
  }
}

function asSingle<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createSkuMatchingError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function mappingRemoteKey(mapping: {
  remote_inventory_item_id?: string | null;
  remote_variant_id?: string | null;
  remote_product_id?: string | null;
  remote_sku?: string | null;
  remoteInventoryItemId?: string | null;
  remoteVariantId?: string | null;
  remoteProductId?: string | null;
  remoteSku?: string | null;
}): string {
  return (
    mapping.remote_inventory_item_id ??
    mapping.remoteInventoryItemId ??
    mapping.remote_variant_id ??
    mapping.remoteVariantId ??
    mapping.remote_product_id ??
    mapping.remoteProductId ??
    normalizeSku(mapping.remote_sku ?? mapping.remoteSku) ??
    ""
  );
}

function classifyRowStatus(input: {
  mapping: ExistingMappingRow | null;
  candidate: RankedSkuCandidate | null;
  hasDuplicateCanonical: boolean;
  hasDuplicateRemote: boolean;
  hasExistingSyncConflict: boolean;
  platform: ClientStoreConnection["platform"];
  shopifyReadyState:
    | "ready_at_default_location"
    | "missing_default_location"
    | "missing_remote_inventory_item_id"
    | "not_stocked_at_default_location"
    | "location_read_failed"
    | null;
}): SkuMatchingRowStatus {
  if (input.hasDuplicateCanonical) return "conflict_duplicate_canonical";
  if (input.hasDuplicateRemote) return "conflict_duplicate_remote";
  if (input.hasExistingSyncConflict) return "conflict_existing_sku_sync";
  if (input.mapping?.is_active) {
    if (
      input.platform === "shopify" &&
      input.shopifyReadyState &&
      input.shopifyReadyState !== "ready_at_default_location"
    ) {
      return "shopify_not_ready";
    }
    return "matched_active";
  }
  if (!input.candidate) return "needs_review_no_candidate";
  if (input.candidate.disqualifiers.length > 0) return "needs_review_multiple_candidates";
  if (
    input.candidate.confidenceTier === "deterministic" ||
    input.candidate.confidenceTier === "strong"
  ) {
    return "needs_review_low_confidence";
  }
  if (input.candidate.confidenceTier === "possible") return "needs_review_low_confidence";
  return "needs_review_multiple_candidates";
}

function classifyInitialShopifyReadiness(input: {
  platform: ClientStoreConnection["platform"];
  defaultLocationId: string | null;
  remoteInventoryItemId: string | null;
}): "missing_default_location" | "missing_remote_inventory_item_id" | null {
  if (input.platform !== "shopify") return null;
  if (!input.defaultLocationId) return "missing_default_location";
  if (!input.remoteInventoryItemId) return "missing_remote_inventory_item_id";
  return null;
}

async function assertSkuMatchingConnection(connectionId: string): Promise<{
  auth: Awaited<ReturnType<typeof requireAuth>>;
  connection: ClientStoreConnection & {
    organizations?: { name: string } | { name: string }[] | null;
  };
}> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Staff access required");
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("client_store_connections")
    .select("*, organizations(name)")
    .eq("id", connectionId)
    .eq("workspace_id", auth.userRecord.workspace_id)
    .single();

  if (error || !data) throw new Error("Connection not found");
  if (!SUPPORTED_PLATFORMS.includes(data.platform as (typeof SUPPORTED_PLATFORMS)[number])) {
    throw new Error(`Unsupported platform for SKU matching: ${data.platform}`);
  }

  return {
    auth,
    connection: data as ClientStoreConnection & {
      organizations?: { name: string } | { name: string }[] | null;
    },
  };
}

async function getCanonicalRows(
  workspaceId: string,
  orgId: string,
): Promise<CanonicalVariantRow[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("warehouse_product_variants")
    .select(
      `
      id,
      sku,
      barcode,
      title,
      price,
      option1_value,
      format_name,
      bandcamp_option_id,
      bandcamp_option_title,
      is_preorder,
      product_id,
      warehouse_products!inner(id, title, vendor),
      bandcamp_product_mappings(
        id,
        bandcamp_album_title,
        bandcamp_url,
        bandcamp_origin_quantities,
        bandcamp_item_id,
        created_at,
        updated_at
      ),
      warehouse_inventory_levels(available, committed)
    `,
    )
    .eq("workspace_id", workspaceId)
    .eq("warehouse_products.org_id", orgId)
    .order("sku", { ascending: true });

  if (error) throw new Error(`Canonical variant load failed: ${error.message}`);
  return (data ?? []) as CanonicalVariantRow[];
}

async function getExistingMappings(
  connectionId: string,
): Promise<{ byVariantId: Map<string, ExistingMappingRow>; remoteKeys: Set<string> }> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("client_store_sku_mappings")
    .select(
      "id, variant_id, remote_product_id, remote_variant_id, remote_inventory_item_id, remote_sku, is_active, updated_at, match_method, match_confidence, matched_at, matched_by",
    )
    .eq("connection_id", connectionId)
    .eq("is_active", true);

  if (error) throw new Error(`Existing mapping load failed: ${error.message}`);

  const byVariantId = new Map<string, ExistingMappingRow>();
  const remoteKeys = new Set<string>();

  for (const row of (data ?? []) as ExistingMappingRow[]) {
    byVariantId.set(row.variant_id, row);
    const key = mappingRemoteKey({
      remote_inventory_item_id: row.remote_inventory_item_id,
      remote_variant_id: row.remote_variant_id,
      remote_product_id: row.remote_product_id,
      remote_sku: row.remote_sku,
    });
    if (key) remoteKeys.add(key);
  }

  return { byVariantId, remoteKeys };
}

async function getDiscogsOverlays(
  workspaceId: string,
  variantIds: string[],
): Promise<Map<string, DiscogsOverlayRow>> {
  if (variantIds.length === 0) return new Map();
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("discogs_product_mappings")
    .select(
      "variant_id, discogs_release_id, discogs_release_url, match_method, match_confidence, is_active",
    )
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .in("variant_id", variantIds);

  if (error) throw new Error(`Discogs overlay load failed: ${error.message}`);
  return new Map(
    ((data ?? []) as DiscogsOverlayRow[])
      .filter((row) => Boolean(row.variant_id))
      .map((row) => [row.variant_id as string, row]),
  );
}

async function getExistingSkuConflicts(workspaceId: string): Promise<
  Map<
    string,
    {
      id: string;
      conflict_type: string;
      severity: string;
      our_sku: string | null;
      example_product_title: string | null;
      status: string;
    }
  >
> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("sku_sync_conflicts")
    .select("id, our_sku, conflict_type, severity, example_product_title, status")
    .eq("workspace_id", workspaceId)
    .in("status", ["open", "in_progress"]);

  if (error) throw new Error(`SKU conflict load failed: ${error.message}`);

  const map = new Map<
    string,
    {
      id: string;
      conflict_type: string;
      severity: string;
      our_sku: string | null;
      example_product_title: string | null;
      status: string;
    }
  >();
  for (const row of data ?? []) {
    if (typeof row.our_sku === "string" && row.our_sku.trim()) {
      map.set(normalizeSku(row.our_sku) ?? row.our_sku, {
        id: row.id,
        conflict_type: row.conflict_type,
        severity: row.severity,
        our_sku: row.our_sku,
        example_product_title: row.example_product_title,
        status: row.status,
      });
    }
  }
  return map;
}

async function loadConflictSummaries(
  workspaceId: string,
  connectionId: string,
): Promise<{
  canonicalDuplicateConflicts: ConflictSummaryRow[];
  remoteDuplicateConflicts: ConflictSummaryRow[];
}> {
  const supabase = createServiceRoleClient();

  const [canonicalDupes, remoteDupes] = await Promise.all([
    supabase.rpc("find_canonical_sku_duplicates", {
      p_workspace_id: workspaceId,
      p_connection_id: connectionId,
    }),
    supabase.rpc("find_remote_to_canonical_dupes", {
      p_workspace_id: workspaceId,
      p_connection_id: connectionId,
    }),
  ]);

  return {
    canonicalDuplicateConflicts: canonicalDupes.error
      ? []
      : ((canonicalDupes.data ?? []) as ConflictSummaryRow[]),
    remoteDuplicateConflicts: remoteDupes.error
      ? []
      : ((remoteDupes.data ?? []) as ConflictSummaryRow[]),
  };
}

function toConnectionSummary(
  connection: ClientStoreConnection & {
    organizations?: { name: string } | { name: string }[] | null;
  },
  activeMappingCount: number,
): SkuMatchingConnectionSummary {
  const orgName = asSingle(connection.organizations)?.name ?? "Unknown org";
  return {
    id: connection.id,
    orgId: connection.org_id,
    orgName,
    platform: connection.platform,
    storeUrl: connection.store_url,
    connectionStatus: connection.connection_status,
    activeMappingCount,
    isShopifyReady: Boolean(connection.default_location_id),
    defaultLocationId: connection.default_location_id,
  };
}

export async function listSkuMatchingClients(): Promise<SkuMatchingClientSummary[]> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, client_store_connections!left(id, platform)")
    .eq("workspace_id", auth.userRecord.workspace_id)
    .order("name", { ascending: true });

  if (error) throw new Error(`Client list failed: ${error.message}`);

  return toPlainJson(
    (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      connectionCount: Array.isArray(row.client_store_connections)
        ? row.client_store_connections.length
        : 0,
    })),
  );
}

export async function listSkuMatchingConnections(input?: {
  orgId?: string;
}): Promise<SkuMatchingConnectionSummary[]> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();
  let query = supabase
    .from("client_store_connections")
    .select("*, organizations(name)")
    .eq("workspace_id", auth.userRecord.workspace_id)
    .in("platform", [...SUPPORTED_PLATFORMS])
    .order("created_at", { ascending: false });

  if (input?.orgId) query = query.eq("org_id", input.orgId);

  const { data, error } = await query;
  if (error) throw new Error(`Connection list failed: ${error.message}`);

  const connectionIds = (data ?? []).map((row) => row.id);
  const mappingCounts = new Map<string, number>();
  if (connectionIds.length > 0) {
    const { data: mappings } = await supabase
      .from("client_store_sku_mappings")
      .select("connection_id")
      .in("connection_id", connectionIds)
      .eq("is_active", true);

    for (const row of mappings ?? []) {
      mappingCounts.set(row.connection_id, (mappingCounts.get(row.connection_id) ?? 0) + 1);
    }
  }

  return toPlainJson(
    (data ?? []).map((row) =>
      toConnectionSummary(
        row as ClientStoreConnection & {
          organizations?: { name: string } | { name: string }[] | null;
        },
        mappingCounts.get(row.id) ?? 0,
      ),
    ),
  );
}

export async function getSkuMatchingWorkspace(
  rawInput: z.input<typeof connectionInputSchema>,
): Promise<SkuMatchingWorkspaceData> {
  const startedAt = Date.now();
  const parsed = connectionInputSchema.parse(rawInput);
  const { auth, connection } = await assertSkuMatchingConnection(parsed.connectionId);
  const [flags, remoteCatalog, canonicalRows, existingMappings, conflictMap, conflictSummaries] =
    await Promise.all([
      getWorkspaceFlags(auth.userRecord.workspace_id),
      fetchRemoteCatalogWithTimeout(connection),
      getCanonicalRows(connection.workspace_id, connection.org_id),
      getExistingMappings(connection.id),
      getExistingSkuConflicts(connection.workspace_id),
      loadConflictSummaries(connection.workspace_id, connection.id),
    ]);
  const discogs = await getDiscogsOverlays(
    connection.workspace_id,
    canonicalRows.map((row) => row.id),
  );
  const { canonicalDuplicateConflicts, remoteDuplicateConflicts } = conflictSummaries;

  const duplicateCanonicalSkuSet = new Set(
    canonicalDuplicateConflicts
      .map((row) => row.canonical_sku)
      .filter((value): value is string => Boolean(value)),
  );
  const duplicateRemoteKeySet = new Set(
    remoteDuplicateConflicts
      .map((row) => row.remote_key)
      .filter((value): value is string => Boolean(value)),
  );

  const rows: SkuMatchingRow[] = [];
  const remoteOnlyRows: RemoteCatalogItem[] = [];
  const matchedCount = { value: 0 };
  const needsReviewCount = { value: 0 };
  const remoteOnlyCount = { value: 0 };
  const conflictCount = { value: 0 };

  for (const canonical of canonicalRows) {
    const product = asSingle(canonical.warehouse_products);
    if (!product || !canonical.sku) continue;
    const inventory = asSingle(canonical.warehouse_inventory_levels);
    const bandcamp = pickPrimaryBandcampMapping(canonical.bandcamp_product_mappings);
    const existingMapping = existingMappings.byVariantId.get(canonical.id) ?? null;

    const canonicalSignal = {
      variantId: canonical.id,
      sku: canonical.sku,
      barcode: canonical.barcode,
      artist: product.vendor,
      title: product.title,
      bandcampTitle: bandcamp?.bandcamp_album_title ?? null,
      format: canonical.format_name,
      variantTitle: canonical.title,
      optionValue: canonical.option1_value,
      isPreorder: Boolean(canonical.is_preorder),
      price: canonical.price,
      bandcampOptionId: canonical.bandcamp_option_id,
      bandcampOptionTitle: canonical.bandcamp_option_title,
      bandcampOriginQuantities: bandcamp?.bandcamp_origin_quantities ?? null,
    };

    const ranked = rankSkuCandidates(canonicalSignal, remoteCatalog.items);

    const topCandidate = ranked[0] ?? null;
    const existingTargetSelection =
      remoteCatalog.state === "ok" && existingMapping
        ? selectConnectionScopedRemoteTarget({
            items: remoteCatalog.items,
            remoteInventoryItemId: existingMapping.remote_inventory_item_id,
            remoteVariantId: existingMapping.remote_variant_id,
            remoteProductId: existingMapping.remote_product_id,
            remoteSku: existingMapping.remote_sku,
          })
        : null;
    const existingTarget = existingTargetSelection?.ok ? existingTargetSelection.target : null;
    const fingerprintCandidate = existingTarget
      ? (rankSkuCandidates(canonicalSignal, [existingTarget])[0] ?? null)
      : topCandidate;
    const topRemoteKey = topCandidate ? mappingRemoteKey(topCandidate.remote) : "";
    const shopifyReadyState = classifyInitialShopifyReadiness({
      platform: connection.platform,
      defaultLocationId: connection.default_location_id,
      remoteInventoryItemId:
        existingMapping?.remote_inventory_item_id ??
        topCandidate?.remote.remoteInventoryItemId ??
        null,
    });

    const rowStatus = classifyRowStatus({
      mapping: existingMapping,
      candidate: topCandidate,
      hasDuplicateCanonical: duplicateCanonicalSkuSet.has(canonical.sku),
      hasDuplicateRemote: Boolean(topRemoteKey) && duplicateRemoteKeySet.has(topRemoteKey),
      hasExistingSyncConflict: conflictMap.has(normalizeSku(canonical.sku) ?? canonical.sku),
      platform: connection.platform,
      shopifyReadyState,
    });

    if (rowStatus === "matched_active") matchedCount.value += 1;
    else if (rowStatus.startsWith("conflict_") || rowStatus === "shopify_not_ready")
      conflictCount.value += 1;
    else needsReviewCount.value += 1;

    const discogsOverlay = discogs.get(canonical.id) ?? null;

    rows.push({
      variantId: canonical.id,
      productId: canonical.product_id,
      canonicalSku: canonical.sku,
      artist: product.vendor,
      canonicalTitle: product.title,
      bandcampTitle: bandcamp?.bandcamp_album_title ?? null,
      bandcampUrl: bandcamp?.bandcamp_url ?? null,
      format: canonical.format_name,
      variantTitle: canonical.title,
      barcode: canonical.barcode,
      price: canonical.price,
      available: inventory?.available ?? 0,
      committed: inventory?.committed ?? 0,
      existingMappingId: existingMapping?.id ?? null,
      remoteSku: existingMapping?.remote_sku ?? topCandidate?.remote.remoteSku ?? null,
      remoteProductId:
        existingMapping?.remote_product_id ?? topCandidate?.remote.remoteProductId ?? null,
      remoteVariantId:
        existingMapping?.remote_variant_id ?? topCandidate?.remote.remoteVariantId ?? null,
      remoteInventoryItemId:
        existingMapping?.remote_inventory_item_id ??
        topCandidate?.remote.remoteInventoryItemId ??
        null,
      matchMethod: existingMapping?.match_method ?? topCandidate?.matchMethod ?? null,
      matchConfidence: existingMapping?.match_confidence ?? topCandidate?.confidenceTier ?? null,
      topCandidate,
      rowStatus,
      candidateFingerprint: buildCandidateFingerprint({
        variantId: canonical.id,
        canonicalSku: canonical.sku,
        canonicalBarcode: canonical.barcode,
        remoteProductId:
          existingMapping?.remote_product_id ?? topCandidate?.remote.remoteProductId ?? null,
        remoteVariantId:
          existingMapping?.remote_variant_id ?? topCandidate?.remote.remoteVariantId ?? null,
        remoteInventoryItemId:
          existingMapping?.remote_inventory_item_id ??
          topCandidate?.remote.remoteInventoryItemId ??
          null,
        remoteSku: existingMapping?.remote_sku ?? topCandidate?.remote.remoteSku ?? null,
        existingMappingId: existingMapping?.id ?? null,
        existingMappingUpdatedAt: existingMapping?.updated_at ?? null,
        disqualifiers: fingerprintCandidate?.disqualifiers ?? [],
      }),
      discogs: discogsOverlay
        ? {
            releaseId: discogsOverlay.discogs_release_id,
            releaseUrl: discogsOverlay.discogs_release_url,
            matchMethod: discogsOverlay.match_method,
            matchConfidence: discogsOverlay.match_confidence,
            isActive: discogsOverlay.is_active,
          }
        : null,
    });
  }

  if (remoteCatalog.state === "ok") {
    for (const item of remoteCatalog.items) {
      const key = mappingRemoteKey(item);
      if (!key || existingMappings.remoteKeys.has(key)) continue;
      remoteOnlyCount.value += 1;
      remoteOnlyRows.push(item);
    }
  }

  await insertSkuMatchingPerfEvent({
    workspaceId: connection.workspace_id,
    connectionId: connection.id,
    actorId: auth.userRecord.id,
    eventType: "workspace_load",
    durationMs: Date.now() - startedAt,
    rowCount: rows.length,
    matchedCount: matchedCount.value,
    needsReviewCount: needsReviewCount.value,
    remoteOnlyCount: remoteOnlyCount.value,
    conflictCount: conflictCount.value,
    metadata: { remoteCatalogState: remoteCatalog.state },
  });

  return toPlainJson({
    featureEnabled: Boolean(flags.sku_matching_enabled),
    connection: toConnectionSummary(connection, existingMappings.byVariantId.size),
    remoteCatalogState: remoteCatalog.state,
    remoteCatalogError: remoteCatalog.error,
    fetchedAt: remoteCatalog.fetchedAt,
    rows,
    remoteOnlyRows,
    matchedCount: matchedCount.value,
    needsReviewCount: needsReviewCount.value,
    remoteOnlyCount: remoteOnlyCount.value,
    conflictCount: conflictCount.value,
    canonicalDuplicateConflicts,
    remoteDuplicateConflicts,
    existingSyncConflicts: Array.from(conflictMap.values()),
  });
}

export async function getSkuMatchCandidates(rawInput: z.input<typeof previewInputSchema>): Promise<{
  candidates: RankedSkuCandidate[];
  remoteCatalogState: RemoteCatalogFetchState;
  remoteCatalogError: string | null;
}> {
  const parsed = previewInputSchema.parse(rawInput);
  const { connection } = await assertSkuMatchingConnection(parsed.connectionId);
  const canonicalRows = await getCanonicalRows(connection.workspace_id, connection.org_id);
  const canonical = canonicalRows.find((row) => row.id === parsed.variantId);
  if (!canonical) throw new Error("Variant not found for this connection");

  const product = asSingle(canonical.warehouse_products);
  const bandcamp = pickPrimaryBandcampMapping(canonical.bandcamp_product_mappings);
  if (!product) throw new Error("Variant has no canonical product");

  const remoteCatalog = await fetchRemoteCatalogWithTimeout(connection);
  if (remoteCatalog.state !== "ok") {
    return toPlainJson({
      candidates: [],
      remoteCatalogState: remoteCatalog.state,
      remoteCatalogError: remoteCatalog.error,
    });
  }

  const candidates = rankSkuCandidates(
    {
      variantId: canonical.id,
      sku: canonical.sku,
      barcode: canonical.barcode,
      artist: product.vendor,
      title: product.title,
      bandcampTitle: bandcamp?.bandcamp_album_title ?? null,
      format: canonical.format_name,
      variantTitle: canonical.title,
      optionValue: canonical.option1_value,
      isPreorder: Boolean(canonical.is_preorder),
      price: canonical.price,
      bandcampOptionId: canonical.bandcamp_option_id,
      bandcampOptionTitle: canonical.bandcamp_option_title,
      bandcampOriginQuantities: bandcamp?.bandcamp_origin_quantities ?? null,
    },
    remoteCatalog.items,
  );

  return toPlainJson({
    candidates,
    remoteCatalogState: remoteCatalog.state,
    remoteCatalogError: remoteCatalog.error,
  });
}

async function previewSkuMatchInternal(rawInput: z.input<typeof previewInputSchema>) {
  const startedAt = Date.now();
  const parsed = previewInputSchema.parse(rawInput);
  const { auth, connection } = await assertSkuMatchingConnection(parsed.connectionId);

  const [canonicalRows, existingMappings, remoteCatalog] = await Promise.all([
    getCanonicalRows(connection.workspace_id, connection.org_id),
    getExistingMappings(connection.id),
    fetchRemoteCatalogWithTimeout(connection),
  ]);

  const canonical = canonicalRows.find((row) => row.id === parsed.variantId);
  if (!canonical) throw new Error("Variant not found for this connection");
  const product = asSingle(canonical.warehouse_products);
  const bandcamp = pickPrimaryBandcampMapping(canonical.bandcamp_product_mappings);
  if (!product) throw new Error("Variant has no canonical product");

  let targetRemote: RemoteCatalogItem | null = null;
  let targetError: { code: string; message: string } | null = null;
  if (remoteCatalog.state === "ok") {
    const targetSelection = selectConnectionScopedRemoteTarget({
      items: remoteCatalog.items,
      remoteInventoryItemId: parsed.remoteInventoryItemId,
      remoteVariantId: parsed.remoteVariantId,
      remoteProductId: parsed.remoteProductId,
      remoteSku: parsed.remoteSku,
    });
    if (targetSelection.ok) {
      targetRemote = targetSelection.target;
    } else {
      targetError = {
        code: targetSelection.code,
        message: targetSelection.message,
      };
    }
  }

  const ranked =
    remoteCatalog.state === "ok"
      ? rankSkuCandidates(
          {
            variantId: canonical.id,
            sku: canonical.sku,
            barcode: canonical.barcode,
            artist: product.vendor,
            title: product.title,
            bandcampTitle: bandcamp?.bandcamp_album_title ?? null,
            format: canonical.format_name,
            variantTitle: canonical.title,
            optionValue: canonical.option1_value,
            isPreorder: Boolean(canonical.is_preorder),
            price: canonical.price,
            bandcampOptionId: canonical.bandcamp_option_id,
            bandcampOptionTitle: canonical.bandcamp_option_title,
            bandcampOriginQuantities: bandcamp?.bandcamp_origin_quantities ?? null,
          },
          targetRemote ? [targetRemote] : remoteCatalog.items,
        )
      : [];

  const existingMapping = existingMappings.byVariantId.get(parsed.variantId) ?? null;
  const readiness =
    connection.platform === "shopify"
      ? await classifyShopifyReadiness({
          connection,
          remoteInventoryItemId:
            targetRemote?.remoteInventoryItemId ??
            existingMapping?.remote_inventory_item_id ??
            null,
        })
      : null;

  const candidate = ranked[0] ?? null;
  const fingerprint = buildCandidateFingerprint({
    variantId: canonical.id,
    canonicalSku: canonical.sku,
    canonicalBarcode: canonical.barcode,
    remoteProductId: targetRemote?.remoteProductId ?? existingMapping?.remote_product_id ?? null,
    remoteVariantId: targetRemote?.remoteVariantId ?? existingMapping?.remote_variant_id ?? null,
    remoteInventoryItemId:
      targetRemote?.remoteInventoryItemId ?? existingMapping?.remote_inventory_item_id ?? null,
    remoteSku: targetRemote?.remoteSku ?? existingMapping?.remote_sku ?? null,
    existingMappingId: existingMapping?.id ?? null,
    existingMappingUpdatedAt: existingMapping?.updated_at ?? null,
    disqualifiers: candidate?.disqualifiers ?? [],
  });

  await insertSkuMatchingPerfEvent({
    workspaceId: connection.workspace_id,
    connectionId: connection.id,
    actorId: auth.userRecord.id,
    eventType: "preview_open",
    durationMs: Date.now() - startedAt,
    conflictCount: candidate?.disqualifiers.length ?? 0,
    metadata: {
      variantId: parsed.variantId,
      remoteCatalogState: remoteCatalog.state,
      hasTargetRemote: Boolean(targetRemote),
      targetError,
    },
  });

  return {
    canonical: {
      variantId: canonical.id,
      sku: canonical.sku,
      barcode: canonical.barcode,
      title: product.title,
      artist: product.vendor,
      format: canonical.format_name,
      bandcampTitle: bandcamp?.bandcamp_album_title ?? null,
      bandcampUrl: bandcamp?.bandcamp_url ?? null,
    },
    existingMapping,
    targetRemote,
    targetError,
    candidate,
    fingerprint,
    shopifyReadiness: readiness,
    remoteCatalogState: remoteCatalog.state,
    remoteCatalogError: remoteCatalog.error,
  };
}

export async function previewSkuMatch(rawInput: z.input<typeof previewInputSchema>) {
  return toPlainJson(await previewSkuMatchInternal(rawInput));
}

export async function createOrUpdateSkuMatch(rawInput: z.input<typeof upsertMatchInputSchema>) {
  const parsed = upsertMatchInputSchema.parse(rawInput);
  const { auth } = await assertSkuMatchingConnection(parsed.connectionId);

  const preview = await previewSkuMatchInternal({
    connectionId: parsed.connectionId,
    variantId: parsed.variantId,
    remoteProductId: parsed.remoteProductId,
    remoteVariantId: parsed.remoteVariantId,
    remoteInventoryItemId: parsed.remoteInventoryItemId,
    remoteSku: parsed.remoteSku,
  });

  if (preview.targetError) {
    throw createSkuMatchingError(preview.targetError.code, preview.targetError.message);
  }
  if (preview.fingerprint !== parsed.fingerprint) {
    throw createSkuMatchingError(
      "stale_candidate",
      "Match candidate changed since review. Refresh and confirm again.",
    );
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("persist_sku_match", {
    p_workspace_id: auth.userRecord.workspace_id,
    p_connection_id: parsed.connectionId,
    p_variant_id: parsed.variantId,
    p_remote_product_id: parsed.remoteProductId ?? null,
    p_remote_variant_id: parsed.remoteVariantId ?? null,
    p_remote_inventory_item_id: parsed.remoteInventoryItemId ?? null,
    p_remote_sku: parsed.remoteSku ?? null,
    p_actor_id: auth.userRecord.id,
    p_match_method: parsed.matchMethod,
    p_match_confidence: parsed.matchConfidence,
    p_match_reasons: parsed.matchReasons,
    p_candidate_snapshot: parsed.candidateSnapshot ?? {},
    p_candidate_fingerprint: parsed.fingerprint,
    p_notes: parsed.notes ?? null,
  });
  if (error)
    throw createSkuMatchingError("persist_failed", `persist_sku_match failed: ${error.message}`);

  await insertSkuMatchingPerfEvent({
    workspaceId: auth.userRecord.workspace_id,
    connectionId: parsed.connectionId,
    actorId: auth.userRecord.id,
    eventType: "match_accept",
    metadata: {
      variantId: parsed.variantId,
      matchMethod: parsed.matchMethod,
      matchConfidence: parsed.matchConfidence,
    },
  });

  revalidatePath("/admin/settings/sku-matching");
  return { success: true, mapping: toPlainJson(data) };
}

export async function deactivateSkuMatch(rawInput: z.input<typeof deactivateMatchInputSchema>) {
  const parsed = deactivateMatchInputSchema.parse(rawInput);
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Staff access required");
  const supabase = createServiceRoleClient();

  const { data: mapping, error: mappingError } = await supabase
    .from("client_store_sku_mappings")
    .select("id, workspace_id, connection_id, variant_id")
    .eq("id", parsed.mappingId)
    .eq("workspace_id", auth.userRecord.workspace_id)
    .single();
  if (mappingError || !mapping) throw new Error("Mapping not found");

  const { error } = await supabase
    .from("client_store_sku_mappings")
    .update({
      is_active: false,
      deactivation_reason: parsed.reason,
      deactivated_by: auth.userRecord.id,
      deactivated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.mappingId)
    .eq("workspace_id", auth.userRecord.workspace_id);
  if (error) throw new Error(`deactivateSkuMatch failed: ${error.message}`);

  const { error: eventError } = await supabase.from("sku_mapping_events").insert({
    workspace_id: auth.userRecord.workspace_id,
    mapping_id: mapping.id,
    connection_id: mapping.connection_id,
    variant_id: mapping.variant_id,
    event_type: "deactivated",
    actor_id: auth.userRecord.id,
    actor_role: auth.userRecord.role,
    deactivation_reason: parsed.reason,
    notes: parsed.notes ?? null,
  });
  if (eventError) throw new Error(`deactivateSkuMatch audit failed: ${eventError.message}`);

  await insertSkuMatchingPerfEvent({
    workspaceId: auth.userRecord.workspace_id,
    connectionId: mapping.connection_id,
    actorId: auth.userRecord.id,
    eventType: "match_deactivate",
    metadata: { mappingId: parsed.mappingId, reason: parsed.reason },
  });

  revalidatePath("/admin/settings/sku-matching");
  return { success: true };
}

export async function getShopifyMatchReadiness(rawInput: z.input<typeof previewInputSchema>) {
  const parsed = previewInputSchema.parse(rawInput);
  const { connection } = await assertSkuMatchingConnection(parsed.connectionId);
  if (connection.platform !== "shopify") {
    return toPlainJson({
      state: "not_supported",
      available: null,
      message: "Readiness checks only apply to Shopify connections.",
    });
  }

  return toPlainJson(
    await classifyShopifyReadiness({
      connection,
      remoteInventoryItemId: parsed.remoteInventoryItemId ?? null,
    }),
  );
}

export async function activateShopifyInventoryAtDefaultLocation(
  rawInput: z.input<typeof previewInputSchema>,
) {
  const parsed = previewInputSchema.parse(rawInput);
  const { connection } = await assertSkuMatchingConnection(parsed.connectionId);
  if (connection.platform !== "shopify") {
    throw new Error("Shopify activation only applies to Shopify connections.");
  }
  const locationId = extractNumericShopifyLocationId(connection.default_location_id);
  if (!locationId) {
    throw new Error("Set a default Shopify location before activating inventory.");
  }
  const inventoryItemId = parsed.remoteInventoryItemId
    ? Number(parsed.remoteInventoryItemId.replace(/\D+/g, ""))
    : NaN;
  if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
    throw new Error("Missing or invalid Shopify inventory item id.");
  }

  const supabase = createServiceRoleClient();
  const { data: variant, error } = await supabase
    .from("warehouse_product_variants")
    .select("sku")
    .eq("id", parsed.variantId)
    .maybeSingle();
  if (error || !variant) throw new Error("Variant not found");

  await activateShopifyInventoryAtLocation({
    connection,
    inventoryItemId,
    locationId,
    sku: variant.sku,
  });

  revalidatePath("/admin/settings/sku-matching");
  return { success: true };
}

export async function acceptExactMatches(rawInput: z.input<typeof acceptExactMatchesInputSchema>) {
  const parsed = acceptExactMatchesInputSchema.parse(rawInput);
  const { auth } = await assertSkuMatchingConnection(parsed.connectionId);

  const results: Array<{ variantId: string; success: boolean; error?: string }> = [];
  for (const item of parsed.items) {
    try {
      const preview = await previewSkuMatchInternal({
        connectionId: parsed.connectionId,
        variantId: item.variantId,
        remoteProductId: item.remoteProductId,
        remoteVariantId: item.remoteVariantId,
        remoteInventoryItemId: item.remoteInventoryItemId,
        remoteSku: item.remoteSku,
      });

      if (preview.targetError) {
        throw createSkuMatchingError(preview.targetError.code, preview.targetError.message);
      }
      if (!preview.candidate || preview.candidate.confidenceTier !== "deterministic") {
        throw new Error("Only deterministic matches can be bulk accepted.");
      }
      if (preview.fingerprint !== item.fingerprint) {
        throw new Error("Fingerprint changed; refresh before bulk accept.");
      }

      const supabase = createServiceRoleClient();
      const { error } = await supabase.rpc("persist_sku_match", {
        p_workspace_id: auth.userRecord.workspace_id,
        p_connection_id: parsed.connectionId,
        p_variant_id: item.variantId,
        p_remote_product_id: item.remoteProductId ?? null,
        p_remote_variant_id: item.remoteVariantId ?? null,
        p_remote_inventory_item_id: item.remoteInventoryItemId ?? null,
        p_remote_sku: item.remoteSku ?? null,
        p_actor_id: auth.userRecord.id,
        p_match_method: "exact_sku",
        p_match_confidence: "deterministic",
        p_match_reasons: preview.candidate.reasons,
        p_candidate_snapshot: {
          remoteTitle: preview.targetRemote?.combinedTitle ?? null,
          reasons: preview.candidate.reasons,
          disqualifiers: preview.candidate.disqualifiers,
          score: preview.candidate.score,
        },
        p_candidate_fingerprint: item.fingerprint,
        p_notes: "Bulk accepted deterministic match",
      });
      if (error) throw new Error(error.message);
      results.push({ variantId: item.variantId, success: true });
    } catch (error) {
      results.push({
        variantId: item.variantId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await insertSkuMatchingPerfEvent({
    workspaceId: auth.userRecord.workspace_id,
    connectionId: parsed.connectionId,
    actorId: auth.userRecord.id,
    eventType: "bulk_accept",
    rowCount: parsed.items.length,
    metadata: {
      successCount: results.filter((result) => result.success).length,
      failureCount: results.filter((result) => !result.success).length,
    },
  });

  revalidatePath("/admin/settings/sku-matching");
  return toPlainJson({ success: true, results });
}

export async function enableSkuMatchingFeatureFlag(): Promise<{ success: true }> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();
  const flags = await getWorkspaceFlags(workspaceId);
  const nextFlags = { ...flags, sku_matching_enabled: true };
  const { error } = await supabase
    .from("workspaces")
    .update({ flags: nextFlags })
    .eq("id", workspaceId);
  if (error) throw new Error(`Failed to enable SKU matching flag: ${error.message}`);
  invalidateWorkspaceFlags(workspaceId);
  revalidatePath("/admin/settings/feature-flags");
  revalidatePath("/admin/settings/sku-matching");
  return { success: true };
}
