# Shopify Hardening — Code Reference 01: OAuth + Webhooks

Part 1 of 6. Full source code for OAuth, webhook handlers, env config, and shared webhook utilities.

Related: [Plan](../../../.cursor/plans/shopify_app_hardening_a4333f7e.plan.md) · [02 Trigger Tasks](02-trigger-tasks-existing.md) · [03 Actions & UI](03-actions-and-ui.md) · [04 Bandcamp Chain](04-bandcamp-shopify-chain.md) · [05 New Code](05-new-code-skeletons.md) · [06 Migrations & Config](06-migrations-config-tests.md)

---

## Table of Contents

1. [`src/app/api/oauth/shopify/route.ts`](#1-oauth-route) — 121 lines
2. [`src/app/api/webhooks/shopify/route.ts`](#2-first-party-webhook-handler) — 117 lines
3. [`src/app/api/webhooks/client-store/route.ts`](#3-client-store-webhook-handler) — 111 lines
4. [`src/app/api/webhooks/shopify/gdpr/route.ts`](#4-gdpr-combined-handler) — 56 lines
5. [`src/app/api/webhooks/shopify/gdpr/customers-data-request/route.ts`](#5-gdpr-customers-data-request) — 38 lines
6. [`src/app/api/webhooks/shopify/gdpr/customers-redact/route.ts`](#6-gdpr-customers-redact) — 38 lines
7. [`src/app/api/webhooks/shopify/gdpr/shop-redact/route.ts`](#7-gdpr-shop-redact) — 38 lines
8. [`src/lib/server/webhook-body.ts`](#8-webhook-body-shared-utils) — 46 lines
9. [`src/lib/shared/env.ts`](#9-environment-configuration) — 109 lines
10. [`shopify.app.toml`](#10-shopify-app-manifest) — 27 lines
11. [`scripts/manage-shopify-webhooks.ts`](#11-warehouse-webhook-registration-script) — 104 lines

---

## 1. OAuth Route

### File: `src/app/api/oauth/shopify/route.ts`

**Role**: Install flow entry point (redirect to Shopify) + callback (token exchange + connection upsert).

**Plan modifications**: Remove `write_publications` from scopes (line 16), add nonce storage to `oauth_states` (Phase 1.1), enqueue `shopify-app-install` task after connection upsert (Phase 1.2).

```typescript
/**
 * Shopify OAuth route for client store connections.
 *
 * GET /api/oauth/shopify?shop=<domain>&org_id=<uuid>   → redirect to Shopify auth
 * GET /api/oauth/shopify?code=<code>&shop=<domain>&...  → callback, store token
 *
 * Security: HMAC verified with crypto.timingSafeEqual (M1 fix — timing-safe comparison).
 */

import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const SHOPIFY_SCOPES =
  "read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_fulfillments,write_fulfillments,write_publications";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const shop = searchParams.get("shop");
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const hmac = searchParams.get("hmac");

  // ── Step 1: Initiate OAuth → redirect to Shopify ──────────────────────────
  if (shop && !code) {
    const orgId = searchParams.get("org_id");
    if (!orgId) {
      return NextResponse.json({ error: "org_id required" }, { status: 400 });
    }

    const stateToken = Buffer.from(JSON.stringify({ orgId, nonce: crypto.randomUUID() })).toString(
      "base64",
    );

    const authUrl =
      `https://${shop}/admin/oauth/authorize?` +
      new URLSearchParams({
        client_id: env().SHOPIFY_CLIENT_ID,
        scope: SHOPIFY_SCOPES,
        redirect_uri: `${env().NEXT_PUBLIC_APP_URL}/api/oauth/shopify`,
        state: stateToken,
      });

    return NextResponse.redirect(authUrl);
  }

  // ── Step 2: Callback with code ────────────────────────────────────────────
  if (code && shop && state && hmac) {
    // Verify HMAC with timing-safe comparison (M1 fix)
    const params = new URLSearchParams(searchParams);
    params.delete("hmac");
    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    const hash = crypto
      .createHmac("sha256", env().SHOPIFY_CLIENT_SECRET)
      .update(sortedParams)
      .digest("hex");

    const hashBuffer = Buffer.from(hash, "hex");
    const hmacBuffer = Buffer.from(hmac, "hex");

    if (
      hashBuffer.length !== hmacBuffer.length ||
      !crypto.timingSafeEqual(hashBuffer, hmacBuffer)
    ) {
      return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
    }

    // Exchange code for access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env().SHOPIFY_CLIENT_ID,
        client_secret: env().SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return NextResponse.json({ error: `Token exchange failed: ${body}` }, { status: 500 });
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const stateData = JSON.parse(Buffer.from(state, "base64").toString()) as { orgId: string };

    const supabase = createServiceRoleClient();
    const { data: org } = await supabase
      .from("organizations")
      .select("workspace_id")
      .eq("id", stateData.orgId)
      .single();

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    await supabase.from("client_store_connections").upsert(
      {
        workspace_id: org.workspace_id,
        org_id: stateData.orgId,
        platform: "shopify",
        store_url: `https://${shop}`,
        api_key: access_token,
        connection_status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,platform,store_url" },
    );

    return NextResponse.redirect(`${env().NEXT_PUBLIC_APP_URL}/portal/stores?connected=shopify`);
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
```

---

## 2. First-Party Webhook Handler

### File: `src/app/api/webhooks/shopify/route.ts`

**Role**: Receives webhooks from the WAREHOUSE Shopify store AND all client Shopify stores (public app — one signing secret for all).

**Plan modifications (Phase 0)**:
- **C1**: Remove `if (SHOPIFY_WEBHOOK_SECRET)` conditional — always enforce HMAC (fail-closed when secret missing)
- **C2**: Fix broken echo query (`remote_variant_id` field is wrong — should be `remote_inventory_item_id` which we add in the new migration)
- Handle `app/uninstalled` topic by routing to the uninstall handler in `process-shopify-webhook`

```typescript
/**
 * First-party Shopify webhook Route Handler.
 *
 * Rule #36: req.text() for raw body — never req.json() then JSON.stringify().
 * Rule #62: INSERT INTO webhook_events for dedup (ON CONFLICT skip).
 * Rule #65: Echo cancellation — drop webhooks that echo back our own inventory pushes.
 * Rule #66: Return 200 within 5s (target <500ms) — heavy processing via Trigger task.
 */

import { tasks } from "@trigger.dev/sdk";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

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
  const shopifyWebhookId = req.headers.get("X-Shopify-Webhook-Id") ?? `shopify:${Date.now()}`;

  // Step 3: Resolve workspace from shop domain via client_store_connections.
  // Using store_url ILIKE match is more reliable than slug matching (slugs can drift
  // if workspace names change; store_url is immutable for a given Shopify store).
  const supabase = createServiceRoleClient();
  const shopDomain = req.headers.get("X-Shopify-Shop-Domain");
  let resolvedWorkspaceId: string | null = null;
  if (shopDomain) {
    const { data: conn } = await supabase
      .from("client_store_connections")
      .select("workspace_id")
      .eq("platform", "shopify")
      .ilike("store_url", `%${shopDomain}%`)
      .limit(1)
      .maybeSingle();
    resolvedWorkspaceId = conn?.workspace_id ?? null;
  }

  // Step 4: Dedup via webhook_events (Rule #62)
  const { data: inserted } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: shopifyWebhookId,
      topic,
      status: "pending",
      workspace_id: resolvedWorkspaceId,
      metadata: { topic, payload },
    })
    .select("id")
    .single();

  if (!inserted) {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // Step 5: Echo cancellation (Rule #65)
  // When we push inventory TO Shopify, Shopify fires a webhook back.
  // If the webhook quantity matches what we last pushed, it's our own echo.
  if (topic === "inventory_levels/update") {
    const inventoryItemId = payload.inventory_item_id as number | undefined;
    const available = payload.available as number | undefined;

    if (inventoryItemId != null && available != null) {
      // Look up SKU mapping by remote variant ID to check last_pushed_quantity
      const { data: mapping } = await supabase
        .from("client_store_sku_mappings")
        .select("id, last_pushed_quantity")
        .eq("remote_variant_id", String(inventoryItemId))
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

      if (mapping?.last_pushed_quantity === available) {
        // This is our own push echoing back — mark and skip
        await supabase
          .from("webhook_events")
          .update({ status: "echo_cancelled" })
          .eq("id", inserted.id);

        return NextResponse.json({ ok: true, status: "echo_cancelled" });
      }
    }
  }

  // Step 6: Enqueue async processing (Rule #66)
  await tasks.trigger("process-shopify-webhook", {
    webhookEventId: inserted.id,
    topic,
    payload,
  });

  // Step 7: Return 200 OK immediately
  return NextResponse.json({ ok: true });
}
```

---

## 3. Client Store Webhook Handler

### File: `src/app/api/webhooks/client-store/route.ts`

**Role**: Per-connection webhook handler for WooCommerce, Squarespace, and legacy client Shopify connections (new client Shopify installs route to `/api/webhooks/shopify` instead).

**Plan modifications (Phase 3.3)**: Add `source` filter to order dedup query (currently missing).

```typescript
/**
 * Client store webhook Route Handler.
 *
 * Rule #36: req.text() for raw body — never req.json() then JSON.stringify().
 * Rule #23: Per-platform HMAC signature verification.
 * Rule #62: INSERT INTO webhook_events for dedup.
 * Rule #66: Return 200 fast — heavy processing in Trigger task.
 */

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";

export async function POST(request: NextRequest) {
  // Step 1: Read raw body (must be first — can only read once)
  const rawBody = await readWebhookBody(request);

  // Step 2: Determine platform and connection
  const connectionId = request.nextUrl.searchParams.get("connection_id");
  const _platform = request.nextUrl.searchParams.get("platform") ?? "unknown";

  if (!connectionId) {
    return NextResponse.json({ error: "missing connection_id" }, { status: 400 });
  }

  // Get connection for webhook secret (using service role — no RLS)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: connection } = await supabase
    .from("client_store_connections")
    .select("id, workspace_id, platform, webhook_secret")
    .eq("id", connectionId)
    .single();

  if (!connection) {
    return NextResponse.json({ error: "connection not found" }, { status: 404 });
  }

  // Step 3: Verify HMAC per platform (Rule #23)
  if (connection.webhook_secret) {
    let signature: string | null = null;

    if (connection.platform === "shopify") {
      signature = request.headers.get("X-Shopify-Hmac-SHA256");
      if (signature) {
        const valid = await verifyHmacSignature(rawBody, connection.webhook_secret, signature);
        if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    } else if (connection.platform === "woocommerce") {
      signature = request.headers.get("X-WC-Webhook-Signature");
      if (signature) {
        const valid = await verifyHmacSignature(rawBody, connection.webhook_secret, signature);
        if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    } else if (connection.platform === "squarespace") {
      // Squarespace uses "Squarespace-Signature" header.
      // IMPORTANT: the webhook secret is hex-encoded — must decode to bytes before HMAC.
      // Using verifyHmacSignature (UTF-8 key) would produce wrong results for Squarespace.
      signature = request.headers.get("Squarespace-Signature");
      if (signature) {
        const secretBytes = Buffer.from(connection.webhook_secret, "hex");
        const expectedSig = crypto.createHmac("sha256", secretBytes).update(rawBody).digest("hex");
        const valid = crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signature));
        if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    }
  }

  // Step 4: Dedup via webhook_events (Rule #62)
  const externalWebhookId =
    request.headers.get("X-Shopify-Webhook-Id") ??
    request.headers.get("X-WC-Webhook-ID") ??
    `${connectionId}:${Date.now()}`;

  const { data: insertedEvent, error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      workspace_id: connection.workspace_id,
      platform: connection.platform,
      external_webhook_id: externalWebhookId,
      topic: request.headers.get("X-Shopify-Topic") ?? request.headers.get("X-WC-Webhook-Topic"),
      metadata: {
        connection_id: connectionId,
        payload: JSON.parse(rawBody),
      },
    })
    .select("id")
    .single();

  if (dedupError) {
    // Unique constraint violation = already processed
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // Step 5: Fire Trigger task for heavy processing (Rule #66)
  if (insertedEvent) {
    await tasks.trigger("process-client-store-webhook", {
      webhookEventId: insertedEvent.id,
    });
  }

  // Step 6: Return 200 fast
  return NextResponse.json({ ok: true });
}
```

---

## 4. GDPR Combined Handler

### File: `src/app/api/webhooks/shopify/gdpr/route.ts`

**Role**: Single combined endpoint for GDPR compliance webhooks (Shopify app manifest points here). Currently acknowledges only — does not execute data export or redaction.

**Plan modifications (Phase 1.4)**: Make the handler actually perform the data export/redaction based on `topic`.

```typescript
/**
 * Combined Shopify GDPR compliance webhook handler.
 *
 * Handles all three mandatory GDPR topics:
 *   customers/data_request — customer requests their data
 *   customers/redact       — customer requests data deletion
 *   shop/redact            — shop uninstalled, delete shop data
 *
 * Shopify signs GDPR webhooks with the app's client secret.
 * Rule #36: Raw body must be read before any parsing.
 * Rule #62: Dedup via webhook_events INSERT.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);

  const secret = env().SHOPIFY_CLIENT_SECRET;
  if (secret) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    const valid = await verifyHmacSignature(rawBody, secret, signature);
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: `gdpr-${bodyHash}`,
      topic: "gdpr/combined",
      status: "received",
    })
    .select("id")
    .single();

  if (dedupError) {
    if (dedupError.code === "23505") {
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    console.error("webhook_events insert failed:", dedupError);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
```

---

## 5. GDPR customers/data_request

### File: `src/app/api/webhooks/shopify/gdpr/customers-data-request/route.ts`

```typescript
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);
  const secret = env().SHOPIFY_CLIENT_SECRET;
  if (secret) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    const valid = await verifyHmacSignature(rawBody, secret, signature);
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: `gdpr-cdr-${bodyHash}`,
      topic: "customers/data_request",
      status: "received",
    })
    .select("id")
    .single();

  if (dedupError) {
    if (dedupError.code === "23505") {
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    console.error("webhook_events insert failed:", dedupError);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
```

---

## 6. GDPR customers/redact

### File: `src/app/api/webhooks/shopify/gdpr/customers-redact/route.ts`

```typescript
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);
  const secret = env().SHOPIFY_CLIENT_SECRET;
  if (secret) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    const valid = await verifyHmacSignature(rawBody, secret, signature);
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: `gdpr-cr-${bodyHash}`,
      topic: "customers/redact",
      status: "received",
    })
    .select("id")
    .single();

  if (dedupError) {
    if (dedupError.code === "23505") {
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    console.error("webhook_events insert failed:", dedupError);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
```

---

## 7. GDPR shop/redact

### File: `src/app/api/webhooks/shopify/gdpr/shop-redact/route.ts`

```typescript
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);
  const secret = env().SHOPIFY_CLIENT_SECRET;
  if (secret) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    const valid = await verifyHmacSignature(rawBody, secret, signature);
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: `gdpr-sr-${bodyHash}`,
      topic: "shop/redact",
      status: "received",
    })
    .select("id")
    .single();

  if (dedupError) {
    if (dedupError.code === "23505") {
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    console.error("webhook_events insert failed:", dedupError);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
```

---

## 8. Webhook Body Shared Utils

### File: `src/lib/server/webhook-body.ts`

**Role**: Single owner for webhook body reading + HMAC verification (Rule #58).

```typescript
// Rule #58: This file is the ONE owner for webhook body parsing + HMAC verification.
// Rule #36: ALWAYS use req.text() — never req.json() then JSON.stringify().

/**
 * Read the raw body from a webhook request.
 * Must be called before any other body parsing — req.text() can only be read once.
 */
export async function readWebhookBody(req: Request): Promise<string> {
  return req.text();
}

/**
 * Verify an HMAC signature against a raw body string.
 * Uses Web Crypto API (works in Edge Runtime and Node).
 *
 * @param rawBody - The raw request body string
 * @param secret - The webhook secret key
 * @param signature - The signature from the request header
 * @param algorithm - Hash algorithm (default: SHA-256)
 */
export async function verifyHmacSignature(
  rawBody: string,
  secret: string,
  signature: string,
  algorithm: "SHA-256" | "SHA-1" = "SHA-256",
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = Buffer.from(sig).toString("base64");

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}
```

---

## 9. Environment Configuration

### File: `src/lib/shared/env.ts`

**Role**: Zod-validated env var schema. Warehouse Shopify uses `SHOPIFY_STORE_URL` + `SHOPIFY_ADMIN_API_TOKEN`. Partner app uses `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`.

**Plan modifications (Phase 0)**: Tighten `SHOPIFY_WEBHOOK_SECRET` to require non-empty when `SHOPIFY_CLIENT_ID` is set. For public apps, set `SHOPIFY_WEBHOOK_SECRET = SHOPIFY_CLIENT_SECRET` (they're the same signing key).

```typescript
import { z } from "zod";

const serverEnvSchema = z.object({
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  // Trigger.dev
  TRIGGER_SECRET_KEY: z.string().min(1),

  // Upstash Redis
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  // Sentry
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1),
  SENTRY_ORG: z.string().min(1),
  SENTRY_PROJECT: z.string().min(1),
  SENTRY_AUTH_TOKEN: z.string().min(1),

  // Shopify
  SHOPIFY_STORE_URL: z.string().url(),
  SHOPIFY_ADMIN_API_TOKEN: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET: z.string().default(""),

  // ShipStation (legacy — kept for historical inventory data, not actively used)
  SHIPSTATION_API_KEY: z.string().default(""),
  SHIPSTATION_API_SECRET: z.string().default(""),
  SHIPSTATION_WEBHOOK_SECRET: z.string().default(""),

  // EasyPost
  EASYPOST_API_KEY: z.string().default(""),

  // Shopify OAuth (client store connections — NOT main Clandestine Shopify)
  SHOPIFY_CLIENT_ID: z.string().default(""),
  SHOPIFY_CLIENT_SECRET: z.string().default(""),

  // Squarespace OAuth
  SQUARESPACE_CLIENT_ID: z.string().default(""),
  SQUARESPACE_CLIENT_SECRET: z.string().default(""),

  // Discogs OAuth (client store connections + master catalog)
  DISCOGS_CONSUMER_KEY: z.string().default(""),
  DISCOGS_CONSUMER_SECRET: z.string().default(""),
  DISCOGS_MASTER_ACCESS_TOKEN: z.string().default(""),

  // AfterShip
  AFTERSHIP_API_KEY: z.string().min(1),
  AFTERSHIP_WEBHOOK_SECRET: z.string().min(1),

  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  // Bandcamp
  BANDCAMP_CLIENT_ID: z.string().min(1),
  BANDCAMP_CLIENT_SECRET: z.string().min(1),

  // Resend
  RESEND_API_KEY: z.string().min(1),
  RESEND_INBOUND_WEBHOOK_SECRET: z.string().min(1),

  // App
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let _cachedEnv: ServerEnv | null = null;

/**
 * Lazily validated server environment variables.
 * Only validates on first access — safe to import without all vars set.
 */
export function env(): ServerEnv {
  if (_cachedEnv) return _cachedEnv;
  _cachedEnv = serverEnvSchema.parse(process.env);
  return _cachedEnv;
}

const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

let _cachedClientEnv: ClientEnv | null = null;

/**
 * Lazily validated client (public) environment variables.
 */
export function clientEnv(): ClientEnv {
  if (_cachedClientEnv) return _cachedClientEnv;
  _cachedClientEnv = clientEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
  return _cachedClientEnv;
}
```

---

## 10. Shopify App Manifest

### File: `shopify.app.toml`

**Role**: Local mirror of the Shopify Partner Dashboard config (app v5 approved). Pushed to Shopify via `shopify app deploy`.

**Plan modifications (Phase 0.6)**: Remove `write_publications` from scopes to match the approved v5 app. Prevents accidental v6 submission on local `shopify app deploy`.

```toml
name = "Clandestine Fulfillment Sync"
client_id = "1a130c67b70382784614107d4ce0e933"
application_url = "https://cpanel.clandestinedistro.com"
embedded = false
handle = "clandestine-fulfillment-sync"

[access_scopes]
scopes = "read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_fulfillments,write_fulfillments,write_publications"

[auth]
redirect_urls = [
  "https://cpanel.clandestinedistro.com/api/oauth/shopify",
]

[webhooks]
api_version = "2026-01"

[[webhooks.subscriptions]]
compliance_topics = ["customers/redact", "customers/data_request", "shop/redact"]
uri = "/api/webhooks/shopify/gdpr"

[pos]
embedded = false

[build]
automatically_update_urls_on_dev = false
```

**Live v5 scopes on Shopify Partner Dashboard** (authoritative):
```
read_fulfillments,read_inventory,read_orders,read_products,write_fulfillments,write_inventory,write_orders,write_products
```

(Note: local file has `write_publications` which v5 does NOT have. Plan removes it from local to align.)

---

## 11. Warehouse Webhook Registration Script

### File: `scripts/manage-shopify-webhooks.ts`

**Role**: One-off script to register webhooks on the WAREHOUSE Shopify store (not client stores). Uses `SHOPIFY_ADMIN_API_TOKEN`. For client stores, see [05 New Code: `shopify-app-install`](05-new-code-skeletons.md#shopify-app-install).

```typescript
/**
 * Manage Shopify webhooks — list existing and register new ones.
 * Run: npx tsx scripts/manage-shopify-webhooks.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const RAW_STORE = process.env.SHOPIFY_STORE_URL ?? ""; // may include https://
const SHOPIFY_STORE = RAW_STORE.replace(/^https?:\/\//, "");
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-01";
const BASE_URL = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}`;
const APP_DOMAIN = "https://cpanel.clandestinedistro.com";

async function shopifyFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN!,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Shopify ${res.status}: ${body}`);
  }
  return res.json();
}

async function listWebhooks() {
  const data = await shopifyFetch("/webhooks.json");
  const webhooks = data.webhooks ?? [];
  console.log(`Found ${webhooks.length} webhook(s):\n`);
  for (const wh of webhooks) {
    console.log(`  [${wh.id}] ${wh.topic} → ${wh.address}`);
    console.log(`    format=${wh.format}, created=${wh.created_at}\n`);
  }
  return webhooks;
}

async function createWebhook(topic: string, address: string) {
  console.log(`Creating: ${topic} → ${address}`);
  const data = await shopifyFetch("/webhooks.json", {
    method: "POST",
    body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
  });
  if (data.webhook) {
    console.log(`  Created: id=${data.webhook.id}\n`);
  } else {
    console.log(`  Response: ${JSON.stringify(data)}\n`);
  }
  return data;
}

async function deleteWebhook(id: number) {
  console.log(`Deleting webhook ${id}...`);
  await shopifyFetch(`/webhooks/${id}.json`, { method: "DELETE" }).catch(() => null);
  console.log(`  Deleted.\n`);
}

async function main() {
  console.log(`Store: ${SHOPIFY_STORE}`);
  console.log(`API: ${API_VERSION}`);
  console.log(`Target: ${APP_DOMAIN}\n`);

  console.log("=== Existing Webhooks ===\n");
  const existing = await listWebhooks();

  // Webhooks we want registered
  const desired = [
    { topic: "inventory_levels/update", path: "/api/webhooks/shopify" },
    { topic: "orders/create", path: "/api/webhooks/shopify" },
    { topic: "products/update", path: "/api/webhooks/shopify" },
  ];

  console.log("=== Registering Webhooks ===\n");
  for (const d of desired) {
    const address = `${APP_DOMAIN}${d.path}`;
    const exists = existing.find(
      (wh: { topic: string; address: string }) => wh.topic === d.topic && wh.address === address,
    );
    if (exists) {
      console.log(`  [skip] ${d.topic} already registered at ${address}\n`);
    } else {
      // Delete any old webhook for same topic pointing elsewhere
      const old = existing.filter(
        (wh: { topic: string; address: string }) => wh.topic === d.topic && wh.address !== address,
      );
      for (const o of old) {
        console.log(`  [replace] Removing old ${d.topic} → ${o.address}`);
        await deleteWebhook(o.id);
      }
      await createWebhook(d.topic, address);
    }
  }

  console.log("=== Final Webhook State ===\n");
  await listWebhooks();
}

main().catch(console.error);
```

---

## Silent Bug Summary in This File Set

| Bug | File | Line | Fix |
|---|---|---|---|
| C1: Empty webhook secret bypasses HMAC | `/api/webhooks/shopify/route.ts` | 22 | Remove conditional; fail-closed when secret missing; require in env |
| C2: Echo query uses wrong ID | `/api/webhooks/shopify/route.ts` | 91 | Add `remote_inventory_item_id` column (new migration); fix query |
| C6: GDPR handlers acknowledge only | All 4 GDPR routes | — | Switch on topic + execute data export/redaction |
| C10: Scope mismatch | `/api/oauth/shopify/route.ts` | 16 | Remove `write_publications` from scope string |

---

**Next**: [02 Trigger Tasks — Existing](02-trigger-tasks-existing.md) for `process-shopify-webhook`, `process-client-store-webhook`, etc.
