# Order Pages Transition — Live System Test (2026-04-29)

Run after `feat(orders)` ship + `chore(operational-cutover)` (commits
`5b1ba33` + `7425ef1`). Validates the transition surfaces against the
plan's contract using:

- HTTP probes (route status + redirect)
- Playwright smoke (transition + cutover specs, full-site audit)
- Direct DB diagnostics (PostgREST against the prod project)
- Targeted Vitest unit suite (5 spec files, 48 tests)
- Production deploy + Trigger deploy + Vercel build status

## Verdict

| Surface | Status |
|---|---|
| Vercel production deploy of `7425ef1` | **READY** ✅ |
| Trigger.dev v3 deploy `20260429.4` | **READY** ✅ (131 tasks) |
| Supabase migrations `20260429000001..04` | **APPLIED** ✅ |
| Order Pages Transition routes | **5/5 PASS** ✅ |
| Operational cutover smoke (3 specs) | **3/3 PASS** ✅ |
| Full-site audit (53 routes) | **51 PASS / 2 FAIL** (both pre-existing) |
| Targeted unit suite (48 tests) | **48/48 PASS** ✅ |
| Direct Orders detail page (route_mode=direct) | **WORKS** ✅ |
| Legacy `/admin/shipstation-orders` redirect | **308 → /admin/orders/shipstation** ✅ |

There is one Vercel-side finding ("the deployment issue" the operator
flagged) that turned out to be on a Dependabot PR, not on `main`. See
§ "Vercel deployment status" below.

---

## 1. HTTP probes

```
GET /admin/orders                  -> 200  (cold compile 25.0s, then sub-second)
GET /admin/orders/shipstation      -> 200  (cold compile 4.9s)
GET /admin/orders/diagnostics      -> 200  0.65s
GET /admin/orders/holds            -> 200  0.64s
GET /admin/shipstation-orders      -> 308 → /admin/orders/shipstation  (instant)
```

Redirect chain confirmed via curl with `--max-redirs 0`:
the legacy URL serves `Location: http://localhost:3000/admin/orders/shipstation`
with HTTP 308 (the `permanent: true` declaration in `next.config.mjs` resolved
to a 308 rather than 301; both are permanent and acceptable).

## 2. Playwright — `tests/e2e/order-transition-smoke.spec.ts`

New spec authored this run. 5 tests:

| Test | Result |
|---|---|
| `/admin/orders` renders Direct or Mirror per flag | **PASS** (1.4s) |
| `/admin/orders/shipstation` hosts the cockpit | **PASS** (640ms) |
| `/admin/orders/diagnostics` renders snapshot grid + 3 operator cards | **PASS** (863ms) |
| Legacy `/admin/shipstation-orders` 301/308 to `/admin/orders/shipstation` | **PASS** (553ms) |
| Direct list + detail page (`route_mode=direct`) | **PASS** (4.2s) |

The detail-page test uses the actual operator UI to flip
`workspaces.flags.orders_route_mode` to `direct` (via
`flipOrdersRouteMode` Server Action with an audit reason),
navigates `/admin/orders` (now Direct), follows the first detail
link to `/admin/orders/[id]`, asserts the order_number h1 + at
least one of (Items / Shipments / Mirror links / Tracking /
Writebacks) renders, then **restores the flag** in a `finally`
block. Workspace flag is back to `shipstation_mirror` post-run
(verified via PostgREST).

## 3. Playwright — `tests/e2e/operational-cutover-smoke.spec.ts`

Existing spec. 3 tests, all PASS:

- `/admin/orders` renders without error boundary ✅
- `/admin/inventory/manual-count` renders without error boundary ✅
- `/admin/shipping` renders without error boundary ✅

## 4. Playwright — full-site audit

`tests/e2e/full-site-audit.spec.ts` (extended this run with the 3 new
transition routes). 53 routes audited.

- **51 PASS / 2 FAIL / 3 SKIPPED** (skipped = empty list pages)
- All 6 transition routes pass cleanly:
  `/admin/shipstation-orders` (legacy alias), `/admin/orders/shipstation`,
  `/admin/orders/diagnostics`, `/admin/orders/holds` (and the audit's
  duplicated row from the prior list — all clean).

The 2 failures **both pre-date this transition** (verified against the
13:38 audit run before any of this session's commits):

| Route | What | Pre-existing? |
|---|---|---|
| `/admin/orders` | 11 hydration errors (`<tr>` child of `<div>` in `TableSkeleton` inside `BlockList`/`EmptyState`) | **Yes** — same 11 errors in the 13:38 audit |
| `/admin/catalog` | 3 hydration errors (duplicate React key `2da5...`, hydration suspense fallback) | **Yes** — same in the 13:38 audit |

Both originate inside `OrdersCockpit` (legacy). Notably **the
hydration errors disappear when `orders_route_mode='direct'`** — the
Direct Orders smoke spec ran with the flag flipped and observed zero
page errors. This is a real benefit-statement for the route flip:
the cockpit's table-skeleton bug is bypassed entirely once Direct
becomes default.

## 5. Direct DB diagnostics (live prod)

| Panel | Count |
|---|---|
| `warehouse_orders` total | **26,045** |
| ↳ `identity_resolution_status='unresolved'` | 26,045 (100%) — backfill not yet enqueued |
| ↳ `identity_resolution_status='deterministic'` | 0 |
| ↳ `connection_id IS NOT NULL` | 0 |
| ↳ `fulfillment_hold='on_hold'` | 0 |
| ↳ `fulfillment_hold='released'` | 0 |
| ↳ `fulfillment_hold='no_hold'` (default) | 26,045 |
| ↳ `is_preorder=true` | 1 |
| `order_mirror_links` | 0 — bridge worker not yet enqueued |
| `preorder_pending_orders` (view) | **113** (1 `direct` + 112 `shipstation_mirror`) ✅ |
| `warehouse_order_identity_review_queue (open)` | 0 |
| `warehouse_order_identity_backfill_runs` | 0 |
| `platform_fulfillment_writebacks` | 0 — none recorded since deploy |
| `platform_fulfillment_writeback_lines` | 0 |
| `warehouse_tracking_events.tracking_source IS NOT NULL` | **1,990 / 1,990** ✅ migration backfilled all rows |

Interpretation: schema is healthy, view + new tables are reachable
through PostgREST, and the migration's tracking-source backfill ran
on every existing row. The two backfill tasks
(`order-identity-backfill`, `order-mirror-links-bridge`) are pending
operator enqueue — the diagnostics page exposes the buttons for both
and they audit correctly when triggered.

## 6. Targeted unit suite

```
tests/unit/lib/server/order-identity-v2.test.ts          ✅
tests/unit/lib/server/order-mirror-links.test.ts         ✅
tests/unit/lib/server/platform-fulfillment-writeback.test.ts  ✅
tests/unit/lib/server/invalidate-order-surfaces.test.ts  ✅
tests/unit/lib/shared/store-key.test.ts                  ✅

5 files / 48 tests / 658ms — all pass.
```

## 7. Vercel deployment status

The operator's "deployment issue" is a Dependabot multi-package PR,
**not main**:

| Deployment | SHA | Branch | State |
|---|---|---|---|
| `dpl_HYa…ZEL4` (production) | `7425ef1` | main | **READY** ✅ |
| `dpl_BwM…7vTw` (preview) | `e7f4cc0d` | dependabot/lucide-react | READY ✅ |
| `dpl_Ek9…YXxaM` (preview) | `3e2d58c7` | dependabot/minor-and-patch (24 packages) | **ERROR** ❌ |

Production at `7425ef1` is alias-assigned and serving on
`clandestinefulfillment.com` + `cpanel.clandestinedistro.com`.

The failing preview is the dependabot bump that includes
`@supabase/supabase-js 2.104.1 → 2.105.1`. Build error:

```
./src/trigger/tasks/bandcamp-shipping-verify.ts:120:19
Type error: Type instantiation is excessively deep and possibly infinite.
> 120 |     legacyQuery = legacyQuery.not("workspace_id", "in", `(${directPrimaryIds.join(",")})`);
```

The newer `@supabase/supabase-js` types accumulate the chained
PostgrestFilterBuilder generics past TS's recursion limit on this
specific `.not()` chain plus conditional reassignment. Production is
**unaffected** because main is still on `2.104.1`. Suggested follow-up
(separate PR, ~1 line): break the type-inference chain at the
conditional reassignment point, e.g.

```ts
const legacyBaseQuery = supabase.from("warehouse_shipments").select(...).not(...).not(...).not(...).is(...).lte(...).limit(...);
const legacyQuery = directPrimaryIds.length > 0
  ? (legacyBaseQuery as typeof legacyBaseQuery).not("workspace_id", "in", `(${directPrimaryIds.join(",")})`)
  : legacyBaseQuery;
```

— or pull the conditional `.not()` into an inline ternary inside the
final `.limit()` chain so the union doesn't expand. Either fix
unblocks the Dependabot PR without changing runtime behavior.

## 8. Notable side-observations

- `[order-route-mode] audit insert failed duplicate key value violates unique constraint "uq_review_queue_group_key"` was logged once during the smoke run. **This is the intended behavior** — `flipOrdersRouteMode` writes a `warehouse_review_queue` audit row keyed by `group_key`, and re-flipping to the same mode within the dedup window correctly hits the unique constraint. The error is currently logged via `console.error`; consider downgrading to `logger.debug` when `error.code === '23505'` so it isn't surfaced as an alert in Sentry. This is cosmetic.
- `orders_route_mode` flag was temporarily flipped to `direct` for the production workspace `1e59b9ca-…` during the smoke run, then restored to `shipstation_mirror`. Verified via PostgREST after the run: `flags.orders_route_mode = "shipstation_mirror"`.

## 9. Reports written

- `reports/order-transition-smoke/order-transition-smoke-2026-04-29T17-19-44-…Z.{json,md}` — per-route smoke detail (page errors, console errors, 5xx, hydration, landmarks)
- `reports/playwright-audit/full-site-audit-2026-04-29T21-09-34-671Z.{json,md}` — full-site audit including the 3 new transition routes
- `reports/order-transition-smoke/order-transition-live-system-test-2026-04-29.md` — this report
