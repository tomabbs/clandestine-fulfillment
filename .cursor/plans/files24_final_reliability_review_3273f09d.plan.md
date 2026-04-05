---
name: Files24 Final Reliability Review
overview: Complete a no-gaps final review of files 24 and produce a prioritized redline plan that eliminates contradictions, closes reliability holes, and hardens parallel Claude build execution.
todos:
  - id: validate-contract-breakers
    content: Confirm and document all contract-breaking contradictions across files 24 with exact replacement text
    status: completed
  - id: reliability-redline
    content: Draft reliability hardening updates for webhooks, billing recovery, inventory idempotency, and support dead-letter flow
    status: completed
  - id: build-proof-redline
    content: Draft parallel-build hardening updates for ownership, CI gate checks, and deterministic merge protocol
    status: completed
  - id: final-go-no-go
    content: Produce final go/no-go checklist with required blocking tests and operational sign-off criteria
    status: completed
isProject: false
---

# Files 24 Final Reliability Redline Plan

## Scope
- Audit and reconcile these docs as one contract set:
  - [/Users/tomabbs/Downloads/files 24/CLANDESTINE_FULFILLMENT_PART1_FINAL.md](/Users/tomabbs/Downloads/files 24/CLANDESTINE_FULFILLMENT_PART1_FINAL.md)
  - [/Users/tomabbs/Downloads/files 24/CLANDESTINE_FULFILLMENT_PART2_FINAL.md](/Users/tomabbs/Downloads/files 24/CLANDESTINE_FULFILLMENT_PART2_FINAL.md)
  - [/Users/tomabbs/Downloads/files 24/CLANDESTINE_FULFILLMENT_BUILD_GUIDE.md](/Users/tomabbs/Downloads/files 24/CLANDESTINE_FULFILLMENT_BUILD_GUIDE.md)
  - [/Users/tomabbs/Downloads/files 24/CLANDESTINE_FULFILLMENT_SETUP_GUIDE.md](/Users/tomabbs/Downloads/files 24/CLANDESTINE_FULFILLMENT_SETUP_GUIDE.md)

## Priority 0: Contract-Breaking Contradictions (fix first)
- **Inventory idempotency schema gap**
  - `Part1` still defines `warehouse_inventory_activity` with `reference_id` only, while build rules require `correlation_id` and `UNIQUE(sku, correlation_id)`.
  - Action: add `correlation_id` and uniqueness constraint (or explicitly rename/replace `reference_id` everywhere).
- **Dead-letter support flow vs schema constraint**
  - `Part2` says unmatched inbound email can create a conversation with no org match; `Part1` requires `support_conversations.org_id NOT NULL`.
  - Action: choose one model and codify it (recommended: create `unrouted_support_emails` table and route manually).
- **Shared file ownership conflict for client credential action**
  - `Build Guide` one-truth rule points to `src/actions/client-store-credentials.ts`; `Part1/Part2` put `submitClientStoreCredentials` in `store-connections.ts`.
  - Action: choose one owner file and update all docs.

## Priority 1: High-Risk Reliability Hardening
- **Webhook signature verification completeness**
  - Current docs clearly enforce signatures for client-store webhooks, but not explicitly for ShipStation/AfterShip/Resend inbound.
  - Action: add explicit signature verification requirements and headers/secrets in `Part2 + Build Guide + Setup Guide`.
- **Redis backfill operational drift**
  - `Build Guide` requires weekly `redis-backfill`, but `Part2` task inventory excludes it.
  - Action: add `redis-backfill` to Part2 task list and all gate checklists (or explicitly de-scope it in all docs).
- **Billing resiliency after RPC commit**
  - RPC commit + subsequent Stripe failure can leave snapshots created without invoices.
  - Action: add retry/recovery state and review queue behavior in billing task spec.

## Priority 2: Parallel Build Proofing (12-window safety)
- **Path ownership consistency**
  - Remaining mismatch: `Part2` maps parser/calculator/detector to `src/lib/shared/*`; Build windows create them in `src/lib/clients/*`.
  - Action: normalize to one canonical path family before Wave 1 starts.
- **Mandatory CI guardrails in audit gates**
  - Add blocking checks to Gate 1–4:
  - inventory-write-path guard,
  - webhook dedup guard,
  - schema-contract test,
  - RPC-call-shape test,
  - RLS isolation Playwright test.
- **Merge determinism**
  - Add explicit branch merge order and shared-file conflict protocol in Git Worktree strategy.

## Output format for final review handoff
- Severity-ordered finding list (`Critical/High/Medium`) with exact doc line snippets.
- For each finding:
  - failure scenario,
  - user impact (staff/client/finance/ops),
  - exact replacement text to paste.
- A short “go/no-go” checklist for launch readiness.
