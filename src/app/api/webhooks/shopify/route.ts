/**
 * First-party Shopify webhook Route Handler.
 *
 * Rule #36: req.text() for raw body — never req.json() then JSON.stringify().
 * Rule #62: INSERT INTO webhook_events for dedup (ON CONFLICT skip).
 * Current model: observe-only for first-party Shopify webhook topics.
 * Orders/inventory are ShipStation-authoritative; product sync runs via Graph API jobs.
 */

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkspaceResolutionStatus = "resolved" | "workspace_resolution_failed" | "workspace_ambiguous";

interface WorkspaceResolutionResult {
  status: WorkspaceResolutionStatus;
  workspaceId: string | null;
  trace: Record<string, unknown>;
}

function normalizeShopDomain(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function resolveWorkspaceForShopifyWebhook(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shopDomainHeader: string | null,
): Promise<WorkspaceResolutionResult> {
  const { SHOPIFY_STORE_URL } = env();
  const configuredDomain = normalizeShopDomain(new URL(SHOPIFY_STORE_URL).hostname);
  const incomingDomain = normalizeShopDomain(shopDomainHeader);

  const trace: Record<string, unknown> = {
    strategy: "configured_store_domain_then_single_workspace",
    incoming_shop_domain: incomingDomain,
    configured_shop_domain: configuredDomain,
  };

  if (!incomingDomain || !configuredDomain || incomingDomain !== configuredDomain) {
    trace.reason = "shop_domain_mismatch";
    return {
      status: "workspace_resolution_failed",
      workspaceId: null,
      trace,
    };
  }

  const { data: candidates, error } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(2);

  if (error) {
    trace.reason = "workspace_query_failed";
    trace.error = error.message;
    return {
      status: "workspace_resolution_failed",
      workspaceId: null,
      trace,
    };
  }

  const candidateIds = (candidates ?? []).map((row) => row.id);
  trace.workspace_candidate_count = candidateIds.length;
  trace.workspace_candidate_ids = candidateIds;

  if (candidateIds.length === 1) {
    return {
      status: "resolved",
      workspaceId: candidateIds[0] ?? null,
      trace,
    };
  }

  if (candidateIds.length === 0) {
    trace.reason = "no_workspace_candidates";
    return {
      status: "workspace_resolution_failed",
      workspaceId: null,
      trace,
    };
  }

  trace.reason = "multiple_workspace_candidates";
  return {
    status: "workspace_ambiguous",
    workspaceId: null,
    trace,
  };
}

export async function POST(req: Request) {
  // Step 1: Read raw body first (Rule #36 — can only read once)
  const rawBody = await readWebhookBody(req);

  // Step 2: Verify HMAC signature (Rule #63)
  const { SHOPIFY_WEBHOOK_SECRET } = env();
  if (SHOPIFY_WEBHOOK_SECRET) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    const valid = await verifyHmacSignature(rawBody, SHOPIFY_WEBHOOK_SECRET, signature);
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  // Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const topic = req.headers.get("X-Shopify-Topic") ?? "unknown";
  // HRD-22: prefer `X-Shopify-Event-Id` (per-event, stable across retries)
  // over `X-Shopify-Webhook-Id` (per-delivery, changes on retry). The latter
  // would let duplicate downstream processing slip through during Shopify's
  // at-least-once retry storms.
  // Ref: https://shopify.dev/docs/apps/build/webhooks/ignore-duplicates
  const shopifyWebhookId =
    req.headers.get("X-Shopify-Event-Id") ??
    req.headers.get("X-Shopify-Webhook-Id") ??
    `shopify:${Date.now()}`;

  // Step 3: Resolve workspace (workspace-first invariant).
  // For first-party Shopify webhook traffic, resolve against configured SHOPIFY_STORE_URL.
  // Never enqueue processing without resolved workspace attribution.
  const supabase = createServiceRoleClient();
  const shopDomain = req.headers.get("X-Shopify-Shop-Domain");
  const workspaceResolution = await resolveWorkspaceForShopifyWebhook(supabase, shopDomain);

  // Step 4: Dedup via webhook_events (Rule #62)
  const { data: inserted } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: shopifyWebhookId,
      topic,
      status: workspaceResolution.status === "resolved" ? "pending" : workspaceResolution.status,
      workspace_id: workspaceResolution.workspaceId,
      metadata: {
        topic,
        payload,
        resolver_trace: workspaceResolution.trace,
      },
    })
    .select("id")
    .single();

  if (!inserted) {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  if (workspaceResolution.status !== "resolved") {
    return NextResponse.json({ ok: true, status: workspaceResolution.status });
  }

  // Current operating model:
  // - ShipStation is authoritative for orders/inventory movement.
  // - Clandestine Shopify product sync runs via Graph API jobs, not webhook mutation flow.
  // We still ingest and classify webhook traffic for visibility and incident detection.
  const noOpTopics = new Set(["inventory_levels/update", "orders/create", "orders/updated"]);
  const status = noOpTopics.has(topic) ? "ignored_shipstation_authoritative" : "ignored_topic";

  await supabase
    .from("webhook_events")
    .update({
      status,
      processed_at: new Date().toISOString(),
      metadata: {
        topic,
        payload,
        resolver_trace: workspaceResolution.trace,
        processing_mode: "observe_only",
      },
    })
    .eq("id", inserted.id);

  return NextResponse.json({ ok: true, status });
}
