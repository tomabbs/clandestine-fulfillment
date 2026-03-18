# Clandestine Fulfillment - Full Technical Audit

Date: 2026-03-18
Audited by: Cursor coding agent
Repository: `clandestine-fulfillment`

## 1) Executive Snapshot

This is a substantial and mostly wired Next.js + Supabase warehouse app with two portals:
- Staff portal: `/admin/*`
- Client portal: `/portal/*`

The system is built around:
- Next.js App Router UI
- Server Actions for app reads/mutations
- Supabase Postgres/Auth as system of record
- Trigger.dev tasks for async/background workflows
- Webhook route handlers for external event intake

Current health from direct command execution:
- `pnpm check`: pass
- `pnpm typecheck`: pass
- `pnpm test` (Vitest): pass (`53` files, `466` tests)
- `pnpm test:e2e`: did not complete in this environment (appears to hang during Playwright run)

Top-level conclusion:
- Core platform is functionally connected across frontend, actions, DB, and tasks.
- Major remaining gap is hardcoded single-workspace assumptions in multiple runtime paths.
- Operational quality is good for unit testing, but CI orchestration is missing.

## 2) Tech Stack and Runtime Building Blocks

## Framework and language
- Next.js `14.2.x` + React `18`
- TypeScript `5.9.x`
- App Router architecture

## UI and state
- Tailwind CSS + shadcn/ui style system
- React Query (`@tanstack/react-query`) for data fetching patterns
- Zustand present for local state management

## Data and auth
- Supabase (Postgres + Auth + Storage)
- Supabase auth used by middleware and auth callback flow
- DB schema managed via SQL migrations in `supabase/migrations`

## Background/async and integrations
- Trigger.dev v4 for asynchronous workflows and schedules
- External systems integrated: Shopify, ShipStation, AfterShip, Stripe, Bandcamp, Resend
- Upstash Redis used as inventory projection/cache layer

## Quality/observability
- Biome for lint/format checks
- Vitest for unit/contract tests
- Playwright for E2E tests
- Sentry instrumentation files present (client/server/edge/instrumentation)

## 3) Repository Technical Map

## Root map
- `src/` - application source
- `tests/` - unit, contract, and E2E tests
- `supabase/migrations/` - schema and policy evolution
- `docs/` - deployment and runbook documentation
- `scripts/` - CI guard scripts

## App route map
- `src/app/(auth)/` - login + callback routing
- `src/app/admin/` - staff-facing pages
- `src/app/portal/` - client-facing pages
- `src/app/api/` - health + webhook route handlers

## Business logic map
- `src/actions/` - Server Actions (domain modules)
- `src/trigger/tasks/` - async/background tasks
- `src/lib/clients/` - external API client wrappers
- `src/lib/server/` - server-only helpers/utilities
- `src/lib/shared/` - constants/env/types/common utilities

## 4) Authentication and Access Wiring

Auth/role gating is wired through `middleware.ts`:
- Public paths:
  - `/login`
  - `/auth/callback`
  - `/api/health`
  - `/api/webhooks/*`
- Protected paths:
  - `/admin/*` requires staff role
  - `/portal/*` requires client role

Role source is centralized in `src/lib/shared/constants.ts`:
- Staff: `admin`, `super_admin`, `label_staff`, `label_management`, `warehouse_manager`
- Client: `client`, `client_admin`

Auth callback route:
- `src/app/(auth)/auth/callback/route.ts`
- Exchanges Supabase auth code, reads user profile role, redirects to `/admin` or `/portal`

## 5) API and Webhook Surface (HTTP Routes)

Route handlers found:
- `GET /api/health` -> `src/app/api/health/route.ts`
- `POST /api/webhooks/aftership` -> `src/app/api/webhooks/aftership/route.ts`
- `POST /api/webhooks/client-store` -> `src/app/api/webhooks/client-store/route.ts`
- `POST /api/webhooks/resend-inbound` -> `src/app/api/webhooks/resend-inbound/route.ts`
- `POST /api/webhooks/shipstation` -> `src/app/api/webhooks/shipstation/route.ts`
- `POST /api/webhooks/stripe` -> `src/app/api/webhooks/stripe/route.ts`
- `GET /auth/callback` -> `src/app/(auth)/auth/callback/route.ts`

Important pattern:
- App business logic is not built as REST APIs.
- Most application data/mutations are wired through Next.js Server Actions (`src/actions/*`).
- `/api/*` is mostly for health and webhook ingress.

## Webhook security and dedup status
- Webhook handlers use raw body reading helper (`readWebhookBody`) for signature checks.
- Signature verification is implemented per platform headers/secrets.
- `webhook_events` insert-based deduping pattern is implemented in handlers (e.g., ShipStation, Stripe).

## 6) Frontend -> Action Wiring Map

Below reflects page-level action-module wiring (import-level map).

## Admin portal (`/admin`)
- `/admin` -> `admin-dashboard`, `preorders`
- `/admin/inventory` -> `inventory`
- `/admin/inbound` -> `inbound`
- `/admin/inbound/[id]` -> `inbound`
- `/admin/orders` -> `orders`
- `/admin/shipping` -> `shipping`
- `/admin/shipping/pirate-ship` -> `pirate-ship`
- `/admin/catalog` -> `catalog`
- `/admin/catalog/[id]` -> `catalog`
- `/admin/clients` -> `clients`
- `/admin/clients/[id]` -> `clients`
- `/admin/billing` -> `billing`
- `/admin/channels` -> `shopify`
- `/admin/review-queue` -> `review-queue`
- `/admin/scan` -> `scanning`
- `/admin/support` -> `support`
- `/admin/settings` -> `admin-settings`
- `/admin/settings/health` -> `admin-settings`
- `/admin/settings/integrations` -> `admin-settings`
- `/admin/settings/bandcamp` -> `bandcamp`
- `/admin/settings/store-mapping` -> `store-mapping`
- `/admin/settings/store-connections` -> `store-connections`

## Client portal (`/portal`)
- `/portal` -> `portal-dashboard`
- `/portal/inventory` -> `inventory`
- `/portal/inbound` -> `inbound`
- `/portal/inbound/new` -> `inbound`
- `/portal/orders` -> `orders`
- `/portal/shipping` -> `orders`
- `/portal/sales` -> `portal-sales`
- `/portal/releases` -> `catalog`
- `/portal/billing` -> `billing`
- `/portal/support` -> `support`
- `/portal/settings` -> `portal-settings`, `client-store-credentials`

Assessment:
- Wiring coverage between pages and domain action modules is broad and consistent.
- No obvious major portal area is disconnected from backend action modules.

## 7) Async/Background Wiring (Trigger Tasks)

Task registry in `src/trigger/tasks/index.ts` exports a broad set of operational tasks:
- Ingestion/sync: Shopify syncs, ShipStation polling/ingest, client-store webhook processing
- Inventory propagation: multi-store push, Redis backfill, sensor checks
- Commerce/integrations: Bandcamp sync/poll/push, AfterShip register
- Operations: monthly billing, storage calc, support escalation
- Fulfillment flows: preorder setup/fulfillment, inbound processing, Pirate Ship import

Assessment:
- Async architecture is mature and designed for non-trivial operational workflows.
- The task surface suggests production intent rather than prototype-only code.

## 8) Data Layer and Schema Status

Migrations present (`11` files):
- `core`, `products`, `inventory`, `orders`, `supporting`, `inbound`, `bandcamp`, `monitoring`, `rls`, `support`, `store_connections`

Data architecture pattern:
- Postgres is source of truth
- Redis is projection/cache for inventory shape
- RLS and role-based access are part of schema strategy

Assessment:
- DB domain modeling appears comprehensive for warehouse + order + billing + support + integrations.

## 9) What Is Finished vs Not Finished

## Finished / strongly implemented
- Dual-portal route architecture (`/admin`, `/portal`)
- Role-aware middleware and auth callback redirection
- Broad action coverage across major product domains
- Webhook ingress endpoints for major external integrations
- Trigger task framework with many production-style tasks
- Lint/type/unit test suite passing locally

## Partially implemented / in-progress markers
- Multi-workspace: many files still hardcode:
  - `WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"`
  - found in multiple Trigger tasks and `src/actions/shopify.ts`
- Admin billing page includes stub workspace context comment
- Scan flow includes placeholder location assignment comment
- Portal settings includes "coming soon" notification preferences placeholder
- Shipment ingest has placeholder org fallback for unmatched events
- Env schema still allows default blank ShipStation webhook secret

## Connected but externally dependent
- Webhook handlers are connected in code but depend on real external secrets/config in environment.
- Integrations are wired, but production readiness depends on valid credential provisioning and endpoint registration.

## 10) Integration Connectivity Matrix

## Clearly connected in code
- Supabase: auth + DB usage throughout actions/middleware/routes
- Trigger.dev: task triggering and task registry present
- Shopify: clients + sync/order task paths + admin channels controls
- ShipStation: webhook + polling/ingest + mapping pages/actions
- Stripe: webhook + billing snapshot status handling
- Bandcamp: settings, sync tasks, inventory push/poll tasks
- Resend: support-related integration + inbound webhook
- Upstash Redis: inventory-related logic paths

## Likely not fully complete end-to-end yet
- Multi-tenant workspace scoping across all jobs/actions
- Some portal UX pieces explicitly marked as placeholders
- Full production CI/CD enforcement (see testing/CI section)

## 11) Testing and Audit Status

Executed commands and outcomes:
- `pnpm check` -> pass
- `pnpm typecheck` -> pass
- `pnpm test` -> pass
  - `53` test files
  - `466` tests passing
- `pnpm test:e2e` -> started but did not complete in this environment

Test suite inventory:
- Unit + contract coverage is extensive under `tests/unit` and `tests/contract`
- Playwright specs exist (`4`):
  - `client-navigation.spec.ts`
  - `inbound-flow.spec.ts`
  - `inventory-flow.spec.ts`
  - `staff-navigation.spec.ts`

Quality gaps:
- No `.github/workflows` directory found, so automated CI orchestration appears absent.
- Guard scripts exist in `scripts/` but are not currently evidenced as wired into CI.

## 12) Risks and Technical Debt (Prioritized)

## High
- Multi-workspace hardcoding in runtime logic can cause tenant isolation and scalability issues.
- Missing CI workflow means pass/fail quality gates rely on manual execution.
- E2E execution reliability is currently unknown from this environment due to hanging run.

## Medium
- Placeholder/coming-soon areas in portal/admin UX indicate incomplete user workflows.
- ShipStation webhook secret default allows misconfiguration risk until strictly required.
- Placeholder org fallback in shipment ingest may mask mapping/identity issues.

## Lower
- Node warning during Vitest (`--localstorage-file` without valid path) should be cleaned up for signal-to-noise.

## 13) Recommended Full Audit/Test Campaign

## Phase 1 - Baseline hard evidence
- Run in clean environment with seeded test data:
  - `pnpm check`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `pnpm test:e2e` (headless + trace)
- Capture artifacts and failure logs per suite.

## Phase 2 - Wiring validation
- For each integration (Shopify, ShipStation, Stripe, Bandcamp, Resend, AfterShip):
  - Validate secret presence and format
  - Replay signed webhook samples
  - Confirm dedup behavior and async task handoff

## Phase 3 - Data correctness audit
- Verify inventory invariants:
  - Postgres truth consistency
  - Redis projection consistency
  - Reconciliation/backfill behavior
- Validate billing snapshot immutability and adjustment paths.

## Phase 4 - Completion closeout
- Eliminate hardcoded workspace IDs with auth/context-driven workspace scoping.
- Replace known placeholders with production implementations.
- Add CI workflows for lint/type/test/build and guard scripts.

## 14) Immediate Action Items (Practical)

1. Create CI workflow (`.github/workflows/ci.yml`) running lint, typecheck, unit tests, and guard scripts.
2. Finish multi-workspace refactor (remove hardcoded workspace IDs in tasks/actions/pages).
3. Resolve placeholders:
   - scan location lookup
   - portal notification preferences
   - unmatched-shipment org handling strategy
4. Make ShipStation webhook secret mandatory in production env validation.
5. Stabilize and document E2E environment setup so Playwright can run reliably in automation.

## 15) Final Readiness Assessment

Current maturity is "advanced MVP / near-production core":
- Architecture and code surface are broad, coherent, and strongly wired.
- Core quality gates (lint/type/unit) are healthy.
- Main blockers to full production confidence are operational hardening:
  - CI enforcement
  - multi-workspace completion
  - completion of placeholder workflows
  - stable E2E execution in CI

