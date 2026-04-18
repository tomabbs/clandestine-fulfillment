# Runbook template

> Tier 1 hardening (Part 14.7) item #12.
> Every Trigger.dev task gets a runbook keyed off its task id. Use this
> template when adding a new runbook.

---

# `<task-id>` runbook

## What this task does

One paragraph: business purpose, what it reads, what it writes, what
external system(s) it talks to.

## Schedule + invocation

- **Cron:** `<expression>` (or "on-demand only").
- **Queue:** `<queue name>` (e.g. `bandcamp-api`, `shipstation-api`).
- **Concurrency limit:** `<n>` (always 1 for OAuth-bearing Bandcamp tasks).
- **Manual invocation:** `tasks.trigger("<task-id>", { … })` from a Server
  Action OR via Trigger.dev dashboard.

## Common failure modes

### 1. `<symptom>`

- Where you'll see it (Sentry tag, log line, dashboard).
- What it usually means.
- Recovery steps:
  1. …
  2. …

### 2. `<symptom>`

(repeat)

## Recovery cheatsheet

| Situation | Action |
|-----------|--------|
| Stuck in_flight on `external_sync_events` for >1h | Manually update status to 'error' with note, re-trigger task with same correlation_id |
| Queue starvation (Bandcamp queue depth >5min) | Pause `bandcamp-sales-backfill-cron` temporarily, drain queue |
| Auth failure | Run secret rotation procedure for the relevant secret (see `docs/operations/secret-rotation.md`) |

## Escalation

- Owner: ops on-call → eng lead.
- SLO this task contributes to: see `docs/operations/SLO.md` row #N.

## Last verified

- YYYY-MM-DD by `<initials>` — `<one-line outcome>`.
