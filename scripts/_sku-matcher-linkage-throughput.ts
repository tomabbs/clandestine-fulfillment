/**
 * Pre-Phase 0 — Bandcamp linkage throughput probe (read-only measurement).
 *
 * Plan: docs/prompt-packs / autonomous_sku_matching_da557209.plan.md,
 *       §"Pre-Phase 0 — Bandcamp linkage baseline (critical path)" bullet 2.
 *
 * Why this exists:
 *   The plan's Phase 2 threshold depends on Bandcamp linkage reaching 30%.
 *   To project a credible backfill window for that gap, we need a real
 *   throughput number for how fast `bandcamp-sync` and the scraper are
 *   actually inserting linked mappings in the current production-like
 *   topology (shared `bandcamp-api` queue at concurrency 1, Rule #9;
 *   `bandcamp-scrape` at concurrency 3, Rule #60). This script does NOT
 *   trigger any background work itself — it samples the historical
 *   insert rate from the last N hours of
 *   `bandcamp_product_mappings.created_at` + `updated_at` so repeated
 *   runs cost nothing and are safe to run at any time.
 *
 * Side effects: NONE. Pure read of `bandcamp_product_mappings`,
 * `warehouse_product_variants`, and `warehouse_products`.
 *
 * Contract:
 *   * Counts mappings CREATED and VERIFIED (non-null `bandcamp_url`) in
 *     the sample window to separate "API walk link" (mapping inserted)
 *     from "scraper link" (bandcamp_url resolved) throughput — the two
 *     are rate-limited differently.
 *   * Reports per-workspace per-minute rates + a projected wall-clock
 *     window to reach the Phase 2 thresholds from
 *     `_sku-matcher-linkage-baseline.ts`'s latest output.
 *   * Applies a 2× rate-limit safety margin (per Rule #30) when it
 *     prints the "committed backfill window" projection — if Bandcamp
 *     throttles sustained high-rate scraping (they do), the observed
 *     rate will not hold indefinitely.
 *
 * Usage:
 *   pnpm tsx scripts/_sku-matcher-linkage-throughput.ts
 *   pnpm tsx scripts/_sku-matcher-linkage-throughput.ts --workspaces=<uuid>
 *   pnpm tsx scripts/_sku-matcher-linkage-throughput.ts --window-hours=72
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface CliArgs {
  workspaceIds: string[] | null;
  windowHours: number;
  outPath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { workspaceIds: null, windowHours: 72, outPath: null };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith("--workspaces=")) {
      out.workspaceIds = raw
        .slice("--workspaces=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (raw.startsWith("--window-hours=")) {
      out.windowHours = Math.max(1, Number.parseInt(raw.slice("--window-hours=".length), 10) || 72);
    } else if (raw.startsWith("--out=")) {
      out.outPath = raw.slice("--out=".length).trim() || null;
    }
  }
  return out;
}

interface WorkspaceProbe {
  workspaceId: string;
  workspaceName: string | null;
  orgId: string;
  totalCanonicalVariants: number;
  currentlyMapped: number;
  currentlyVerified: number;
  mappingsInsertedInWindow: number;
  mappingsVerifiedInWindow: number;
  mappingsPerMinute: number;
  verifiedPerMinute: number;
  gapTo30PctLinkage: number;
  projectedHoursToPhase2Linkage: number | null;
  gapTo20PctVerified: number;
  projectedHoursToPhase2Verified: number | null;
}

const PHASE2_LINKAGE = 0.3;
const PHASE2_VERIFIED = 0.2;
const SAFETY_MARGIN = 2.0;

async function loadWorkspaces(
  supabase: ReturnType<typeof createServiceRoleClient>,
  filter: string[] | null,
): Promise<Array<{ id: string; name: string | null; org_id: string }>> {
  let q = supabase.from("workspaces").select("id, name, org_id").order("name", { ascending: true });
  if (filter && filter.length > 0) q = q.in("id", filter);
  const { data, error } = await q;
  if (error) throw new Error(`failed to load workspaces: ${error.message}`);
  return (data ?? []) as Array<{ id: string; name: string | null; org_id: string }>;
}

async function probeWorkspace(
  supabase: ReturnType<typeof createServiceRoleClient>,
  ws: { id: string; name: string | null; org_id: string },
  windowHours: number,
): Promise<WorkspaceProbe> {
  const pageSize = 1000;
  const poolIds = new Set<string>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("warehouse_product_variants")
      .select("id, warehouse_products!inner(id, org_id)")
      .eq("workspace_id", ws.id)
      .eq("warehouse_products.org_id", ws.org_id)
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw new Error(`pool page ${page}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) poolIds.add((r as { id: string }).id);
    if (data.length < pageSize) break;
  }

  const currentlyMapped = new Set<string>();
  const currentlyVerified = new Set<string>();
  const windowCutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  let mappingsInserted = 0;
  let mappingsVerified = 0;

  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("bandcamp_product_mappings")
      .select("variant_id, bandcamp_url, created_at, updated_at")
      .eq("workspace_id", ws.id)
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw new Error(`mappings page ${page}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const row = r as {
        variant_id: string | null;
        bandcamp_url: string | null;
        created_at: string | null;
        updated_at: string | null;
      };
      const vid = row.variant_id;
      if (!vid || !poolIds.has(vid)) continue;
      currentlyMapped.add(vid);
      if (row.bandcamp_url != null) currentlyVerified.add(vid);
      if (row.created_at && row.created_at >= windowCutoff) mappingsInserted++;
      if (row.bandcamp_url != null && row.updated_at && row.updated_at >= windowCutoff) {
        mappingsVerified++;
      }
    }
    if (data.length < pageSize) break;
  }

  const minutesInWindow = windowHours * 60;
  const mappingsPerMinute = mappingsInserted / minutesInWindow;
  const verifiedPerMinute = mappingsVerified / minutesInWindow;

  const total = poolIds.size;
  const target30 = Math.ceil(total * PHASE2_LINKAGE);
  const gapTo30 = Math.max(0, target30 - currentlyMapped.size);
  const projectedHoursLinkage =
    mappingsPerMinute > 0 ? (gapTo30 / mappingsPerMinute / 60) * SAFETY_MARGIN : null;

  const target20 = Math.ceil(total * PHASE2_VERIFIED);
  const gapTo20 = Math.max(0, target20 - currentlyVerified.size);
  const projectedHoursVerified =
    verifiedPerMinute > 0 ? (gapTo20 / verifiedPerMinute / 60) * SAFETY_MARGIN : null;

  return {
    workspaceId: ws.id,
    workspaceName: ws.name,
    orgId: ws.org_id,
    totalCanonicalVariants: total,
    currentlyMapped: currentlyMapped.size,
    currentlyVerified: currentlyVerified.size,
    mappingsInsertedInWindow: mappingsInserted,
    mappingsVerifiedInWindow: mappingsVerified,
    mappingsPerMinute,
    verifiedPerMinute,
    gapTo30PctLinkage: gapTo30,
    projectedHoursToPhase2Linkage: projectedHoursLinkage,
    gapTo20PctVerified: gapTo20,
    projectedHoursToPhase2Verified: projectedHoursVerified,
  };
}

function fmtHours(h: number | null): string {
  if (h == null) return "N/A (no observed rate)";
  if (!Number.isFinite(h)) return "∞";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  const days = h / 24;
  if (days < 60) return `${days.toFixed(1)} d`;
  const weeks = days / 7;
  return `${weeks.toFixed(1)} w`;
}

function renderMarkdown(probes: WorkspaceProbe[], windowHours: number, generatedAt: string): string {
  const lines: string[] = [];
  lines.push("# Bandcamp linkage throughput probe — autonomous SKU matcher Pre-Phase 0");
  lines.push("");
  lines.push(`Generated: \`${generatedAt}\``);
  lines.push(`Sample window: last ${windowHours} hours of \`bandcamp_product_mappings\` writes.`);
  lines.push(`Safety margin on projections: ${SAFETY_MARGIN.toFixed(1)}× (per Rule #30 — residential-proxy contingency).`);
  lines.push("");
  lines.push(
    "| workspace | variants | mapped now | verified now | new mappings (window) | new verified (window) | mappings/min | verified/min | gap→30% linkage | ETA (linkage) | gap→20% verified | ETA (verified) |",
  );
  lines.push(
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :-- | ---: | :-- |",
  );
  for (const p of probes) {
    lines.push(
      `| ${p.workspaceName ?? p.workspaceId} | ${p.totalCanonicalVariants} | ${p.currentlyMapped} | ${p.currentlyVerified} | ${p.mappingsInsertedInWindow} | ${p.mappingsVerifiedInWindow} | ${p.mappingsPerMinute.toFixed(3)} | ${p.verifiedPerMinute.toFixed(3)} | ${p.gapTo30PctLinkage} | ${fmtHours(p.projectedHoursToPhase2Linkage)} | ${p.gapTo20PctVerified} | ${fmtHours(p.projectedHoursToPhase2Verified)} |`,
    );
  }
  lines.push("");
  lines.push("## Notes on interpretation");
  lines.push("");
  lines.push(
    "- `mappings/min` samples the API-walk insert rate (`bandcamp-api` queue, Rule #9 concurrency 1). It caps the linkage-rate climb regardless of scraper throughput.",
  );
  lines.push(
    "- `verified/min` samples the scraper-resolved URL rate (`bandcamp-scrape` queue, Rule #60 concurrency 3). Verified requires both a mapping row AND a non-null `bandcamp_url`.",
  );
  lines.push(
    "- `ETA` columns apply a 2× safety margin to observed rate — Bandcamp routinely throttles sustained scraping. If the ETA exceeds the intended Phase 2 ship date, Phase 0 still ships (schema-only, no automation) and the Phase 2 feature flag stays off until backfill catches up.",
  );
  lines.push(
    "- A zero-rate workspace means `bandcamp-sync` has not run in the sample window. Re-run after triggering one full sync to get a real number.",
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const supabase = createServiceRoleClient();
  const workspaces = await loadWorkspaces(supabase, args.workspaceIds);
  if (workspaces.length === 0) {
    console.log("No workspaces matched.");
    process.exit(0);
  }

  const probes: WorkspaceProbe[] = [];
  for (const ws of workspaces) {
    try {
      const p = await probeWorkspace(supabase, ws, args.windowHours);
      probes.push(p);
      console.log(
        `[${ws.name ?? ws.id}] mapped=${p.currentlyMapped}/${p.totalCanonicalVariants} verified=${p.currentlyVerified} new=${p.mappingsInsertedInWindow} ver_new=${p.mappingsVerifiedInWindow} rate=${p.mappingsPerMinute.toFixed(3)}/min ver_rate=${p.verifiedPerMinute.toFixed(3)}/min ETA_linkage=${fmtHours(p.projectedHoursToPhase2Linkage)} ETA_verified=${fmtHours(p.projectedHoursToPhase2Verified)}`,
      );
    } catch (err) {
      console.error(`[${ws.name ?? ws.id}] probe failed:`, err);
    }
  }

  const generatedAt = new Date().toISOString();
  const md = renderMarkdown(probes, args.windowHours, generatedAt);
  const outPath =
    args.outPath ??
    path.join(
      "reports",
      `bandcamp-linkage-throughput-${generatedAt.replace(/[:.]/g, "-").replace(/Z$/, "Z")}.md`,
    );
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, md, "utf8");
  console.log(`\nWrote throughput report → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
