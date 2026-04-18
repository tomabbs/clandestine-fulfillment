# Secret rotation runbook

> Tier 1 hardening (Part 14.7) item #7.
> Per-secret rotation procedure. All secrets are rotated at least once per
> 90 days; high-risk secrets (Supabase service role, Bandcamp OAuth,
> Stripe) rotate every 30 days. Test rotation on one non-prod secret
> first whenever possible.

## General principles

- **Rotate one secret per session.** Never rotate two unrelated secrets in
  the same window — if something breaks, you cannot tell which rotation
  caused it.
- **Update Vercel + Trigger.dev environments together.** The Trigger.dev
  build pipeline syncs env vars from `.env.production` via
  `syncEnvVars()` (see `trigger.config.ts`). Vercel reads from its
  Environment Variables UI directly. After updating Vercel, run
  `npx trigger.dev@latest deploy --env prod` to refresh the Trigger
  bundle.
- **Verify with one canary call.** After rotation, hit one read-only API
  call (Bandcamp `merch_details`, ShipStation `listInventory`, Stripe
  `customers.list`) before considering the rotation done.
- **Keep the previous value in a sealed channel for 24h.** Quick rollback
  beats chasing a regression.

---

## SUPABASE_SERVICE_ROLE_KEY

Cadence: every 30 days. Rotation requires a maintenance window because
EVERY workspace stops processing webhooks during the swap.

1. Log in to Supabase dashboard → Project Settings → API.
2. Click "Reset" next to the service role JWT. Copy the new value.
3. In Vercel, update `SUPABASE_SERVICE_ROLE_KEY` (Production scope).
   Redeploy the production branch.
4. In `.env.production` (local), update the value, then run
   `npx trigger.dev@4.4.4 deploy --env prod` to push the new bundle.
5. Verify by hitting `/api/health` (returns 200 if service-role read of
   `workspaces` succeeds).
6. Watch Sentry for 5 minutes. Resume normal operation.

Rollback: paste the old value into Vercel + `.env.production` and
re-deploy. The Supabase dashboard does NOT preserve old keys — you must
have copied the previous value before clicking "Reset".

## BANDCAMP_CLIENT_ID / BANDCAMP_CLIENT_SECRET

Cadence: every 90 days. CRITICAL: read CLAUDE.md Rule #9 before rotating —
all OAuth-bearing tasks must remain serialized through `bandcampQueue`
during the rotation. Rotation itself does NOT trigger `duplicate_grant`,
but a refresh-token race can.

1. Email the Bandcamp Developer Partnership team (this is not
   self-service). Request new credentials, do NOT request invalidation
   of current credentials yet.
2. Once new client_id + client_secret arrive, update Vercel and
   `.env.production` together with both values.
3. Paste the existing refresh_token into Bandcamp's "exchange refresh
   token for new access token" endpoint using the NEW client_id /
   client_secret. This is the ONLY moment we know whether Bandcamp ties
   refresh tokens to client_id (currently unknown — record the result
   here for the next rotation).
4. If exchange succeeds: store the new access_token + refresh_token in
   the Bandcamp credentials table.
5. If exchange fails: Bandcamp ties tokens to client_id. We need to walk
   every fulfillment client through OAuth re-consent. This is a 1-2 day
   ops effort and requires email outreach to all 17 labels.
6. Once verified, ask Bandcamp to invalidate the old credentials.

## SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET (v1)

Cadence: every 90 days. v1 uses HTTP Basic auth; rotation is straightforward.

1. ShipStation dashboard → Account → API Settings → Generate New Keys.
2. Copy both values. Update Vercel + `.env.production`.
3. Re-deploy. Verify by hitting the v1 list-products endpoint (used by
   `sku-rectify-via-alias` task).
4. Rotate the alias-add path (Phase 0.5 mutex-protected) once before
   considering the rotation done.

## SHIPSTATION_V2_API_KEY

Cadence: every 90 days.

1. ShipStation v2 dashboard → API & Integrations → API Keys → Create
   New Key. Name it with the rotation date.
2. Update Vercel + `.env.production`. Re-deploy + Trigger redeploy.
3. Verify by hitting `listInventory({ skus: ['LILA-AV1'] })` from a
   one-off Trigger task or `scripts/test-shipstation-v2-decrement-to-zero.mjs`
   in read-only mode.
4. After 24h of clean traffic, revoke the old key in the dashboard.

## SHIPSTATION_WEBHOOK_SECRET

Cadence: every 180 days. Lower frequency because rotation requires
updating the webhook URL in ShipStation's dashboard for every webhook
endpoint.

1. Generate a new HMAC secret (`openssl rand -hex 32`).
2. Update Vercel + `.env.production`.
3. ShipStation dashboard → Webhooks → for each registered webhook,
   update the secret to the new value.
4. Verify with a manual test event from ShipStation.

## SHOPIFY_ADMIN_API_TOKEN (Clandestine Shopify)

Cadence: every 90 days.

1. Shopify admin → Apps → Custom App → Configuration → API credentials.
   Click "Rotate access token". Copy the new value.
2. Update Vercel + `.env.production`. Re-deploy + Trigger redeploy.
3. Verify by running the `clandestine-shopify-sync` task in dry-run
   mode (or call `productSet` with a no-op edit on a known product).

## SHOPIFY_WEBHOOK_SECRET

Cadence: rotate when Shopify rotates it (we don't pick this — it's the
shared secret with Shopify's webhook signing). Update process: just
sync the new value from Shopify Partners dashboard into Vercel +
`.env.production`.

## SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (client store OAuth)

Cadence: every 180 days. Rotation invalidates currently-installed
OAuth tokens for client stores. Do NOT rotate without first warning
clients.

## STRIPE_SECRET_KEY

Cadence: every 90 days.

1. Stripe dashboard → Developers → API keys → Roll secret key.
2. Update Vercel + `.env.production`. Re-deploy.
3. Verify by hitting Stripe customer list from a Server Action.
4. After 24h of clean traffic, the old key is automatically expired
   by Stripe (configurable on the dashboard).

## STRIPE_WEBHOOK_SECRET

Cadence: every 90 days. Rotation requires creating a new webhook
endpoint in Stripe dashboard temporarily, then deleting the old one.

## RESEND_API_KEY / RESEND_INBOUND_WEBHOOK_SECRET

Cadence: every 180 days.

1. Resend dashboard → API Keys → Create new key. Old key remains valid
   until you delete it.
2. Update Vercel + `.env.production`. Re-deploy.
3. Verify by sending a test email through the support-escalation task.
4. Rotate the inbound webhook secret on the same cadence.

## AFTERSHIP_API_KEY / AFTERSHIP_WEBHOOK_SECRET

Cadence: every 180 days. Same pattern as Resend.

## DISCOGS_CONSUMER_KEY / DISCOGS_CONSUMER_SECRET

Cadence: every 180 days. Discogs OAuth requires re-consent for client
connections after rotation; coordinate with clients.

## TRIGGER_SECRET_KEY

Cadence: every 90 days.

1. Trigger.dev dashboard → Project Settings → Secret Keys → Rotate.
2. Update Vercel ONLY (NOT `.env.production` — `syncEnvVars()` excludes
   this var; see `trigger.config.ts`).
3. Re-deploy Vercel. Verify by triggering any task from a Server Action.

---

## Rotation log

Append a row each time a secret is rotated. Keep this log in this file
so the next rotator can see when the previous one happened.

| Date | Secret | Rotated by | Verified by | Notes |
|------|--------|-----------|-------------|-------|
| 2026-04-13 | (initial creation, no rotations yet) | tomabbs | n/a | Tier 1 hardening pass — runbook authored. |

## Out-of-scope (operator-only)

- Vercel project deploy-protection bypass tokens — Vercel team only.
- Supabase database superuser password — never used by the app, do not
  expose into env vars.
- GitHub Actions tokens — set per-repo by the operator; Dependabot
  config (Tier 1 #6) handles dependency-update PRs.
