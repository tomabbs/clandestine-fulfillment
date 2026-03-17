# Deployment Guide

## Environment Variables

All variables from `src/lib/shared/env.ts`. Set in Vercel dashboard or `.env.local`.

### Supabase
- `NEXT_PUBLIC_SUPABASE_URL` — project URL (https://xxx.supabase.co)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — public anon key
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (server-only, never expose)
- `DATABASE_URL` — pooled connection (port 6543, `?pgbouncer=true`)
- `DIRECT_URL` — direct connection (port 5432, migrations only)

### Trigger.dev
- `TRIGGER_SECRET_KEY` — production secret key

### Upstash Redis
- `UPSTASH_REDIS_REST_URL` — Redis REST endpoint
- `UPSTASH_REDIS_REST_TOKEN` — Redis auth token

### Sentry
- `NEXT_PUBLIC_SENTRY_DSN` — Sentry DSN
- `SENTRY_ORG` — Sentry organization slug
- `SENTRY_PROJECT` — Sentry project slug
- `SENTRY_AUTH_TOKEN` — Sentry auth token (for source map uploads)

### Shopify
- `SHOPIFY_STORE_URL` — store URL (https://store.myshopify.com)
- `SHOPIFY_ADMIN_API_TOKEN` — Admin API access token
- `SHOPIFY_API_VERSION` — API version (e.g., 2024-01)

### ShipStation
- `SHIPSTATION_API_KEY` — API key
- `SHIPSTATION_API_SECRET` — API secret
- `SHIPSTATION_WEBHOOK_SECRET` — webhook HMAC secret

### AfterShip
- `AFTERSHIP_API_KEY` — API key
- `AFTERSHIP_WEBHOOK_SECRET` — webhook HMAC secret

### Stripe
- `STRIPE_SECRET_KEY` — secret key (sk_live_xxx)
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (whsec_xxx)

### Bandcamp
- `BANDCAMP_CLIENT_ID` — OAuth client ID
- `BANDCAMP_CLIENT_SECRET` — OAuth client secret

### Resend
- `RESEND_API_KEY` — API key
- `RESEND_INBOUND_WEBHOOK_SECRET` — Svix webhook secret

### App
- `NEXT_PUBLIC_APP_URL` — production URL (https://app.clandestine.com)

## Supabase Configuration

1. **Auth Providers**: Enable Google OAuth (staff) and Magic Link (clients)
2. **Redirect URLs**: Add `{NEXT_PUBLIC_APP_URL}/auth/callback`
3. **RLS**: Verify all 38 tables have RLS enabled (migration 009)
4. **Migrations**: Run `supabase db push` to apply all 11 migrations

## Trigger.dev

1. Deploy tasks: `npx trigger.dev@latest deploy`
2. Verify all 25 tasks appear in the dashboard
3. Cron schedules are defined in task files — they auto-register on deploy

## Webhook Endpoints

Configure these URLs in each platform's webhook settings:

| Platform | URL | Events |
|----------|-----|--------|
| Stripe | `{APP_URL}/api/webhooks/stripe` | invoice.paid, invoice.payment_failed |
| ShipStation | `{APP_URL}/api/webhooks/shipstation` | SHIP_NOTIFY |
| AfterShip | `{APP_URL}/api/webhooks/aftership` | tracking updates |
| Resend | `{APP_URL}/api/webhooks/resend-inbound` | email.received |
| Client Stores | `{APP_URL}/api/webhooks/client-store?connection_id={id}&platform={platform}` | orders, inventory |

## Post-Deploy Checklist

- [ ] All env vars set in Vercel
- [ ] Supabase migrations applied
- [ ] Auth providers configured
- [ ] Trigger.dev tasks deployed
- [ ] Webhook URLs registered in each platform
- [ ] First Shopify full backfill triggered
- [ ] Redis backfill task runs successfully
- [ ] Sensor check cron produces healthy readings
- [ ] Staff user can log in via Google OAuth
- [ ] Client user can log in via magic link
