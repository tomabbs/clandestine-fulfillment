---
name: Shipping API + Client Auth Gap Report
overview: Audit of CLANDESTINE_IMPLEMENTATION_PLAN_FINAL.md shipping API and client platform auth sections against what is already built, with technical integration notes for each gap.
todos:
  - id: auth-email-patch
    content: Patch aftership-register.ts to pass customer email from linked order to createTracking call
    status: pending
  - id: oauth-migrations
    content: Create migration for oauth_states table and token_expires_at column on client_store_connections
    status: pending
  - id: shopify-oauth-routes
    content: Implement /api/shopify/auth and /api/shopify/callback — add SHOPIFY_CLIENT_ID/SECRET to env.ts, add callback to middleware PUBLIC_PATHS
    status: pending
  - id: woocommerce-oauth-routes
    content: Implement /api/woocommerce/auth and /api/woocommerce/callback using WooCommerce built-in OAuth
    status: pending
  - id: easypost-client
    content: Create src/lib/clients/easypost-client.ts with rate shopping, domestic Media Mail label, and international Asendia label
    status: pending
  - id: shipping-labels-migration
    content: Create migration for shipping_labels table and shipping_preferences column on organizations
    status: pending
  - id: easypost-actions-webhook
    content: Create createShippingLabel/getRates server actions and /api/webhooks/easypost handler
    status: pending
  - id: squarespace-oauth
    content: Implement Squarespace OAuth routes + token refresh logic (blocked on pending credentials)
    status: pending
  - id: onboarding-wizard
    content: Build client onboarding wizard at /portal/onboarding
    status: pending
  - id: doc-sync
    content: Update API_CATALOG.md, TRIGGER_TASK_CATALOG.md, engineering_map.yaml, journeys.yaml after implementation
    status: pending
isProject: false
---

# Shipping API + Client Platform Auth Flow — Gap Report

## Evidence Sources Read

- `/Users/tomabbs/Downloads/CLANDESTINE_IMPLEMENTATION_PLAN_FINAL.md` (the plan)
- `TRUTH_LAYER.md`, `docs/system_map/API_CATALOG.md`, `docs/system_map/TRIGGER_TASK_CATALOG.md`, `project_state/engineering_map.yaml`, `project_state/journeys.yaml`, `docs/RELEASE_GATE_CRITERIA.md`
- `src/actions/store-connections.ts`, `src/actions/client-store-credentials.ts`, `src/actions/shipping.ts`
- `src/lib/clients/aftership-client.ts`, `src/lib/clients/store-sync-client.ts`, `src/lib/clients/squarespace-client.ts`, `src/lib/clients/woocommerce-client.ts`
- `src/app/api/webhooks/aftership/route.ts`, `src/app/api/webhooks/client-store/route.ts`
- `src/trigger/tasks/aftership-register.ts`, `src/trigger/tasks/bandcamp-mark-shipped.ts`
- `supabase/migrations/20260316000004_orders.sql`, `supabase/migrations/20260316000011_store_connections.sql`
- `src/lib/shared/env.ts`, `middleware.ts`

---

## Part A — Client Platform Auth Flow

### What the Plan Wants

Full OAuth 2.0/1.0a redirect flows per platform: `/api/shopify/auth` + `/api/shopify/callback`, same for WooCommerce, Squarespace, Discogs. An `oauth_states` table for CSRF protection. A shared `src/lib/oauth/index.ts`. A client onboarding wizard at `/onboarding`.

### What Is Already Built

**The database and action layer are complete.** The `client_store_connections` table in [supabase/migrations/20260316000011_store_connections.sql](supabase/migrations/20260316000011_store_connections.sql) already has `platform`, `store_url`, `api_key`, `api_secret`, `webhook_secret`, `connection_status`, and health columns. The admin UI at [src/app/admin/settings/store-connections/page.tsx](src/app/admin/settings/store-connections/page.tsx) creates connections and shows test/disable buttons. [src/actions/client-store-credentials.ts](src/actions/client-store-credentials.ts) securely accepts `api_key`/`api_secret` from client users via service-role bypass.

**The sync engine is complete.** [src/lib/clients/store-sync-client.ts](src/lib/clients/store-sync-client.ts) has working Shopify (REST Admin API 2024-01 with `X-Shopify-Access-Token`), WooCommerce (Consumer Key/Secret), and Squarespace (Bearer API key) implementations — push inventory, get orders — all live, not stubbed. Trigger tasks `multi-store-inventory-push` (every 5 min) and `client-store-order-detect` (every 10 min) drive them.

**What does NOT exist:**


| Missing item                                            | Impact                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/lib/oauth/index.ts`                                | No shared OAuth utilities                                         |
| `/api/shopify/auth`, `/api/shopify/callback`            | No OAuth redirect flow                                            |
| `/api/woocommerce/auth`, `/api/woocommerce/callback`    | No OAuth redirect flow                                            |
| `/api/squarespace/auth`, `/api/squarespace/callback`    | No OAuth redirect flow                                            |
| `/api/discogs/auth`, `/api/discogs/callback`            | No Discogs integration at all                                     |
| `oauth_states` migration                                | No CSRF protection table                                          |
| `token_expires_at` column on `client_store_connections` | No token expiry tracking (critical for Squarespace 30-min tokens) |
| `onboarding_completed_at` on `organizations`            | No onboarding completion tracking                                 |
| Client onboarding wizard (`/portal/onboarding`)         | No self-service store connection UI                               |
| Discogs client library                                  | No Discogs API client                                             |


### Technical Integration Notes — Auth

**The current model is staff-managed credential entry, not client-initiated OAuth.** The plan assumes clients will self-connect. Both models can coexist: OAuth flows write the same `api_key`/`api_secret` columns the current manual model already uses.

`**SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`** already exist in `.env.local` but are NOT in [src/lib/shared/env.ts](src/lib/shared/env.ts) — they are not validated at startup. Any new OAuth code referencing these must add them to `serverEnvSchema`.

`**middleware.ts` must be patched** for OAuth callback routes. Currently only `/auth/callback` is public (line 6). New OAuth callback paths like `/api/shopify/callback` will redirect to login unless added to `PUBLIC_PATHS` or the `pathname.startsWith("/api/webhooks/")` guard is extended.

`**oauth_states` table is a new migration.** It must cascade-delete on `client_store_connections.id` (as shown in the plan schema). RLS should be staff-only.

**Squarespace tokens expire in 30 minutes** — the `token_expires_at` column and a refresh task (or inline refresh in `store-sync-client.ts`) are required before Squarespace OAuth is usable in production.

**WooCommerce OAuth 1.0a** (`/wc-auth/v1/authorize`) returns consumer key/secret as a redirect query param — these map directly into `api_key`/`api_secret`. No shared OAuth utility is needed; it's a one-shot redirect pattern.

---

## Part B — Shipping API (EasyPost)

### What the Plan Wants

EasyPost as the single shipping provider for domestic (USPS Media Mail) and international (USA Export / Asendia). New `shipping_labels` table. New `shipping_tracking_events` table. EasyPost client wrapper. Rate shopping. Label creation actions. EasyPost webhook handler at `/api/webhooks/easypost`. Pirate Ship as manual international fallback.

### What Is Already Built

**AfterShip tracking is fully wired.** [src/lib/clients/aftership-client.ts](src/lib/clients/aftership-client.ts) implements `createTracking` and `getTracking`. The `aftership-register` Trigger task fires after ShipStation ingest and registers tracking numbers. [src/app/api/webhooks/aftership/route.ts](src/app/api/webhooks/aftership/route.ts) receives status updates, writes to `warehouse_tracking_events`, and updates `warehouse_shipments.status`. [src/components/shared/tracking-timeline.tsx](src/components/shared/tracking-timeline.tsx) renders timeline events in the UI. This part of the plan is essentially done.

**Current label creation is external — ShipStation and Pirate Ship.** The app does NOT create labels today. Labels come in via ShipStation webhook (`shipment-ingest` task populates `warehouse_shipments`) or Pirate Ship CSV import. The `label_data jsonb` column on `warehouse_shipments` holds the raw label data from ShipStation.

**What does NOT exist:**


| Missing item                                    | Impact                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `easypost-client.ts`                            | No EasyPost API wrapper                                                          |
| `shipping_labels` table                         | No label records (labels currently tracked via `warehouse_shipments.label_data`) |
| `/api/webhooks/easypost`                        | No EasyPost tracking webhook handler                                             |
| Label creation server action                    | No way to create labels from inside the app                                      |
| Rate shopping function                          | No carrier rate comparison                                                       |
| `shipping_preferences` jsonb on `organizations` | No per-client domestic/international routing config                              |
| International customs info handling             | No customs item data model                                                       |


### Technical Integration Notes — EasyPost

**The plan's `shipping_tracking_events` table already exists as `warehouse_tracking_events`.** Do not create a duplicate table. EasyPost webhook events should write to `warehouse_tracking_events` using the existing schema (`shipment_id`, `workspace_id`, `status`, `description`, `location`, `event_time`, `source`). Set `source: "easypost"`.

`**shipping_labels` links to `warehouse_orders`, not `warehouse_shipments`.** The EasyPost flow creates a label from an order, then creates a `warehouse_shipments` row (or updates existing). The correct foreign key is `order_id` as shown in the plan schema.

**AfterShip customer notification email is NOT currently sent.** The `createTracking` call in `aftership-register.ts` does not pass customer email — AfterShip cannot send a "your order shipped" email without it. The customer email lives in the platform order (Bandcamp `buyer_email`, Shopify `email`, etc.) and is stored in `warehouse_orders.label_data` or the order's `line_items` jsonb. To enable the branded tracking email, `createTracking` must be extended to pass the customer email field from the linked order. This is a one-line patch to `aftership-register.ts` but requires reading the joined order's customer email.

**Middleware does NOT need updating for EasyPost webhooks.** All `/api/webhooks/`* paths are already public (existing guard: `pathname.startsWith("/api/webhooks/")`).

**EasyPost and ShipStation can coexist.** EasyPost-created shipments write a `warehouse_shipments` row with the EasyPost tracking number. `aftership-register` then picks it up and registers tracking. The same pipeline works for both providers.

---

## Summary Gap Table


| Feature                                          | Plan Status                    | Built    | Gap                                                    |
| ------------------------------------------------ | ------------------------------ | -------- | ------------------------------------------------------ |
| `client_store_connections` schema                | Required                       | Complete | None                                                   |
| Staff credential entry for client stores         | Required                       | Complete | None                                                   |
| Shopify/WooCommerce/Squarespace sync engine      | Required                       | Complete | None                                                   |
| AfterShip tracking registration                  | Required                       | Complete | None                                                   |
| AfterShip webhook + tracking timeline            | Required                       | Complete | None                                                   |
| Customer email in AfterShip notification         | Required                       | Partial  | Patch `aftership-register.ts` to pass customer email   |
| Shopify OAuth redirect flow                      | Required                       | Missing  | New routes + `oauth_states` migration                  |
| WooCommerce OAuth redirect flow                  | Required                       | Missing  | New redirect + callback routes                         |
| Squarespace OAuth redirect flow                  | Pending (awaiting credentials) | Missing  | New routes + `token_expires_at` column + refresh logic |
| Discogs OAuth flow                               | Lower priority                 | Missing  | New routes + Discogs client                            |
| Bandcamp self-service                            | Manual                         | N/A      | Instructional UI only                                  |
| `oauth_states` migration                         | Required                       | Missing  | New migration                                          |
| `token_expires_at` on `client_store_connections` | Required                       | Missing  | New migration column                                   |
| Client onboarding wizard                         | Phase 2                        | Missing  | New portal route + components                          |
| EasyPost label creation                          | Phase 3                        | Missing  | New client + server action + migration                 |
| `shipping_labels` table                          | Required                       | Missing  | New migration                                          |
| EasyPost webhook handler                         | Required                       | Missing  | New API route                                          |
| Per-client shipping preferences                  | Required                       | Missing  | New `organizations` column + migration                 |
| Pirate Ship manual fallback flag                 | Required                       | Partial  | Pirate Ship import exists; routing logic missing       |


---

## Trigger Touchpoint Check

These existing tasks are directly affected by or relevant to the plan:

- `aftership-register` — fires after ShipStation ingest; will also need to fire after EasyPost label creation; **needs customer email patch**
- `multi-store-inventory-push` — no change needed; already wired
- `client-store-order-detect` — no change needed; already wired
- `shipment-ingest` — currently the only path that calls `aftership-register`; EasyPost path will need its own invocation
- `bandcamp-mark-shipped` — already handles tracking push back to Bandcamp; no change needed

New Trigger tasks required by the plan:

- None strictly required — EasyPost label creation can be a server action (synchronous) with the webhook handler updating status asynchronously

---

## API Boundaries Impacted

New routes required (from `API_CATALOG.md` perspective — must be added to the catalog when implemented):

- `GET/POST /api/shopify/auth`, `GET /api/shopify/callback`
- `GET/POST /api/woocommerce/auth`, `GET /api/woocommerce/callback`
- `GET/POST /api/squarespace/auth`, `GET /api/squarespace/callback`
- `GET/POST /api/discogs/auth`, `GET /api/discogs/callback`
- `POST /api/webhooks/easypost`

New server actions required:

- `createShippingLabel(orderId, options)` → calls EasyPost, creates `shipping_labels` row, creates `warehouse_shipments` row, triggers `aftership-register`
- `getRates(orderId)` → returns EasyPost rate options
- `getShippingLabels(orderId)` → reads `shipping_labels` table

Middleware patch: add OAuth callback paths to `PUBLIC_PATHS` in [middleware.ts](middleware.ts).

---

## Recommended Sequencing

Given the current state, the lowest-risk / highest-value order is:

1. **Customer email in AfterShip** — one-line patch, completes the existing tracking notification flow that's already 95% done
2. `**oauth_states` + `token_expires_at` migrations** — database-only, no app risk
3. **Shopify OAuth routes** — credentials already exist; `store-sync-client.ts` already uses the resulting token format
4. **WooCommerce OAuth redirect** — simple pattern, no credentials needed
5. **EasyPost client + `shipping_labels` migration** — new capability, well-isolated
6. **EasyPost label creation action + webhook handler** — after client is validated
7. **Squarespace OAuth** — blocked on pending credentials from Squarespace
8. **Client onboarding wizard** — UI sugar on top of already-working infrastructure
9. **Discogs** — lower priority per plan's own questions

---

## Doc Sync Contract — Required Updates After Implementation


| Change                                    | Doc to update                                     |
| ----------------------------------------- | ------------------------------------------------- |
| New OAuth API routes                      | `docs/system_map/API_CATALOG.md`                  |
| New EasyPost webhook route                | `docs/system_map/API_CATALOG.md`                  |
| `shipping_labels` table + new migrations  | `project_state/engineering_map.yaml`              |
| Client onboarding journey                 | `project_state/journeys.yaml`                     |
| `aftership-register` customer email patch | `docs/system_map/TRIGGER_TASK_CATALOG.md` (notes) |
| New `EASYPOST_API_KEY`, OAuth secrets     | `src/lib/shared/env.ts` + `.env.local`            |


