/**
 * Phase 6 closeout — automated cross-system inventory verification.
 *
 * Hourly during the ramp window (Sat-Mon Apr 18-20), then daily after Tuesday
 * onboarding. Per workspace, samples N SKUs (15 in ramp, 5 daily) prioritized
 * by recent activity, fetches current "available" from four sources (DB,
 * Redis, ShipStation v2, Bandcamp), classifies drift, persists an artifact
 * row to `megaplan_spot_check_runs`, and creates a review queue item only
 * when `drift_major` PERSISTS across two consecutive runs (review pass v4
 * §5.3 — eliminates transient lag noise).
 *
 * Plan reference: §C.3.
 */
import { logger, schedules } from "@trigger.dev/sdk";
import { getInventory as redisGetInventory } from "@/lib/clients/redis-inventory";
import { listInventory } from "@/lib/clients/shipstation-inventory-v2";
import { getInventoryLevelsAtLocation } from "@/lib/server/shopify-connection-graphql";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

// B-4 / HRD-15 — cap on Shopify-direct probes per connection per run.
// `inventoryLevels` GraphQL costs ~2 points per item; Shopify's bucket is
// 50 pts/sec for standard plans. 50 SKUs per connection × ~2 pts = 100 pts
// over <2 seconds is safely inside the per-connection budget. High-SKU
// stores rotate which subset is sampled across consecutive runs.
const MAX_SHOPIFY_DIRECT_PROBES_PER_CONNECTION = 50;

interface SkuRow {
  sku: string;
  variantId: string;
  workspaceId: string;
  dbAvailable: number;
  redisAvailable: number | null;
  shipstationAvailable: number | null;
  bandcampAvailable: number | null;
  /** B-4: per-SKU available from a direct Shopify Admin GraphQL probe at the connection's default_location_id. NULL when no shopify mapping, or the probe failed, or the SKU was over the per-connection probe cap this run. */
  shopifyDirectAvailable: number | null;
  /**
   * B-4 / HRD-15 — symmetric 5-source classification.
   *
   *   - agreed              all 5 sources match
   *   - delayed_propagation DB === Redis but external sources lag (existing)
   *   - drift_minor         maxDiff <= 2 anywhere
   *   - legacy_drift        Shopify-direct AND DB agree but ShipStation v2 disagrees
   *                         (informational artifact only — NOT a review queue item;
   *                         tells us where the SS v2 truth was wrong before cutover)
   *   - bandcamp_drift      Shopify-direct + DB + SS agree but Bandcamp disagrees
   *                         (existing handling)
   *   - drift_major         everything else
   */
  classification:
    | "agreed"
    | "delayed_propagation"
    | "drift_minor"
    | "legacy_drift"
    | "bandcamp_drift"
    | "drift_major";
}

interface ShopifyConnectionForProbe {
  id: string;
  store_url: string;
  api_key: string | null;
  default_location_id: string | null;
}

interface ShopifySkuMapping {
  remote_inventory_item_id: string | null;
  connection_id: string;
}

interface SampledRow {
  sku: string;
  variant_id: string;
  workspace_id: string;
  org_id: string | null;
  last_activity_at: string;
}

interface PriorRunSummary {
  rows?: Array<{ sku: string; classification: string }>;
}

export const megaplanSpotCheckTask = schedules.task({
  id: "megaplan-spot-check",
  queue: shipstationQueue,
  // Hourly during ramp; switch the cron to "0 9 * * *" after Tuesday onboarding.
  cron: "0 * * * *",
  run: async () => {
    const supabase = createServiceRoleClient();
    const startedAt = new Date().toISOString();

    const { data: workspaces, error: wsErr } = await supabase
      .from("workspaces")
      .select("id, name, fanout_rollout_percent");
    if (wsErr) {
      logger.error("[megaplan-spot-check] failed to load workspaces", { error: wsErr });
      throw wsErr;
    }

    // Ramp detection (review pass v4 §5.1): if any workspace has
    // fanout_rollout_percent < 100 we treat the system as "in ramp" and
    // sample 15 SKUs per client instead of 5. After Tuesday all workspaces
    // hit 100 and the daily run drops to 5.
    const inRamp = (workspaces ?? []).some(
      (w) => typeof w.fanout_rollout_percent === "number" && w.fanout_rollout_percent < 100,
    );
    const perClient = inRamp ? 15 : 5;

    for (const ws of workspaces ?? []) {
      const { data: runRow, error: runErr } = await supabase
        .from("megaplan_spot_check_runs")
        .insert({ workspace_id: ws.id, started_at: startedAt })
        .select("id")
        .single();
      if (runErr || !runRow) {
        logger.error("[megaplan-spot-check] failed to insert run row", {
          workspaceId: ws.id,
          error: runErr,
        });
        continue;
      }

      const { data: sampledRaw, error: sampleErr } = await supabase.rpc(
        "megaplan_sample_skus_per_client",
        {
          p_workspace_id: ws.id,
          p_per_client: perClient,
          p_exclude_count_in_progress: true,
          p_prioritize_recent_activity_hours: 4,
        },
      );
      if (sampleErr) {
        logger.error("[megaplan-spot-check] sampler RPC failed", {
          workspaceId: ws.id,
          error: sampleErr,
        });
        continue;
      }
      const sampled = (sampledRaw ?? []) as SampledRow[];

      // ─── B-4 / HRD-15: pre-batch Shopify-direct probes by connection ──
      // We batch BEFORE the per-row loop so each connection produces ONE
      // GraphQL request covering up to MAX_SHOPIFY_DIRECT_PROBES_PER_CONNECTION
      // SKUs. Per-row code below just reads from this Map. Failures are
      // captured per-connection (not per-SKU) — a single connection error
      // marks all its SKUs as `shopifyDirectAvailable: null` and continues.
      const shopifyDirectByVariantId = new Map<string, number | null>();
      let shopifyDirectProbeCount = 0;
      let shopifyDirectProbeFailures = 0;
      try {
        const variantIds = sampled.map((s) => s.variant_id);
        if (variantIds.length > 0) {
          const { data: mappings } = await supabase
            .from("client_store_sku_mappings")
            .select("variant_id, remote_inventory_item_id, connection_id")
            .in("variant_id", variantIds);

          // Group: connection_id → variant_id[] (capped per connection)
          const variantsByConnection = new Map<
            string,
            Array<{ variantId: string; remoteInventoryItemId: string }>
          >();
          for (const m of (mappings ?? []) as Array<ShopifySkuMapping & { variant_id: string }>) {
            if (!m.remote_inventory_item_id) continue;
            const list = variantsByConnection.get(m.connection_id) ?? [];
            if (list.length >= MAX_SHOPIFY_DIRECT_PROBES_PER_CONNECTION) continue;
            list.push({
              variantId: m.variant_id,
              remoteInventoryItemId: m.remote_inventory_item_id,
            });
            variantsByConnection.set(m.connection_id, list);
          }

          if (variantsByConnection.size > 0) {
            const { data: connections } = await supabase
              .from("client_store_connections")
              .select("id, store_url, api_key, default_location_id, platform")
              .eq("platform", "shopify")
              .in("id", Array.from(variantsByConnection.keys()));

            const connectionById = new Map<string, ShopifyConnectionForProbe>();
            for (const c of (connections ?? []) as Array<ShopifyConnectionForProbe>) {
              connectionById.set(c.id, c);
            }

            for (const [connectionId, items] of variantsByConnection) {
              const conn = connectionById.get(connectionId);
              if (!conn || !conn.api_key || !conn.default_location_id) {
                // Connection missing creds or default_location_id — null out
                // these variants without an HTTP call. The dry-run gate
                // (HRD-04) is supposed to set default_location_id before
                // do_not_fanout flips, so this is rare in practice.
                for (const it of items) shopifyDirectByVariantId.set(it.variantId, null);
                continue;
              }
              try {
                const inventoryLevels = await getInventoryLevelsAtLocation(
                  { storeUrl: conn.store_url, accessToken: conn.api_key },
                  items.map((i) => i.remoteInventoryItemId),
                  conn.default_location_id,
                );
                for (const it of items) {
                  const lvl = inventoryLevels.get(it.remoteInventoryItemId);
                  shopifyDirectByVariantId.set(it.variantId, lvl ?? null);
                  if (lvl !== null && lvl !== undefined) shopifyDirectProbeCount += 1;
                }
              } catch (err) {
                shopifyDirectProbeFailures += 1;
                logger.warn("[megaplan-spot-check] Shopify-direct probe failed", {
                  connectionId,
                  workspaceId: ws.id,
                  err: String(err),
                });
                for (const it of items) shopifyDirectByVariantId.set(it.variantId, null);
              }
            }
          }
        }
      } catch (err) {
        // Pre-batch failures must not block the rest of the spot-check.
        logger.warn("[megaplan-spot-check] Shopify-direct pre-batch failed", {
          workspaceId: ws.id,
          err: String(err),
        });
      }

      const rows: SkuRow[] = [];
      for (const row of sampled) {
        const { data: level } = await supabase
          .from("warehouse_inventory_levels")
          .select("available")
          .eq("variant_id", row.variant_id)
          .maybeSingle();
        const dbAvailable = level?.available ?? 0;

        let redisAvailable: number | null = null;
        try {
          const r = await redisGetInventory(row.sku);
          redisAvailable = r.available;
        } catch (err) {
          logger.warn("[megaplan-spot-check] Redis read failed", { sku: row.sku, err });
        }

        let shipstationAvailable: number | null = null;
        try {
          const records = await listInventory({ skus: [row.sku] });
          // Sum across locations because a SKU with per-location data has
          // multiple inventory records — the comparison target is the
          // ShipStation total, not any individual row. SKUs missing from the
          // response are treated as 0 (Patch D2 finding: a SKU at available 0
          // disappears from /v2/inventory entirely).
          shipstationAvailable = records.reduce((acc, rec) => acc + (rec.available ?? 0), 0);
        } catch (err) {
          logger.warn("[megaplan-spot-check] ShipStation read failed", { sku: row.sku, err });
        }

        const { data: mapping } = await supabase
          .from("bandcamp_product_mappings")
          .select("bandcamp_origin_quantities")
          .eq("workspace_id", ws.id)
          .eq("variant_id", row.variant_id)
          .maybeSingle();
        const bandcampAvailable = extractBandcampPushedQuantity(
          mapping?.bandcamp_origin_quantities,
        );

        const shopifyDirectAvailable = shopifyDirectByVariantId.has(row.variant_id)
          ? (shopifyDirectByVariantId.get(row.variant_id) ?? null)
          : null;

        rows.push({
          sku: row.sku,
          variantId: row.variant_id,
          workspaceId: ws.id,
          dbAvailable,
          redisAvailable,
          shipstationAvailable,
          bandcampAvailable,
          shopifyDirectAvailable,
          classification: classify({
            db: dbAvailable,
            redis: redisAvailable,
            ss: shipstationAvailable,
            bc: bandcampAvailable,
            shopify: shopifyDirectAvailable,
          }),
        });
      }

      const summary = summarize(rows);
      const artifactMd = renderArtifactMarkdown(ws, rows, summary);

      const { error: updateErr } = await supabase
        .from("megaplan_spot_check_runs")
        .update({
          finished_at: new Date().toISOString(),
          sampled_sku_count: rows.length,
          drift_agreed_count: summary.agreed,
          drift_minor_count: summary.minor,
          drift_major_count: summary.major,
          delayed_propagation_count: summary.delayed,
          // B-4 / HRD-15 — count of SKUs successfully verified via direct
          // Shopify GraphQL probe this run. Per-SKU values live in
          // summary_json.rows[].shopifyDirectAvailable. Failures are NOT
          // counted; this is the operational metric "how much of the spot
          // check was 5-source vs degraded to 4-source". When this count
          // collapses to zero across runs, surface as a Channels page alert.
          shopify_direct_available: shopifyDirectProbeCount,
          summary_json: {
            rows,
            shopify_direct_probe_count: shopifyDirectProbeCount,
            shopify_direct_probe_failures: shopifyDirectProbeFailures,
            legacy_drift_count: summary.legacyDrift,
            bandcamp_drift_count: summary.bandcampDrift,
          },
          artifact_md: artifactMd,
        })
        .eq("id", runRow.id);
      if (updateErr) {
        logger.error("[megaplan-spot-check] failed to update run row", {
          runId: runRow.id,
          error: updateErr,
        });
      }

      // Persistence rule (review pass v4 §5.3): drift_major must repeat in TWO
      // consecutive runs for the same SKU before creating a review queue item.
      // Eliminates transient ShipStation/Bandcamp propagation-lag noise.
      const driftMajorSkus = rows
        .filter((r) => r.classification === "drift_major")
        .map((r) => r.sku);

      if (driftMajorSkus.length > 0) {
        const { data: priorRun } = await supabase
          .from("megaplan_spot_check_runs")
          .select("summary_json")
          .eq("workspace_id", ws.id)
          .lt("started_at", startedAt)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const priorSummary = (priorRun?.summary_json as PriorRunSummary | null) ?? null;
        const priorMajorSkus = new Set<string>(
          (priorSummary?.rows ?? [])
            .filter((r) => r.classification === "drift_major")
            .map((r) => r.sku),
        );
        const persistedMajor = driftMajorSkus.filter((sku) => priorMajorSkus.has(sku));

        if (persistedMajor.length > 0) {
          const { error: queueErr } = await supabase.from("warehouse_review_queue").upsert(
            {
              workspace_id: ws.id,
              category: "megaplan_spot_check",
              severity: "critical" as const,
              title: `Spot-check: ${persistedMajor.length} SKU(s) in drift_major for 2 consecutive runs`,
              description:
                `Workspace ${ws.name ?? ws.id}. SKUs with persistent major drift across DB/Redis/ShipStation/Bandcamp: ` +
                persistedMajor.join(", "),
              metadata: {
                run_id: runRow.id,
                persisted_skus: persistedMajor,
                all_drift_major_this_run: driftMajorSkus,
              },
              status: "open" as const,
              group_key: `megaplan-spot-check-${ws.id}`,
              occurrence_count: 1,
            },
            { onConflict: "group_key", ignoreDuplicates: false },
          );
          if (queueErr) {
            logger.error("[megaplan-spot-check] failed to upsert review queue item", {
              workspaceId: ws.id,
              error: queueErr,
            });
          }
        } else {
          logger.info(
            "[megaplan-spot-check] drift_major SKUs detected but did not persist from prior run — no review item created",
            { workspaceId: ws.id, transientSkus: driftMajorSkus },
          );
        }
      }
    }
  },
});

/**
 * B-4 / HRD-15 — symmetric 5-source classification.
 *
 * The Shopify-direct value (`shopify`) is treated as a NEW source, not a
 * replacement for any existing source. The classifier preserves prior
 * behavior on 4-source inputs (when `shopify === null`) so this change is
 * non-breaking for connections without a Shopify mapping.
 *
 * Disagreement priority (most-specific first):
 *   1. shopify-direct vs DB > 2 → drift_major (escalation direction)
 *   2. shopify === db AND ss disagrees → legacy_drift (informational)
 *   3. shopify === db === ss AND bc disagrees → bandcamp_drift
 *   4. Existing 4-source rules apply otherwise (agreed / delayed / minor / major)
 */
export function classify(args: {
  db: number;
  redis: number | null;
  ss: number | null;
  bc: number | null;
  shopify: number | null;
}): SkuRow["classification"] {
  const { db, redis, ss, bc, shopify } = args;

  // Existing 4-source guard: any failed read on the legacy sources = major.
  if (redis === null || ss === null || bc === null) return "drift_major";

  // Shopify-direct is the new authoritative source for cutover. A direct
  // disagreement >2 is always escalated; this is the "Shopify says X but
  // the warehouse believes Y" signal that motivated HRD-15.
  if (shopify !== null && Math.abs(db - shopify) > 2) return "drift_major";

  // 5-way agreement (or 4-way agreement when no shopify mapping exists)
  const allAgree = db === redis && db === ss && db === bc && (shopify === null || db === shopify);
  if (allAgree) return "agreed";

  // legacy_drift: shopify-direct AND DB agree but ShipStation v2 disagrees.
  // Tells us where SS truth was wrong before cutover. Informational artifact
  // only — the persistence rule does NOT escalate this to a review queue
  // item.
  if (shopify !== null && db === shopify && db !== ss) return "legacy_drift";

  // bandcamp_drift: shopify-direct + DB + SS agree but Bandcamp disagrees.
  // Existing handling; surfaces sticky push lag without spamming the queue.
  if (shopify !== null && db === shopify && db === ss && db !== bc) {
    return "bandcamp_drift";
  }

  // Existing rules: DB/Redis agreement + external lag = delayed propagation.
  if (db === redis && (db !== ss || db !== bc)) return "delayed_propagation";

  const diffs = [Math.abs(db - redis), Math.abs(db - ss), Math.abs(db - bc)];
  if (shopify !== null) diffs.push(Math.abs(db - shopify));
  const maxDiff = Math.max(...diffs);
  return maxDiff <= 2 ? "drift_minor" : "drift_major";
}

function summarize(rows: SkuRow[]) {
  return {
    agreed: rows.filter((r) => r.classification === "agreed").length,
    delayed: rows.filter((r) => r.classification === "delayed_propagation").length,
    minor: rows.filter((r) => r.classification === "drift_minor").length,
    major: rows.filter((r) => r.classification === "drift_major").length,
    legacyDrift: rows.filter((r) => r.classification === "legacy_drift").length,
    bandcampDrift: rows.filter((r) => r.classification === "bandcamp_drift").length,
  };
}

function renderArtifactMarkdown(
  ws: { id: string; name: string | null },
  rows: SkuRow[],
  summary: ReturnType<typeof summarize>,
): string {
  const header = `# Spot-check ${new Date().toISOString()} — ${ws.name ?? ws.id}\n\n`;
  const sum =
    `**Summary:** ${summary.agreed} agreed | ${summary.delayed} delayed | ` +
    `${summary.minor} minor | ${summary.major} major | ` +
    `${summary.legacyDrift} legacy_drift | ${summary.bandcampDrift} bandcamp_drift\n\n`;
  const table =
    "| SKU | DB | Redis | Shopify-direct | ShipStation | Bandcamp | Class |\n" +
    "|---|---:|---:|---:|---:|---:|---|\n" +
    rows
      .map(
        (r) =>
          `| ${r.sku} | ${r.dbAvailable} | ${r.redisAvailable ?? "—"} | ` +
          `${r.shopifyDirectAvailable ?? "—"} | ${r.shipstationAvailable ?? "—"} | ` +
          `${r.bandcampAvailable ?? "—"} | ${r.classification} |`,
      )
      .join("\n");
  return header + sum + table;
}

function extractBandcampPushedQuantity(originQuantities: unknown): number | null {
  if (!Array.isArray(originQuantities) || originQuantities.length === 0) return null;
  // bandcamp_origin_quantities shape: [{ origin_id, quantity_available, ...}, ...]
  // Sum across all origins to get the total Bandcamp-known available.
  let total = 0;
  let foundAny = false;
  for (const entry of originQuantities) {
    const q = (entry as { quantity_available?: number } | null)?.quantity_available;
    if (typeof q === "number") {
      total += q;
      foundAny = true;
    }
  }
  return foundAny ? total : null;
}
