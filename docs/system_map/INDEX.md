# System Map Index

Use this index as the first-stop map before planning/building/auditing.

## Required Read Order

1. `TRUTH_LAYER.md`
2. `project_state/engineering_map.yaml`
3. `project_state/journeys.yaml`
4. `docs/system_map/API_CATALOG.md`
5. `docs/system_map/TRIGGER_TASK_CATALOG.md`
6. `docs/system_map/CACHE_ARCHITECTURE.md`
7. `docs/RELEASE_GATE_CRITERIA.md`
8. `docs/RUNBOOK.md`

## Full Indexed Code Review View

### Request Boundaries

- API routes: `src/app/api/**/route.ts`
- Server actions: `src/actions/**/*.ts`
- Canonical list: `docs/system_map/API_CATALOG.md`

### Async/Background Runtime

- Trigger tasks: `src/trigger/tasks/**/*.ts`
- Trigger queues: `src/trigger/lib/*.ts`
- Runtime config: `trigger.config.ts`
- Canonical list: `docs/system_map/TRIGGER_TASK_CATALOG.md`

### App Surfaces

- Staff portal: `src/app/admin/**`, `src/components/admin/**`
- Client portal: `src/app/portal/**`, `src/components/portal/**`
- Phase 6 + 7 SKU-AUTO admin surfaces (all gated by `sku_autonomous_ui_enabled`):
  - `/admin/settings/sku-matching/autonomous-runs` — read model over `sku_autonomous_runs` + `sku_autonomous_decisions` (Slice 6.B).
  - `/admin/settings/sku-matching/identity-matches` — read model over `client_store_product_identity_matches` + `sku_outcome_transitions` (Slice 6.E).
  - `/admin/settings/sku-matching/rollout` — rollout dashboard: flag state, emergency pause, weekly telemetry rollup from `sensor_readings` (`sensor_name='sku_autonomous.telemetry'`), Bandcamp linkage, and canary review lifecycle (Slice 7.D).
  - `/admin/orders/holds` — staff resolution surface for `warehouse_orders.fulfillment_hold='on_hold'` (Slice 6.D).
- Phase 6 SKU-AUTO portal surface: `/portal/stock-exceptions` — client view of `client_stock_exception` identity rows, gated by `client_stock_exception_reports_enabled` (Slice 6.F).

### Data + Access

- Auth context: `src/lib/server/auth-context.ts`
- Query wrappers: `src/lib/hooks/use-app-query.ts`
- Query tiers/keys: `src/lib/shared/query-tiers.ts`, `src/lib/shared/query-keys.ts`
- Cache/freshness policy: `docs/system_map/CACHE_ARCHITECTURE.md`

### Persistence and Policies

- Migrations: `supabase/migrations/**`
- SQL checks: `scripts/sql/prod_parity_checks.sql`, `scripts/sql/webhook_health_snapshot.sql`

### Quality Gates

- Release gate script: `scripts/release-gate.sh`
- Direct-Shopify cutover gate script (Section C.1): `scripts/check-release-gates.sh` — wired to the `release-gate-check` GitHub Actions job on `main`.
- Webhook runtime guard (HRD-23): `scripts/check-webhook-runtime.sh` — every `src/app/api/webhooks/**/route.ts` must export `runtime='nodejs'` + `dynamic='force-dynamic'`.
- Fulfilled-quantity write-only guard (HRD-08.1): `scripts/check-fulfilled-quantity-writers.sh` — `warehouse_order_items.fulfilled_quantity` is write-only from webhook handlers.
- Autonomous SKU identity fanout-isolation guard (SKU-AUTO-fanout-isolation): `scripts/ci-checks/sku-identity-no-fanout.sh` — `client_store_product_identity_matches` rows must never be read in `inventory-fanout.ts`, `client-store-fanout-gate.ts`, `multi-store-inventory-push`, or `process-client-store-webhook`. Wired into `release-gate.sh` and `cloud-agent-verify.sh`.
- Full-site audit: `tests/e2e/full-site-audit.spec.ts`
- Reports: `reports/playwright-audit/`

## Session Rule

Before finalizing any PLAN/BUILD/AUDIT output, reference:

- at least one file from request boundaries,
- at least one relevant Trigger task (if feature is async/integration-related),
- and one verification source from release/audit docs.
