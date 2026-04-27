import { createHash } from "node:crypto";
import {
  type ConfidenceTier,
  fetchRemoteCatalogWithTimeout,
  type RankedSkuCandidate,
  type RemoteCatalogFetchState,
  type RemoteCatalogResult,
  rankSkuCandidates,
} from "@/lib/server/sku-matching";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";

const SUPPORTED_PLATFORMS = ["shopify", "woocommerce", "squarespace"] as const;
const DECISION_BATCH_SIZE = 100;
const CANCELLATION_POLL_INTERVAL = 25;

export type SkuAutonomousDryRunTriggerSource =
  | "manual_admin"
  | "scheduled_periodic"
  | "connection_added"
  | "evidence_change_trigger"
  | "stock_change_trigger";

export interface RunSkuAutonomousDryRunInput {
  workspaceId?: string;
  connectionId?: string;
  triggeredBy?: string;
  triggerSource?: SkuAutonomousDryRunTriggerSource;
  limitPerConnection?: number;
}

export interface DryRunConnectionSummary {
  workspaceId: string;
  connectionId: string;
  platform: string;
  runId: string | null;
  status: "completed" | "failed" | "cancelled" | "skipped_paused" | "run_open_failed";
  variantsEvaluated: number;
  outcomesBreakdown: Record<string, number>;
  confidenceBreakdown: Record<string, number>;
  candidatesWithNoMatch: number;
  candidatesWithDisqualifiers: number;
  fetchStatus: DryRunDecisionFetchStatus;
  errorCount: number;
  errors: string[];
}

export interface SkuAutonomousDryRunResult {
  connectionsScanned: number;
  connectionsSkippedPaused: number;
  runsOpened: number;
  variantsEvaluated: number;
  decisionsWritten: number;
  outcomesBreakdown: Record<string, number>;
  confidenceBreakdown: Record<string, number>;
  candidatesWithNoMatch: number;
  candidatesWithDisqualifiers: number;
  errors: string[];
  connectionSummaries: DryRunConnectionSummary[];
}

type SupabaseClient = ReturnType<typeof createServiceRoleClient>;

interface SkuAutonomousDryRunDeps {
  supabase?: SupabaseClient;
  fetchRemoteCatalog?: (connection: ClientStoreConnection) => Promise<RemoteCatalogResult>;
  now?: () => number;
}

type DryRunDecisionFetchStatus =
  | "ok"
  | "timeout"
  | "auth_error"
  | "unavailable"
  | "unsupported"
  | "partial";

type DryRunOutcomeState =
  | "auto_live_inventory_alias"
  | "auto_database_identity_match"
  | "auto_holdout_for_evidence"
  | "auto_reject_non_match"
  | "fetch_incomplete_holdout";

interface ConnectionRow {
  id: string;
  workspace_id: string;
  org_id: string | null;
  platform: string;
  connection_status: string | null;
  store_url: string | null;
  api_key?: string | null;
  api_secret?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  shopify_shop_domain?: string | null;
  shopify_access_token?: string | null;
  default_location_id?: string | null;
  metadata?: unknown;
}

interface WorkspacePauseRow {
  id: string;
  sku_autonomous_emergency_paused: boolean | null;
}

interface CanonicalVariantRow {
  id: string;
  sku: string | null;
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
    | { id: string; title: string | null; vendor: string | null }
    | { id: string; title: string | null; vendor: string | null }[]
    | null;
  bandcamp_product_mappings:
    | {
        bandcamp_album_title: string | null;
        bandcamp_origin_quantities: unknown;
        bandcamp_item_id: number | null;
      }[]
    | null;
}

interface ExistingMappingRow {
  id: string;
  variant_id: string | null;
  remote_sku: string | null;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_inventory_item_id: string | null;
  match_method: string | null;
  match_confidence: string | null;
}

interface DryRunDecisionDraft {
  workspace_id: string;
  connection_id: string;
  variant_id: string;
  outcome_state: DryRunOutcomeState;
  previous_outcome_state: null;
  outcome_changed: boolean;
  match_method: string | null;
  match_confidence: string | null;
  reason_code: string;
  evidence_snapshot: Record<string, unknown>;
  evidence_hash: string;
  disqualifiers: string[];
  top_candidates: ReturnType<typeof serializeTopCandidates>;
  fetch_status: DryRunDecisionFetchStatus;
  fetch_completed_at: string | null;
  fetch_duration_ms: number;
  alias_id: string | null;
  identity_match_id: null;
  transition_id: null;
}

interface DryRunDecisionShape {
  outcomeState: DryRunOutcomeState;
  reasonCode: string;
  matchMethod: string | null;
  matchConfidence: ConfidenceTier | string | null;
  disqualifiers: string[];
  candidatesWithNoMatch: boolean;
  candidatesWithDisqualifiers: boolean;
}

function asSingle<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function increment(counter: Record<string, number>, key: string | null | undefined): void {
  const normalized = key?.trim() || "none";
  counter[normalized] = (counter[normalized] ?? 0) + 1;
}

function mergeCounters(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function mapFetchStatus(state: RemoteCatalogFetchState): DryRunDecisionFetchStatus {
  switch (state) {
    case "ok":
      return "ok";
    case "timeout":
      return "timeout";
    case "auth_expired":
      return "auth_error";
    case "not_supported":
      return "unsupported";
    case "rate_limited":
    case "api_error":
      return "unavailable";
    default:
      return "partial";
  }
}

export function serializeTopCandidates(candidates: RankedSkuCandidate[], limit = 5) {
  return candidates.slice(0, limit).map((candidate) => ({
    score: candidate.score,
    match_method: candidate.matchMethod,
    confidence_tier: candidate.confidenceTier,
    reasons: candidate.reasons,
    disqualifiers: candidate.disqualifiers,
    remote: {
      platform: candidate.remote.platform,
      remote_product_id: candidate.remote.remoteProductId,
      remote_variant_id: candidate.remote.remoteVariantId,
      remote_inventory_item_id: candidate.remote.remoteInventoryItemId,
      remote_sku: candidate.remote.remoteSku,
      product_title: candidate.remote.productTitle,
      variant_title: candidate.remote.variantTitle,
      barcode: candidate.remote.barcode,
      quantity: candidate.remote.quantity,
    },
  }));
}

export function selectDryRunDecision(input: {
  existingMapping: ExistingMappingRow | null;
  ranked: RankedSkuCandidate[];
  fetchStatus: DryRunDecisionFetchStatus;
}): DryRunDecisionShape {
  if (input.existingMapping) {
    return {
      outcomeState: "auto_live_inventory_alias",
      reasonCode: "existing_live_alias",
      matchMethod: input.existingMapping.match_method ?? "existing_mapping",
      matchConfidence: input.existingMapping.match_confidence ?? "deterministic",
      disqualifiers: [],
      candidatesWithNoMatch: false,
      candidatesWithDisqualifiers: false,
    };
  }

  if (input.fetchStatus !== "ok") {
    return {
      outcomeState: "fetch_incomplete_holdout",
      reasonCode: `fetch_${input.fetchStatus}`,
      matchMethod: null,
      matchConfidence: null,
      disqualifiers: [`fetch_${input.fetchStatus}`],
      candidatesWithNoMatch: true,
      candidatesWithDisqualifiers: true,
    };
  }

  const topCandidate = input.ranked[0] ?? null;
  if (!topCandidate) {
    return {
      outcomeState: "auto_reject_non_match",
      reasonCode: "no_remote_candidate",
      matchMethod: null,
      matchConfidence: null,
      disqualifiers: [],
      candidatesWithNoMatch: true,
      candidatesWithDisqualifiers: false,
    };
  }

  if (topCandidate.confidenceTier === "conflict" || topCandidate.disqualifiers.length > 0) {
    return {
      outcomeState: "auto_reject_non_match",
      reasonCode: "candidate_disqualified",
      matchMethod: topCandidate.matchMethod,
      matchConfidence: topCandidate.confidenceTier,
      disqualifiers: topCandidate.disqualifiers,
      candidatesWithNoMatch: false,
      candidatesWithDisqualifiers: true,
    };
  }

  if (topCandidate.confidenceTier === "deterministic" || topCandidate.confidenceTier === "strong") {
    return {
      outcomeState: "auto_database_identity_match",
      reasonCode:
        topCandidate.matchMethod === "exact_barcode"
          ? "exact_barcode_match"
          : topCandidate.matchMethod === "exact_sku"
            ? "exact_sku_match"
            : "strong_candidate_match",
      matchMethod: topCandidate.matchMethod,
      matchConfidence: topCandidate.confidenceTier,
      disqualifiers: [],
      candidatesWithNoMatch: false,
      candidatesWithDisqualifiers: false,
    };
  }

  return {
    outcomeState: "auto_holdout_for_evidence",
    reasonCode: "insufficient_confidence",
    matchMethod: topCandidate.matchMethod,
    matchConfidence: topCandidate.confidenceTier,
    disqualifiers: topCandidate.disqualifiers,
    candidatesWithNoMatch: false,
    candidatesWithDisqualifiers: topCandidate.disqualifiers.length > 0,
  };
}

function evidenceHash(evidence: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

async function loadConnections(
  supabase: SupabaseClient,
  input: RunSkuAutonomousDryRunInput,
): Promise<ConnectionRow[]> {
  let query = supabase
    .from("client_store_connections")
    .select("*")
    .eq("connection_status", "active")
    .in("platform", [...SUPPORTED_PLATFORMS])
    .order("created_at", { ascending: true });

  if (input.workspaceId) query = query.eq("workspace_id", input.workspaceId);
  if (input.connectionId) query = query.eq("id", input.connectionId);

  const { data, error } = await query;
  if (error) throw new Error(`connection load failed: ${error.message}`);
  return (data ?? []) as ConnectionRow[];
}

async function loadWorkspacePauseMap(
  supabase: SupabaseClient,
  workspaceIds: string[],
): Promise<Map<string, boolean>> {
  if (workspaceIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, sku_autonomous_emergency_paused")
    .in("id", workspaceIds);
  if (error) throw new Error(`workspace pause load failed: ${error.message}`);
  return new Map(
    ((data ?? []) as WorkspacePauseRow[]).map((row) => [
      row.id,
      Boolean(row.sku_autonomous_emergency_paused),
    ]),
  );
}

async function loadCanonicalRows(
  supabase: SupabaseClient,
  connection: ConnectionRow,
  limitPerConnection?: number,
): Promise<CanonicalVariantRow[]> {
  if (!connection.org_id) return [];
  let query = supabase
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
      warehouse_products!inner(id, title, vendor, org_id),
      bandcamp_product_mappings(
        bandcamp_album_title,
        bandcamp_origin_quantities,
        bandcamp_item_id
      )
    `,
    )
    .eq("workspace_id", connection.workspace_id)
    .eq("warehouse_products.org_id", connection.org_id)
    .order("sku", { ascending: true });

  if (limitPerConnection && limitPerConnection > 0) {
    query = query.limit(limitPerConnection);
  }

  const { data, error } = await query;
  if (error) throw new Error(`canonical variant load failed: ${error.message}`);
  return (data ?? []) as CanonicalVariantRow[];
}

async function loadExistingMappings(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<Map<string, ExistingMappingRow>> {
  const { data, error } = await supabase
    .from("client_store_sku_mappings")
    .select(
      "id, variant_id, remote_sku, remote_product_id, remote_variant_id, remote_inventory_item_id, match_method, match_confidence",
    )
    .eq("connection_id", connectionId)
    .eq("is_active", true);
  if (error) throw new Error(`existing mapping load failed: ${error.message}`);

  const byVariant = new Map<string, ExistingMappingRow>();
  for (const row of (data ?? []) as ExistingMappingRow[]) {
    if (row.variant_id) byVariant.set(row.variant_id, row);
  }
  return byVariant;
}

async function openRun(
  supabase: SupabaseClient,
  connection: ConnectionRow,
  input: RunSkuAutonomousDryRunInput,
): Promise<string> {
  const { data, error } = await supabase
    .from("sku_autonomous_runs")
    .insert([
      {
        workspace_id: connection.workspace_id,
        connection_id: connection.id,
        trigger_source: input.triggerSource ?? "manual_admin",
        dry_run: true,
        feature_flags: {
          entry_point: "sku-autonomous-dry-run",
          platform: connection.platform,
          limit_per_connection: input.limitPerConnection ?? null,
        },
        triggered_by: input.triggeredBy ?? "sku-autonomous-dry-run",
      },
    ])
    .select("id")
    .single();

  if (error || !data || typeof data.id !== "string") {
    throw new Error(`run open failed: ${error?.message ?? "no_data"}`);
  }

  return data.id;
}

async function closeRun(
  supabase: SupabaseClient,
  runId: string,
  summary: Omit<DryRunConnectionSummary, "runId" | "workspaceId" | "connectionId" | "platform">,
  startedAtMs: number,
): Promise<void> {
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  const { error } = await supabase
    .from("sku_autonomous_runs")
    .update({
      status: summary.status,
      completed_at: new Date().toISOString(),
      variants_evaluated: summary.variantsEvaluated,
      outcomes_breakdown: summary.outcomesBreakdown,
      candidates_with_no_match: summary.candidatesWithNoMatch,
      candidates_with_disqualifiers: summary.candidatesWithDisqualifiers,
      total_duration_ms: durationMs,
      avg_per_variant_ms:
        summary.variantsEvaluated > 0 ? Math.round(durationMs / summary.variantsEvaluated) : null,
      error_count: summary.errorCount,
      error_log: summary.errors,
    })
    .eq("id", runId);
  if (error) {
    throw new Error(`run close failed: ${error.message}`);
  }
}

async function isCancellationRequested(supabase: SupabaseClient, runId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("sku_autonomous_runs")
    .select("cancellation_requested_at")
    .eq("id", runId)
    .maybeSingle();
  if (error) return false;
  return Boolean(
    (data as { cancellation_requested_at?: string | null } | null)?.cancellation_requested_at,
  );
}

async function insertDecisionBatch(
  supabase: SupabaseClient,
  runId: string,
  decisions: DryRunDecisionDraft[],
): Promise<number> {
  if (decisions.length === 0) return 0;
  const rows = decisions.map((decision) => ({
    ...decision,
    run_id: runId,
  }));
  const { error } = await supabase.from("sku_autonomous_decisions").insert(rows);
  if (error) throw new Error(`decision insert failed: ${error.message}`);
  return rows.length;
}

function buildDecisionDraft(input: {
  connection: ConnectionRow;
  canonical: CanonicalVariantRow;
  existingMapping: ExistingMappingRow | null;
  ranked: RankedSkuCandidate[];
  fetchStatus: DryRunDecisionFetchStatus;
  fetchCompletedAt: string | null;
  fetchDurationMs: number;
}): DryRunDecisionDraft | null {
  const product = asSingle(input.canonical.warehouse_products);
  if (!product || !input.canonical.sku) return null;

  const bandcamp = Array.isArray(input.canonical.bandcamp_product_mappings)
    ? input.canonical.bandcamp_product_mappings[0]
    : null;
  const decision = selectDryRunDecision({
    existingMapping: input.existingMapping,
    ranked: input.ranked,
    fetchStatus: input.fetchStatus,
  });
  const topCandidates = serializeTopCandidates(input.ranked);
  const evidence = {
    dry_run: true,
    entry_point: "sku-autonomous-dry-run",
    canonical: {
      variant_id: input.canonical.id,
      sku: input.canonical.sku,
      barcode: input.canonical.barcode,
      product_title: product.title,
      vendor: product.vendor,
      variant_title: input.canonical.title,
      format_name: input.canonical.format_name,
      bandcamp_item_id: bandcamp?.bandcamp_item_id ?? null,
      bandcamp_option_id: input.canonical.bandcamp_option_id,
      bandcamp_option_title: input.canonical.bandcamp_option_title,
    },
    fetch: {
      status: input.fetchStatus,
      completed_at: input.fetchCompletedAt,
      duration_ms: input.fetchDurationMs,
    },
    existing_mapping_id: input.existingMapping?.id ?? null,
    top_candidates: topCandidates,
  };

  return {
    workspace_id: input.connection.workspace_id,
    connection_id: input.connection.id,
    variant_id: input.canonical.id,
    outcome_state: decision.outcomeState,
    previous_outcome_state: null,
    outcome_changed: decision.outcomeState !== "auto_live_inventory_alias",
    match_method: decision.matchMethod,
    match_confidence: decision.matchConfidence,
    reason_code: decision.reasonCode,
    evidence_snapshot: evidence,
    evidence_hash: evidenceHash(evidence),
    disqualifiers: decision.disqualifiers,
    top_candidates: topCandidates,
    fetch_status: input.fetchStatus,
    fetch_completed_at: input.fetchCompletedAt,
    fetch_duration_ms: input.fetchDurationMs,
    alias_id: input.existingMapping?.id ?? null,
    identity_match_id: null,
    transition_id: null,
  };
}

async function runConnectionDryRun(
  supabase: SupabaseClient,
  connection: ConnectionRow,
  input: RunSkuAutonomousDryRunInput,
  deps: Required<Pick<SkuAutonomousDryRunDeps, "fetchRemoteCatalog" | "now">>,
): Promise<DryRunConnectionSummary & { decisionsWritten: number }> {
  const startedAtMs = deps.now();
  let runId: string | null = null;
  const summary: DryRunConnectionSummary & { decisionsWritten: number } = {
    workspaceId: connection.workspace_id,
    connectionId: connection.id,
    platform: connection.platform,
    runId: null,
    status: "completed",
    variantsEvaluated: 0,
    outcomesBreakdown: {},
    confidenceBreakdown: {},
    candidatesWithNoMatch: 0,
    candidatesWithDisqualifiers: 0,
    fetchStatus: "ok",
    errorCount: 0,
    errors: [],
    decisionsWritten: 0,
  };

  try {
    runId = await openRun(supabase, connection, input);
    summary.runId = runId;
  } catch (error) {
    summary.status = "run_open_failed";
    summary.errorCount = 1;
    summary.errors.push(error instanceof Error ? error.message : String(error));
    return summary;
  }

  try {
    const canonicalRows = await loadCanonicalRows(supabase, connection, input.limitPerConnection);
    const existingMappings = await loadExistingMappings(supabase, connection.id);

    const fetchStartedAt = deps.now();
    const catalog = await deps.fetchRemoteCatalog(connection as ClientStoreConnection);
    const fetchDurationMs = Math.max(0, deps.now() - fetchStartedAt);
    const fetchStatus = mapFetchStatus(catalog.state);
    summary.fetchStatus = fetchStatus;

    let batch: DryRunDecisionDraft[] = [];

    for (const canonical of canonicalRows) {
      if (
        summary.variantsEvaluated > 0 &&
        summary.variantsEvaluated % CANCELLATION_POLL_INTERVAL === 0
      ) {
        const shouldCancel = await isCancellationRequested(supabase, runId);
        if (shouldCancel) {
          summary.status = "cancelled";
          break;
        }
      }

      const product = asSingle(canonical.warehouse_products);
      if (!product || !canonical.sku) continue;

      const bandcamp = Array.isArray(canonical.bandcamp_product_mappings)
        ? canonical.bandcamp_product_mappings[0]
        : null;
      const ranked =
        catalog.state === "ok"
          ? rankSkuCandidates(
              {
                variantId: canonical.id,
                sku: canonical.sku,
                barcode: canonical.barcode,
                artist: product.vendor,
                title: product.title ?? "",
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
              catalog.items,
            )
          : [];

      const existingMapping = existingMappings.get(canonical.id) ?? null;
      const draft = buildDecisionDraft({
        connection,
        canonical,
        existingMapping,
        ranked,
        fetchStatus,
        fetchCompletedAt: catalog.fetchedAt,
        fetchDurationMs,
      });

      if (!draft) continue;

      summary.variantsEvaluated += 1;
      increment(summary.outcomesBreakdown, draft.outcome_state);
      increment(summary.confidenceBreakdown, draft.match_confidence);
      if (
        draft.reason_code === "no_remote_candidate" ||
        draft.outcome_state === "fetch_incomplete_holdout"
      ) {
        summary.candidatesWithNoMatch += 1;
      }
      if (draft.disqualifiers.length > 0) {
        summary.candidatesWithDisqualifiers += 1;
      }

      batch.push(draft);
      if (batch.length >= DECISION_BATCH_SIZE) {
        summary.decisionsWritten += await insertDecisionBatch(supabase, runId, batch);
        batch = [];
      }
    }

    summary.decisionsWritten += await insertDecisionBatch(supabase, runId, batch);
  } catch (error) {
    summary.status = "failed";
    summary.errorCount += 1;
    summary.errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    await closeRun(supabase, runId, summary, startedAtMs);
  } catch (error) {
    summary.status = "failed";
    summary.errorCount += 1;
    summary.errors.push(error instanceof Error ? error.message : String(error));
  }

  return summary;
}

export async function runSkuAutonomousDryRun(
  input: RunSkuAutonomousDryRunInput = {},
  deps: SkuAutonomousDryRunDeps = {},
): Promise<SkuAutonomousDryRunResult> {
  const supabase = deps.supabase ?? createServiceRoleClient();
  const fetchRemoteCatalog = deps.fetchRemoteCatalog ?? fetchRemoteCatalogWithTimeout;
  const now = deps.now ?? (() => Date.now());
  const result: SkuAutonomousDryRunResult = {
    connectionsScanned: 0,
    connectionsSkippedPaused: 0,
    runsOpened: 0,
    variantsEvaluated: 0,
    decisionsWritten: 0,
    outcomesBreakdown: {},
    confidenceBreakdown: {},
    candidatesWithNoMatch: 0,
    candidatesWithDisqualifiers: 0,
    errors: [],
    connectionSummaries: [],
  };

  const connections = await loadConnections(supabase, input);
  const pauseMap = await loadWorkspacePauseMap(
    supabase,
    Array.from(new Set(connections.map((connection) => connection.workspace_id))),
  );

  for (const connection of connections) {
    result.connectionsScanned += 1;
    if (pauseMap.get(connection.workspace_id)) {
      result.connectionsSkippedPaused += 1;
      result.connectionSummaries.push({
        workspaceId: connection.workspace_id,
        connectionId: connection.id,
        platform: connection.platform,
        runId: null,
        status: "skipped_paused",
        variantsEvaluated: 0,
        outcomesBreakdown: {},
        confidenceBreakdown: {},
        candidatesWithNoMatch: 0,
        candidatesWithDisqualifiers: 0,
        fetchStatus: "ok",
        errorCount: 0,
        errors: [],
      });
      continue;
    }

    const connectionSummary = await runConnectionDryRun(supabase, connection, input, {
      fetchRemoteCatalog,
      now,
    });

    if (connectionSummary.runId) result.runsOpened += 1;
    result.variantsEvaluated += connectionSummary.variantsEvaluated;
    result.decisionsWritten += connectionSummary.decisionsWritten;
    result.candidatesWithNoMatch += connectionSummary.candidatesWithNoMatch;
    result.candidatesWithDisqualifiers += connectionSummary.candidatesWithDisqualifiers;
    mergeCounters(result.outcomesBreakdown, connectionSummary.outcomesBreakdown);
    mergeCounters(result.confidenceBreakdown, connectionSummary.confidenceBreakdown);
    result.errors.push(...connectionSummary.errors);
    const { decisionsWritten: _decisionsWritten, ...publicSummary } = connectionSummary;
    result.connectionSummaries.push(publicSummary);
  }

  return result;
}
