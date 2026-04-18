# `sensor-check` runbook

## What this task does

Periodic sensor evaluation. Runs every health-state check defined in
`src/trigger/lib/sensor-defs.ts` and writes results to
`sensor_readings`.

## Schedule + invocation

- **Cron:** every 5 minutes.

## Common failure modes

### 1. Single sensor fails

- Symptom: one sensor row missing; others written.
- Recovery: per-sensor retry on next tick; investigate sensor's
  dependencies.

### 2. All sensors fail

- Means: Postgres or Redis unreachable.
- Recovery: PAGE on-call.

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
