import { config } from "dotenv";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
config({ path: ".env.local" });

(async () => {
  const sb = createServiceRoleClient();

  const { data: ws } = await sb.from("workspaces").select("id, name, slug").limit(20);
  console.log("workspaces:", ws);

  const { data: orgs } = await sb
    .from("organizations")
    .select("id, name, slug")
    .limit(120)
    .order("name");
  console.log("\norgs:");
  for (const o of orgs ?? []) console.log(`  ${o.id}  ${o.name}  (${o.slug ?? ""})`);

  const { data: vendors } = await sb
    .from("warehouse_products")
    .select("vendor, org_id")
    .limit(20000);
  const v = new Map<string, { count: number; org_ids: Set<string> }>();
  for (const row of vendors ?? []) {
    const k = (row.vendor ?? "(null)").trim();
    const cur = v.get(k);
    if (cur) {
      cur.count++;
      if (row.org_id) cur.org_ids.add(row.org_id);
    } else {
      v.set(k, { count: 1, org_ids: new Set(row.org_id ? [row.org_id] : []) });
    }
  }
  const sorted = [...v.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`\nvendors in warehouse_products (${sorted.length} distinct, top 80):`);
  for (const [k, val] of sorted.slice(0, 80)) {
    console.log(
      `  ${val.count.toString().padStart(5)}  vendor="${k}"  org_count=${val.org_ids.size}  ${val.org_ids.size === 1 ? `org=${[...val.org_ids][0]}` : ""}`,
    );
  }

  const { count: total } = await sb
    .from("warehouse_product_variants")
    .select("*", { count: "exact", head: true });
  const { count: noFmt } = await sb
    .from("warehouse_product_variants")
    .select("*", { count: "exact", head: true })
    .is("format_name", null);
  const { count: emptyFmt } = await sb
    .from("warehouse_product_variants")
    .select("*", { count: "exact", head: true })
    .eq("format_name", "");
  console.log(`\nvariants total=${total} format_null=${noFmt} format_empty=${emptyFmt}`);

  const { data: fmts } = await sb
    .from("warehouse_product_variants")
    .select("format_name")
    .limit(20000);
  const fmap = new Map<string, number>();
  for (const r of fmts ?? []) {
    const k = r.format_name ?? "(null)";
    fmap.set(k, (fmap.get(k) ?? 0) + 1);
  }
  console.log("\nformat_name distribution:");
  for (const [k, c] of [...fmap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.toString().padStart(5)}  "${k}"`);
  }

  const { data: distroOnly } = await sb
    .from("warehouse_products")
    .select("id, vendor, org_id, status, shopify_product_id, title")
    .is("shopify_product_id", null)
    .limit(20);
  console.log("\nsample products without shopify_product_id (could be 'distro only' candidates):");
  for (const r of distroOnly ?? []) {
    console.log(`  ${r.id}  vendor="${r.vendor}" status=${r.status} title="${r.title}"`);
  }

  const { data: orgVendors } = await sb
    .from("organizations")
    .select("id, name, slug, settings")
    .ilike("name", "%egghunt%");
  console.log("\norgs matching 'egghunt':", orgVendors);
  const { data: bw } = await sb
    .from("organizations")
    .select("id, name, slug")
    .or("name.ilike.%birdwatcher%,slug.ilike.%birdwatcher%");
  console.log("orgs matching 'birdwatcher':", bw);
  const { data: nna } = await sb
    .from("organizations")
    .select("id, name, slug")
    .or("name.ilike.%NNA%,slug.ilike.%nna%");
  console.log("orgs matching 'NNA':", nna);
})();
