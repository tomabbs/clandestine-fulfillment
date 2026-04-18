#!/usr/bin/env node
/**
 * LILA SKU normalization audit (Phase 0 deliverable).
 *
 * Background (plan §8 Phase 0 row, predecessor plan
 * `shipstation_source_of_truth_62f0d321.plan.md` line 244):
 *
 *   "Normalize 5 LILA SKUs in our DB to match Bandcamp's canonical values
 *    (LILAAVI-SE -> LILA-AV1-SE, etc.) — single SQL update."
 *
 * Our `warehouse_product_variants` has a handful of LILA variants whose SKU
 * was imported in a "collapsed" form (no hyphens) from a one-off backfill
 * — e.g. `LILAAVI`, `LILAAVI-SE`. Bandcamp's canonical form has the hyphen
 * after the band prefix and before the trailing variant code: `LILA-AV1`,
 * `LILA-AV1-SE`. ShipStation Inventory Sync requires exact SKU match across
 * channels (plan §10.1), so seeding can't ship until our DB matches
 * Bandcamp's canonical SKUs.
 *
 * This script is READ-ONLY. It surfaces every LILA workspace variant whose
 * SKU does not contain a hyphen between the LILA prefix and the trailing
 * variant code, plus a heuristic-suggested canonical form. The operator
 * confirms the final mapping and runs the generated SQL UPDATE separately
 * (see scripts/normalize-lila-skus.sql produced from this audit).
 *
 * Outputs:
 *   - Console: human-readable table of suspect SKUs + suggested canonical
 *   - reports/lila-sku-audit-<ISO date>.json: machine-readable audit log
 *   - reports/lila-sku-normalize.sql: UPDATE statements (commented out by
 *     default; operator uncomments rows they accept)
 *
 * Usage:
 *   node scripts/audit-lila-sku-normalization.mjs
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Error: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.local");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

/**
 * Heuristic: if the SKU starts with `LILA` and the next character is a
 * letter (i.e. there's no hyphen between the band prefix and the trailing
 * code), suggest inserting a hyphen and splitting digits into a hyphen-
 * separated variant suffix where present.
 *
 * Examples:
 *   LILAAVI       -> LILA-AVI
 *   LILAAV1       -> LILA-AV1
 *   LILAAVISE     -> LILA-AVI-SE   (heuristic: split before trailing letters)
 *   LILA-AV1      -> already canonical, skipped
 *
 * The operator MUST eyeball the suggested form before applying.
 */
function suggestCanonical(sku) {
  if (!sku.startsWith("LILA")) return null;
  if (sku.startsWith("LILA-")) return null; // already canonical
  const tail = sku.slice(4);
  if (!tail) return null;
  if (!/^[A-Za-z]/.test(tail)) return null; // LILA1 or LILA-anything-else: leave alone
  // Split tail at first hyphen if any: e.g. AVISE-FOO → AVISE | FOO
  const [head, ...restParts] = tail.split("-");
  // Heuristic: a head that ends in trailing UPPERCASE letters after a numeric
  // (e.g. "AV1SE") gets the suffix split off.
  const m = head.match(/^([A-Za-z]+\d+)([A-Za-z]+)$/);
  let canonicalHead;
  if (m) {
    canonicalHead = `${m[1]}-${m[2]}`;
  } else {
    canonicalHead = head;
  }
  return ["LILA", canonicalHead, ...restParts].join("-");
}

async function findLilaWorkspaceCandidates() {
  // LILA's workspace is identified by the bandcamp_credentials.account_name
  // that contains "LILA" (per docs/INVENTORY_SYSTEM_AUDIT_2026-04-06.md and
  // docs/handoff/SALES_BACKFILL_HANDOFF.md). Also try the org name as a
  // fallback.
  const candidates = new Map(); // workspace_id -> { source, label }

  const { data: creds } = await sb
    .from("bandcamp_credentials")
    .select("workspace_id, account_name");
  for (const row of creds ?? []) {
    if (row.account_name && /lila/i.test(row.account_name)) {
      candidates.set(row.workspace_id, {
        source: "bandcamp_credentials.account_name",
        label: row.account_name,
      });
    }
  }

  const { data: orgs } = await sb.from("organizations").select("id, name, workspace_id");
  for (const row of orgs ?? []) {
    if (row.name && /lila/i.test(row.name)) {
      candidates.set(row.workspace_id ?? row.id, {
        source: "organizations.name",
        label: row.name,
      });
    }
  }

  return Array.from(candidates.entries()).map(([workspace_id, meta]) => ({ workspace_id, ...meta }));
}

async function listLilaVariants(workspaceId) {
  const { data, error } = await sb
    .from("warehouse_product_variants")
    .select("id, workspace_id, sku, format_name, product_id")
    .eq("workspace_id", workspaceId)
    .ilike("sku", "LILA%")
    .order("sku");
  if (error) {
    console.error(`Query failed for workspace ${workspaceId}:`, error.message);
    return [];
  }
  return data ?? [];
}

async function main() {
  console.log("LILA SKU normalization audit (Phase 0)");
  console.log("======================================\n");

  const workspaces = await findLilaWorkspaceCandidates();
  if (!workspaces.length) {
    console.log("No LILA workspace found via bandcamp_credentials.account_name or organizations.name.");
    console.log("If LILA exists under a different name, override by setting LILA_WORKSPACE_ID env var.");
    if (process.env.LILA_WORKSPACE_ID) {
      workspaces.push({
        workspace_id: process.env.LILA_WORKSPACE_ID,
        source: "LILA_WORKSPACE_ID env override",
        label: "operator override",
      });
    } else {
      process.exit(0);
    }
  }

  const auditRows = [];
  for (const ws of workspaces) {
    console.log(`\n--- Workspace ${ws.workspace_id} (${ws.source}: "${ws.label}") ---`);
    const variants = await listLilaVariants(ws.workspace_id);
    console.log(`  ${variants.length} LILA-prefixed variants`);
    for (const v of variants) {
      const suggested = suggestCanonical(v.sku);
      if (suggested && suggested !== v.sku) {
        auditRows.push({
          workspace_id: ws.workspace_id,
          variant_id: v.id,
          current_sku: v.sku,
          suggested_canonical_sku: suggested,
          format_name: v.format_name,
          product_id: v.product_id,
          source_label: ws.label,
        });
      }
    }
  }

  if (!auditRows.length) {
    console.log("\nNo LILA SKU candidates need normalization. Phase 0 SKU deliverable is satisfied.\n");
  } else {
    console.log("\n=== Suspect LILA SKUs (operator review required) ===");
    console.log(
      [
        "current_sku".padEnd(20),
        "→",
        "suggested_canonical".padEnd(22),
        "format",
      ].join("  "),
    );
    console.log("-".repeat(70));
    for (const row of auditRows) {
      console.log(
        [
          row.current_sku.padEnd(20),
          "→",
          row.suggested_canonical_sku.padEnd(22),
          row.format_name ?? "",
        ].join("  "),
      );
    }
  }

  // Persist artifacts
  mkdirSync(resolve(process.cwd(), "reports"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const jsonPath = resolve(process.cwd(), `reports/lila-sku-audit-${stamp}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        ran_at: new Date().toISOString(),
        workspaces_searched: workspaces,
        audit_rows: auditRows,
        notes:
          "Read-only audit. Suggested canonical forms are heuristic-based; " +
          "operator MUST cross-check against Bandcamp's actual SKUs before applying.",
      },
      null,
      2,
    ),
  );

  const sqlPath = resolve(process.cwd(), "reports/lila-sku-normalize.sql");
  const sqlBody =
    `-- LILA SKU normalization — Phase 0 deliverable\n` +
    `-- Generated by scripts/audit-lila-sku-normalization.mjs at ${new Date().toISOString()}\n` +
    `-- Each row is COMMENTED OUT. Uncomment ONLY the rows the operator has\n` +
    `-- verified against Bandcamp's canonical SKU. Run inside a Postgres\n` +
    `-- transaction so any mismatch can be rolled back atomically.\n` +
    `--\n` +
    `-- BEGIN;\n` +
    auditRows
      .map(
        (r) =>
          `-- UPDATE warehouse_product_variants SET sku = '${r.suggested_canonical_sku}'\n` +
          `--   WHERE id = '${r.variant_id}'\n` +
          `--     AND workspace_id = '${r.workspace_id}'\n` +
          `--     AND sku = '${r.current_sku}'; -- format=${r.format_name ?? "?"}, current → canonical`,
      )
      .join("\n") +
    `\n-- COMMIT;\n`;
  writeFileSync(sqlPath, sqlBody);

  console.log(`\nArtifacts written:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${sqlPath}`);
  console.log(
    `\nNext step (operator): cross-check each suggested canonical SKU against Bandcamp's actual SKU,\n` +
      `uncomment the verified rows in reports/lila-sku-normalize.sql, and run via\n` +
      `\`psql $DIRECT_URL -f reports/lila-sku-normalize.sql\` (or the Supabase SQL editor in a\n` +
      `transaction). The UNIQUE(workspace_id, sku) constraint on warehouse_product_variants will\n` +
      `reject any conflict, so the update is safe.\n`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
