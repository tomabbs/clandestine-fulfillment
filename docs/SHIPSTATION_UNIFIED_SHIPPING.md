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

## Phase 12 — Unified branded customer email pipeline

Code shipped 2026-04-19. **Currently deployed in `email_send_strategy='off'` mode**, meaning ShipStation continues to send all customer emails exactly as before. Nothing customer-facing has changed yet. Cutover happens when ops flips the strategy flag (via SQL).

### Architecture (when activated)

| Email | Sender |
|---|---|
| Order receipt | Bandcamp / Shopify (their existing native flows — untouched) |
| Shipment Confirmation | **us via Resend** (`shipment-confirmation` template) |
| Out for Delivery | **us via Resend** (`out-for-delivery` template) |
| Delivered | **us via Resend** (`delivered` template) |
| Exception (return/lost/cancelled) | **us via Resend** (`exception` template) |
| ShipStation customer emails | **none** — `notify_customer: false` |
| Customer tracking link | **always** `https://app.../track/[token]` (our branded page) |
| Carrier event source | **EasyPost only** (replaces ShipStation tracking) |

### Strategy flag values

```
workspaces.flags.email_send_strategy:
  'off'             ← default; SS still emails per legacy hybrid matrix
  'shadow'          ← parallel-run mode; SS continues to real customers,
                       unified pipeline ALSO runs but redirects to
                       workspaces.flags.shadow_recipients (ops only)
  'unified_resend'  ← production target; SS stops emailing customers,
                       unified pipeline takes over
  'ss_for_all'      ← legacy / emergency-reverse; force everything to SS
```

### Per-shipment kill switch

```
warehouse_shipments.suppress_emails: boolean (default false)
```

Wins over EVERY workspace strategy. Use for one-off opt-outs.

### Cutover sequence (single workspace)

**Stage 1 — DONE:** code shipped, migration applied, Trigger.dev tasks
deployed, 772 existing shipments backfilled with `public_track_token`. Mode
defaults to `'off'`. Real-customer behavior unchanged.

**Stage 2 — Pre-flight gates** (run BEFORE flipping to `shadow` or `unified_resend`):

- [ ] `RESEND_WEBHOOK_SECRET` set in Vercel prod env (get from Resend
      dashboard → Webhooks → endpoint signing secret).
- [ ] Resend webhook URL configured in Resend dashboard pointing to
      `https://app.clandestinedistro.com/api/webhooks/resend` for events:
      `email.delivered`, `email.bounced`, `email.complained`.
- [ ] `EASYPOST_WEBHOOK_SECRET` already set (Phase 10 prereq) + EP webhook
      pointed at `/api/webhooks/easypost` for `tracker.updated`.
- [ ] Shipping sender domain (`clandestinedistro.com`) DKIM/SPF/DMARC
      passing in Resend dashboard.
- [ ] Run mail-tester.com style deliverability check: send 5 manual test
      emails per template via Resend to Gmail/Outlook/Yahoo/Apple/ProtonMail.
      Confirm inbox placement, score ≥ 9/10, DKIM signed.

**Stage 3 — Shadow mode (parallel-run review)**:

```sql
UPDATE workspaces
SET flags = jsonb_set(
  jsonb_set(flags, '{email_send_strategy}', '"shadow"'),
  '{shadow_recipients}', '["tom@northern-spy.com"]'
)
WHERE id = '<ws-uuid>';
```

For as long as you want (recommended ≥ 3 days):
- SS keeps emailing real customers exactly as before
- Unified pipeline ALSO runs on every shipment; emails go to
  `tom@northern-spy.com` only
- Each shadow send writes a `notification_sends` row with
  `status='shadow'` and `shadow_intended_recipient` = real customer email
- Reconciliation cron fires daily at 04:30 UTC; will re-fire any missing
  sends within 24h (idempotent — no double-sends possible)

Manually review every email shape in your inbox: subject, branding,
tracking link works, plain-text alt is sane.

**Stage 4 — Cutover (flip to production unified mode)**:

```sql
UPDATE workspaces
SET flags = jsonb_set(flags, '{email_send_strategy}', '"unified_resend"')
WHERE id = '<ws-uuid>';
```

Within 30 seconds (per-process flag cache TTL):
- SS stops emailing customers (`notify_customer=false` returned by strategy fn)
- BC connector still pushes ship_date back (so BC marks orders shipped on
  its own dashboard + sends BC's native receipt — the accepted "one
  redundant store-platform email")
- Shopify still sends its own emails for shopify_main / shopify_client
- WE start sending to real customers

**Stage 5 — Rollback (any time)**:

```sql
UPDATE workspaces SET flags = jsonb_set(flags, '{email_send_strategy}', '"off"') WHERE id = '<ws-uuid>';
```

Within 30 seconds:
- Unified pipeline goes silent (skipped+audit row instead of sending)
- SS resumes emailing per the legacy hybrid matrix
- No data corruption, no manual cleanup needed

### Monitoring after cutover

The `notification_sends` table is the source of truth. Key SQL:

```sql
-- Sends in last 24h by status
SELECT trigger_status, status, count(*) FROM notification_sends
 WHERE sent_at > now() - interval '24 hours'
 GROUP BY 1, 2 ORDER BY 1, 2;

-- Failure rate
SELECT count(*) FILTER (WHERE status='failed') * 100.0 / count(*) AS pct_failed
 FROM notification_sends WHERE sent_at > now() - interval '24 hours';

-- Bounce / complaint list (recipients added to suppression)
SELECT * FROM resend_suppressions ORDER BY created_at DESC LIMIT 50;

-- Reconciliation gaps in last 24h
SELECT message FROM sensor_readings
 WHERE sensor_name = 'notification.reconciliation_misses'
 ORDER BY created_at DESC LIMIT 5;
```

### In-flight shipments at cutover

Shipments that already have `shipstation_marked_shipped_at` BEFORE the flag
flip will NOT receive a Shipment Confirmation email retroactively (the
recon cron only looks back 7 days AND requires a missing audit row — but
those shipments will be MISSING audit rows, so the cron WOULD fire). To
prevent that, before flipping insert `notification_sends` rows with
`status='suppressed'` for every existing shipped row:

```sql
INSERT INTO notification_sends
  (workspace_id, shipment_id, trigger_status, channel, template_id, recipient, status, error)
SELECT
  workspace_id, id, 'shipped', 'email', 'shipped', '(in-flight at cutover)',
  'suppressed', 'inserted at Phase 12 cutover to prevent retroactive emails'
FROM warehouse_shipments
WHERE shipstation_marked_shipped_at IS NOT NULL
  AND shipstation_marked_shipped_at > now() - interval '7 days'
  AND id NOT IN (SELECT shipment_id FROM notification_sends WHERE trigger_status = 'shipped')
ON CONFLICT DO NOTHING;
```

Run this AS the cutover SQL in the same transaction window if possible.
The recon cron then only fires OOD/Delivered going forward, never the
backfill confirmation.

## Phase 7 — Workspace feature flags (admin)

All flags live in `workspaces.flags` JSONB and are managed via:

- **Admin UI**: `/admin/settings/feature-flags` (Phase 7.3 page) — flip booleans, edit the `email_send_strategy` enum (with confirm gate), set `shadow_recipients`, tune `rate_delta_thresholds`. Writes are validated by the Zod schema in `src/lib/server/workspace-flags.ts` — typos are rejected before persisting.
- **SQL** (cutover sequences in this doc use SQL because flag-flip is the operational moment).

Documented keys (full schema in `src/lib/server/workspace-flags.ts`):

| Key | Type | Purpose |
|---|---|---|
| `shipstation_unified_shipping` | bool | Phase 6 — gate the new cockpit at `/admin/orders` |
| `email_send_strategy` | enum | Phase 12 — `off` / `shadow` / `unified_resend` / `ss_for_all` |
| `shadow_recipients` | string[] | Phase 12 — recipients for shadow mode (≥ 1 required) |
| `rate_delta_thresholds` | `{warn,halt}` | Phase 0.5.2 — circuit-breaker limits in USD |
| `easypost_buy_enabled` | bool | Phase 7.3 — kill switch for EP label purchase (default true) |
| `shipstation_writeback_enabled` | bool | Phase 7.3 — kill switch for SS mark-shipped (default true) |
| `v1_features_enabled` | bool | Phase 9.5 — gate bulk tag/hold UI |
| `staff_diagnostics` | bool | Phase 6.3 — re-enable legacy CreateLabelPanel post-cutover |
| `bandcamp_skip_ss_email` | bool | Phase 10.4 — legacy hybrid mode only |

## Phase 7.1 — Sensors emitted hourly

The `unified-shipping-sensors` cron (every hour at :05) writes one
`sensor_readings` row per workspace per metric. Latest readings are visible at
`/admin/settings/health` (existing dashboard).

| Sensor | Healthy | Warning | Critical |
|---|---|---|---|
| `shipstation.writeback_failed_count` | 0 | 1-5 | >5 |
| `shipstation.label_printed_not_marked` | 0 | 1-10 | >10 |
| `shipstation.orders_unmatched_count` | ≤25 | >25 | — |
| `notification.send_failure_rate_24h` | <1% | 1-5% | >5% |
| `notification.recon_cron_alive` | <25h since reading | ≥25h | — |
| `resend.bounce_rate_24h` | <5% | ≥5% | — |
| `resend.complaint_rate_24h` | <0.1% | — | ≥0.1% |
| `tracker.parity_cron_alive` | <25h since reading | ≥25h | — |

## Phase 7 — Operational runbooks

### Runbook 1 — "Label printed but mark-shipped failing"

Symptom: `shipstation.label_printed_not_marked` sensor in `warning` /
`critical` state. Customer's package is shipping but the SS dashboard
doesn't reflect it (so SS-side automation that depends on shipped status
won't fire — though customer email is OUR responsibility in unified mode).

Diagnosis:
```sql
-- Find affected shipments
SELECT id, workspace_id, shipstation_order_id, tracking_number, carrier,
       shipstation_writeback_error, shipstation_writeback_attempts,
       shipstation_writeback_path, created_at
  FROM warehouse_shipments
 WHERE shipstation_marked_shipped_at IS NULL
   AND shipstation_order_id IS NOT NULL
   AND tracking_number IS NOT NULL
   AND created_at < now() - interval '30 minutes'
   AND created_at > now() - interval '24 hours'
 ORDER BY created_at DESC;
```

Actions in priority order:

1. **Check `shipstation_writeback_error`** column — common values:
   - `mapping_blocked_by_low_confidence`: open `/admin/settings/carrier-map`,
     find the EP carrier, click "Verify + allow" to flip
     `block_auto_writeback=false`.
   - `v1_fallback_no_order_id`: SS order missing from `shipstation_orders`.
     Re-run `pnpm tsx scripts/shipstation-orders-backfill.ts --workspace=<id>`.
   - 4xx from SS API: SS API key may have rotated; check `SHIPSTATION_API_KEY`
     env var.
2. **Manually retry** — open the order in `/admin/orders`, click the
   "Retry write-back" button in the drawer's writeback-error banner.
3. **Bulk retry**: invoke the trigger task directly via the dashboard:
   `shipstation-mark-shipped` with payload
   `{ warehouse_shipment_id: "..." }`.
4. **If `shipstation_writeback_enabled = false`**: that's the kill switch.
   Flip back to true via `/admin/settings/feature-flags`.

### Runbook 2 — "Customer didn't receive Shipment Confirmation"

Symptom: customer support ticket says "I never got a tracking email."

Diagnosis:
```sql
-- Did we attempt the send?
SELECT * FROM notification_sends
 WHERE shipment_id = '<warehouse_shipment_id>'
   AND trigger_status = 'shipped'
 ORDER BY sent_at DESC;
```

Possible outcomes:
- `status='sent'`: we DID send. Check Resend dashboard for the
  `resend_message_id` to see delivery status. Likely junk-foldered or
  recipient-side block.
- `status='failed'`: send attempt errored. Check `error` column for the
  Resend API response.
- `status='bounced'` / `'complained'`: recipient is on `resend_suppressions`.
  Confirm with customer that they actually want emails before manually
  removing them.
- `status='shadow'`: workspace is in shadow mode. Real customer never got
  the email — by design.
- `status='skipped'`: strategy gate skipped it. Check `error` column for
  reason (e.g. `strategy=off → ...`).
- `status='suppressed'`: recipient address is on suppression list.
- **No row at all**: pipeline didn't fire. Daily recon cron should catch
  this within 24h. Or trigger manually via Trigger.dev dashboard:
  `send-tracking-email` with payload
  `{ shipment_id: "...", trigger_status: "shipped" }`.

### Runbook 3 — "Spam complaint rate spike"

Symptom: `resend.complaint_rate_24h` sensor in `critical` (>0.1%).

This is a deliverability emergency. Action immediately:

1. **Stop sending**:
   ```sql
   UPDATE workspaces SET flags = jsonb_set(flags, '{email_send_strategy}', '"off"')
    WHERE id = '<ws-uuid>';
   ```
   Within 30 seconds the unified pipeline goes silent and SS resumes the
   legacy hybrid behavior.

2. **Investigate**:
   ```sql
   SELECT recipient, error, sent_at FROM notification_sends
    WHERE status = 'complained' AND sent_at > now() - interval '24 hours'
    ORDER BY sent_at DESC;
   ```
   Common causes: wrong-recipient sends, sending to old email lists, content
   that triggers spam filters. Each complaint row has the recipient address
   added to `resend_suppressions` automatically.

3. **Audit + remediate** before re-enabling. Domain reputation can take
   days/weeks to recover from a complaint spike.

### Runbook 4 — Carrier map maintenance

The `shipstation_carrier_map` table maps EP carrier+service strings to SS
carrier_code values. SS rejects writeback calls for carriers it doesn't
recognize, so this map must be kept current.

Add a new EP carrier:

1. Go to `/admin/settings/carrier-map`.
2. Click "Re-seed from SS" — pulls the latest list of SS carriers.
3. Find the row for the new EP carrier; pick the matching SS carrier_code
   from the dropdown.
4. **Critical**: do a real test ship via the cockpit, watch the
   `shipstation_marked_shipped_at` stamp on the shipment, then click
   "Verify + allow" on the row to flip `block_auto_writeback=false` and
   `mapping_confidence='verified'`.

Until verified, that mapping returns `mapping_blocked_by_low_confidence` and
the writeback task surfaces it in the cockpit's writeback-error banner.

### Runbook 5 — Preorder tab semantics

A SS order is in the "Preorders" tab when `shipstation_orders.preorder_state =
'preorder'`. It moves to "Ready to ship" when `preorder_state = 'ready'`,
which happens once any line-item's `street_date` is within
`PREORDER_READY_WINDOW_DAYS` (default 7) of today (NY timezone).

The state is recomputed by the `preorder-tab-refresh` cron (daily at 05:00
NY) and by the SS order poll (every 15 min) when an order is
ingested/updated.

If preorder badges look wrong:

```sql
-- Inspect a specific order
SELECT preorder_state, preorder_release_date, shipstation_order_id
  FROM shipstation_orders WHERE order_number = '<...>';

-- Force-refresh that one order (kicks the cron)
-- via Trigger.dev dashboard: preorder-tab-refresh, payload {} → re-derives
-- for all candidates including this one.
```

The `preorder.refresh_cron_stale` sensor (Phase 5 retro) alerts if the cron
hasn't run in 25+ hours.

### Runbook 6 — AfterShip sunset (Phase 10.5)

Status: DEFERRED until tracker-parity sensor is green for ≥30 days
(earliest 2026-05-19). Do NOT execute these steps until the gate is passed.

When ready:

1. Confirm parity:
   ```sql
   SELECT message FROM sensor_readings
    WHERE sensor_name = 'tracker.parity_aftership_vs_easypost'
      AND created_at > now() - interval '30 days'
    ORDER BY created_at DESC LIMIT 30;
   ```
   Every reading should show `aftership_only=0`.

2. Stop registering new shipments with AfterShip:
   In `src/trigger/tasks/post-label-purchase.ts`, remove the
   `tasks.trigger("aftership-register", ...)` block.

3. Disable the AfterShip webhook:
   In `src/app/api/webhooks/aftership/route.ts`, change to return 410 Gone
   (log incoming for 14 days then delete).

4. Cancel AfterShip subscription, rotate keys, delete:
   - `src/lib/clients/aftership-client.ts`
   - `src/trigger/tasks/aftership-register.ts`
   - `AFTERSHIP_API_KEY` + `AFTERSHIP_WEBHOOK_SECRET` from `.env.example` + `env.ts`

## Architecture map (Phase 7.2 will expand)

See the canonical plan doc + the per-phase retrospectives for full detail:
`/Users/tomabbs/.cursor/plans/unified_shipping_workflow_a8ac6c94.plan.md`
