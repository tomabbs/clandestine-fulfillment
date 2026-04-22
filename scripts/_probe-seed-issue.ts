import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();
  const ws = "1e59b9ca-ab4e-442b-952b-a649e2aadb0e";

  const { count: variantCount, error: vcErr } = await sb
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", ws);
  console.log("variant count (workspace):", variantCount, "err:", vcErr?.message);

  const { count: orgVariantCount, error: ovcErr } = await sb
    .from("warehouse_product_variants")
    .select("id, warehouse_products!inner(org_id)", { count: "exact", head: true })
    .eq("workspace_id", ws)
    .not("warehouse_products.org_id", "is", null);
  console.log("variant count (org-scoped):", orgVariantCount, "err:", ovcErr?.message);

  const { data: probe, error: probeErr } = await sb
    .from("bundle_components")
    .select("bundle_variant_id, component_variant_id")
    .limit(2);
  console.log("bundle_components probe:", probe, "err:", probeErr?.message);

  // Try a small `.in()` with 2 random variant ids to see if PostgREST handles it
  const { data: vids } = await sb
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", ws)
    .limit(2);
  if (vids?.length) {
    const { data: bc, error: bcErr } = await sb
      .from("bundle_components")
      .select("bundle_variant_id")
      .in("bundle_variant_id", vids.map((v) => v.id));
    console.log("bundle_components small .in() probe:", bc, "err:", bcErr?.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
