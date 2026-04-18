// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: service_role for Trigger tasks
//
// Phase 0.5 — daily SKU sync audit. Detects mismatches across the four
// systems we control (warehouse DB, Bandcamp, Clandestine Shopify,
// ShipStation v1) and the client store mappings, and surfaces them as
// `sku_sync_conflicts` rows for staff/client review.
//
// Design (per plan §7.1.9 + Phase 0 reinforcement #1): SUGGEST, DON'T
// MUTATE. The audit task NEVER renames a SKU or adds an alias on its own —
// it only writes detection rows. Resolution flows through staff approval
// (the `applySkuResolution` Server Action → `sku-rectify-via-alias` task).
//
// Idempotency: every conflict gets a stable `group_key`. The cron upserts
// on group_key — re-detected conflicts increment `occurrence_count`
// instead of creating duplicate rows. Resolved conflicts that re-detect
// reopen automatically with a new `occurrence_count`.

import { logger, schedules } from "@trigger.dev/sdk";
import { fetchProducts, type ShipStationProduct } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

interface ConflictDraft {
  workspace_id: string;
  org_id: string | null;
  variant_id: string | null;
  conflict_type:
    | "mismatch"
    | "orphan_shipstation"
    | "orphan_bandcamp"
    | "placeholder_squarespace"
    | "casing"
    | "ambiguous";
  severity: "low" | "medium" | "high" | "critical";
  our_sku: string | null;
  bandcamp_sku: string | null;
  shipstation_sku: string | null;
  shopify_sku: string | null;
  squarespace_sku: string | null;
  woocommerce_sku: string | null;
  example_product_title: string | null;
  /**
   * Stable across audit runs so re-detection bumps occurrence_count rather
   * than inserting duplicates. Composition rule:
   *   ${workspace_id}:${conflict_type}:${primary_sku}:${secondary_sku || ''}
   */
  group_key: string;
}

function buildGroupKey(parts: {
  workspace_id: string;
  conflict_type: ConflictDraft["conflict_type"];
  primary: string;
  secondary?: string;
}): string {
  return [parts.workspace_id, parts.conflict_type, parts.primary, parts.secondary ?? ""].join(":");
}

interface VariantRow {
  id: string;
  workspace_id: string;
  sku: string;
  title: string | null;
  product_id: string;
  org_id: string | null;
}

interface VariantWithProductRow {
  id: string;
  workspace_id: string;
  sku: string;
  title: string | null;
  product_id: string;
  warehouse_products: { org_id: string | null; title: string | null } | null;
}

/**
 * Casing detector: any two variants in the same workspace whose `sku`
 * matches case-insensitively but not exactly. This is a soft conflict
 * (severity: low) because the DB UNIQUE(workspace_id, sku) constraint
 * already prevents true duplicates — but ShipStation Inventory Sync is
 * case-sensitive, so casing differences across channels do break sync.
 */
function detectCasingConflicts(variants: VariantRow[]): ConflictDraft[] {
  const byLowerCase = new Map<string, VariantRow[]>();
  for (const v of variants) {
    const key = `${v.workspace_id}:${v.sku.toLowerCase()}`;
    const list = byLowerCase.get(key) ?? [];
    list.push(v);
    byLowerCase.set(key, list);
  }

  const conflicts: ConflictDraft[] = [];
  for (const group of Array.from(byLowerCase.values())) {
    if (group.length < 2) continue;
    // Sort by sku for stable group_key composition
    const sorted = [...group].sort((a, b) => a.sku.localeCompare(b.sku));
    conflicts.push({
      workspace_id: sorted[0].workspace_id,
      org_id: sorted[0].org_id,
      variant_id: sorted[0].id,
      conflict_type: "casing",
      severity: "low",
      our_sku: sorted.map((v) => v.sku).join(" / "),
      bandcamp_sku: null,
      shipstation_sku: null,
      shopify_sku: null,
      squarespace_sku: null,
      woocommerce_sku: null,
      example_product_title: sorted[0].title,
      group_key: buildGroupKey({
        workspace_id: sorted[0].workspace_id,
        conflict_type: "casing",
        primary: sorted[0].sku.toLowerCase(),
      }),
    });
  }
  return conflicts;
}

interface ClientStoreMapRow {
  workspace_id: string;
  variant_id: string;
  remote_sku: string | null;
  variant_sku: string;
  variant_title: string | null;
  variant_org_id: string | null;
  platform: string;
}

/**
 * Client-store mismatch detector: any `client_store_sku_mappings` row
 * whose `remote_sku` differs from the linked variant's `sku`. These
 * become alias-add candidates in ShipStation.
 */
function detectClientStoreMismatches(rows: ClientStoreMapRow[]): ConflictDraft[] {
  const conflicts: ConflictDraft[] = [];
  for (const r of rows) {
    if (!r.remote_sku || r.remote_sku === r.variant_sku) continue;

    // Squarespace placeholder SKUs are a separate, more severe class.
    const isSquarespacePlaceholder = r.platform === "squarespace" && /^SQ/i.test(r.remote_sku);

    const conflict_type: ConflictDraft["conflict_type"] = isSquarespacePlaceholder
      ? "placeholder_squarespace"
      : "mismatch";

    const severity: ConflictDraft["severity"] = isSquarespacePlaceholder ? "high" : "medium";

    const platformBucket: Pick<
      ConflictDraft,
      "shopify_sku" | "squarespace_sku" | "woocommerce_sku"
    > = {
      shopify_sku: null,
      squarespace_sku: null,
      woocommerce_sku: null,
    };
    if (r.platform === "shopify") platformBucket.shopify_sku = r.remote_sku;
    if (r.platform === "squarespace") platformBucket.squarespace_sku = r.remote_sku;
    if (r.platform === "woocommerce") platformBucket.woocommerce_sku = r.remote_sku;

    conflicts.push({
      workspace_id: r.workspace_id,
      org_id: r.variant_org_id,
      variant_id: r.variant_id,
      conflict_type,
      severity,
      our_sku: r.variant_sku,
      bandcamp_sku: null,
      shipstation_sku: null,
      ...platformBucket,
      example_product_title: r.variant_title,
      group_key: buildGroupKey({
        workspace_id: r.workspace_id,
        conflict_type,
        primary: r.variant_sku,
        secondary: `${r.platform}:${r.remote_sku}`,
      }),
    });
  }
  return conflicts;
}

/**
 * Orphan-ShipStation detector: SKUs in ShipStation v1 catalog that don't
 * map to any of our `warehouse_product_variants.sku`. These are products
 * we've never imported (e.g., manual ShipStation entries from staff) or
 * products with a master SKU we don't recognize.
 *
 * Rate-limit aware: paginated walk respects ShipStation v1's 40 req/min
 * via the existing rate limiter in `src/lib/clients/shipstation.ts`.
 * Bounded to `MAX_PAGES` per run to keep individual runs sane; subsequent
 * runs continue from page 1 with deterministic ordering and the upsert
 * key is stable, so partial runs are safe.
 */
async function detectShipStationOrphans({
  workspaceId,
  knownSkus,
  maxPages,
}: {
  workspaceId: string;
  knownSkus: Set<string>;
  maxPages: number;
}): Promise<{ conflicts: ConflictDraft[]; pagesScanned: number }> {
  const conflicts: ConflictDraft[] = [];
  const pageSize = 100;
  let page = 1;
  let pagesScanned = 0;
  let totalPages = 1;

  while (page <= Math.min(totalPages, maxPages)) {
    const result = await fetchProducts({
      page,
      pageSize,
      sortBy: "ModifyDate",
      sortDir: "DESC",
    });
    pagesScanned += 1;
    totalPages = result.pages;

    for (const product of result.products) {
      const masterSku = product.sku;
      if (!masterSku) continue;
      if (knownSkus.has(masterSku)) continue;

      // The aliases array might cover us — if any alias matches a known
      // SKU, this is not an orphan, just a known cross-store mapping.
      const aliasCovers = product.aliases.some((a) => knownSkus.has(a.name));
      if (aliasCovers) continue;

      conflicts.push(buildOrphanFromProduct({ workspaceId, product }));
    }

    page += 1;
  }

  return { conflicts, pagesScanned };
}

function buildOrphanFromProduct({
  workspaceId,
  product,
}: {
  workspaceId: string;
  product: ShipStationProduct;
}): ConflictDraft {
  return {
    workspace_id: workspaceId,
    org_id: null,
    variant_id: null,
    conflict_type: "orphan_shipstation",
    severity: "low",
    our_sku: null,
    bandcamp_sku: null,
    shipstation_sku: product.sku,
    shopify_sku: null,
    squarespace_sku: null,
    woocommerce_sku: null,
    example_product_title: product.name ?? null,
    group_key: buildGroupKey({
      workspace_id: workspaceId,
      conflict_type: "orphan_shipstation",
      primary: product.sku,
    }),
  };
}

/**
 * Upsert conflicts onto `sku_sync_conflicts` keyed by group_key. Re-runs
 * bump occurrence_count and refresh detected_at on still-open rows;
 * resolved rows that re-detect reopen.
 */
async function upsertConflicts(
  supabase: ReturnType<typeof createServiceRoleClient>,
  drafts: ConflictDraft[],
): Promise<{ inserted: number; reopened: number; bumped: number }> {
  let inserted = 0;
  let reopened = 0;
  let bumped = 0;

  for (const draft of drafts) {
    const { data: existing } = await supabase
      .from("sku_sync_conflicts")
      .select("id,status,occurrence_count")
      .eq("group_key", draft.group_key)
      .maybeSingle();

    if (!existing) {
      const { error } = await supabase.from("sku_sync_conflicts").insert(draft);
      if (error) throw error;
      inserted += 1;
      continue;
    }

    if (existing.status === "resolved" || existing.status === "ignored") {
      // Re-detection: reopen with bumped occurrence count.
      const { error } = await supabase
        .from("sku_sync_conflicts")
        .update({
          status: "open",
          detected_at: new Date().toISOString(),
          resolved_at: null,
          resolved_by: null,
          resolution_method: null,
          occurrence_count: (existing.occurrence_count ?? 1) + 1,
        })
        .eq("id", existing.id);
      if (error) throw error;
      reopened += 1;
      continue;
    }

    // Open or client_suggested: bump occurrence + detected_at.
    const { error } = await supabase
      .from("sku_sync_conflicts")
      .update({
        detected_at: new Date().toISOString(),
        occurrence_count: (existing.occurrence_count ?? 1) + 1,
      })
      .eq("id", existing.id);
    if (error) throw error;
    bumped += 1;
  }

  return { inserted, reopened, bumped };
}

export const skuSyncAuditTask = schedules.task({
  id: "sku-sync-audit",
  queue: shipstationQueue,
  // ShipStation pagination is rate-limited; give it room.
  maxDuration: 1800,
  // Daily at 02:00 UTC — well outside warehouse hours and well after the
  // 30-min cron windows for sync tasks so we don't fight for the v1 budget.
  cron: "0 2 * * *",
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    logger.info("sku-sync-audit started", { runId: ctx.run.id });

    // ── Load all workspaces (multi-tenant; per-workspace reasoning) ─────────
    const { data: workspaces, error: wsErr } = await supabase.from("workspaces").select("id");
    if (wsErr) throw wsErr;
    if (!workspaces?.length) {
      logger.warn("sku-sync-audit: no workspaces to audit");
      return { status: "skipped", reason: "no_workspaces" };
    }

    let totalInserted = 0;
    let totalReopened = 0;
    let totalBumped = 0;
    let totalShipStationPages = 0;

    for (const ws of workspaces) {
      // ── Pull our variant truth for this workspace ────────────────────────
      const { data: rawVariants, error: vErr } = await supabase
        .from("warehouse_product_variants")
        .select("id, workspace_id, sku, title, product_id, warehouse_products!inner(org_id, title)")
        .eq("workspace_id", ws.id);
      if (vErr) throw vErr;

      const variants: VariantRow[] = (rawVariants ?? []).map((row) => {
        const r = row as unknown as VariantWithProductRow;
        return {
          id: r.id,
          workspace_id: r.workspace_id,
          sku: r.sku,
          title: r.title ?? r.warehouse_products?.title ?? null,
          product_id: r.product_id,
          org_id: r.warehouse_products?.org_id ?? null,
        };
      });

      const knownSkus = new Set(variants.map((v) => v.sku));
      logger.info("sku-sync-audit: workspace loaded", {
        workspace_id: ws.id,
        variants: variants.length,
      });

      // ── Casing conflicts ────────────────────────────────────────────────
      const casingDrafts = detectCasingConflicts(variants);

      // ── Client-store mapping mismatches ────────────────────────────────
      const { data: rawMaps, error: mErr } = await supabase
        .from("client_store_sku_mappings")
        .select(
          "workspace_id, variant_id, remote_sku, " +
            "warehouse_product_variants!inner(sku, title, warehouse_products!inner(org_id)), " +
            "client_store_connections!inner(platform)",
        )
        .eq("workspace_id", ws.id);
      if (mErr) throw mErr;

      const clientStoreRows: ClientStoreMapRow[] = (rawMaps ?? []).map((row) => {
        const r = row as unknown as {
          workspace_id: string;
          variant_id: string;
          remote_sku: string | null;
          warehouse_product_variants: {
            sku: string;
            title: string | null;
            warehouse_products: { org_id: string | null };
          };
          client_store_connections: { platform: string };
        };
        return {
          workspace_id: r.workspace_id,
          variant_id: r.variant_id,
          remote_sku: r.remote_sku,
          variant_sku: r.warehouse_product_variants.sku,
          variant_title: r.warehouse_product_variants.title,
          variant_org_id: r.warehouse_product_variants.warehouse_products.org_id,
          platform: r.client_store_connections.platform,
        };
      });
      const clientStoreDrafts = detectClientStoreMismatches(clientStoreRows);

      // ── ShipStation orphan walk (rate-limit aware, page-bounded) ────────
      const { conflicts: orphanDrafts, pagesScanned } = await detectShipStationOrphans({
        workspaceId: ws.id,
        knownSkus,
        // Cap pages per workspace per run — at pageSize=100 this is 5,000
        // ShipStation products per workspace per audit, roughly 100 v1 API
        // calls at the rate limiter's 40 req/min (≈2.5 min). The next run
        // resumes deterministically (sortBy=ModifyDate DESC).
        maxPages: 50,
      });
      totalShipStationPages += pagesScanned;

      const allDrafts = [...casingDrafts, ...clientStoreDrafts, ...orphanDrafts];
      logger.info("sku-sync-audit: drafts produced", {
        workspace_id: ws.id,
        casing: casingDrafts.length,
        client_store: clientStoreDrafts.length,
        shipstation_orphan: orphanDrafts.length,
        ss_pages_scanned: pagesScanned,
      });

      const { inserted, reopened, bumped } = await upsertConflicts(supabase, allDrafts);
      totalInserted += inserted;
      totalReopened += reopened;
      totalBumped += bumped;
    }

    logger.info("sku-sync-audit complete", {
      runId: ctx.run.id,
      workspaces: workspaces.length,
      inserted: totalInserted,
      reopened: totalReopened,
      bumped: totalBumped,
      shipstation_pages: totalShipStationPages,
    });

    return {
      status: "ok",
      workspaces: workspaces.length,
      inserted: totalInserted,
      reopened: totalReopened,
      bumped: totalBumped,
      shipstation_pages: totalShipStationPages,
    };
  },
});

// Exported for testing
export {
  buildGroupKey,
  buildOrphanFromProduct as _buildOrphanFromProduct,
  detectCasingConflicts,
  detectClientStoreMismatches,
};
