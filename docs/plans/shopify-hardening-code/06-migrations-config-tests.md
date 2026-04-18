# Shopify Hardening — Code Reference 06: Migrations, Config, Tests

Part 6 of 6. Existing + NEW migrations, Trigger.dev config, and comprehensive test skeletons.

Related: [01 OAuth & Webhooks](01-oauth-webhooks.md) · [02 Trigger Tasks](02-trigger-tasks-existing.md) · [03 Actions & UI](03-actions-and-ui.md) · [04 Bandcamp Chain](04-bandcamp-shopify-chain.md) · [05 New Code](05-new-code-skeletons.md)

---

## Table of Contents

1. [Existing Migration: `20260316000011_store_connections.sql`](#1-existing-store-connections-base-migration)
2. [Existing Migration: `20260316000008_monitoring.sql` (webhook_events + RPC)](#2-existing-monitoring-webhook_events--rpc)
3. [Existing Migration: `20260325000001_v72_schema_updates.sql` Section 4](#3-existing-v72-client_store_connections-updates)
4. [NEW Migration: `20260416000001_shopify_app_hardening.sql`](#4-new-shopify-app-hardening-migration)
5. [`trigger.config.ts`](#5-triggerdev-config)
6. [`shopify.app.toml`](#6-shopify-partner-app-manifest)
7. [Test Skeletons](#7-test-skeletons)

---

## 1. Existing: Store Connections Base Migration

### File: `supabase/migrations/20260316000011_store_connections.sql` (63 lines)

```sql
-- Migration 011: Client store connections and SKU mappings
-- Rule #19: Client credential submission uses service_role (bypasses RLS)
-- Rule #28: Store connection health columns (last_webhook_at, last_poll_at, last_error_at, last_error)
-- Rule #44: last_pushed_quantity / last_pushed_at for WooCommerce drift tracking
-- Rule #53: do_not_fanout flag + connection_status for circuit breakers

CREATE TABLE client_store_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  platform text NOT NULL CHECK (platform IN ('shopify', 'woocommerce', 'squarespace', 'bigcommerce')),
  store_url text NOT NULL,
  api_key text,
  api_secret text,
  webhook_url text,
  webhook_secret text,
  connection_status text NOT NULL DEFAULT 'pending' CHECK (connection_status IN ('pending', 'active', 'disabled_auth_failure', 'error')),
  last_webhook_at timestamptz,
  last_poll_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  do_not_fanout boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_store_connections_org ON client_store_connections(org_id);

CREATE TABLE client_store_sku_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id),
  remote_product_id text,
  remote_variant_id text,
  remote_sku text,
  last_pushed_quantity integer,
  last_pushed_at timestamptz,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sku_mappings_connection ON client_store_sku_mappings(connection_id);
CREATE INDEX idx_sku_mappings_variant ON client_store_sku_mappings(variant_id);

-- RLS: client_store_connections
ALTER TABLE client_store_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON client_store_connections FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON client_store_connections FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- RLS: client_store_sku_mappings
ALTER TABLE client_store_sku_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON client_store_sku_mappings FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON client_store_sku_mappings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_store_connections csc
    WHERE csc.id = client_store_sku_mappings.connection_id
    AND csc.org_id = get_user_org_id()
  ));
```

**Gap flagged in plan**: Missing UNIQUE constraint on `(connection_id, variant_id)` — needed for `upsert` onConflict — added in new migration (Section 4 below).

---

## 2. Existing: Monitoring (webhook_events + RPC)

### File: `supabase/migrations/20260316000008_monitoring.sql` — key excerpts

```sql
-- Rule #37/#62: Webhook dedup table — atomic INSERT ON CONFLICT for all platforms
CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  platform text NOT NULL,
  external_webhook_id text NOT NULL,
  topic text,
  status text DEFAULT 'received',
  processed_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(platform, external_webhook_id)
);
CREATE INDEX idx_webhook_events_platform ON webhook_events(platform, created_at DESC);

-- Rule #64: record_inventory_change_txn RPC
CREATE OR REPLACE FUNCTION record_inventory_change_txn(
  p_workspace_id uuid,
  p_sku text,
  p_delta integer,
  p_source text,
  p_correlation_id text,
  p_metadata jsonb DEFAULT '{}'
) RETURNS jsonb AS $$
DECLARE
  v_previous integer;
  v_new integer;
BEGIN
  UPDATE warehouse_inventory_levels
  SET available = available + p_delta,
      updated_at = now(),
      last_redis_write_at = now()
  WHERE workspace_id = p_workspace_id AND sku = p_sku
  RETURNING available - p_delta, available INTO v_previous, v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No inventory level found for workspace=% sku=%', p_workspace_id, p_sku;
  END IF;

  INSERT INTO warehouse_inventory_activity (
    id, workspace_id, sku, delta, source, correlation_id,
    previous_quantity, new_quantity, metadata
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_sku, p_delta, p_source, p_correlation_id,
    v_previous, v_new, p_metadata
  );

  RETURN jsonb_build_object('previous', v_previous, 'new', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Plan note**: `webhook_events.status` should get expanded values via migration (new statuses: `failed_permanent`, `echo_cancelled`, `sku_not_found`, `no_change`, etc.). Current schema uses text (no CHECK), so no migration needed — just documentation.

---

## 3. Existing: v72 client_store_connections Updates

### File: `supabase/migrations/20260325000001_v72_schema_updates.sql` — Section 4

```sql
-- SECTION 4: CLIENT STORE CONNECTIONS UPDATES

-- Add metadata column (used for primary_location_id, OAuth state, etc.)
ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

-- Add token refresh locking (for Discogs OAuth 1.0a)
ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS token_refresh_locked_at timestamptz;

-- Update platform CHECK constraint to include discogs
ALTER TABLE client_store_connections
  DROP CONSTRAINT IF EXISTS client_store_connections_platform_check;
ALTER TABLE client_store_connections
  ADD CONSTRAINT client_store_connections_platform_check
  CHECK (platform IN ('shopify', 'woocommerce', 'squarespace', 'bigcommerce', 'discogs'));

-- Unique indexes for OAuth upsert
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_connections_org_platform_url
  ON client_store_connections(org_id, platform, store_url);

CREATE UNIQUE INDEX IF NOT EXISTS idx_store_connections_org_discogs
  ON client_store_connections(org_id, platform)
  WHERE platform = 'discogs';

-- oauth_states table (Discogs OAuth 1.0a uses this; new migration extends for Shopify)
CREATE TABLE IF NOT EXISTS oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_token text NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  request_token_secret text NOT NULL,
  platform text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);
```

---

## 4. NEW: Shopify App Hardening Migration

### File: `supabase/migrations/20260416000001_shopify_app_hardening.sql` (NEW)

Supports Phase 0.2 (echo query fix), Phase 2 (match confidence), Phase 3.2 (per-SKU failure tracking), Phase 1.3 (disconnected status).

```sql
-- Migration: Shopify app hardening — client store reliability + fuzzy matching
-- Addresses findings C2, C9, M3, and enables Phase 2-4 of the plan.

-- ── 1. client_store_sku_mappings: add match confidence + observability ─────

-- Unique constraint for upsert (M3 — currently only an index exists)
ALTER TABLE client_store_sku_mappings
  ADD CONSTRAINT uq_sku_mappings_connection_variant
  UNIQUE (connection_id, variant_id);

-- Match confidence tier (Phase 2)
ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS match_confidence text
    CHECK (match_confidence IN ('exact_sku', 'barcode', 'title_fuzzy', 'manual'))
    DEFAULT 'exact_sku';

-- Approval status: only 'confirmed' mappings participate in inventory push
ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS match_status text
    CHECK (match_status IN ('confirmed', 'pending_review', 'rejected'))
    DEFAULT 'confirmed';

-- Match score (0..1) — useful for bulk-approval UI ("approve all >= 0.8")
ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS match_score numeric;

-- Remote metadata for staff review UI
ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS remote_title text,
  ADD COLUMN IF NOT EXISTS remote_barcode text;

-- Shopify's inventory_item_id per mapping (C2 — echo query fix)
ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS remote_inventory_item_id text;

-- Audit trail for approval/rejection
ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- Per-SKU failure tracking (Phase 3.2)
ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS consecutive_push_failures integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_push_error text,
  ADD COLUMN IF NOT EXISTS last_push_error_at timestamptz;

-- Index for pending review queue
CREATE INDEX IF NOT EXISTS idx_sku_mappings_status
  ON client_store_sku_mappings(match_status)
  WHERE match_status = 'pending_review';

-- Index for echo lookup in webhook route (C2)
CREATE INDEX IF NOT EXISTS idx_sku_mappings_inventory_item
  ON client_store_sku_mappings(remote_inventory_item_id)
  WHERE remote_inventory_item_id IS NOT NULL;

-- Index for reconciliation task sampling
CREATE INDEX IF NOT EXISTS idx_sku_mappings_reconcile
  ON client_store_sku_mappings(connection_id, is_active, match_status)
  WHERE is_active = true AND match_status = 'confirmed';


-- ── 2. client_store_connections: expand status values (C9) ─────────────────

-- Add 'disconnected' status for app/uninstalled handling
ALTER TABLE client_store_connections
  DROP CONSTRAINT IF EXISTS client_store_connections_connection_status_check;
ALTER TABLE client_store_connections
  ADD CONSTRAINT client_store_connections_connection_status_check
  CHECK (connection_status IN ('pending', 'active', 'disabled_auth_failure', 'disconnected', 'error'));


-- ── 3. webhook_events: expand status enum for observability ────────────────

-- No CHECK constraint exists on webhook_events.status today, so no migration needed.
-- Documentation: valid status values are now:
--   received, pending, processed, echo_cancelled, parse_failed, sku_not_found,
--   no_inventory_level, no_change, processing_failed, already_processed,
--   failed_permanent
--
-- If enforcement is desired later:
-- ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
--   CHECK (status IN (...above list...));


-- ── 4. Backfill existing mappings to 'confirmed' status ────────────────────

-- All pre-existing mappings were created via exact-SKU match logic.
-- Default already handles this, but explicit backfill for clarity:
UPDATE client_store_sku_mappings
SET match_status = 'confirmed',
    match_confidence = 'exact_sku'
WHERE match_status IS NULL OR match_confidence IS NULL;


-- ── 5. Documentation comment on table ───────────────────────────────────────

COMMENT ON COLUMN client_store_sku_mappings.match_status IS
  'Phase 2 hardening: confirmed = active for inventory push; pending_review = awaiting staff approval (fuzzy match); rejected = staff rejected, do not re-auto-match';
COMMENT ON COLUMN client_store_sku_mappings.remote_inventory_item_id IS
  'Shopify inventory_item_id per mapping — used for webhook echo cancellation. NULL for non-Shopify platforms.';
COMMENT ON COLUMN client_store_sku_mappings.consecutive_push_failures IS
  'Phase 3.2: incremented on each push failure; resets to 0 on success. >= 5 → mark is_active=false + review item.';
```

**Apply with**: `supabase db push --yes` from repo root. Idempotent (all `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`).

---

## 5. Trigger.dev Config

### File: `trigger.config.ts` (73 lines)

```typescript
// Rule #49: Trigger.dev v4 tasks run in Trigger's infra, NOT Vercel.
// Use @sentry/node here, NOT @sentry/nextjs — this code runs outside Next.js.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Sentry from "@sentry/node";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";
import { parse } from "dotenv";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
  enabled: process.env.NODE_ENV === "production",
});

// Vars that Trigger.dev manages itself — never sync these.
const EXCLUDED_VARS = new Set(["TRIGGER_SECRET_KEY"]);

export default defineConfig({
  project: "proj_lxmzyqttdjjukmshplok",
  dirs: ["src/trigger/tasks"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      factor: 2,
    },
  },
  build: {
    extensions: [
      syncEnvVars(async (ctx) => {
        const envFile = ctx.environment === "prod" ? ".env.production" : ".env.local";
        const envPath = resolve(process.cwd(), envFile);

        if (!existsSync(envPath)) {
          console.warn(`syncEnvVars: ${envFile} not found — skipping`);
          return [];
        }

        const parsed = parse(readFileSync(envPath));

        const vars: Array<{ name: string; value: string }> = [];
        for (const [key, value] of Object.entries(parsed)) {
          if (!EXCLUDED_VARS.has(key)) {
            vars.push({ name: key, value });
          }
        }

        console.log(
          `syncEnvVars: syncing ${vars.length} vars from ${envFile} → ${ctx.environment}`,
        );

        return vars;
      }),
    ],
  },
  onFailure: async ({ ctx, error }) => {
    Sentry.captureException(error, {
      tags: {
        trigger_task: ctx.task?.id,
        trigger_run: ctx.run?.id,
      },
    });
    await Sentry.flush(2000);
  },
});
```

**Plan notes**:
- `onFailure` catches task-level throws. Per-iteration errors in loops must explicitly call `Sentry.captureException` (H7 — plan wires this in Phase 3.4).
- Default 3-attempt retry will catch C4 fix (throw-instead-of-return) for `process-shopify-webhook` inventory failures.

---

## 6. Shopify Partner App Manifest

### File: `shopify.app.toml` (27 lines — local file, authoritative source is Partner Dashboard)

**CURRENT (as committed — has extra `write_publications`):**
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

**AFTER PLAN (Phase 0.6 — remove `write_publications` to match approved v5):**
```toml
name = "Clandestine Fulfillment Sync"
client_id = "1a130c67b70382784614107d4ce0e933"
application_url = "https://cpanel.clandestinedistro.com"
embedded = false
handle = "clandestine-fulfillment-sync"

[access_scopes]
scopes = "read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_fulfillments,write_fulfillments"

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

**IMPORTANT**: This file is a local mirror. The authoritative source is the Shopify Partner Dashboard. The plan does NOT require submitting a new app version — we only:
1. Remove `write_publications` from our OAuth request code (so we ask for fewer scopes than approved)
2. Update this local file so it matches the approved v5 (prevents accidental `shopify app deploy` from trying to push v6)

No Shopify review needed. All client webhooks (orders, inventory, products, app/uninstalled) are registered imperatively via the `shopify-app-install` Trigger task after OAuth.

---

## 7. Test Skeletons

### 7.1 `tests/unit/trigger/process-client-store-webhook.test.ts` (NEW — H5)

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for process-client-store-webhook task.
 * Covers: echo cancellation, order creation, partial inventory apply,
 * bundle fanout, cross-platform dedup.
 */

describe("process-client-store-webhook", () => {
  describe("handleInventoryUpdate", () => {
    it("echo-cancels when webhook quantity matches last_pushed_quantity", async () => {
      // Mock supabase to return mapping with last_pushed_quantity = 10
      // Webhook payload has quantity = 10
      // Expect: webhook_events.status updated to 'echo_cancelled'
      // Expect: recordInventoryChange NOT called
    });

    it("computes delta and calls recordInventoryChange when quantities differ", async () => {
      // Mock warehouse_inventory_levels.available = 5
      // Webhook payload has quantity = 3
      // Expect: recordInventoryChange called with delta = -2
    });

    it("returns no_change when delta is 0", async () => {
      // warehouse = 5, webhook = 5
      // Expect: no inventory mutation, status = 'no_change'
    });

    it("returns sku_not_found when warehouse level missing", async () => {
      // Mock supabase to return null for warehouse_inventory_levels
      // Expect: status = 'sku_not_found'
    });
  });

  describe("handleOrderCreated", () => {
    it("deduplicates by external_order_id + source (Phase 3.3 fix)", async () => {
      // Same external_order_id on shopify + woocommerce should NOT collide
    });

    it("creates warehouse_order + items + decrements inventory via SKU mapping", async () => {
      // Full flow: connection lookup → order insert → line items → recordInventoryChange
    });

    it("marks 'not_mapped' for line items without SKU mapping", async () => {
      // Line item SKU has no client_store_sku_mappings entry
      // Expect: decrementResults includes { status: 'not_mapped' }
      // Expect: review queue item created with severity: 'medium'
    });

    it("marks 'floor_violation' for insufficient stock", async () => {
      // recordInventoryChange returns floor_violation reason
      // Expect: decrementResults includes { status: 'floor_violation' }
    });

    it("marks 'error' for system faults", async () => {
      // recordInventoryChange throws
      // Expect: decrementResults includes { status: 'error' }
      // Expect: review queue item with severity: 'high'
    });

    it("triggers bundle fanout when mapped variant is a bundle", async () => {
      // Mock triggerBundleFanout
      // Expect: called with correct variantId + soldQuantity
    });

    it("triggers downstream inventory push tasks after successful decrement", async () => {
      // Expect: tasks.trigger called with bandcamp-inventory-push
      // Expect: tasks.trigger called with multi-store-inventory-push
    });
  });
});
```

### 7.2 `tests/unit/trigger/auto-discover-skus.test.ts` (NEW)

```typescript
import { describe, expect, it } from "vitest";

describe("auto-discover-skus", () => {
  describe("matching cascade", () => {
    it("TIER 1: exact SKU match → confirmed", async () => {
      // Remote SKU = "LP-001", warehouse SKU = "LP-001"
      // Expect: match_confidence = 'exact_sku', status = 'confirmed'
    });

    it("TIER 2: barcode match when SKU differs → confirmed", async () => {
      // Remote SKU = "VINYL-BLACK-12IN", warehouse SKU = "LP-001"
      // Both have barcode = "196922555718"
      // Expect: match_confidence = 'barcode', status = 'confirmed'
    });

    it("TIER 3: title fuzzy match >= 0.6 → pending_review", async () => {
      // Remote title = "Green-House - Six Songs for Invisible Gardens"
      // Warehouse title = "Green-House - Six Songs for Invisible Gardens LP"
      // Expect: match_confidence = 'title_fuzzy', match_status = 'pending_review'
    });

    it("TIER 4: no match → unmatched (review item)", async () => {
      // No SKU/barcode/title match
      // Expect: no mapping created, review queue item
    });

    it("prefers exact SKU over barcode when both match different variants", async () => {
      // Edge case: one variant matches by SKU, different one matches by barcode
      // Exact SKU wins
    });

    it("skips remote variants with empty SKU (current behavior)", async () => {
      // TODO: plan may want to fuzzy-match these too
    });
  });

  describe("WooCommerce variations (H6)", () => {
    it("fetches /products then /products/{id}/variations for variable products", async () => {
      // Mock first fetch returns parent products including variable type
      // Mock second fetch returns variations
      // Expect: all variations appear as RemoteVariant entries
    });

    it("merges simple products + variations into single list", async () => {
      // Some products simple (no variations), some variable
    });
  });

  describe("Shopify", () => {
    it("fetches with fields=id,title,product_type,vendor,variants including barcode", async () => {
      // Verify fetch URL includes all needed fields
    });

    it("paginates via Link header", async () => {
      // First page returns Link: <url>; rel="next"
      // Second page returns no Link
      // Expect: both pages merged
    });
  });
});
```

### 7.3 `tests/unit/trigger/store-inventory-reconcile.test.ts` (NEW)

```typescript
describe("store-inventory-reconcile", () => {
  it("samples 50 confirmed mappings per connection", async () => {});
  it("skips pending_review and rejected mappings", async () => {});
  it("creates drift review item when |drift| > 1", async () => {});
  it("dedupes review items via group_key per connection", async () => {});
  it("writes sensor_readings entry per connection", async () => {});
  it("handles per-SKU lookup failures without aborting", async () => {});
  it("skips connections with do_not_fanout = true", async () => {});
  it("skips connections in disabled/disconnected status", async () => {});
});
```

### 7.4 `tests/unit/trigger/retry-failed-webhooks.test.ts` (NEW)

```typescript
describe("retry-failed-webhooks", () => {
  it("retries events in 'pending' status older than 5 minutes", async () => {});
  it("retries events in 'processing_failed' status", async () => {});
  it("respects exponential backoff (2^n minutes)", async () => {});
  it("marks failed_permanent after MAX_RETRIES (5)", async () => {});
  it("creates review item on permanent failure", async () => {});
  it("routes shopify events to process-shopify-webhook", async () => {});
  it("routes client-store events to process-client-store-webhook", async () => {});
});
```

### 7.5 `tests/unit/lib/clients/shopify-rate-limiter.test.ts` (NEW)

```typescript
describe("shopify-rate-limiter", () => {
  describe("token bucket", () => {
    it("allows BUCKET_SIZE (40) immediate requests", async () => {});
    it("waits for refill when tokens exhausted", async () => {});
    it("refills at REFILL_RATE (2 per second)", async () => {});
    it("caps tokens at BUCKET_SIZE on refill", async () => {});
  });

  describe("429 handling", () => {
    it("sleeps for Retry-After seconds when 429 received", async () => {});
    it("defaults to 2s when Retry-After header missing", async () => {});
    it("drains bucket after 429 for safety", async () => {});
  });

  describe("per-store isolation", () => {
    it("maintains separate buckets per store URL", async () => {});
  });

  describe("rateLimitedShopifyFetch", () => {
    it("retries up to maxRetries on 429", async () => {});
    it("throws after exhausted retries", async () => {});
    it("returns response on non-429 status", async () => {});
  });
});
```

### 7.6 `tests/unit/webhooks/client-store-webhook.test.ts` (NEW)

```typescript
describe("POST /api/webhooks/client-store", () => {
  describe("HMAC verification", () => {
    it("verifies Shopify HMAC with X-Shopify-Hmac-SHA256", async () => {});
    it("verifies WooCommerce HMAC with X-WC-Webhook-Signature", async () => {});
    it("verifies Squarespace HMAC with hex-decoded secret", async () => {});
    it("rejects 401 on invalid signature", async () => {});
    it("skips verification if webhook_secret is null", async () => {});
  });

  describe("dedup", () => {
    it("returns duplicate on second INSERT conflict", async () => {});
    it("uses X-Shopify-Webhook-Id when present", async () => {});
    it("falls back to connection_id:timestamp when no header", async () => {});
  });

  describe("task enqueue", () => {
    it("triggers process-client-store-webhook with event ID", async () => {});
    it("does NOT trigger task on dedup (already processed)", async () => {});
  });
});
```

### 7.7 `tests/contract/shopify-client-store.test.ts` (NEW) — fixtures-based contract tests

```typescript
/**
 * Contract tests with mocked Shopify REST fixtures.
 * Fixtures in tests/fixtures/shopify-rest/.
 *
 * Covers:
 *   - OAuth install → token exchange → webhook registration → SKU discovery
 *   - Inventory webhook → echo cancellation
 *   - Order webhook → decrement
 *   - app/uninstalled → connection disabled
 *   - 429 response → rate limiter retries
 */

describe("Shopify client store contract", () => {
  it("full install flow: OAuth → webhooks → SKU discovery", async () => {});
  it("inventory_levels/update webhook → echo cancelled when last_pushed matches", async () => {});
  it("inventory_levels/update webhook → decrement applied when differs", async () => {});
  it("orders/create webhook → warehouse_orders row + inventory decrement", async () => {});
  it("app/uninstalled → connection_status=disconnected + do_not_fanout=true", async () => {});
  it("429 response → rate limiter retries up to 3x", async () => {});
  it("invalid HMAC signature → 401", async () => {});
});
```

### 7.8 `tests/e2e/portal-store-connection.spec.ts` (NEW) — Playwright

```typescript
import { test, expect } from "@playwright/test";

test.describe("Portal store connection", () => {
  test("client can initiate Shopify OAuth from portal", async ({ page }) => {
    // Login as client
    // Navigate to /portal/stores
    // Click "Add Store" → "Shopify"
    // Enter domain, click "Connect with Shopify"
    // Verify new tab opens to /api/oauth/shopify?shop=...
  });

  test("post-OAuth progress card shows install progress", async ({ page }) => {
    // Mock ?connected=shopify redirect
    // Mock /api/portal/stores/connection-progress poll
    // Verify progress card shows: "Registering webhooks" → "Discovering products" → "X matched"
  });

  test("connection card shows freshness badge", async ({ page }) => {
    // Seed connection with last_poll_at
    // Verify badge shows correct color (green/amber/red) based on age
  });

  test("client can delete a connection", async ({ page }) => {
    // Click delete, confirm
    // Verify connection removed from list
  });
});
```

### 7.9 Release Gate Additions

```bash
# scripts/release-gate.sh — new CI guards

# Guard 1: No new console.error in critical paths without review queue / Sentry
bash scripts/ci-no-silent-errors-guard.sh

# Guard 2: Inventory write path still enforced (existing)
bash scripts/ci-inventory-guard.sh

# Guard 3: Webhook dedup still in place (existing)
bash scripts/ci-webhook-dedup-guard.sh

# Guard 4: New — verify migration list matches code expectations
supabase migration list --linked
```

```bash
# scripts/ci-no-silent-errors-guard.sh (NEW)
#!/bin/bash
# Fail if any console.error in the following files lacks adjacent Sentry.captureException or
# review queue INSERT within 10 lines.

FILES=(
  "src/trigger/tasks/process-shopify-webhook.ts"
  "src/trigger/tasks/process-client-store-webhook.ts"
  "src/trigger/tasks/multi-store-inventory-push.ts"
  "src/trigger/tasks/client-store-order-detect.ts"
  "src/lib/clients/store-sync-client.ts"
)

for f in "${FILES[@]}"; do
  # grep -B 0 -A 10 for console.error, check if Sentry or warehouse_review_queue appears within
  # Fail with helpful message if not
done
```

---

## Summary of All New Files Created by Plan

| Category | File | Lines (est) |
|---|---|---|
| Migration | `supabase/migrations/20260416000001_shopify_app_hardening.sql` | 80 |
| Trigger tasks | `src/trigger/tasks/shopify-app-install.ts` | 100 |
| Trigger tasks | `src/trigger/tasks/auto-discover-skus.ts` | 300 |
| Trigger tasks | `src/trigger/tasks/store-inventory-reconcile.ts` | 150 |
| Trigger tasks | `src/trigger/tasks/retry-failed-webhooks.ts` | 110 |
| Libraries | `src/lib/clients/shopify-rate-limiter.ts` | 75 |
| Libraries | `src/lib/shared/title-similarity.ts` | 45 |
| Libraries | `src/lib/server/shopify-webhook-registration.ts` | 110 |
| Server actions | `src/actions/webhook-events.ts` | 50 |
| UI | `src/app/admin/settings/webhooks/page.tsx` | 200 |
| UI | `src/components/admin/mapping-review.tsx` | 150 |
| API | `src/app/api/portal/stores/connection-progress/route.ts` | 70 |
| Tests | 6 unit + 1 contract + 1 e2e | 800 |
| Scripts | `scripts/ci-no-silent-errors-guard.sh` | 40 |

**Total new code**: ~2,280 lines + migration.

---

## Files Modified (Existing)

| File | Phase | Changes |
|---|---|---|
| `src/app/api/oauth/shopify/route.ts` | 0.6, 1.1, 1.2 | Remove `write_publications`; nonce via oauth_states; enqueue shopify-app-install |
| `src/app/api/webhooks/shopify/route.ts` | 0.1, 0.2 | Fail-closed HMAC; fix echo query to use `remote_inventory_item_id` |
| `src/app/api/webhooks/shopify/gdpr/*/route.ts` | 1.4 | Functional data export/redaction |
| `src/trigger/tasks/process-shopify-webhook.ts` | 0.3, 0.4, 1.3 | Remove dead code; throw on error; app/uninstalled handler |
| `src/trigger/tasks/process-client-store-webhook.ts` | 3.3 | Add source filter to dedup; Sentry per-iteration |
| `src/trigger/tasks/multi-store-inventory-push.ts` | 3.1, 3.2 | Wire shouldRetryConnection; rate limiter; per-SKU failure tracking |
| `src/trigger/tasks/client-store-order-detect.ts` | 3.4 | Sentry per-iteration |
| `src/lib/clients/store-sync-client.ts` | 0.5, 3.1 | Primary-location resolution; rate limiter wrapping; typed errors |
| `src/lib/server/shipment-fulfillment-cost.ts` | 2.2 | Export titleSimilarity + normalizeTitleForMatching |
| `src/actions/store-connections.ts` | 2.1, 2.3 | Multi-signal matching in autoDiscoverSkus; approve/reject actions |
| `src/app/admin/settings/store-connections/page.tsx` | 5 | Pending mappings subview |
| `src/app/portal/stores/page.tsx` | 7 | Post-connection progress card |
| `src/app/admin/channels/page.tsx` | 5 | Add client stores section |
| `src/lib/server/inventory-fanout.ts` | 2.5 | Filter by match_status=confirmed |
| `src/lib/shared/env.ts` | 0.1 | Tighten SHOPIFY_WEBHOOK_SECRET validation |
| `shopify.app.toml` | 0.6 | Remove write_publications to match v5 approved |
| `src/trigger/tasks/sensor-check.ts` | 5.3 | Add webhook.stuck_pending, store.drift_count, store.unconfirmed_mappings sensors |

---

**End of code reference.** Return to the [Plan](../../../.cursor/plans/shopify_app_hardening_a4333f7e.plan.md) for implementation phases and validation steps.
