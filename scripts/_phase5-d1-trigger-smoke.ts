#!/usr/bin/env tsx
/**
 * Phase 5 §9.6 D1 — live smoke test for the inventory_commitments
 * trigger lockstep.
 *
 * Verifies on the LIVE Supabase project that:
 *   1. INSERT open row → committed_quantity += qty (single SQL txn).
 *   2. Second INSERT for same (workspace_id, source, source_id, sku)
 *      hits the unique partial index → no double-count, no error.
 *   3. UPDATE released_at = now() → committed_quantity -= qty.
 *   4. Re-INSERT after release → counter increments again (released
 *      row no longer participates in the unique index).
 *   5. Trying to UPDATE qty on an open row raises (trigger guard).
 *   6. Trying to un-release a row raises (trigger guard).
 *
 * Picks one real (workspace, sku) pair to exercise — does NOT touch
 * any other rows. Cleans up after itself.
 *
 * Usage:
 *   tsx scripts/_phase5-d1-trigger-smoke.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SOURCE_ID = `phase5-smoke-${Date.now()}`;

interface Pass { name: string; ok: boolean; detail?: string }
const results: Pass[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function fetchCommitted(workspaceId: string, sku: string): Promise<number> {
  const { data, error } = await supabase
    .from("warehouse_inventory_levels")
    .select("committed_quantity, warehouse_product_variants!inner(workspace_id, sku)")
    .eq("warehouse_product_variants.workspace_id", workspaceId)
    .eq("warehouse_product_variants.sku", sku)
    .maybeSingle();
  if (error) throw new Error(`fetchCommitted: ${error.message}`);
  return Number(data?.committed_quantity ?? 0);
}

async function main() {
  const { data: variants, error: vErr } = await supabase
    .from("warehouse_product_variants")
    .select("workspace_id, sku, warehouse_inventory_levels!inner(committed_quantity, available)")
    .gt("warehouse_inventory_levels.available", 0)
    .limit(1);
  if (vErr || !variants || variants.length === 0) {
    console.error("Could not find a variant with a non-empty inventory level to use");
    process.exit(2);
  }
  const target = variants[0];
  const workspaceId = target.workspace_id as string;
  const sku = target.sku as string;
  console.log(`Target (workspace=${workspaceId}, sku=${sku})`);
  console.log(`source_id=${SOURCE_ID}\n`);

  const baseline = await fetchCommitted(workspaceId, sku);
  console.log(`baseline committed_quantity=${baseline}\n`);

  const { data: ins1, error: insErr } = await supabase
    .from("inventory_commitments")
    .insert({
      workspace_id: workspaceId,
      sku,
      source: "manual",
      source_id: SOURCE_ID,
      qty: 3,
      metadata: { smoke: true },
    })
    .select("id")
    .single();
  if (insErr) {
    record("insert open row", false, insErr.message);
    return;
  }
  const rowId = ins1.id as string;
  let after = await fetchCommitted(workspaceId, sku);
  record(
    "insert open row → committed_quantity += qty",
    after === baseline + 3,
    `expected ${baseline + 3}, got ${after}`,
  );

  const { error: dupErr } = await supabase.from("inventory_commitments").insert({
    workspace_id: workspaceId,
    sku,
    source: "manual",
    source_id: SOURCE_ID,
    qty: 7,
    metadata: { duplicate: true },
  });
  after = await fetchCommitted(workspaceId, sku);
  record(
    "duplicate insert blocked by unique partial index",
    Boolean(dupErr) && after === baseline + 3,
    `error=${dupErr?.code ?? "none"}, committed=${after}`,
  );

  const { error: qtyErr } = await supabase
    .from("inventory_commitments")
    .update({ qty: 5 })
    .eq("id", rowId);
  record(
    "qty mutation on open row blocked by trigger",
    Boolean(qtyErr) && /qty cannot be changed/.test(qtyErr?.message ?? ""),
    qtyErr?.message ?? "no error",
  );

  const { error: relErr } = await supabase
    .from("inventory_commitments")
    .update({ released_at: new Date().toISOString(), release_reason: "smoke_test" })
    .eq("id", rowId);
  after = await fetchCommitted(workspaceId, sku);
  record(
    "release flips counter back",
    !relErr && after === baseline,
    `expected ${baseline}, got ${after} (err=${relErr?.message ?? "none"})`,
  );

  const { data: ins2, error: rein } = await supabase
    .from("inventory_commitments")
    .insert({
      workspace_id: workspaceId,
      sku,
      source: "manual",
      source_id: SOURCE_ID,
      qty: 2,
      metadata: { round: 2 },
    })
    .select("id")
    .single();
  after = await fetchCommitted(workspaceId, sku);
  record(
    "re-insert after release re-increments counter",
    !rein && after === baseline + 2,
    `expected ${baseline + 2}, got ${after} (err=${rein?.message ?? "none"})`,
  );
  const rowId2 = ins2?.id as string | undefined;

  // Release rowId2 so we have a released row whose key isn't shadowed
  // by another open row (otherwise the unique index would fire before
  // the trigger could). This isolates the trigger guard from the
  // unique-index guard.
  if (rowId2) {
    await supabase
      .from("inventory_commitments")
      .update({ released_at: new Date().toISOString(), release_reason: "smoke_pre_unrelease" })
      .eq("id", rowId2);
  }
  const { error: unrelErr } = await supabase
    .from("inventory_commitments")
    .update({ released_at: null })
    .eq("id", rowId);
  record(
    "un-release of released row blocked by trigger",
    Boolean(unrelErr) && /cannot be un-released/.test(unrelErr?.message ?? ""),
    unrelErr?.message ?? "no error",
  );

  await supabase.from("inventory_commitments").delete().eq("source_id", SOURCE_ID);
  const final = await fetchCommitted(workspaceId, sku);
  record(
    "cleanup leaves counter at baseline",
    final === baseline,
    `expected ${baseline}, got ${final}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
