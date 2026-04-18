# Clandestine Fulfillment

3PL warehouse management application for independent record labels. Staff portal for warehouse operations, client portal for label owners.

## Tech Stack

- **Framework**: Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui
- **Database**: Supabase (Postgres + Auth + RLS + Realtime + Storage)
- **Background Jobs**: Trigger.dev v4 (25 tasks, cron schedules)
- **Cache**: Upstash Redis (inventory ledger, idempotency keys)
- **Integrations**: Shopify, Bandcamp, ShipStation, AfterShip, Stripe, Resend
- **Monitoring**: Sentry (error tracking), custom sensor framework
- **Testing**: Vitest (437 unit tests), Playwright (E2E)
- **Linting**: Biome (not ESLint)

## Getting Started

### Prerequisites

- Node.js **22+** (see `.nvmrc`; aligns with CI)
- pnpm 10+
- Supabase CLI (for local development)

### Setup

```bash
# Clone and install
git clone <repo-url>
cd clandestine-fulfillment
pnpm install

# Copy environment template
cp .env.example .env.local
# Fill in all required values (see docs/DEPLOYMENT.md)

# Apply database migrations
supabase db push

# Start development
pnpm dev
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start dev server |
| `pnpm build` | Production build |
| `pnpm test` | Run Vitest unit tests |
| `pnpm test:e2e` | Run Playwright E2E tests |
| `pnpm check` | Biome lint + format check |
| `pnpm check:fix` | Auto-fix Biome issues |
| `pnpm typecheck` | TypeScript type check |
| `pnpm verify:cloud` | Lint, typecheck, test, production build (CI-style env), CI guard scripts — for [Cursor Cloud Agents](docs/CURSOR_CLOUD_AGENT.md) |

## Cursor Cloud Agents

Remote agents (e.g. from [cursor.com/agents](https://cursor.com/agents)) should read **[AGENTS.md](AGENTS.md)** and **[docs/CURSOR_CLOUD_AGENT.md](docs/CURSOR_CLOUD_AGENT.md)** for install commands, Secrets vs `.env`, and copy-paste prompts. This repo includes [`.cursor/environment.json`](.cursor/environment.json) with `pnpm install --frozen-lockfile` and [`scripts/cloud-agent-verify.sh`](scripts/cloud-agent-verify.sh) for CI-parity checks.

## Architecture

### Portals

- **Staff Portal** (`/admin/*`) — warehouse operations, client management, billing, integrations
- **Client Portal** (`/portal/*`) — inventory visibility, inbound submissions, billing statements, support

### Key Design Decisions

- **Single inventory write path** (Rule #20): All changes flow through `recordInventoryChange()`
- **Webhook idempotency** (Rule #47): Redis SETNX + Lua script guards against double-processing
- **Billing immutability** (Rule #29): Snapshots are never modified; adjustments are separate rows
- **FIFO pre-order allocation** (Rule #69): Orders allocated by `created_at ASC`
- **Circuit breakers** (Rule #53): Client store connections auto-disable after 5 auth failures

### Database

38 tables across 11 migrations with RLS on all org-scoped tables. See `supabase/migrations/`.

### Background Tasks

25 Trigger.dev tasks handling: Shopify sync, Bandcamp sync, order polling, inventory pushes, billing, tracking, sensor checks, and more.

## Documentation

- [Cursor Cloud Agents](docs/CURSOR_CLOUD_AGENT.md) — Cloud Agent / Secrets, verify script, manual setup
- [Deployment Guide](docs/DEPLOYMENT.md) — environment setup, webhook configuration, post-deploy checklist
- [Operations Runbook](docs/RUNBOOK.md) — handling common incidents and operational procedures
- [CLAUDE.md](CLAUDE.md) — 72 architectural rules and conventions

## Testing

```bash
# Unit tests (437 tests across 46 files)
pnpm test

# E2E tests (requires dev server + Supabase)
pnpm dev & pnpm test:e2e

# Contract tests
pnpm test -- tests/contract/

# CI guard scripts
bash scripts/ci-inventory-guard.sh
bash scripts/ci-webhook-dedup-guard.sh
```
