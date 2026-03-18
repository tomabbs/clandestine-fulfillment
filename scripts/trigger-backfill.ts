import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!ws) { console.error("No workspace"); process.exit(1); }
  console.log(`Workspace: ${ws.id}`);

  // Current image count
  const { count: beforeImages } = await supabase
    .from("warehouse_product_images")
    .select("id", { count: "exact", head: true });
  console.log(`Images before: ${beforeImages ?? 0}`);

  // 1. Trigger full backfill
  console.log("\n--- Triggering shopify-full-backfill ---");
  const backfill = await tasks.trigger("shopify-full-backfill", { workspace_id: ws.id });
  console.log(`Triggered: ${backfill.id}`);
  console.log(`Dashboard: https://cloud.trigger.dev/projects/v3/proj_lxmzyqttdjjukmshplok/runs/${backfill.id}`);

  // 2. Also trigger shopify-sync for channel_sync_log
  console.log("\n--- Triggering shopify-sync (for Channels page) ---");
  // shopify-sync is a cron task — we can't trigger it directly with a payload.
  // Instead trigger a one-off sync via the task
  // Actually shopify-sync is a schedules.task which can't be triggered with payload.
  // Let's just note that the cron will pick it up.
  console.log("shopify-sync runs on cron (*/15 * * * *) — will update channel_sync_log automatically");

  console.log("\nMonitor backfill at:");
  console.log(`https://cloud.trigger.dev/projects/v3/proj_lxmzyqttdjjukmshplok/runs/${backfill.id}`);
  console.log("\nRun `npx tsx scripts/poll-images.ts` to check progress.");
}

main().catch(console.error);
