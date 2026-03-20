# Trigger Smoke Checklist

Purpose: verify Trigger task runtime is operational in the target environment before release.

---

## 1) Environment and auth pre-check

From the deployment environment shell:

```bash
echo "$TRIGGER_SECRET_KEY" | wc -c
npx trigger.dev@latest --version
npx trigger.dev@latest whoami
```

Expected:
- non-zero `TRIGGER_SECRET_KEY` length
- CLI version returns successfully
- `whoami` returns authenticated account/project context

If `whoami` fails, run:

```bash
npx trigger.dev@latest login
```

---

## 2) Scheduled-task smoke

Pick one low-risk scheduled task from the registry, e.g.:
- `sensor-check`
- `shopify-sync` (if safe in your environment)

Validation steps:
1. Trigger from Trigger dashboard/manual run
2. Confirm task run reaches success state
3. Confirm expected side effects (for `sensor-check`, new sensor/log updates)

Record:
- run ID
- start/end time
- status

---

## 3) Event-task smoke

Pick one event-driven task with safe payload, e.g.:
- `process-shopify-webhook` using a known test `webhook_events.id`
- `process-client-store-webhook` with controlled test event

Validation steps:
1. Insert or identify test event row in `webhook_events`
2. Trigger task with corresponding `webhookEventId`
3. Confirm successful run and expected status update in `webhook_events`

---

## 4) Failure handling check

For one selected task:
- verify failures surface in logs
- verify retry behavior matches expectations
- verify review queue/alerts are generated where designed

---

## 5) Exit criteria

Trigger runtime considered healthy when:
- auth/env pre-check passes
- one scheduled smoke succeeds
- one event smoke succeeds
- logs and side effects match expected behavior

If any step fails, block release and resolve before proceeding.
