# Manual Release Checks - 2026-03-20

## Scope

- `scripts/sql/prod_parity_checks.sql`
- `scripts/sql/webhook_health_snapshot.sql`
- `docs/TRIGGER_SMOKE_CHECKLIST.md`
- `docs/INTEGRATION_REGISTRATION_MATRIX.md`

## Results

### 1) Prod parity SQL check

- Status: `PARTIAL / BLOCKED`
- Direct DB execution was re-attempted via `.env.local` `DATABASE_URL` and `DIRECT_URL`.
- Direct connection still fails:
  - `password authentication failed for user "postgres"`
- Partial API-level parity was executed with service-role credentials and saved to:
  - `reports/manual-checks/prod_parity_checks.partial.result.json`
- Partial parity confirms required critical tables are present.
- RLS policy and migration-history checks remain blocked without valid direct DB auth.

### 2) Webhook health snapshot

- Status: `COMPLETED`
- Executed equivalent snapshot via service-role API and saved to:
  - `reports/manual-checks/webhook_health_snapshot.result.json`
- Key findings:
  - Shopify traffic observed in last 7 days (`168` events).
  - No events in last 7 days for ShipStation, AfterShip, Stripe, Resend.
  - No active `client_store_connections` rows were observed.

### 3) Trigger smoke checklist

- Status: `COMPLETED (FAILED HEALTH CHECK)`
- Pre-check results:
  - `TRIGGER_SECRET_KEY` length: `27` (non-zero)
  - CLI version: `4.4.3`
  - `whoami`: success, authenticated to project `clandestine-fulfillment`.
- Trigger smoke harness executed and saved to:
  - `reports/manual-checks/trigger_smoke.result.json`
- Scheduled-task smoke:
  - task: `sensor-check`
  - run: `run_cmmz0umbh3xdr0in2hcbvuhwf`
  - observed status for ~40s: `QUEUED` (never executed)
  - side effect: no new `sensor_readings` row observed
- Event-task smoke:
  - task: `process-shopify-webhook`
  - run: `run_cmmz0vhx63sse0on2kyd4e9nh`
  - observed status for ~40s: `QUEUED` (never executed)
  - side effect: `webhook_events` row status unchanged
- Failure-handling check:
  - task: `process-shopify-webhook` with invalid UUID payload
  - run: `run_cmmz0wdhp41k30hocpzr9mpk1`
  - observed status for ~40s: `QUEUED` (never executed)
- Conclusion:
  - API auth is valid, but cloud workers are not currently draining queued runs for this project/environment.
  - Release should remain blocked until Trigger execution resumes and smoke checks pass.

### 4) Integration registration matrix

- Status: `UPDATED`
- File updated:
  - `docs/INTEGRATION_REGISTRATION_MATRIX.md`
- `Current registration status` + `Last validated` were populated from current evidence:
  - Shopify: `ACTIVE_TRAFFIC_SEEN (168 events/7d)`
  - ShipStation/AfterShip/Stripe/Resend: `STALE_OR_UNREGISTERED (0 events/7d)`
  - Client store: `NO_ACTIVE_CONNECTIONS_OBSERVED`
- `Owner` remains `TBD` pending assignment.

## Remaining blockers to clear

1. Provide valid direct Postgres connection credentials (or rotate and update env), then rerun:
   - `scripts/sql/prod_parity_checks.sql`
2. Restore Trigger cloud execution (runs are accepted but remain `QUEUED`):
   - verify worker/runtime health in Trigger dashboard for project `clandestine-fulfillment`
   - once healthy, rerun `reports/manual-checks/trigger_smoke.result.json` harness and confirm completion/success.
