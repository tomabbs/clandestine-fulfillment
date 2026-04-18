# `bandcamp-inventory-push` runbook

## What this task does

Pushes inventory deltas to Bandcamp `update_quantities` API for variants
with `push_mode = 'normal'`. Bundle SKUs use the shared
`computeEffectiveBundleAvailable()` helper (Phase 2.5(b)).

## Schedule + invocation

- **Triggered:** by `recordInventoryChange()` fanout (Rule #43 step 4).
- **Queue:** `bandcamp-api` (Rule #9).

## Common failure modes

### 1. Push to baseline-anomaly mapping

- Symptom: API returns 200 but Bandcamp shows inflated quantity.
- Means: mapping should be `push_mode='blocked_baseline'` but isn't.
- Recovery: run `bandcamp-baseline-audit`, flip mapping.

### 2. Multi-origin merchant push without `origin_id`

- Symptom: Bandcamp API returns "ambiguous origin" error.
- Means: mapping should be `push_mode='blocked_multi_origin'` OR push
  must include explicit `origin_id`.
- Recovery: per Phase 1 audit, flip mapping to `blocked_multi_origin`.

## Recovery cheatsheet

| Situation | Action |
|-----------|--------|
| `external_sync_events.error` for system='bandcamp' | Inspect `response_body` for API code; consult Bandcamp API docs |

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
