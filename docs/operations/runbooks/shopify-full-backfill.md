# `shopify-full-backfill` runbook

## What this task does

Full Clandestine Shopify catalog backfill. Used for first-time setup,
recovery from severe drift, or after a major schema migration. Bulk
INSERT…ON CONFLICT (Rule #59).

## Schedule + invocation

- **On-demand only.** Triggered manually from staff Channels page.
- **Queue:** none.

## Common failure modes

### 1. Long run > maxDuration

- Symptom: task timeout at 300s.
- Means: catalog grew past chunk size.
- Recovery: increase chunk size or shard by collection.

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
