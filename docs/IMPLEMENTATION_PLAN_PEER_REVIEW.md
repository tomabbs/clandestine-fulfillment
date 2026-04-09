# CLANDESTINE_IMPLEMENTATION_PLAN_FINAL.md — Peer Review + Codebase Annotations

**Reviewer:** Cursor AI with full codebase access  
**Date:** 2026-03-23  
**Purpose:** This document is structured for handoff to another Claude instance for plan strengthening. It contains (1) the codebase context brief that Claude won't have, (2) the original plan annotated inline with issues and suggestions, and (3) a consolidated issue list.

---

## SECTION 0: CODEBASE CONTEXT BRIEF

**Read this before reviewing the plan.** These are facts about the existing codebase that the plan was written without.

### App Architecture

- **Two portals, not one:** All staff operations are under `src/app/admin/`**. All client-facing pages are under `src/app/portal/**`. There is NO `src/app/(dashboard)/` route group — that path does not exist in this project.
- **Auth pattern:** All server actions use `requireAuth()` from `src/lib/server/auth-context.ts`. This reads the Supabase session cookie, looks up the user record in the `users` table, and returns `{ userRecord, isStaff }`.
- **Query pattern:** All client-side data fetching uses `useAppQuery`/`useAppMutation` from `src/lib/hooks/use-app-query.ts`. Raw `fetch()` or `useEffect` data loading is a pattern violation.

### The Two Shopify Contexts (Critical)

1. **Clandestine's own Shopify** (`SHOPIFY_STORE_URL`, `SHOPIFY_ADMIN_API_TOKEN` in env): This is Clandestine's warehouse master store. Bandcamp product data is scraped → products created in this Shopify → becomes master inventory for the warehouse. Handled by `shopify-sync`, `shopify-full-backfill` Trigger tasks and the `src/lib/clients/shopify-client.ts` GraphQL client. **DO NOT TOUCH.**
2. **Client store connections** (`client_store_connections` table): Each fulfillment client (e.g., Northern Spy, Egghunt) may have their own separate Shopify, Squarespace, or WooCommerce store. Orders flow in FROM those stores and inventory is pushed TO those stores. This is what the plan is about. Handled by `store-sync-client.ts`, `multi-store-inventory-push` Trigger task, `client-store-order-detect` Trigger task.

### What Is Already Fully Built (DO NOT REBUILD)


| Feature                                   | Files                                                              | Status                             |
| ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| `client_store_connections` DB schema      | `supabase/migrations/20260316000011_store_connections.sql`         | ✅ Complete                         |
| Staff admin UI for connections            | `src/app/admin/settings/store-connections/page.tsx`                | ✅ Complete                         |
| Credential storage (secure, service-role) | `src/actions/client-store-credentials.ts`                          | ✅ Complete                         |
| Shopify client-store sync engine          | `src/lib/clients/store-sync-client.ts` — `createShopifySync()`     | ✅ Complete                         |
| WooCommerce client-store sync engine      | `src/lib/clients/store-sync-client.ts` — `createWooCommerceSync()` | ✅ Complete                         |
| Squarespace client-store sync engine      | `src/lib/clients/store-sync-client.ts` — `createSquarespaceSync()` | ✅ Complete                         |
| Client-store webhook ingress              | `src/app/api/webhooks/client-store/route.ts`                       | ✅ Complete                         |
| Inventory push cron (every 5 min)         | `src/trigger/tasks/multi-store-inventory-push.ts`                  | ✅ Complete                         |
| Order detection cron (every 10 min)       | `src/trigger/tasks/client-store-order-detect.ts`                   | ✅ Complete                         |
| AfterShip API client                      | `src/lib/clients/aftership-client.ts`                              | ✅ Complete                         |
| AfterShip registration Trigger task       | `src/trigger/tasks/aftership-register.ts`                          | ✅ Wired but missing customer email |
| AfterShip webhook receiver                | `src/app/api/webhooks/aftership/route.ts`                          | ✅ Complete                         |
| Tracking event storage                    | `warehouse_tracking_events` table (in migrations)                  | ✅ Complete                         |
| Tracking timeline UI                      | `src/components/shared/tracking-timeline.tsx`                      | ✅ Complete                         |
| Bandcamp order sync                       | `src/trigger/tasks/bandcamp-order-sync.ts`                         | ✅ Complete                         |
| Bandcamp mark-shipped (with tracking)     | `src/trigger/tasks/bandcamp-mark-shipped.ts`                       | ✅ Complete                         |
| Pirate Ship label import                  | `src/trigger/tasks/pirate-ship-import.ts`                          | ✅ Complete (CSV import)            |


### Critical Type Definitions (in `src/lib/shared/types.ts`)

```typescript
export type StorePlatform = "shopify" | "woocommerce" | "squarespace" | "bigcommerce";
export type OrderSource = "shopify" | "bandcamp" | "woocommerce" | "squarespace" | "manual";
```

**Discogs is not in either type.** Any Discogs implementation will fail TypeScript checks unless these are updated first.

### Environment Variables in `src/lib/shared/env.ts`

The following env vars are validated at runtime via Zod schema. Any new variable that code tries to use via `env()` must first be added to `serverEnvSchema` or the app will throw on startup.

**Currently validated:** SUPABASE, TRIGGER, REDIS, SENTRY, SHOPIFY (warehouse), SHIPSTATION, AFTERSHIP, STRIPE, BANDCAMP, RESEND, APP_URL.

**NOT validated (exist in `.env.local` but not in schema):** `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`. Any OAuth code using these will silently read from `process.env` without type safety — or crash if referenced via `env()`.

### Middleware Public Path Rules (`middleware.ts`)

```typescript
const PUBLIC_PATHS = ["/login", "/auth/callback", "/api/health", "/terms", "/privacy"];

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/api/webhooks/")) return true;  // ALL webhooks are public
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
```

OAuth callback routes like `/api/shopify/callback` do NOT match `/api/webhooks/` and are NOT in `PUBLIC_PATHS`. They will redirect to `/login`. This is a bug if not addressed.

---

## SECTION 1: ANNOTATED PLAN

---

### Part 1: Platform Authentication — Annotated

> **Plan says:** Shopify Partners — ✅ COMPLETE with App URL `https://cpanel.clandestinedistro.com/api/shopify/auth` and Redirect URL `/api/shopify/callback`.

**⚠️ ISSUE [HIGH]: These routes do not exist in the codebase.** There is no `src/app/api/shopify/auth/route.ts` or `src/app/api/shopify/callback/route.ts`. The plan marks Shopify as "COMPLETE" but only the Shopify Partners developer app registration may be complete. The actual OAuth redirect routes are zero lines of code in the repo. The plan is misleading here — implementation has not started.

**💡 SUGGESTION:** Change "✅ COMPLETE" to "✅ REGISTERED (routes not yet implemented)" to avoid confusion for any implementer reading this.

---

> **Plan says:** WooCommerce — ✅ No registration needed. Uses built-in `/wc-auth/v1/authorize` endpoint.

**ℹ️ CONTEXT NOTE:** This is architecturally correct. WooCommerce's built-in OAuth 1.0a does not require registering with a central developer portal. However, the callback URL (`/api/woocommerce/callback`) must be passed in the authorization request, and the client's WooCommerce site will redirect to it after approval. The callback URL itself must be HTTPS. No route exists yet.

**⚠️ ISSUE [MEDIUM]:** WooCommerce OAuth 1.0a callback delivers credentials as query parameters in a `GET` redirect, not a `POST`. The callback route must handle `GET`, not `POST`. Many OAuth implementations get this wrong.

---

> **Plan says:** Squarespace OAuth — ⏳ SUBMITTED. Tokens expire in 30 min — refresh required.

**⚠️ ISSUE [HIGH]: Token refresh is not modeled in the existing schema.** The `client_store_connections` table has `api_key` and `api_secret` but no `refresh_token` column, no `token_expires_at` column. Squarespace tokens expire every 30 minutes and require a refresh token grant. Without these columns, Squarespace connections will silently fail after the first 30-minute window. The migration for `token_expires_at` is mentioned in the plan's Part 3, but `refresh_token` is missing entirely.

**💡 SUGGESTION:** Add `refresh_token text` column to the `client_store_connections` migration. Add a Trigger task or inline refresh logic in `store-sync-client.ts` that checks `token_expires_at` and refreshes before any Squarespace API call.

---

> **Plan says:** Discogs — 🔲 NEEDS REGISTRATION. OAuth 1.0a flow.

**⚠️ ISSUE [CRITICAL]: Discogs is not in `StorePlatform` type.** The TypeScript union `StorePlatform = "shopify" | "woocommerce" | "squarespace" | "bigcommerce"` does not include `"discogs"`. Any code that stores a Discogs connection with `platform: "discogs"` will cause TypeScript errors across the entire codebase. Similarly, `OrderSource` doesn't include `"discogs"`. Both types must be updated as a precondition.

**⚠️ ISSUE [MEDIUM]: Discogs OAuth 1.0a is a significantly different implementation from Shopify/Squarespace OAuth 2.0.** It uses request tokens, verifier codes, and a three-legged flow. The shared `src/lib/oauth/index.ts` utility proposed in the plan cannot abstract both OAuth 2.0 and OAuth 1.0a cleanly. Discogs needs its own implementation.

**💡 SUGGESTION:** Defer Discogs to a separate phase. Add `"discogs"` to `StorePlatform` and `OrderSource` types as a precondition step, implement schema support, but build the OAuth and sync logic separately after Shopify/WooCommerce/Squarespace are stable.

---

> **Plan says:** Bandcamp — ✅ Manual (no OAuth). Add `fulfillment@clandestinedistribution.com` as fulfillment partner.

**ℹ️ CONTEXT NOTE:** Bandcamp is already fully integrated via the Bandcamp Merch Orders API. `bandcamp-order-sync` polls for orders every 6 hours. `bandcamp-mark-shipped` pushes tracking back to Bandcamp. `bandcamp-sale-poll` runs every 5 minutes. Bandcamp connections are stored in the `bandcamp_connections` table (separate from `client_store_connections`). The onboarding wizard for Bandcamp should be purely instructional — no OAuth or API keys needed.

---

### Part 2: Shipping Stack — Annotated

> **Plan says:** EasyPost — Single API for Everything (domestic Media Mail + international Asendia).

**ℹ️ CONTEXT NOTE:** EasyPost is completely absent from the codebase. There is no `easypost-client.ts`, no EasyPost env var in `env.ts`, no `shipping_labels` table, no label creation server action. The current label creation flow is: ShipStation creates labels externally → webhook fires → `shipment-ingest` task creates `warehouse_shipments` row → `aftership-register` registers tracking. EasyPost would add an IN-APP label creation path as an alternative/supplement.

**⚠️ ISSUE [HIGH]: EasyPost would represent a parallel shipment creation path that bypasses ShipStation.** The existing flow assumes all shipments enter via ShipStation webhook. If EasyPost creates a shipment directly, it needs to either: (a) create a `warehouse_shipments` row directly, or (b) still go through ShipStation (not useful). The plan needs to specify exactly how EasyPost-created shipments write to the DB and trigger AfterShip registration.

**💡 SUGGESTION:** Proposed integration flow for EasyPost label creation:

1. Staff selects order in UI → clicks "Create Label" → server action calls EasyPost API
2. EasyPost returns label URL + tracking number
3. Server action creates `shipping_labels` row (new table)
4. Server action creates or updates `warehouse_shipments` row with `tracking_number`, `carrier`, `service`, `shipping_cost`, `label_data`
5. Server action triggers `aftership-register` Trigger task with `shipment_id`
6. `aftership-register` registers tracking + (patched) notifies customer via email

---

> **Plan says:** `shipping_tracking_events` table — new table to create.

**⚠️ ISSUE [CRITICAL]: This table already exists as `warehouse_tracking_events`.** Creating `shipping_tracking_events` would be a duplicate. The existing table schema:

```sql
-- From migrations:
warehouse_tracking_events (
  id, shipment_id, workspace_id, status, description, 
  location, event_time, source, created_at
)
```

The `source` column already distinguishes between `"aftership"` and other sources. EasyPost webhook events should write to `warehouse_tracking_events` with `source: "easypost"`.

**💡 SUGGESTION:** Remove `shipping_tracking_events` from Part 3. Replace all references in the plan with `warehouse_tracking_events`. Update the EasyPost webhook handler design accordingly.

---

> **Plan says:** Pirate Ship — Manual Fallback Only.

**ℹ️ CONTEXT NOTE:** Pirate Ship is already built as a CSV import tool (`pirate-ship-import` Trigger task, `src/actions/pirate-ship.ts`). It imports historical shipment CSVs from Pirate Ship into `warehouse_shipments`. The "per-client configuration" SQL in the plan (`shipping_preferences` on `organizations`) is new and does not exist. The international fallback flag logic would need to be implemented in the order processing pipeline.

---

### Part 3: Database Schema — Annotated

> **Plan says:** New table `oauth_states`.

**✅ ASSESSMENT: Correct and necessary.** No issues with this table design. One addition: add `platform` to the index since it will be queried alongside state for validation.

**💡 SUGGESTION:** Also add `attempted_at timestamptz` to support rate-limiting OAuth initiation attempts per org.

---

> **Plan says:** `ALTER TABLE client_store_connections ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;`

**⚠️ ISSUE [HIGH]: Missing `refresh_token` column.** Squarespace issues both an access token (30-min expiry) and a refresh token. Without storing the refresh token, token refresh is impossible and Squarespace connections will break after 30 minutes permanently.

**💡 SUGGESTION:** Add `refresh_token text` column in the same migration.

---

> **Plan says:** New table `shipping_labels`.

**✅ ASSESSMENT: Correct and necessary.** This is a new concept — the current `warehouse_shipments` table's `label_data jsonb` is unstructured data from ShipStation. A dedicated `shipping_labels` table for EasyPost-generated labels is the right design.

**⚠️ ISSUE [MEDIUM]:** The `shipping_labels` table has `order_id uuid REFERENCES warehouse_orders(id)` but no `shipment_id` back-reference. When an EasyPost label is created, it should eventually link to a `warehouse_shipments` row. Without `shipment_id`, there's no way to link the label to the tracking/status machinery.

**💡 SUGGESTION:** Add `shipment_id uuid REFERENCES warehouse_shipments(id)` (nullable, set after the shipment row is created). Also add `org_id uuid REFERENCES organizations(id)` for RLS and billing traceability.

---

> **Plan says:** `shipping_tracking_events` table.

**⚠️ ISSUE [CRITICAL]: REMOVE THIS TABLE.** See annotation in Part 2. `warehouse_tracking_events` already exists and serves this exact purpose. Adding a second table for the same data will create inconsistency across the tracking timeline UI.

---

> **Plan says:** No RLS section for `shipping_labels`.

**⚠️ ISSUE [HIGH]:** `shipping_labels` has `ALTER TABLE shipping_labels ENABLE ROW LEVEL SECURITY;` in the schema block, but no policies are defined. Without policies, the table is locked out to all users. Add at minimum a staff-all policy and a client-select-own-org policy (matching the pattern from `warehouse_shipments`).

---

### Part 4: Client Onboarding Wizard — Annotated

> **Plan says:** Route at `src/app/(dashboard)/onboarding/page.tsx`.

**⚠️ ISSUE [CRITICAL]: This route path does not exist in this app.** The Next.js app uses `src/app/admin/` for staff and `src/app/portal/` for clients. There is no `(dashboard)` route group. The onboarding wizard is a client-facing feature (clients connect their own stores), so it belongs in `src/app/portal/onboarding/page.tsx`.

**💡 SUGGESTION:** Replace all references to `(dashboard)` with the correct paths:

- Onboarding wizard: `src/app/portal/onboarding/page.tsx`
- Connected stores settings: `src/app/portal/settings/stores/page.tsx`

Also note: The middleware guards `/portal/`* to require `client` or `client_admin` roles. This is correct behavior for a self-service onboarding page.

---

> **Plan says:** `src/app/(dashboard)/layout.tsx` — Add onboarding check.

**⚠️ ISSUE [HIGH]:** This file doesn't exist. The portal layout is `src/app/portal/layout.tsx`. Any onboarding redirect logic should be added there, gated by `onboarding_completed_at IS NULL` on the org.

**💡 SUGGESTION:** The redirect logic should check: if the client's organization has `onboarding_completed_at IS NULL` AND the user is not already on `/portal/onboarding`, redirect to `/portal/onboarding`. This check belongs in the portal layout server component, not in `middleware.ts` (which doesn't have DB access at the right layer).

---

### Part 5: Order-to-Label Data Flow — Annotated

> **Plan says:** AfterShip sends branded tracking page email to customer.

**⚠️ ISSUE [HIGH]: Customer email is not currently passed to AfterShip.** The `aftership-register` Trigger task calls:

```typescript
const tracking = await createTracking(shipment.tracking_number, shipment.carrier, {
  title: `Shipment ${shipment.id}`,
  orderId: shipment.order_id,
});
```

The `createTracking` function signature accepts `metadata` with `title` and `orderId` but NOT `customer_email`. AfterShip's API supports `customer_name` and `emails` fields in the tracking creation payload, but these are not passed. Without the customer email, AfterShip cannot send tracking notification emails to customers.

**💡 SUGGESTION:** Patch `aftership-register.ts` to:

1. Join `warehouse_orders` to get customer email from `label_data.shipTo.email` or a future dedicated column
2. Pass `customer_email` to `createTracking`

Also patch `src/lib/clients/aftership-client.ts` to accept and pass an `emails` array in the tracking creation payload.

---

> **Plan says:** Push tracking back to source platform (mark order shipped).

**ℹ️ CONTEXT NOTE:** This is already implemented for Bandcamp. `bandcamp-mark-shipped` pushes tracking to Bandcamp via `updateShipped()`. For Shopify client stores, fulfillment creation via the REST API is not yet implemented (the `createShopifySync` in `store-sync-client.ts` handles inventory and orders but not fulfillment marking). For WooCommerce and Squarespace, order status update/fulfillment is also not implemented. This is a genuine gap not addressed by the current plan text.

**💡 SUGGESTION:** Add a section to the plan specifically for "Mark Order Fulfilled" per platform — this is a distinct operation from inventory sync and order import. Each platform needs: Shopify → POST `/admin/api/2024-01/orders/{id}/fulfillments.json`, WooCommerce → PUT `/orders/{id}` with `status: "completed"`, Squarespace → PATCH `/commerce/orders/{id}`.

---

### Part 7: Environment Variables — Annotated

> **Plan says:** List of env vars to add.

**⚠️ ISSUE [HIGH]: None of these new variables are in `src/lib/shared/env.ts`.** The `serverEnvSchema` Zod object validates all env vars on app startup. If any code uses `env().EASYPOST_API_KEY` without adding it to the schema first, the app will throw a runtime error. If code reads `process.env.EASYPOST_API_KEY` directly (bypassing `env()`), it loses type safety and validation.

**💡 SUGGESTION:** Every new env var must be added to `serverEnvSchema` in `src/lib/shared/env.ts` as a precondition to any code that references it. Add to the checklist:

```typescript
// Add to serverEnvSchema:
SHOPIFY_CLIENT_ID: z.string().min(1),
SHOPIFY_CLIENT_SECRET: z.string().min(1),
SQUARESPACE_CLIENT_ID: z.string().optional(),   // pending approval
SQUARESPACE_CLIENT_SECRET: z.string().optional(),
DISCOGS_CONSUMER_KEY: z.string().optional(),
DISCOGS_CONSUMER_SECRET: z.string().optional(),
EASYPOST_API_KEY: z.string().min(1),
EASYPOST_TEST_API_KEY: z.string().min(1),
EASYPOST_WEBHOOK_SECRET: z.string().min(1),
```

---

### Part 8: Implementation Checklist — Annotated

> **Plan says:** Phase 1: OAuth Implementation — Implement Shopify, WooCommerce, Squarespace, Discogs OAuth routes.

**⚠️ ISSUE [HIGH]: Middleware is not in Phase 1 checklist.** OAuth callback routes will be blocked by middleware and redirect to `/login` unless middleware is patched first. This should be the first step in Phase 1, before any routes are built.

**💡 SUGGESTION:** Add as Phase 1 Day 0 step:

- Patch `middleware.ts` `PUBLIC_PATHS` to include `/api/shopify/callback`, `/api/woocommerce/callback`, `/api/squarespace/callback`, `/api/discogs/callback` — or use a more general pattern like `pathname.startsWith("/api/") && pathname.endsWith("/callback")`.

---

> **Plan says:** Phase 1 — Implement shared OAuth utilities (`src/lib/oauth/index.ts`).

**⚠️ ISSUE [MEDIUM]:** OAuth 2.0 (Shopify, Squarespace) and OAuth 1.0a (WooCommerce, Discogs) are different enough that a shared utility would be thin. Shopify and Squarespace share the same basic pattern (redirect → code exchange → access token). WooCommerce uses a GET redirect with credentials in the URL. Discogs uses OAuth 1.0a with request tokens and HMAC-SHA1 signatures.

**💡 SUGGESTION:** Create `src/lib/oauth/oauth2.ts` for Shopify/Squarespace flows and `src/lib/oauth/woocommerce-oauth.ts` for WooCommerce. Keep Discogs isolated in `src/lib/oauth/discogs-oauth.ts`. A thin `src/lib/oauth/index.ts` can export shared utilities like `generateState()` and `verifyState()` against the `oauth_states` table.

---

### Part 9: Files to Create/Modify — Annotated

> **Plan says:** `src/app/(dashboard)/...` paths throughout.

**⚠️ ISSUE [CRITICAL]:** This route group does not exist. See Part 4 annotation. Replace all `(dashboard)` references with `admin` (for staff) or `portal` (for clients).

---

> **Plan says:** `src/actions/shipping.ts` — Shipping server actions (listed under "Files to Modify").

**⚠️ ISSUE [HIGH]: This file already exists** with `getShipments`, `getShipmentsSummary`, `getShipmentDetail`, `exportShipmentsCsv`. Adding EasyPost-specific server actions to this file would bloat it and mix concerns. The existing `shipping.ts` is a read-oriented file for querying shipment history.

**💡 SUGGESTION:** Create a new `src/actions/label-creation.ts` (or `src/actions/easypost.ts`) for EasyPost-specific mutations: `createDomesticLabel`, `createInternationalLabel`, `getRates`. Keep `src/actions/shipping.ts` read-only as it is.

---

> **Plan says:** No mention of updating `src/lib/shared/types.ts`.

**⚠️ ISSUE [CRITICAL]:** Adding Discogs as a platform requires updating:

- `StorePlatform` union type (line 41)
- `OrderSource` union type (line 30)

Without these updates, TypeScript will reject any Discogs connection records. These type updates are a hard prerequisite that should be in Phase 1 Day 0 along with the schema migrations.

---

## SECTION 2: CONSOLIDATED ISSUE LIST

### 🔴 CRITICAL (Blocks implementation)


| #   | Issue                                                                          | Location in Plan  |
| --- | ------------------------------------------------------------------------------ | ----------------- |
| C1  | `shipping_tracking_events` table already exists as `warehouse_tracking_events` | Part 3, Part 5    |
| C2  | `StorePlatform` and `OrderSource` types don't include `"discogs"`              | Part 1, Part 9    |
| C3  | App routing uses `admin/` and `portal/`, not `(dashboard)/`                    | Parts 4, 9        |
| C4  | Middleware does not allow OAuth callback routes — they redirect to login       | Phase 1 checklist |
| C5  | `shipping_labels` table has no RLS policies defined                            | Part 3            |


### 🟠 HIGH (Will cause failures if not addressed)


| #   | Issue                                                                                                            | Location in Plan |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| H1  | Shopify OAuth marked "COMPLETE" — routes don't exist                                                             | Part 1           |
| H2  | `refresh_token` column missing from `client_store_connections` — Squarespace breaks after 30 min                 | Parts 1, 3       |
| H3  | Customer email not passed to AfterShip — branded tracking emails not sent                                        | Part 5           |
| H4  | New env vars not added to `serverEnvSchema` in `env.ts`                                                          | Part 7           |
| H5  | EasyPost-created shipments need explicit flow to write to `warehouse_shipments` and trigger `aftership-register` | Part 5           |
| H6  | `src/actions/shipping.ts` already exists with different exports — naming conflict                                | Part 9           |
| H7  | `shipping_labels` has no `org_id` or `shipment_id` back-reference                                                | Part 3           |
| H8  | No plan for marking orders "fulfilled" back on source platforms after shipping                                   | Part 5           |


### 🟡 MEDIUM (Should be addressed before implementation)


| #   | Issue                                                                                       | Location in Plan  |
| --- | ------------------------------------------------------------------------------------------- | ----------------- |
| M1  | WooCommerce OAuth callback must be GET not POST                                             | Part 1            |
| M2  | Discogs OAuth 1.0a cannot share a utility with OAuth 2.0                                    | Phase 1 checklist |
| M3  | Portal layout (`portal/layout.tsx`) needs onboarding redirect, not `(dashboard)/layout.tsx` | Part 4            |
| M4  | Discogs should be deferred — adds significant complexity for unclear volume                 | Part 1            |


### 🔵 INFORMATIONAL (No code change needed, plan text should clarify)


| #   | Issue                                                                                          | Location in Plan    |
| --- | ---------------------------------------------------------------------------------------------- | ------------------- |
| I1  | Bandcamp is already fully integrated — no new work needed                                      | Part 1              |
| I2  | Pirate Ship is already built as a CSV import tool                                              | Part 2              |
| I3  | AfterShip tracking webhook, timeline UI, and `warehouse_tracking_events` are already built     | Part 5              |
| I4  | `store-sync-client.ts` Shopify, WooCommerce, Squarespace engines are already fully implemented | Implicit throughout |


---

## SECTION 3: SUGGESTED ADDITIONS TO PLAN

### Addition 1: "Mark Order Fulfilled" Per-Platform

After a label is created and tracking confirmed, each source platform needs the order marked as shipped. This is not in the current plan but is necessary for end-to-end fulfillment. Required per platform:

- **Shopify:** POST `/admin/api/2024-01/orders/{order_id}/fulfillments.json` with tracking number and carrier
- **WooCommerce:** PUT `/orders/{order_id}` with `status: "completed"` and order notes
- **Squarespace:** Squarespace does not have a fulfillment API as of 2024 — only email notification is possible via AfterShip branded page
- **Bandcamp:** Already implemented via `bandcamp-mark-shipped` task
- **Discogs:** PUT `/marketplace/orders/{order_id}` with `status: "Shipped"` and tracking

### Addition 2: Token Refresh Architecture for Squarespace

Since Squarespace access tokens expire in 30 minutes, add:

1. `refresh_token text` column on `client_store_connections`
2. A `refreshSquarespaceToken(connectionId)` utility function
3. Call it inline in `createSquarespaceSync()` in `store-sync-client.ts` before any API call if `token_expires_at < now() + 5 minutes`
4. On failure, set `connection_status: "disabled_auth_failure"` and create review queue item

### Addition 3: EasyPost Integration into Existing Shipment Pipeline

Precise data flow for EasyPost label creation (not in current plan):

```
Staff clicks "Create Label" on order detail page
  → calls createDomesticLabel(orderId) or createInternationalLabel(orderId) server action
  → action reads order from warehouse_orders (customer address, items, weight)
  → action calls EasyPost API → gets label URL + tracking number
  → action creates shipping_labels row (new)
  → action creates warehouse_shipments row (same table as ShipStation shipments)
  → action triggers aftership-register Trigger task with shipment_id
  → aftership-register registers tracking with customer email (patched)
  → AfterShip sends branded tracking email to customer
  → EasyPost webhook updates warehouse_tracking_events (source: "easypost")
  → UI shows tracking timeline (already built)
```

### Addition 4: Phase 0 — Preconditions Checklist

Before any Phase 1 code:

1. Add Discogs to `StorePlatform` and `OrderSource` types (`src/lib/shared/types.ts`)
2. Add new env vars to `serverEnvSchema` (`src/lib/shared/env.ts`)
3. Patch `middleware.ts` to allow OAuth callback routes
4. Write and apply DB migration for: `oauth_states` table, `refresh_token` column on `client_store_connections`, `token_expires_at` column on `client_store_connections`, `onboarding_completed_at` on `organizations`, `shipping_preferences` on `organizations`
5. Patch `aftership-register.ts` to pass customer email to `createTracking`

---

## SECTION 4: QUESTIONS FOR PLAN OWNER TO ANSWER

Before the next review iteration:

1. **International shipping via EasyPost vs Pirate Ship:** The plan describes both. What is the threshold for manual Pirate Ship fallback? Is it per-client config or global? Who sets `use_international_fallback: true` — staff or client?
2. **Discogs priority:** Is there enough Discogs order volume to warrant the complexity of OAuth 1.0a + a new platform? If < 5% of orders, recommend deferring to Phase 5+.
3. **Client onboarding — who initiates?** Does the client self-connect (portal-side onboarding wizard), or does staff set up connections on behalf of clients (admin-side), or both? The current admin UI already allows staff to create connections manually.
4. **Label creation UI:** Where in the admin UI does staff create labels? On the order detail page? On a dedicated shipping/fulfillment page? This affects which pages need new UI components.
5. **Customer-facing tracking page:** AfterShip provides a hosted branded tracking page. Is the AfterShip page sufficient, or should there be a tracking page at a custom subdomain (e.g., `track.clandestinedistribution.com`)?
6. **WooCommerce and Squarespace order volume:** These platforms require separate polling. Are any current clients on WooCommerce or Squarespace, or is this future-proofing?

