# `external-sync-events-retention` runbook

## What this task does

Tier 1 hardening #14 (Patch D3). Daily sweep:
- Deletes `external_sync_events` where status='success' and
  completed_at < now() - 7 days.
- Deletes status='error' rows older than 30 days.
- Never deletes in_flight rows.

Prevents index bloat on the synchronous hot path of every fanout call.

## Schedule + invocation

- **Cron:** daily 07:30 UTC.

## Common failure modes

### 1. Delete query times out

- Symptom: error in cron run after 120s.
- Means: backlog too large for one sweep (first run after a long
  outage).
- Recovery: run manually multiple times until empty; consider
  shortening retention temporarily.

## Last verified

- 2026-04-13 (TA) — Tier 1 hardening pass: task created.
