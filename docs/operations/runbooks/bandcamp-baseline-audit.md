# `bandcamp-baseline-audit` runbook

## What this task does

Phase 1 audit. Sweeps every fulfillment-client Bandcamp mapping; for
each merchant, probes `merch_details` and writes
`bandcamp_baseline_anomalies` rows when TOP `quantity_available` is
inflated above the sum of `origin_quantities`. Flips mapping
`push_mode` to `blocked_baseline` or `blocked_multi_origin` as needed.

## Schedule + invocation

- **Manual:** triggered by Phase 1 deploy and on-demand from staff UI.
- **Queue:** `bandcamp-api` (Rule #9).

## Common failure modes

### 1. Audit stalls on one workspace

- Means: that workspace's Bandcamp credential is invalid.
- Recovery: re-OAuth the workspace, re-run audit for that workspace only.

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
