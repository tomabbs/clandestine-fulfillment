---
name: Full Audit Remediation
overview: Address high-signal failures from the full-site Playwright audit by fixing real 500/hydration issues, tightening route assertions, and establishing a clean, repeatable runtime-health baseline.
todos:
  - id: harden-auth-actions
    content: Convert auth-throwing read actions to safe typed failures on unauthenticated prefetch paths
    status: completed
  - id: fix-route-500s
    content: Patch billing/users/releases page-action wiring so errors render in UI instead of server 500s
    status: completed
  - id: resolve-hydration-mismatch
    content: Remove SSR/client divergence causing hydration/pageerror bursts on audited routes
    status: completed
  - id: tighten-audit-spec
    content: Refine full-site audit assertions to fail on true runtime regressions and reduce false heading failures
    status: completed
  - id: rerun-and-compare
    content: Re-run full-site audit and compare report metrics versus current baseline
    status: completed
  - id: document-gate-criteria
    content: Document full-site audit pass/fail interpretation in release gate docs
    status: completed
isProject: false
---

# Full-Site Audit Fix Plan

## Goal

Resolve the concrete runtime issues surfaced by the full-site Playwright audit and make the audit report reliable as an ongoing health gate for staff + client portals.

## Scope From Latest Audit

- Failing routes and noisy hotspots came from `reports/playwright-audit/full-site-audit-2026-03-20T06-09-17-203Z.md`.
- Primary signals to fix first:
  - 500 responses on `POST /admin/billing`, `POST /admin/settings/users`, `POST /portal/releases`.
  - Hydration mismatch/pageerror bursts (mostly on releases/users paths).
  - Repeated unauthorized server-action calls during route loads.

## Implementation Steps

1. **Stabilize auth-bound server actions on initial page load**

- Harden auth handling in actions that currently throw `Unauthorized` during hydration/prefetch where UI can safely degrade:
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/actions/billing.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/actions/billing.ts)`
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/actions/catalog.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/actions/catalog.ts)`
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/actions/users.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/actions/users.ts)`
- Pattern: return typed error envelopes / safe empty results for read-only queries when session is absent, instead of uncaught throws that produce 500s.

1. **Fix route-level runtime 500s in audited pages**

- Verify and patch specific call chains for:
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/admin/billing/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/admin/billing/page.tsx)`
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/admin/settings/users/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/admin/settings/users/page.tsx)`
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/portal/releases/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/portal/releases/page.tsx)`
- Ensure each page handles action failures with explicit UI states (error cards/toasts) and never bubbles to generic server-render 500s.

1. **Eliminate hydration mismatch sources on releases/settings paths**

- Audit SSR/client rendering differences in page-level data access and dynamic markup for:
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/portal/releases/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/portal/releases/page.tsx)`
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/admin/settings/users/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/admin/settings/users/page.tsx)`
- Normalize potentially unstable initial render values (time/date formatting, conditional blocks, auth-dependent content) so server/client trees match.

1. **Tighten full-site audit quality signal**

- Refine audit assertions in `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/tests/e2e/full-site-audit.spec.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/tests/e2e/full-site-audit.spec.ts)`:
  - Keep strict failure for network 5xx + page errors.
  - Normalize heading checks where current titles differ but page is healthy (e.g., `User Management` vs `Users`).
  - Continue writing JSON+Markdown route diagnostics for trend tracking.

1. **Re-run and compare baseline**

- Re-run:
  - `pnpm check`
  - `pnpm test:e2e:full-audit`
- Confirm improvements in newest `reports/playwright-audit/full-site-audit-*.md` against prior baseline:
  - fewer/no route fails,
  - zero unexpected 500 POSTs,
  - reduced hydration/pageerror counts.

1. **Promote to release hardening gate**

- Keep `test:e2e:full-audit` as optional pre-release health pass and document interpretation criteria in release docs:
  - `[/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/RELEASE_GATE_CRITERIA.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/RELEASE_GATE_CRITERIA.md)`
- Mark known benign warnings separately from actionable regressions.

