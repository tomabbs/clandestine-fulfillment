# Stress test harness

Phase 5 (finish-line plan v4, 2026-04-13) shipped six stress scripts under
`scripts/stress/` plus a shared library at `scripts/stress/lib/stress-run.ts`.
They share a single CLI surface and a single artifact convention so every
production write made by the harness is greppable end-to-end and the
`ramp-halt-criteria-sensor` can filter them out via
`excludeStressArtifacts()`.

## Universal conventions

Every stress run:

- Mints a `stress_run_id = '${script}-${utc-iso8601}'` once at startup.
- Uses synthetic SKU prefix `STRESS-${stress_run_id}-`.
- Uses synthetic ShipStation location prefix `TEST-${stress_run_id}-`.
- Uses correlation_id prefix `${stress_run_id}-` on every write.
- Tags `external_sync_events.metadata` and `warehouse_review_queue.metadata`
  rows with `{ "stress_run_id": "..." }`.
- Writes a JSON report to `reports/stress/${stress_run_id}.json` with
  assertions, metrics, and a side-effects-summary SQL query for post-run
  forensics.

Operator scripts:

- `pnpm stress:dry-run <workspace-uuid>` — runs all six scripts in
  `--dry-run` mode (no writes, validates payload shapes only).
- `pnpm stress:all <workspace-uuid> --apply` — actually writes (gated; the
  reconcile-chaos script additionally requires `STRESS_HARNESS=1` env var
  AND `--force-debug-bypass` flag).

## The six scripts

| Script | What it asserts | Pre-conditions |
| --- | --- | --- |
| `manual-count-burst.ts` | 200-row batch via `submitManualInventoryCounts`; <30s elapsed; 200 ledger rows; 200 v2 enqueues; 0 review rows. | `inventory_sync_paused=false`, `shipstation_v2_inventory_warehouse_id` populated. Without these, emits a structured-skip report. |
| `webhook-flood.ts` | 50 replays of one canned SHIP_NOTIFY with the SAME `external_webhook_id` produce 1 inserted + 49 dedup hits via `webhook_events` (`INSERT … ON CONFLICT DO NOTHING`, Rule #62). | None. |
| `concurrent-count-session.ts` | 5 simultaneous count sessions; no fanout fires during in-progress windows; explicit Scenario A (mid-session synthetic shipstation decrement) verifies v4-corrected `delta = current - sumOfLocations` produces no double-decrement. | Same as `manual-count-burst`. |
| `fanout-storm.ts` | 100 concurrent `recordInventoryChange` calls across 10 SKUs (30% intentional duplicates); Redis SETNX guards held; ledger UNIQUE caught all dups; ShipStation queue concurrency:1 honored. | 10 STRESS-* variants must be pre-seeded for the live-write path. |
| `reconcile-chaos.ts` | Inject 3-unit Redis-vs-Postgres drift on 5 STRESS- SKUs via gated debug bypass; trigger `shipstation-bandcamp-reconcile-hot`; assert all 5 auto-fixed via `source='reconcile'` adjustments + correct review-queue severity. | `STRESS_HARNESS=1` env var AND `--force-debug-bypass` flag (defense-in-depth — Redis bypass cannot be invoked accidentally). |
| `bulk-create-locations-burst.ts` | Calls `createLocationRange(..., toIndex:50)` to exercise the Trigger-task path (>30 entries, v5 `bulk-create-locations` task). Asserts `mode: 'trigger'` synchronous return + 50 rows persisted with v2 IDs. | `shipstation_v2_inventory_warehouse_id` populated. First stress coverage of the bulk-create-locations task since v5 ship. |

## CLI flags (every script)

| Flag | Meaning |
| --- | --- |
| `--workspace=<uuid>` | Required. Target workspace. |
| `--dry-run` | Validates payload shape and writes a report; performs zero side effects. |
| `--apply` | Required for live execution. Mutually exclusive with `--dry-run`. |
| `--report=<path>` | Override default `reports/stress/${stress_run_id}.json` location. |
| `--force-debug-bypass` | `reconcile-chaos.ts` only. Required alongside `STRESS_HARNESS=1`. |

## Cleanup after a stress run

Stress runs intentionally leave artifacts in the database for forensic
review. To clean up:

1. Inspect the side-effects summary SQL emitted in the report:
   `psql "$DATABASE_URL" -f - <<<"$(jq -r '.sideEffectsSummarySql' reports/stress/<id>.json)"`
2. Synthetic SKUs: `delete from warehouse_inventory_levels where sku like 'STRESS-${stress_run_id}-%';`
   (cascades through variant tables via FK).
3. Synthetic ShipStation locations: run
   `pnpm tsx scripts/cleanup-stale-ss-locations.ts --apply` (Phase 8b script;
   sweeps any `TEST-${stress_run_id}-*` locations that v2 will accept a
   DELETE for; locations that ever held inventory are marked permanent and
   added to a low-severity review row per Phase 1 probe outcome 4).
4. Synthetic review-queue rows:
   `update warehouse_review_queue set status='resolved' where group_key like 'stress:${stress_run_id}:%';`
5. Synthetic ledger rows ride the standard `external-sync-events-retention`
   weekly cron — no explicit cleanup needed.

## Why structured-skip reports?

On 2026-04-13 the target workspace `1e59b9ca-…` had
`inventory_sync_paused=true` AND missing v2 IDs (per the Phase 0 baseline
artifact). The scripts that depend on these pre-conditions emit a
structured-skip report identical in shape to a passing live run, with a
clear `notes[]` entry naming the missing pre-condition. This makes the
runbook stable across "today's environment" vs "tomorrow's environment"
and lets Phase 7's go/no-go gate compare like-for-like artifacts.

## Sensor coordination

The `ramp-halt-criteria-sensor` (Phase 6) calls `excludeStressArtifacts(query, currentStressRunIds)`
to drop any row whose `correlation_id LIKE '${stress_run_id}%'` OR
`metadata->>'stress_run_id' IS NOT NULL` OR `group_key LIKE 'stress:%'`.
This means stress runs CANNOT trip the halt criteria. Authoritative-during-
stress signals (per plan v4 §6) are: ShipStation v2 5xx on production
correlation_ids only, Sentry runtime errors NOT tagged with `stress_run_id`,
and persisted-across-two-runs spot-check `drift_major` from
`megaplan-spot-check` (which already excludes synthetic SKUs because the
per-client sample query draws from `warehouse_product_variants`, never
synthetic STRESS-* SKUs).
