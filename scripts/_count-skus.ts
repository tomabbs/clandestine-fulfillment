import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();

  console.log("\n=== Variant counts ===");

  const { count: totalVariants } = await sb
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true });
  console.log(`total variants in table:                ${totalVariants}`);

  const { count: nullWs } = await sb
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true })
    .is("workspace_id", null);
  console.log(`variants with workspace_id IS NULL:     ${nullWs}`);

  // Per-workspace counts
  const { data: workspaces } = await sb.from("workspaces").select("id, name");
  for (const ws of workspaces ?? []) {
    const { count } = await sb
      .from("warehouse_product_variants")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", ws.id);
    console.log(`workspace ${ws.id} (${ws.name}): ${count}`);
  }

  // Org_id breakdown for the Clandestine workspace
  const cdWs = workspaces?.find((w) => w.name === "Clandestine Distribution");
  if (cdWs) {
    const { count: orgScoped } = await sb
      .from("warehouse_product_variants")
      .select("id, warehouse_products!inner(org_id)", { count: "exact", head: true })
      .eq("workspace_id", cdWs.id)
      .not("warehouse_products.org_id", "is", null);
    console.log(`  └─ org_id IS NOT NULL (fulfillment client): ${orgScoped}`);

    const { count: distroOnly } = await sb
      .from("warehouse_product_variants")
      .select("id, warehouse_products!inner(org_id)", { count: "exact", head: true })
      .eq("workspace_id", cdWs.id)
      .is("warehouse_products.org_id", null);
    console.log(`  └─ org_id IS NULL (distro / unowned):       ${distroOnly}`);
  }

  console.log("\n=== Distinct SKU counts (page-walked) ===");
  const skuSet = new Set<string>();
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
      if (r.sku) skuSet.add(r.sku as string);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`distinct SKUs across all variants:      ${skuSet.size}`);

  console.log("\n=== Products vs variants ===");
  const { count: prodCount } = await sb
    .from("warehouse_products")
    .select("id", { count: "exact", head: true });
  console.log(`total warehouse_products rows:          ${prodCount}`);

  const { count: prodOrgScoped } = await sb
    .from("warehouse_products")
    .select("id", { count: "exact", head: true })
    .not("org_id", "is", null);
  console.log(`  └─ with org_id (fulfillment client):  ${prodOrgScoped}`);

  const { count: prodDistro } = await sb
    .from("warehouse_products")
    .select("id", { count: "exact", head: true })
    .is("org_id", null);
  console.log(`  └─ with org_id NULL (distro):         ${prodDistro}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
