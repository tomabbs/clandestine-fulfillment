import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();

  const { data, error } = await sb
    .from("webhook_events")
    .select("id, external_webhook_id, status, created_at, metadata")
    .eq("platform", "resend")
    .order("created_at", { ascending: false })
    .limit(3);

  if (error) throw error;

  for (const row of data ?? []) {
    console.log("\n" + "=".repeat(70));
    console.log(`webhook_events row id=${row.id}`);
    console.log(`svix-id: ${row.external_webhook_id}`);
    console.log(`status: ${row.status}`);
    console.log(`created_at: ${row.created_at}`);
    console.log("metadata (full):");
    console.log(JSON.stringify(row.metadata, null, 2).slice(0, 4000));
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
