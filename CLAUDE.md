# Clandestine Fulfillment

3PL warehouse management app for independent record labels.
Staff portal (/admin/*) + Client portal (/portal/*).

## Tech Stack
- Next.js 14+ App Router, TypeScript, Tailwind, shadcn/ui
- Supabase (Postgres + Auth + Realtime + Storage)
- Trigger.dev v4 for background jobs
- Upstash Redis for real-time inventory ledger
- Biome for linting/formatting (NOT ESLint/Prettier)
- Vitest for unit tests, Playwright for E2E tests
- Sentry for error monitoring
- Zod for all runtime validation

## Commands
- `pnpm dev` — start dev server
- `pnpm build` — production build
- `pnpm test` — run Vitest unit tests
- `pnpm test:e2e` — run Playwright E2E tests
- `pnpm check` — run Biome lint + format check
- `pnpm check:fix` — auto-fix Biome issues
- `pnpm typecheck` — run tsc --noEmit

## File Structure
```
src/
  app/
    (auth)/          # Login pages (no nav shell)
    admin/           # Staff portal pages
    portal/          # Client portal pages
    api/webhooks/    # Route Handlers (webhooks ONLY)
  components/
    ui/              # shadcn/ui components
    admin/           # Staff-specific components
    portal/          # Client-specific components
    shared/          # Components used by both
  lib/
    clients/         # External API clients (shopify, bandcamp, shipstation, etc.)
    server/          # Server-only utils (supabase-server, auth-helpers)
    shared/          # Shared utils (types, constants, zod schemas)
    hooks/           # React hooks (useAppQuery, useAppMutation)
  trigger/
    tasks/           # Trigger.dev task definitions
    lib/             # Shared logic for tasks
  actions/           # Server Actions (one file per domain)
tests/
  unit/              # Vitest unit tests (mirror src/ structure)
  e2e/               # Playwright E2E tests
```

## CRITICAL RULES
1. **Never use productSet for EDITS.** productSet deletes list-field entries not in payload. Use productUpdate + productVariantsBulkUpdate for edits. productSet is for CREATE only with complete payloads.
2. **Trigger.dev v4 ONLY.** Import from `@trigger.dev/sdk` NOT `@trigger.dev/sdk/v3`. Use `catchError` not `handleError`. Queues via `queue()` function.
3. **Biome, not ESLint.** Run `pnpm check:fix` before committing. No eslint config files.
4. **Server Actions for mutations, React Query for reads.** No hand-rolled API routes except webhooks.
5. **Zod for all boundaries.** Form inputs, API responses, webhook payloads, env vars — all validated with Zod.
6. **Every Server Action file MUST have a companion .test.ts file** in tests/unit/actions/.
7. **Supabase service_role for Trigger tasks.** Never use anon key in background jobs.
8. **One Shopify product per SKU.** Bandcamp merch variants become separate Shopify products, NOT Shopify variants.
9. **Bandcamp token serialization.** ALL Bandcamp tasks (`bandcamp-sync`, `bandcamp-inventory-push`, `bandcamp-sale-poll`) must use the **EXACT SAME shared queue instance**: `export const bandcampQueue = queue({ name: "bandcamp-api", concurrencyLimit: 1 });` in a shared file (e.g. `src/trigger/lib/bandcamp-queue.ts`). Setting concurrencyLimit on individual task definitions does NOT prevent them from running simultaneously — only a shared named queue does.
10. **Type exports live in src/lib/shared/types.ts.** All shared types in one place.
11. **Wave 1 output is FROZEN for Wave 2+.** No Wave 2 window modifies types.ts, middleware.ts, supabase-server.ts, layout files, or migration files. If a Wave 2 feature needs a shared primitive changed, flag it for the merge review — do not change it in the worktree.
12. **Trigger task payloads must be IDs only.** Never pass large JSON arrays. Tasks fetch the data they need from Postgres using the IDs passed in the payload.

## Naming
- Server Actions: camelCase verbs (`createInbound`, `resolveReviewItem`)
- Components: PascalCase (`InventoryTable`, `ScanHub`)
- Trigger tasks: kebab-case (`bandcamp-sync`, `monthly-billing`)
- Files: kebab-case (`store-connections.ts`, `billing-calculator.ts`)
- Test files: `{original-name}.test.ts`

## Auth
- Staff: Google OAuth → checks `users.role IN ('admin', 'super_admin', 'label_staff', 'label_management', 'warehouse_manager')`
- Clients: Magic link → RLS via `get_user_org_id()` restricts to own org
- Middleware: `/admin/*` requires staff role (list above), `/portal/*` requires authenticated user with role `client` or `client_admin`

## Database
- 38 tables across 10 migrations
- RLS on all org-scoped tables via `is_staff_user()` and `get_user_org_id()`
- Service role bypasses RLS (for Trigger tasks)
- `warehouse_inventory_levels.org_id` is auto-derived by DB trigger from variant → product → org (DO NOT set manually)
- `support_messages` RLS uses join to `support_conversations.org_id` (no org_id on messages table)
- `client_store_connections` has client SELECT policy (own org only) + service_role for credential writes

## Shopify Safety
13. **productSet requires a "full-shape builder."** Never let individual callers assemble productSet payloads. Use a single function that: loads current Shopify product (variants, media, collections, metafields), merges new data, emits COMPLETE list for every list field. Forgetting a list field = silent data deletion.
14. **Build a productSet contract test suite.** Creates test product → calls wrapper with partial vs full data → asserts variants/media/metafields behave as expected. Run in CI whenever SHOPIFY_API_VERSION bumps.
15. **Idempotency keys must be stable per logical adjustment.** Use `{webhook_id}:{line_item_id}` or `{task_run_id}:{sku}`, NOT random UUID per request. Random UUIDs make retries unsafe.

## Operational Patterns
16. **Billing debug view.** The admin Billing page must include a debug tab showing: which shipments were included in each snapshot, which were excluded and why (already billed, outside period, voided, adjusted). Essential for client dispute resolution.
17. **Webhook silence alerting.** If webhooks for a `client_store_connection` go silent for >6 hours while the backup poller still finds new orders, create a review queue item alerting staff. Likely means webhook URL is broken.
18. **Bandcamp scraper snapshot tests.** Keep saved HTML fixtures from real Bandcamp album pages in `tests/fixtures/`. Scraper unit tests run against these fixtures to catch DOM structure changes immediately, before they hit production.
19. **Client credential submission uses service_role.** The `submitClientStoreCredentials` Server Action writes to `client_store_connections` via service_role client (bypassing staff-only RLS) after validating the authenticated user's org_id matches the target connection.

## Inventory Invariants
20. **Single inventory write path.** ALL inventory changes flow through `recordInventoryChange({ sku, delta, source, correlationId })`. No code path may directly mutate `warehouse_inventory_levels` or Redis inventory keys outside this function. This is the core invariant of the Trunk replacement.
21. **warehouse_inventory_levels.org_id is enforced by DB trigger.** Writers do NOT need to set org_id manually — the `derive_inventory_org_id` trigger auto-populates it from variant → product. The `inv.org_id_drift` sensor is a safety net, not the primary enforcement.
22. **Billing uses Supabase RPC, not JS transactions.** The Trigger task computes totals via `billing-calculator.ts`, then calls `supabase.rpc('persist_billing_snapshot', { p_workspace_id, p_org_id, p_billing_period, p_snapshot_data, p_grand_total, p_total_shipping, p_total_pick_pack, p_total_materials, p_total_storage, p_total_adjustments })`. Supabase `rpc()` requires JS keys to EXACTLY match PL/pgSQL argument names (including the `p_` prefix). Billing math stays in TypeScript; row locking stays in Postgres.

## Webhook Security
23. **Per-platform webhook signature verification.** The `client-store` Route Handler must verify HMAC signatures per platform (Shopify: `X-Shopify-Hmac-SHA256`, WooCommerce: `X-WC-Webhook-Signature`). Never trust `connection_id` query param alone. Add replay protection (reject >5 min old).

## Operational Resilience
24. **Bandcamp scraper failure = review queue item, not crash.** If TralbumData parsing fails: default Type to "Merch", leave street_date blank, flag as "metadata_incomplete" in review queue. Never crash the sync run.
25. **Bandcamp scraper versioned parser.** Keep parser functions versioned (`parseV1`, `parseV2`) with a heuristic to switch. Saves you from emergency deploys when Bandcamp changes DOM.
26. **Scrape health metric on Channels page.** Surface scraper success rate per account as a first-class health indicator, not just a log entry.
27. **Periodic Postgres → Redis backfill.** Schedule a weekly `redis-backfill` task that rebuilds Redis from Postgres truth. Not just startup — scheduled, so drift never accumulates. **Race condition protection:** Before overwriting any Redis key, compare `warehouse_inventory_levels.last_redis_write_at` (set by `recordInventoryChange()` on every write) to the backfill run's start timestamp. If `last_redis_write_at > backfill_started_at`, skip that SKU — a live write happened after the backfill began. Schedule backfills for low-traffic windows (e.g., Tuesday 3 AM EST) to minimize the race window.
28. **Store connection health columns.** `client_store_connections` tracks `last_webhook_at`, `last_poll_at`, `last_error_at`, `last_error` for operational visibility.
29. **Billing snapshot immutability.** Once a `warehouse_billing_snapshots` row is created, its monetary totals and included shipment IDs are immutable. Adjustments are modeled as separate `billing_adjustments` rows, never edits to the snapshot.
30. **Scraper residential proxy contingency.** If Bandcamp blocks Trigger.dev IPs in the first week, route scraper HTTP through a rotating residential proxy (BrightData, Smartproxy). Monitor failure rate before committing.

## System Invariants (enforce via DB constraints, tests, and sensors)
31. **SKU uniqueness per workspace.** Add unique index: `UNIQUE(workspace_id, sku)` on `warehouse_product_variants`. No two active products may share a SKU within a workspace. Violations = hard error → review queue.
32. **Every inventory delta must have a correlation_id.** `warehouse_inventory_activity` requires `source` (enum: shopify, bandcamp, squarespace, woocommerce, shipstation, manual, inbound, preorder, backfill) and `correlation_id` (webhook ID, order ID, task run ID). Add `UNIQUE(sku, correlation_id)` to prevent double-writes from retries.
33. **Redis is a projection, not a source of truth.** Redis must never be treated as authoritative. Postgres is the truth. Redis can be rebuilt from Postgres at any time. Every Redis write must be accompanied by a Postgres write (via `recordInventoryChange`).
34. **Billing snapshots are immutable.** Once created, monetary totals and included shipment IDs on `warehouse_billing_snapshots` rows cannot be changed. Adjustments go to `warehouse_billing_adjustments` only.
35. **Bandcamp scraper is a first-class health signal.** If scraper failure rate > 20% in a single sync run, create a review queue item AND surface on Channels page. Don't just log it.

## Webhook Implementation
36. **ALWAYS use `req.text()` for webhook HMAC verification.** In Next.js App Router, `await req.json()` then `JSON.stringify()` alters whitespace and byte sequence, breaking HMAC signatures 100% of the time. Correct pattern: `const rawBody = await req.text(); verifyHmac(rawBody, secret, signature); const data = JSON.parse(rawBody);`
37. **Store processed webhook IDs for replay protection.** Don't rely solely on timestamp freshness. Create a `webhook_events` table or use a TTL cache with `UNIQUE(platform, external_webhook_id)` to reject duplicate deliveries.

## Frozen Primitives Escape Hatch
38. **If Wave 2+ reveals a bug in frozen Wave 1 primitives:** Do NOT modify them inside a worktree. Instead: (a) pause affected worktrees, (b) create a hotfix branch from main, (c) fix the primitive (types.ts, middleware, schema, etc.), (d) merge hotfix to main, (e) all active worktrees rebase on the new main before continuing. This is the ONLY safe way to change frozen files.

## SKU Ingestion Safety
39. **Never let ingestion tasks crash on SKU uniqueness violations.** Wrap upserts in a function that catches unique constraint errors, writes a `warehouse_review_queue` item with full context (source, payload, SKU, org), marks the sync run as "partial success", and continues processing remaining items.

## Role Management
40. **Define a single ROLE_MATRIX constant in code.** All role checks (middleware, Server Actions, RLS helpers) reference the same source: `const STAFF_ROLES = ['admin', 'super_admin', 'label_staff', 'label_management', 'warehouse_manager'] as const;` exported from `src/lib/shared/constants.ts`. Never hardcode role strings in middleware or components.

## Server Action Timeouts
41. **Server Actions for quick mutations. Trigger tasks for heavy work.** Keep Server Actions bounded (aim for <30s regardless of platform limits). Add `export const maxDuration = 60;` on the route segment (page.tsx/layout.tsx, NOT the action file) for heavy mutations like product create or bulk operations. For anything that may exceed 60s (force sync, full backfill, large Bandcamp scrape), fire a Trigger.dev task from the Server Action and return a task run ID for polling. Never let a Server Action do unbounded work.

## Inventory Write-Path Enforcement
42. **Lint guard for direct inventory access.** Add a CI script that greps for `warehouse_inventory_levels` and `inv:` Redis key patterns outside of `recordInventoryChange()` and its tests. Any direct `supabase.from('warehouse_inventory_levels').update(...)` or `redis.hincrby('inv:...')` outside the canonical write path is a build failure. Provide an `InventoryRepository` abstraction that exposes only safe methods; never export the raw table name in shared constants.
43. **recordInventoryChange() event ordering contract.** The function MUST execute in this exact order: (1) acquire stable correlation_id, (2) apply Redis HINCRBY synchronously, (3) Postgres mutation + `warehouse_inventory_activity` row in ONE DB transaction, (4) enqueue fanout (multi-store push, Realtime broadcast), (5) mark event handled/idempotent via correlation_id. If step 3 fails, the Redis write is an over-decrement — the periodic reconciliation sensor catches this. Never reorder steps 2 and 3.

## WooCommerce Drift Tracking
44. **WooCommerce uses absolute quantities, not deltas — track last-known remote value.** Add `last_pushed_quantity` and `last_pushed_at` to `client_store_sku_mappings`. On each push, store the value sent. On next poll/webhook, compare remote quantity to `last_pushed_quantity` — if it differs and no order accounts for the delta, treat as external adjustment and create a review queue item. Surface "WooCommerce drift detected" on Channels page.

## Bandcamp Degraded Mode
45. **Channels page must show granular Bandcamp health states.** Not just "healthy/unhealthy" but: (a) API token status (valid / expired / family broken), (b) scraper status (operational / degraded / failing), (c) metadata coverage (full / partial — missing type_name or street_date), (d) push lag (last successful push timestamp). If scraper is degraded, fall back to format-detector on title/SKU and mark products as `format_inferred` in review queue.

## Shopify Sync Cursor Safety
46. **Delta sync must use an overlap window.** Store both `last_sync_cursor` (Shopify `updated_at` value) and `last_sync_wall_clock` in `warehouse_sync_state`. On each delta run, subtract 2 minutes from the cursor to create an overlap window: `updated_at_min = last_sync_cursor - 2min`. This catches products updated near the cursor boundary that may have been missed due to clock skew or Shopify eventual consistency. Deduplication via SKU upsert ensures overlap doesn't create duplicates.

## Redis Idempotency (CRITICAL)
47. **HINCRBY is NOT idempotent — guard every Redis inventory write with SETNX.** If a Shopify webhook handler times out at 14.9s AFTER Redis HINCRBY but BEFORE returning 200, Shopify retries and you double-decrement. Pattern: `SETNX processed_wh:{webhook_id} 1 EX 86400` → if returns 1, proceed with HINCRBY; if returns 0, skip HINCRBY, return 200. Use Lua script to make check+write atomic:
```lua
-- KEYS[1] = idempotency key (e.g., "processed_wh:{webhook_id}")
-- KEYS[2] = inventory hash (e.g., "inv:{sku}")
-- ARGV[1] = hash field (e.g., "available")
-- ARGV[2] = delta (e.g., "-2")
if redis.call('SETNX', KEYS[1], 1) == 1 then
  redis.call('EXPIRE', KEYS[1], 86400)
  return redis.call('HINCRBY', KEYS[2], ARGV[1], ARGV[2])
else
  return nil
end
```
This applies to ALL webhook-driven inventory writes, not just Shopify.

## Force Sync Safety
48. **No Server Action may call the Bandcamp API directly.** The "Force Sync" button on Channels page MUST call `tasks.trigger('bandcamp-sync')` to enqueue the job into the shared `bandcamp-api` queue. If a Server Action calls `bandcamp.ts` directly while the cron job runs, you get a `duplicate_grant` error and kill the token family. Same rule applies to "Force Sync" for Shopify, ShipStation, and all other integrations — always enqueue via Trigger, never call APIs from Server Actions.

## Sentry + Trigger.dev Integration
49. **Trigger.dev v4 tasks run in Trigger's infra, NOT Vercel.** The Next.js Sentry wizard only catches errors in Vercel-hosted code (UI, Route Handlers, Server Actions). Task errors in `src/trigger/tasks/*.ts` are invisible to Sentry unless explicitly forwarded. In `trigger.config.ts`, use the global `catchError` hook to call `Sentry.captureException(error)`. Initialize Sentry in the Trigger config using `@sentry/node`, NOT `@sentry/nextjs`.

## Scanner Hardware Resilience
50. **Use the Wake Lock API during active scan sessions.** Warehouse staff scan 15 items, set the phone down to open a box, and the screen sleeps. On iOS Safari, the browser tab may reload on wake, losing the session. Pattern: `navigator.wakeLock.request('screen')` when a count session starts, release on session end. Also use Zustand `persist` middleware (to `sessionStorage`) so if Safari force-reloads the tab, the active count session is restored instantly. Release wake lock in cleanup.

## Layout Freeze for Parallel Waves
51. **Wave 2 windows MUST NOT modify `layout.tsx` or sidebar navigation.** With 12 parallel worktrees, if multiple windows add routes to the sidebar nav array simultaneously, Git merge conflicts will be structurally horrific. Instead: each window builds pages and actions only. After Wave 2 merge, a SINGLE manual pass wires all new routes into the navigation layout. Add this to the Wave 2 prompt preamble.

## Integration Health States
52. **Every integration must expose typed health states, not just "healthy/unhealthy".** States: `healthy`, `delayed` (>2x normal interval), `partial` (some operations failing), `manual_review` (needs staff action), `disconnected` (auth failed / unreachable). These states apply to: Shopify sync, Bandcamp API + scraper (separate states), ShipStation webhooks + poller, each client store connection, Redis projection, and Resend email. Surface on Channels page and client portal "sync health" card.

## Outbound Sync Circuit Breakers
53. **Add circuit breakers for every outbound sync connection.** Per-connection: retry cap (5 failures), exponential backoff (1min → 2min → 4min → 8min → 16min), auto-disable after 5 consecutive auth failures (set `connection_status = 'disabled_auth_failure'`), "Retry All" button on Channels page, and a `do_not_fanout` flag that stops inventory pushes to a degraded connection. One broken client store must NEVER block global sync throughput.

## Server Action Timeout Placement
54. **Keep Server Actions bounded. Use Trigger for anything heavy.** Regardless of platform limits, Server Actions should stay under 30 seconds. Put `export const maxDuration = 60;` on the route segment (page.tsx or layout.tsx), NOT in the action file — Vercel reads it from the route segment. For anything unbounded, retried, or fanout-heavy, fire a Trigger.dev task from the Server Action and return a task run ID for polling. Never let a Server Action do unbounded work.

## Review Queue UX
55. **Review Queue must be actionable, not just informational.** Required fields: `assigned_to` (staff user), `severity` (low/medium/high/critical), `sla_due_at` (auto-set based on severity), `suppressed_until` (nullable — "snooze for X hours"), `group_key` (for deduplication — e.g., same SKU + same error type = one item). Auto-deduplicate: if an item with the same `group_key` already exists and is open, increment its `occurrence_count` rather than creating a duplicate. Attach auto-generated diagnosis text with links to relevant pages.

## Client Onboarding Progress
56. **Both staff and client portals must show an onboarding checklist.** Steps: (1) Login complete, (2) Portal features configured, (3) Store connections submitted, (4) SKU mappings verified, (5) Inbound contact confirmed, (6) Billing contact confirmed, (7) First inventory sync complete, (8) Support email active. Store progress in `organizations.onboarding_state JSONB`. Show on client Home page and staff Client Detail page. Incomplete steps show "What we need from you" guidance.

## Shared Utilities (Anti-Drift)
57. **Do NOT invent new utility files.** Standard formatting, class merging, date parsing, and currency functions go in `src/lib/shared/utils.ts` (created in Wave 1). If a utility doesn't exist there, ADD it there — never create a separate `helpers.ts`, `formatters.ts`, or `money.ts` in a feature directory. This prevents 12 windows from creating 12 different `formatCurrency` functions.

## One Truth Per Concern (Anti-Drift)
58. **Every shared concern has exactly ONE owner file.** If two files look equally authoritative, Claude windows will diverge. Hard owners:
- Schema truth: `supabase/migrations/*.sql`
- DB types: generated Supabase types (re-exported from `types.ts`)
- Role truth: `src/lib/shared/constants.ts` → ROLE_MATRIX
- Inventory writes: `src/lib/server/record-inventory-change.ts`
- Bandcamp concurrency: `src/trigger/lib/bandcamp-queue.ts`
- Client credentials: `src/actions/client-store-credentials.ts`
- Task registry: `src/trigger/tasks/index.ts` (exports all task names)
- Env validation: `src/lib/shared/env.ts` (Zod schema)
- Webhook body parsing: `src/lib/server/webhook-body.ts` (shared `req.text()` + HMAC helper)

## Bulk Sync Exception
59. **shopify-sync and shopify-full-backfill are the ONLY exceptions to the single write path.** These tasks upsert thousands of product/variant rows per run. Calling `recordInventoryChange()` per-row would overwhelm Redis and Postgres with individual transaction locks. Instead, these tasks use bulk `INSERT ... ON CONFLICT` for Postgres and `MSET`/pipeline for Redis, then log a single `sync_reconciliation` event in `warehouse_inventory_activity`. The `inv.redis_postgres_drift` sensor catches any resulting drift. ALL other inventory writes (webhooks, manual adjustments, inbound check-ins, sale polls) MUST use `recordInventoryChange()`.

## Bandcamp Scrape Queue
60. **HTML scraping does NOT need the Bandcamp API token queue.** The shared `bandcamp-api` queue with `concurrencyLimit: 1` is for OAuth-bearing API calls only. Public HTML page scraping should use a SEPARATE queue: `export const bandcampScrapeQueue = queue({ name: "bandcamp-scrape", concurrencyLimit: 3 });` — allowing 3 concurrent scrape requests while API calls remain serialized. This prevents 200+ page scrapes from blocking API operations.

## Env Source of Truth
61. **The authoritative env var list is Setup Guide Section 3.** Part 2 and Build Guide reference env vars but the Setup Guide `.env.local` block is the single canonical list. If a new env var is needed, add it to the Setup Guide FIRST, then reference it elsewhere. Wave 1 Window 1 creates `src/lib/shared/env.ts` with Zod validation — that file must validate EVERY var from the Setup Guide list.

## Webhook Dedup for ALL Platforms
62. **ALL webhook handlers (including Stripe) must use the `webhook_events` table for dedup.** Pattern: `INSERT INTO webhook_events (platform, external_webhook_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`. If the insert returns no rows, the webhook was already processed — return 200 OK immediately and halt. This applies to: Shopify, ShipStation, Stripe, Resend inbound, and all client-store webhooks. Stripe specifically retries for up to 3 days; simple "check if exists" queries are vulnerable to race conditions, but INSERT ON CONFLICT is atomic.

## Platform Webhook Signatures
63. **Every first-party webhook endpoint must verify signatures before side effects.** Required headers and secrets: Shopify `X-Shopify-Hmac-SHA256` (`SHOPIFY_*` secret), ShipStation `X-SS-Signature` (`SHIPSTATION_WEBHOOK_SECRET`), AfterShip `aftership-hmac-sha256` (`AFTERSHIP_WEBHOOK_SECRET`), Stripe `Stripe-Signature` (`STRIPE_WEBHOOK_SECRET`), Resend inbound Svix trio (`svix-id`, `svix-timestamp`, `svix-signature` with `RESEND_INBOUND_WEBHOOK_SECRET`). Always verify against raw body from `req.text()`.

## PostgREST Transaction Safety (CRITICAL)
64. **`supabase.from().update()` followed by `supabase.from().insert()` is NOT a transaction.** PostgREST executes each call as a separate HTTP request. If the process dies between them, your inventory levels and activity log are permanently out of sync. The Postgres portion of `recordInventoryChange` MUST be a Supabase RPC (`supabase.rpc('record_inventory_change_txn', { p_sku, p_delta, p_source, p_correlation_id })`) that wraps the level update + activity insert in a single ACID PL/pgSQL transaction. Never use sequential `.from()` calls for multi-table inventory mutations.

## Webhook Echo Cancellation (CRITICAL)
65. **Prevent infinite inventory loops when pushing to Shopify/stores.** When Clandestine pushes inventory to Shopify, Shopify fires a webhook back. If you process that webhook as a real sale, you decrement again, push again, and inventory spirals to zero in minutes. FIX: ALL incoming absolute-inventory webhooks must calculate delta against `client_store_sku_mappings.last_pushed_quantity`, NOT warehouse truth. If `webhook_qty == last_pushed_quantity` (or if the Shopify webhook `app_id` matches Clandestine's app), DROP the webhook immediately. Log as `echo_cancelled` in `webhook_events`.

## Async Webhook Processing (CRITICAL)
66. **Shopify expects 200 OK within 5 seconds.** If your Route Handler does HMAC + dedup + Redis + Postgres + fanout and Vercel has a cold start, you'll exceed 5s. Shopify drops the connection, retries aggressively, and eventually DELETES your webhook subscription. FIX: Route Handlers must do ONLY: (1) `req.text()` for raw body, (2) verify HMAC, (3) `INSERT INTO webhook_events`, (4) `tasks.trigger('process-webhook', { payload })`, (5) return 200 OK. Target <500ms. All heavy processing happens in Trigger.dev where timeouts don't matter.

## Connection Pooling (CRITICAL)
67. **All Supabase clients in Server Actions and Trigger tasks MUST use Supavisor (port 6543 with `?pgbouncer=true`).** Port 5432 is a direct Postgres connection — 50 concurrent webhooks will blow past Supabase's 100-connection limit and crash the app. Keep port 5432 ONLY for the migration CLI (`DIRECT_URL` in Supabase config). The `DATABASE_URL` used by the app runtime must use pooled connections.

## Direct-to-Storage Uploads
68. **Vercel Server Actions have a hard 4.5MB request body limit.** Pirate Ship XLSX exports for 80 labels can hit 8-10MB. FIX: The browser UI must upload the XLSX directly to Supabase Storage via the Supabase JS client, then pass the `storage_path` string to the Server Action. The Server Action triggers a Trigger.dev task to download and parse the file. Same pattern for any user upload that could exceed 4MB.

## FIFO Pre-Order Allocation
69. **The `preorder-fulfillment` task MUST allocate stock via FIFO.** When a pressing plant short-ships (300 received vs 450 pre-orders), which orders get released matters. The task must `ORDER BY warehouse_orders.created_at ASC` and allocate sequentially. When available stock hits 0, remaining orders stay `pending` and a `short_shipment` review queue item is created (severity: `critical`). Never release orders in arbitrary disk order.

## Wave 1.5 Dependency Freeze
70. **Before branching Wave 2 worktrees, run a single "Wave 1.5" pass.** One Claude window installs ALL predicted npm packages, shadcn/ui components, and Lucide icons. Commit to main. THEN branch worktrees. Wave 2 windows are BANNED from running `pnpm add` or `npx shadcn-ui add` — these modify `package.json` and `pnpm-lock.yaml`, which are impossible to merge across 12 branches. If a Wave 2 window discovers a missing dependency, STOP and use the Rule 38 hotfix protocol.

## Inventory Freshness States
71. **Quantity agreement is not the same as temporal certainty.** Redis says 4, Postgres says 4, but WooCommerce still shows 6 because push is delayed. Staff sees green. Oversell happens. FIX: Track `inventory_freshness_state` per channel: `fresh` (<5min since last push), `delayed` (5-30min), `stale` (>30min), `reconciling` (backfill running). Drive Channels page badges and client-facing confidence from freshness, not just quantity match. The `inv.propagation_lag` sensor must check `last_pushed_at` per store connection and flag `delayed` or `stale` states.

## Hardware Scanner Input
72. **Barcode scanners fire 12+ keystrokes in <50ms.** React's synthetic event loop cannot process state updates that fast and will drop characters. FIX: Capture input via vanilla JS `window.addEventListener('keydown')` outside the React render cycle. Measure keystroke delta — if <30ms between keys, it's a scanner, not typing. Buffer characters to an array and execute the lookup once on `[Enter]`. Never use a controlled React `<input onChange>` for raw scanner capture.
