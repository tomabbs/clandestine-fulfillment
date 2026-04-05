---
name: Support Omnichannel Upgrade
overview: Audit current support implementation against your desired real-time chat + email continuity workflow, then deliver a phased patch plan that adds floating chat, presence indicators, and robust app/email thread continuity without replacing the existing support pages.
todos: []
isProject: false
---

# Support Omnichannel Plan (Client + Staff)

## 1) Scope Summary

Implement an additive upgrade to support so you keep the existing support tab/pages and issue-tracking workflow, while adding:

- floating chat launcher/bubble on staff + client portals,
- real-time presence and typing/online indicators,
- app/email continuity so conversations continue when one party is offline,
- clear escalation behavior and response-state UX.

This is a patch plan, not a rewrite.

## 2) Evidence Sources (Exact Files Reviewed)

- Core truth/context:
  - [TRUTH_LAYER.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/TRUTH_LAYER.md)
  - [docs/system_map/INDEX.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/system_map/INDEX.md)
  - [docs/system_map/API_CATALOG.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/system_map/API_CATALOG.md)
  - [docs/system_map/TRIGGER_TASK_CATALOG.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/system_map/TRIGGER_TASK_CATALOG.md)
  - [project_state/engineering_map.yaml](/Users/Shared/WorkShared/Project/clandestine-fulfillment/project_state/engineering_map.yaml)
  - [project_state/journeys.yaml](/Users/Shared/WorkShared/Project/clandestine-fulfillment/project_state/journeys.yaml)
  - [docs/RELEASE_GATE_CRITERIA.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/RELEASE_GATE_CRITERIA.md)
  - [docs/RUNBOOK.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/RUNBOOK.md)
- Support implementation:
  - [src/actions/support.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/actions/support.ts)
  - [src/app/portal/support/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/portal/support/page.tsx)
  - [src/app/admin/support/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/admin/support/page.tsx)
  - [src/app/api/webhooks/resend-inbound/route.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/api/webhooks/resend-inbound/route.ts)
  - [src/lib/clients/resend-client.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/lib/clients/resend-client.ts)
  - [src/trigger/tasks/support-escalation.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/trigger/tasks/support-escalation.ts)
  - [src/lib/hooks/use-presence-tracking.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/lib/hooks/use-presence-tracking.ts)

## 3) API Boundaries Impacted (from API catalog)

Primary boundaries in-scope:

- Server actions in [src/actions/support.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/actions/support.ts):
  - `getConversations`, `getConversationDetail`, `createConversation`, `sendMessage`, `resolveConversation`, `assignConversation`
- Webhook route in [src/app/api/webhooks/resend-inbound/route.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/api/webhooks/resend-inbound/route.ts):
  - inbound email -> conversation/message append/create
- Optional new API boundary (if needed for launcher counters):
  - either extend existing support actions or add a lightweight support-presence/status endpoint

## 4) Trigger Touchpoint Check

Reviewed relevant Trigger tasks:

- [src/trigger/tasks/support-escalation.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/trigger/tasks/support-escalation.ts)
  - currently provides reminder/escalation cadence (`*/5 * * * *`)

Touchpoint conclusion:

- Real-time in-app chat/presence should be driven by Supabase realtime/presence (low latency).
- Trigger remains for asynchronous SLA reminders/escalations and should be extended only for delayed/offline escalation workflows, not live delivery.

## 5) Proposed Implementation Steps

1. **Gap audit + UX contract (support-only)**
  - Document exact states: online, offline, waiting_on_staff, waiting_on_client, resolved.
  - Define when to show floating launcher badge, unread count, and “agent online/client online” indicators.
  - Keep existing support pages as source of full history and management.
2. **Presence model and conversation metadata patch**
  - Reuse/extend presence channel approach from [src/lib/hooks/use-presence-tracking.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/lib/hooks/use-presence-tracking.ts) for support-specific presence.
  - Add minimal message metadata fields (or computed projections) for unread/last_seen per participant.
  - Preserve existing conversation/message schema and status semantics.
3. **Floating support launcher (client + staff)**
  - Add a portal/admin shared floating component that:
    - shows unread badge,
    - opens compact conversation panel,
    - deep-links to full support page for issue management.
  - Do not replace [src/app/portal/support/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/portal/support/page.tsx) or [src/app/admin/support/page.tsx](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/admin/support/page.tsx).
4. **Real-time message updates and presence indicators in existing pages**
  - Add online/presence chips in conversation lists and detail headers.
  - Add “active now / last seen” for counterparty where possible.
  - Ensure query invalidation + realtime subscriptions do not duplicate or race.
5. **Email continuity hardening (omnichannel thread continuity)**
  - Ensure outbound staff/client replies consistently set `In-Reply-To`/`References` (already present in [src/lib/clients/resend-client.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/lib/clients/resend-client.ts)).
  - Tighten inbound matching logic in [src/app/api/webhooks/resend-inbound/route.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/app/api/webhooks/resend-inbound/route.ts) for edge cases (missing headers, alias/reply-to variants, duplicate delivery).
  - Add explicit “message delivered via email” / “reply from email” indicators in timeline.
6. **Escalation policy alignment**
  - Update [src/trigger/tasks/support-escalation.ts](/Users/Shared/WorkShared/Project/clandestine-fulfillment/src/trigger/tasks/support-escalation.ts) thresholds and logic to align with online/offline presence + SLA policy.
  - Add guardrails so escalation reminders do not spam when active real-time conversation is ongoing.
7. **AI-ready seam (without full AI build yet)**
  - Add non-invasive extension points in support actions for future answer-suggestion retrieval (e.g., hook interface, not model integration now).
  - Keep current support flow deterministic and auditable.

## 6) Risk + Rollback Notes

- **Risk: realtime duplication/race** between query polling and channel updates.
  - Mitigation: single subscription source per view + idempotent message merge strategy.
- **Risk: email threading mismatches** causing new conversations instead of append.
  - Mitigation: stronger inbound matching order + dedup checks + tests for reply-header variants.
- **Risk: staff UX overload** from launcher + page notifications.
  - Mitigation: clear priority rules; launcher as quick-entry, page remains operations center.
- **Rollback**:
  - Feature-flag floating launcher and presence chips,
  - retain existing support page behavior untouched behind flag-off state.

## 7) Verification Steps

- Static/runtime:
  - `pnpm check`
  - `pnpm typecheck`
- Unit/integration:
  - support action envelope tests + inbound email parsing/matching tests
- E2E:
  - extend support scenarios in portal/admin plus offline email-reply continuation path
  - `pnpm test:e2e:full-audit` to ensure no new 5xx/pageerror regressions
- Ops/gate:
  - ensure [docs/RELEASE_GATE_CRITERIA.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/RELEASE_GATE_CRITERIA.md) support flow section still passes

## 8) Doc Sync Contract Updates Required

If this plan is implemented, update in same session:

- [project_state/journeys.yaml](/Users/Shared/WorkShared/Project/clandestine-fulfillment/project_state/journeys.yaml) (`client_support_flow` expanded with launcher/presence/email continuity checks)
- [docs/system_map/API_CATALOG.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/system_map/API_CATALOG.md) (any new/changed support boundaries)
- [docs/system_map/TRIGGER_TASK_CATALOG.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/system_map/TRIGGER_TASK_CATALOG.md) (if escalation task logic/IDs change)
- [TRUTH_LAYER.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/TRUTH_LAYER.md) only if invariants change
- [docs/RELEASE_GATE_CRITERIA.md](/Users/Shared/WorkShared/Project/clandestine-fulfillment/docs/RELEASE_GATE_CRITERIA.md) if new support verification rules are added

## Industry Pattern Fit (Research Summary)

Patterns aligned with Intercom/Zendesk/Help Scout style support systems:

- unified thread across in-app and email,
- real-time chat when both parties online,
- offline fallback to email with preserved conversation context,
- visible presence/availability cues,
- asynchronous reminder/escalation policies for unanswered threads.

This plan follows those patterns while preserving your current support tab workflow and data model.