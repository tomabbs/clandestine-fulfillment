/**
 * WooCommerce credential submission route.
 *
 * WooCommerce uses API key authentication (not OAuth), so this accepts
 * consumer_key + consumer_secret + store_url via POST, validates them
 * against the WooCommerce API, and stores the connection.
 *
 * POST /api/oauth/woocommerce
 * Body: { org_id, store_url, api_key, api_secret }
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const submitSchema = z.object({
  org_id: z.string().uuid(),
  store_url: z.string().url(),
  api_key: z.string().min(1),
  api_secret: z.string().min(1),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { org_id, store_url, api_key, api_secret } = parsed.data;
  const baseUrl = store_url.replace(/\/$/, "");

  // Validate credentials against WooCommerce API
  const auth = Buffer.from(`${api_key}:${api_secret}`).toString("base64");
  const testRes = await fetch(`${baseUrl}/wp-json/wc/v3/system_status`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!testRes.ok) {
    return NextResponse.json(
      { error: `WooCommerce credential validation failed: HTTP ${testRes.status}` },
      { status: 422 },
    );
  }

  const supabase = createServiceRoleClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("workspace_id")
    .eq("id", org_id)
    .single();

  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const { error: upsertError } = await supabase.from("client_store_connections").upsert(
    {
      workspace_id: org.workspace_id,
      org_id,
      platform: "woocommerce",
      store_url: baseUrl,
      api_key,
      api_secret,
      connection_status: "active",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,platform,store_url" },
  );

  if (upsertError) {
    return NextResponse.json(
      { error: `Failed to save connection: ${upsertError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    redirectUrl: `${env().NEXT_PUBLIC_APP_URL}/portal/stores?connected=woocommerce`,
  });
}
