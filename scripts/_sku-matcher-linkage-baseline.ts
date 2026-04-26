/**
 * Pre-Phase 0 — Bandcamp linkage baseline measurement (read-only).
 *
 * Plan: docs/prompt-packs / autonomous_sku_matching_da557209.plan.md,
 *       §"Pre-Phase 0 — Bandcamp linkage baseline (critical path)".
 *
 * Why this exists:
 *   The autonomous SKU matcher's Phase 2 identity-write advancement is
 *   gated on `compute_bandcamp_linkage_metrics()` returning
 *   `linkage_rate >= 0.30`, `verified_rate >= 0.20`, `option_rate >= 0.10`
 *   for the target workspace/org. The 2026-04-26 dossier showed ZERO
 *   linked rows across the target orgs, which means those thresholds are
 *   unreachable on Phase 0 ship day. This script captures the actual
 *   starting numbers (T-0) so the team has a real baseline to project a
 *   backfill timeline against, not an estimate.
 *
 * Side effects: NONE. Pure read. Writes a markdown report to disk and
 * prints a summary to stdout. No Supabase writes, no external API calls.
 *
 * Contract:
 *   * Runs BEFORE the Phase 0 migration lands, so it CANNOT call the
 *     not-yet-existing `compute_bandcamp_linkage_metrics` RPC. It
 *     inlines the exact CTEs the RPC will use (verified against
 *     migrations `20260316000002_products.sql`,
 *     `20260316000007_bandcamp.sql`, `20260420000005_variant_bandcamp_option.sql`
 *     as of 2026-04-26) so the baseline number is comparable with the
 *     post-migration RPC number.
 *   * `bandcamp_product_mappings` has NO soft-delete semantics (no
 *     `is_active`, no `deleted_at`) — rows are hard-deleted via
 *     `variant_id → warehouse_product_variants ON DELETE CASCADE`. Row
 *     existence implies a real current link. No `is_active = true`
 *     filter is added here for that reason.
 *
 * Usage:
 *   pnpm tsx scripts/_sku-matcher-linkage-baseline.ts
 *   pnpm tsx scripts/_sku-matcher-linkage-baseline.ts --workspaces=<uuid>,<uuid>
 *   pnpm tsx scripts/_sku-matcher-linkage-baseline.ts --out=reports/bandcamp-linkage-baseline-2026-04-26.md
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface CliArgs {
  workspaceIds: string[] | null;
  outPath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { workspaceIds: null, outPath: null };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith("--workspaces=")) {
      out.workspaceIds = raw
        .slice("--workspaces=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (raw.startsWith("--out=")) {
      out.outPath = raw.slice("--out=".length).trim() || null;
    }
  }
  return out;
}

interface WorkspaceMetrics {
  workspaceId: string;
  workspaceName: string | null;
  orgId: string;
  orgName: string | null;
  totalCanonicalVariants: number;
  variantsWithBandcampMapping: number;
  variantsWithVerifiedBandcampUrl: number;
  variantsWithOptionEvidence: number;
  linkageRate: number;
  verifiedRate: number;
  optionRate: number;
  phase2Passes: boolean;
  phase5Passes: boolean;
  phase7Passes: boolean;
}

const PHASE_THRESHOLDS = {
  phase_2: { linkage: 0.3, verified: 0.2, option: 0.1 },
  phase_5: { linkage: 0.5, verified: 0.4, option: 0.25 },
  phase_7: { linkage: 0.7, verified: 0.6, option: 0.4 },
} as const;

function passesThreshold(
  linkage: number,
  verified: number,
  option: number,
  t: { linkage: number; verified: number; option: number },
): boolean {
  return linkage >= t.linkage && verified >= t.verified && option >= t.option;
}

async function measureWorkspace(
  supabase: ReturnType<typeof createServiceRoleClient>,
  row: { id: string; name: string | null; org_id: string; org_name: string | null },
): Promise<WorkspaceMetrics> {
  const workspaceId = row.id;
  const orgId = row.org_id;

  // Pool: canonical variants for this workspace+org. Mirrors the `pool` CTE in
  // compute_bandcamp_linkage_metrics (joins variants -> products on org_id).
  const poolIds = new Set<string>();
  const pageSize = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("warehouse_product_variants")
      .select("id, product_id, warehouse_products!inner(id, org_id)")
      .eq("workspace_id", workspaceId)
      .eq("warehouse_products.org_id", orgId)
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw new Error(`pool page ${page} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) poolIds.add((r as { id: string }).id);
    if (data.length < pageSize) break;
  }
  const total = poolIds.size;

  const optionedIds = new Set<string>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("warehouse_product_variants")
      .select("id, warehouse_products!inner(id, org_id)")
      .eq("workspace_id", workspaceId)
      .eq("warehouse_products.org_id", orgId)
      .not("bandcamp_option_id", "is", null)
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw new Error(`optioned page ${page} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) optionedIds.add((r as { id: string }).id);
    if (data.length < pageSize) break;
  }

  const mappedVariantIds = new Set<string>();
  const verifiedVariantIds = new Set<string>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("bandcamp_product_mappings")
      .select("variant_id, bandcamp_url")
      .eq("workspace_id", workspaceId)
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw new Error(`mappings page ${page} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const vid = (r as { variant_id: string | null }).variant_id;
      if (!vid || !poolIds.has(vid)) continue;
      mappedVariantIds.add(vid);
      if ((r as { bandcamp_url: string | null }).bandcamp_url != null) {
        verifiedVariantIds.add(vid);
      }
    }
    if (data.length < pageSize) break;
  }

  const mapped = mappedVariantIds.size;
  const verified = verifiedVariantIds.size;
  const optioned = optionedIds.size;

  const linkageRate = total === 0 ? 0 : mapped / total;
  const verifiedRate = total === 0 ? 0 : verified / total;
  const optionRate = total === 0 ? 0 : optioned / total;

  return {
    workspaceId,
    workspaceName: row.name,
    orgId,
    orgName: row.org_name,
    totalCanonicalVariants: total,
    variantsWithBandcampMapping: mapped,
    variantsWithVerifiedBandcampUrl: verified,
    variantsWithOptionEvidence: optioned,
    linkageRate,
    verifiedRate,
    optionRate,
    phase2Passes: passesThreshold(linkageRate, verifiedRate, optionRate, PHASE_THRESHOLDS.phase_2),
    phase5Passes: passesThreshold(linkageRate, verifiedRate, optionRate, PHASE_THRESHOLDS.phase_5),
    phase7Passes: passesThreshold(linkageRate, verifiedRate, optionRate, PHASE_THRESHOLDS.phase_7),
  };
}

function renderMarkdown(metrics: WorkspaceMetrics[], generatedAt: string): string {
  const lines: string[] = [];
  lines.push("# Bandcamp linkage baseline — autonomous SKU matcher Pre-Phase 0");
  lines.push("");
  lines.push(`Generated: \`${generatedAt}\``);
  lines.push("");
  lines.push(
    "Source: `scripts/_sku-matcher-linkage-baseline.ts`. Mirrors the CTEs in `compute_bandcamp_linkage_metrics` (Phase 0 RPC, not yet deployed at the time of this baseline).",
  );
  lines.push("");
  lines.push("## Phase-advancement thresholds (from the plan)");
  lines.push("");
  lines.push("| Phase | linkage_rate | verified_rate | option_rate |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| phase_2 (identity-only persistence) | ≥ ${PHASE_THRESHOLDS.phase_2.linkage.toFixed(
      2,
    )} | ≥ ${PHASE_THRESHOLDS.phase_2.verified.toFixed(2)} | ≥ ${PHASE_THRESHOLDS.phase_2.option.toFixed(2)} |`,
  );
  lines.push(
    `| phase_5 (actual holds) | ≥ ${PHASE_THRESHOLDS.phase_5.linkage.toFixed(
      2,
    )} | ≥ ${PHASE_THRESHOLDS.phase_5.verified.toFixed(2)} | ≥ ${PHASE_THRESHOLDS.phase_5.option.toFixed(2)} |`,
  );
  lines.push(
    `| phase_7 (live alias autonomy) | ≥ ${PHASE_THRESHOLDS.phase_7.linkage.toFixed(
      2,
    )} | ≥ ${PHASE_THRESHOLDS.phase_7.verified.toFixed(2)} | ≥ ${PHASE_THRESHOLDS.phase_7.option.toFixed(2)} |`,
  );
  lines.push("");
  lines.push("## Per-workspace baseline");
  lines.push("");
  lines.push(
    "| workspace | org | variants | mapped | verified | optioned | linkage | verified | option | ph2 | ph5 | ph7 |",
  );
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :-: | :-: | :-: |");
  for (const m of metrics) {
    const label = m.workspaceName ?? m.workspaceId;
    const orgLabel = m.orgName ?? m.orgId;
    lines.push(
      `| ${label} | ${orgLabel} | ${m.totalCanonicalVariants} | ${m.variantsWithBandcampMapping} | ${m.variantsWithVerifiedBandcampUrl} | ${m.variantsWithOptionEvidence} | ${m.linkageRate.toFixed(4)} | ${m.verifiedRate.toFixed(4)} | ${m.optionRate.toFixed(4)} | ${m.phase2Passes ? "✓" : "✗"} | ${m.phase5Passes ? "✓" : "✗"} | ${m.phase7Passes ? "✓" : "✗"} |`,
    );
  }
  lines.push("");
  lines.push("## Interpretation");
  lines.push("");
  lines.push(
    "- Every `✗` is a BLOCKING gap. The Server Action that flips `sku_identity_autonomy_enabled` / `sku_live_alias_autonomy_enabled` will refuse to advance a workspace until the corresponding phase columns read `✓`.",
  );
  lines.push(
    "- The gap between today's number and the ph2 target drives the required Bandcamp backfill window. Multiply the gap by the catalog size and divide by the throughput probe's `mappings_per_minute` number (see `scripts/_sku-matcher-linkage-throughput.ts`), then apply a 2× rate-limit safety margin per Rule #30.",
  );
  lines.push(
    "- `bandcamp_product_mappings` has NO soft-delete column today. If a soft-delete column is added later, the verified CTE in this script (and in `compute_bandcamp_linkage_metrics`) must be updated at that point.",
  );
  return `${lines.join("\n")}\n`;
}

async function loadWorkspaces(
  supabase: ReturnType<typeof createServiceRoleClient>,
  filter: string[] | null,
): Promise<Array<{ id: string; name: string | null; org_id: string; org_name: string | null }>> {
  let wsQuery = supabase
    .from("workspaces")
    .select("id, name, org_id")
    .order("name", { ascending: true });
  if (filter && filter.length > 0) {
    wsQuery = wsQuery.in("id", filter);
  }
  const { data: workspaces, error: wsErr } = await wsQuery;
  if (wsErr) throw new Error(`failed to load workspaces: ${wsErr.message}`);
  const rows = (workspaces ?? []) as Array<{ id: string; name: string | null; org_id: string }>;
  if (rows.length === 0) return [];

  const orgIds = Array.from(new Set(rows.map((r) => r.org_id)));
  const { data: orgs, error: orgErr } = await supabase
    .from("organizations")
    .select("id, name")
    .in("id", orgIds);
  if (orgErr) throw new Error(`failed to load organizations: ${orgErr.message}`);
  const orgNameById = new Map<string, string | null>();
  for (const o of (orgs ?? []) as Array<{ id: string; name: string | null }>) {
    orgNameById.set(o.id, o.name ?? null);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    org_id: r.org_id,
    org_name: orgNameById.get(r.org_id) ?? null,
  }));
}

async function main() {
  const args = parseArgs(process.argv);
  const supabase = createServiceRoleClient();
  const workspaces = await loadWorkspaces(supabase, args.workspaceIds);
  if (workspaces.length === 0) {
    console.log("No workspaces matched the --workspaces filter (or workspaces table is empty).");
    process.exit(0);
  }

  const metrics: WorkspaceMetrics[] = [];
  for (const row of workspaces) {
    try {
      const m = await measureWorkspace(supabase, row);
      metrics.push(m);
      console.log(
        `[${row.name ?? row.id}] variants=${m.totalCanonicalVariants} mapped=${m.variantsWithBandcampMapping} verified=${m.variantsWithVerifiedBandcampUrl} optioned=${m.variantsWithOptionEvidence} linkage=${m.linkageRate.toFixed(4)} verified=${m.verifiedRate.toFixed(4)} option=${m.optionRate.toFixed(4)}`,
      );
    } catch (err) {
      console.error(`[${row.name ?? row.id}] measurement failed:`, err);
    }
  }

  const generatedAt = new Date().toISOString();
  const md = renderMarkdown(metrics, generatedAt);
  const outPath =
    args.outPath ??
    path.join(
      "reports",
      `bandcamp-linkage-baseline-${generatedAt.replace(/[:.]/g, "-").replace(/Z$/, "Z")}.md`,
    );
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, md, "utf8");
  console.log(`\nWrote baseline report → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
