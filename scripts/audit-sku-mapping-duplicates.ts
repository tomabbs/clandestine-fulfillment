import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

type MappingRow = {
  id: string;
  connection_id: string;
  variant_id: string;
  remote_inventory_item_id: string | null;
  remote_variant_id: string | null;
  remote_sku: string | null;
  updated_at: string;
  created_at: string;
  is_active: boolean;
};

type VariantRow = {
  id: string;
  sku: string | null;
  workspace_id: string;
  product_id: string;
  warehouse_products: { org_id: string | null } | { org_id: string | null }[] | null;
};

function groupAndCount<T>(rows: T[], keyFn: (row: T) => string | null) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return Array.from(groups.entries())
    .filter(([, bucket]) => bucket.length > 1)
    .map(([key, bucket]) => ({ key, count: bucket.length, ids: bucket.map((row) => (row as { id: string }).id) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

async function main() {
  const supabase = createServiceRoleClient();

  const [{ data: mappings, error: mappingsError }, { data: variants, error: variantsError }] =
    await Promise.all([
      supabase
        .from("client_store_sku_mappings")
        .select(
          "id, connection_id, variant_id, remote_inventory_item_id, remote_variant_id, remote_sku, updated_at, created_at, is_active",
        )
        .eq("is_active", true),
      supabase
        .from("warehouse_product_variants")
        .select("id, sku, workspace_id, product_id, warehouse_products!inner(org_id)")
        .not("sku", "is", null),
    ]);

  if (mappingsError) throw new Error(`Failed to load mappings: ${mappingsError.message}`);
  if (variantsError) throw new Error(`Failed to load variants: ${variantsError.message}`);

  const canonicalDupes = groupAndCount(
    (mappings ?? []) as MappingRow[],
    (row) => `variant:${row.connection_id}:${row.variant_id}`,
  );
  const remoteInventoryDupes = groupAndCount(
    (mappings ?? []) as MappingRow[],
    (row) =>
      row.remote_inventory_item_id
        ? `inventory:${row.connection_id}:${row.remote_inventory_item_id}`
        : null,
  );
  const remoteVariantDupes = groupAndCount(
    (mappings ?? []) as MappingRow[],
    (row) => (row.remote_variant_id ? `remote-variant:${row.connection_id}:${row.remote_variant_id}` : null),
  );
  const canonicalSkuDupes = groupAndCount((variants ?? []) as VariantRow[], (row) => {
    const org = Array.isArray(row.warehouse_products) ? row.warehouse_products[0] : row.warehouse_products;
    const sku = row.sku?.trim().toUpperCase();
    return sku ? `sku:${row.workspace_id}:${org?.org_id ?? "null"}:${sku}` : null;
  });

  const summary = {
    connection_variant_duplicates: canonicalDupes.length,
    remote_inventory_item_duplicates: remoteInventoryDupes.length,
    remote_variant_duplicates: remoteVariantDupes.length,
    canonical_sku_duplicates: canonicalSkuDupes.length,
  };

  console.log(JSON.stringify({ summary, canonicalDupes: canonicalDupes.slice(0, 20), remoteInventoryDupes: remoteInventoryDupes.slice(0, 20), remoteVariantDupes: remoteVariantDupes.slice(0, 20), canonicalSkuDupes: canonicalSkuDupes.slice(0, 20) }, null, 2));
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
