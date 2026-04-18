# `daily-recon-summary` runbook

## What this task does

Tier 1 hardening #11. Aggregates the last 24h of:
- `external_sync_events` status counts (in_flight / success / error,
  errors broken out by system).
- `warehouse_review_queue` open items by severity.
- `channel_sync_log` failed/partial runs broken out by channel.

Logs the structured report unconditionally; emails it to
`OPS_ALERT_EMAIL` when set.

## Schedule + invocation

- **Cron:** daily 12:00 UTC (08:00 ET DST / 07:00 ET winter).

## Common failure modes

### 1. Resend send fails but report logged

- Recovery: cron next day will resend with current state. Or trigger
  `daily-recon-summary` manually.

### 2. OPS_ALERT_EMAIL unset

- Behaviour: task succeeds without sending email; logs note "no
  recipient configured".

## Last verified

- 2026-04-13 (TA) — Tier 1 hardening pass: task created.
