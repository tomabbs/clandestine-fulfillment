# Release Gate Criteria

Purpose: define the minimum confidence bar before deploying reliability fixes or major upgrades.

This gate complements:
- `docs/PROD_MIGRATION_RLS_PARITY_CHECKLIST.md`
- `docs/INTEGRATION_REGISTRATION_MATRIX.md`
- `scripts/sql/prod_parity_checks.sql`
- `scripts/sql/webhook_health_snapshot.sql`

> **Last full automated sweep:** 2026-04-22 (Direct-Shopify cutover finish-line P0–P7). All Section A checks PASS (`pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm exec biome check` 0 errors / `scripts/check-webhook-runtime.sh` + `scripts/check-fulfilled-quantity-writers.sh` CI guards green). New finish-line surface area covered: F-1 partial-cancel recredit + telemetry, F-2 Node runtime pin on every webhook route, F-3/F-4 typed dedup + canonical-form sha256 fallback, F-5 Shopify `myshopifyDomain` install verification, B-1 `bandcamp-order-sync` 15-min cadence + global idempotency, B-2 `fulfillmentCreate` GraphQL migration, B-3 Channels webhook health card + idempotent `diffWebhookSubscriptions`, B-4 megaplan 5-source classifier with Shopify-direct probe. **Section C** ("Direct Shopify cutover preconditions") below lists the 4 hard gates that must additionally pass before flipping `do_not_fanout=false` in production. Megaplan Finish-Line v4 (2026-04-13) baselines remain in force; this entry adds to (does not replace) the prior gate set.

---

## Quick run

Automated subset:

```bash
pnpm release:gate
```

Automated subset + critical e2e:

```bash
bash scripts/release-gate.sh --with-e2e
```

This runner executes all local automatable checks and then prints required manual SQL/Trigger steps.

---

## 1) Required checks (must pass)

### A. Static + build checks

Run:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm build
bash scripts/ci-inventory-guard.sh
bash scripts/ci-webhook-dedup-guard.sh
```

Pass criteria:
- all commands exit with status `0`
- no new failing tests

---

### A1. Cache architecture conformance (mandatory)

Run:

```bash
pnpm test tests/unit/lib/query-tiers.test.ts tests/unit/lib/query-keys.test.ts
pnpm test:integration tests/integration/tenant-isolation.test.ts
```

Pass criteria:
- query tier and key-contract unit tests pass
- tenant-isolation integration test passes when integration env vars are configured
- if integration env vars are not configured, skip must be explicitly noted in release notes with owner + follow-up date
- any cache-policy changes must include doc updates in:
  - `docs/system_map/CACHE_ARCHITECTURE.md`
  - `docs/system_map/API_CATALOG.md` (if action/read boundaries changed)
  - `TRUTH_LAYER.md`

---

### B. Migration and RLS parity checks

Run in production SQL editor:
- `scripts/sql/prod_parity_checks.sql`

Pass criteria:
- required tables present
- required policies present
- RLS enabled on critical tables
- migration versions present for required entries

---

### C. Integration registration and webhook health

Run in production SQL editor:
- `scripts/sql/webhook_health_snapshot.sql`

Pass criteria:
- expected integrations show recent webhook activity (or documented maintenance window)
- no unexplained error spikes in `webhook_events`
- client store connections do not show persistent stale/failing state
- for first-party Shopify webhook traffic, `ignored_shipstation_authoritative` is expected for inventory/order topics while ShipStation remains authoritative for order/inventory movement

---

### C.1 Direct Shopify cutover preconditions (Section C — added 2026-04-22)

Hard gates required **in addition to A–E** before any production cutover that
flips `client_store_connections.do_not_fanout = false` for the direct-Shopify
ingestion path. All four are CI-enforceable via
`bash scripts/check-release-gates.sh`; that script must exit 0 on `main`
before tagging a cutover build.

| ID | Gate | How verified |
|---|---|---|
| HRD-08.1 | Partial-cancel recredit honors `warehouse_order_items.fulfilled_quantity` (DB is canonical when it disagrees with `orders/cancelled` payload `fulfillment_status`). | `pnpm vitest run tests/unit/trigger/process-client-store-webhook.test.ts` MUST pass; the F-1 triad (none / partial / all fulfilled) MUST appear in the suite. |
| HRD-23 | Every `src/app/api/webhooks/**/route.ts` exports both `runtime = "nodejs"` and `dynamic = "force-dynamic"`. | `bash scripts/check-webhook-runtime.sh` exits 0; `bash scripts/check-fulfilled-quantity-writers.sh` exits 0. |
| HRD-10 | `/api/oauth/shopify` rejects installs whose `shop.myshopifyDomain` does not match the normalized `shop` query param; persists the verified domain into `client_store_connections.shopify_verified_domain` on success. | Schema probe asserts column present; `tests/unit/api/oauth/shopify-route.test.ts` MUST pass; staff Channels page surfaces the verified domain on every Shopify connection row. |
| HRD-35 gap #3 | `registerShopifyWebhookSubscriptions` runs as a hook on every successful OAuth install; manual "Re-register webhooks" on Channels uses the same code path and is idempotent (`diffWebhookSubscriptions` no-op on aligned state). | `pnpm vitest run tests/unit/lib/server/shopify-webhook-subscriptions.test.ts` (≥17 tests) MUST pass; `client_store_connections` schema includes `webhook_topic_health` + `webhook_subscriptions_audit_at` + `last_webhook_at`. |
| P9 / merge-coverage | Every public-schema table that holds `org_id` or carries an FK to `organizations(id)` is registered in `merge_organizations_txn.v_tables` (otherwise the merge RPC trips `merge_delete_failed` at runtime via the orphan-FK violation). | `DATABASE_URL=… bash scripts/check-org-constraints.sh` exits 0 (parses `v_tables` from `supabase/migrations/20260423000001_org_merge_rpc.sql`, diffs against the live DB). Wired into `scripts/check-release-gates.sh` — emits `SKIP` when DATABASE_URL is unavailable, `PASS`/`FAIL` otherwise. |

Operator note: `scripts/check-release-gates.sh` is referenced by the Section D
cutover runbook (`docs/prompt-packs/BUILD.md` + the finish-line plan T-2
preflight). It performs four steps:

1. Asserts that the four migrations are applied (`select 1 from
   information_schema.columns where ...`) for `fulfilled_quantity`,
   `shopify_verified_domain`, `webhook_topic_health`,
   `webhook_subscriptions_audit_at`, `last_webhook_at`, `dedup_key`,
   `shopify_direct_available`.
2. Runs the two CI grep guards (`check-webhook-runtime.sh`,
   `check-fulfilled-quantity-writers.sh`).
3. Runs the four test files referenced in the table above and fails on any
   non-zero exit.
4. Asserts that `process.env.SHOPIFY_API_VERSION === '2026-01'` (cutover-pinned
   version) and `process.env.WEBHOOK_ECHO_SHOPIFY_DIRECT` is **set** (its
   value can be `off` pre-cutover; the gate only checks it is not undefined,
   so the operator has explicitly thought about it).

If any gate fails, the cutover is blocked and the failing gate ID must be
listed on the rollback ticket.

---

### C.2 Per-connection cutover state machine preconditions (Phase 3 Pass 1 — added 2026-04-23)

Hard gates required **in addition to A–C.1** before any production deployment
that exposes the per-connection cutover wizard. These are also CI-enforceable
via `bash scripts/check-release-gates.sh`.

| ID | Gate | How verified |
|---|---|---|
| C.2.1 | `client_store_connections.cutover_state` column present (`text`, `NOT NULL DEFAULT 'legacy'`), constrained to `legacy | shadow | direct`, with audit columns `cutover_started_at`, `cutover_completed_at`, `shadow_mode_log_id`, `shadow_window_tolerance_seconds`. | Schema probe in `scripts/check-release-gates.sh` (`information_schema.columns`); `pnpm vitest run tests/unit/lib/server/client-store-fanout-gate.test.ts` covers the legacy/shadow/direct branches and the unrecognized-value defensive deny. |
| C.2.2 | `connection_shadow_log` table exists with the columns needed by the Pass 2 comparison hook (`workspace_id`, `connection_id`, `correlation_id`, `sku`, `pushed_quantity`, `pushed_at`, `ss_observed_quantity`, `observed_at`, `match`, `drift_units`, `cutover_state_at_push`, `metadata`). | Schema probe in `scripts/check-release-gates.sh`; the table is the primary substrate for Pass 2 D3 diagnostics — without it the wizard cannot render the 7-day match-rate. |
| C.2.3 | Drift artifact retention scaffolding present — partial index `idx_connection_shadow_log_retention` on `connection_shadow_log (created_at) WHERE match IS NOT NULL OR observed_at IS NOT NULL` makes the future `prune-shadow-log` sweep index-only. | Schema probe in `scripts/check-release-gates.sh` (Pass 2 D6, migration `20260427000003_connection_echo_overrides_metadata.sql`). |
| C.2.4 | The DB CHECK constraint `client_store_connections_cutover_dormancy_check` rejects `(cutover_state IN ('shadow','direct'), do_not_fanout=true)` so a mid-cutover row cannot be silently disabled out from under the wizard. | Schema probe in `scripts/check-release-gates.sh`; `pnpm vitest run tests/unit/actions/store-connections.test.ts` covers the actionable-error branch in `disableStoreConnection`. |
| C.2.5 | `connection_echo_overrides` table exists with a partial unique index that prevents two active rows for the same `(connection_id, override_type)` pair. | Schema probe in `scripts/check-release-gates.sh`; the partial unique index `uq_connection_echo_overrides_active` enforces the invariant. |
| C.2.6 | `connection_echo_overrides.metadata jsonb NOT NULL` column present so `runConnectionCutover()` can persist the diagnostics snapshot + operator id + force reason for forensic replay. | Schema probe in `scripts/check-release-gates.sh` (Pass 2 D4 + D6, migration `20260427000003_connection_echo_overrides_metadata.sql`). |
| C.2.7 | `shadow_window_tolerance_seconds` is bounded between 30 and 600 by the DB CHECK `client_store_connections_shadow_window_check` so an operator cannot set a 1-second window that races SS Inventory Sync mirror latency. | Schema probe in `scripts/check-release-gates.sh`; the wizard input also clamps to 30..600. |

Phase 3 Pass 1 deliverables (D1, partial D4, partial D6) are GA-safe today
because all changes are additive: the DB defaults every existing row to
`cutover_state='legacy'`, the gate treats `'legacy'` exactly as before, and
no fanout call site changes behavior unless an operator explicitly inserts a
`connection_echo_overrides` row (which Pass 2 gates behind the wizard).

**Phase 3 Pass 2 (D2 / D3 / D4 / D5 / D6 — added 2026-04-27)** completes the
operator surface:

* The shadow-mode write hook (`recordShadowPush()`, called from
  `client-store-push-on-sku` whenever `conn.cutover_state === 'shadow'`)
  inserts a row into `connection_shadow_log` and enqueues a delayed
  `shadow-mode-comparison` Trigger task. The comparison task re-reads
  ShipStation v2 inventory after the per-connection
  `shadow_window_tolerance_seconds` window and persists `match` +
  `drift_units` back to the originating row. Skip cascades (no v2
  defaults, v2 read failed, etc.) write a structured `metadata.skip_reason`
  so the diagnostics surface can bucket them.
* `getCutoverDiagnostics(connectionId)` returns 7-day rolling counters
  (resolved, matched, drifted, unresolved, comparison_skipped, mean +
  max |drift|), recent drift samples (cap 25), the
  `comparison_skip_breakdown`, and the gate evaluation (`eligible`,
  `gate_reason`). Required match rate is 99.5% across ≥ 50 resolved
  comparisons.
* `runConnectionCutover(connectionId, { force, forceReason })` enforces
  three gates in order: (1) connection must be in `shadow`, (2)
  diagnostics must be `eligible` (bypassable with `force=true` +
  `forceReason ≥ 8 chars`), (3) no `external_sync_events` with
  `status='in_flight'` for this connection's sync system within the last
  5 minutes. On pass it inserts `connection_echo_overrides` row FIRST
  (audit row carries the diagnostics snapshot + operator id + force
  reason in `metadata`), then flips `client_store_connections.cutover_state`
  to `'direct'`. Order matters: a crash between the two writes leaves
  the connection in `shadow` with an active override — safe (still in
  shadow logging mode) and auto-recoverable.
* `rollbackConnectionCutover(connectionId, { reason })` deactivates any
  active `connection_echo_overrides` rows (`is_active=false`) and reverts
  `cutover_state='legacy'`. Idempotent on already-legacy.
* The wizard at `/admin/settings/connection-cutover` exposes the picker,
  diagnostics panel, and three transition buttons. The "Cutover to
  direct" button is disabled unless `gate.eligible` is true OR the
  operator has checked "Force" and supplied a reason ≥ 8 chars. The
  rollback always requires a reason ≥ 8 chars (Zod-validated). Sidebar
  link added under Settings.

---

### C.3 SKU matching rollout preconditions (added 2026-04-25)

Hard gates required before staff are told to use `/admin/settings/sku-matching`
as the canonical alias-review workspace.

| ID | Gate | How verified |
|---|---|---|
| SKU-1 | Duplicate cleanup completed before active-row unique indexes are applied. | `reports/sku-matching-duplicate-audit-20260425T1337Z.json` shows zero duplicate groups; `npx tsx scripts/remediate-sku-mapping-duplicates.ts` dry-run + `--live` both report zero rows to deactivate (or an operator-approved remediation log is attached for non-zero cases). |
| SKU-2 | SKU matching schema/RPC substrate is present on the linked production database. | `supabase migration list --linked` shows `20260425000002_sku_matching_provenance`; `supabase db push --yes --include-all` completed successfully; `persist_sku_match`, `find_remote_to_canonical_dupes`, and `find_canonical_sku_duplicates` are callable. |
| SKU-3 | Review drawer stale-match protection is live. | `pnpm typecheck` passes and `pnpm test -- tests/unit/lib/server/sku-matching.test.ts` passes; operator spot-check confirms a changed candidate fingerprint blocks `createOrUpdateSkuMatch()` until the preview is refreshed. |
| SKU-4 | Shopify operational readiness is visible before staff accept Shopify aliases. | On a Shopify connection with `default_location_id` set, `getShopifyMatchReadiness()` returns one of the explicit readiness states (`ready_at_default_location`, `missing_default_location`, `missing_remote_inventory_item_id`, `not_stocked_at_default_location`, `location_read_failed`), and the review drawer can call `activateShopifyInventoryAtDefaultLocation()` for non-ready accepted matches. |
| SKU-5 | Monitoring exists before rollout widens beyond initial staff review. | `supabase migration list --linked` shows `20260425000003_sku_matching_monitoring`; SKU matching server actions emit best-effort rows into `sku_matching_perf_events`; and scheduled task `sku-matching-monitor` writes weekly `sensor_readings` plus a review-queue alert when conflict growth breaches the rollout threshold. |

Operator note: this workspace is intentionally connection-scoped and read-mostly.
It does not enqueue Trigger tasks and does not rewrite remote SKUs; the release
bar is therefore focused on duplicate safety, RPC availability, stale-review
protection, and Shopify activation readiness.
Phase 6 adds a lightweight telemetry gate as well so slow connection loads or
steady conflict growth become operator-visible before the workspace is expanded.

---

### C.4 Tracking-notification hardening preconditions (added 2026-04-25)

Hard gates required before the EasyPost-driven customer tracking + notification path is rolled out (or before the legacy `/api/webhooks/aftership` route is fully sunset).

| ID | Gate | How verified |
|---|---|---|
| TN-1 | Webhook secret rotation envelope is set on every prod environment. | `pnpm ops:check-webhook-secrets` exits 0 — confirms `EASYPOST_WEBHOOK_SECRET`, `EASYPOST_WEBHOOK_SECRET_PREVIOUS`, `RESEND_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SECRET_PREVIOUS` are present in env (current required; previous optional but allowed-empty). |
| TN-2 | Centralized status writes are enforced in CI. | `bash scripts/check-notification-status-writes.sh` exits 0 — no direct writes to `notification_sends.status` or `warehouse_shipments.easypost_tracker_status` outside `src/lib/server/notification-status.ts`. The legacy `/api/webhooks/aftership` route's direct `warehouse_shipments.status` write is intentionally excluded from this guard during the dual-mode sunset window. |
| TN-3 | Idempotency unique index applied without conflict. | `supabase migration list --linked` shows the Slice 2 state-machine migration; pre-migration duplicate detector ran clean (or operator-approved remediation log is attached); `notification_sends_unique_send` partial index present on `(workspace_id, shipment_id, kind, idempotency_key)`. |
| TN-4 | Provider ledger + operator audit tables exist. | `notification_provider_events` (with normalized `workspace_id` + `shipment_id` columns + `provider IN ('resend','easypost')`) and `notification_operator_events` (FK → `public.users(id)`) present and writable by the service role. |
| TN-5 | Test suite green for the tracking-notification path. | `pnpm vitest run tests/unit/lib/server/notification-status.test.ts tests/unit/lib/server/notification-sends.test.ts tests/unit/lib/server/notification-provider-events.test.ts tests/unit/api/webhooks/easypost-route.test.ts tests/unit/api/webhooks/resend-route.test.ts tests/unit/lib/carrier-tracking-urls.test.ts tests/unit/lib/tracking-email-templates.test.ts tests/unit/lib/resend-client.test.ts tests/unit/scripts/check-notification-status-writes.test.ts tests/unit/scripts/check-webhook-secrets.test.ts tests/unit/server/easypost-webhook-signature.test.ts tests/unit/server/resend-webhook-signature.test.ts tests/unit/trigger/send-tracking-email-recon.test.ts tests/unit/actions/notification-operations.test.ts tests/unit/lib/public-track-token.test.ts` exits 0 (194+ tests passing). |
| TN-6 | Parity sensor between aftership and easypost is live and green. | `tracking.status_drift_24h` sensor reports zero divergent shipments for ≥7 days before the aftership route is removed. Until then both routes run; only `/api/webhooks/easypost` is wired into label creation. |
| TN-7 | Operator surface deployed. | `/admin/operations/notifications` page renders with 24h status counts (incl. `provider_failed`/`delivered`/`cancelled`), suppression count, last sensor run, and currently-stuck rows. Per-shipment audit drilldown link visible from at least one shipment surface. |
| TN-8 | Public tracking page PII allowlist enforced. | `tests/unit/lib/public-track-token.test.ts` passes — confirms `pickPublicDestination` and `PublicTrackingShipment` types only expose `name`/`city`/`state`/`country`/`postal_code`. |

Release manifest split for the four sequential PRs lives at `docs/RELEASE_SLICES_TRACKING_NOTIFICATION.md`.

---

### D. Trigger runtime smoke checks

Follow:
- `docs/TRIGGER_SMOKE_CHECKLIST.md`

Pass criteria:
- Trigger auth/environment valid
- one scheduled task smoke run succeeds
- one event task smoke run succeeds

---

### E. Critical user-flow smoke (manual)

Required flows:
1. Client invite user from admin client settings
2. Portal support create + reply, plus staff Support Inbox reply from `/admin/support` with collision-safe draft preservation and visible delivery status
3. Portal inbound submit
4. One core admin operational page load (`/admin/inventory` or `/admin/inbound`)
5. Support omnichannel checks:
   - floating launcher unread count updates
   - presence indicators show online/offline state
   - email reply lands in existing conversation timeline

Pass criteria:
- no generic Server Components 500 errors
- any validation failure is presented as readable UI error

---

## 2) E2E gate (minimum set)

Run:

```bash
pnpm test:e2e -- tests/e2e/inbound-flow.spec.ts tests/e2e/inventory-flow.spec.ts
```

Pass criteria:
- selected specs pass in CI
- no flaky retries > 1 in CI for two consecutive runs

Note:
- `playwright.config.ts` currently sets retries in CI and single worker in CI.
- Keep this minimal suite stable before broadening e2e scope.

---

## 3) Release decision rule

A release is **blocked** if any required section (A-E) fails.

If a check is intentionally skipped, it must include:
- written reason
- risk acceptance owner
- rollback plan

---

## 4) Full-site audit interpretation (optional but recommended)

Run:

```bash
pnpm test:e2e:full-audit
```

Read the latest markdown report in `reports/playwright-audit/full-site-audit-*.md`.

Treat as **release-blocking regression** when any of the following are true:
- `Failed` routes is greater than `0`
- `Page errors captured` is greater than `0`
- any route includes a `network` issue caused by HTTP `5xx` responses

Treat as **non-blocking noise** (track separately) when:
- warnings are only known UI-library ref warnings (`Function components cannot be given refs`)
- warnings are image ratio notices (for example `/logo.webp` sizing)
- network issues are only `requestfailed` script aborts (`net::ERR_ABORTED`) during rapid route transitions and no page errors/5xx are present

Goal trend:
- keep failed routes at `0`
- keep page errors at `0`
- keep HTTP `5xx` network issues at `0`

---

## 5) Suggested cadence

- Reliability fix releases: run full gate every release
- Major upgrade releases: full gate + expanded e2e suite
- Weekly ops review: rerun webhook health snapshot + Trigger smoke subset
