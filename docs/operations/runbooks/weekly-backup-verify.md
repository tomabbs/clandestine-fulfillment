# `weekly-backup-verify` runbook

## What this task does

Tier 1 hardening #8 (agent slice). Probes 5 critical tables and asserts:
- non-zero row count, AND
- recent activity (most recent `created_at`/`updated_at`/`started_at`
  is within table-specific freshness threshold).

This is the LIVE-PROD probe. The full restore-into-sandbox procedure
is operator-tier — see [`backup-verify`](./backup-verify.md).

## Schedule + invocation

- **Cron:** Sundays 09:00 UTC.

## Common failure modes

### 1. Critical table empty

- Symptom: alert "$table has 0 rows".
- Means: catastrophic data loss OR RLS regression where service-role
  cannot read.
- Recovery: PAGE on-call. Investigate immediately.

### 2. Stale recency

- Symptom: alert "$table most-recent ... is Nd old".
- Means: writes have stopped to that table.
- Recovery: investigate the writers (which tasks/actions write here);
  check Trigger.dev for failed cron runs.

## Last verified

- 2026-04-13 (TA) — Tier 1 hardening pass: task created.
