/**
 * Phase 0 / §9.1 D1 — World-class baseline diagnostics.
 *
 * Read-only Stage 2 (Q-A through Q-E) live diagnostics. Establishes the
 * empirical baseline that the §9.0 success criteria sign off against:
 *
 *   - p95 Bandcamp-sale → client-Shopify reflect (target <30s)
 *   - Zero `drift_major` review queue items per week
 *   - 100% Shopify variants on `inventoryPolicy=DENY`
 *   - Cold-start webhook ingress p95 < 800ms
 *
 * Each probe writes structured JSON + human-readable markdown to
 * `reports/world-class-baseline/<timestamp>.{json,md}`.
 *
 * Side effects: NONE on any production-mutating surface. Q-A hits Shopify
 * GraphQL READ-ONLY (Admin REST/GraphQL doesn't count toward Storefront
 * limits). Q-B/C/D/E are pure SQL reads against Supabase.
 *
 * Usage:
 *   pnpm tsx scripts/_world-class-baseline.ts
 *   pnpm tsx scripts/_world-class-baseline.ts --probes=Q-A,Q-E
 *   pnpm tsx scripts/_world-class-baseline.ts --skip=Q-A     (skip Shopify; SQL only)
 *   pnpm tsx scripts/_world-class-baseline.ts --workspace=<uuid>
 *
 * Plan: bandcamp_shopify_enterprise_sync_a448cf6a.plan.md §9.1 D1.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ConnectionShopifyContext,
  ShopifyScopeError,
} from "@/lib/server/shopify-connection-graphql";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { iterateAllVariantsForAudit } from "@/trigger/tasks/shopify-policy-audit";

interface CliArgs {
  probes: Set<string>;
  workspaceId: string | null;
  outDir: string;
}

const ALL_PROBES = ["Q-A", "Q-B", "Q-C", "Q-D", "Q-E"] as const;

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    probes: new Set(ALL_PROBES),
    workspaceId: null,
    outDir: "reports/world-class-baseline",
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--probes=")) {
      out.probes = new Set(
        a
          .slice("--probes=".length)
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      );
    } else if (a.startsWith("--skip=")) {
      const skip = a
        .slice("--skip=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase());
      for (const s of skip) out.probes.delete(s);
    } else if (a.startsWith("--workspace=")) {
      out.workspaceId = a.slice("--workspace=".length).trim() || null;
    } else if (a.startsWith("--out=")) {
      out.outDir = a.slice("--out=".length).trim() || out.outDir;
    }
  }
  return out;
}

// ─── Q-A: Shopify inventoryPolicy=DENY audit per connection ────────────

interface QAResult {
  probe: "Q-A";
  description: string;
  perConnection: Array<{
    connectionId: string;
    storeUrl: string;
    workspaceId: string;
    status: "ok" | "skipped" | "scope_error" | "failed";
    variantsScanned: number;
    continueCount: number;
    denyCount: number;
    untrackedCount: number;
    sampleContinueSkus: string[];
    error?: string;
  }>;
  totals: {
    connectionsScanned: number;
    variantsScanned: number;
    continueCount: number;
    denyCount: number;
    denyPercent: number;
  };
}

async function runQA(workspaceFilter: string | null): Promise<QAResult> {
  const supabase = createServiceRoleClient();
  let q = supabase
    .from("client_store_connections")
    .select("id, workspace_id, store_url, platform, api_key, connection_status")
    .eq("platform", "shopify")
    .eq("connection_status", "active");
  if (workspaceFilter) q = q.eq("workspace_id", workspaceFilter);
  const { data: connections, error } = await q;
  if (error) throw new Error(`Q-A connection load failed: ${error.message}`);

  const result: QAResult = {
    probe: "Q-A",
    description:
      "Shopify variant inventoryPolicy audit per active connection. CONTINUE on a non-preorder SKU is the #1 industry oversell cause (Webgility, Shopify community 2025).",
    perConnection: [],
    totals: {
      connectionsScanned: 0,
      variantsScanned: 0,
      continueCount: 0,
      denyCount: 0,
      denyPercent: 0,
    },
  };

  for (const conn of connections ?? []) {
    if (!conn.api_key) {
      result.perConnection.push({
        connectionId: conn.id,
        storeUrl: conn.store_url,
        workspaceId: conn.workspace_id,
        status: "skipped",
        variantsScanned: 0,
        continueCount: 0,
        denyCount: 0,
        untrackedCount: 0,
        sampleContinueSkus: [],
        error: "no_access_token",
      });
      continue;
    }

    const ctx: ConnectionShopifyContext = {
      storeUrl: conn.store_url,
      accessToken: conn.api_key,
    };

    let variantsScanned = 0;
    let continueCount = 0;
    let denyCount = 0;
    let untrackedCount = 0;
    const sampleContinueSkus: string[] = [];

    try {
      for await (const page of iterateAllVariantsForAudit(ctx)) {
        for (const v of page) {
          variantsScanned++;
          if (v.inventoryPolicy === "CONTINUE") {
            continueCount++;
            if (sampleContinueSkus.length < 25 && v.sku) sampleContinueSkus.push(v.sku);
          } else if (v.inventoryPolicy === "DENY") {
            denyCount++;
          }
          if (v.inventoryItem && v.inventoryItem.tracked === false) untrackedCount++;
        }
      }
      result.perConnection.push({
        connectionId: conn.id,
        storeUrl: conn.store_url,
        workspaceId: conn.workspace_id,
        status: "ok",
        variantsScanned,
        continueCount,
        denyCount,
        untrackedCount,
        sampleContinueSkus,
      });
      result.totals.connectionsScanned++;
      result.totals.variantsScanned += variantsScanned;
      result.totals.continueCount += continueCount;
      result.totals.denyCount += denyCount;
    } catch (err) {
      const isScope = err instanceof ShopifyScopeError;
      result.perConnection.push({
        connectionId: conn.id,
        storeUrl: conn.store_url,
        workspaceId: conn.workspace_id,
        status: isScope ? "scope_error" : "failed",
        variantsScanned,
        continueCount,
        denyCount,
        untrackedCount,
        sampleContinueSkus,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const total = result.totals.continueCount + result.totals.denyCount;
  result.totals.denyPercent = total === 0 ? 0 : (result.totals.denyCount / total) * 100;
  return result;
}

// ─── Q-B: Bandcamp-sale → Shopify-reflect latency p50/p95 ──────────────

interface QBRow {
  hour: string;
  p50_seconds: number | null;
  p95_seconds: number | null;
  sample_n: number;
}
interface QBResult {
  probe: "Q-B";
  description: string;
  rows: QBRow[];
  rollup: { p50_seconds: number | null; p95_seconds: number | null; sample_n: number };
}

async function runQB(): Promise<QBResult> {
  const supabase = createServiceRoleClient();
  // Inline SQL via supabase.rpc would require a stored function; instead
  // we do the join in two reads + JS aggregation. Bounded to 7 days so
  // memory stays in the kilobytes range.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: emails, error: eErr } = await supabase
    .from("webhook_events")
    .select("id, created_at, metadata")
    .eq("platform", "resend")
    .eq("topic", "email.received")
    .gte("created_at", since);
  if (eErr) throw new Error(`Q-B email load failed: ${eErr.message}`);

  const { data: pushes, error: pErr } = await supabase
    .from("external_sync_events")
    .select("correlation_id, completed_at, system, status")
    .in("system", ["shopify", "clandestine_shopify"])
    .eq("status", "success")
    .gte("completed_at", since);
  if (pErr) throw new Error(`Q-B push load failed: ${pErr.message}`);

  // Group pushes by correlation_id prefix bandcamp-sale:* → cheap O(N) join.
  const pushByCorr = new Map<string, string>();
  for (const p of pushes ?? []) {
    if (!p.correlation_id || !p.completed_at) continue;
    if (!p.correlation_id.startsWith("bandcamp-sale:")) continue;
    if (!pushByCorr.has(p.correlation_id)) pushByCorr.set(p.correlation_id, p.completed_at);
  }

  // We don't have a strong join key from email→push in the canonical
  // schema (correlation_id on the push is set by the sale-poll task,
  // not by the email handler). Best-effort: bucket by hour and take
  // the closest push following each email. Output sample_n = matched
  // emails so the operator can judge confidence.
  const buckets = new Map<string, number[]>();
  let totalDeltas: number[] = [];
  for (const e of emails ?? []) {
    if (!e.created_at) continue;
    const emailMs = Date.parse(e.created_at);
    if (!Number.isFinite(emailMs)) continue;
    // Best closest-following push within 30 minutes.
    let bestDelta: number | null = null;
    for (const ts of pushByCorr.values()) {
      const pMs = Date.parse(ts);
      const delta = (pMs - emailMs) / 1000;
      if (delta > 0 && delta < 1800 && (bestDelta === null || delta < bestDelta)) {
        bestDelta = delta;
      }
    }
    if (bestDelta === null) continue;
    const hour = new Date(emailMs).toISOString().slice(0, 13);
    const arr = buckets.get(hour) ?? [];
    arr.push(bestDelta);
    buckets.set(hour, arr);
    totalDeltas.push(bestDelta);
  }

  const percentile = (arr: number[], p: number): number | null => {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
  };

  const rows: QBRow[] = [];
  for (const [hour, deltas] of [...buckets.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    rows.push({
      hour,
      p50_seconds: percentile(deltas, 0.5),
      p95_seconds: percentile(deltas, 0.95),
      sample_n: deltas.length,
    });
  }

  return {
    probe: "Q-B",
    description:
      "End-to-end Bandcamp-sale (resend webhook) → Shopify push success latency, last 7 days. Best-effort hourly buckets via 30-minute closest-following match. Hypothesis from code reading: p50 in 5-15 minute range driven by global multi-store-inventory-push cron. World-class target: p95 <30s.",
    rows,
    rollup: {
      p50_seconds: percentile(totalDeltas, 0.5),
      p95_seconds: percentile(totalDeltas, 0.95),
      sample_n: totalDeltas.length,
    },
  };
}

// ─── Q-C: Reconcile drift frequency (review queue) ──────────────────────

interface QCResult {
  probe: "Q-C";
  description: string;
  rows: Array<{
    day: string;
    high: number;
    low: number;
    negative_blocks: number;
    spot_check_drifts: number;
  }>;
  rollup30d: {
    drift_high: number;
    drift_low: number;
    negative_blocks: number;
    spot_check_drifts: number;
  };
}

async function runQC(): Promise<QCResult> {
  const supabase = createServiceRoleClient();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("warehouse_review_queue")
    .select("created_at, category, severity")
    .gte("created_at", since)
    .in("category", [
      "reconcile.qty_drift",
      "manual_count_negative_block",
      "megaplan_spot_check",
    ]);
  if (error) throw new Error(`Q-C load failed: ${error.message}`);

  const buckets = new Map<
    string,
    { high: number; low: number; negative_blocks: number; spot_check_drifts: number }
  >();
  const roll = { drift_high: 0, drift_low: 0, negative_blocks: 0, spot_check_drifts: 0 };
  for (const row of data ?? []) {
    if (!row.created_at) continue;
    const day = row.created_at.slice(0, 10);
    const b = buckets.get(day) ?? {
      high: 0,
      low: 0,
      negative_blocks: 0,
      spot_check_drifts: 0,
    };
    if (row.category === "reconcile.qty_drift") {
      if (row.severity === "high" || row.severity === "critical") {
        b.high++;
        roll.drift_high++;
      } else {
        b.low++;
        roll.drift_low++;
      }
    } else if (row.category === "manual_count_negative_block") {
      b.negative_blocks++;
      roll.negative_blocks++;
    } else if (row.category === "megaplan_spot_check") {
      b.spot_check_drifts++;
      roll.spot_check_drifts++;
    }
    buckets.set(day, b);
  }

  const rows = [...buckets.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, v]) => ({ day, ...v }));

  return {
    probe: "Q-C",
    description:
      "Review-queue drift indicators over the last 30 days. Tracks reconcile drift (high/low), manual count negative blocks, and megaplan spot-check drift items. Success-criteria target: zero spot_check_drifts/week.",
    rows,
    rollup30d: roll,
  };
}

// ─── Q-D: SS Inventory Sync mirror coverage ─────────────────────────────

interface QDResult {
  probe: "Q-D";
  description: string;
  perPlatform: Array<{
    platform: string;
    dormant: number;
    active: number;
    ss_inventory_sync_mirrored: number;
  }>;
}

async function runQD(): Promise<QDResult> {
  const supabase = createServiceRoleClient();
  const { data: connections, error } = await supabase
    .from("client_store_connections")
    .select("platform, do_not_fanout, store_url");
  if (error) throw new Error(`Q-D connection load failed: ${error.message}`);

  // ShipStation mirror lookup — best-effort if the warehouse_shipstation_stores
  // table exists, otherwise zero.
  let ssStoresByUrl: Set<string> = new Set();
  const ssRes = await supabase.from("warehouse_shipstation_stores").select("store_url");
  if (!ssRes.error && ssRes.data) {
    ssStoresByUrl = new Set((ssRes.data as Array<{ store_url: string | null }>).flatMap(
      (r) => (r.store_url ? [r.store_url] : []),
    ));
  }

  const groups = new Map<string, { dormant: number; active: number; mirrored: number }>();
  for (const c of connections ?? []) {
    const g = groups.get(c.platform) ?? { dormant: 0, active: 0, mirrored: 0 };
    if (c.do_not_fanout) g.dormant++;
    else g.active++;
    if (c.store_url && ssStoresByUrl.has(c.store_url)) g.mirrored++;
    groups.set(c.platform, g);
  }

  return {
    probe: "Q-D",
    description:
      "ShipStation Inventory Sync mirror coverage per platform. Confirms which connections rely on the legacy SS mirror as a redundant secondary path during the direct cutover.",
    perPlatform: [...groups.entries()].map(([platform, v]) => ({
      platform,
      dormant: v.dormant,
      active: v.active,
      ss_inventory_sync_mirrored: v.mirrored,
    })),
  };
}

// ─── Q-E: Webhook ingress p50/p95 by platform ──────────────────────────

interface QEResult {
  probe: "Q-E";
  description: string;
  perPlatform: Array<{ platform: string; p50_seconds: number | null; p95_seconds: number | null; n: number }>;
}

async function runQE(): Promise<QEResult> {
  const supabase = createServiceRoleClient();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("webhook_events")
    .select("platform, created_at, processed_at")
    .not("processed_at", "is", null)
    .gte("created_at", since);
  if (error) throw new Error(`Q-E load failed: ${error.message}`);

  const buckets = new Map<string, number[]>();
  for (const row of data ?? []) {
    if (!row.created_at || !row.processed_at) continue;
    const cMs = Date.parse(row.created_at);
    const pMs = Date.parse(row.processed_at);
    if (!Number.isFinite(cMs) || !Number.isFinite(pMs)) continue;
    const delta = (pMs - cMs) / 1000;
    if (delta < 0) continue;
    const arr = buckets.get(row.platform) ?? [];
    arr.push(delta);
    buckets.set(row.platform, arr);
  }

  const percentile = (arr: number[], p: number): number | null => {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  };

  return {
    probe: "Q-E",
    description:
      "Webhook ingress processing latency p50/p95 per platform, last 7 days. World-class target: cold-start p95 <800ms. Hypothesis: client-store webhook p95 may approach Shopify's 5s timeout under cold-start.",
    perPlatform: [...buckets.entries()].map(([platform, arr]) => ({
      platform,
      p50_seconds: percentile(arr, 0.5),
      p95_seconds: percentile(arr, 0.95),
      n: arr.length,
    })),
  };
}

// ─── Markdown rendering ────────────────────────────────────────────────

function renderMarkdown(report: {
  generatedAt: string;
  args: CliArgs;
  results: Array<QAResult | QBResult | QCResult | QDResult | QEResult>;
}): string {
  const out: string[] = [];
  out.push("# World-class baseline diagnostics");
  out.push("");
  out.push(`Generated: ${report.generatedAt}`);
  out.push(`Workspace filter: ${report.args.workspaceId ?? "(all)"}`);
  out.push(`Probes: ${[...report.args.probes].sort().join(", ")}`);
  out.push("");

  for (const r of report.results) {
    out.push(`## ${r.probe} — ${("description" in r ? r.description : "").split(".")[0]}`);
    out.push("");
    out.push(`> ${("description" in r ? r.description : "")}`);
    out.push("");

    if (r.probe === "Q-A") {
      out.push(
        `**Totals:** connections=${r.totals.connectionsScanned}, variants=${r.totals.variantsScanned}, DENY=${r.totals.denyCount} (${r.totals.denyPercent.toFixed(2)}%), CONTINUE=${r.totals.continueCount}.`,
      );
      out.push("");
      out.push("| Connection | Variants | DENY | CONTINUE | Untracked | Status | Sample CONTINUE SKUs |");
      out.push("| --- | ---: | ---: | ---: | ---: | --- | --- |");
      for (const c of r.perConnection) {
        out.push(
          `| ${c.storeUrl} | ${c.variantsScanned} | ${c.denyCount} | ${c.continueCount} | ${c.untrackedCount} | ${c.status}${c.error ? ` (${c.error})` : ""} | ${c.sampleContinueSkus.slice(0, 5).join(", ")}${c.sampleContinueSkus.length > 5 ? "…" : ""} |`,
        );
      }
    } else if (r.probe === "Q-B") {
      out.push(
        `**Rollup (7d):** p50=${r.rollup.p50_seconds?.toFixed(1) ?? "n/a"}s, p95=${r.rollup.p95_seconds?.toFixed(1) ?? "n/a"}s, n=${r.rollup.sample_n}.`,
      );
      out.push("");
      out.push("| Hour (UTC) | p50 (s) | p95 (s) | n |");
      out.push("| --- | ---: | ---: | ---: |");
      for (const row of r.rows.slice(0, 24)) {
        out.push(
          `| ${row.hour} | ${row.p50_seconds?.toFixed(1) ?? "n/a"} | ${row.p95_seconds?.toFixed(1) ?? "n/a"} | ${row.sample_n} |`,
        );
      }
    } else if (r.probe === "Q-C") {
      out.push(
        `**Rollup (30d):** drift_high=${r.rollup30d.drift_high}, drift_low=${r.rollup30d.drift_low}, negative_blocks=${r.rollup30d.negative_blocks}, spot_check_drifts=${r.rollup30d.spot_check_drifts}.`,
      );
      out.push("");
      out.push("| Day | drift_high | drift_low | neg_blocks | spot_check |");
      out.push("| --- | ---: | ---: | ---: | ---: |");
      for (const row of r.rows.slice(0, 30)) {
        out.push(
          `| ${row.day} | ${row.high} | ${row.low} | ${row.negative_blocks} | ${row.spot_check_drifts} |`,
        );
      }
    } else if (r.probe === "Q-D") {
      out.push("| Platform | Dormant | Active | SS-mirrored |");
      out.push("| --- | ---: | ---: | ---: |");
      for (const row of r.perPlatform) {
        out.push(
          `| ${row.platform} | ${row.dormant} | ${row.active} | ${row.ss_inventory_sync_mirrored} |`,
        );
      }
    } else if (r.probe === "Q-E") {
      out.push("| Platform | p50 (s) | p95 (s) | n |");
      out.push("| --- | ---: | ---: | ---: |");
      for (const row of r.perPlatform) {
        out.push(
          `| ${row.platform} | ${row.p50_seconds?.toFixed(3) ?? "n/a"} | ${row.p95_seconds?.toFixed(3) ?? "n/a"} | ${row.n} |`,
        );
      }
    }
    out.push("");
  }
  return out.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  await mkdir(args.outDir, { recursive: true });

  const results: Array<QAResult | QBResult | QCResult | QDResult | QEResult> = [];

  if (args.probes.has("Q-A")) {
    console.log("[Q-A] Auditing Shopify inventoryPolicy (this can take minutes for large estates)…");
    try {
      results.push(await runQA(args.workspaceId));
    } catch (err) {
      console.error("Q-A failed:", err);
    }
  }
  if (args.probes.has("Q-B")) {
    console.log("[Q-B] Computing Bandcamp→Shopify reflect latency…");
    try {
      results.push(await runQB());
    } catch (err) {
      console.error("Q-B failed:", err);
    }
  }
  if (args.probes.has("Q-C")) {
    console.log("[Q-C] Counting review queue drift…");
    try {
      results.push(await runQC());
    } catch (err) {
      console.error("Q-C failed:", err);
    }
  }
  if (args.probes.has("Q-D")) {
    console.log("[Q-D] SS Inventory Sync mirror coverage…");
    try {
      results.push(await runQD());
    } catch (err) {
      console.error("Q-D failed:", err);
    }
  }
  if (args.probes.has("Q-E")) {
    console.log("[Q-E] Webhook ingress p50/p95…");
    try {
      results.push(await runQE());
    } catch (err) {
      console.error("Q-E failed:", err);
    }
  }

  const report = { generatedAt, args: { ...args, probes: [...args.probes] }, results };
  const jsonPath = path.join(args.outDir, `${stamp}.json`);
  const mdPath = path.join(args.outDir, `${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(mdPath, renderMarkdown({ generatedAt, args, results }), "utf8");

  console.log("");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((err) => {
  console.error("world-class-baseline failed:", err);
  process.exit(1);
});
