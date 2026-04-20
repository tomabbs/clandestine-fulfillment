import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// READ-ONLY plan generator. Produces a JSON + CSV preview of the per-size
// Shopify variant + DB variant additions needed to bring apparel packages
// into compliance with CLAUDE.md Rule #8 (sized items = one product, one
// variant per size). NO writes are performed by this script.
//
// Output:
//   reports/finish-line/apparel-variant-backfill-plan-<ts>.json
//   reports/finish-line/apparel-variant-backfill-plan-<ts>.csv
//   reports/finish-line/apparel-variant-backfill-risks-<ts>.csv
// ---------------------------------------------------------------------------

type BcOption = {
  option_id?: number;
  title?: string | null;
  sku?: string | null;
  quantity_available?: number | null;
  quantity_sold?: number | null;
};

type Mapping = {
  id: string;
  workspace_id: string;
  variant_id: string;
  bandcamp_item_id: number;
  bandcamp_options: BcOption[] | null;
  bandcamp_option_skus: string[] | null;
  bandcamp_price: number | null;
  bandcamp_currency: string | null;
  authority_status: string;
};

type ShopifyOption = { id: string; name: string; values: string[]; position: number };
type ShopifyVariant = {
  id: string;
  sku: string | null;
  price: string;
  selectedOptions: Array<{ name: string; value: string }>;
  inventoryItem: { id: string; tracked: boolean } | null;
};
type ShopifyProduct = {
  id: string;
  title: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  vendor: string | null;
  options: ShopifyOption[];
  variants: { nodes: ShopifyVariant[] };
  productType: string | null;
};

function normSku(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9\-_./]/g, "");
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `"${String(v).replaceAll('"', '""').replaceAll(/\r?\n/g, " ")}"`;
}

function toProductGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}

async function fetchShopifyProduct(productId: string): Promise<ShopifyProduct | null> {
  const data = await shopifyGraphQL<{ product: ShopifyProduct | null }>(
    `query Product($id: ID!) {
      product(id: $id) {
        id title status vendor productType
        options { id name values position }
        variants(first: 100) {
          nodes {
            id sku price
            selectedOptions { name value }
            inventoryItem { id tracked }
          }
        }
      }
    }`,
    { id: toProductGid(productId) },
  );
  return data.product;
}

async function loadAllMappings(): Promise<Mapping[]> {
  const sb = createServiceRoleClient();
  const out: Mapping[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("bandcamp_product_mappings")
      .select(
        "id, workspace_id, variant_id, bandcamp_item_id, bandcamp_options, bandcamp_option_skus, bandcamp_price, bandcamp_currency, authority_status",
      )
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const m of data) out.push(m as unknown as Mapping);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function loadAllVariantsBySku(): Promise<Map<string, { id: string; product_id: string; workspace_id: string }>> {
  const sb = createServiceRoleClient();
  const out = new Map<string, { id: string; product_id: string; workspace_id: string }>();
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select("id, product_id, workspace_id, sku")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const v of data as Array<{ id: string; product_id: string; workspace_id: string; sku: string }>) {
      const ns = normSku(v.sku);
      if (ns) out.set(ns, { id: v.id, product_id: v.product_id, workspace_id: v.workspace_id });
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function loadParentRows(
  variantIds: string[],
): Promise<
  Map<
    string,
    {
      variant_id: string;
      product_id: string;
      umbrella_sku: string;
      shopify_variant_id: string | null;
      shopify_inventory_item_id: string | null;
      product_title: string;
      shopify_product_id: string | null;
      vendor: string | null;
      org_id: string | null;
      product_type: string | null;
      umbrella_price: number | null;
    }
  >
> {
  const sb = createServiceRoleClient();
  const out = new Map<string, {
    variant_id: string;
    product_id: string;
    umbrella_sku: string;
    shopify_variant_id: string | null;
    shopify_inventory_item_id: string | null;
    product_title: string;
    shopify_product_id: string | null;
    vendor: string | null;
    org_id: string | null;
    product_type: string | null;
    umbrella_price: number | null;
  }>();
  for (let i = 0; i < variantIds.length; i += 200) {
    const slice = variantIds.slice(i, i + 200);
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select(
        "id, product_id, sku, shopify_variant_id, shopify_inventory_item_id, price, warehouse_products:product_id(id, title, shopify_product_id, vendor, org_id, product_type)",
      )
      .in("id", slice);
    if (error) throw error;
    for (const v of (data ?? []) as unknown as Array<{
      id: string;
      product_id: string;
      sku: string;
      shopify_variant_id: string | null;
      shopify_inventory_item_id: string | null;
      price: number | null;
      warehouse_products: {
        id: string;
        title: string;
        shopify_product_id: string | null;
        vendor: string | null;
        org_id: string | null;
        product_type: string | null;
      } | null;
    }>) {
      out.set(v.id, {
        variant_id: v.id,
        product_id: v.product_id,
        umbrella_sku: v.sku,
        shopify_variant_id: v.shopify_variant_id,
        shopify_inventory_item_id: v.shopify_inventory_item_id,
        product_title: v.warehouse_products?.title ?? "",
        shopify_product_id: v.warehouse_products?.shopify_product_id ?? null,
        vendor: v.warehouse_products?.vendor ?? null,
        org_id: v.warehouse_products?.org_id ?? null,
        product_type: v.warehouse_products?.product_type ?? null,
        umbrella_price: v.price,
      });
    }
  }
  return out;
}

type PlannedVariant = {
  workspace_id: string;
  org_id: string;
  bandcamp_item_id: number;
  bandcamp_option_id: number | null;
  bandcamp_option_title: string;
  product_id: string;
  product_title: string;
  shopify_product_id: string;
  shopify_product_status: string;
  current_options_layout: string;
  needs_option_restructure: boolean;
  planned_option_name: string;
  planned_option_value: string;
  sku: string;
  sku_normalized: string;
  price: string;
  bc_quantity_available: number | null;
  shopify_action: "create_variant" | "skip_already_exists" | "skip_blocked";
  db_action: "insert_variant" | "skip_already_exists" | "skip_blocked";
  block_reasons: string;
};

function inferOptionName(titles: string[]): string {
  const sizeLike = /^(2?xs|xx?s|s|m|l|xx?l|xxxl|small|medium|large|x-?large|xx?-?large|womens? .*|youth)/i;
  const sizes = titles.filter((t) => sizeLike.test(t.trim()));
  if (sizes.length >= titles.length / 2) return "Size";
  if (titles.some((t) => /color|colour/i.test(t))) return "Color";
  return "Variant";
}

async function main() {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const reportDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(reportDir, { recursive: true });

  console.log("[start] read-only plan: per-size variant backfill for apparel packages");

  const [mappings, variantBySku] = await Promise.all([
    loadAllMappings(),
    loadAllVariantsBySku(),
  ]);
  console.log(`[loaded] mappings=${mappings.length} db_variant_skus=${variantBySku.size}`);

  // Identify apparel packages: mapping with bandcamp_options containing >= 2 SKU'd options.
  const apparelMappings = mappings.filter((m) => {
    const opts = (m.bandcamp_options ?? []) as BcOption[];
    if (!Array.isArray(opts)) return false;
    const skuOpts = opts.filter((o) => (o?.sku ?? "").trim());
    return skuOpts.length >= 2;
  });
  console.log(`[scope] apparel-shaped mappings (>=2 option SKUs): ${apparelMappings.length}`);

  const parentRows = await loadParentRows(apparelMappings.map((m) => m.variant_id));
  console.log(`[loaded] parent rows resolved: ${parentRows.size}`);

  // Load Shopify products for each parent (one per affected mapping). Concurrency-limited.
  const uniqueShopifyIds = Array.from(
    new Set(
      apparelMappings
        .map((m) => parentRows.get(m.variant_id)?.shopify_product_id ?? "")
        .filter((id) => id),
    ),
  );
  console.log(`[shopify] fetching ${uniqueShopifyIds.length} parent product details …`);

  const shopifyById = new Map<string, ShopifyProduct | null>();
  const concurrency = 6;
  let done = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = done++;
        if (idx >= uniqueShopifyIds.length) return;
        const id = uniqueShopifyIds[idx];
        try {
          const p = await fetchShopifyProduct(id);
          shopifyById.set(id, p);
        } catch (err) {
          console.warn(
            `  shopify fetch failed for ${id}: ${err instanceof Error ? err.message : err}`,
          );
          shopifyById.set(id, null);
        }
        if (idx % 25 === 0) process.stdout.write(`  shopify fetched ${idx}\r`);
      }
    }),
  );
  process.stdout.write("\n");

  // Build planned operations.
  const planned: PlannedVariant[] = [];
  const risks: Array<{
    bandcamp_item_id: number;
    sku: string;
    risk: string;
    detail: string;
    workspace_id: string;
    product_id: string;
    shopify_product_id: string;
  }> = [];

  for (const m of apparelMappings) {
    const parent = parentRows.get(m.variant_id);
    if (!parent) {
      risks.push({
        bandcamp_item_id: m.bandcamp_item_id,
        sku: "",
        risk: "missing_parent_variant_row",
        detail: `mapping ${m.id} variant_id=${m.variant_id} not resolvable`,
        workspace_id: m.workspace_id,
        product_id: "",
        shopify_product_id: "",
      });
      continue;
    }
    if (!parent.shopify_product_id) {
      risks.push({
        bandcamp_item_id: m.bandcamp_item_id,
        sku: parent.umbrella_sku,
        risk: "parent_has_no_shopify_link",
        detail: `warehouse_product ${parent.product_id} has no shopify_product_id`,
        workspace_id: m.workspace_id,
        product_id: parent.product_id,
        shopify_product_id: "",
      });
      continue;
    }
    const shop = shopifyById.get(parent.shopify_product_id);
    if (!shop) {
      risks.push({
        bandcamp_item_id: m.bandcamp_item_id,
        sku: parent.umbrella_sku,
        risk: "shopify_product_not_found",
        detail: `Shopify lookup returned null for ${parent.shopify_product_id}`,
        workspace_id: m.workspace_id,
        product_id: parent.product_id,
        shopify_product_id: parent.shopify_product_id,
      });
      continue;
    }

    const opts = (m.bandcamp_options ?? []) as BcOption[];
    const skuOpts = opts.filter((o) => (o?.sku ?? "").trim());
    const titles = skuOpts.map((o) => (o.title ?? "").trim()).filter(Boolean);
    const inferredOptionName = inferOptionName(titles);

    const onlyDefaultOption =
      shop.options.length === 1 &&
      shop.options[0]?.name === "Title" &&
      shop.options[0]?.values?.length === 1 &&
      shop.options[0]?.values?.[0] === "Default Title";
    const matchesInferred = shop.options.some((o) => o.name.toLowerCase() === inferredOptionName.toLowerCase());

    const needsRestructure = onlyDefaultOption && !matchesInferred;
    const optionsLayout = shop.options
      .map((o) => `${o.name}=[${o.values.join("|")}]`)
      .join(" / ");

    // Build set of existing Shopify variant SKUs (normalized) so we can skip duplicates.
    const existingShopSkus = new Set<string>();
    for (const v of shop.variants.nodes) {
      const ns = normSku(v.sku);
      if (ns) existingShopSkus.add(ns);
    }

    // Per-package risk: existing umbrella variant has shopify_variant_id used in current orders.
    if (parent.shopify_variant_id) {
      risks.push({
        bandcamp_item_id: m.bandcamp_item_id,
        sku: parent.umbrella_sku,
        risk: "umbrella_variant_in_use",
        detail: `Existing umbrella shopify_variant_id=${parent.shopify_variant_id} may be referenced by past orders. Restructuring options may strand or rename it.`,
        workspace_id: m.workspace_id,
        product_id: parent.product_id,
        shopify_product_id: parent.shopify_product_id,
      });
    }

    for (const opt of skuOpts) {
      const sku = (opt.sku ?? "").trim();
      const ns = normSku(sku);
      const blockReasons: string[] = [];

      // Cross-product DB SKU collision check
      const existingDbVariant = variantBySku.get(ns);
      let dbAction: PlannedVariant["db_action"] = "insert_variant";
      if (existingDbVariant) {
        if (existingDbVariant.product_id === parent.product_id) {
          dbAction = "skip_already_exists";
        } else {
          dbAction = "skip_blocked";
          blockReasons.push(
            `db_sku_collision_with_other_product:${existingDbVariant.product_id.slice(0, 8)}`,
          );
          risks.push({
            bandcamp_item_id: m.bandcamp_item_id,
            sku,
            risk: "db_sku_collision_other_product",
            detail: `SKU ${sku} already attached to product ${existingDbVariant.product_id}, cannot reattach to ${parent.product_id}`,
            workspace_id: m.workspace_id,
            product_id: parent.product_id,
            shopify_product_id: parent.shopify_product_id,
          });
        }
      }

      let shopAction: PlannedVariant["shopify_action"] = "create_variant";
      if (existingShopSkus.has(ns)) {
        shopAction = "skip_already_exists";
      } else if (blockReasons.length > 0) {
        shopAction = "skip_blocked";
      }

      const plannedOptionValue = (opt.title ?? "").trim() || "Default";
      const price =
        m.bandcamp_price !== null && m.bandcamp_price !== undefined
          ? String(m.bandcamp_price)
          : (parent.umbrella_price !== null ? String(parent.umbrella_price) : "0.00");

      planned.push({
        workspace_id: m.workspace_id,
        org_id: parent.org_id ?? "",
        bandcamp_item_id: m.bandcamp_item_id,
        bandcamp_option_id: opt.option_id ?? null,
        bandcamp_option_title: plannedOptionValue,
        product_id: parent.product_id,
        product_title: parent.product_title,
        shopify_product_id: parent.shopify_product_id,
        shopify_product_status: shop.status,
        current_options_layout: optionsLayout,
        needs_option_restructure: needsRestructure,
        planned_option_name: inferredOptionName,
        planned_option_value: plannedOptionValue,
        sku,
        sku_normalized: ns,
        price,
        bc_quantity_available: opt.quantity_available ?? null,
        shopify_action: shopAction,
        db_action: dbAction,
        block_reasons: blockReasons.join(";"),
      });
    }
  }

  // Summary
  const summary = {
    timestamp: new Date().toISOString(),
    apparel_mappings: apparelMappings.length,
    parent_products_to_modify: new Set(planned.map((p) => p.product_id)).size,
    parents_needing_option_restructure: new Set(
      planned.filter((p) => p.needs_option_restructure).map((p) => p.product_id),
    ).size,
    planned_new_shopify_variants: planned.filter((p) => p.shopify_action === "create_variant").length,
    planned_new_db_variants: planned.filter((p) => p.db_action === "insert_variant").length,
    skipped_already_exists_shopify: planned.filter((p) => p.shopify_action === "skip_already_exists").length,
    skipped_already_exists_db: planned.filter((p) => p.db_action === "skip_already_exists").length,
    blocked_total: planned.filter((p) => p.shopify_action === "skip_blocked" || p.db_action === "skip_blocked").length,
    risks_total: risks.length,
    risk_buckets: risks.reduce(
      (a, r) => {
        a[r.risk] = (a[r.risk] ?? 0) + 1;
        return a;
      },
      {} as Record<string, number>,
    ),
    by_label: planned.reduce(
      (a, p) => {
        const key = p.product_title.split(" - ")[0] || p.product_title.slice(0, 30);
        a[key] = (a[key] ?? 0) + 1;
        return a;
      },
      {} as Record<string, number>,
    ),
  };

  console.log(JSON.stringify(summary, null, 2));

  // Write plan CSV
  const planHeader = [
    "workspace_id",
    "org_id",
    "bandcamp_item_id",
    "bandcamp_option_id",
    "bandcamp_option_title",
    "product_id",
    "product_title",
    "shopify_product_id",
    "shopify_product_status",
    "current_options_layout",
    "needs_option_restructure",
    "planned_option_name",
    "planned_option_value",
    "sku",
    "sku_normalized",
    "price",
    "bc_quantity_available",
    "shopify_action",
    "db_action",
    "block_reasons",
  ];
  const planLines = [planHeader.join(",")];
  for (const p of planned) {
    planLines.push(
      [
        csvCell(p.workspace_id),
        csvCell(p.org_id),
        csvCell(p.bandcamp_item_id),
        csvCell(p.bandcamp_option_id ?? ""),
        csvCell(p.bandcamp_option_title),
        csvCell(p.product_id),
        csvCell(p.product_title),
        csvCell(p.shopify_product_id),
        csvCell(p.shopify_product_status),
        csvCell(p.current_options_layout),
        csvCell(p.needs_option_restructure ? "yes" : "no"),
        csvCell(p.planned_option_name),
        csvCell(p.planned_option_value),
        csvCell(p.sku),
        csvCell(p.sku_normalized),
        csvCell(p.price),
        csvCell(p.bc_quantity_available ?? ""),
        csvCell(p.shopify_action),
        csvCell(p.db_action),
        csvCell(p.block_reasons),
      ].join(","),
    );
  }
  const planPath = join(reportDir, `apparel-variant-backfill-plan-${ts}.csv`);
  writeFileSync(planPath, `${planLines.join("\n")}\n`, "utf8");

  // Risks CSV
  const riskHeader = [
    "bandcamp_item_id",
    "sku",
    "risk",
    "detail",
    "workspace_id",
    "product_id",
    "shopify_product_id",
  ];
  const riskLines = [riskHeader.join(",")];
  for (const r of risks) {
    riskLines.push(
      [
        csvCell(r.bandcamp_item_id),
        csvCell(r.sku),
        csvCell(r.risk),
        csvCell(r.detail),
        csvCell(r.workspace_id),
        csvCell(r.product_id),
        csvCell(r.shopify_product_id),
      ].join(","),
    );
  }
  const riskPath = join(reportDir, `apparel-variant-backfill-risks-${ts}.csv`);
  writeFileSync(riskPath, `${riskLines.join("\n")}\n`, "utf8");

  // JSON plan for execute mode
  const jsonPath = join(reportDir, `apparel-variant-backfill-plan-${ts}.json`);
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ summary, planned, risks }, null, 2)}\n`,
    "utf8",
  );

  console.log(`[done] plan_csv=${planPath}`);
  console.log(`       risks_csv=${riskPath}`);
  console.log(`       plan_json=${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
