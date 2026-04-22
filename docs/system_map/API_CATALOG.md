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
| `POST` | `/api/webhooks/aftership` | `src/app/api/webhooks/aftership/route.ts` | AfterShip webhook ingest |
| `POST` | `/api/webhooks/stripe` | `src/app/api/webhooks/stripe/route.ts` | Stripe billing webhooks |
| `POST` | `/api/webhooks/resend-inbound` | `src/app/api/webhooks/resend-inbound/route.ts` | Resend inbound email hooks |
| `POST` | `/api/webhooks/client-store` | `src/app/api/webhooks/client-store/route.ts` | Generic client store webhook ingress (Shopify / WooCommerce / Squarespace). Verifies HMAC, dedups via `webhook_events` (HRD-22 `X-Shopify-Event-Id` precedence), enforces HRD-24 per-platform freshness ceilings (Shopify 72h), runs HRD-30 PII sanitization on stored payloads, then enqueues `process-client-store-webhook` with HRD-29 global-scope idempotency key (HRD-17.1 enqueue-failure path = HTTP 503 + `status='enqueue_failed'` + 5-min recovery sweeper retry). **F-3 / F-4 (2026-04-22):** dedup pathway is now driven by the typed `interpretDedupError` helper in `src/lib/server/webhook-body.ts` — `transient` PG errors map to HTTP 503 (so upstream retries), `unknown` map to 503 + Sentry, `duplicate` returns 200 OK; non-`fresh` outcomes log `{ connection_id, platform, topic, external_webhook_id, dedup_kind, error_code }`. Squarespace (and any header-less platform) use `canonicalBodyDedupKey({ platform, rawBody })` → `{platform}:{sha256(rawBody)}` as the dedup-key fallback, persisted on `webhook_events.dedup_key`. Heavy processing happens in the Trigger task — see `process-client-store-webhook` in `TRIGGER_TASK_CATALOG.md` for the four handlers (`handleInventoryUpdate` Shopify `inventory_item_id`→SKU, `handleRefund` Shopify `refunds/create`, `handleOrderCancelled` Shopify `orders/cancelled` with F-1 partial-recredit, `handleOrderCreated` writes `warehouse_order_items.fulfilled_quantity`). HRD-23 / F-2: `runtime='nodejs'` + `dynamic='force-dynamic'` enforced by `scripts/check-webhook-runtime.sh`. |
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

### Portal Experience

- Files:
  - `src/actions/portal-dashboard.ts`
  - `src/actions/portal-sales.ts`
  - `src/actions/portal-settings.ts`
  - `src/actions/portal-stores.ts`
  - `src/actions/support.ts`
- Key exports:
  - `getPortalDashboard`, `getSalesData`, `getPortalSettings`, `updateNotificationPreferences`
  - portal stores: `getMyStoreConnections`, `getWooCommerceAuthUrl`, `deleteStoreConnection`
  - support: `getConversations`, `getConversationDetail`, `getSupportViewerContext`, `createConversation`, `sendMessage`, `markConversationRead`, `resolveConversation`, `assignConversation`, `suggestSupportReply`

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
  - store connections and mappings: connection CRUD/test + mapping and reprocess ops; **`reactivateClientStoreConnection({ connectionId })`** (Phase 0.8) — staff-only Server Action that flips `do_not_fanout = false`, sets `connection_status = 'active'`, clears `last_error`/`last_error_at`, and writes a `channel_sync_log` audit row tagged with the actor. The dormancy gate at `src/lib/server/client-store-fanout-gate.ts` (`shouldFanoutToConnection()`) is the single chokepoint consulted by `multi-store-inventory-push`, `client-store-order-detect`, `process-client-store-webhook`, and `createStoreSyncClient` — never bypass it. Admin UI: `/admin/settings/client-store-reconnect`.
  - **HRD-35 per-client Shopify Custom-distribution app onboarding (2026-04-22, staff-only):** `setShopifyAppCredentials({ connectionId, shopifyAppClientId, shopifyAppClientSecret })` writes per-connection app credentials to `client_store_connections.shopify_app_client_id` / `_secret_encrypted`. `generateShopifyInstallUrl({ connectionId, shopDomain })` returns the install URL with `connection_id` encoded in state (the OAuth route's Phase A persists the nonce server-side via `oauth_states` per HRD-35.1; this Server Action does NOT write the nonce). `listShopifyLocations({ connectionId })` reads `/admin/api/2026-01/locations.json` with the per-connection token (`read_locations` scope required — installs predating HRD-25 get a clear "re-install" error). `setShopifyDefaultLocation({ connectionId, locationId })` re-verifies the locationId is in the live Shopify list AND active before persisting to `client_store_connections.default_location_id`. The companion UI is the per-connection "Configure App" dialog at `/admin/settings/store-connections` (`src/components/admin/configure-shopify-app-dialog.tsx`).
  - **HRD-04 + HRD-18 dry-run reconciliation (2026-04-22, staff-only):** `runDirectShopifyDryRun({ connectionId, sampleSize?, skipBandwidthEstimate? })` is a read-only Server Action that runs three independent passes on a Shopify client_store connection: **(A) membership scan** — full Shopify variant walk via `iterateAllVariants`, surfaces `shopifyOnlySkus`/`warehouseOnlySkus`/`duplicateShopifySkus` (Rule #8 violation)/`shopifyVariantsWithoutSku`/`shopifyVariantsWithoutInventoryItem`; **(B) quantity drift sample** — pulls up to `sampleSize` (default 50, max 200) `client_store_sku_mappings` rows with `remote_inventory_item_id`, calls Shopify GraphQL `nodes(ids:)` via the new `getInventoryLevelsAtLocation` helper, compares against `warehouse_inventory_levels.available` at the connection's `default_location_id`, classifies each row as `diff` / `remote_not_stocked_at_location` (HRD-26 lazy-activate path) / `remote_node_missing`; **(C) bandwidth estimate** — calls Shopify GraphQL `ordersCount` via `estimateOrderVolume` (last 30d), produces `avgDailyOrders`, `estimatedDailyWebhooks` (× 2 for orders/create + inventory_levels/update), `peakHourlyRate` (× 3 burst factor), and a `safe_to_proceed` vs `gradual_rollout` recommendation (threshold: 1000 webhooks/day) for the Section 0.D Thursday runbook. Aggregates into a `verdict` block: fatal classes (duplicates, shopify-only SKUs, variants without SKU, drift > SC-1's 2% ceiling) block reactivation; warnings (warehouse-only SKUs, empty drift sample, high bandwidth) are informational. Bandwidth estimate is **fail-soft** — `ordersCount` errors are logged via `console.warn` and yield `bandwidthEstimate=null` rather than failing the dry-run. NEVER mutates Shopify or warehouse state. Companion UI is Step 6 of the per-connection "Configure App" dialog at `/admin/settings/store-connections`.
  - pirate ship imports: `initiateImport`, `getImportHistory`, `getImportDetail`
  - preorder tools: `getPreorderProducts`, `manualRelease` (triggers `preorder-release-variant` for single-variant release — NOT the full fulfillment job), `getPreorderAllocationPreview`
  - Shopify client additions: `inventoryItemUpdate`, `collectionCreate`, `collectionAddProducts`, `findOrCreateCollection`, `publishToSafeChannels`, `getPublicationIds` (all in `src/lib/clients/shopify-client.ts`). Variant input helper: `buildShopifyVariantInput` in `src/lib/clients/shopify-variant-input.ts`.

## Audit Requirement

Any diagnosis or fix plan touching sync/webhooks/inventory/orders/support must cite:

1. relevant entries in this file, and
2. matching tasks in `docs/system_map/TRIGGER_TASK_CATALOG.md`.
