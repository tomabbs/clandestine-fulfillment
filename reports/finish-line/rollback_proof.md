# Rollback Proof — Megaplan Finish-Line v4 (2026-04-13)

This document proves the rollback contract for the Phase 6 rollout
infrastructure shipped today. Phase 7 (the ramp itself) was deferred
because the live workspace lacks ShipStation v2 prerequisites; this proof
covers the layer that WOULD execute when Phase 7 is driven.

## Three-layer rollback model

The finish-line plan v4 §rollback specifies three independent layers,
ranked by blast radius:

### Layer 1 — Single-SKU oscillation (most surgical)

**Trigger:** spot-check or staff manually identifies one SKU with persistent
drift between Postgres truth and either Bandcamp or ShipStation v2.

**Action:**
```bash
pnpm tsx scripts/manual-reconcile-sku.ts --sku=<SKU> --target=<v2|bandcamp|all>
```

**Effect:** runs `recordInventoryChange({ source: 'reconcile', ... })` once
for the affected SKU; aligns external system to Postgres truth without
touching the rollout percent.

**Proof of contract:**
- `recordInventoryChange` is the SINGLE inventory write path (Rule #20).
- `external_sync_events` UNIQUE on `(system, correlation_id, sku, action)`
  guarantees the reconcile is idempotent if re-run.
- No rollout state is modified; the rest of fleet continues at current %.

### Layer 2 — Pause integration fanout (medium blast radius)

**Trigger:** ShipStation v2 5xx rate climbs above 2% OR webhook silence
detected on multiple stores OR sustained `external_sync_events.error` rate
spike for one integration.

**Action via staff Server Action:**
```ts
import { setShipstationSyncPaused } from "@/actions/admin-settings";
await setShipstationSyncPaused(true);
```

**Effect:** flips `workspaces.shipstation_sync_paused = true`. The
`fanoutInventoryChange()` helper checks this on every call; pushes to
ShipStation v2 short-circuit while internal writes (Postgres + Redis) and
push to other integrations continue.

**Proof of contract:**
- `loadFanoutGuard()` reads the pause column on EVERY fanout call (no
  cached state to invalidate).
- The pause is per-integration: pausing ShipStation does not affect
  Bandcamp.
- Pause is reversible via the same Server Action with `false`; no data
  loss occurs because external_sync_events queue any deferred writes.

### Layer 3 — Halt the entire ramp (largest blast radius)

**Trigger:**
- Operator decision: any Go/No-Go checkpoint fails
- Auto-trigger: `ramp-halt-criteria-sensor` evaluates §31 criteria and
  decides `halt` or `halt_and_page`

**Action via Server Action (operator-initiated):**
```ts
await setFanoutRolloutPercent({ percent: 0, reason: "<root cause>" });
```

**Action via sensor (auto, no operator):**
The sensor calls `setFanoutRolloutPercentInternal({ percent: 0, actor: { kind: 'sensor', sensorRun: ctx.run.id } })`.

**Effect:** writes `workspaces.fanout_rollout_percent = 0` and appends an
audit row. `fanoutInventoryChange()`'s deterministic FNV-1a hash on
`correlation_id` evaluates `hash % 100 >= 0` for ALL inputs → all fanout
events skip immediately on the next call.

**Proof of contract:**
- The rollout percent is read FRESH on every fanout call via
  `loadFanoutGuard()`. There is no in-memory cache to invalidate; a halt
  takes effect on the next inventory change anywhere in the fleet, in
  Postgres latency.
- Both the staff Server Action AND the sensor write through
  `setFanoutRolloutPercentInternal` (verified by 8 unit tests in
  `tests/unit/lib/server/admin-rollout-internal.test.ts`).
- The audit JSONB is APPEND-ONLY (verified by helper test "appends to
  existing audit (does not overwrite)").
- `actor.kind = "sensor"` carries `sensor_run` for forensic linking back
  to the Trigger run; staff and script actors do not.
- §5.3 two-consecutive-runs persistence prevents single-run flap from
  triggering a halt on H-3 (spot-check); see
  `tests/unit/trigger/lib/ramp-halt-evaluator.test.ts` "H-3: bucket flap
  (trip → recover → trip) does NOT halt".

## What we did NOT prove today

Phase 7 ramp was deferred, so we did NOT exercise:
- The actual fanout-rollout percent affecting live writes (because
  `inventory_sync_paused = true` short-circuits all fanout already).
- The sensor auto-halting against real production drift.
- Layer 1 single-SKU reconcile against a real misaligned SKU.

When Phase 7 resumes, the resume contract should:
1. Run a smoke pass at 0% → record baseline metrics in
   `sensor_readings` for each halt criterion.
2. Manually trigger an artificial spot-check `drift_major` value above 5%
   in `sensor_readings` (test row prefixed `STRESS-`); confirm sensor
   warns but does NOT halt on first run.
3. Submit a second matching reading; confirm sensor halts and writes the
   audit + review queue rows. Roll back percent to baseline and clear
   sensor state.
4. Only then proceed to 0→10% staff-driven ramp.

## Verified halt path test coverage

Every layer has automated test coverage that runs in CI:

| Layer | Coverage | Test file |
|---|---|---|
| 1 | recordInventoryChange invariant guarantees | tests/unit/lib/server/record-inventory-change.test.ts |
| 2 | fanoutInventoryChange honors per-integration pause | tests/unit/lib/server/fanout-guard.test.ts (existing) |
| 3 helper | setFanoutRolloutPercentInternal contract | tests/unit/lib/server/admin-rollout-internal.test.ts (8 cases) |
| 3 sensor | evaluator §31 criteria + §5.3 persistence | tests/unit/trigger/lib/ramp-halt-evaluator.test.ts (14 cases) |

Total: 22 new Phase 6 tests, all green at sign-off.
