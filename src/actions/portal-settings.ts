"use server";

import { z } from "zod";
import { requireClient } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export async function getPortalSettings() {
  const { orgId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, billing_email")
    .eq("id", orgId)
    .single();

  const { data: connections } = await supabase
    .from("client_store_connections")
    .select("id, platform, store_url, connection_status, last_webhook_at")
    .eq("org_id", orgId);

  let notificationPreferences = { email_enabled: true };
  if (org) {
    const { data: adminSettings } = await supabase
      .from("portal_admin_settings")
      .select("settings")
      .eq("org_id", org.id)
      .maybeSingle();

    if (adminSettings?.settings) {
      const settings = adminSettings.settings as Record<string, unknown>;
      const notifications = settings.notifications as Record<string, unknown> | undefined;
      notificationPreferences = {
        email_enabled: notifications?.email_enabled !== false,
      };
    }
  }

  return { org, connections: connections ?? [], notificationPreferences };
}

const updateNotificationPreferencesSchema = z.object({
  email_enabled: z.boolean(),
});

export async function updateNotificationPreferences(rawData: { email_enabled: boolean }) {
  const parsed = updateNotificationPreferencesSchema.parse(rawData);
  const { orgId, workspaceId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { data: existing } = await supabase
    .from("portal_admin_settings")
    .select("id, settings")
    .eq("org_id", orgId)
    .maybeSingle();

  const mergedSettings = {
    ...((existing?.settings as Record<string, unknown>) ?? {}),
    notifications: { email_enabled: parsed.email_enabled },
  };

  if (existing) {
    const { error } = await supabase
      .from("portal_admin_settings")
      .update({ settings: mergedSettings, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("org_id", orgId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("portal_admin_settings").insert({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      org_id: orgId,
      settings: mergedSettings,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  }
}
