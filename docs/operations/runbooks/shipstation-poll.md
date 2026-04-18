# `shipstation-poll` runbook

## What this task does

Backup poller for ShipStation v1 — pulls shipments since
`last_shipment_id` for workspaces whose webhook URL on cPanel may be
stale (Phase 0.8 audit). Bridge until Shopify Custom App approval
allows full webhook coverage.

## Schedule + invocation

- **Cron:** every 30 minutes.
- **Queue:** none (v1 has no global rate limit issues).

## Common failure modes

### 1. Cursor mismatch

- Symptom: re-processing same shipments.
- Recovery: verify `last_shipment_id` advances after each successful run.

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
