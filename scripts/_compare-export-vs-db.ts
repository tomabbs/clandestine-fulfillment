import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "node:fs";

import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const skuFile = readFileSync("/tmp/export-skus.txt", "utf8");
  const exportSkus = new Set(skuFile.split("\n").map((s) => s.trim()).filter(Boolean));
  console.log(`export distinct SKUs: ${exportSkus.size}`);

  const sb = createServiceRoleClient();

  const variantSkus = new Set<string>();
  const productSkus = new Set<string>();

  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select("sku")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.sku) variantSkus.add(r.sku as string);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`variant distinct SKUs in DB: ${variantSkus.size}`);

  // Check if warehouse_products has a SKU column
  const { data: probe, error: probeErr } = await sb
    .from("warehouse_products")
    .select("*")
    .limit(1);
  if (probeErr) {
    console.log(`warehouse_products probe err: ${probeErr.message}`);
  } else if (probe && probe[0]) {
    console.log(`warehouse_products columns: ${Object.keys(probe[0]).join(", ")}`);
    if ("sku" in probe[0]) {
      let pfrom = 0;
      for (;;) {
        const { data, error } = await sb
          .from("warehouse_products")
          .select("sku")
          .order("id", { ascending: true })
          .range(pfrom, pfrom + PAGE - 1);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const r of data) {
          if ((r as { sku?: string }).sku) productSkus.add((r as { sku: string }).sku);
        }
        if (data.length < PAGE) break;
        pfrom += PAGE;
      }
      console.log(`product distinct SKUs in DB: ${productSkus.size}`);
    }
  }

  // Set math
  const inExportNotInVariants = [...exportSkus].filter((s) => !variantSkus.has(s));
  const inVariantsNotInExport = [...variantSkus].filter((s) => !exportSkus.has(s));
  console.log(`\nin export but NOT in variants: ${inExportNotInVariants.length}`);
  console.log(`in variants but NOT in export: ${inVariantsNotInExport.length}`);

  console.log(`\nfirst 10 SKUs in export but NOT in variants:`);
  for (const s of inExportNotInVariants.slice(0, 10)) console.log(`  ${s}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
