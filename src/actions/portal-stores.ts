"use server";

import { z } from "zod/v4";
import { requireClient } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

/** Return store connections for the logged-in client's org. */
export async function getMyStoreConnections() {
  const { orgId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("client_store_connections")
    .select(
      "id, platform, store_url, connection_status, last_poll_at, last_webhook_at, last_error, last_error_at, created_at",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch store connections: ${error.message}`);

  return {
    connections: data ?? [],
    orgId,
  };
}

const wooSchema = z.object({
  storeUrl: z.string().url(),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
});

/** Submit WooCommerce API key credentials.  Calls /api/oauth/woocommerce internally. */
export async function submitWooCommerceCredentials(rawData: {
  storeUrl: string;
  apiKey: string;
  apiSecret: string;
}): Promise<{ success: boolean; error?: string }> {
  const { orgId } = await requireClient();
  const data = wooSchema.parse(rawData);

  const appUrl = env().NEXT_PUBLIC_APP_URL;

  const res = await fetch(`${appUrl}/api/oauth/woocommerce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      org_id: orgId,
      store_url: data.storeUrl,
      api_key: data.apiKey,
      api_secret: data.apiSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    return { success: false, error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }

  return { success: true };
}

/**
 * Build the WooCommerce OAuth authorization URL.
 * Redirecting the client to this URL shows a native WP admin approval screen —
 * no manual API key copy/paste required.
 */
export async function getWooCommerceAuthUrl(storeUrl: string): Promise<{ url: string }> {
  const { orgId } = await requireClient();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  const baseStore = storeUrl.replace(/\/$/, "");

  const callbackUrl = `${appUrl}/api/oauth/woocommerce/callback?org_id=${encodeURIComponent(orgId)}&store_url=${encodeURIComponent(baseStore)}`;
  const returnUrl = `${appUrl}/portal/stores?connected=woocommerce`;

  const wcAuthParams = new URLSearchParams({
    app_name: "Clandestine Fulfillment",
    scope: "read_write",
    user_id: orgId,
    return_url: returnUrl,
    callback_url: callbackUrl,
  });

  const wcAuthUrl = `${baseStore}/wc-auth/v1/authorize?${wcAuthParams}`;

  // Route through wp-login.php with redirect_to so:
  // - If already logged in → skips login form, goes straight to approval screen
  // - If not logged in → shows login form, then auto-forwards to approval screen
  const loginUrl = `${baseStore}/wp-login.php?redirect_to=${encodeURIComponent(wcAuthUrl)}`;

  return { url: loginUrl };
}

/** Delete a store connection. */
export async function deleteStoreConnection(connectionId: string): Promise<{ success: boolean }> {
  const { orgId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { error } = await supabase
    .from("client_store_connections")
    .delete()
    .eq("id", connectionId)
    .eq("org_id", orgId); // RLS-equivalent guard

  if (error) throw new Error(`Failed to delete connection: ${error.message}`);
  return { success: true };
}
