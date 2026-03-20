# Integration Registration Matrix

Purpose: distinguish “implemented in code” from “registered and healthy in production.”

Use this with:
- `docs/DEPLOYMENT.md`
- `scripts/sql/webhook_health_snapshot.sql`

---

## 1) Webhook registration matrix

Status fields are intentionally explicit to prevent drift.

| Integration | Route handler | Provider-side registration required | Signature header | Secret source | Current registration status | Owner | Last validated |
|---|---|---|---|---|---|---|---|
| Shopify (first-party) | `/api/webhooks/shopify` | Yes (Shopify admin -> webhooks) | `X-Shopify-Hmac-SHA256` | `SHOPIFY_WEBHOOK_SECRET` env | `UNKNOWN` | `TBD` | `TBD` |
| ShipStation | `/api/webhooks/shipstation` | Yes (ShipStation webhook config) | `X-SS-Signature` | `SHIPSTATION_WEBHOOK_SECRET` env | `UNKNOWN` | `TBD` | `TBD` |
| AfterShip | `/api/webhooks/aftership` | Yes (AfterShip webhook config) | `aftership-hmac-sha256` | `AFTERSHIP_WEBHOOK_SECRET` env | `UNKNOWN` | `TBD` | `TBD` |
| Stripe | `/api/webhooks/stripe` | Yes (Stripe webhook endpoint) | `Stripe-Signature` | `STRIPE_WEBHOOK_SECRET` env | `UNKNOWN` | `TBD` | `TBD` |
| Resend inbound | `/api/webhooks/resend-inbound` | Yes (Resend inbound/Svix endpoint) | `svix-signature` (+ `svix-id`, `svix-timestamp`) | `RESEND_INBOUND_WEBHOOK_SECRET` env | `UNKNOWN` | `TBD` | `TBD` |
| Client store (Shopify/Woo) | `/api/webhooks/client-store?connection_id={id}&platform={platform}` | Yes (per client store) | Shopify: `X-Shopify-Hmac-SHA256`; Woo: `X-WC-Webhook-Signature` | `client_store_connections.webhook_secret` | `UNKNOWN` | `TBD` | `TBD` |

Notes:
- Shopify support also exists in client-store webhook path for per-client connected stores.
- Route implementation is present; registration status must be verified in provider dashboards.

---

## 2) Code-level evidence map

- Shopify handler: `src/app/api/webhooks/shopify/route.ts`
- ShipStation handler: `src/app/api/webhooks/shipstation/route.ts`
- AfterShip handler: `src/app/api/webhooks/aftership/route.ts`
- Stripe handler: `src/app/api/webhooks/stripe/route.ts`
- Resend inbound handler: `src/app/api/webhooks/resend-inbound/route.ts`
- Client-store handler: `src/app/api/webhooks/client-store/route.ts`
- Shared HMAC utility: `src/lib/server/webhook-body.ts`

---

## 3) Registration checklist (run per environment)

For each integration above:

1. Confirm endpoint URL in provider dashboard matches current app domain.
2. Confirm event/topic subscriptions are correct and active.
3. Confirm secret exists in environment (or per-connection DB for client stores).
4. Send a provider test webhook (or equivalent replay).
5. Verify app receives 2xx and inserts into `webhook_events`.
6. Verify downstream Trigger task fires where applicable.
7. Record owner + validation date in the matrix.

---

## 4) Event/topic expectations

| Integration | Expected events/topics |
|---|---|
| Shopify | Inventory webhooks (notably `inventory_levels/update`) |
| ShipStation | `SHIP_NOTIFY` |
| AfterShip | Tracking updates |
| Stripe | `invoice.paid`, `invoice.payment_failed` |
| Resend inbound | `email.received` / inbound email events |
| Client stores | Orders/inventory updates by platform |

---

## 5) Health checks and observability

- Run SQL snapshot:
  - `scripts/sql/webhook_health_snapshot.sql`
- Review:
  - `webhook_events` recent volume/status
  - `client_store_connections.last_webhook_at` and `last_poll_at`
  - Trigger task runs for webhook processors

---

## 6) Known risk flags

- `SHIPSTATION_WEBHOOK_SECRET` currently defaults to empty string in `src/lib/shared/env.ts`.
  - Recommendation: require non-empty in production profile before enabling live webhook traffic.
- Manual registration drift risk:
  - This matrix must be maintained as part of release checklists.
