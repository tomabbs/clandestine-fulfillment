# ShipStation Unified Shipping — Operator Runbook

This doc is the operator-facing companion to the build plan
(`/Users/tomabbs/.cursor/plans/unified_shipping_workflow_a8ac6c94.plan.md`).
Phase 7.2 fleshes this out with the full architecture map; for now it carries
the **cutover runbook** + **rollback runbook** for Phase 6.3.

## Status (as of 2026-04-19)

- Phases 0 → 5 + Phase 8 + Phase 6 (code-only) shipped to production via the
  unified-shipping commit on `main`.
- Code is FLAG-GATED off via `workspaces.flags.shipstation_unified_shipping`.
  Cockpit at `/admin/orders` still renders the legacy multi-source view until
  the flag is flipped.
- Trigger.dev: 4 new tasks live (`shipstation-orders-poll`,
  `post-label-purchase`, `shipstation-mark-shipped`, `preorder-tab-refresh`)
  + Phase 6.5 swap (`bandcamp-mark-shipped-cron` removed,
  `bandcamp-shipping-verify` added).
- Supabase: 7 unified-shipping migrations applied (label_purchase_attempts,
  variant_tariff_dimensions, shipstation_orders + items, workspaces.flags,
  shipstation_carrier_map, user_view_prefs + SS-fields extension).

## Phase 6 cutover runbook

The cutover is a single SQL statement. Everything else is verification.

### One-shot pre-flight check (RUN THIS FIRST)

```sh
pnpm tsx scripts/verify-cutover-readiness.ts
```

Exit codes: `0` = safe to flip, `1` = blockers failed, `2` = warnings only,
`3` = env misconfigured. The script checks every gate below in code so you
don't have to walk it manually. Add `--workspace=<id>` to target a specific
workspace, `--json` for machine-readable output. Re-run it anytime; it never
mutates data.

If it returns 0, jump to **The flip** below.

### What the verifier checks (and how to fix each blocker)

1. **`shipstation_orders` backfill executed** — confirm row count > 0 for
   the cutover workspace:
   ```sql
   SELECT count(*) FROM shipstation_orders WHERE workspace_id = '<ws-uuid>';
   ```
   Already done 2026-04-19 — 1241 rows ingested.

2. **Phase 4.0.A v2 fulfillments capability probe** — run:
   ```sh
   pnpm tsx scripts/shipstation-v2-fulfillments-probe.ts
   ```
   Step 1 should list recent v2 shipment IDs (HTTP 200). Pick one
   awaiting-shipment SS order in a non-critical store; then run with
   `--confirm`:
   ```sh
   pnpm tsx scripts/shipstation-v2-fulfillments-probe.ts \
     --shipment-id=se-XXXXXX \
     --tracking=<real-EP-tracking-number> \
     --carrier=stamps_com \
     --confirm
   ```
   Step 5 of the script's output makes the decision: `v2 PRIMARY` (proceed)
   vs `v1 PRIMARY` (need to re-anchor Phase 4.3 — escalate). Record the
   result here under "Decision log" below.

3. **Phase 4.0.B BC connector round-trip** — manual SS-dashboard test for one
   Bandcamp store. Mark Shipped via SS UI on a real BC order with
   `notifyCustomer: true` AND `notifySalesChannel: true`. Wait 5 min:
   - Customer received SS shipment-confirmation email? ✅/❌
   - BC dashboard shows `ship_date` populated for that order? ✅/❌
   - Customer received BC's own shipped email? ✅/❌
   Record per-store outcome; if BC connector failed, fix in SS dashboard
   BEFORE flipping the flag (otherwise BC orders won't sync until the
   `bandcamp-shipping-verify` cron's 30-min fallback fires).

4. **Carrier-map verified** — open `/admin/settings/carrier-map`. For each
   row currently being used by orders in the cutover workspace, click
   "Verify + allow" after a real round-trip. Verify a label of the
   corresponding carrier was actually written back to SS successfully via the
   v2 probe in step 2.

5. **`SHIPSTATION_WEBHOOK_SECRET` set in production env** — without this,
   the SS webhook route returns 500 in prod (deploy-blocking by design).
   Confirm in your hosting dashboard.

6. **`EASYPOST_ASENDIA_CARRIER_ACCOUNT_ID` set in production env** — has a
   fallback default but ops should set it explicitly so prod vs sandbox can
   differentiate accounts.

7. **ORDER_NOTIFY enabled in SS dashboard** — Settings → Account → API
   Settings → Webhooks. Without this, the cockpit will still update via the
   15-min cron but staff won't see fresh state in real-time.

8. **`/admin/orders-legacy` smoke test** — open the URL directly. Confirm
   the legacy view loads cleanly (it remains the rollback surface).

9. **All Phase 0–5 + 8 retrospectives are signed off in the plan doc** —
   that's the documentation gate for the cutover.

### The flip

When all 9 checks above pass, run the single SQL statement:

```sql
UPDATE workspaces
SET flags = jsonb_set(flags, '{shipstation_unified_shipping}', 'true')
WHERE id = '<cutover-workspace-uuid>';
```

Then verify within 30 seconds (the `getWorkspaceFlags()` cache TTL):

1. Open `/admin/orders` in a private browser window. The new ShipStation
   cockpit (left status sidebar + tabs + table with Tracking column) should
   render — NOT the legacy multi-source view.
2. Click into one order row → confirm the drawer opens with: Bandcamp match
   badge (if applicable), ship-to + verify button, tags + Edit Tags, hold-
   until picker, Buy Label panel.
3. Open `/admin/orders-legacy` — confirms the rollback surface still works.
   Per-row CreateLabelPanel should show the "Label printing moved to the new
   Orders cockpit" notice (because `staff_diagnostics` is still off).

### Within the first hour

- Watch for `easypost.rate_delta_halt` sensor events. Any hit = a real
  customer-facing UX failure; investigate immediately.
- Watch `shipstation.bc_connector_fallback` — the verifier cron fires every
  30 min; if fallback rate > baseline established in step 3, BC connector
  is misbehaving and the verifier safety-net is doing more work than
  expected.
- Watch the SS dashboard for orders that should have flipped to "shipped"
  but didn't — those are writeback failures and will surface in the cockpit
  with the writeback-error banner + Retry button.

### Post-cutover follow-ups

- Investigate the 313 (~26.7%) unmatched SS orders surfaced by the Phase 1.4
  backfill. Use the cockpit's "Needs Assignment" tab + the manual
  org-assignment dropdown in the row drawer.
- After 30 days of clean dual-running, plan removal of
  `/admin/orders-legacy/page.tsx` + `_legacy-orders-view.tsx` + the import
  shim in `src/app/admin/orders/page.tsx`.

## Rollback runbook

If the cutover causes a customer-communication incident or staff workflow
breakage that can't be patched within ~1 hour, rollback is one statement:

```sql
UPDATE workspaces
SET flags = flags - 'shipstation_unified_shipping'
WHERE id = '<cutover-workspace-uuid>';
```

This makes `/admin/orders` render the legacy view again within 30 seconds
(per-process flag cache TTL). The legacy view's per-row CreateLabelPanel
becomes available again because the flag-OFF branch passes
`canPrintLegacyLabels=true`.

**Reconciliation after rollback**: any labels printed through the cockpit
during the rollback window remain in `warehouse_shipments` with
`label_source='easypost'` + `shipstation_order_id` populated. They are
indistinguishable from labels that would have been printed pre-cutover via
the legacy view's manual flow — no special reconciliation needed. SS-side
writeback continues to work via `shipstation-mark-shipped` regardless of
which UI bought the label.

## Decision log

(Operator fills this in during cutover.)

- **v2 fulfillments capability**: ⏳ pending operator probe →
- **BC connector round-trip per store**: ⏳ pending operator test
- **Cutover timestamp**: ⏳
- **Cutover workspace UUID**: ⏳

## Architecture map (Phase 7.2 will expand)

See the canonical plan doc + the per-phase retrospectives for full detail:
`/Users/tomabbs/.cursor/plans/unified_shipping_workflow_a8ac6c94.plan.md`
