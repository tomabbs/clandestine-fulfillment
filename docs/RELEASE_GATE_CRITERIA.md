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
bash scripts/ci-use-server-exports-guard.sh
pnpm build
bash scripts/ci-inventory-guard.sh
bash scripts/ci-webhook-dedup-guard.sh
```

Pass criteria:
- all commands exit with status `0`
- no new failing tests

Note: `scripts/ci-use-server-exports-guard.sh` runs BEFORE `pnpm build`. It
AST-parses every `src/**/*.{ts,tsx}` file that carries the `"use server"`
directive and fails fast (~200ms) if any module exports anything other than
`async function`s (or erased types). This guard was added 2026-04-26 after a
Phase 6 deploy hit the `Error: A "use server" file can only export async
functions, found object` build failure (NextJS RSC validation at page-data
collection). Without this guard, the same class of bug costs ~90s of
CI time and produces a stacktrace pointing at compiled `.next/server/*`
chunks rather than the offending source line. See
`scripts/check-use-server-exports.ts` for the full rule set and
`tests/unit/scripts/check-use-server-exports.test.ts` for the 14-case
coverage matrix.

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

### C.5 Autonomous SKU matching preconditions (added 2026-04-26)

The `SKU-AUTO-*` namespace is ADDITIVE to the existing `SKU-1..5` gates in
Section C.3 — both sets must pass before general availability of the
autonomous-matching feature. The plan for this feature lives at
`/Users/tomabbs/.cursor/plans/autonomous_sku_matching_da557209.plan.md`.

Gates marked `Active` are backed by migration / code / CI and are enforced
now. Gates marked `Pending-Phase-N` are design-frozen in the plan but
will only be asserted once the phase ships; they are listed here so the
release-gate script can grow into them without re-negotiating the
contract.

| ID | Gate | Status | How verified |
|---|---|---|---|
| SKU-AUTO-1 | Identity-only rows in `client_store_product_identity_matches` are never consumed by `inventory-fanout.ts`, `client-store-fanout-gate.ts`, `multi-store-inventory-push`, or `process-client-store-webhook`. | Active | `bash scripts/ci-checks/sku-identity-no-fanout.sh` exits 0 (wired into `release-gate.sh` + `cloud-agent-verify.sh`). Phase 2 adds a positive test fixture. |
| SKU-AUTO-6 | Two-set drift guard: `STORED_IDENTITY_OUTCOME_STATES` (TS) equals the DB CHECK on `client_store_product_identity_matches.outcome_state`; `FULL_OUTCOME_STATES` equals the STORED set ∪ `{ 'auto_live_inventory_alias' }`; every legal transition edge references only states in `FULL_OUTCOME_STATES`. | Active | `pnpm vitest run tests/unit/lib/server/sku-outcome-transitions.test.ts` — the test reads migration `20260428000001_sku_autonomous_matching_phase0.sql` at runtime and diffs the CHECK constraint against the TS sets. |
| SKU-AUTO-12 | `client_store_product_identity_matches` CHECK constraint enforces the per-outcome `variant_id` nullability rules so `auto_database_identity_match` / `auto_shadow_identity_match` without a `variant_id` are rejected at insert time. | Active | Migration `20260428000001_sku_autonomous_matching_phase0.sql` defines `client_store_product_identity_matches_variant_nullability_check`; regression test added with Phase 2 insert fixtures. |
| SKU-AUTO-13 | Remote-listing uniqueness on `client_store_product_identity_matches` via three partial unique indexes: `(connection_id, remote_product_id, remote_variant_id)`, `(connection_id, remote_inventory_item_id)`, `(connection_id, remote_fingerprint)`. | Active | Schema probe (Phase 0 migration); Phase 2 duplicate-insert regression test. |
| SKU-AUTO-14 | Every `applyOutcomeTransition` call supplies `expectedStateVersion` + `reasonCode`. Stale `state_version` fails cleanly; missing `reasonCode` fails the DB CHECK. | Active | `validateOutcomeTransition()` rejects empty `reasonCode` at runtime; `apply_sku_outcome_transition` RPC (migration `20260428000002_sku_autonomous_matching_phase1_rpc.sql`) enforces OCC via `p_expected_state_version` and raises on missing `p_reason_code`; mapped to `stale_state_version` in the TS wrapper. Covered by `tests/unit/lib/server/sku-outcome-transitions.test.ts` (migration-shape drift guard + 15 wrapper cases) and by `tests/integration/sku-outcome-transition-concurrency.test.ts` (live-DB SKU-AUTO-14 / SKU-AUTO-22 evidence). |
| SKU-AUTO-25 | `buildRemoteFingerprint` returns SHA-256 hex digests; different vinyl sizes / colors / editions produce different hashes; frozen fixtures stay byte-identical across commits. | Active | `pnpm vitest run tests/unit/lib/server/remote-fingerprint.test.ts` (12 cases, incl. frozen-hash stability). |
| SKU-AUTO-26 | Cross-workspace inserts into `client_store_product_identity_matches` and `client_store_sku_mappings` are rejected at the DB trigger level. | Active for trigger; Pending-Phase-2 for insert-regression tests | Migration `20260428000001_sku_autonomous_matching_phase0.sql` attaches `enforce_identity_match_scope()` to both tables; Phase 2 fixture tests exercise the rejection paths. |
| SKU-AUTO-2 | Deterministic warehouse-positive aliases are only written via `persist_sku_match` (directly or via `promote_identity_match_to_alias` → `persist_sku_match`). No other path writes `client_store_sku_mappings`. | Pending-Phase-2 | RPC `promote_identity_match_to_alias` is already shipped (Phase 0 migration); Phase 2 adds the grep guard + test fixtures. |
| SKU-AUTO-3 | Webhook-ingest and poll-ingest both construct `NormalizedClientStoreOrder` via the shared adapter and call `evaluateOrderForHold()`, OR the poll path is explicitly disabled for any connection with `non_warehouse_order_hold_enabled=true`. | Pending-Phase-2 | `loadNormalizedOrder()` + `evaluateOrderForHold()` + parity integration test land with Phase 2. |
| SKU-AUTO-4 | Fetch-incomplete connections are excluded from client correction reports and from live-alias promotion. | Pending-Phase-5 | Connection-scoped filter in report queries + promotion RPC preflight. |
| SKU-AUTO-5 | Query-key / cache tests cover every new stock-exception, hold-queue, identity-match, and autonomous-run read surface. | Pending-Phase-2 | Added alongside the admin views in `src/lib/shared/query-keys.ts`. |
| SKU-AUTO-7 | Stock-based tiebreaks never fire when warehouse tier ≠ `authoritative` or remote tier ∈ `{ cached_only, unknown }`; `fresh_remote_unbounded` never participates in numeric tiebreaks. | Pending-Phase-2 | `rankSkuCandidates()` tests land with Phase 2. |
| SKU-AUTO-8 | Promotion from `auto_database_identity_match` to `auto_live_inventory_alias` only occurs via documented paths A/B/C, and every promotion writes a `sku_outcome_transitions` row + a `sku_autonomous_decisions` row. | Pending-Phase-3 | Alias-promotion wrapper in `src/lib/server/sku-alias-promotion.ts` + integration test. |
| SKU-AUTO-9 | Holdout backlog cannot exceed the stop-condition thresholds (10 evaluations / 90 days); a periodic job enforces the give-up transition. | Pending-Phase-5 | `sku-holdout-stop-condition-sweep` Trigger task + test. |
| SKU-AUTO-10 | `warehouse_orders.fulfillment_hold` is treated as a distinct state by every downstream consumer (ShipStation export, fulfillment UI, commitments). No consumer coerces `on_hold` into ShipStation's `on_hold` or into `cancelled`. | Pending-Phase-3 | Consumer grep + contract test. |
| SKU-AUTO-11 | State-machine enforcement is split across `sku-outcome-transitions.ts`, `sku-alias-promotion.ts`, and `order-hold-policy.ts`. No module writes to another module's table. | Pending-Phase-3 | CI test asserts each module's legal-transition table references only states that module owns. |
| SKU-AUTO-15 | `order_fulfillment_hold_events` is written in the same transaction as every `fulfillment_hold` state change. One `hold_applied` event per cycle, one `hold_released` per release, one `hold_alert_sent` per dispatch. | Pending-Phase-3 | RPC-driven hold transitions + test. |
| SKU-AUTO-16 | The client alert task `send-non-warehouse-order-hold-alert` is idempotent on `(workspace_id, order_id, hold_cycle_id)`. | Pending-Phase-3 | Task ships with test that reruns twice per cycle. |
| SKU-AUTO-17 | `releaseFulfillmentHold(orderId, { resolutionCode })` rejects any `resolutionCode` outside the enum; `staff_override` without a note is rejected. | Pending-Phase-3 | Server Action + Zod test. |
| SKU-AUTO-18 | Dry-run mode (Phase 1) writes `sku_autonomous_runs` + `sku_autonomous_decisions` but writes nothing to identity tables, alias tables, `warehouse_orders.fulfillment_hold`, or the alert task queue. | Pending-Phase-2 | Dry-run runner test. |
| SKU-AUTO-19 | Before enabling `sku_identity_autonomy_enabled` (Phase 2) or `sku_live_alias_autonomy_enabled` (Phase 7) on a connection, a signed-off `warehouse_review_queue` row of category `sku_autonomous_canary_review` must exist. | Active | Enforced in `src/actions/sku-autonomous-canary.ts::flipAutonomousMatchingFlag()` — canary-gated flags refuse to flip ON until a RESOLVED `warehouse_review_queue` row with category `sku_autonomous_canary_review` exists for the workspace; `sku_live_alias_autonomy_enabled` also requires `compute_bandcamp_linkage_metrics` to clear Phase 7 thresholds (70% linkage / 60% verified / 40% option) AND `workspaces.sku_autonomous_emergency_paused=false`. Turning any flag OFF bypasses the gate (fast rollback). Tests: `tests/unit/actions/sku-autonomous-canary.test.ts` (canary missing / unresolved / resolved happy path + Phase 7 linkage trip + emergency-pause block + rollback fast-path + UI-only flag bypass). |
| SKU-AUTO-20 | Squarespace "unlimited" listings produce `fresh_remote_unbounded` and never a large integer. | Pending-Phase-2 | Fixture-based parser test. |
| SKU-AUTO-21 | When a held order contains valid warehouse-stocked lines, those lines are committed through `commitOrderItems()` in the same transaction as the hold write. | Pending-Phase-4 | Integration test with mixed order. |
| SKU-AUTO-22 | `promote_identity_match_to_alias` and the `applyOutcomeTransition` RPC wrapper both invoke `pg_advisory_xact_lock(hashtext('sku_transition:' || id))` before reading the row. | Active | Phase 0 migration for `promote_identity_match_to_alias`; Phase 1 migration `20260428000002_sku_autonomous_matching_phase1_rpc.sql` for `apply_sku_outcome_transition`. Migration-shape drift guard asserts `PERFORM pg_advisory_xact_lock` precedes `SELECT ... FOR UPDATE` in both functions. Live-DB evidence: `tests/integration/sku-outcome-transition-concurrency.test.ts` fires N=8 concurrent callers and asserts exactly one succeeds, N-1 return `stale_state_version`, identity `state_version` is bumped exactly once, and exactly one `sku_outcome_transitions` row is written. |
| SKU-AUTO-23 | Stock tiebreaks in `rankSkuCandidates()` fire only when `isStockStableFor('tiebreak', ...)` returns true. | Pending-Phase-2 | Ranker test with oscillating ATP. |
| SKU-AUTO-24 | A demoted `client_stock_exception` row does not trigger unknown-SKU discovery on subsequent webhooks; instead webhook ingress calls `promote_identity_match_to_alias` with `reason_code='stock_positive_promotion'` when remote stock recovers. | Pending-Phase-5 | Webhook-ingress test with demotion-rehydrate fixture. |
| SKU-AUTO-27 | An in-flight autonomous run can be cancelled within 30 seconds of the cancellation request. | Pending-Phase-2 | Cancellation-loop integration test using `sku_autonomous_runs.cancellation_requested_at`. |
| SKU-AUTO-28 | Setting `workspaces.sku_autonomous_emergency_paused=true` prevents any new autonomous run from starting; the order-hold evaluator's READ path continues to classify held orders. | Active for column; Pending-Phase-2 for guard plumbing | Column + DB-level tests land in Phase 0; `checkEmergencyPause()` guard lands in Phase 2. |
| SKU-AUTO-29 | Phase advancement (Phase 2, 5, 7) checks Bandcamp linkage thresholds (`30/20/10` → `50/40/25` → `70/60/40` for linkage / verified / option rates) via `compute_bandcamp_linkage_metrics`. | Active for RPC; Pending-Phase-2 for admin-action wiring | RPC lands in Phase 0 migration; the admin action that flips `sku_identity_autonomy_enabled` / `sku_live_alias_autonomy_enabled` is gated in Phase 2. |
| SKU-AUTO-30 | Non-authoritative `StockSignal` with `|clock_skew_ms| > 1h` always classifies as `cached_only` regardless of claimed freshness. | Active | `pnpm vitest run tests/unit/lib/server/stock-reliability.test.ts` covers both skew directions. |
| SKU-AUTO-31 | Bulk hold suppression triggers on ≥ 10 `fetch_incomplete_at_match` holds per `(workspace_id, connection_id)` in a 15-minute window, producing one ops alert and zero client emails for the suppressed window. | Pending-Phase-3 | Integration test with 12 synthetic holds. |
| SKU-AUTO-32 | `sku-hold-recovery-recheck` auto-releases eligible held orders with `resolutionCode='fetch_recovered_evaluator_passed'` (accepted ONLY from the recovery task, never from staff). | Pending-Phase-5 | Recovery-task test + enum guard. |
| SKU-AUTO-33 | Phase 7 rollout readiness is driven by a weekly telemetry rollup against hard thresholds — max demotion rate 2%, hold_released_rate 60-80% band, ≤20 client alerts/week, promotion_rate_monthly 10-30% band, decision audit completeness 100%, run failure rate ≤10% — AND staff sign-off via `/admin/settings/sku-matching/rollout`. The weekly `sku-autonomous-telemetry` Trigger task ALWAYS emits one `sensor_readings` row per workspace (even while emergency-paused — observability must not drop during incidents); threshold trips upsert one `warehouse_review_queue` row per reason code per ISO-week. Emergency pause suppresses review-queue writes without suppressing the sensor row. | Active | Pure summarizer in `src/lib/server/sku-autonomous-telemetry.ts` (33-case unit test); weekly Trigger task `src/trigger/tasks/sku-autonomous-telemetry.ts` (cron `0 8 * * 1`, 21-case unit test); rollout page + actions in `src/app/admin/settings/sku-matching/rollout/` + `src/actions/sku-autonomous-rollout.ts` (28-case unit test) driven by the `sku_autonomous_ui_enabled` flag; evidence-gathering + sign-off before any `flipAutonomousMatchingFlag('sku_live_alias_autonomy_enabled', true)` call, which itself remains gated by SKU-AUTO-19 + SKU-AUTO-28 + SKU-AUTO-29. |

Operator note: the `Active` subset is enforceable today. The
`Pending-Phase-*` subset is tracked here so the rollout cannot advance
past the corresponding phase without flipping its row green in this
table. The Phase 0 migration file (`20260428000001_sku_autonomous_matching_phase0.sql`)
is the single source of truth for the schema that Active gates probe.

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
