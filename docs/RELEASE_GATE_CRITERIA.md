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
2. Portal support create + reply
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
