"use server";

/**
 * Shopify Server Actions.
 *
 * Rule #48: No Server Action may call the Shopify API directly.
 * "Force Sync" and "Full Backfill" MUST call tasks.trigger() to enqueue the
 * job via Trigger.dev. If a Server Action calls the API directly while the
 * cron job runs, you risk rate limits and data races.
 *
 * Rule #41: Server Actions for quick mutations only. Heavy work goes to Trigger tasks.
 */

import { tasks } from "@trigger.dev/sdk";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"; // TODO: multi-workspace

export async function triggerShopifySync() {
  const handle = await tasks.trigger("shopify-sync", {});
  return { runId: handle.id };
}

export async function triggerFullBackfill() {
  const handle = await tasks.trigger("shopify-full-backfill", {
    workspace_id: WORKSPACE_ID,
  });
  return { runId: handle.id };
}

export async function getShopifySyncStatus() {
  const supabase = await createServerSupabaseClient();

  const { data: syncState } = await supabase
    .from("warehouse_sync_state")
    .select("*")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("sync_type", "shopify_delta")
    .single();

  const { data: recentLogs } = await supabase
    .from("channel_sync_log")
    .select("*")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("channel", "shopify")
    .order("created_at", { ascending: false })
    .limit(10);

  return {
    syncState: syncState ?? null,
    recentLogs: recentLogs ?? [],
  };
}
