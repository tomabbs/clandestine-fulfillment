// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: service_role for Trigger tasks
// Rule #9: Bandcamp OAuth API tasks share `bandcampQueue` (concurrencyLimit: 1)
//
// Phase 1 — Bandcamp baseline anomaly + multi-origin push_mode audit.
//
// Two passes per workspace:
//
//   (1) Per-mapping baseline detection (NO API CALL — pure SQL/JSON):
//       baseline_inferred = (raw_api_data->>'quantity_available')::int
//                         - sum(over origin_quantities[].option_quantities[].quantity_available)
//       If `baseline_inferred > 0` → write `bandcamp_baseline_anomalies` row,
//       set the mapping's `push_mode = 'blocked_baseline'`. If `baseline_inferred = 0`
//       and the mapping is currently `blocked_baseline` (auto-set), flip back to
//       `'normal'` and resolve the anomaly. `manual_override` is NEVER auto-cleared.
//
//   (2) Per-workspace multi-origin probe (REQUIRES Bandcamp API):
//       For each unique band_id with active mappings, call `getShippingOriginDetails`.
//       If the band has > 1 shipping origin, set every mapping in that workspace +
//       band to `push_mode = 'blocked_multi_origin'`. If origin count ≤ 1 and
//       mappings are currently `blocked_multi_origin` (auto-set), flip back to `'normal'`.
//
// Suggest-don't-mutate contract: this task ONLY writes to
// `bandcamp_baseline_anomalies` + `bandcamp_product_mappings.push_mode*`. It
// never modifies inventory, never calls `update_quantities`, never calls
// `update_sku`. The `bandcamp-inventory-push` task respects `push_mode` at the
// source — see TRUTH_LAYER "Bandcamp push_mode contract".
//
// Schedule: nightly @ 03:00 UTC (low Bandcamp API traffic). Also invokable by
// staff via `forceBaselineScan` Server Action for on-demand re-audit.

import { logger, schedules } from "@trigger.dev/sdk";
import { getShippingOriginDetails, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

interface OriginQuantitiesShape {
  origin_id?: number | null;
  option_quantities?: Array<{
    option_id?: number | null;
    quantity_available?: number | null;
  }> | null;
}

interface RawApiShape {
  quantity_available?: number | null;
  // Other fields ignored — anomaly detection only uses TOP quantity_available
  // vs the per-option origin allocations.
}

export interface BaselineAnomalyComputation {
  // option_id null ⇒ package-level (no options) anomaly
  option_id: number | null;
  baseline_qty: number;
}

/**
 * Pure baseline detector for one mapping row.
 *
 * Returns one entry per anomalous option (or one entry with `option_id=null`
 * for package-level anomalies). Returns `[]` if the mapping is healthy (sum
 * of origin allocations matches TOP quantity).
 *
 * For option-level products: computes per-option `top_per_option - sum(origins)`.
 * For package-level products: computes `top - sum(all origin quantities)`.
 *
 * Mirrors the SQL detector in plan §5.2.3.
 */
export function computeBaselineAnomalies(
  rawApi: unknown,
  originQuantities: unknown,
): BaselineAnomalyComputation[] {
  if (!rawApi || typeof rawApi !== "object") return [];
  const raw = rawApi as RawApiShape;
  const top = Number(raw.quantity_available);
  if (!Number.isFinite(top)) return [];

  if (!Array.isArray(originQuantities)) {
    // No origin data — can't infer baseline; treat as healthy (don't false-positive
    // on freshly synced mappings that haven't captured origins yet).
    return [];
  }

  const origins = originQuantities as OriginQuantitiesShape[];

  // Determine if this is option-level or package-level by inspecting whether
  // any origin has option_quantities entries with non-null option_id.
  const hasOptions = origins.some(
    (o) =>
      Array.isArray(o.option_quantities) && o.option_quantities.some((oq) => oq.option_id != null),
  );

  if (!hasOptions) {
    // Package-level: sum every origin's option_quantities[].quantity_available
    // (Bandcamp returns a single placeholder option entry for non-option products).
    const sum = origins.reduce((acc, origin) => {
      if (!Array.isArray(origin.option_quantities)) return acc;
      return (
        acc +
        origin.option_quantities.reduce((inner, oq) => {
          const q = Number(oq.quantity_available);
          return inner + (Number.isFinite(q) ? q : 0);
        }, 0)
      );
    }, 0);
    const baseline = top - sum;
    if (baseline > 0) return [{ option_id: null, baseline_qty: baseline }];
    return [];
  }

  // Option-level: aggregate per option_id across all origins.
  const totalsByOption = new Map<number, number>();
  for (const origin of origins) {
    if (!Array.isArray(origin.option_quantities)) continue;
    for (const oq of origin.option_quantities) {
      if (oq.option_id == null) continue;
      const q = Number(oq.quantity_available);
      if (!Number.isFinite(q)) continue;
      totalsByOption.set(oq.option_id, (totalsByOption.get(oq.option_id) ?? 0) + q);
    }
  }

  // For option-level products the TOP quantity_available is the SUM of all
  // option totals + sum of all option-level baselines. We can only infer a
  // single aggregate baseline (= top - sum-of-all-options); attributing it
  // proportionally to specific options would be a guess. Lord Spikeheart's
  // case has the same baseline (100) per size, so the aggregate captures the
  // anomaly without misattributing it.
  const sumOfOptions = Array.from(totalsByOption.values()).reduce((a, b) => a + b, 0);
  const aggregateBaseline = top - sumOfOptions;
  if (aggregateBaseline <= 0) return [];

  // Emit one anomaly row per affected option_id so the dashboard can display
  // each size's contribution. baseline_qty for each entry is the aggregate;
  // operator runbook (Part 9.3) tells the merchant to zero ALL options.
  return Array.from(totalsByOption.keys())
    .sort((a, b) => a - b)
    .map((option_id) => ({ option_id, baseline_qty: aggregateBaseline }));
}

interface MappingRow {
  id: string;
  workspace_id: string;
  variant_id: string;
  bandcamp_member_band_id: number | null;
  bandcamp_item_id: number | null;
  bandcamp_option_skus: string[] | null;
  bandcamp_origin_quantities: unknown;
  raw_api_data: unknown;
  push_mode: "normal" | "blocked_baseline" | "blocked_multi_origin" | "manual_override";
}

interface PerWorkspaceResult {
  workspace_id: string;
  mappings_audited: number;
  baseline_anomalies_open: number;
  baseline_anomalies_resolved: number;
  multi_origin_bands_blocked: number;
  multi_origin_bands_cleared: number;
  push_mode_changes: number;
  errors: number;
}

// ─── Trigger task ────────────────────────────────────────────────────────────

export const bandcampBaselineAuditTask = schedules.task({
  id: "bandcamp-baseline-audit",
  // Rule #9 — pinned to the shared bandcamp-api queue. The multi-origin
  // probe issues `getShippingOriginDetails` API calls per band; baseline
  // detection itself is pure SQL/JSON and would not require the queue.
  queue: bandcampQueue,
  cron: "0 3 * * *",
  maxDuration: 600,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const startedAt = new Date().toISOString();

    // Pull every workspace that has at least one active Bandcamp connection.
    const { data: connections, error: connErr } = await supabase
      .from("bandcamp_connections")
      .select("workspace_id, band_id")
      .eq("is_active", true);

    if (connErr) {
      logger.error("[bandcamp-baseline-audit] failed to load connections", {
        error: connErr.message,
      });
      throw connErr;
    }

    const workspaceBands = new Map<string, Set<number>>();
    for (const c of connections ?? []) {
      if (!c.workspace_id || !c.band_id) continue;
      const set = workspaceBands.get(c.workspace_id) ?? new Set<number>();
      set.add(c.band_id);
      workspaceBands.set(c.workspace_id, set);
    }

    const results: PerWorkspaceResult[] = [];

    for (const [workspaceId, bandIds] of Array.from(workspaceBands.entries())) {
      const result = await auditWorkspace({
        supabase,
        workspaceId,
        bandIds: Array.from(bandIds),
        runId: ctx.run.id,
      });
      results.push(result);
    }

    logger.info("[bandcamp-baseline-audit] completed", {
      workspaces: results.length,
      total_anomalies_open: results.reduce((a, r) => a + r.baseline_anomalies_open, 0),
      total_multi_origin_blocks: results.reduce((a, r) => a + r.multi_origin_bands_blocked, 0),
    });

    return {
      run_id: ctx.run.id,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      results,
    };
  },
});

// ─── Internal: per-workspace audit (exported for the Server Action) ──────────

interface AuditWorkspaceArgs {
  supabase: ReturnType<typeof createServiceRoleClient>;
  workspaceId: string;
  bandIds: number[];
  runId: string;
}

export async function auditWorkspace(args: AuditWorkspaceArgs): Promise<PerWorkspaceResult> {
  const { supabase, workspaceId, bandIds, runId } = args;
  const result: PerWorkspaceResult = {
    workspace_id: workspaceId,
    mappings_audited: 0,
    baseline_anomalies_open: 0,
    baseline_anomalies_resolved: 0,
    multi_origin_bands_blocked: 0,
    multi_origin_bands_cleared: 0,
    push_mode_changes: 0,
    errors: 0,
  };

  // ─── Pass 1 — baseline detection (no API call) ────────────────────────────

  const { data: mappings, error: mapErr } = await supabase
    .from("bandcamp_product_mappings")
    .select(
      "id, workspace_id, variant_id, bandcamp_member_band_id, bandcamp_item_id, bandcamp_option_skus, bandcamp_origin_quantities, raw_api_data, push_mode",
    )
    .eq("workspace_id", workspaceId)
    .not("bandcamp_origin_quantities", "is", null);

  if (mapErr) {
    logger.error("[bandcamp-baseline-audit] failed to load mappings", {
      workspace_id: workspaceId,
      error: mapErr.message,
    });
    result.errors++;
    return result;
  }

  const typedMappings = (mappings ?? []) as unknown as MappingRow[];
  result.mappings_audited = typedMappings.length;

  for (const mapping of typedMappings) {
    if (!mapping.bandcamp_item_id || !mapping.bandcamp_member_band_id) continue;

    const anomalies = computeBaselineAnomalies(
      mapping.raw_api_data,
      mapping.bandcamp_origin_quantities,
    );

    if (anomalies.length > 0) {
      // Upsert anomaly rows — keyed by (workspace, band, package, option).
      for (const anomaly of anomalies) {
        const sku = pickSkuForOption(mapping, anomaly.option_id);
        const wrote = await upsertBaselineAnomaly({
          supabase,
          workspace_id: workspaceId,
          band_id: mapping.bandcamp_member_band_id,
          package_id: mapping.bandcamp_item_id,
          option_id: anomaly.option_id,
          sku,
          baseline_qty: anomaly.baseline_qty,
          run_id: runId,
        });
        if (wrote) result.baseline_anomalies_open++;
      }

      // Set push_mode = blocked_baseline (preserve manual_override).
      if (mapping.push_mode === "normal") {
        const ok = await setPushMode({
          supabase,
          mapping_id: mapping.id,
          push_mode: "blocked_baseline",
          reason: `auto_detected_baseline=${anomalies[0]?.baseline_qty ?? 0}`,
        });
        if (ok) result.push_mode_changes++;
      }
    } else {
      // Healthy now — close any open anomalies for this package and
      // (only if currently auto-blocked) flip push_mode back to normal.
      const closed = await resolveAnomaliesForPackage({
        supabase,
        workspace_id: workspaceId,
        band_id: mapping.bandcamp_member_band_id,
        package_id: mapping.bandcamp_item_id,
      });
      result.baseline_anomalies_resolved += closed;

      if (mapping.push_mode === "blocked_baseline") {
        const ok = await setPushMode({
          supabase,
          mapping_id: mapping.id,
          push_mode: "normal",
          reason: "auto_cleared_baseline=0",
        });
        if (ok) result.push_mode_changes++;
      }
    }
  }

  // ─── Pass 2 — multi-origin probe (Bandcamp API; rule #9 queue protects token) ──

  if (bandIds.length === 0) return result;

  let accessToken: string;
  try {
    accessToken = await refreshBandcampToken(workspaceId);
  } catch (err) {
    logger.error("[bandcamp-baseline-audit] token refresh failed", {
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    result.errors++;
    return result;
  }

  for (const bandId of bandIds) {
    try {
      const origins = await getShippingOriginDetails(bandId, accessToken);
      const originCount = origins.length;

      if (originCount > 1) {
        // Multi-origin → block automated push for all mappings in this band
        // until per-origin fanout ships (Phase 4+).
        const changed = await bulkSetPushMode({
          supabase,
          workspace_id: workspaceId,
          band_id: bandId,
          target: "blocked_multi_origin",
          reason: `auto_detected_multi_origin=${originCount}`,
        });
        if (changed > 0) {
          result.multi_origin_bands_blocked++;
          result.push_mode_changes += changed;
        }
      } else {
        // Single (or zero) origin → safe to clear `blocked_multi_origin` if it
        // was auto-set previously. `manual_override` and `blocked_baseline`
        // stay untouched.
        const cleared = await bulkSetPushMode({
          supabase,
          workspace_id: workspaceId,
          band_id: bandId,
          target: "normal",
          reason: "auto_cleared_multi_origin=1",
          fromOnly: "blocked_multi_origin",
        });
        if (cleared > 0) {
          result.multi_origin_bands_cleared++;
          result.push_mode_changes += cleared;
        }
      }
    } catch (err) {
      logger.error("[bandcamp-baseline-audit] origin probe failed", {
        workspace_id: workspaceId,
        band_id: bandId,
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
    }
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickSkuForOption(_mapping: MappingRow, optionId: number | null): string | null {
  if (optionId == null) return null;
  // bandcamp_option_skus is a positional array per the existing schema (Part 6
  // 20260402210000 migration). We can't reliably map option_id → index without
  // raw_api_data.options[]; leave null and let the dashboard show the option_id.
  // Mapping arg retained for future enrichment (e.g. cross-referencing
  // raw_api_data.options[] when present).
  return null;
}

async function upsertBaselineAnomaly(args: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  workspace_id: string;
  band_id: number;
  package_id: number;
  option_id: number | null;
  sku: string | null;
  baseline_qty: number;
  run_id: string;
}): Promise<boolean> {
  const { supabase, workspace_id, band_id, package_id, option_id, sku, baseline_qty, run_id } =
    args;

  // The composite uniqueness lives in two partial indexes (option_id IS NULL vs
  // NOT NULL) — supabase-js can't target a partial index for ON CONFLICT, so we
  // do an explicit lookup → update or insert.
  let query = supabase
    .from("bandcamp_baseline_anomalies")
    .select("id, resolved_at")
    .eq("workspace_id", workspace_id)
    .eq("band_id", band_id)
    .eq("package_id", package_id)
    .limit(1);

  if (option_id == null) {
    query = query.is("option_id", null);
  } else {
    query = query.eq("option_id", option_id);
  }

  const { data: existing, error: selErr } = await query.maybeSingle();
  if (selErr) {
    logger.error("[bandcamp-baseline-audit] anomaly select failed", {
      workspace_id,
      band_id,
      package_id,
      option_id,
      error: selErr.message,
    });
    return false;
  }

  if (existing) {
    const { error: updErr } = await supabase
      .from("bandcamp_baseline_anomalies")
      .update({
        baseline_qty,
        sku,
        // Reopen if it was previously resolved and the anomaly returned.
        resolved_at: existing.resolved_at == null ? null : null,
        resolved_by: null,
        notes: `last_seen_run=${run_id}`,
      })
      .eq("id", existing.id);
    if (updErr) {
      logger.error("[bandcamp-baseline-audit] anomaly update failed", {
        id: existing.id,
        error: updErr.message,
      });
      return false;
    }
    return true;
  }

  const { error: insErr } = await supabase.from("bandcamp_baseline_anomalies").insert({
    workspace_id,
    band_id,
    package_id,
    option_id,
    sku,
    baseline_qty,
    notes: `first_seen_run=${run_id}`,
  });
  if (insErr) {
    logger.error("[bandcamp-baseline-audit] anomaly insert failed", {
      workspace_id,
      band_id,
      package_id,
      option_id,
      error: insErr.message,
    });
    return false;
  }
  return true;
}

async function resolveAnomaliesForPackage(args: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  workspace_id: string;
  band_id: number;
  package_id: number;
}): Promise<number> {
  const { supabase, workspace_id, band_id, package_id } = args;
  const { data, error } = await supabase
    .from("bandcamp_baseline_anomalies")
    .update({ resolved_at: new Date().toISOString() })
    .eq("workspace_id", workspace_id)
    .eq("band_id", band_id)
    .eq("package_id", package_id)
    .is("resolved_at", null)
    .select("id");
  if (error) {
    logger.error("[bandcamp-baseline-audit] anomaly resolve failed", {
      workspace_id,
      band_id,
      package_id,
      error: error.message,
    });
    return 0;
  }
  return data?.length ?? 0;
}

async function setPushMode(args: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  mapping_id: string;
  push_mode: "normal" | "blocked_baseline" | "blocked_multi_origin" | "manual_override";
  reason: string;
}): Promise<boolean> {
  const { supabase, mapping_id, push_mode, reason } = args;
  const { error } = await supabase
    .from("bandcamp_product_mappings")
    .update({
      push_mode,
      push_mode_reason: reason,
      push_mode_set_at: new Date().toISOString(),
      // push_mode_set_by stays NULL for system-driven changes — only staff
      // overrides set this column (via the Server Action, not here).
    })
    .eq("id", mapping_id);
  if (error) {
    logger.error("[bandcamp-baseline-audit] push_mode update failed", {
      mapping_id,
      push_mode,
      error: error.message,
    });
    return false;
  }
  return true;
}

async function bulkSetPushMode(args: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  workspace_id: string;
  band_id: number;
  target: "normal" | "blocked_baseline" | "blocked_multi_origin";
  reason: string;
  fromOnly?: "blocked_multi_origin"; // when set, only flip rows currently in this state
}): Promise<number> {
  const { supabase, workspace_id, band_id, target, reason, fromOnly } = args;
  let query = supabase
    .from("bandcamp_product_mappings")
    .update({
      push_mode: target,
      push_mode_reason: reason,
      push_mode_set_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspace_id)
    .eq("bandcamp_member_band_id", band_id);

  if (fromOnly) {
    // Clearing path — never auto-touch manual_override or blocked_baseline.
    query = query.eq("push_mode", fromOnly);
  } else if (target === "blocked_multi_origin") {
    // Blocking path — never overwrite manual_override (operator opt-in).
    // Also leave blocked_baseline alone; baseline is a separate fault that
    // must be resolved by the merchant first.
    query = query.eq("push_mode", "normal");
  }

  const { data, error } = await query.select("id");
  if (error) {
    logger.error("[bandcamp-baseline-audit] bulk push_mode update failed", {
      workspace_id,
      band_id,
      target,
      error: error.message,
    });
    return 0;
  }
  return data?.length ?? 0;
}
