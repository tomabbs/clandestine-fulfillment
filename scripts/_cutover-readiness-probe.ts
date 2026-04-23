/**
 * CF-5 (Phase 0.5) — read-only cutover-readiness probe.
 *
 * Goal: produce a per-workspace JSON snapshot that the operator (and the
 * CF-6 follow-up SKU rectifier) can use to decide whether the cutover-day
 * SKU drift is small enough for an in-place CLI fix or large enough to
 * escalate into its own remediation plan.
 *
 * Side effects: NONE. Pure read. No Supabase writes, no remote API hits to
 * Shopify/Bandcamp/SS — just DB reads + JSON write to disk.
 *
 * Inputs:
 *   --workspaces=<id>,<id>,... (default: every workspace returned by
 *                               getAllWorkspaceIds — Northern Spy + True
 *                               Panther in the current pilot, but we don't
 *                               hard-code that so the script stays useful
 *                               as more workspaces light up)
 *   --threshold=<n>            mismatch count above which the verdict
 *                              flips from "safe-cli" to "escalate"
 *                              (default 20, matches plan §9.0 CF-6)
 *
 * Output:
 *   reports/cutover-readiness/{workspaceLabel}-{ISO-date}.json
 *   plus a console summary that prints the verdict per workspace.
 *
 * Usage:
 *   pnpm tsx scripts/_cutover-readiness-probe.ts
 *   pnpm tsx scripts/_cutover-readiness-probe.ts --workspaces=ws_uuid_a,ws_uuid_b
 *   pnpm tsx scripts/_cutover-readiness-probe.ts --threshold=30
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdir, writeFile } from "node:fs/promises";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface CliArgs {
  workspaceIds: string[] | null;
  threshold: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { workspaceIds: null, threshold: 20 };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--workspaces=")) {
      out.workspaceIds = a
        .slice("--workspaces=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith("--threshold=")) {
      out.threshold = Math.max(0, Number.parseInt(a.slice("--threshold=".length), 10) || 20);
    }
  }
  return out;
}

interface PerWorkspaceProbe {
  workspaceId: string;
  workspaceName: string | null;
  generatedAt: string;
  connections: {
    total: number;
    active: number;
    byPlatform: Record<string, number>;
    dormant: number;
    nullWebhookSecret: number;
  };
  skuMappings: {
    total: number;
    active: number;
    nullRemoteSku: number;
    skuLocalRemoteMismatch: number;
    sampledMismatches: Array<{
      connectionId: string;
      variantId: string;
      localSku: string | null;
      remoteSku: string | null;
    }>;
  };
  variants: {
    totalActive: number;
    nullSku: number;
  };
  webhookActivity: {
    last24hByPlatform: Record<string, number>;
    nullEventIdLast24h: number;
  };
  verdict: {
    mismatchCount: number;
    threshold: number;
    decision: "safe-cli" | "escalate";
    rationale: string[];
  };
}

async function probeWorkspace(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  threshold: number,
): Promise<PerWorkspaceProbe> {
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .maybeSingle();

  const generatedAt = new Date().toISOString();
  const probe: PerWorkspaceProbe = {
    workspaceId,
    workspaceName: (ws as { name?: string | null } | null)?.name ?? null,
    generatedAt,
    connections: {
      total: 0,
      active: 0,
      byPlatform: {},
      dormant: 0,
      nullWebhookSecret: 0,
    },
    skuMappings: {
      total: 0,
      active: 0,
      nullRemoteSku: 0,
      skuLocalRemoteMismatch: 0,
      sampledMismatches: [],
    },
    variants: { totalActive: 0, nullSku: 0 },
    webhookActivity: { last24hByPlatform: {}, nullEventIdLast24h: 0 },
    verdict: {
      mismatchCount: 0,
      threshold,
      decision: "safe-cli",
      rationale: [],
    },
  };

  // ── Connections ──────────────────────────────────────────────────────────
  const { data: conns } = await supabase
    .from("client_store_connections")
    .select("id, platform, connection_status, do_not_fanout, webhook_secret")
    .eq("workspace_id", workspaceId);
  const conn = conns ?? [];
  probe.connections.total = conn.length;
  for (const c of conn as Array<{
    platform: string | null;
    connection_status: string | null;
    do_not_fanout: boolean | null;
    webhook_secret: string | null;
  }>) {
    if (c.connection_status === "active") probe.connections.active += 1;
    if (c.do_not_fanout) probe.connections.dormant += 1;
    if (!c.webhook_secret) probe.connections.nullWebhookSecret += 1;
    const p = c.platform ?? "unknown";
    probe.connections.byPlatform[p] = (probe.connections.byPlatform[p] ?? 0) + 1;
  }

  // ── SKU mappings (drift) ─────────────────────────────────────────────────
  // CF-2 wired the workspace_id filter into fanout; here we use the same
  // column on the mappings table to scope the readiness check.
  const { data: mappings } = await supabase
    .from("client_store_sku_mappings")
    .select("id, connection_id, variant_id, remote_sku, is_active")
    .eq("workspace_id", workspaceId);
  const map = mappings ?? [];
  probe.skuMappings.total = map.length;
  probe.skuMappings.active = map.filter((m) => m.is_active === true).length;
  probe.skuMappings.nullRemoteSku = map.filter((m) => !m.remote_sku).length;

  // Local SKU lookup (one round trip, IN-list).
  const variantIds = Array.from(
    new Set(map.map((m) => m.variant_id).filter((v): v is string => !!v)),
  );
  const variantSkuById = new Map<string, string | null>();
  if (variantIds.length > 0) {
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku")
      .in("id", variantIds);
    for (const v of variants ?? []) {
      variantSkuById.set(
        (v as { id: string }).id,
        ((v as { sku?: string | null }).sku ?? null),
      );
    }
  }

  for (const m of map as Array<{
    id: string;
    connection_id: string;
    variant_id: string;
    remote_sku: string | null;
    is_active: boolean | null;
  }>) {
    if (!m.is_active) continue;
    const localSku = variantSkuById.get(m.variant_id) ?? null;
    if (!localSku || !m.remote_sku) continue;
    if (localSku.trim().toLowerCase() !== m.remote_sku.trim().toLowerCase()) {
      probe.skuMappings.skuLocalRemoteMismatch += 1;
      if (probe.skuMappings.sampledMismatches.length < 50) {
        probe.skuMappings.sampledMismatches.push({
          connectionId: m.connection_id,
          variantId: m.variant_id,
          localSku,
          remoteSku: m.remote_sku,
        });
      }
    }
  }

  // ── Variant hygiene ──────────────────────────────────────────────────────
  const { count: variantTotal } = await supabase
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  probe.variants.totalActive = variantTotal ?? 0;

  const { count: variantNullSku } = await supabase
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .is("sku", null);
  probe.variants.nullSku = variantNullSku ?? 0;

  // ── Webhook activity (last 24h) ──────────────────────────────────────────
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: webhooks } = await supabase
    .from("webhook_events")
    .select("platform, external_webhook_id")
    .eq("workspace_id", workspaceId)
    .gte("created_at", since);
  for (const w of webhooks ?? []) {
    const p = (w as { platform?: string | null }).platform ?? "unknown";
    probe.webhookActivity.last24hByPlatform[p] =
      (probe.webhookActivity.last24hByPlatform[p] ?? 0) + 1;
    if (!(w as { external_webhook_id?: string | null }).external_webhook_id) {
      probe.webhookActivity.nullEventIdLast24h += 1;
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  // Per plan §9.0 CF-6: a CLI rectifier is acceptable when ≤ threshold
  // mismatches per workspace. Otherwise escalate to its own plan.
  probe.verdict.mismatchCount = probe.skuMappings.skuLocalRemoteMismatch;
  if (probe.skuMappings.skuLocalRemoteMismatch > threshold) {
    probe.verdict.decision = "escalate";
    probe.verdict.rationale.push(
      `SKU mismatches (${probe.skuMappings.skuLocalRemoteMismatch}) exceed threshold (${threshold}); escalate to CF-6 follow-up plan.`,
    );
  } else {
    probe.verdict.rationale.push(
      `SKU mismatches (${probe.skuMappings.skuLocalRemoteMismatch}) within threshold (${threshold}); CF-6 CLI safe.`,
    );
  }
  if (probe.connections.nullWebhookSecret > 0 && probe.connections.active > 0) {
    probe.verdict.rationale.push(
      `Phase 3 release gate C.2.6 currently blocks: ${probe.connections.nullWebhookSecret} active connection(s) have NULL webhook_secret.`,
    );
  }
  if (probe.variants.nullSku > 0) {
    probe.verdict.rationale.push(
      `${probe.variants.nullSku} variant(s) have NULL SKU — fanout will skip them silently. Investigate before enabling per-SKU push (Phase 1).`,
    );
  }
  return probe;
}

function safeLabel(name: string | null, workspaceId: string): string {
  const base = (name ?? workspaceId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : workspaceId;
}

async function main() {
  const args = parseArgs(process.argv);
  const supabase = createServiceRoleClient();
  const workspaceIds =
    args.workspaceIds && args.workspaceIds.length > 0
      ? args.workspaceIds
      : await getAllWorkspaceIds(supabase);

  const reportsDir = "reports/cutover-readiness";
  await mkdir(reportsDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const summary: Array<{
    workspaceId: string;
    workspaceName: string | null;
    decision: "safe-cli" | "escalate";
    mismatches: number;
    activeConnections: number;
    nullWebhookSecret: number;
    file: string;
  }> = [];

  for (const workspaceId of workspaceIds) {
    const probe = await probeWorkspace(supabase, workspaceId, args.threshold);
    const label = safeLabel(probe.workspaceName, workspaceId);
    const file = `${reportsDir}/${label}-${today}.json`;
    await writeFile(file, JSON.stringify(probe, null, 2), "utf8");
    summary.push({
      workspaceId,
      workspaceName: probe.workspaceName,
      decision: probe.verdict.decision,
      mismatches: probe.verdict.mismatchCount,
      activeConnections: probe.connections.active,
      nullWebhookSecret: probe.connections.nullWebhookSecret,
      file,
    });
  }

  console.log("\n[CF-5] cutover-readiness probe — summary");
  console.log("─".repeat(72));
  for (const s of summary) {
    const tag = s.decision === "safe-cli" ? "SAFE-CLI" : "ESCALATE";
    console.log(
      `  ${tag.padEnd(9)} ${(s.workspaceName ?? s.workspaceId).padEnd(28)}  mismatches=${s.mismatches}  active_conns=${s.activeConnections}  null_webhook_secret=${s.nullWebhookSecret}`,
    );
    console.log(`            -> ${s.file}`);
  }
  console.log("─".repeat(72));
  const escalated = summary.filter((s) => s.decision === "escalate").length;
  if (escalated > 0) {
    console.log(
      `\n[CF-5] ${escalated} workspace(s) flagged ESCALATE — open a CF-6 follow-up plan before running the CLI rectifier.`,
    );
    process.exitCode = 2;
  } else {
    console.log("\n[CF-5] All probed workspaces are within CF-6 CLI threshold.");
  }
}

main().catch((err) => {
  console.error("[CF-5] probe failed:", err);
  process.exit(1);
});
