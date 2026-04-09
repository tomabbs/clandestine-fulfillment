# Expanded Audit — Full Source Code Appendix

Companion to `EXPANDED_AUDIT_FIX_HANDOFF_2026-04-09.md`. Contains complete source code for every file referenced in the audit, organized by system area.

---

## Table of Contents

1. [Inventory Core](#1-inventory-core)
2. [Trigger Tasks — Inventory Domain](#2-trigger-tasks--inventory-domain)
3. [Server Actions — Security Issues](#3-server-actions--security-issues)
4. [Auth System](#4-auth-system)
5. [Database Migrations](#5-database-migrations)

---

## 1. Inventory Core

### 1.1 `src/lib/server/record-inventory-change.ts`

```typescript
import { adjustInventory } from "@/lib/clients/redis-inventory";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { InventorySource } from "@/lib/shared/types";

interface RecordInventoryChangeParams {
  workspaceId: string;
  sku: string;
  delta: number;
  source: InventorySource;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

interface RecordInventoryChangeResult {
  success: boolean;
  newQuantity: number | null;
  alreadyProcessed: boolean;
}

export async function recordInventoryChange(
  params: RecordInventoryChangeParams,
): Promise<RecordInventoryChangeResult> {
  const { workspaceId, sku, delta, source, correlationId, metadata } = params;

  const redisResult = await adjustInventory(sku, "available", delta, correlationId);

  if (redisResult === null) {
    return { success: true, newQuantity: null, alreadyProcessed: true };
  }

  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.rpc("record_inventory_change_txn", {
      p_workspace_id: workspaceId,
      p_sku: sku,
      p_delta: delta,
      p_source: source,
      p_correlation_id: correlationId,
      p_metadata: metadata ?? {},
    });

    if (error) {
      console.error(
        `[recordInventoryChange] Postgres RPC failed after Redis write. ` +
          `SKU=${sku} delta=${delta} correlationId=${correlationId} error=${error.message}`,
      );
      return { success: false, newQuantity: redisResult, alreadyProcessed: false };
    }
  } catch (err) {
    console.error(
      `[recordInventoryChange] Postgres RPC exception after Redis write. ` +
        `SKU=${sku} delta=${delta} correlationId=${correlationId}`,
      err,
    );
    return { success: false, newQuantity: redisResult, alreadyProcessed: false };
  }

  try {
    const { fanoutInventoryChange } = await import("@/lib/server/inventory-fanout");
    fanoutInventoryChange(workspaceId, sku, redisResult).catch((err) => {
      console.error(`[recordInventoryChange] Fanout failed for SKU=${sku}:`, err);
    });
  } catch {
    // Fanout is non-critical
  }

  return { success: true, newQuantity: redisResult, alreadyProcessed: false };
}
```

### 1.2 `src/lib/clients/redis-inventory.ts`

```typescript
import { Redis } from "@upstash/redis";
import { env } from "@/lib/shared/env";

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = env();
  _redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });
  return _redis;
}

export interface InventoryLevels {
  available: number;
  committed: number;
  incoming: number;
}

export async function getInventory(sku: string): Promise<InventoryLevels> {
  const redis = getRedis();
  const data = await redis.hgetall<Record<string, string>>(`inv:${sku}`);
  return {
    available: Number(data?.available ?? 0),
    committed: Number(data?.committed ?? 0),
    incoming: Number(data?.incoming ?? 0),
  };
}

export async function setInventory(sku: string, fields: Partial<InventoryLevels>): Promise<void> {
  const redis = getRedis();
  const mapped: Record<string, number> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) mapped[key] = val;
  }
  if (Object.keys(mapped).length > 0) {
    await redis.hset(`inv:${sku}`, mapped);
  }
}

const ADJUST_LUA_SCRIPT = `
if redis.call('SETNX', KEYS[1], 1) == 1 then
  redis.call('EXPIRE', KEYS[1], 86400)
  return redis.call('HINCRBY', KEYS[2], ARGV[1], ARGV[2])
else
  return nil
end
`;

export async function adjustInventory(
  sku: string,
  field: keyof InventoryLevels,
  delta: number,
  idempotencyKey: string,
): Promise<number | null> {
  const redis = getRedis();
  const result = await redis.eval(
    ADJUST_LUA_SCRIPT,
    [`processed:${idempotencyKey}`, `inv:${sku}`],
    [field, delta],
  );
  return result as number | null;
}

export async function bulkSetInventory(
  entries: Array<{ sku: string; levels: Partial<InventoryLevels> }>,
): Promise<void> {
  const redis = getRedis();
  const pipeline = redis.pipeline();
  for (const entry of entries) {
    const mapped: Record<string, number> = {};
    for (const [key, val] of Object.entries(entry.levels)) {
      if (val !== undefined) mapped[key] = val;
    }
    if (Object.keys(mapped).length > 0) {
      pipeline.hset(`inv:${entry.sku}`, mapped);
    }
  }
  await pipeline.exec();
}

export { ADJUST_LUA_SCRIPT as _ADJUST_LUA_SCRIPT, getRedis as _getRedis };
```

### 1.3 `src/lib/server/inventory-fanout.ts`

```typescript
import { tasks } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface FanoutResult {
  storeConnectionsPushed: number;
  bandcampPushed: boolean;
}

export function determineFanoutTargets(
  hasStoreConnections: boolean,
  hasBandcampMapping: boolean,
): { pushToStores: boolean; pushToBandcamp: boolean } {
  return {
    pushToStores: hasStoreConnections,
    pushToBandcamp: hasBandcampMapping,
  };
}

export async function fanoutInventoryChange(
  workspaceId: string,
  sku: string,
  _newQuantity: number,
): Promise<FanoutResult> {
  const supabase = createServiceRoleClient();
  let storeConnectionsPushed = 0;
  let bandcampPushed = false;

  const { data: skuMappings } = await supabase
    .from("client_store_sku_mappings")
    .select("connection_id")
    .eq("is_active", true)
    .eq("remote_sku", sku);

  const { data: bandcampMappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, variant_id")
    .eq("workspace_id", workspaceId);

  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .single();

  const hasBandcampMapping =
    variant &&
    (bandcampMappings ?? []).some((m) => (m as Record<string, unknown>).variant_id === variant.id);

  const targets = determineFanoutTargets((skuMappings ?? []).length > 0, !!hasBandcampMapping);

  if (targets.pushToStores) {
    try {
      await tasks.trigger("multi-store-inventory-push", {});
      storeConnectionsPushed = (skuMappings ?? []).length;
    } catch { /* non-critical */ }
  }

  if (targets.pushToBandcamp) {
    try {
      await tasks.trigger("bandcamp-inventory-push", {});
      bandcampPushed = true;
    } catch { /* non-critical */ }
  }

  if (variant) {
    const { data: parentBundles } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("component_variant_id", variant.id)
      .limit(1);

    if (parentBundles?.length) {
      if (!targets.pushToBandcamp) {
        try { await tasks.trigger("bandcamp-inventory-push", {}); } catch { /* */ }
      }
      if (!targets.pushToStores) {
        try { await tasks.trigger("multi-store-inventory-push", {}); } catch { /* */ }
      }
    }
  }

  return { storeConnectionsPushed, bandcampPushed };
}
```

---

## 2. Trigger Tasks — Inventory Domain

> Due to document size constraints, the full source of every trigger task file is provided in the inventory system audit document at `docs/INVENTORY_SYSTEM_AUDIT_2026-04-06.md` sections 5.1-5.11.
>
> For the reviewer's convenience, the key files with their line counts are:
>
> | File | Lines | Key Functions |
> |------|-------|---------------|
> | `src/trigger/tasks/shopify-sync.ts` | 389 | `shopifySyncTask`, `upsertProductsBulk`, `upsertInventoryBulk` |
> | `src/trigger/tasks/process-shopify-webhook.ts` | 209 | `processShopifyWebhookTask`, `parseShopifyInventoryPayload`, `computeDelta` |
> | `src/trigger/tasks/bandcamp-sale-poll.ts` | 167 | `bandcampSalePollTask` |
> | `src/trigger/tasks/bandcamp-inventory-push.ts` | 190 | `bandcampInventoryPushTask` |
> | `src/trigger/tasks/multi-store-inventory-push.ts` | 291 | `multiStoreInventoryPushTask`, `pushConnectionInventory`, `handleConnectionFailure` |
> | `src/trigger/tasks/redis-backfill.ts` | 118 | `redisBackfillTask`, `shouldSkipSku` |
> | `src/trigger/tasks/sensor-check.ts` | 402 | `sensorCheckTask` (10 sensors) |
> | `src/trigger/tasks/bundle-component-fanout.ts` | 80 | `bundleComponentFanoutTask` |
> | `src/trigger/tasks/bundle-availability-sweep.ts` | 42 | `bundleAvailabilitySweepTask` |
> | `src/trigger/tasks/inbound-product-create.ts` | 201 | `inboundProductCreate` |
> | `src/trigger/tasks/inbound-checkin-complete.ts` | 130 | `inboundCheckinComplete` |
>
> All files have been read in full during this audit session. The complete code is available in the codebase at the paths above.

---

## 3. Server Actions — Security Issues

### 3.1 `src/actions/portal-dashboard.ts` (no auth check)

```typescript
"use server";

import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { parseOnboardingState } from "@/lib/shared/onboarding";

export async function getPortalDashboard() {
  const supabase = await createServerSupabaseClient();

  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name, onboarding_state")
    .limit(1)
    .single();

  const org = orgs;
  const orgId = org?.id;
  const onboardingSteps = parseOnboardingState(
    (org?.onboarding_state as Record<string, unknown>) ?? null,
  );

  const [variantCount, inventorySum, inboundCount, supportCount] = await Promise.all([
    supabase.from("warehouse_product_variants").select("id", { count: "exact", head: true }),
    supabase.from("warehouse_inventory_levels").select("available"),
    supabase
      .from("warehouse_inbound_shipments")
      .select("id", { count: "exact", head: true })
      .in("status", ["expected", "arrived", "checking_in"]),
    supabase
      .from("support_conversations")
      .select("id", { count: "exact", head: true })
      .in("status", ["open", "waiting_on_staff"]),
  ]);

  const totalAvailable = (inventorySum.data ?? []).reduce(
    (sum, row) => sum + (row.available as number),
    0,
  );

  const { data: recentActivity } = await supabase
    .from("warehouse_inventory_activity")
    .select("id, sku, delta, source, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: connections } = await supabase
    .from("client_store_connections")
    .select("id, platform, store_url, connection_status, last_webhook_at, last_poll_at")
    .eq("connection_status", "active");

  return {
    orgName: org?.name ?? "Your Organization",
    orgId,
    onboardingSteps,
    stats: {
      totalSkus: variantCount.count ?? 0,
      totalAvailable,
      pendingInbound: inboundCount.count ?? 0,
      openSupport: supportCount.count ?? 0,
    },
    recentActivity: recentActivity ?? [],
    connections: connections ?? [],
  };
}
```

### 3.2 `src/actions/portal-settings.ts` (broken client write)

```typescript
"use server";

import { z } from "zod";
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
  const supabase = await createServerSupabaseClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("id, workspace_id")
    .limit(1)
    .single();

  if (!org) throw new Error("Organization not found");

  const { data: existing } = await supabase
    .from("portal_admin_settings")
    .select("id, settings")
    .eq("org_id", org.id)
    .maybeSingle();

  const mergedSettings = {
    ...((existing?.settings as Record<string, unknown>) ?? {}),
    notifications: { email_enabled: parsed.email_enabled },
  };

  if (existing) {
    const { error } = await supabase
      .from("portal_admin_settings")
      .update({ settings: mergedSettings, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("portal_admin_settings").insert({
      id: crypto.randomUUID(),
      workspace_id: org.workspace_id,
      org_id: org.id,
      settings: mergedSettings,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  }
}
```

### 3.3 `src/actions/bandcamp-shipping.ts` (inline auth, hardcoded roles)

```typescript
"use server";

import { z } from "zod/v4";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

const setPaymentIdSchema = z.object({
  shipmentId: z.string().uuid(),
  bandcampPaymentId: z.number().int().positive().nullable(),
});

const triggerSyncSchema = z.object({
  shipmentId: z.string().uuid(),
});

async function requireStaffAuth() {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Unauthorized");

  const serviceClient = createServiceRoleClient();
  const { data: userRecord } = await serviceClient
    .from("users")
    .select("role")
    .eq("auth_user_id", data.user.id)
    .single();

  const staffRoles = [
    "admin",
    "super_admin",
    "label_staff",
    "label_management",
    "warehouse_manager",
  ];
  if (!userRecord || !staffRoles.includes(userRecord.role as string)) {
    throw new Error("Staff access required");
  }
}

export async function setBandcampPaymentId(raw: {
  shipmentId: string;
  bandcampPaymentId: number | null;
}): Promise<{ success: true }> {
  await requireStaffAuth();
  const { shipmentId, bandcampPaymentId } = setPaymentIdSchema.parse(raw);
  const serviceClient = createServiceRoleClient();

  const update: Record<string, unknown> = {
    bandcamp_payment_id: bandcampPaymentId,
    updated_at: new Date().toISOString(),
  };
  if (bandcampPaymentId === null) {
    update.bandcamp_synced_at = null;
  }

  const { error } = await serviceClient
    .from("warehouse_shipments")
    .update(update)
    .eq("id", shipmentId);

  if (error) throw new Error(`Failed to update shipment: ${error.message}`);
  return { success: true };
}

export async function triggerBandcampMarkShipped(raw: {
  shipmentId: string;
}): Promise<{ taskRunId: string }> {
  await requireStaffAuth();
  const { shipmentId } = triggerSyncSchema.parse(raw);
  const serviceClient = createServiceRoleClient();

  const { data: shipment } = await serviceClient
    .from("warehouse_shipments")
    .select("id, bandcamp_payment_id, tracking_number")
    .eq("id", shipmentId)
    .single();

  if (!shipment) throw new Error("Shipment not found");
  if (!shipment.bandcamp_payment_id) throw new Error("Shipment has no Bandcamp payment ID");
  if (!shipment.tracking_number) throw new Error("Shipment has no tracking number");

  const { tasks } = await import("@trigger.dev/sdk");
  const handle = await tasks.trigger("bandcamp-mark-shipped", { shipmentId });

  return { taskRunId: handle.id };
}
```

---

## 4. Auth System

### 4.1 `src/lib/shared/constants.ts`

```typescript
export const STAFF_ROLES = [
  "admin",
  "super_admin",
  "label_staff",
  "label_management",
  "warehouse_manager",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const CLIENT_ROLES = ["client", "client_admin"] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];

export type UserRole = StaffRole | ClientRole;
```

### 4.2 `src/lib/server/auth-context.ts`

> Full file (175 lines) was read and verified during audit. Key exports: `requireAuth()`, `requireStaff()`, `requireClient()`, `getAuthUser()`, `getOrCreateUserRecord()`, `getAllWorkspaceIds()`.
>
> See the handoff document Issue HIGH-1 and FIX-M3 sections for the complete code.

---

## 5. Database Migrations

### 5.1 `supabase/migrations/20260316000002_products.sql`

```sql
-- Migration 002: Products and variants
-- Rule #31: SKU uniqueness per workspace via UNIQUE(workspace_id, sku)

CREATE TABLE warehouse_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  shopify_product_id text,
  title text NOT NULL,
  vendor text,
  product_type text,
  status text DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  tags text[] DEFAULT '{}',
  shopify_handle text,
  images jsonb DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);
CREATE INDEX idx_warehouse_products_org ON warehouse_products(org_id);
CREATE INDEX idx_warehouse_products_workspace ON warehouse_products(workspace_id);
CREATE INDEX idx_warehouse_products_shopify_id ON warehouse_products(shopify_product_id);

CREATE TABLE warehouse_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES warehouse_products(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sku text NOT NULL,
  shopify_variant_id text,
  title text,
  price numeric,
  compare_at_price numeric,
  barcode text,
  weight numeric,
  weight_unit text DEFAULT 'lb',
  option1_name text,
  option1_value text,
  format_name text,
  street_date date,
  is_preorder boolean DEFAULT false,
  bandcamp_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, sku)
);
CREATE INDEX idx_variants_product ON warehouse_product_variants(product_id);
CREATE INDEX idx_variants_sku ON warehouse_product_variants(workspace_id, sku);
CREATE INDEX idx_variants_shopify ON warehouse_product_variants(shopify_variant_id);
CREATE INDEX idx_variants_barcode ON warehouse_product_variants(barcode);
```

### 5.2 `supabase/migrations/20260316000003_inventory.sql`

```sql
-- Migration 003: Inventory levels, locations, variant locations
-- Rule #21: org_id auto-derived by DB trigger from variant -> product -> org

CREATE TABLE warehouse_inventory_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL UNIQUE REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid REFERENCES organizations(id),
  sku text NOT NULL,
  available integer NOT NULL DEFAULT 0,
  committed integer NOT NULL DEFAULT 0,
  incoming integer NOT NULL DEFAULT 0,
  last_redis_write_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_levels_sku ON warehouse_inventory_levels(workspace_id, sku);
CREATE INDEX idx_inventory_levels_org ON warehouse_inventory_levels(org_id);

CREATE OR REPLACE FUNCTION derive_inventory_org_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT wp.org_id INTO NEW.org_id
  FROM warehouse_product_variants wpv
  JOIN warehouse_products wp ON wp.id = wpv.product_id
  WHERE wpv.id = NEW.variant_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_derive_inventory_org_id
  BEFORE INSERT OR UPDATE ON warehouse_inventory_levels
  FOR EACH ROW
  EXECUTE FUNCTION derive_inventory_org_id();

CREATE TABLE warehouse_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  barcode text,
  location_type text NOT NULL CHECK (location_type IN ('shelf', 'bin', 'floor', 'staging')),
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);

CREATE TABLE warehouse_variant_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES warehouse_locations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  quantity integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(variant_id, location_id)
);
```

### 5.3 `supabase/migrations/20260401000001_inventory_hardening.sql`

```sql
-- Inventory hardening: safety buffer, floor enforcement

ALTER TABLE warehouse_inventory_levels
  ADD COLUMN IF NOT EXISTS safety_stock integer CHECK (safety_stock >= 0),
  ADD COLUMN IF NOT EXISTS allow_negative_stock boolean NOT NULL DEFAULT false;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS default_safety_stock integer NOT NULL DEFAULT 3
    CHECK (default_safety_stock >= 0);

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
  v_allow_neg boolean;
BEGIN
  SELECT allow_negative_stock INTO v_allow_neg
  FROM warehouse_inventory_levels
  WHERE workspace_id = p_workspace_id AND sku = p_sku;

  UPDATE warehouse_inventory_levels
  SET available = available + p_delta,
      updated_at = now(),
      last_redis_write_at = now()
  WHERE workspace_id = p_workspace_id
    AND sku = p_sku
    AND (v_allow_neg = true OR (available + p_delta) >= 0)
  RETURNING available - p_delta, available INTO v_previous, v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory_floor_violation: workspace=% sku=% delta=%',
      p_workspace_id, p_sku, p_delta
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO warehouse_inventory_activity (
    id, workspace_id, sku, delta, source, correlation_id,
    previous_quantity, new_quantity, metadata
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_sku, p_delta, p_source,
    p_correlation_id, v_previous, v_new, p_metadata
  ) ON CONFLICT (sku, correlation_id) DO NOTHING;

  RETURN jsonb_build_object('previous', v_previous, 'new', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 5.4 `supabase/migrations/20260401000002_bundle_components.sql`

```sql
-- Bundle/kit component tracking

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS bundles_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bundle_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bundle_variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  component_variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bundle_variant_id, component_variant_id),
  CHECK (bundle_variant_id != component_variant_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_components_bundle
  ON bundle_components(bundle_variant_id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_component
  ON bundle_components(component_variant_id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_workspace
  ON bundle_components(workspace_id);

ALTER TABLE bundle_components ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bundle_components_workspace ON bundle_components;

CREATE POLICY bundle_components_workspace ON bundle_components
  USING (workspace_id = (
    SELECT workspace_id FROM users WHERE auth_user_id = auth.uid() LIMIT 1
  ));
```

### 5.5 `supabase/migrations/20260316000009_rls.sql`

> Full file (227 lines) covering RLS policies for all tables. See the handoff document for the complete contents. Key policies:
>
> - `is_staff_user()` — checks `users.role IN ('admin','super_admin','label_staff','label_management','warehouse_manager')`
> - `get_user_org_id()` — returns `users.org_id WHERE auth_user_id = auth.uid()`
> - Staff: `FOR ALL` on every table
> - Client: `FOR SELECT` on org-scoped tables using `org_id = get_user_org_id()`
> - `portal_admin_settings`: **client_select only (no INSERT/UPDATE)** — root cause of HIGH-2
> - `warehouse_inventory_activity`: **staff-only** — clients cannot see audit trail

---

## Cross-Reference: Inventory Audit → Code Locations

| Audit Issue | Primary File | Line(s) | Function |
|-------------|-------------|---------|----------|
| CRIT-1 (34.5% untracked) | `shopify-sync.ts` | 187-188 | `upsertProductsBulk` |
| CRIT-2 (ID hack) | `shopify-sync.ts` | 312-317 | `upsertInventoryBulk` |
| CRIT-3 (no Shopify push) | N/A (data gap) | N/A | `client_store_connections` table |
| CRIT-4 (inbound no level) | `inbound-product-create.ts` | 117-147 | `inboundProductCreate` |
| CRIT-5 (workspace scoping) | `inventory.ts` | 274, 310-325 | `getInventoryDetail`, `updateInventoryBuffer` |
| HIGH-1 (cross-org search) | `catalog.ts` | 108-145 | `searchProductVariants` |
| HIGH-2 (broken prefs) | `portal-settings.ts` | 39-73 | `updateNotificationPreferences` |
| M4 (backfill dead code) | `redis-backfill.ts` | 85 | `mismatches: 0` |
| M5 (safety_stock query) | `inventory.ts` | varies | `getInventoryLevels`, `getClientInventoryLevels` |
