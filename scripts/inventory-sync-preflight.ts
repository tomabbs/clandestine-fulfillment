/**
 * Inventory sync cutover preflight.
 *
 * Read-only report for SKU mapping coverage, Shopify location readiness,
 * Bandcamp push modes, Woo deferral, review-queue blockers, and Redis/Postgres
 * drift evidence. Intended for:
 *
 *   npx tsx scripts/inventory-sync-preflight.ts --workspace-id <uuid>
 *   npx tsx scripts/inventory-sync-preflight.ts --workspace-id <uuid> --connection-id <uuid> --strict
 */

import { config } from "dotenv";
import { writeFileSync } from "node:fs";
import { getInventory } from "@/lib/clients/redis-inventory";
import { getInventoryLevelsAtLocation } from "@/lib/server/shopify-connection-graphql";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

type Readiness = "ready" | "blocked" | "deferred";

type CliArgs = {
  workspaceId: string | null;
  connectionId: string | null;
  orgId: string | null;
  strict: boolean;
  markdown: boolean;
  out: string | null;
};

type PreflightConnection = {
  connectionId: string;
  platform: string;
  orgId: string | null;
  doNotFanout: boolean;
  cutoverState: string | null;
  defaultLocationId?: string | null;
  defaultLocationLabel?: string | null;
  stockedVariants: number;
  stockedMapped: number;
  stockedUnmapped: number;
  missingRemoteInventoryItem: number;
  inactiveLocationItems?: number | null;
  neverPushedMappings: number;
  readiness: Readiness;
  blockers: string[];
};

type InventorySyncPreflightReport = {
  workspaceId: string;
  generatedAt: string;
  target?: { orgId?: string; connectionId?: string };
  global: {
    inventorySyncPaused: boolean;
    fanoutRolloutPercent: number;
    redisPostgresDrift: {
      status: "ok" | "warning" | "critical";
      maxUnitsDrift: number;
      oldestDriftAgeMinutes: number | null;
    };
  };
  connections: PreflightConnection[];
  bandcamp: {
    pushModeCounts: Record<string, number>;
    blockedStockedMappings: number;
  };
  reviewQueue: {
    criticalOpen: number;
    warningOpen: number;
  };
  strictPassed: boolean;
  blockers: string[];
};

function parseArgs(): CliArgs {
  const args: CliArgs = {
    workspaceId: null,
    connectionId: null,
    orgId: null,
    strict: false,
    markdown: false,
    out: null,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--workspace-id" && process.argv[i + 1]) args.workspaceId = process.argv[++i];
    else if (arg === "--connection-id" && process.argv[i + 1]) args.connectionId = process.argv[++i];
    else if (arg === "--org-id" && process.argv[i + 1]) args.orgId = process.argv[++i];
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--markdown") args.markdown = true;
    else if (arg === "--out" && process.argv[i + 1]) args.out = process.argv[++i];
    else {
      throw new Error(
        `Unknown argument ${arg}. Usage: npx tsx scripts/inventory-sync-preflight.ts --workspace-id <uuid> [--connection-id <uuid>] [--org-id <uuid>] [--strict] [--markdown] [--out <path>]`,
      );
    }
  }
  if (!args.workspaceId) throw new Error("--workspace-id is required");
  return args;
}

function pushCount(map: Record<string, number>, key: string | null | undefined): void {
  const k = key || "unknown";
  map[k] = (map[k] ?? 0) + 1;
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

async function main() {
  const args = parseArgs();
  const workspaceId = args.workspaceId as string;
  const supabase = createServiceRoleClient();

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, inventory_sync_paused, fanout_rollout_percent")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceError || !workspace) {
    throw new Error(`Workspace not found: ${workspaceError?.message ?? workspaceId}`);
  }

  const connectionsQuery = supabase
    .from("client_store_connections")
    .select(
      "id, workspace_id, org_id, platform, store_url, api_key, do_not_fanout, cutover_state, default_location_id, connection_status",
    )
    .eq("workspace_id", workspaceId);
  if (args.connectionId) connectionsQuery.eq("id", args.connectionId);
  if (args.orgId) connectionsQuery.eq("org_id", args.orgId);
  const { data: connections, error: connectionsError } = await connectionsQuery;
  if (connectionsError) throw new Error(`Connection query failed: ${connectionsError.message}`);

  const { data: coverageRows } = await supabase
    .from("client_store_connection_org_coverage")
    .select("connection_id, org_id")
    .eq("workspace_id", workspaceId);

  const coverageByConnection = new Map<string, Set<string>>();
  for (const row of coverageRows ?? []) {
    const set = coverageByConnection.get(row.connection_id) ?? new Set<string>();
    if (row.org_id) set.add(row.org_id);
    coverageByConnection.set(row.connection_id, set);
  }

  const { data: stockedRows, error: stockedError } = await supabase
    .from("warehouse_inventory_levels")
    .select(
      "sku, variant_id, available, warehouse_product_variants!inner(id, warehouse_products!inner(org_id))",
    )
    .eq("workspace_id", workspaceId)
    .gt("available", 0);
  if (stockedError) throw new Error(`Stocked variant query failed: ${stockedError.message}`);

  const stockedByOrg = new Map<string, Set<string>>();
  const stockedByVariant = new Map<string, { sku: string; available: number; orgId: string | null }>();
  for (const row of stockedRows ?? []) {
    const product = Array.isArray(row.warehouse_product_variants)
      ? row.warehouse_product_variants[0]?.warehouse_products
      : row.warehouse_product_variants?.warehouse_products;
    const org = Array.isArray(product) ? product[0]?.org_id : product?.org_id;
    stockedByVariant.set(row.variant_id, {
      sku: row.sku,
      available: row.available ?? 0,
      orgId: org ?? null,
    });
    if (org) {
      const set = stockedByOrg.get(org) ?? new Set<string>();
      set.add(row.variant_id);
      stockedByOrg.set(org, set);
    }
  }

  const { data: mappings, error: mappingsError } = await supabase
    .from("client_store_sku_mappings")
    .select(
      "id, connection_id, variant_id, remote_sku, remote_inventory_item_id, is_active, last_pushed_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (mappingsError) throw new Error(`Mapping query failed: ${mappingsError.message}`);

  const mappingsByConnection = new Map<string, typeof mappings>();
  for (const mapping of mappings ?? []) {
    const arr = mappingsByConnection.get(mapping.connection_id) ?? [];
    arr.push(mapping);
    mappingsByConnection.set(mapping.connection_id, arr);
  }

  const reportConnections: PreflightConnection[] = [];
  for (const conn of connections ?? []) {
    const coverage = coverageByConnection.get(conn.id);
    const orgIds = coverage?.size ? Array.from(coverage) : conn.org_id ? [conn.org_id] : [];
    const stockedVariants = new Set<string>();
    for (const orgId of orgIds) {
      for (const variantId of stockedByOrg.get(orgId) ?? []) stockedVariants.add(variantId);
    }

    const connMappings = mappingsByConnection.get(conn.id) ?? [];
    const stockedMappings = connMappings.filter((m) => stockedVariants.has(m.variant_id));
    const mappedStockedVariantIds = new Set(stockedMappings.map((m) => m.variant_id));
    const missingRemoteInventoryItem = stockedMappings.filter((m) => !m.remote_inventory_item_id).length;
    const neverPushedMappings = stockedMappings.filter((m) => !m.last_pushed_at).length;
    const blockers: string[] = [];

    if (conn.platform === "shopify" && !conn.default_location_id) {
      blockers.push("missing_default_location_id");
    }
    if (stockedVariants.size - mappedStockedVariantIds.size > 0) {
      blockers.push("stocked_unmapped_variants");
    }
    if (conn.platform === "shopify" && missingRemoteInventoryItem > 0) {
      blockers.push("missing_remote_inventory_item_id");
    }

    let inactiveLocationItems: number | null = null;
    if (
      conn.platform === "shopify" &&
      conn.api_key &&
      conn.default_location_id &&
      stockedMappings.some((m) => m.remote_inventory_item_id)
    ) {
      const ids = stockedMappings
        .map((m) => m.remote_inventory_item_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      try {
        const levels = await getInventoryLevelsAtLocation(
          { storeUrl: conn.store_url, accessToken: conn.api_key },
          ids,
          conn.default_location_id,
        );
        inactiveLocationItems = ids.filter((id) => !levels.has(id) || levels.get(id) == null).length;
        if (inactiveLocationItems > 0) blockers.push("inventory_items_not_stocked_at_default_location");
      } catch (err) {
        inactiveLocationItems = null;
        blockers.push(
          `shopify_location_read_failed:${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (conn.platform === "woocommerce") {
      if (conn.do_not_fanout && (conn.cutover_state ?? "legacy") === "legacy") {
        blockers.push("woo_deferred_v1");
      } else {
        blockers.push("woo_in_scope_requires_mapping_readiness");
      }
    }

    const readiness: Readiness =
      conn.platform === "woocommerce" && conn.do_not_fanout && (conn.cutover_state ?? "legacy") === "legacy"
        ? "deferred"
        : blockers.length > 0
          ? "blocked"
          : "ready";

    reportConnections.push({
      connectionId: conn.id,
      platform: conn.platform,
      orgId: conn.org_id ?? null,
      doNotFanout: conn.do_not_fanout ?? false,
      cutoverState: conn.cutover_state ?? null,
      defaultLocationId: conn.default_location_id ?? null,
      defaultLocationLabel: conn.default_location_id ?? null,
      stockedVariants: stockedVariants.size,
      stockedMapped: mappedStockedVariantIds.size,
      stockedUnmapped: stockedVariants.size - mappedStockedVariantIds.size,
      missingRemoteInventoryItem,
      inactiveLocationItems,
      neverPushedMappings,
      readiness,
      blockers,
    });
  }

  const { data: bandcampRows } = await supabase
    .from("bandcamp_product_mappings")
    .select("variant_id, push_mode")
    .eq("workspace_id", workspaceId);
  const pushModeCounts: Record<string, number> = {};
  let blockedStockedMappings = 0;
  for (const row of bandcampRows ?? []) {
    pushCount(pushModeCounts, row.push_mode);
    if (
      stockedByVariant.has(row.variant_id) &&
      row.push_mode !== "normal" &&
      row.push_mode !== "manual_override"
    ) {
      blockedStockedMappings++;
    }
  }

  const reviewBase = supabase
    .from("warehouse_review_queue")
    .select("id, severity", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("status", "open");
  if (args.orgId) reviewBase.eq("org_id", args.orgId);
  const { data: reviewRows } = await reviewBase;
  const criticalOpen = (reviewRows ?? []).filter((r) => r.severity === "critical").length;
  const warningOpen = (reviewRows ?? []).filter((r) => r.severity !== "critical").length;

  const redisPostgresDrift = await computeRedisPostgresDrift(supabase, workspaceId);
  const blockers = [
    ...reportConnections.flatMap((c) =>
      c.readiness === "blocked" ? c.blockers.map((b) => `${c.connectionId}:${b}`) : [],
    ),
  ];
  if (criticalOpen > 0) blockers.push("critical_review_queue_items_open");
  if (redisPostgresDrift.status === "critical") blockers.push("critical_redis_postgres_drift");

  const report: InventorySyncPreflightReport = {
    workspaceId,
    generatedAt: new Date().toISOString(),
    target: {
      ...(args.orgId ? { orgId: args.orgId } : {}),
      ...(args.connectionId ? { connectionId: args.connectionId } : {}),
    },
    global: {
      inventorySyncPaused: workspace.inventory_sync_paused ?? false,
      fanoutRolloutPercent: workspace.fanout_rollout_percent ?? 0,
      redisPostgresDrift,
    },
    connections: reportConnections,
    bandcamp: { pushModeCounts, blockedStockedMappings },
    reviewQueue: { criticalOpen, warningOpen },
    strictPassed: blockers.length === 0,
    blockers,
  };

  const output = args.markdown ? renderMarkdown(report) : JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(args.out, `${output}\n`);
  console.log(output);

  if (args.strict && !report.strictPassed) process.exit(1);
}

async function computeRedisPostgresDrift(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<InventorySyncPreflightReport["global"]["redisPostgresDrift"]> {
  try {
    const { data: observations, error } = await supabase
      .from("redis_pg_drift_observations")
      .select("max_abs_drift, first_observed_at, status")
      .eq("workspace_id", workspaceId)
      .neq("status", "resolved");
    if (!error && observations && observations.length > 0) {
      const maxUnitsDrift = Math.max(...observations.map((o) => o.max_abs_drift ?? 0));
      const oldestDriftAgeMinutes = Math.max(
        ...observations.map((o) => minutesSince(o.first_observed_at)),
      );
      return {
        status: observations.some((o) => o.status === "critical") ? "critical" : "warning",
        maxUnitsDrift,
        oldestDriftAgeMinutes,
      };
    }
  } catch {
    // Table may not exist before the cutover migration is applied; fall back to
    // a bounded live sample below.
  }

  const { data: sample } = await supabase
    .from("warehouse_inventory_levels")
    .select("sku, available")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(200);

  let maxUnitsDrift = 0;
  for (const row of sample ?? []) {
    try {
      const redis = await getInventory(row.sku);
      maxUnitsDrift = Math.max(maxUnitsDrift, Math.abs(redis.available - (row.available ?? 0)));
    } catch {
      return { status: "warning", maxUnitsDrift, oldestDriftAgeMinutes: null };
    }
  }

  return {
    status: maxUnitsDrift >= 50 ? "critical" : maxUnitsDrift > 0 ? "warning" : "ok",
    maxUnitsDrift,
    oldestDriftAgeMinutes: null,
  };
}

function renderMarkdown(report: InventorySyncPreflightReport): string {
  const lines = [
    `# Inventory Sync Preflight`,
    ``,
    `Generated: ${report.generatedAt}`,
    `Workspace: ${report.workspaceId}`,
    `Strict: ${report.strictPassed ? "PASS" : "BLOCKED"}`,
    ``,
    `## Global`,
    ``,
    `- inventory_sync_paused: ${report.global.inventorySyncPaused}`,
    `- fanout_rollout_percent: ${report.global.fanoutRolloutPercent}`,
    `- redis/postgres drift: ${report.global.redisPostgresDrift.status} (max ${report.global.redisPostgresDrift.maxUnitsDrift}, oldest ${report.global.redisPostgresDrift.oldestDriftAgeMinutes ?? "n/a"} min)`,
    ``,
    `## Connections`,
    ``,
  ];
  for (const c of report.connections) {
    lines.push(
      `- ${c.platform} ${c.connectionId}: ${c.readiness}; stocked=${c.stockedVariants}, mapped=${c.stockedMapped}, unmapped=${c.stockedUnmapped}, missing_inventory_item=${c.missingRemoteInventoryItem}, inactive_location=${c.inactiveLocationItems ?? "n/a"}, never_pushed=${c.neverPushedMappings}; blockers=${c.blockers.join(", ") || "none"}`,
    );
  }
  lines.push(
    ``,
    `## Bandcamp`,
    ``,
    `- push modes: ${JSON.stringify(report.bandcamp.pushModeCounts)}`,
    `- blocked stocked mappings: ${report.bandcamp.blockedStockedMappings}`,
    ``,
    `## Review Queue`,
    ``,
    `- critical open: ${report.reviewQueue.criticalOpen}`,
    `- warning/non-critical open: ${report.reviewQueue.warningOpen}`,
  );
  if (report.blockers.length > 0) {
    lines.push(``, `## Blockers`, ``, ...report.blockers.map((b) => `- ${b}`));
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
