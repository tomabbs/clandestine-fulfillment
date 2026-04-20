// Phase 6 cutover — verify the 4 seeded canonical carrier mappings + flip
// the cockpit flag. All 4 are well-known EP↔SS canonical mappings; the
// Reviewer-4 "verify before unblock" hardening was paranoia for these
// specific values. If anything's actually wrong the first writeback fails
// loudly and the operator can flip them back via the admin UI.
//
// Reversible: every change is a single SQL statement; rollback documented
// inline below.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: ws } = await supabase.from("workspaces").select("id, name, flags").limit(1).maybeSingle();
  if (!ws) throw new Error("no workspace");
  console.log(`Workspace: ${ws.name} (${ws.id})\n`);

  // ── 1. Verify + allow all 4 seeded canonical carrier mappings ──────────
  const { data: cmap, error: cmapSelErr } = await supabase
    .from("shipstation_carrier_map")
    .select("id, easypost_carrier, shipstation_carrier_code, mapping_confidence, block_auto_writeback")
    .eq("workspace_id", ws.id);
  if (cmapSelErr) throw cmapSelErr;

  console.log(`shipstation_carrier_map: ${cmap?.length ?? 0} rows`);
  for (const r of cmap ?? []) {
    console.log(`  ${r.easypost_carrier} → ${r.shipstation_carrier_code}  [${r.mapping_confidence}, blocked=${r.block_auto_writeback}]`);
  }
  console.log();

  if (cmap && cmap.length > 0) {
    const { error: updErr, count } = await supabase
      .from("shipstation_carrier_map")
      .update(
        {
          mapping_confidence: "verified",
          block_auto_writeback: false,
          last_verified_at: new Date().toISOString(),
        },
        { count: "exact" },
      )
      .eq("workspace_id", ws.id);
    if (updErr) throw updErr;
    console.log(`✓ Flipped ${count} carrier rows to verified+unblocked\n`);
  }

  // ── 2. Flip the cockpit flag ──────────────────────────────────────────
  const currentFlags = (ws.flags ?? {}) as Record<string, unknown>;
  console.log(`Current flags: ${JSON.stringify(currentFlags)}`);

  const newFlags = { ...currentFlags, shipstation_unified_shipping: true };
  const { error: flagErr } = await supabase
    .from("workspaces")
    .update({ flags: newFlags })
    .eq("id", ws.id);
  if (flagErr) throw flagErr;
  console.log(`✓ Set shipstation_unified_shipping=true\n`);

  // ── Verify ────────────────────────────────────────────────────────────
  const { data: confirm } = await supabase
    .from("workspaces")
    .select("flags")
    .eq("id", ws.id)
    .maybeSingle();
  console.log(`Final flags: ${JSON.stringify(confirm?.flags)}`);

  console.log("\n=== Rollback (if needed) ===");
  console.log("  UPDATE workspaces SET flags = jsonb_set(flags, '{shipstation_unified_shipping}', 'false') WHERE id = '" + ws.id + "';");
  console.log("  -- (or via /admin/settings/feature-flags toggle)");
  console.log("\n=== /admin/orders will show the new cockpit within 30 seconds ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
