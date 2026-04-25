# Release Slices — Tracking & Notification Hardening

This document is the operational manifest for splitting the tracking-notification
hardening work into the four sequential PRs described in
`docs/prompt-packs/PLAN.md` → "Release Slices (4-PR rollout, v4 decision)".

It maps every concrete file in the working tree to exactly one of the four
slices so an operator (or a follow-up agent) can physically separate the work
into per-slice branches without re-deriving the boundary.

> Status at the time of writing: All slice work is staged on the working tree
> against `main`. No commits have been authored. Splitting into per-slice
> branches and PRs is the next operator action.

## Sequencing rules (do not break)

1. Slices ship in order. Slice N+1 cannot deploy before Slice N has soaked in
   production for ≥24h.
2. Each slice contains its own migration, code, and tests. The release gate
   (`scripts/release-gate.sh`) must be green per slice.
3. Per Rule #51, the sidebar nav entry that exposes
   `/admin/operations/notifications` is added in a separate manual pass after
   Slice 4 merge — not inside the Slice 4 worktree.
4. Pre-flight: before any slice that touches `notification_sends.status`, run
   `pnpm ops:check-webhook-secrets` (Slice 1 dependency) and the duplicate-row
   detector embedded in the Slice 2 migration.

## Slice 1 — Webhook security + provider ledger

Purpose: Make EasyPost and Resend webhook ingest fail-closed in production,
add the append-only provider event ledger, and ship the preflight script.

### New files

- `supabase/migrations/20260425000004_slice1_notification_provider_events.sql`
- `src/lib/server/notification-provider-events.ts`
- `scripts/check-webhook-secrets.ts`
- `tests/unit/lib/server/notification-provider-events.test.ts`
- `tests/unit/scripts/check-webhook-secrets.test.ts`
- `tests/unit/api/webhooks/easypost-route.test.ts`
- `tests/unit/api/webhooks/resend-route.test.ts`

### Modified files

- `src/lib/server/easypost-webhook-signature.ts` — current EasyPost v2 spec,
  dual-secret rotation, RFC 2822 timestamps, `x-path` normalization, generic
  401 body.
- `src/lib/server/resend-webhook-signature.ts` — Svix dual-secret rotation.
- `src/app/api/webhooks/easypost/route.ts` — fail-closed in production,
  signature verification, `signature_failed` `webhook_event` insert path,
  provider-event ledger insert before any rollup.
- `src/app/api/webhooks/resend/route.ts` — same shape; the slice-2 status
  rollup additions in this file MUST be carved out into Slice 2 (see "Cross-
  slice file split" below).
- `src/lib/shared/env.ts` — `EASYPOST_WEBHOOK_SECRET_PREVIOUS`,
  `RESEND_WEBHOOK_SECRET_PREVIOUS`, `EASYPOST_WEBHOOK_REQUIRE_SIGNATURE`.
- `tests/unit/server/easypost-webhook-signature.test.ts`
- `tests/unit/server/resend-webhook-signature.test.ts`
- `package.json` — `ops:check-webhook-secrets` script entry.
- `scripts/release-gate.sh` — invokes the preflight as a release gate.

### Validation

- Signed test webhook with current AND previous secret both verify.
- Invalid signature returns generic 401 + writes `signature_failed` row.
- Duplicate webhook returns fast 200 with no downstream work.
- Resend signed test event creates a `notification_provider_events` row
  before any `notification_sends` rollup write.

### Rollback

Re-deploy previous commit. New table is additive and unused by other code
until Slice 2.

---

## Slice 2 — Notification idempotency + state machine

Purpose: Centralize all `notification_sends.status` writes through a
PostgreSQL state machine, widen the status enum, and ship the
`send-tracking-email` 4-step ordering.

### New files

- `supabase/migrations/20260425000005_slice2_notification_state_machine.sql`
  (also creates `notification_operator_events` — see "Migration ordering
  caveat" below).
- `src/lib/server/notification-status.ts`
- `scripts/check-notification-status-writes.sh`
- `tests/unit/lib/server/notification-status.test.ts`
- `tests/unit/lib/server/notification-sends.test.ts`
- `tests/unit/scripts/check-notification-status-writes.test.ts`

### Modified files

- `src/lib/server/notification-sends.ts` — `findPriorActiveSend`,
  `findNotificationSendByMessageId`, extended `recordSend` for `pending`,
  status set helpers.
- `src/lib/clients/resend-client.ts` — `idempotencyKey`, `replyTo`,
  `sanitizeTagValue`, `ResendSendError` classification.
- `src/trigger/tasks/send-tracking-email.ts` — 4-step ordering: pre-check,
  insert `pending`, call Resend, transition status via wrapper.
- `src/app/api/webhooks/resend/route.ts` — Resend event mapping
  (sent / delivered / delivery_delayed / bounced / complained / failed /
  suppressed) routed through the wrapper. The HMAC + provider-ledger writes
  in this file belong to Slice 1; the rollup mapping is the Slice 2 carve.
- `tests/unit/lib/resend-client.test.ts`

### Cross-slice file split (Slice 1 ↔ Slice 2)

`src/app/api/webhooks/resend/route.ts` and `src/app/api/webhooks/easypost/route.ts`
each contain both Slice 1 (signature, dedup, provider-ledger) and Slice 2
(status rollup) changes in the same file diff. Operator splitting strategy:

- Slice 1 PR ships the signature/dedup/ledger lines and leaves rollup
  references behind a `noop` or unchanged mapping.
- Slice 2 PR ships the rollup mapping switch wired through
  `updateNotificationStatusSafe`.
- If splitting cleanly is impractical, ship the Slice 1 hardened skeleton
  with a `// TODO(slice-2)` marker and only enable the rollup wiring in
  Slice 2 — never collapse them into a single PR.

### Migration ordering caveat

`notification_operator_events` is needed by the Slice 4 retry/cancel server
actions but is created in the Slice 2 migration so that all
`notification_sends`-adjacent schema work lands together. The table is
created RLS-locked with no INSERT path until Slice 4 introduces the server
action. This is intentional and documented here so the Slice 4 reviewer is
not surprised.

### Validation

- Trigger `send-tracking-email` shadow mode → exactly one `pending` row →
  exactly one `sent` row after Resend ack.
- Replay all six Resend event types → status precedence holds, terminal
  states sticky, lifecycle timestamps populate.
- Concurrent insert test → exactly one row.
- Grep guard `bash scripts/check-notification-status-writes.sh` exits 0
  against `src/`.

### Rollback

Wrapper module routes through new RPCs; rollback restores prior code paths.
Schema columns/indexes are additive.

---

## Slice 3 — Tracking persistence + public page hardening

Purpose: Persist public-safe destination + tracker metadata on
`warehouse_shipments`, add `provider_event_id` dedup column on
`warehouse_tracking_events`, and rewrite the customer tracking page to
consume only an allowlist type.

### New files

- `supabase/migrations/20260425000006_slice3_tracking_persistence.sql`
- `src/app/track/[token]/types.ts` — `PublicTrackingShipment` allowlist type.

### Modified files

- `src/lib/shared/public-track-token.ts` — `pickPublicDestination`
  PII-allowlist helper.
- `src/lib/shared/carrier-tracking-urls.ts` — `buildCarrierTrackingUrl`
  extension for absent tracker URLs.
- `src/lib/shared/tracking-email-templates.ts` — `safeTrackingUrl`,
  `sanitizeBrandColor`, `sanitizeImageUrl`, `sanitizeCarrierMessage`,
  exception copy.
- `src/app/track/[token]/page.tsx` — consumes `PublicTrackingShipment` only.
- `src/trigger/tasks/easypost-register-tracker.ts` — write public-safe
  destination + tracker columns at registration time.
- `src/trigger/tasks/create-shipping-label.ts` — same persistence path on
  label creation.
- `src/trigger/tasks/bulk-buy-labels.ts` — same persistence path on bulk
  label flow.
- `tests/unit/lib/public-track-token.test.ts`
- `tests/unit/lib/carrier-tracking-urls.test.ts`
- `tests/unit/lib/tracking-email-templates.test.ts`

### Validation

- Load `/track/[token]` for sparse and full shipments → no PII leakage.
- CHECK `chk_destination_city_no_street` rejects street-prefixed city
  strings.
- 50-row sample audit on the destination backfill passes.

### Rollback

Public page falls back to `label_data` allowlist read for one deploy window
if backfill incomplete. CHECK constraint can be dropped without affecting
write paths.

---

## Slice 4 — Ops visibility (sensor + page + drilldown + view-as-customer)

Purpose: Ship the staff-facing notification ops surface, the failure sensor,
the per-shipment audit drilldown, and the "view customer tracking page"
links.

### New files

- `src/trigger/tasks/notification-failure-sensor.ts`
- `src/actions/notification-operations.ts`
- `src/app/admin/operations/notifications/page.tsx`
- `src/components/admin/shipment-notification-log.tsx`
- `tests/unit/actions/notification-operations.test.ts`
- `tests/unit/trigger/send-tracking-email-recon.test.ts`

### Modified files

- `src/trigger/tasks/send-tracking-email-recon.ts` — fix per-workspace
  attribution (Map accumulation, no global rollup).
- `src/trigger/tasks/index.ts` — register
  `notification-failure-sensor` (and any new ops tasks).
- `src/app/admin/orders/_components/orders-cockpit.tsx` — `<ShipmentNotificationLog>`
  drawer mount + "View customer tracking page" link.
- `src/app/admin/shipping/page.tsx` — "View customer tracking page" link.
- `src/components/admin/admin-sidebar.tsx` — DO NOT include in Slice 4 PR
  (Rule #51). Operator adds this in a manual post-merge pass.

### Out-of-band manual pass (post-Slice-4 merge)

- Add `/admin/operations/notifications` entry to
  `src/components/admin/admin-sidebar.tsx` under the Operations section.
- Configure Slack incoming webhook for signature failure spike alerts (>10/hr)
  and wire to `notification-failure-sensor` output channel.

### Validation

- Replay invalid signatures → sensor fires + Slack alert.
- Stuck pending row appears on ops page within 15 min sensor cadence.
- Retry re-enqueues the same row + writes operator event.
- Cancel flips to `cancelled` + writes operator event.
- Per-shipment drilldown renders merged time-ordered ledger.
- Admin "view customer" URL byte-equals what `send-tracking-email` writes.

### Rollback

Page is staff-only — feature-flag the route to gated-off if needed.
Underlying data remains intact across rollback.

---

## Files NOT in any tracking-notification slice

The following modified/untracked files in the working tree are unrelated to
this plan and must NOT be bundled into any of the four slice PRs. They
belong to other workstreams (Bandcamp apparel, SKU matching, store-connection
hardening, manual inventory counts, etc.) and should be split into their own
PRs:

- `src/actions/manual-inventory-count.ts`
- `src/actions/shipstation-orders.ts`
- `src/actions/sku-matching.ts`
- `src/app/admin/orders-legacy/_legacy-orders-view.tsx`
- `src/app/admin/orders/[id]/packing-slip/page.tsx`
- `src/app/admin/orders/_components/bulk-buy-labels-modal.tsx`
- `src/app/admin/orders/_components/scan-to-verify-modal.tsx`
- `src/app/admin/settings/feature-flags/_feature-flags-form.tsx`
- `src/app/admin/settings/store-connections/store-connections-client.tsx`
- `src/app/admin/settings/sku-matching/`
- `src/components/admin/client-store-webhook-health-card.tsx`
- `src/lib/clients/billing-calculator.ts`
- `src/lib/clients/shopify-client.ts`
- `src/lib/clients/store-sync-client.ts`
- `src/lib/server/bundles.ts`
- `src/lib/server/shopify-fulfillment.ts`
- `src/lib/server/sku-matching-monitor.ts`
- `src/lib/server/workspace-flags.ts`
- `src/lib/shared/query-keys.ts`
- `src/lib/shared/sanitize-buyer-text.ts`
- `src/lib/shared/types.ts`
- `src/trigger/tasks/bandcamp-inventory-push.ts`
- `src/trigger/tasks/bandcamp-sync.ts`
- `src/trigger/tasks/ramp-halt-criteria-sensor.ts`
- `src/trigger/tasks/sku-matching-monitor.ts`
- `src/trigger/tasks/unified-shipping-sensors.ts`
- `scripts/_phase3-*.ts`
- `scripts/audit-sku-mapping-duplicates.{sql,ts}`
- `scripts/remediate-sku-mapping-duplicates.ts`
- `supabase/migrations/20260425000002_sku_matching_provenance.sql`
- `supabase/migrations/20260425000003_sku_matching_monitoring.sql`
- `tests/integration/tenant-isolation.test.ts`
- `tests/unit/actions/store-connections.test.ts`
- `tests/unit/lib/billing-rates.test.ts`
- `tests/unit/lib/clients/shipstation-inventory-v2.test.ts`
- `tests/unit/lib/packing-slip-data.test.ts`
- `tests/unit/lib/server/shipment-fulfillment-cost.test.ts`
- `tests/unit/lib/server/sku-matching-monitor.test.ts`
- `tests/unit/lib/server/sku-matching.test.ts`
- `tests/unit/trigger/preorder-tab-refresh.test.ts`
- `tests/unit/trigger/shipstation-mark-shipped.test.ts`

The truth-doc files (`TRUTH_LAYER.md`, `docs/system_map/API_CATALOG.md`,
`docs/system_map/TRIGGER_TASK_CATALOG.md`, `project_state/engineering_map.yaml`,
`project_state/journeys.yaml`, `docs/RELEASE_GATE_CRITERIA.md`) are touched by
the doc-sync pass that follows this plan and are split per-slice in that pass:

- Slice 1 doc updates: API catalog (webhook routes), engineering map (provider
  events table).
- Slice 2 doc updates: API catalog (status wrapper), engineering map (state
  machine + new columns), journeys (notification lifecycle).
- Slice 3 doc updates: engineering map (tracking columns + CHECK), journeys
  (public page render contract).
- Slice 4 doc updates: TRIGGER_TASK_CATALOG (failure sensor), API catalog
  (server actions), engineering map (operator events), RELEASE_GATE_CRITERIA
  (per-slice gates).

## Recommended branch + PR commands (per slice)

For each slice, repeat the following pattern:

```bash
git checkout main
git pull --ff-only origin main
git checkout -b feat/slice-N-tracking-notification

# stage only the files listed under this slice
git add <files for slice N>

git commit -m "feat(notifications): slice N — <slice purpose>"

# verify the slice in isolation
pnpm check
pnpm typecheck
pnpm test

git push -u origin HEAD
gh pr create --title "feat(notifications): slice N — <slice purpose>" --body "$(cat <<'EOF'
## Summary
<one-paragraph slice purpose>

## Validation
<copy from this manifest>

## Rollback
<copy from this manifest>

## Cross-slice notes
<if slice 1 or slice 2: include the cross-slice file-split note from this manifest>
EOF
)"
```

After PR N merges and the 24h soak completes per `docs/RELEASE_GATE_CRITERIA.md`,
proceed to PR N+1.
