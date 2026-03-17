"use server";

import { createServerSupabaseClient } from "@/lib/server/supabase-server";

export async function getPortalSettings() {
  const supabase = await createServerSupabaseClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, billing_email")
    .limit(1)
    .single();

  const { data: connections } = await supabase
    .from("client_store_connections")
    .select("id, platform, store_url, connection_status, last_webhook_at");

  return { org, connections: connections ?? [] };
}
