import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

type MappingRow = {
  id: string;
  connection_id: string;
  variant_id: string;
  remote_variant_id: string | null;
  remote_inventory_item_id: string | null;
  remote_sku: string | null;
  updated_at: string;
  created_at: string;
  is_active: boolean;
};

function groupKey(prefix: string, connectionId: string, value: string | null): string | null {
  if (!value || !value.trim()) return null;
  return `${prefix}:${connectionId}:${value}`;
}

function pickWinner(rows: MappingRow[]): MappingRow {
  return [...rows].sort((a, b) => {
    const updated = Date.parse(b.updated_at) - Date.parse(a.updated_at);
    if (updated !== 0) return updated;
    const created = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  })[0];
}

async function main() {
  const live = process.argv.includes("--live");
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("client_store_sku_mappings")
    .select(
      "id, connection_id, variant_id, remote_variant_id, remote_inventory_item_id, remote_sku, updated_at, created_at, is_active",
    )
    .eq("is_active", true)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Failed to load mappings: ${error.message}`);

  const rows = (data ?? []) as MappingRow[];
  const groups = new Map<string, MappingRow[]>();

  for (const row of rows) {
    const keys = [
      groupKey("variant", row.connection_id, row.variant_id),
      groupKey("remote_variant", row.connection_id, row.remote_variant_id),
      groupKey("remote_inventory", row.connection_id, row.remote_inventory_item_id),
    ].filter((value): value is string => Boolean(value));

    for (const key of keys) {
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }
  }

  const deactivateIds = new Set<string>();
  const report: Array<{
    group: string;
    keep: string;
    deactivate: string[];
  }> = [];

  for (const [key, bucket] of groups.entries()) {
    if (bucket.length <= 1) continue;
    const winner = pickWinner(bucket);
    const losers = bucket.filter((row) => row.id !== winner.id).map((row) => row.id);
    losers.forEach((id) => deactivateIds.add(id));
    report.push({ group: key, keep: winner.id, deactivate: losers });
  }

  console.log(`duplicate groups: ${report.length}`);
  console.log(`rows to deactivate: ${deactivateIds.size}`);
  console.log(JSON.stringify(report.slice(0, 20), null, 2));

  if (!live) {
    console.log("Dry run complete. Re-run with --live to deactivate duplicate rows.");
    return;
  }

  if (deactivateIds.size === 0) {
    console.log("No duplicate rows found. Nothing to deactivate.");
    return;
  }

  const ids = Array.from(deactivateIds);
  const timestamp = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("client_store_sku_mappings")
    .update({
      is_active: false,
      deactivation_reason: "phase0_duplicate_remediation",
      deactivated_at: timestamp,
      updated_at: timestamp,
    })
    .in("id", ids);
  if (updateError) throw new Error(`Failed to deactivate duplicates: ${updateError.message}`);

  console.log(`Deactivated ${ids.length} duplicate mapping rows.`);
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
