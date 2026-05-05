# API Catalog

Canonical catalog of request boundaries used for planning/build/audit.

## Scope

- Next.js API route handlers in `src/app/api/**/route.ts`
- Server action boundaries in `src/actions/**/*.ts`

## Cache and Freshness Contract

- All durable UI reads must use `useAppQuery` tiering and `query-keys.ts` factories.
- New read paths must be classified as `hot operational`, `warm collaborative`, or `cold config/reference` per `docs/system_map/CACHE_ARCHITECTURE.md`.
- Scope-sensitive reads must have scope-safe key dimensions (workspace/org/authz variant where response shape differs).
- Mutations that change read models must invalidate affected key families; TTL is fallback, not primary correctness.
- Any new API/action that changes freshness behavior must update:
  - this catalog (boundary notes),
  - `docs/system_map/CACHE_ARCHITECTURE.md`,
  - `docs/RELEASE_GATE_CRITERIA.md` (if release checks change).

## API Routes (App Router)

| Method | Route | File | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | `src/app/api/health/route.ts` | Runtime health endpoint |
| `POST` | `/api/webhooks/shopify` | `src/app/api/webhooks/shopify/route.ts` | First-party Shopify webhook ingest (observe-only for `inventory_levels/update`/order topics; records resolver trace + status, no inventory/order side effects) |
| `POST` | `/api/webhooks/shipstation` | `src/app/api/webhooks/shipstation/route.ts` | ShipStation `SHIP_NOTIFY` ingest (Phase 2). Verifies `x-ss-signature` HMAC against `SHIPSTATION_WEBHOOK_SECRET`, dedupes via `webhook_events` (`platform='shipstation'`, `external_webhook_id='shipstation:ship_notify:{resource_url}'`), enqueues `process-shipstation-shipment` task. Returns 200 in <500ms. |
| `POST` | `/api/webhooks/shopify/gdpr` | `src/app/api/webhooks/shopify/gdpr/route.ts` | Combined Shopify GDPR compliance handler (HMAC verified) |
| `POST` | `/api/webhooks/shopify/gdpr/customers-data-request` | `src/app/api/webhooks/shopify/gdpr/customers-data-request/route.ts` | Shopify GDPR customers data request (HMAC verified, idempotent) |
| `POST` | `/api/webhooks/shopify/gdpr/customers-redact` | `src/app/api/webhooks/shopify/gdpr/customers-redact/route.ts` | Shopify GDPR customer redact (HMAC verified, idempotent) |
| `POST` | `/api/webhooks/shopify/gdpr/shop-redact` | `src/app/api/webhooks/shopify/gdpr/shop-redact/route.ts` | Shopify GDPR shop data redact (HMAC verified, idempotent) |
| `POST` | `/api/webhooks/aftership` | `src/app/api/webhooks/aftership/route.ts` | AfterShip webhook ingest. **Legacy — being sunset in favor of `/api/webhooks/easypost` (Phase 10.5 of tracking-notification hardening).** Direct `warehouse_shipments.status` writes are intentionally retained on this route during the dual-mode window; the parity sensor `tracking.status_drift_24h` flags any divergence from the EasyPost path. Do not extend this route — new tracking work flows through EasyPost. |
| `POST` | `/api/webhooks/easypost` | `src/app/api/webhooks/easypost/route.ts` | **EasyPost tracker webhook (tracking-notification hardening v5, 2026-04-25).** Verifies HMAC v1 (`x-hmac-signature`) or v2 (`x-easypost-hmac-signature` / `easypost-hmac-signature`) on the raw body via `verifyEasyPostSignature` (`src/lib/server/easypost-webhook-signature.ts`); supports dual-secret rotation (current + previous via `EASYPOST_WEBHOOK_SECRET` / `EASYPOST_WEBHOOK_SECRET_PREVIOUS`). Production fails closed when secret is unset; dev allows shadow mode. Logs `signature_failed` to `webhook_events` for audit trail. Dedup via `webhook_events` keyed on `easypost:tracker:{event_id}` (uses `interpretDedupError` — duplicates → 200, transient PG errors → 503 retry, unknown → 503 + Sentry). On unique tracker delivery, resolves `warehouse_shipments` row by `easypost_tracker_id` or `tracking_number+carrier`, then routes status updates through `updateShipmentTrackingStatusSafe` (RPC `update_shipment_tracking_status_safe` enforces sticky terminal states + out-of-order rejection) and seeds `notification_provider_events` for downstream send-tracking-email correlation. |
| `POST` | `/api/webhooks/stripe` | `src/app/api/webhooks/stripe/route.ts` | Stripe billing webhooks |
| `POST` | `/api/webhooks/resend` | `src/app/api/webhooks/resend/route.ts` | Resend outbound email status webhook. **Hardened (tracking-notification v5, 2026-04-25):** verifies Svix signature, dedups via `webhook_events` (R-6 2026-04-23: insert now uses `metadata` column — prior `payload` was silently failing every dedup), maps Resend events through `mapEventToTransition`: `email.delivered` → `delivered`, `email.bounced` → `bounced`, `email.complained` → `complained`, `email.suppressed` → `provider_suppressed`, `email.failed` → `provider_failed`, `email.opened`/`email.clicked` → ledger-only (no status flip), unknown → `ignored`. All status writes route through `updateNotificationStatusSafe` (centralized state machine; sticky terminals enforced). Provider events appended to `notification_provider_events` (workspace_id + shipment_id normalized for fast drilldown). Bounced + complained + provider_suppressed call `suppressRecipient` to update `resend_suppressions`. |
| `POST` | `/api/webhooks/resend-inbound` | `src/app/api/webhooks/resend-inbound/route.ts` | Resend inbound email webhook (`email.received`). **2026-04-23 fix bundle (R-1..R-7):** Svix HMAC verified → workspace resolved deterministically (`order by created_at asc limit 1`, R-7) → raw envelope inserted into `webhook_events.metadata` (Bug 9 fix: non-duplicate insert errors now Sentry-capture and 500 instead of silent 200) → envelope parsed via `parseInboundWebhook` (R-1: arrays for `to/cc/bcc`, no `text` — Resend webhooks are envelope-only) → full email body fetched via `fetchInboundEmail(emailId)` → `resend.emails.receiving.get` (R-2) → real sender recovered from headers `X-Original-From` > `Reply-To` > `Return-Path` > `From` > envelope (R-4, survives Workspace forwarding) → routed via `src/lib/server/resend-inbound-router.ts`. **2026-04-27 support resolver:** after Bandcamp order-mail heuristics and thread match, `src/lib/server/support-email-resolution.ts` resolves support emails by Bandcamp transaction id in the body, then order customer email, client login email, then `support_email_mappings`; otherwise it writes `warehouse_review_queue` with correct `category`/`metadata` columns (R-5). Replay tool: `scripts/_replay-resend-inbound.ts`. |
| `POST` | `/api/webhooks/client-store` | `src/app/api/webhooks/client-store/route.ts` | Generic client store webhook ingress (Shopify / WooCommerce / Squarespace). Verifies HMAC, dedups via `webhook_events` (HRD-22 `X-Shopify-Event-Id` precedence), enforces HRD-24 per-platform freshness ceilings (Shopify 72h), runs HRD-30 PII sanitization on stored payloads, then enqueues `process-client-store-webhook` with HRD-29 global-scope idempotency key (HRD-17.1 enqueue-failure path = HTTP 503 + `status='enqueue_failed'` + 5-min recovery sweeper retry). **F-3 / F-4 (2026-04-22):** dedup pathway is now driven by the typed `interpretDedupError` helper in `src/lib/server/webhook-body.ts` — `transient` PG errors map to HTTP 503 (so upstream retries), `unknown` map to 503 + Sentry, `duplicate` returns 200 OK; non-`fresh` outcomes log `{ connection_id, platform, topic, external_webhook_id, dedup_kind, error_code }`. Squarespace (and any header-less platform) use `canonicalBodyDedupKey({ platform, rawBody })` → `{platform}:{sha256(rawBody)}` as the dedup-key fallback, persisted on `webhook_events.dedup_key`. Heavy processing happens in the Trigger task — see `process-client-store-webhook` in `TRIGGER_TASK_CATALOG.md` for the four handlers (`handleInventoryUpdate` Shopify `inventory_item_id`→SKU, `handleRefund` Shopify `refunds/create`, `handleOrderCancelled` Shopify `orders/cancelled` with F-1 partial-recredit, `handleOrderCreated` writes `warehouse_order_items.fulfilled_quantity`). **Phase 8 (2026-04-27, SKU-AUTO-3 / SKU-AUTO-21):** `handleOrderCreated` calls `runHoldIngressSafely` after items insert (hold evaluation + optional `apply_order_fulfillment_hold` + committable-only inventory decrement + conditional `send-non-warehouse-order-hold-alert` enqueue). HRD-23 / F-2: `runtime='nodejs'` + `dynamic='force-dynamic'` enforced by `scripts/check-webhook-runtime.sh`. |
| `POST` | `/api/webhooks/client-store` Woo hardening | `src/app/api/webhooks/client-store/route.ts`, `src/lib/server/webhook-body.ts` | **2026-04-28 Woo repair:** WooCommerce webhooks now require a valid `X-WC-Webhook-Signature` against current or non-expired previous secret. Missing signature, malformed signature, mismatch, or missing configured secret write explicit `webhook_events.status` values (`signature_missing`, `signature_malformed`, `signature_invalid`, `connection_misconfigured`) and do not enqueue Trigger processing. |
| `GET` | `/api/oauth/shopify` | `src/app/api/oauth/shopify/route.ts` | Shopify OAuth initiation + callback (HRD-35: per-connection Custom-distribution app credentials resolved from `client_store_connections` when `connection_id` in state; HRD-35.1: state nonce stored in `oauth_states` (`nonce_purpose='shopify_install'`, 15min TTL, single-use); HRD-25 scope set; new connections insert with `do_not_fanout=true`. **HRD-35 gap #3 (auto-register, 2026-04-21):** after token capture the callback calls `registerWebhookSubscriptions` for the four required topics + `persistWebhookRegistrationMetadata` to store `metadata.webhook_subscriptions[]`, `shopify_scopes[]` (parsed from token-exchange `scope` field), `app_distribution` (`custom` when state.connectionId set, `public` otherwise), and `installed_at`. Auto-register failures do NOT abort the install — the success redirect carries `webhook_register=partial|error` so the operator UI can surface the partial state for the staff-manual retry button. **F-5 / HRD-10 (2026-04-22):** after the code-exchange the callback queries `shop { myshopifyDomain }` and rejects the install if the canonical domain doesn't match the normalized `shop` query param (lowercase + `.myshopify.com` suffix + trailing `/` stripped); mismatches upsert a `warehouse_review_queue` row keyed `shop_token_mismatch:{org_id}:{shop}` with `severity='high'` and the verified domain is persisted to `client_store_connections.shopify_verified_domain`.) |
| `POST` | `/api/oauth/woocommerce` | `src/app/api/oauth/woocommerce/route.ts` | WooCommerce OAuth key delivery (receives credentials from portal-stores action) |
| `POST` | `/api/oauth/woocommerce/callback` | `src/app/api/oauth/woocommerce/callback/route.ts` | WooCommerce OAuth 1.0a key delivery |
| `GET` | `/api/oauth/squarespace` | `src/app/api/oauth/squarespace/route.ts` | Squarespace OAuth initiation |
| `GET` | `/api/oauth/discogs` | `src/app/api/oauth/discogs/route.ts` | Discogs OAuth 1.0a initiation (client store connect) |

> All `/api/oauth/*` routes are public paths (no auth middleware) — clients arrive from external OAuth providers.
> GDPR routes verified with HMAC signature using `SHOPIFY_CLIENT_SECRET`.

## Server Actions by Domain

### Auth + Identity

- File: `src/actions/auth.ts`
- Exports: `getUserContext`, `heartbeatPresence`, `sendLoginMagicLink`
  - `sendLoginMagicLink`: server-side magic link generation via `auth.admin.generateLink` + Resend delivery. Replaces client-side `signInWithOtp`.

### Admin Dashboard + Settings

- Files:
  - `src/actions/admin-dashboard.ts`
  - `src/actions/admin-settings.ts`
- Key exports:
  - `getDashboardStats`
  - `getGeneralSettings`, `getIntegrationStatus`, `getHealthData`, `getShippingBillingHealth` **(new 2026-04-13)** — pipeline health metrics for admin dashboard
  - `triggerSensorCheck`, `triggerTagCleanup`
- Admin page: `/admin/catalog/bundles` — bundle management

### Autonomous SKU Matching — staff surfaces (Phase 6, 2026-04-26)

- Files:
  - `src/actions/sku-autonomous-runs.ts` (Slice 6.A)
  - `src/actions/sku-identity-matches.ts` (Slice 6.E)
  - `src/actions/order-holds.ts` (Slice 6.C)
  - `src/actions/sku-autonomous-canary.ts` (Slice 6.G)
  - `src/actions/sku-autonomous-rollout.ts` (Slice 7.C)
- Key exports (all staff-only via `requireStaff()`; workspace-scoped defense-in-depth over RLS):
  - Slice 6.A — `listAutonomousRuns({ filters, page })`, `getAutonomousRunDetail({ runId })`, `getVariantDecisionHistory({ variantId })` — read surface over `sku_autonomous_runs` and `sku_autonomous_decisions` (never writes). Bounded `limit ≤ 200`.
  - Slice 6.E — `listIdentityMatches({ filters, page })`, `getIdentityMatchDetail({ identityMatchId, transitionsLimit ≤ 200 })` — read surface over `client_store_product_identity_matches` + `sku_outcome_transitions`. Whitelisted in `scripts/ci-checks/sku-identity-no-fanout.sh` (read-only). Promotion still goes through `promote_identity_match_to_alias` — this module never mutates identity state.
  - Slice 6.C — `listOrderHolds({ filters, page })`, `releaseOrderHold({ orderId, resolutionCode, note? })`, `releaseOrderHoldsBulk({ orderIds, resolutionCode, note? })` — single-entry mutation for held orders; both wrap `release_order_fulfillment_hold` RPC. `staff_override` resolution requires a non-empty note (SKU-AUTO-17).
  - Slice 6.G — `flipAutonomousMatchingFlag({ flag, enabled, note? })` — SKU-AUTO-19 enforcement for turning autonomous-matching flags ON. Canary-gated flags (`sku_identity_autonomy_enabled`, `sku_live_alias_autonomy_enabled`) require a RESOLVED `warehouse_review_queue` row with category `sku_autonomous_canary_review`; `sku_live_alias_autonomy_enabled` additionally requires `compute_bandcamp_linkage_metrics` to clear the Phase 7 thresholds (70% linkage / 60% verified / 40% option) AND the workspace not to be in `sku_autonomous_emergency_paused`. Turning a flag OFF bypasses both preflights (fast-rollback path). Writes an audit row to `warehouse_review_queue` and invalidates the flag cache.
  - Slice 7.C — `getAutonomousRolloutHealth()` — single-read aggregator for the rollout page, returning `{ workspaceId, flags, emergencyPause, telemetry, canaryReview, linkage }`. Telemetry reads the latest `sensor_readings` row (`sensor_name='sku_autonomous.telemetry'`); linkage calls `compute_bandcamp_linkage_metrics` when `org_id` is resolved; canary review reads the latest `warehouse_review_queue` row with `category='sku_autonomous_canary_review'`. Partial failure produces typed error markers per panel (`telemetry.kind='error'`, `linkage.kind='unavailable'`) so the page always renders. `createAutonomousCanaryReview({ intendedFlag?, title?, note? })` opens a new canary review row (`category='sku_autonomous_canary_review'`, `severity='high'`, `status='open'`) with intendedFlag stored in `metadata.intended_flag`; defaults to `sku_live_alias_autonomy_enabled` with a phase-specific auto-title. `resolveAutonomousCanaryReview({ reviewId, resolutionNote? })` marks the row resolved (enforces workspace ownership, returns `{ alreadyResolved: true }` on idempotent re-call), merges prior metadata with `resolution_note` + `resolved_by_user`, revalidates both rollout + feature-flags pages, and invalidates the workspace flag cache so the next flip-read sees the resolved row immediately.
- Admin pages:
  - `/admin/settings/sku-matching/autonomous-runs` (Slice 6.B) — gated by `sku_autonomous_ui_enabled`.
  - `/admin/settings/sku-matching/identity-matches` (Slice 6.E) — gated by `sku_autonomous_ui_enabled`.
  - `/admin/settings/sku-matching/rollout` (Slice 7.D) — gated by `sku_autonomous_ui_enabled`. Surfaces flag state (read-only), emergency-pause state, latest weekly telemetry rollup, Bandcamp linkage with pass/fail thresholds, and the canary review lifecycle (open + resolve). All reads come from a single `getAutonomousRolloutHealth()` call; mutations re-use `router.refresh()` so the server render stays the source of truth.
  - `/admin/orders/holds` (Slice 6.D) — NOT flag-gated (staff should always be able to resolve existing holds).

### Per-Channel Safety Stock (Phase 5 §9.6 D2 — 2026-04-24)

- File: `src/actions/safety-stock.ts` (single-owner per Rule #58 — every safety_stock write goes through here)
- Companion test: `tests/unit/actions/safety-stock.test.ts` (21 cases per Rule #6)
- Shared helpers:
  - `src/lib/shared/safety-stock-csv.ts` — minimal RFC 4180 parser kept outside `"use server"` so it can be a sync export.
  - `src/lib/shared/constants.ts` — `INTERNAL_SAFETY_STOCK_CHANNELS = ["bandcamp", "clandestine_shopify"]`, `SAFETY_STOCK_MAX_BULK_EDITS = 200` (Rule #41), `SAFETY_STOCK_MAX_VALUE = 32_767` (smallint cap), `SAFETY_STOCK_REASON_MAX_LENGTH = 500`.
- Schema:
  - Storefronts: `client_store_sku_mappings.safety_stock` smallint (CHECK >= 0), `preorder_whitelist` boolean, `last_inventory_policy` text, `last_policy_check_at` timestamptz.
  - Internal channels: `warehouse_safety_stock_per_channel(workspace_id, variant_id, channel, safety_stock, notes, updated_by)` — sparse table; rows reverting to safety_stock=0 are DELETED to keep the §9.6 push helper hot path lean.
  - Audit log: `warehouse_safety_stock_audit_log` (migration `20260427000004_safety_stock_audit_log.sql`) — append-only, `(channel_kind ∈ {storefront,internal} XOR connection_id|channel_name)` constraint, `prev_/new_safety_stock`, `prev_/new_preorder_whitelist`, `reason`, `source ∈ {ui_inline, ui_bulk, ui_csv, system}`, `changed_by`, `changed_at`. Staff-only RLS.
- Server Actions (all staff-only via `requireStaffContext`):
  - `listSafetyStockChannels({})` → `SafetyStockChannelSummary[]` — storefront connections + internal channels with `policyDriftCount` (storefront mappings where `last_inventory_policy='CONTINUE' AND preorder_whitelist=false`).
  - `listSafetyStockEntries({ channel, page, pageSize, search?, onlyWithSafetyStock? })` → paginated entries joining variant + inventory + last-edit timestamp from the audit log.
  - `updateSafetyStockBulk({ channel, edits[≤200], reason?, source })` → per-SKU outcomes (`applied | skipped_no_change | error`); writes one audit row per applied/deleted edit. Best-effort: row 73 with a renamed SKU does NOT poison rows 1-72 / 74-200. Internal-channel calls IGNORE `newPreorderWhitelist` (lives only on storefront mapping).
  - `previewSafetyStockCsv({ channel, csv })` → `CsvPreviewResult` with create/update/delete/no_op/error classification per row; SKU-not-found is surfaced as `error` rather than rejected.
  - `commitSafetyStockCsv({ channel, edits, reason? })` → delegates to `updateSafetyStockBulk` with `source='ui_csv'`.
  - `listSafetyStockAuditLog({ page?, pageSize?, channelKind?, connectionId?, channelName?, sku? })` → workspace-scoped, newest first; rejects contradictory filters at the Zod boundary.
- Admin page: `/admin/settings/safety-stock` — channel picker (drift badge per storefront) + paginated editable grid (inline numeric input, dirty-row highlight, batch save). Valid inline numeric values stage immediately on change so the page-level Save button and pending-count badge reflect dirty state before blur; blur/Escape still normalize invalid drafts back to the last valid value. Per-row Sheet drawer (preorder_whitelist switch + reason textarea + per-SKU audit history) + modal CSV import (file picker / paste textarea → preview rows with classification badges → commit) + workspace-wide audit Sheet with channel + SKU filters. Sidebar entry under Settings between Carrier Mapping and Feature Flags.
- Critical invariants:
  - Rule #20 — this file is a POLICY editor; it NEVER calls `recordInventoryChange()`, never touches `available` / `committed_quantity` / Redis. `safety_stock` reduces *push* values via `effective_sellable`, not the underlying ledger.
  - Rule #54 — every Server Action is bounded ≤200 edits/call. Operators must split larger CSV imports client-side.
  - Audit rows are written by the Server Action (NOT a DB trigger) because the trigger cannot see `reason` + `source`.

### Clients + Users + Organizations

- Files:
  - `src/actions/clients.ts`
  - `src/actions/users.ts`
  - `src/actions/organizations.ts`
- Key exports:
  - client lifecycle: `getClients`, `getClientDetail`, `createClient`, `updateClient`
  - client presence + support history: `getClientPresenceSummary`, `getClientSupportHistory`
  - user lifecycle: `getUsers`, `inviteUser`, `updateUserRole`, `deactivateUser`, `removeClientUser`
  - org lifecycle: `getOrganizations`, `createOrganization`, `mergeOrganizations`, alias management
  - **HRD-36 org-merge transactional rewrite (2026-04-23):** `previewMerge(sourceOrgId, targetOrgId)` and `mergeOrganizations(sourceOrgId, targetOrgId)` now delegate to two PL/pgSQL RPCs (`preview_merge_organizations`, `merge_organizations_txn`) defined in `supabase/migrations/20260423000001_org_merge_rpc.sql`. The TypeScript-only loop was replaced because it had six confirmed bugs: (1) five org_id-bearing tables missing from the per-table allow-list (`mailorder_orders`, `oauth_states`, `shipstation_orders`, `sku_sync_conflicts`, `warehouse_billing_rule_overrides` — the first two are NOT NULL FKs that hard-blocked the source-org DELETE; the latter three silently orphaned rows); (2) silent failures inside the loop (the `.update()` `error` was never checked); (3) not transactional (Rule #64 violation — each PostgREST call its own HTTP request); (4) preview underreported affected rows for the same reason as (1); (5) `warehouse_inventory_levels.org_id` is auto-derived by `trg_derive_inventory_org_id` (Rule #21) so update order matters — the RPC documents and enforces ordering (`warehouse_products` first); (6) UNIQUE-constraint collisions on `portal_admin_settings(workspace_id, org_id)`, `warehouse_billing_snapshots(workspace_id, org_id, billing_period)`, `warehouse_billing_rule_overrides(workspace_id, org_id, rule_id)`, `mailorder_orders(workspace_id, source, external_order_id, org_id)`, `client_store_connections(org_id, platform, store_url)`, `client_store_connections(org_id, platform) WHERE platform='discogs'`, and `organization_aliases(LOWER(alias_name), workspace_id)` were not pre-checked. **New behaviour:** `previewMerge` returns `MergePreview` with a `collisions: MergeCollision[]` field; the `MergeOrgCard` UI lists each collision and disables the Confirm button until the operator resolves them. `mergeOrganizations_txn` re-runs collision detection inside the transaction (closes the preview→confirm gap) and raises one of `merge_invalid_input`, `merge_source_not_found`, `merge_target_not_found`, `merge_workspace_mismatch`, `merge_collisions_present`, or `merge_delete_failed` — translated into operator-friendly text by the Server Action wrapper. The RPC enforces same-workspace merges (cross-workspace merges are rejected). 12 new unit tests in `tests/unit/actions/organizations.test.ts` cover admin-only auth, RPC payload mapping, collision surfacing, error translation, self-merge rejection, and rowcount return.
  - `getClientStores` → returns `{ legacy: [], connections: [] }` combining legacy + `client_store_connections`
  - `getClientProducts` → returns client products sorted by title (Artist — Title — Format)

### Inventory + Catalog + Product Images

- Files:
  - `src/actions/inventory.ts`
  - `src/actions/catalog.ts`
  - `src/actions/product-images.ts`
  - `src/actions/sku-conflicts.ts` — **Phase 0.5 (2026-04-17)** — SKU rectify queue (staff) + suggest UI (client)
- Key exports:
  - inventory read/write: `getInventoryLevels`, `adjustInventory`, `getInventoryDetail`, `updateVariantFormat`
  - portal inventory: `getClientInventoryLevels` — starts from `warehouse_product_variants` (LEFT JOIN `warehouse_inventory_levels`) so zero-stock items are visible. Uses service role, filters by `org_id` explicitly.
  - catalog read/write: `getProducts`, `getCatalogStats`, `getProductDetail`, `updateProduct`, `updateVariants`, `searchProductVariants`, `getClientReleases`
  - images: `uploadProductImage`, `reorderProductImages`, `deleteProductImage`, `setFeaturedImage`
  - SKU conflicts (staff): `listSkuConflicts`, `getSkuConflict`, `applyAliasResolution` (triggers `sku-rectify-via-alias`), `ignoreSkuConflict` — backed by `/admin/catalog/sku-conflicts`
  - SKU conflicts (client): `listClientSkuMismatches`, `suggestCanonicalSku` — backed by `/portal/catalog/sku-alignment`. `suggestCanonicalSku` uses `createServiceRoleClient` after RLS-validated org_id check.
- File: `src/actions/bandcamp-baseline.ts` — **Phase 1 (2026-04-17)** — Bandcamp baseline anomaly + multi-origin push_mode admin surface
  - `forceBaselineScan({ workspaceId? })` — staff-only. Enqueues `bandcamp-baseline-audit` via `tasks.trigger` (Rule #48 + Rule #9). Cross-workspace force-scan rejected.
  - `setBandcampPushMode({ mappingId, pushMode, reason })` — staff-only. Records `push_mode_set_by` so the next audit run preserves the manual decision (`manual_override` is NEVER auto-cleared by `bandcamp-baseline-audit`).
  - `listBaselineAnomalies({ status?, limit? })` — staff-only. Reads `bandcamp_baseline_anomalies` scoped to the staff member's workspace; default filter is `status='open'` (resolved_at IS NULL).

### Inbound + Shipping Log + Orders + Scanning

- Files:
  - `src/actions/inbound.ts`
  - `src/actions/shipping.ts`
  - `src/actions/orders.ts`
  - `src/actions/staff-orders.ts` (Order Pages Transition Phase 3 — Direct Orders staff read model; explicit `DirectOrderDTO` / `DirectOrderDetailDTO`; staff-only via `requireStaff()`; uses Phase 1 trigram indexes for search; hydrates items, shipments, tracking events with `tracking_source`, mirror links from the Phase 2 bridge, and Phase 5b platform fulfillment writebacks per order)
  - `src/actions/order-route-mode.ts` (Order Pages Transition Phase 0 — `getOrdersRouteMode(workspaceId)` reads `workspaces.flags.orders_route_mode` (`direct | shipstation_mirror`) plus the legacy `shipstation_unified_shipping` value; `flipOrdersRouteMode` is staff-gated to `super_admin`/`warehouse_manager`, writes a `warehouse_review_queue` row with `category='order_route_mode_change'`, then calls `invalidateOrderSurfaces`)
  - `src/actions/order-transition-diagnostics.ts` (Order Pages Transition Phase 0 — staff-only `getOrderTransitionDiagnostics()` aggregates direct/mirror counts by 30/90 day windows, identity backfill counts, mirror link confidence histogram, hold counts, preorder-pending counts by surface, writeback statuses, shipments by `label_source`, Pirate Ship potential mislink count, open route-flip / identity / Pirate Ship review queue items)
  - `src/actions/order-identity-backfill.ts` (Order Pages Transition Phase 1 — `enqueueIdentityBackfill()` triggers the resumable `order-identity-backfill` Trigger task; `resolveIdentityReview()` lets `super_admin` / `warehouse_manager` resolve `warehouse_order_identity_review_queue` rows; both invalidate Direct Orders surfaces via `invalidateOrderSurfaces`)
  - `src/actions/order-mirror-links.ts` (Order Pages Transition Phase 2 — `enqueueMirrorLinksBridge()` staff-gated trigger of the `order-mirror-links-bridge` task; invalidates `transitionDiagnostics` + `mirrorLinks` cache)
  - `src/actions/preorder-pending.ts` (Order Pages Transition Phase 4a — `getPreorderPending()` reads from the unified `preorder_pending_orders` SQL view; returns combined rows + per-surface counts)
  - `src/actions/order-holds.ts` (Phase 4b: bulk + single hold release; refactored 2026-04-29 to call `invalidateOrderSurfaces({kinds:['holds','direct.detail','direct.list']})` instead of direct `revalidatePath`)
  - `src/actions/scanning.ts`
  - `src/actions/mail-orders.ts`
- Key exports:
  - inbound: `getInboundShipments`, `getInboundDetail`, `createInbound`, `markArrived`, `beginCheckIn`, `checkInItem`, `completeCheckIn`
  - shipping log (renamed from "Shipping", route `/admin/shipping`): `getShipments`, `getShipmentsSummary`, `getShipmentDetail`, `exportShipmentsCsv`, `getShippingRates`, `createOrderLabel`, `getLabelTaskStatus`
    - `getShipments` select now includes: `workspace_id`, `ss_order_number`, `customer_shipping_charged`, `total_units`, `label_source`, `warehouse_orders(order_number, shipping_cost, line_items)`, `warehouse_shipment_items(id, sku, quantity)`. Each returned row is enriched post-query with `fulfillment_total` (postage + materials + pick/pack, workspace-scoped, chunked batch lookup) and `fulfillment_partial` (true when any SKU or format cost is unresolvable). **Updated 2026-04-13**: added `labelSource` filter; **2026-04-13 (later)**: line_items customer shipping inference; **2026-04-13 (shipping-log-hardening)**: batch fulfillment enrichment with workspace scoping.
    - `getShipmentDetail` costBreakdown now includes `partial`, `unknownSkus`, `missingFormatCosts` fields. Variant and format cost queries are scoped by `workspace_id`. Uses shared `computeFulfillmentCostBreakdown` (eliminates duplicate variant DB query). `skuFormatMap` returned by helper populates item.format_name without a second query.
    - `exportShipmentsCsv` CSV column renamed `total` → `fulfillment_total` to match fulfillment semantics. Workspace-scoped batch lookups via shared helper.
    - `getShipmentsSummary` **updated 2026-04-13**: filters `voided=false` so summary cards exclude voided shipments
  - orders: `getOrders`, `getOrderDetail`, `getTrackingEvents`, `getClientShipments`, `getShipmentItems`
    - `getClientShipments` **hardened 2026-04-02**: explicit `org_id` filter (resolves from authenticated user), includes `warehouse_orders(order_number)` join; no longer returns cross-org shipments. **Updated 2026-04-13**: added `search` param (tracking number filter)
    - `getOrderDetail` shipments now auto-populated via `order_id` FK set by `shipstation-poll` auto-link
  - scan: `lookupLocation`, `lookupBarcode`, `submitCount`, `recordReceivingScan`
  - mail orders: `getMailOrders` (admin), `getClientMailOrders` (portal), `getMailOrderPayoutSummary`

### ShipStation Bridge (active during Shopify app approval period)

- File: `src/actions/shipstation-orders.ts`
- Key exports:
  - `getShipStationOrders({ status?, page?, pageSize? })` — live read from ShipStation `/orders` API, no DB write; staff-only
  - **Unified staff Orders cockpit (2026-04-28):** when `workspaces.flags.shipstation_unified_shipping`, `/admin/orders` loads **`getShipStationOrdersDb` → `shipstation_orders` + `shipstation_order_items`** (see `src/app/admin/orders/page.tsx`). This is the ShipStation mirror—not a per-native-channel SQL union over `warehouse_orders`. Multi-channel visibility depends on orders existing in ShipStation first; see `TRUTH_LAYER.md` § Operational cutover semantics + `docs/RELEASE_GATE_CRITERIA.md` § Operational cutover — user-facing claims vs system contracts.
  - `refreshShipStationOrdersFromSS({ windowMinutes })` — staff mutation to pull recent SS orders into the mirror for cockpit refresh.
- Admin page: `/admin/shipstation-orders` — team's working order queue during bridge period
- Pirate Ship import surfaced from Shipping Log header → `/admin/shipping/pirate-ship`

### Manual inventory count (Saturday Workstream 2 — 2026-04-18)

- File: `src/actions/manual-inventory-count.ts`
- Backed by Trigger task: `shipstation-v2-adjust-on-sku` (queue-pinned to `shipstation`, ledger-gated via `external_sync_events`, fanout-guard aware)
- Key exports (all staff-only via `requireStaff()`):
  - `getManualCountTable({ orgId, search?, page?, pageSize? })` — returns SKUs filtered to one organization with current `available`, format, and `countStatus`. Used by the bulk table editor to render the editable grid.
  - `submitManualInventoryCounts({ orgId, entries: [{ sku, newAvailable, force? }] })` — bulk write path. Per row: pre-fetch current available + variant org → compute delta → gate (negative-block / threshold confirm / count-in-progress skip / unknown SKU) → call `recordInventoryChange({ source:'manual_inventory_count', correlationId:'manual-count:{userId}:{batchId}:{sku}' })` → fire `tasks.trigger('shipstation-v2-adjust-on-sku', payload)`. `MAX_ENTRIES_PER_BATCH=200`. Returns per-row `EntryStatus` (`applied` / `no_change` / `blocked_negative` / `requires_confirm` / `skipped_count_in_progress` / `unknown_sku` / `error`).
- Confirmation gate (chosen `absolute_with_threshold`): `force:true` is required when `|delta| > 10` OR `currentAvailable === 0 && newAvailable > 0` (rising_from_zero) OR `currentAvailable > 0 && newAvailable === 0` (falling_to_zero). UI re-submits the same rows with `force:true` after operator approval.
- Negative handling (chosen `block_negative_review_queue`): submissions with `newAvailable < 0` are hard-blocked AND a `warehouse_review_queue` row is upserted (`category='manual_count_negative_block'`, `severity='high'`, `group_key='manual-count.negative-block:{workspaceId}:{sku}'`).
- Fanout (chosen `respect_guard`): Bandcamp + Clandestine Shopify + client-store + ShipStation v2 fanout all happen automatically via `recordInventoryChange()` → `fanoutInventoryChange()` → existing `loadFanoutGuard` path. The Server Action ALSO directly enqueues `shipstation-v2-adjust-on-sku` (same correlation id) so the v2 push happens immediately even if the generic fanout pipeline is skipped — `external_sync_events` UNIQUE on `(system='shipstation_v2', correlation_id, sku, action)` deduplicates the dual enqueue safely. Both paths short-circuit when `workspaces.inventory_sync_paused=true` (audit fixes F2 + F3, 2026-04-13).
- Admin page: `/admin/inventory/manual-count` (linked from sidebar NAV_ITEMS as "Manual Count").

### Inventory count sessions + locations (Saturday Workstream 3 — 2026-04-18)

- Files: `src/actions/inventory-counts.ts`, `src/actions/locations.ts`
- Backed by Trigger tasks: `bulk-create-locations` (queue-pinned to `shipstation` for ranged location mirror), `shipstation-v2-adjust-on-sku` (only fires on completion delta).
- Schema (already shipped in WS1 migration `20260418000001_phase4b_megaplan_closeout_and_count_session.sql`): `warehouse_inventory_levels` gained `count_status` / `count_started_at` / `count_started_by` / `count_baseline_available` / `has_per_location_data`; `warehouse_locations` gained `shipstation_inventory_location_id` / `shipstation_synced_at` / `shipstation_sync_error`.
- Count session exports (all staff-only via `requireStaff()`):
  - `startCountSession(sku)` — flips `count_status` to `count_in_progress`, snapshots `count_baseline_available`, records `count_started_by`. Returns `ALREADY_IN_PROGRESS` / `UNKNOWN_SKU` for safe UI handling.
  - `setVariantLocationQuantity({ sku, locationId, quantity })` — upserts `warehouse_variant_locations`. Suppresses fanout while `count_status='count_in_progress'`. Idle path routes any non-zero delta through `recordInventoryChange()`. Sets the sticky `has_per_location_data=true` flag on first per-location write.
  - `completeCountSession(sku)` — re-reads current `available` (defends against concurrent sales), sums `warehouse_variant_locations.quantity_available`, computes delta vs current available (Scenario A: count POST-sale → delta=0; Scenario B: count completes BEFORE sale → delta picks up the live sale), and routes the single resulting delta through `recordInventoryChange({ source:'cycle_count' })`. Clears all `count_*` columns. Idempotent against `NO_ACTIVE_SESSION`.
  - `cancelCountSession(sku, { rollbackLocationEntries })` — clears the session; optionally restores `warehouse_variant_locations` to baseline.
  - `getCountSessionState(sku)` — read-only fetch returning `{ status, baselineAvailable, currentAvailable, locations, sumOfLocations, drift, hasPerLocationData }` for UI.
- Locations exports (all staff-only via `requireStaff()`):
  - `listLocations({ activeOnly?, search? })` — filtered + ordered list of `warehouse_locations`.
  - `createLocation({ name, locationType, barcode? })` — inserts local row; one-way mirrors to ShipStation v2 via `createInventoryLocation` (resolves a 409 by calling `listInventoryLocations`). Returns `LOCATION_ALREADY_EXISTS` / `NO_V2_WAREHOUSE_CONFIGURED` / `INVALID_LOCATION_TYPE` for UI fallback.
  - `createLocationRange({ prefix, start, end, locationType, barcodePrefix? })` — for ≤30 entries the action runs inline with throttling. For >30 it offloads to `tasks.trigger('bulk-create-locations', payload)` and returns `{ status:'enqueued', runId }`.
  - `updateLocation(id, patch)` — calls ShipStation FIRST when renaming (v4 hardening: local row stays unchanged on v2 failure so retry has truth to retry from). Empty patch is a no-op.
  - `deactivateLocation(id)` — blocked when any `warehouse_variant_locations.quantity_available > 0` references it.
  - `retryShipstationLocationSync(id)` — operator-driven retry for rows with `shipstation_sync_error`.
- Admin UI: existing `/admin/inventory` expanded-row detail now hosts `InventoryCountSessionPanel` (component at `src/components/admin/inventory-count-session-panel.tsx`) — provides "Start count" / in-progress badge / per-location editable list with debounced `setVariantLocationQuantity` / locator typeahead with inline `createLocation` / Complete + Cancel controls.
- Admin UI: `/admin/inventory/locations` (added 2026-04-18, sprint #2 post-closeout) — operator surface for `warehouse_locations`. Search + filter (location_type, active-only/all), per-row ShipStation v2 sync state (Synced / Local only / Mirror failed with `shipstation_sync_error` on hover), Last-synced relative time, one-click Retry button (calls `retryShipstationLocationSync`), Deactivate button (Server Action refuses with `LOCATION_HAS_INVENTORY` if any `warehouse_variant_locations.quantity > 0`), New-location dialog (calls `createLocation`, surfaces all four `CreateLocationWarning` variants), New-range dialog (calls `createLocationRange`, shows inline-vs-Trigger badge live based on size — §15.5 cap of 30). Inline rename intentionally deferred (Server Action calls v2 first per v4 §17.1.b — failure UX needs more design). Sidebar `NAV_ITEMS` gained "Locations" entry under Inventory.

### Mega-plan verification (Phase 6 closeout)

- File: `src/actions/megaplan-spot-check.ts`
- Backed by Trigger task: `megaplan-spot-check` (hourly during ramp; persistence rule for drift_major)
- Key exports (all staff-only via `requireStaff()`):
  - `triggerSpotCheck()` — enqueues a one-off `megaplan-spot-check` run via `tasks.trigger`. Returns `{ runHandleId }`. Used by the "Run spot-check now" button.
  - `listSpotCheckRuns(limit = 50)` — reads recent `megaplan_spot_check_runs` rows (header + drift counts only). Used by the runs table.
  - `getSpotCheckArtifact(runId)` — fetches `artifact_md` + `summary_json` for one run. Used by the per-run dialog.
- Admin page: `/admin/settings/megaplan-verification` (linked from the settings sidebar group).
- Rule #48 alignment: never calls ShipStation/Bandcamp/Redis directly — always delegates to the Trigger task.

### ShipStation v2 Inventory Seed (Phase 3)

- File: `src/actions/shipstation-seed.ts`
- Underlying client: `src/lib/clients/shipstation-inventory-v2.ts` (`adjustInventoryV2`, `listInventoryWarehouses`, `listInventoryLocations`)
- Key exports (all staff-only, all enforce `requireAuth().userRecord.workspace_id` matches the input `workspaceId`):
  - `previewShipStationSeed({ workspaceId, inventoryWarehouseId, inventoryLocationId })` — enqueues `shipstation-seed-inventory` with `dryRun: true` and inline-polls up to 25s; returns `{ status: 'completed', taskRunId, output }` or `{ status: 'pending', taskRunId }` if the dry-run takes longer
  - `triggerShipStationSeed({ … })` — enqueues the real seed run (Rule #41 — Server Action returns immediately with the task run id; the UI polls `listShipStationSeedRuns`)
  - `listShipStationSeedRuns({ workspaceId, limit? })` — reads the most recent `channel_sync_log` rows where `channel='shipstation_v2'` and `sync_type='seed_inventory'`
- Admin page: `/admin/settings/shipstation-seed`
- Rule #48: never calls ShipStation directly — always routes via `tasks.trigger('shipstation-seed-inventory', …)`

### Billing + Reports + Review Queue

- Files:
  - `src/actions/billing.ts`
  - `src/actions/reports.ts`
  - `src/actions/review-queue.ts`
- Key exports:
  - billing: `getAuthWorkspaceId`, `getBillingRules`, `createBillingRule`, `updateBillingRule`, `getFormatCosts`, `updateFormatCost`, `createFormatCost`, snapshot + adjustments + overrides APIs. **Updated 2026-04-13**: added `getClientCurrentMonthPreview` (TZ-aware billing estimate), `requireStaff()` on `getClientOverrides`/`createClientOverride`/`deleteClientOverride`
  - reports: `getTopSellers`, `getTopSellersSummary`
  - review queue: `getReviewQueueItems`, `assignReviewItem`, `resolveReviewItem`, `suppressReviewItem`, `reopenReviewItem`, bulk ops

### Notification Operations (tracking-notification hardening, 2026-04-25)

- File: `src/actions/notification-operations.ts`
- Key exports:
  - `getNotificationOperationsOverview`: staff-only dashboard read powering `/admin/operations/notifications` — surfaces 24h notification status counts (incl. new `provider_failed` / `delivered` / `cancelled`), suppression count, last sensor run, and currently-stuck rows (status `pending` / `provider_failed` / `delayed` past SLA threshold).
  - `getShipmentNotificationLog({ shipmentId })`: per-shipment audit drilldown — joins `notification_sends` + `notification_provider_events` (normalized `shipment_id` column, NOT JSON-path query) + `notification_operator_events` to render the full lifecycle of every customer email tied to a shipment. Linked from every admin shipment surface (Shipping log, Order detail, Operations notifications).
  - `retryStuckNotification`, `cancelStuckNotification`: operator actions routed through `applyOperatorNotificationAction` (centralized state-machine RPC `apply_operator_notification_action`). Audit row written to `notification_operator_events` (FK → `public.users`). Retry re-enqueues `send-tracking-email` with the same correlation_id; cancel terminates the row with `status='cancelled'` (sticky terminal).
  - `triggerNotificationFailureSensor`: manual operator trigger for `notification-failure-sensor` Trigger task (cron-driven baseline; manual button surfaces in the ops page for incident response).
- Companion CI guard: `scripts/check-notification-status-writes.sh` greps the source tree for direct `notification_sends.status` and `warehouse_shipments.easypost_tracker_status` writes outside the wrapper (`src/lib/server/notification-status.ts`) — build fails on drift. Aftership route's legacy `warehouse_shipments.status` write is intentionally excluded from this guard during the dual-mode sunset window; parity sensor `tracking.status_drift_24h` flags any divergence.

### Portal Experience

- Files:
  - `src/actions/portal-dashboard.ts`
  - `src/actions/portal-sales.ts`
  - `src/actions/portal-settings.ts`
  - `src/actions/portal-stores.ts`
  - `src/actions/portal-stock-exceptions.ts`
  - `src/actions/support.ts`
- Phase 6 Slice 6.F — portal SKU stock-exceptions surface (2026-04-26):
  - `listClientStockExceptions({ connectionId?, platform?, limit, offset })` — `src/actions/portal-stock-exceptions.ts`. Client-only (`requireClient()`), read-only, org-scoped via explicit `org_id=:caller.orgId` filter on top of the `client_select_identity_matches` RLS policy. Returns only `outcome_state='client_stock_exception'` + `is_active=true` rows ordered by `last_evaluated_at DESC`. Intentionally hides `evidence_snapshot`, `remote_fingerprint`, and `remote_inventory_item_id` from the client payload. Companion page at `/portal/stock-exceptions` is gated by the `client_stock_exception_reports_enabled` workspace flag.
- Key exports:
  - `getPortalDashboard`, `getSalesData`, `getPortalSettings`, `updateNotificationPreferences`
  - portal stores: `getMyStoreConnections`, `getWooCommerceAuthUrl`, `deleteStoreConnection`
  - support: `getConversations`, `getSupportInboxSummary`, `getConversationDetail`, `getSupportViewerContext`, `createConversation`, `sendMessage`, `markConversationRead`, `resolveConversation`, `reopenConversation`, `assignConversation`, `updateConversationTriage`, `snoozeConversation`, `addInternalNote`, `listSavedReplies`, `createSavedReply`, `listSupportAssignees`, `getSupportClientContext`, `getDuplicateCandidates`, `markDuplicateCandidateReviewed`, `retrySupportDelivery`, `suggestSupportReply`
  - Support Inbox 2.0 boundary notes (2026-04-25): `getConversations({ queue })` computes queue membership from canonical fields, returns per-thread `message_count`, and sorts by latest support message timestamp when available; `getSupportInboxSummary()` returns DB evidence fields (`totalConversations`, `totalMessages`, `latestMessageAt`, `loadedAt`) plus queue totals, with `resolvedTotal` driven by `status='resolved'` rather than `resolved_at`-today. `sendMessage` accepts `clientMutationId`, `lastSeenMessageId`, and `forceSendAfterCollision` for retry-safe idempotency + hard collision protection; staff replies insert `support_message_deliveries` before Trigger dispatch. Client/admin surfaces use scoped `queryKeys.support.*` invalidation; only active conversation detail panes maintain granular Realtime message subscriptions.

### Discogs Master Catalog (Admin)

- File: `src/actions/discogs-admin.ts`
- Key exports: `getDiscogsOverview`, `getDiscogsCredentials`, `saveDiscogsCredentials`, `getProductMappings`, `confirmMapping`, `rejectMapping`
- All require `requireStaff()`.

### Bandcamp Shipping

- File: `src/actions/bandcamp-shipping.ts`
- Exports: `setBandcampPaymentId`, `triggerBandcampMarkShipped`
  - Staff-only. Sets Bandcamp payment ID on shipments and triggers mark-shipped task (Rule #48 compliant — enqueues via Trigger, never calls Bandcamp API directly).

### Bundle Components

- File: `src/actions/bundle-components.ts`
- Exports: `getBundleComponents`, `setBundleComponents`, `removeBundleComponent`, `computeBundleAvailability`, `listBundles` (workspace-level bundle list with effective availability)
  - Bundle composition management with full-graph DFS cycle detection and MIN-based availability calculation.

### Integrations + Store Mapping

- Files:
  - `src/actions/shopify.ts`
  - `src/actions/bandcamp.ts`
  - `src/actions/store-connections.ts`
  - `src/actions/sku-matching.ts`
  - `src/actions/store-mapping.ts`
  - `src/actions/client-store-credentials.ts`
  - `src/actions/pirate-ship.ts`
  - `src/actions/preorders.ts`
- Key exports:
  - bundle-components: `listBundles` (workspace-level bundle list with effective availability; see `src/actions/bundle-components.ts`)
  - trigger kickoffs/status: `triggerShopifySync`, `triggerFullBackfill`, `getShopifySyncStatus`, `triggerBandcampSync`, `getBandcampSyncStatus`, `triggerBandcampConnectionBackfill`
  - Bandcamp connection management: `createBandcampConnection`, `deleteBandcampConnection`, `getBandcampAccounts`, `getBandcampMappings`, `getOrganizationsForWorkspace`
  - scraper observability: `getBandcampScraperHealth` (log-backed activity, catalog completeness, sensor readings, block rate, review queue)
  - sales data: `getBandcampSalesOverview` (item-level sales breakdown, sortable, filterable, genre-matched)
  - backfill coverage: `getBandcampBackfillAudit` (chunk-level backfill coverage dashboard, per-account heatmap data from bandcamp_sales_backfill_log)
  - trending: `getBandcampTrending` (live dig_deeper API proxy with client-artist highlighting + 3-min server cache)
  - Sales Report API: `salesReport`, `generateSalesReport`, `fetchSalesReport` (v4, all-time transaction history with catalog_number/upc/isrc); async generate/fetch deprecated in favor of sync sales_report
  - SKU management: `updateSku` (push SKUs to Bandcamp, behind feature flag)
  - store connections and mappings: connection CRUD/test + mapping and reprocess ops; **`getStoreConnections(filters?)`** always scopes the base query to `requireAuth().userRecord.workspace_id` server-side and only applies caller filters for `orgId` / `platform` / `status` on top, so admin pages must NOT depend on a client-cached workspace id to see the correct rows. **`getStoreConnectionOrganizations()`** likewise derives the workspace on the server and returns the org picker list for `/admin/settings/store-connections`. **Bootstrap contract (2026-04-24):** `/admin/settings/store-connections/page.tsx` now server-loads BOTH reads inside the request scope and passes the results into a client child; the page no longer invokes these read actions from client-side query hooks during initial render. Interactive mutations (`createStoreConnection`, `updateStoreConnection`, `deleteStoreConnection`, `testStoreConnection`, `disableStoreConnection`) refresh the server-scoped dataset via `router.refresh()`. **`updateStoreConnection`** and **`deleteStoreConnection`** are staff-only (`requireStaff`) and scope writes to `(id, workspace_id)` for the authenticated staff workspace; **`deleteStoreConnection`** rejects `cutover_state IN ('shadow','direct')` like `disableStoreConnection`, logs `channel_sync_log.sync_type='connection_deleted'` after deletion, and order-identity FKs null out (`20260429000005_connection_delete_null_order_refs.sql`). **Connection test hardening (2026-04-24):** `testStoreConnection(connectionId)` now validates WooCommerce and Squarespace credentials through catalog reads instead of shallow order/inventory probes (`listProductsPage()` on each client) so the operator learns earlier when product-read scope or catalog reachability is broken. **Legacy non-Shopify discovery hardening (2026-04-24):** `autoDiscoverSkus(connectionId)` now scans full WooCommerce and Squarespace catalogs instead of a first-page Woo fetch / inventory-only Squarespace scan. Woo discovery comes from `src/lib/clients/woocommerce-client.ts::listCatalogItems()` (paginated products + variable-product variations, safe `per_page=20` cap), and Squarespace discovery comes from `src/lib/clients/squarespace-client.ts::listCatalogItems()` (paginated `v2/commerce/products` plus `getProductsByIds()` for variant ids/titles). **`reactivateClientStoreConnection({ connectionId })`** (Phase 0.8) is the staff-only re-enable path: flips `do_not_fanout = false`, sets `connection_status = 'active'`, clears `last_error`/`last_error_at`, and writes a `channel_sync_log` audit row tagged with the actor. The dormancy gate at `src/lib/server/client-store-fanout-gate.ts` (`shouldFanoutToConnection()`) is the single chokepoint consulted by `multi-store-inventory-push`, `client-store-order-detect`, `process-client-store-webhook`, and `createStoreSyncClient` — never bypass it. Admin UI: `/admin/settings/client-store-reconnect`.
  - **WooCommerce connection repair (2026-04-28):** `testStoreConnection`, `autoDiscoverSkus`, SKU matching remote catalog reads, and Trigger polling all route Woo REST calls through `src/lib/clients/woocommerce-client.ts`, which tries Basic Auth first, falls back once to HTTPS query-param auth on `401/403`, persists `preferred_auth_mode='query_param'` when that succeeds, and redacts credentials from URL-bearing error text. `/admin/settings/store-connections` renders a Woo webhook checklist with callback URL, required `order.created/order.updated/product.created/product.updated` topics, last webhook, poll success, and poll failure count.
  - **SKU matching workspace (2026-04-25, staff-only; repaired 2026-04-27; manual search + multi-org coverage + catalog narrowing 2026-04-28):** `listSkuMatchingClients()` and `listSkuMatchingConnections({ orgId? })` drive the picker data for `/admin/settings/sku-matching`; the org filter now includes connections whose `client_store_connection_org_coverage` contains the requested org, so umbrella Shopify stores can appear under included labels. `getSkuMatchingWorkspace({ connectionId, catalogOrgId? })` server-loads the full connection-scoped review model (canonical rows, top-ranked remote candidates, remote-only rows, conflict summaries, Discogs overlay, remote catalog fetch state) behind `workspaces.flags.sku_matching_enabled`; when `catalogOrgId` equals a coverage org (`?orgId=` from the picker), canonical rows narrow to that org only — otherwise canonical rows merge from **all** coverage orgs. The remote storefront is still fetched once per connection regardless. Canonical rows remain scoped by the selected connection's coverage org set when merged, not only `client_store_connections.org_id`; every row and preview payload includes `canonicalOrgId` + non-optional `canonicalOrgName` so staff can distinguish Northern Spy proper from Egghunt/NNA/Across before accepting a match. Workspace load parallelizes independent reads and only performs cheap Shopify readiness classification (default location + remote inventory item id); stocked-at-default-location GraphQL checks are deferred to `previewSkuMatch()` for the selected row. `getSkuMatchCandidates()` and `previewSkuMatch()` provide per-row review detail plus the candidate fingerprint used for stale-review detection. `searchSkuRemoteCatalog({ connectionId, query, limit? })` searches the fetched remote catalog by title, SKU, artist/vendor text, barcode, product ID, variant ID, and inventory item ID; choosing a result reuses `previewSkuMatch()` against that exact remote target. `rejectSkuMatchCandidate()` writes staff-authored negative evidence to `sku_match_candidate_rejections`, suppressing the remote key from automated ranking/search for the connection without mutating `client_store_sku_mappings`. Candidate fingerprints are owned by `src/lib/server/sku-matching.ts::buildCandidateFingerprint()` and must match across workspace load, preview, single accept, manual search preview, and bulk accept. Bandcamp relation data is reduced through `pickPrimaryBandcampMapping()` (URL-bearing row, then newest timestamp, then id fallback), so `bandcamp_product_mappings(...)` selects in this path must include `id`, `bandcamp_url`, `created_at`, and `updated_at`. Remote target lookup is owned by `selectConnectionScopedRemoteTarget()` and resolves inventory item -> variant -> product inside the current connection catalog; product-only multi-variant matches without a unique SKU return `ambiguous_remote_target` and instruct the operator to add SKUs upstream. `createOrUpdateSkuMatch()` and `acceptExactMatches()` persist alias matches through the `persist_sku_match` RPC (single-row and guarded bulk deterministic accepts, respectively); the RPC rejects variants whose product org is not covered by the connection. The client review drawer JSON-sanitizes confirm/accept payloads before invoking `createOrUpdateSkuMatch()` so Server Actions receive plain objects even when the payload is derived from a prior preview response, and `createOrUpdateSkuMatch()` JSON-sanitizes the RPC return before handing it back to React. Accept persistence still revalidates stale fingerprints but skips Shopify readiness and preview telemetry, because stocked-at-location checks are drawer-only operational context. The live alias table `client_store_sku_mappings` has no `org_id`; the shared scope trigger `enforce_identity_match_scope()` must extract optional `org_id` via JSONB so alias writes can still pass workspace/variant checks without raising on a missing column. `deactivateSkuMatch()` soft-deactivates the live mapping and appends a `sku_mapping_events` audit row. Shopify-specific helpers: `getShopifyMatchReadiness()` classifies `default_location_id` / `remote_inventory_item_id` / stocked-at-default-location state, and `activateShopifyInventoryAtDefaultLocation()` reuses the shared Shopify `inventory_levels/connect.json` path from `src/lib/clients/store-sync-client.ts` to make an accepted alias operational without changing quantity. Visual comparison data travels through the same read model: Shopify catalog rows expose `productUrl` from the product handle, and canonical rows expose the deterministically selected Bandcamp URL when present. The client page clears stale selection/preview/search/mutation state on client or connection changes, renders dense cards fully below 2000 rows, optimistically removes saved Accept-best-match rows while refreshing the server bootstrap in the background, mounts a page-local top-center Sonner toaster for saved/rejected outcomes so feedback floats in the viewport during scroll, bounds the review drawer/search results to the viewport, force-wraps long remote IDs, hides horizontal overflow, and surfaces Accept/Confirm failures once at page level. **Shopify digital omission (2026-05-05):** `iterateAllVariants` selects `requiresShipping`; `fetchShopifyCatalog()` omits variants matching `shouldExcludeShopifyVariantFromSkuMatchingCatalog` (`requiresShipping === false`, variant title `Digital`, or product-title suffix ` - Digital`). The workspace is intentionally read-mostly + connection-scoped; it does NOT enqueue Trigger tasks and it never rewrites remote SKUs.
  - **HRD-35 per-client Shopify Custom-distribution app onboarding (2026-04-22, staff-only):** `setShopifyAppCredentials({ connectionId, shopifyAppClientId, shopifyAppClientSecret })` writes per-connection app credentials to `client_store_connections.shopify_app_client_id` / `_secret_encrypted`. `generateShopifyInstallUrl({ connectionId, shopDomain })` returns the install URL with `connection_id` encoded in state (the OAuth route's Phase A persists the nonce server-side via `oauth_states` per HRD-35.1; this Server Action does NOT write the nonce). `listShopifyLocations({ connectionId })` reads `/admin/api/2026-01/locations.json` with the per-connection token (`read_locations` scope required — installs predating HRD-25 get a clear "re-install" error). `setShopifyDefaultLocation({ connectionId, locationId })` re-verifies the locationId is in the live Shopify list AND active before persisting to `client_store_connections.default_location_id`. The companion UI is the per-connection "Configure App" dialog at `/admin/settings/store-connections` (`src/components/admin/configure-shopify-app-dialog.tsx`).
  - **HRD-04 + HRD-18 dry-run reconciliation (2026-04-22, staff-only):** `runDirectShopifyDryRun({ connectionId, sampleSize?, skipBandwidthEstimate? })` is a read-only Server Action that runs three independent passes on a Shopify client_store connection: **(A) membership scan** — full Shopify variant walk via `iterateAllVariants`, surfaces `shopifyOnlySkus`/`warehouseOnlySkus`/`duplicateShopifySkus` (Rule #8 violation)/`shopifyVariantsWithoutSku`/`shopifyVariantsWithoutInventoryItem`; **(B) quantity drift sample** — pulls up to `sampleSize` (default 50, max 200) `client_store_sku_mappings` rows with `remote_inventory_item_id`, calls Shopify GraphQL `nodes(ids:)` via the new `getInventoryLevelsAtLocation` helper, compares against `warehouse_inventory_levels.available` at the connection's `default_location_id`, classifies each row as `diff` / `remote_not_stocked_at_location` (HRD-26 lazy-activate path) / `remote_node_missing`; **(C) bandwidth estimate** — calls Shopify GraphQL `ordersCount` via `estimateOrderVolume` (last 30d), produces `avgDailyOrders`, `estimatedDailyWebhooks` (× 2 for orders/create + inventory_levels/update), `peakHourlyRate` (× 3 burst factor), and a `safe_to_proceed` vs `gradual_rollout` recommendation (threshold: 1000 webhooks/day) for the Section 0.D Thursday runbook. Aggregates into a `verdict` block: fatal classes (duplicates, shopify-only SKUs, variants without SKU, drift > SC-1's 2% ceiling) block reactivation; warnings (warehouse-only SKUs, empty drift sample, high bandwidth) are informational. Bandwidth estimate is **fail-soft** — `ordersCount` errors are logged via `console.warn` and yield `bandwidthEstimate=null` rather than failing the dry-run. NEVER mutates Shopify or warehouse state. Companion UI is Step 6 of the per-connection "Configure App" dialog at `/admin/settings/store-connections`.
  - pirate ship imports: `initiateImport`, `getImportHistory`, `getImportDetail`
  - preorder tools: `getPreorderProducts`, `manualRelease` (triggers `preorder-release-variant` for single-variant release — NOT the full fulfillment job), `getPreorderAllocationPreview`
  - Shopify client additions: `inventoryItemUpdate`, `collectionCreate`, `collectionAddProducts`, `findOrCreateCollection`, `publishToSafeChannels`, `getPublicationIds` (all in `src/lib/clients/shopify-client.ts`). Variant input helper: `buildShopifyVariantInput` in `src/lib/clients/shopify-variant-input.ts`.

## Audit Requirement

Any diagnosis or fix plan touching sync/webhooks/inventory/orders/support must cite:

1. relevant entries in this file, and
2. matching tasks in `docs/system_map/TRIGGER_TASK_CATALOG.md`.
