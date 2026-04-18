# Release Gate Criteria

Purpose: define the minimum confidence bar before deploying reliability fixes or major upgrades.

This gate complements:
- `docs/PROD_MIGRATION_RLS_PARITY_CHECKLIST.md`
- `docs/INTEGRATION_REGISTRATION_MATRIX.md`
- `scripts/sql/prod_parity_checks.sql`
- `scripts/sql/webhook_health_snapshot.sql`

> **Last full automated sweep:** 2026-04-13 (Megaplan Finish-Line v4 closeout). All Section A automated checks PASS (`pnpm typecheck` / `pnpm test` 1143/1143 — 1121 pre-Phase-6 + 22 new Phase 6 tests for `setFanoutRolloutPercentInternal` and `evaluateRampHaltCriteria` / `pnpm build` / `pnpm exec biome check` 0 errors / inventory + webhook-dedup + fanout-gate + v2 batch + source-union-sync CI guards). Section B (focused reliability tests via `pnpm release:gate`) PASS. Phase 7 ramp deferred today (workspace lacks `shipstation_v2_inventory_warehouse_id` / `_location_id`; `inventory_sync_paused = true`). Rollout infrastructure (helper + sensor + audit) SHIPPED and tested end-to-end via unit suites — see `reports/finish-line/finish_line_status.json` for the per-phase outcome breakdown and `reports/finish-line/rollback_proof.md` for the verified 3-layer rollback contract.

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
