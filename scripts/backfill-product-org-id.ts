/**
 * scripts/backfill-product-org-id.ts
 *
 * Backfills warehouse_products.org_id where it is NULL.
 *
 * Source priority per product (highest confidence first):
 *   1. Bandcamp connection — if any variant of the product has a
 *      bandcamp_product_mappings row whose bandcamp_member_band_id resolves
 *      to a bandcamp_connections.org_id.
 *   2. Exact case-insensitive match: warehouse_products.vendor
 *        == organizations.shopify_vendor_name
 *   3. Exact case-insensitive match: warehouse_products.vendor
 *        == organizations.name
 *   4. Normalized fuzzy match: lowercase + strip
 *      "records|recordings|label|tapes|the|and|&" + strip punctuation, then
 *      compare to org name / shopify_vendor_name.
 *   5. Multi-vendor split — vendor strings like "Foo|Bar", "Foo & Bar",
 *      "Foo / Bar" → resolve to FIRST half if it matches; flag as collab.
 *
 * Side effect when applying:
 *   - For every (vendor, org) pair we resolve via source 2/3/4, also set
 *     organizations.shopify_vendor_name = vendor (when currently NULL) so
 *     future shopify-sync runs auto-attach without going through this script.
 *
 * Usage:
 *   npx tsx scripts/backfill-product-org-id.ts                # dry-run (default)
 *   npx tsx scripts/backfill-product-org-id.ts --apply        # apply
 *   npx tsx scripts/backfill-product-org-id.ts --apply --create-orgs
 *
 * Output:
 *   reports/finish-line/org-backfill/org-backfill-plan-<ts>.csv
 *   reports/finish-line/org-backfill/org-backfill-unresolved-<ts>.csv
 *   reports/finish-line/org-backfill/org-backfill-summary-<ts>.json
 */

import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

type CliArgs = {
  apply: boolean;
  createOrgs: boolean;
};

function parseArgs(): CliArgs {
  return {
    apply: process.argv.includes("--apply"),
    createOrgs: process.argv.includes("--create-orgs"),
  };
}

const NORMALIZE_DROP = /\b(records|recordings|recording|label|tapes|the|and)\b/g;

function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(NORMALIZE_DROP, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitMultiVendor(vendor: string): string[] {
  const parts = vendor
    .split(/\s*[|/]\s*|\s+&\s+|\s+\+\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [];
}

type Resolution =
  | { kind: "bandcamp"; orgId: string; orgName: string; bandId: number; bandName: string }
  | { kind: "vendor_exact_shopify"; orgId: string; orgName: string }
  | { kind: "vendor_exact_name"; orgId: string; orgName: string }
  | { kind: "vendor_normalized"; orgId: string; orgName: string; normalizedFrom: string }
  | { kind: "vendor_split_first"; orgId: string; orgName: string; splitParts: string[] }
  | { kind: "auto_created"; orgId: string; orgName: string }
  | { kind: "unresolved"; reason: string };

async function main() {
  const args = parseArgs();
  const sb = createServiceRoleClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

  console.log(`[backfill-product-org-id] mode=${args.apply ? "APPLY" : "DRY-RUN"} create-orgs=${args.createOrgs}`);

  // ---------------------------------------------------------------------
  // 1. Load all NULL-org products (paginated)
  // ---------------------------------------------------------------------
  type ProductRow = {
    id: string;
    workspace_id: string;
    title: string;
    vendor: string | null;
    status: string | null;
    shopify_product_id: string | null;
  };
  const products: ProductRow[] = [];
  const PAGE = 1000;
  let from = 0;
  let last = PAGE;
  while (last === PAGE) {
    const { data, error } = await sb
      .from("warehouse_products")
      .select("id, workspace_id, title, vendor, status, shopify_product_id")
      .is("org_id", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`products query: ${error.message}`);
    const batch = (data ?? []) as ProductRow[];
    products.push(...batch);
    last = batch.length;
    from += PAGE;
  }
  console.log(`Loaded ${products.length} NULL-org products`);

  if (products.length === 0) {
    console.log("Nothing to do — no NULL-org products.");
    return;
  }

  // ---------------------------------------------------------------------
  // 2. Load orgs (key by name + shopify_vendor_name + normalized variants)
  // ---------------------------------------------------------------------
  const { data: orgs, error: orgErr } = await sb
    .from("organizations")
    .select("id, workspace_id, name, slug, shopify_vendor_name");
  if (orgErr) throw new Error(`orgs query: ${orgErr.message}`);

  const orgsByName = new Map<string, { id: string; name: string; workspaceId: string }>();
  const orgsByVendor = new Map<string, { id: string; name: string; workspaceId: string }>();
  const orgsByNormalized = new Map<string, { id: string; name: string; workspaceId: string }>();
  for (const o of orgs ?? []) {
    const v = { id: o.id, name: o.name, workspaceId: o.workspace_id };
    orgsByName.set(o.name.toLowerCase().trim(), v);
    if (o.shopify_vendor_name) {
      orgsByVendor.set(o.shopify_vendor_name.toLowerCase().trim(), v);
    }
    const norm = normalizeName(o.name);
    if (norm) orgsByNormalized.set(norm, v);
    const normVendor = normalizeName(o.shopify_vendor_name);
    if (normVendor) orgsByNormalized.set(normVendor, v);
  }
  console.log(`Loaded ${orgs?.length ?? 0} organizations (${orgsByVendor.size} have shopify_vendor_name)`);

  // ---------------------------------------------------------------------
  // 3. Load bandcamp mappings + connections for these products
  // ---------------------------------------------------------------------
  const productIds = products.map((p) => p.id);
  const variantIdToProductId = new Map<string, string>();
  const IN_CHUNK = 200;
  for (let i = 0; i < productIds.length; i += IN_CHUNK) {
    const chunk = productIds.slice(i, i + IN_CHUNK);
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select("id, product_id")
      .in("product_id", chunk);
    if (error) throw new Error(`variants query: ${error.message}`);
    for (const v of data ?? []) variantIdToProductId.set(v.id, v.product_id);
  }

  const productIdToBandId = new Map<string, number>();
  const variantIds = Array.from(variantIdToProductId.keys());
  for (let i = 0; i < variantIds.length; i += IN_CHUNK) {
    const chunk = variantIds.slice(i, i + IN_CHUNK);
    const { data, error } = await sb
      .from("bandcamp_product_mappings")
      .select("variant_id, bandcamp_member_band_id")
      .in("variant_id", chunk);
    if (error) throw new Error(`bandcamp mappings query: ${error.message}`);
    for (const m of data ?? []) {
      if (!m.bandcamp_member_band_id) continue;
      const pid = variantIdToProductId.get(m.variant_id);
      if (pid && !productIdToBandId.has(pid)) {
        productIdToBandId.set(pid, m.bandcamp_member_band_id);
      }
    }
  }

  const bandIdToConnection = new Map<number, { orgId: string; bandName: string }>();
  const bandIds = Array.from(new Set(productIdToBandId.values()));
  if (bandIds.length > 0) {
    const { data, error } = await sb
      .from("bandcamp_connections")
      .select("band_id, band_name, org_id")
      .in("band_id", bandIds);
    if (error) throw new Error(`bandcamp connections query: ${error.message}`);
    for (const c of data ?? []) {
      bandIdToConnection.set(c.band_id, { orgId: c.org_id, bandName: c.band_name ?? "" });
    }
  }
  console.log(`Bandcamp resolution: ${productIdToBandId.size} products linked, ${bandIdToConnection.size} bands`);

  // ---------------------------------------------------------------------
  // 4. Resolve each product
  // ---------------------------------------------------------------------
  const resolutions = new Map<string, Resolution>();
  // Track new orgs we'll create (vendor-name keyed) so we don't dupe within one run.
  const pendingNewOrgs = new Map<
    string,
    { vendorName: string; workspaceId: string; productIds: string[] }
  >();
  // Track vendor → org_id mappings we should write back to organizations.shopify_vendor_name
  const orgVendorBackfill = new Map<string, { vendor: string; orgId: string; orgName: string }>();

  for (const p of products) {
    // Source 1: bandcamp connection
    const bandId = productIdToBandId.get(p.id);
    if (bandId != null) {
      const conn = bandIdToConnection.get(bandId);
      if (conn) {
        const orgName = orgsByName.size > 0 ? findOrgNameById(orgs ?? [], conn.orgId) : "";
        resolutions.set(p.id, {
          kind: "bandcamp",
          orgId: conn.orgId,
          orgName,
          bandId,
          bandName: conn.bandName,
        });
        continue;
      }
    }

    const vendor = (p.vendor ?? "").trim();
    if (!vendor) {
      resolutions.set(p.id, { kind: "unresolved", reason: "no_vendor_no_bandcamp" });
      continue;
    }

    // Source 2: exact match on shopify_vendor_name
    const vLower = vendor.toLowerCase();
    const exactShopify = orgsByVendor.get(vLower);
    if (exactShopify) {
      resolutions.set(p.id, {
        kind: "vendor_exact_shopify",
        orgId: exactShopify.id,
        orgName: exactShopify.name,
      });
      continue;
    }

    // Source 3: exact match on org name
    const exactName = orgsByName.get(vLower);
    if (exactName) {
      resolutions.set(p.id, {
        kind: "vendor_exact_name",
        orgId: exactName.id,
        orgName: exactName.name,
      });
      orgVendorBackfill.set(exactName.id, {
        vendor,
        orgId: exactName.id,
        orgName: exactName.name,
      });
      continue;
    }

    // Source 4: normalized fuzzy match
    const norm = normalizeName(vendor);
    if (norm && orgsByNormalized.has(norm)) {
      const o = orgsByNormalized.get(norm)!;
      resolutions.set(p.id, {
        kind: "vendor_normalized",
        orgId: o.id,
        orgName: o.name,
        normalizedFrom: vendor,
      });
      orgVendorBackfill.set(o.id, { vendor, orgId: o.id, orgName: o.name });
      continue;
    }

    // Source 5: multi-vendor split — try each part
    const parts = splitMultiVendor(vendor);
    if (parts.length > 0) {
      let matched: { id: string; name: string } | null = null;
      for (const part of parts) {
        const partLower = part.toLowerCase();
        if (orgsByVendor.has(partLower)) {
          matched = orgsByVendor.get(partLower)!;
          break;
        }
        if (orgsByName.has(partLower)) {
          matched = orgsByName.get(partLower)!;
          break;
        }
        const partNorm = normalizeName(part);
        if (partNorm && orgsByNormalized.has(partNorm)) {
          matched = orgsByNormalized.get(partNorm)!;
          break;
        }
      }
      if (matched) {
        resolutions.set(p.id, {
          kind: "vendor_split_first",
          orgId: matched.id,
          orgName: matched.name,
          splitParts: parts,
        });
        continue;
      }
    }

    // Source 6: auto-create
    if (args.createOrgs) {
      const key = vendor.toLowerCase();
      const existing = pendingNewOrgs.get(key);
      if (existing) {
        existing.productIds.push(p.id);
      } else {
        pendingNewOrgs.set(key, {
          vendorName: vendor,
          workspaceId: p.workspace_id,
          productIds: [p.id],
        });
      }
      // Mark as unresolved-but-pending; will assign orgId after creation
      resolutions.set(p.id, { kind: "unresolved", reason: "pending_auto_create" });
      continue;
    }

    resolutions.set(p.id, { kind: "unresolved", reason: `no_match:${vendor}` });
  }

  // ---------------------------------------------------------------------
  // 5. Apply phase
  // ---------------------------------------------------------------------
  const summary: Record<string, number> = {
    total: products.length,
    bandcamp: 0,
    vendor_exact_shopify: 0,
    vendor_exact_name: 0,
    vendor_normalized: 0,
    vendor_split_first: 0,
    auto_created: 0,
    unresolved: 0,
  };

  const createdOrgs: Array<{ vendor: string; orgId: string; orgName: string; products: number }> = [];

  if (args.apply && pendingNewOrgs.size > 0) {
    console.log(`Creating ${pendingNewOrgs.size} new organizations for unmatched vendors...`);
    for (const { vendorName, workspaceId, productIds: pids } of pendingNewOrgs.values()) {
      const slug = vendorName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      const { data, error } = await sb
        .from("organizations")
        .insert({
          workspace_id: workspaceId,
          name: vendorName,
          slug,
          shopify_vendor_name: vendorName,
        })
        .select("id, name")
        .single();
      if (error) {
        console.error(`  failed to create org "${vendorName}":`, error.message);
        continue;
      }
      createdOrgs.push({
        vendor: vendorName,
        orgId: data.id,
        orgName: data.name,
        products: pids.length,
      });
      for (const pid of pids) {
        resolutions.set(pid, {
          kind: "auto_created",
          orgId: data.id,
          orgName: data.name,
        });
      }
    }
  }

  // Compute summary counts and gather updates
  const productUpdates: Array<{ productId: string; orgId: string; via: string }> = [];
  for (const [pid, r] of resolutions.entries()) {
    summary[r.kind] = (summary[r.kind] ?? 0) + 1;
    if (r.kind !== "unresolved") {
      productUpdates.push({ productId: pid, orgId: r.orgId, via: r.kind });
    }
  }

  // Apply: update warehouse_products.org_id in batches
  if (args.apply && productUpdates.length > 0) {
    console.log(`Applying org_id to ${productUpdates.length} products...`);
    // Group by org_id so we can do a single .in() update per org
    const byOrg = new Map<string, string[]>();
    for (const u of productUpdates) {
      const list = byOrg.get(u.orgId) ?? [];
      list.push(u.productId);
      byOrg.set(u.orgId, list);
    }
    let applied = 0;
    for (const [orgId, pids] of byOrg.entries()) {
      for (let i = 0; i < pids.length; i += IN_CHUNK) {
        const chunk = pids.slice(i, i + IN_CHUNK);
        const { error } = await sb
          .from("warehouse_products")
          .update({ org_id: orgId })
          .in("id", chunk);
        if (error) {
          console.error(`  update failed for org=${orgId} chunk:`, error.message);
        } else {
          applied += chunk.length;
        }
      }
    }
    console.log(`  applied org_id update on ${applied}/${productUpdates.length} products`);

    // Backfill organizations.shopify_vendor_name for orgs we resolved-by-name
    if (orgVendorBackfill.size > 0) {
      console.log(`Setting organizations.shopify_vendor_name on ${orgVendorBackfill.size} orgs (idempotent — only when NULL)...`);
      for (const { vendor, orgId } of orgVendorBackfill.values()) {
        // Only set when currently NULL — never clobber a manually curated value.
        const { data: cur } = await sb
          .from("organizations")
          .select("shopify_vendor_name")
          .eq("id", orgId)
          .maybeSingle();
        if (cur && cur.shopify_vendor_name == null) {
          const { error } = await sb
            .from("organizations")
            .update({ shopify_vendor_name: vendor })
            .eq("id", orgId)
            .is("shopify_vendor_name", null);
          if (error) console.error(`  vendor backfill failed for org=${orgId}:`, error.message);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // 6. Reports
  // ---------------------------------------------------------------------
  const outDir = join(process.cwd(), "reports", "finish-line", "org-backfill");
  mkdirSync(outDir, { recursive: true });

  const cell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const planHeader = ["product_id", "vendor", "status", "title", "resolution", "org_id", "org_name", "extra"].join(",");
  const planLines = [planHeader];
  const unresolvedHeader = ["product_id", "vendor", "title", "reason"].join(",");
  const unresolvedLines = [unresolvedHeader];

  for (const p of products) {
    const r = resolutions.get(p.id)!;
    if (r.kind === "unresolved") {
      unresolvedLines.push([cell(p.id), cell(p.vendor), cell(p.title), cell(r.reason)].join(","));
      planLines.push([cell(p.id), cell(p.vendor), cell(p.status), cell(p.title), cell("unresolved"), cell(""), cell(""), cell(r.reason)].join(","));
    } else {
      const extra =
        r.kind === "bandcamp"
          ? `band_id=${r.bandId};band_name=${r.bandName}`
          : r.kind === "vendor_normalized"
            ? `normalized_from=${r.normalizedFrom}`
            : r.kind === "vendor_split_first"
              ? `split=${r.splitParts.join("|")}`
              : "";
      planLines.push(
        [
          cell(p.id),
          cell(p.vendor),
          cell(p.status),
          cell(p.title),
          cell(r.kind),
          cell(r.orgId),
          cell(r.orgName),
          cell(extra),
        ].join(","),
      );
    }
  }

  const planPath = join(outDir, `org-backfill-plan-${stamp}.csv`);
  const unresolvedPath = join(outDir, `org-backfill-unresolved-${stamp}.csv`);
  const summaryPath = join(outDir, `org-backfill-summary-${stamp}.json`);
  writeFileSync(planPath, planLines.join("\n") + "\n");
  writeFileSync(unresolvedPath, unresolvedLines.join("\n") + "\n");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      { mode: args.apply ? "apply" : "dry-run", summary, createdOrgs, totalUpdates: productUpdates.length },
      null,
      2,
    ),
  );

  console.log("");
  console.log("--- Resolution summary ---");
  for (const [k, n] of Object.entries(summary)) {
    console.log(`  ${k.padEnd(24)} ${String(n).padStart(5)}`);
  }
  if (createdOrgs.length > 0) {
    console.log("");
    console.log("--- Auto-created orgs ---");
    for (const c of createdOrgs) {
      console.log(`  ${c.orgName.padEnd(40)} (${c.products} products)`);
    }
  }
  console.log("");
  console.log(`Plan       : ${planPath}`);
  console.log(`Unresolved : ${unresolvedPath}`);
  console.log(`Summary    : ${summaryPath}`);
  if (!args.apply) {
    console.log("");
    console.log("DRY RUN — no DB changes. Re-run with --apply to write.");
  }
}

function findOrgNameById(orgs: Array<{ id: string; name: string }>, id: string): string {
  return orgs.find((o) => o.id === id)?.name ?? "";
}

main().catch((err) => {
  console.error("[backfill-product-org-id] FAILED:", err);
  process.exit(1);
});
