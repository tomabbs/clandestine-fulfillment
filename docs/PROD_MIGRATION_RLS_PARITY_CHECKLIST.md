# Production Migration + RLS Parity Checklist

Purpose: prevent production-only 500s caused by schema/policy drift between repository code and deployed Supabase.

Primary risk areas:
- Portal support writes (`support_conversations`, `support_messages`)
- Portal inbound submit (`warehouse_inbound_shipments`, `warehouse_inbound_items`)
- Invite/user flows (`users`)

Use with:
- `scripts/sql/prod_parity_checks.sql`

---

## 1) Required migration baseline

Verify production has applied all migrations present in `supabase/migrations`, with special attention to post-base policy migrations:

- `20260316000009_rls.sql`
- `20260316000010_support.sql`
- `20260319000001_support_client_insert.sql`
- `20260319000004_user_is_active.sql`

Note: current repository contains more than the original 001-010 plan set. Do not assume a 10-migration baseline.

---

## 2) Run SQL parity checks in Supabase SQL Editor

Copy/paste and execute:
- `scripts/sql/prod_parity_checks.sql`

This script checks:
- existence of critical tables
- existence of critical RLS policies
- whether RLS is enabled where expected
- whether migration history includes expected versions

---

## 3) Manual validation of critical writes

After SQL parity checks pass, validate these user journeys in production:

1. Portal support:
   - create new conversation
   - send reply in existing conversation
2. Portal inbound:
   - submit new inbound shipment with at least one item
3. Admin/client invite:
   - invite user and confirm envelope error/success handling

Expected:
- No generic “Server Components render” 500 errors
- Clear user-visible mutation error messages when failures occur

---

## 4) Release gate decision

Only proceed with larger upgrades when all are true:

- SQL parity checks are green
- critical write-path smoke tests pass
- CI is green (`check`, `typecheck`, `test`, `build`, guard scripts)

If any parity check fails, fix migration/policy drift first before shipping new features.
