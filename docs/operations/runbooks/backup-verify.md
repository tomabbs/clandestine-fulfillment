# Backup verification — operator procedure

> Tier 1 hardening (Part 14.7) item #8 — operator extension.
> The agent-side `weekly-backup-verify` task probes prod aliveness; this
> runbook covers the full restore-into-sandbox verification that requires
> operator credentials.

## When to run

- Quarterly minimum.
- Within 48h of any major Postgres schema migration.
- Within 24h of any Supabase support-ticket-driven recovery.

## Prerequisites

- Sandbox Supabase project provisioned (`clandestine-fulfillment-sandbox`).
- `pg_dump` + `pg_restore` installed locally.
- `supabase` CLI logged in to BOTH prod and sandbox projects.
- Service-role key for sandbox stored in `.env.sandbox` (NEVER in
  Vercel; this is local-only).

## Procedure

1. **Snapshot prod**
   ```bash
   supabase db dump --linked --file backup-verify-$(date +%Y%m%d).sql
   ```

2. **Switch to sandbox project**
   ```bash
   supabase link --project-ref <sandbox-ref>
   ```

3. **Wipe sandbox public schema**
   ```bash
   supabase db reset --linked
   ```

4. **Restore into sandbox**
   ```bash
   psql "$SANDBOX_DIRECT_URL" < backup-verify-$(date +%Y%m%d).sql
   ```

5. **Run row-count comparison**
   ```bash
   ENV=sandbox node scripts/backup-verify-compare.mjs
   ```
   The script prints a side-by-side row count for each table in
   `CRITICAL_TABLES` (defined in `src/trigger/tasks/weekly-backup-verify.ts`).
   ALL counts must match. Differences > 0.5% indicate a backup
   integrity issue — page Supabase support.

6. **Run RLS smoke test against sandbox**
   ```bash
   INTEGRATION_TEST_SUPABASE_URL=$SANDBOX_URL \
   INTEGRATION_TEST_SERVICE_ROLE_KEY=$SANDBOX_SERVICE_KEY \
   INTEGRATION_TEST_ANON_KEY=$SANDBOX_ANON_KEY \
   pnpm test:integration
   ```

7. **Re-link to prod**
   ```bash
   supabase link --project-ref <prod-ref>
   ```

8. **Document the run**
   - Append a row to `docs/operations/secret-rotation.md` rotation log
     under the heading "Backup verification" (or this runbook's log
     below).
   - Capture row counts in the run record.

## Verification log

| Date | Operator | Backup file | Row count drift | RLS smoke test result | Notes |
|------|----------|-------------|-----------------|----------------------|-------|
| 2026-04-13 | (initial) | n/a | n/a | n/a | Runbook authored — no run yet. |

## Failure escalation

- Row counts diverge: page Supabase support immediately. Do NOT delete
  the backup file; ops needs it.
- RLS smoke test fails: investigate which policy regressed; do not
  promote any new migration to prod until sandbox passes.
