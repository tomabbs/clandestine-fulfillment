import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function check() {
  // Check review queue
  const { data: reviews } = await supabase
    .from("warehouse_review_queue")
    .select("title, description, category, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  console.log("Review queue items:");
  for (const r of reviews ?? []) {
    console.log(`\n  [${r.category}] ${r.title}`);
    console.log(`  ${r.description?.slice(0, 300)}`);
    if (r.metadata) console.log(`  metadata: ${JSON.stringify(r.metadata).slice(0, 200)}`);
  }

  // Check sync logs with more detail
  const { data: logs } = await supabase
    .from("channel_sync_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(3);

  console.log("\n\nDetailed sync logs:");
  for (const log of logs ?? []) {
    console.log(`\n  ${log.channel}/${log.sync_type}: ${log.status}`);
    console.log(`  processed: ${log.items_processed}, failed: ${log.items_failed}`);
    if (log.error_message) console.log(`  error: ${log.error_message.slice(0, 400)}`);
    console.log(`  started: ${log.started_at}, completed: ${log.completed_at}`);
  }

  // Also check if shipstation sync state was updated
  const { data: ssState } = await supabase
    .from("warehouse_sync_state")
    .select("*")
    .eq("sync_type", "shipstation_poll")
    .single();

  console.log("\n\nShipStation sync state:");
  console.log(ssState ? JSON.stringify(ssState, null, 2) : "  not found");
}

check().catch(console.error);
