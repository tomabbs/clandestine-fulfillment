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
| SKU-3 | Review drawer stale-match protection is live. | `pnpm typecheck` passes and `pnpm test -- tests/unit/lib/server/sku-matching.test.ts` passes; operator spot-check confirms a changed candidate fingerprint blocks `createOrUpdateSkuMatch()` until the preview is refreshed. The drawer constructs a JSON-plain `createOrUpdateSkuMatch()` payload before confirm/accept, and the action returns a JSON-plain `persist_sku_match` result, so Server Action serialization rejects neither null-prototype preview objects nor reused PostgREST/RPC rows. |
| SKU-4 | Shopify operational readiness is visible before staff accept Shopify aliases. | On a Shopify connection with `default_location_id` set, `getShopifyMatchReadiness()` returns one of the explicit readiness states (`ready_at_default_location`, `missing_default_location`, `missing_remote_inventory_item_id`, `not_stocked_at_default_location`, `location_read_failed`), and the review drawer can call `activateShopifyInventoryAtDefaultLocation()` for non-ready accepted matches. The drawer also exposes visual comparison links: Shopify storefront product URL from the remote product handle and Bandcamp product URL from `bandcamp_product_mappings.bandcamp_url` when available. |
| SKU-5 | Monitoring exists before rollout widens beyond initial staff review. | `supabase migration list --linked` shows `20260425000003_sku_matching_monitoring`; SKU matching server actions emit best-effort rows into `sku_matching_perf_events`; and scheduled task `sku-matching-monitor` writes weekly `sensor_readings` plus a review-queue alert when conflict growth breaches the rollout threshold. |
| SKU-MATCHING-BC-1 | Bandcamp relation rows used by SKU matching helper paths are deterministic. | `tests/unit/actions/sku-matching.test.ts` verifies the SKU matching select includes `id`, `bandcamp_url`, `created_at`, and `updated_at`; runtime code uses `pickPrimaryBandcampMapping()` rather than relation array order. |
| SKU-MATCHING-FP-1 | Candidate fingerprint construction has a single owner. | `tests/unit/lib/server/sku-matching.test.ts` covers normalized identity inputs and disqualifier order-insensitivity; `tests/unit/actions/sku-matching.test.ts` verifies `src/actions/sku-matching.ts` does not inline `createHash()` for candidate fingerprints. |
| SKU-MATCHING-REMOTE-1 | Remote target selection is ordered and connection-scoped. | `tests/unit/lib/server/sku-matching.test.ts` covers inventory-item precedence, product+SKU disambiguation, and SKU-less multi-variant ambiguity; `tests/unit/actions/sku-matching.test.ts` verifies the action path goes through `selectConnectionScopedRemoteTarget()`. |

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
| SKU-AUTO-26 | Cross-workspace inserts into `client_store_product_identity_matches` and `client_store_sku_mappings` are rejected at the DB trigger level. | Active | Migration `20260428000001_sku_autonomous_matching_phase0.sql` attaches `enforce_identity_match_scope()` to both tables. The trigger is enforceable at the DB layer (cannot be mocked at the unit level); Phase 1+ integration coverage at `tests/integration/sku-outcome-transition-concurrency.test.ts` exercises the RPC path end-to-end against the live trigger, and the migration-shape drift guard in `tests/unit/lib/server/sku-outcome-transitions.test.ts` asserts the trigger signature does not drift. Pure insert-regression fixtures were de-scoped because the trigger runs at Supabase and is exercised by every concurrency-test insert. |
| SKU-AUTO-2 | Autonomous-matcher aliases are only written via `persist_sku_match` (directly or via `promote_identity_match_to_alias` → `persist_sku_match`). No NEW direct writer to `client_store_sku_mappings` may appear outside a pinned whitelist. | Active | CI guard `bash scripts/ci-checks/sku-aliases-single-writer.sh` enforces the whitelist (currently the single legacy operator-triggered seed path `src/actions/store-connections.ts::autoDiscoverSkus`, which pre-existed the autonomous matcher). Any new direct `.from("client_store_sku_mappings").insert/upsert/update/delete` outside the whitelist fails CI. Autonomous outputs route through `persist_sku_match` via `supabase.rpc(...)` (not `.from()`), so they never match the grep anchor. Wrapper coverage in `tests/unit/lib/server/sku-alias-promotion.test.ts`. Guard wired into `scripts/release-gate.sh` and `.github/workflows/ci.yml` audit-gate. |
| SKU-AUTO-3 | Webhook-ingest and poll-ingest both call the shared `runHoldIngressSafely` helper (payload includes `source: "webhook"` or `source: "poll"`) immediately after `warehouse_order_items` insert. The helper reads `workspaces.flags.non_warehouse_order_hold_enabled` + `workspaces.sku_autonomous_emergency_paused`, then (when holds are active and not paused) chains `loadNormalizedOrder(supabase, orderId, { source })` → `evaluateOrderForHold` → `applyOrderFulfillmentHold` when the evaluator says hold. Same helper + same `(workspaceId, orderId)` tuple ⇒ identical hold decision for identical DB state (parity by construction). | Active | Implementation: `src/lib/server/order-hold-ingress.ts` (`runHoldIngressSafely`, `evaluateAndApplyOrderHold`, `readIngressGuardsInline`); callers `src/trigger/tasks/process-client-store-webhook.ts` (`handleOrderCreated`, `source: "webhook"`) and `src/trigger/tasks/client-store-order-detect.ts` (`source: "poll"`). Loader: `src/lib/server/normalized-order-loader.ts` accepts `source: "webhook" \| "poll" \| "recovery"`. Evidence: `tests/unit/lib/server/order-hold-ingress.test.ts` (exhaustive branches + webhook vs poll parity case) + `tests/unit/trigger/process-client-store-webhook.test.ts` Phase 8 describe block (ingress call shape, `legacy`/`no_hold`/`hold_applied` dispatch). |
| SKU-AUTO-4 | Fetch-incomplete connections are excluded from client correction reports and from live-alias promotion. | Active | Client correction report `src/actions/portal-stock-exceptions.ts::listClientStockExceptions()` hardcodes `outcome_state='client_stock_exception' AND is_active=true` — `fetch_incomplete_holdout` rows cannot be returned. Live-alias promotion via `promote_identity_match_to_alias` is gated by `from_state ∈ {auto_database_identity_match, auto_shadow_identity_match}` at the PL/pgSQL level (Phase 0 migration `20260428000001_sku_autonomous_matching_phase0.sql`) — `fetch_incomplete_holdout` cannot enter the promotion path via the legal-transition table in `src/lib/server/sku-outcome-transitions.ts::LEGAL_TRANSITIONS`. State-machine coverage in `tests/unit/lib/server/sku-outcome-transitions.test.ts` (migration-shape drift guard asserts the `from_state` filter doesn't regress). |
| SKU-AUTO-5 | Admin + portal read surfaces for stock-exception, hold-queue, identity-match, and autonomous-run use stable query keys with Server Action-driven invalidation. | Active | All four surfaces (`/admin/settings/sku-matching/identity-matches`, `/admin/settings/sku-matching/autonomous-runs`, `/admin/orders/holds`, `/portal/stock-exceptions`, `/admin/settings/sku-matching/rollout`) use inline `['admin', …]` / `['portal', …]` query keys through `useAppQuery` — consistent with every other admin page in this codebase (`src/lib/shared/query-keys.ts` is reserved for keys shared across >1 surface; single-surface keys live inline per established pattern). Mutating Server Actions (`order-holds.ts::releaseOrderHold`, `sku-autonomous-canary.ts::flipAutonomousMatchingFlag`, `sku-autonomous-rollout.ts::createAutonomousCanaryReview` / `resolveAutonomousCanaryReview`) call `revalidatePath()` on the surface they mutate, and the companion tests (`tests/unit/actions/order-holds.test.ts`, `sku-autonomous-canary.test.ts`, `sku-autonomous-rollout.test.ts`, `sku-autonomous-runs.test.ts`, `sku-identity-matches.test.ts`, `portal-stock-exceptions.test.ts`) assert the invalidation contract post-mutation. |
| SKU-AUTO-7 | Stock-based tiebreaks never fire when warehouse tier ≠ `authoritative` or remote tier ∈ `{ cached_only, unknown }`; `fresh_remote_unbounded` never participates in numeric tiebreaks. | Active | Tier gating is implemented in `src/lib/server/stock-reliability.ts::classifyStockTier()` + `isStockStableFor('tiebreak', …)`. Ranker evidence wiring in `src/lib/server/sku-candidate-evidence.ts` and the ranker additive signature change in `src/lib/server/sku-matching.ts::rankSkuCandidates()`. Covered by `tests/unit/lib/server/stock-reliability.test.ts` (unbounded classification + clock-skew + stability) + `tests/unit/lib/server/sku-candidate-evidence.test.ts` (gate signals + tier propagation into evidence). |
| SKU-AUTO-8 | Promotion from `auto_database_identity_match` to `auto_live_inventory_alias` only occurs via documented paths A/B/C, and every promotion writes a `sku_outcome_transitions` row + a `sku_autonomous_decisions` row. | Active | Single TS entry point `src/lib/server/sku-alias-promotion.ts::promoteIdentityMatchToAlias()` handles every path (`isPathReasonPairValid()` guards the path × reason_code matrix). Success + block paths both write a `sku_autonomous_decisions` row; the underlying `promote_identity_match_to_alias` RPC writes the `sku_outcome_transitions` row in the same transaction as the alias insert (Phase 0 migration `20260428000001_sku_autonomous_matching_phase0.sql`). Covered by `tests/unit/lib/server/sku-alias-promotion.test.ts` (50+ cases across Path A/B/C happy paths, invalid path/reason matrix, workspace-read failures, emergency pause, autonomy-flag gating, stock-stability gate, RPC error mapping, decision-row shape tolerance). |
| SKU-AUTO-9 | Holdout backlog cannot exceed the stop-condition thresholds (10 evaluations / 90 days); a periodic job enforces the give-up transition. | Active | Phase 5.D task `src/trigger/tasks/sku-holdout-stop-condition-sweep.ts` runs daily (`schedules.task`, `0 7 * * *`), finds `client_store_product_identity_matches` rows stuck in `auto_holdout_for_evidence` where `evaluation_count >= 10` OR `age_days >= 90`, and retires them via `applyOutcomeTransition()` with reason codes `holdout_expired_10_evaluations` / `holdout_expired_90_days`. Emergency-pause fail-closed (`workspaces.sku_autonomous_emergency_paused`) skips the workspace. Idempotency guaranteed by `state_version` OCC + advisory lock inside the RPC. Covered by `tests/unit/trigger/sku-holdout-stop-condition-sweep.test.ts` (524 lines: cap-based retirement, age-based retirement, dual-trip precedence, emergency-pause block, OCC / advisory-lock race, decision-row + run-row bookkeeping). |
| SKU-AUTO-10 | `warehouse_orders.fulfillment_hold` is treated as a distinct state by every downstream consumer (ShipStation export, fulfillment UI, commitments). No consumer coerces `on_hold` into ShipStation's `on_hold` or into `cancelled`. | Active | Structurally enforced: `warehouse_orders.fulfillment_hold` (enum `no_hold` / `on_hold` / `released` / `cancelled`) lives on `warehouse_orders`; `shipstation_orders.order_status` (ShipStation's own `on_hold`) is a separate column on a separate table. The ShipStation export task `src/trigger/tasks/shipstation-export.ts` is product-SKU-level (not order-level) and has no `fulfillment_hold` reference. The order-push path (`mark-platform-fulfilled`, `inventory-commitments.ts`) never reads or writes `fulfillment_hold` — commitments are indexed on `(workspace_id, source, source_id)` independent of the hold column. The only writers of `warehouse_orders.fulfillment_hold` are the two RPCs `apply_order_fulfillment_hold` / `release_order_fulfillment_hold` (wrapped exclusively by `src/lib/server/order-hold-rpcs.ts`). The staff UI at `/admin/orders/holds` reads `fulfillment_hold` directly; the legacy orders cockpit (`/admin/orders-legacy`) filters on `shipstation_orders.order_status` and never conflates the two. Covered by `tests/unit/lib/server/order-hold-rpcs.test.ts` (528 cases asserting the RPC round-trip) + `tests/unit/actions/order-holds.test.ts` (449 cases asserting the admin read model ONLY surfaces `fulfillment_hold='on_hold'` rows and rejects releases of non-`on_hold` rows). |
| SKU-AUTO-11 | State-machine enforcement is split across `sku-outcome-transitions.ts`, `sku-alias-promotion.ts`, and `order-hold-policy.ts`. No module writes to another module's table. | Active | Structurally verified: `src/lib/server/sku-outcome-transitions.ts` writes ONLY via `supabase.rpc('apply_sku_outcome_transition', …)` (the RPC owns `client_store_product_identity_matches.outcome_state` + `sku_outcome_transitions`) — no direct `.from(...)` writes. `src/lib/server/sku-alias-promotion.ts` writes ONLY via `supabase.rpc('promote_identity_match_to_alias', …)` (owns alias-table inserts) + a bookkeeping insert into `sku_autonomous_decisions` (its own audit table). `src/lib/server/order-hold-policy.ts` is pure policy code with ZERO DB access; writes route through `src/lib/server/order-hold-rpcs.ts` → `apply_order_fulfillment_hold` / `release_order_fulfillment_hold` RPCs which own `warehouse_orders.fulfillment_hold` + `order_fulfillment_hold_events`. Cross-table writes are impossible because each module's single mutation path is an RPC owned by a different PL/pgSQL function. The CI guard `scripts/ci-checks/sku-aliases-single-writer.sh` (SKU-AUTO-2) enforces no drift on `client_store_sku_mappings` direct writes; the shape-drift guard in `tests/unit/lib/server/sku-outcome-transitions.test.ts` asserts the three RPC signatures don't drift. |
| SKU-AUTO-15 | `order_fulfillment_hold_events` is written in the same transaction as every `fulfillment_hold` state change. One `hold_applied` event per cycle, one `hold_released` per release, one `hold_alert_sent` per dispatch. | Active | Atomicity enforced in PL/pgSQL. Migration `supabase/migrations/20260428000003_order_fulfillment_hold_rpcs.sql` defines `apply_order_fulfillment_hold()` + `release_order_fulfillment_hold()` — each writes the `fulfillment_hold` column AND inserts the matching `order_fulfillment_hold_events` row in a single function body, guaranteed by the Postgres transaction boundary. `hold_alert_sent` events are written in `src/trigger/tasks/send-non-warehouse-order-hold-alert.ts` via an `INSERT … ON CONFLICT DO NOTHING` on the `(workspace_id, order_id, hold_cycle_id, event_type)` unique index from migration `20260428000004_hold_alert_idempotency_index.sql`. Covered by `tests/unit/lib/server/order-hold-rpcs.test.ts` (528 cases: apply + release happy paths, already-held, duplicate-cycle, actor validation, reason + resolution enum enforcement, event payload shape) + `tests/integration/order-hold-rpcs.test.ts` (live-DB evidence that the event row and the `fulfillment_hold` column transition in the same txn) + `tests/unit/trigger/send-non-warehouse-order-hold-alert.test.ts` (677 cases covering one-event-per-dispatch). |
| SKU-AUTO-16 | The client alert task `send-non-warehouse-order-hold-alert` is idempotent on `(workspace_id, order_id, hold_cycle_id)`. | Active | Enforced at two levels: (a) migration `supabase/migrations/20260428000004_hold_alert_idempotency_index.sql` adds a UNIQUE partial index on `order_fulfillment_hold_events (workspace_id, order_id, hold_cycle_id)` WHERE `event_type = 'hold_alert_sent'`; (b) the task `src/trigger/tasks/send-non-warehouse-order-hold-alert.ts` writes the event row via `INSERT … ON CONFLICT DO NOTHING` before attempting to send email, so a re-delivery skips silently. The task also early-exits if `fulfillment_hold_client_alerted_at` is already stamped or if `fulfillment_hold_cycle_id` doesn't match the payload (ensuring a NEW cycle is required for re-alerting). Covered by `tests/unit/trigger/send-non-warehouse-order-hold-alert.test.ts` (677 lines: double-dispatch for same cycle short-circuits, new cycle re-alerts, emergency-pause skip, suppression-window skip, Resend failure classification). |
| SKU-AUTO-17 | `releaseOrderHold(orderId, { resolutionCode })` rejects any `resolutionCode` outside the staff-facing enum; `staff_override` without a note is rejected. | Active | The staff-facing Zod enum in `src/actions/order-holds.ts` is `{ staff_override, alias_learned, manual_sku_fix, order_cancelled }` — deliberately narrower than the full RPC-level `ReleaseResolutionCode` in `src/lib/server/order-hold-rpcs.ts` (which additionally allows `fetch_recovered_evaluator_passed` for the `sku-hold-recovery-recheck` task path, per SKU-AUTO-32). `staff_override` without a non-empty trimmed `note` is rejected by a `.superRefine()` on the schema. The RPC `release_order_fulfillment_hold` (migration `20260428000003_order_fulfillment_hold_rpcs.sql`) applies a second enum check at the PL/pgSQL layer. Covered by `tests/unit/actions/order-holds.test.ts` (staff-enum rejection, `staff_override` note requirement, non-on_hold state rejection, staff-only auth, bulk partial-success handling, and SKU-AUTO-32 `fetch_recovered_evaluator_passed` rejection for BOTH single + bulk paths) + `tests/unit/lib/server/order-hold-rpcs.test.ts` (528 lines: RPC-level enum enforcement). |
| SKU-AUTO-18 | Dry-run mode (Phase 1) writes `sku_autonomous_runs` + `sku_autonomous_decisions` but writes nothing to identity tables, alias tables, `warehouse_orders.fulfillment_hold`, or the alert task queue. | Active | Implemented by `src/trigger/tasks/sku-autonomous-dry-run.ts` and runner `src/lib/server/sku-autonomous-dry-run.ts`. The task scans active Shopify / WooCommerce / Squarespace `client_store_connections`, fetches each live remote catalog through `fetchRemoteCatalogWithTimeout()`, ranks canonical variants via `rankSkuCandidates()`, opens one `sku_autonomous_runs` row per connection with `dry_run=true`, and writes one `sku_autonomous_decisions` row per evaluated variant. It never imports or calls `promoteIdentityMatchToAlias`, `applyOutcomeTransition`, order-hold RPC wrappers, alert tasks, or `client_store_sku_mappings` / `client_store_product_identity_matches` write paths; the only writes are run/decision audit inserts and final run summary updates. Emergency pause skips new dry-run writes per SKU-AUTO-28. Covered by `tests/unit/lib/server/sku-autonomous-dry-run.test.ts` (existing aliases remain audit-only, deterministic/strong candidates become dry-run identity-match decisions, weak/possible candidates hold out, conflicts reject, fetch failures produce `fetch_incomplete_holdout`, and bounded top-candidate evidence is persisted). |
| SKU-AUTO-19 | Before enabling `sku_identity_autonomy_enabled` (Phase 2) or `sku_live_alias_autonomy_enabled` (Phase 7) on a connection, a signed-off `warehouse_review_queue` row of category `sku_autonomous_canary_review` must exist. | Active | Enforced in `src/actions/sku-autonomous-canary.ts::flipAutonomousMatchingFlag()` — canary-gated flags refuse to flip ON until a RESOLVED `warehouse_review_queue` row with category `sku_autonomous_canary_review` exists for the workspace; `sku_live_alias_autonomy_enabled` also requires `compute_bandcamp_linkage_metrics` to clear Phase 7 thresholds (70% linkage / 60% verified / 40% option) AND `workspaces.sku_autonomous_emergency_paused=false`. Turning any flag OFF bypasses the gate (fast rollback). Tests: `tests/unit/actions/sku-autonomous-canary.test.ts` (canary missing / unresolved / resolved happy path + Phase 7 linkage trip + emergency-pause block + rollback fast-path + UI-only flag bypass). |
| SKU-AUTO-20 | Squarespace "unlimited" listings produce `fresh_remote_unbounded` and never a large integer. | Pending-Phase-2 | Primitives exist: `src/lib/clients/squarespace-client.ts` parses `variant.stock.unlimited` off the API payload (Zod schema at L70 + L103), and `src/lib/server/stock-reliability.ts::classifyStockTier()` returns `fresh_remote_unbounded` when `StockSignal.isUnbounded === true`. The missing piece is the ADAPTER that converts a parsed Squarespace variant into a `StockSignal` — there is no current call site that wires `variant.stock.unlimited → isUnbounded=true` on the inbound stock signal. Flip to Active once the adapter lands (likely in `src/lib/server/normalized-order.ts` or a new `squarespace-stock-signal.ts` adapter) with a fixture test that feeds an `unlimited=true` variant through the pipeline and asserts the resulting signal's tier is `fresh_remote_unbounded`. |
| SKU-AUTO-21 | When a held order contains valid warehouse-stocked lines, those lines are committed via `apply_order_fulfillment_hold` RPC parameter `p_commit_lines` (open `inventory_commitments` rows) in the **same** PL/pgSQL transaction as the `hold_applied` event + `warehouse_orders.fulfillment_hold` stamp — not via a separate `commitOrderItems()` call in that transaction. | Active | Ingress: `evaluateAndApplyOrderHold` builds `commitLines` from evaluator classifications and calls `applyOrderFulfillmentHold` inside `runHoldIngressSafely` (`src/lib/server/order-hold-ingress.ts`). Webhook path skips legacy `commitOrderItems()` when the verdict is `hold_applied` (RPC already reserved committable lines; double `commitOrderItems` would attempt to commit held lines). Poll path does not run the inventory decrement loop (webhook remains canonical for stock movement); it still runs hold evaluation + client-alert enqueue so hold state matches. RPC-level evidence: `tests/integration/order-hold-rpcs.test.ts` (same-txn commit visibility). Ingress evidence: `tests/unit/trigger/process-client-store-webhook.test.ts` (`hold_applied` ⇒ `commitOrderItems` not called; only `committableRemoteSkus` decrement). |
| SKU-AUTO-22 | `promote_identity_match_to_alias` and the `applyOutcomeTransition` RPC wrapper both invoke `pg_advisory_xact_lock(hashtext('sku_transition:' || id))` before reading the row. | Active | Phase 0 migration for `promote_identity_match_to_alias`; Phase 1 migration `20260428000002_sku_autonomous_matching_phase1_rpc.sql` for `apply_sku_outcome_transition`. Migration-shape drift guard asserts `PERFORM pg_advisory_xact_lock` precedes `SELECT ... FOR UPDATE` in both functions. Live-DB evidence: `tests/integration/sku-outcome-transition-concurrency.test.ts` fires N=8 concurrent callers and asserts exactly one succeeds, N-1 return `stale_state_version`, identity `state_version` is bumped exactly once, and exactly one `sku_outcome_transitions` row is written. |
| SKU-AUTO-23 | Stock tiebreaks in `rankSkuCandidates()` fire only when `isStockStableFor('tiebreak', ...)` returns true. | Active | Enforced structurally: `rankSkuCandidates()` (`src/lib/server/sku-matching.ts`) delegates every stock-derived signal to `buildCandidateEvidence()` → `classifyEvidenceGates()` (`src/lib/server/sku-candidate-evidence.ts`), which classifies each stock signal via `classifyStockTier()` before it can participate in gates. Unbounded signals (`fresh_remote_unbounded`) and `cached_only` / `unknown` tiers never contribute numeric disqualifiers — they are filtered at tier-classification time. The `tiebreak` stability window (4h, `STABILITY_WINDOWS_MS.tiebreak`) is defined in `src/lib/server/stock-reliability.ts` for use by future numeric tiebreakers; today the ranker does NOT use numeric warehouse/remote stock deltas as tiebreakers, so the invariant holds vacuously for the score-path AND positively for the evidence-gate path. Covered by `tests/unit/lib/server/stock-reliability.test.ts` (oscillating-ATP stability, unbounded rejection, clock-skew downgrade, window-coverage) + `tests/unit/lib/server/sku-candidate-evidence.test.ts` (unbounded + cached_only propagation into evidence, tier-aware gate decisions). |
| SKU-AUTO-24 | A demoted `client_stock_exception` row does not trigger unknown-SKU discovery on subsequent webhooks; instead webhook ingress calls `promote_identity_match_to_alias` with `reason_code='stock_positive_promotion'` when remote stock recovers. | Active | Rehydrate path lives in `src/lib/server/webhook-rehydrate.ts::rehydrateClientStockExceptionOnWebhook()`. When a webhook delivers positive remote stock on a `client_stock_exception` identity row, the rehydrate function short-circuits BEFORE unknown-SKU discovery runs: (a) looks up the identity row by `(connection_id, remote_identity)`, (b) applies the pure policy in `src/lib/server/webhook-rehydrate-policy.ts::shouldRehydrate()` (tier-aware — `fresh_remote_unbounded` / `cached_only` / stale signals are all rejected), (c) on pass, calls `promoteIdentityMatchToAlias()` with `reason_code='stock_positive_promotion'` via Path A (decision path `inline_ingest`), (d) skips fallback discovery. Covered by `tests/unit/lib/server/webhook-rehydrate.test.ts` (900 lines: happy path, emergency-pause skip, stability-fail skip, advisory-lock race, non-matching identity fallback, stock-unbounded rejection, clock-skew rejection, decision-row audit) + `tests/unit/lib/server/webhook-rehydrate-policy.test.ts` (430 lines: all tier × freshness × stability cross-product cases). |
| SKU-AUTO-27 | An in-flight autonomous run can be cancelled within 30 seconds of the cancellation request. | Pending-Phase-2 | Columns exist: `sku_autonomous_runs.cancellation_requested_at`, `cancellation_requested_by`, `cancellation_reason` (Phase 0 migration `20260428000001_sku_autonomous_matching_phase0.sql`). The staff read surface `src/actions/sku-autonomous-runs.ts::getAutonomousRunDetail` selects all three so the UI can display cancellation metadata. What is missing: (a) the `requestAutonomousRunCancellation(runId, reason)` Server Action that writes those columns, (b) the per-iteration check inside each of the long-running tasks (`sku-shadow-promotion`, `sku-holdout-stop-condition-sweep`, future `sku-autonomous-dry-run`) that polls its own run row every N iterations and bails when `cancellation_requested_at IS NOT NULL`, and (c) a UI affordance on `/admin/settings/sku-matching/autonomous-runs/[id]` with optimistic state. Flip to Active once all three land with a test fixture asserting ≤30s latency between the Server Action call and task termination. |
| SKU-AUTO-28 | Setting `workspaces.sku_autonomous_emergency_paused=true` prevents any new autonomous WRITER from running; the order-hold evaluator's READ path continues to classify held orders. | Active | Guard plumbing is live at every writer entry point: `src/lib/server/workspace-flags.ts::readWorkspaceEmergencyPause()` is the single source of truth (fail-closed on read error) and is invoked by `sku-alias-promotion.ts::promoteIdentityMatchToAlias()`, `sku-autonomous-canary.ts::flipAutonomousMatchingFlag()`, `sku-shadow-promotion.ts`, `sku-holdout-stop-condition-sweep.ts`, `sku-hold-recovery-recheck.ts`, `send-non-warehouse-order-hold-alert.ts`, `sku-autonomous-telemetry.ts`, `webhook-rehydrate.ts`, and `stock-stability-sampler.ts`. Reads remain uncoupled: `order-hold-evaluator.ts` has no pause check (classification is read-only). The telemetry task deliberately emits sensor rows while paused (observability must not drop during incidents) but suppresses review-queue writes — see SKU-AUTO-33. Covered by unit tests on every writer listed above and by `tests/unit/actions/sku-autonomous-canary.test.ts` (emergency-pause blocks Phase 7 flag-on, fast-rollback OFF bypasses the gate). |
| SKU-AUTO-29 | Phase advancement (Phase 2, 5, 7) checks Bandcamp linkage thresholds (`30/20/10` → `50/40/25` → `70/60/40` for linkage / verified / option rates) via `compute_bandcamp_linkage_metrics`. | Active | Admin-action wiring is live. `src/actions/sku-autonomous-canary.ts::flipAutonomousMatchingFlag()` gates every canary-controlled flag flip on `compute_bandcamp_linkage_metrics` — `sku_identity_autonomy_enabled` uses Phase 2 thresholds (`LINKAGE_THRESHOLDS.phase2 = { linkage: 30, verified: 20, option: 10 }`), `sku_live_alias_autonomy_enabled` uses Phase 7 thresholds (`LINKAGE_THRESHOLDS.phase7 = { linkage: 70, verified: 60, option: 40 }`). Threshold-trip responses include the failing metrics so the operator can see exactly which ratio fell short. Rolling back (flag OFF) bypasses the threshold check (fast rollback never blocks). The Phase 5 promotion task `sku-shadow-promotion.ts` reads its thresholds from the same `LINKAGE_THRESHOLDS` constant for consistency. Covered by `tests/unit/actions/sku-autonomous-canary.test.ts` (Phase 2 / Phase 7 threshold blocks, rollback bypass, emergency-pause precedence, canary-review requirement). |
| SKU-AUTO-30 | Non-authoritative `StockSignal` with `|clock_skew_ms| > 1h` always classifies as `cached_only` regardless of claimed freshness. | Active | `pnpm vitest run tests/unit/lib/server/stock-reliability.test.ts` covers both skew directions. |
| SKU-AUTO-31 | Bulk hold suppression triggers on ≥ 10 `fetch_incomplete_at_match` holds per `(workspace_id, connection_id)` in a 15-minute window, producing one ops alert and zero client emails for the suppressed window. | Active | `src/lib/server/order-hold-bulk-suppression.ts::evaluateBulkSuppression()` counts `order_fulfillment_hold_events` rows with `reason='fetch_incomplete_at_match'` in the rolling 15-minute window (index `idx_order_fulfillment_hold_events_bulk_window`). When the count crosses the threshold (10), the suppression window activates: `hold_applied` events still write (audit trail preserved), but `send-non-warehouse-order-hold-alert` checks suppression before Resend dispatch and short-circuits (one ops alert per window via `ops-alert.ts`, zero client emails). Covered by `tests/unit/lib/server/order-hold-bulk-suppression.test.ts` (239 lines: exact-threshold trip, sub-threshold pass, window-boundary, per-connection isolation, metadata attachment) + `tests/unit/trigger/send-non-warehouse-order-hold-alert.test.ts` assertions that suppression suppresses client email while preserving audit rows. |
| SKU-AUTO-32 | `sku-hold-recovery-recheck` auto-releases eligible held orders with `resolutionCode='fetch_recovered_evaluator_passed'` (accepted ONLY from the recovery task, never from staff). | Active | `src/trigger/tasks/sku-hold-recovery-recheck.ts` (`schedules.task`, `*/30 * * * *`) finds `warehouse_orders` with `fulfillment_hold='on_hold'` AND `fulfillment_hold_reason='fetch_incomplete_at_match'` AND `fulfillment_hold_at >= now() - 24h`, probes platform health via `fetchRemoteCatalogWithTimeout()`, re-runs `loadNormalizedOrder()` + `evaluateOrderForHold()` against current identity state, and on BOTH-pass calls `releaseOrderFulfillmentHold()` directly (bypassing the Server Action) with `resolutionCode='fetch_recovered_evaluator_passed'` + `actorKind='recovery_task'`. The staff-facing Server Action path in `src/actions/order-holds.ts::releaseOrderHold` + `releaseOrderHoldsBulk` excludes `fetch_recovered_evaluator_passed` from its Zod enum (see code comment citing this gate) — staff attempts to pass that code throw at the Zod boundary BEFORE any RPC round-trip. The UI dropdown in `src/app/admin/orders/holds/holds-client.tsx` likewise excludes the recovery code from its `RESOLUTION_LABELS`. Emergency-pause fail-closed on the recovery task. Covered by `tests/unit/trigger/sku-hold-recovery-recheck.test.ts` (544 lines: recovery happy path, still-stuck skip, emergency-pause skip, non-matching reason skip, resolution-code assertion, batch-limit pagination) + `tests/unit/actions/order-holds.test.ts` — `rejects fetch_recovered_evaluator_passed from staff path` (single + bulk) asserts the staff enum strip actually fires and `mockRpc` is never called. |
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
   - Inbound Bandcamp fan-message support tickets must show resolved client context plus related order and shipment/customer tracking links when the body includes a Bandcamp transaction id.
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
