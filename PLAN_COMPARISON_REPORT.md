# Clandestine Fulfillment - Plan Compliance Report

Date: 2026-03-18
Compared against:
- `CLANDESTINE_FULFILLMENT_PART1_FINAL.md`
- `CLANDESTINE_FULFILLMENT_PART2_FINAL.md`
- `CLANDESTINE_FULFILLMENT_BUILD_GUIDE.md`
- `CLANDESTINE_FULFILLMENT_SETUP_GUIDE.md`

## Scope and method

This report compares the current codebase state to the planning docs. It uses:
- direct source inspection
- route/action/task inventory
- migration inventory
- actual quality/test command execution

Executed checks in current repo:
- `pnpm check` -> pass
- `pnpm typecheck` -> pass
- `pnpm test` -> pass (`53` files, `466` tests)
- `bash scripts/ci-inventory-guard.sh` -> pass
- `bash scripts/ci-webhook-dedup-guard.sh` -> pass
- `pnpm test:e2e` -> did not complete in this environment (hang)

---

## 1) High-level status

## Overall progress against plan
- **Core architecture:** mostly implemented
- **Primary staff/client portals:** implemented with broad coverage
- **Server Actions + task-driven backend:** implemented
- **Webhook surface:** mostly implemented, with one major planned endpoint missing
- **Database model:** implemented (11 migrations present, plan described 10 + store-connection expansion)
- **Quality baseline:** strong for lint/type/unit tests
- **Production-readiness hardening:** not complete

---

## 2) What is done (aligned with plan)

## Foundation and stack (Part 1 + Build Guide)
- Next.js App Router + TypeScript + Tailwind + Supabase + Trigger.dev + Upstash + Sentry stack is present.
- `CLAUDE.md` exists and contains the project ruleset.
- Core owner files from Build Guide rules exist:
  - `src/lib/shared/env.ts`
  - `src/lib/shared/constants.ts`
  - `src/lib/server/record-inventory-change.ts`
  - `src/lib/server/webhook-body.ts`
  - `src/trigger/lib/bandcamp-queue.ts`
  - `src/trigger/tasks/index.ts`
  - `src/actions/client-store-credentials.ts`

## Auth and role model (Part 1/2)
- Middleware route protection exists for `/admin/*` and `/portal/*`.
- Public routes include `/login`, `/auth/callback`, `/api/health`, and webhook routes.
- Auth callback route is implemented.
- Staff/client role constants are centralized in `src/lib/shared/constants.ts`.

## Data architecture (Part 1/2)
- Full migration set exists in `supabase/migrations` with warehouse, support, monitoring, RLS, and store-connection domains.
- Multi-domain schema surface matches intended architecture (products/inventory/orders/inbound/billing/support/store connections).

## Application wiring (Part 1/2)
- Staff route areas are implemented: dashboard, scan, inventory, inbound, orders, catalog, clients, shipping, billing, channels, review queue, support, settings.
- Client route areas are implemented: dashboard, inventory, releases, inbound, orders, shipping, sales, billing, support, settings.
- Server Action modules are broad and aligned with intended domains (`22` action modules).
- Companion test rule is met: `22` action files / `22` matching unit tests.

## Integrations and async jobs (Part 2 + Build Guide)
- Trigger task surface is substantial and includes key planned tasks like:
  - `shopify-sync`, `shopify-full-backfill`
  - `shipment-ingest`, `shipstation-poll`
  - `aftership-register`
  - `monthly-billing`, `storage-calc`
  - `bandcamp-sync`, `bandcamp-inventory-push`, `bandcamp-sale-poll`
  - `multi-store-inventory-push`, `client-store-order-detect`
  - `redis-backfill`, `sensor-check`, `support-escalation`
- Webhook handlers implemented for:
  - ShipStation
  - AfterShip
  - Stripe
  - Resend inbound
  - Client-store (multi-platform entrypoint)

## Test and guardrail baseline (Build Guide audit gates)
- Contract tests exist:
  - `tests/contract/billing-rpc.test.ts`
  - `tests/contract/product-set.test.ts`
- Guard scripts exist and pass.
- Unit/contract suite currently passes.

---

## 3) What is not done (or not aligned)

## Critical gaps vs plan
1. **Missing Shopify webhook route handler**
   - Plan expects `app/api/webhooks/shopify/route.ts`.
   - Current webhook directories: `aftership`, `client-store`, `resend-inbound`, `shipstation`, `stripe`.

2. **Missing async Shopify webhook processor task**
   - Plan expects `process-shopify-webhook` task (Build Guide + Part 2 task list).
   - Current task list does not include `process-shopify-webhook.ts`.

3. **No CI workflow wiring**
   - Build Guide assumes repeated audit gates in automation.
   - Current repo has no `.github/workflows` directory.
   - Guard scripts exist but are not wired in CI.

4. **Multi-workspace still hardcoded in runtime paths**
   - Multiple tasks/actions still use hardcoded `WORKSPACE_ID` constants.
   - This conflicts with plan intent for robust tenant/workspace context handling.

## Significant partials
5. **E2E readiness incomplete in current environment**
   - `pnpm test:e2e` did not complete (hang).
   - Wave/Audit gate expectations require stable Playwright execution.

6. **Truth layer implementation is partial**
   - `sensor-check` task exists.
   - But `scripts/truth-sensors` is absent, and smoke suite wiring appears incomplete.
   - Plan expects broader sensor runner set and truth-run orchestration.

7. **Planned route granularity differs from implemented route shape**
   - Plan specifies many nested subroutes (for example `/admin/orders/*`, `/admin/billing/*`, `/admin/settings/bandcamp-accounts`).
   - Current app often consolidates these as tabbed/sectioned single pages (for example `/admin/orders`, `/admin/billing`, `/admin/settings/bandcamp`).
   - Functional intent may be present, but route-level parity is not exact.

8. **Known placeholders remain in product UX/ops**
   - Portal settings: notification preferences marked "coming soon".
   - Scan workflow: placeholder location assignment noted in code comments.
   - Billing page: workspace context stub comment.

## Possible naming/spec drift
9. **Some planned task names differ from implementation**
   - Plan names include `shopify-product-update` and `process-shopify-webhook`.
   - Current task set includes adjacent capabilities but not exact name parity for all planned tasks.

---

## 4) Setup Guide compliance (can and cannot be verified from code)

## Verifiable in code
- Env schema (`src/lib/shared/env.ts`) covers major required variables from Setup Guide.
- Pooled DB URL pattern (`DATABASE_URL` + `DIRECT_URL`) is represented in expected env structure.

## Not verifiable from repository alone
- External account provisioning and configuration:
  - Supabase project/provider setup
  - Trigger.dev environments
  - Vercel env dashboard values
  - Upstash/Sentry/Resend live connectivity
  - Shopify scope confirmation in live app
  - DNS/MX/webhook endpoint registration

Status for these should be treated as **unknown** until validated with runtime checks in deployed/staging environments.

---

## 5) What needs to be done to meet plan guidelines

## P0 (do first)
1. Add `src/app/api/webhooks/shopify/route.ts` with:
   - raw body signature verification
   - dedup insert into `webhook_events`
   - quick ack behavior
   - async handoff to a Trigger task

2. Add `src/trigger/tasks/process-shopify-webhook.ts` and wire from route.

3. Implement CI pipeline:
   - `pnpm check`
   - `pnpm typecheck`
   - `pnpm test`
   - contract tests
   - guard scripts
   - optionally `pnpm build` and Playwright job

4. Remove hardcoded `WORKSPACE_ID` paths and source workspace from authenticated/runtime context.

## P1 (close major plan deltas)
5. Stabilize Playwright execution and make `pnpm test:e2e` reliably pass in CI.
6. Complete truth-layer runner scripts (`scripts/truth-sensors/*`, truth entrypoint) if strict plan compliance is required.
7. Replace remaining placeholders:
   - portal notification preferences
   - scan location lookup
   - billing workspace stub path

## P2 (alignment/polish)
8. Decide whether to keep consolidated route design or add planned subroutes for strict route parity.
9. Confirm all planned operational controls are surfaced (integration health states, review workflow completeness, onboarding checklist consistency).
10. Validate setup guide externally (live API checks, scopes, webhooks, DNS, inbound email).

---

## 6) Practical readiness verdict

The implementation is **substantially complete** versus the architecture and feature vision, but it is **not yet fully compliant** with the planning guidelines due to a few high-impact gaps:
- missing Shopify webhook ingestion path,
- missing async Shopify webhook processor task,
- missing CI automation,
- remaining single-workspace hardcoding,
- incomplete truth-layer/Playwright operational hardening.

Once P0 is complete, the project will be much closer to full guideline compliance and production-grade confidence.

