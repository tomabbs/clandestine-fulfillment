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
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

interface SkuRow {
  sku: string;
  variantId: string;
  workspaceId: string;
  dbAvailable: number;
  redisAvailable: number | null;
  shipstationAvailable: number | null;
  bandcampAvailable: number | null;
  classification: "agreed" | "delayed_propagation" | "drift_minor" | "drift_major";
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

        rows.push({
          sku: row.sku,
          variantId: row.variant_id,
          workspaceId: ws.id,
          dbAvailable,
          redisAvailable,
          shipstationAvailable,
          bandcampAvailable,
          classification: classify(
            dbAvailable,
            redisAvailable,
            shipstationAvailable,
            bandcampAvailable,
          ),
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
          summary_json: { rows },
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

function classify(
  db: number,
  redis: number | null,
  ss: number | null,
  bc: number | null,
): SkuRow["classification"] {
  // If any source failed to read, that's drift_major — we can't verify agreement.
  if (redis === null || ss === null || bc === null) return "drift_major";
  if (db === redis && db === ss && db === bc) return "agreed";

  // DB/Redis agreement but external lag is the textbook "delayed propagation"
  // signal — happens routinely between recordInventoryChange() commit and the
  // ShipStation v2 push completing. Persistence rule downstream will flag if
  // it stays delayed across two runs.
  if (db === redis && (db !== ss || db !== bc)) return "delayed_propagation";

  const maxDiff = Math.max(Math.abs(db - redis), Math.abs(db - ss), Math.abs(db - bc));
  return maxDiff <= 2 ? "drift_minor" : "drift_major";
}

function summarize(rows: SkuRow[]) {
  return {
    agreed: rows.filter((r) => r.classification === "agreed").length,
    delayed: rows.filter((r) => r.classification === "delayed_propagation").length,
    minor: rows.filter((r) => r.classification === "drift_minor").length,
    major: rows.filter((r) => r.classification === "drift_major").length,
  };
}

function renderArtifactMarkdown(
  ws: { id: string; name: string | null },
  rows: SkuRow[],
  summary: ReturnType<typeof summarize>,
): string {
  const header = `# Spot-check ${new Date().toISOString()} — ${ws.name ?? ws.id}\n\n`;
  const sum = `**Summary:** ${summary.agreed} agreed | ${summary.delayed} delayed | ${summary.minor} minor | ${summary.major} major\n\n`;
  const table =
    "| SKU | DB | Redis | ShipStation | Bandcamp | Class |\n|---|---:|---:|---:|---:|---|\n" +
    rows
      .map(
        (r) =>
          `| ${r.sku} | ${r.dbAvailable} | ${r.redisAvailable ?? "—"} | ${r.shipstationAvailable ?? "—"} | ${r.bandcampAvailable ?? "—"} | ${r.classification} |`,
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
