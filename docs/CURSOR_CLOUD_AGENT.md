# Cursor Cloud Agents — clandestine-fulfillment

This document supports [Cursor Cloud Agents](https://cursor.com/docs/cloud-agents) and local agents working in this repo. Also read [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md).

## Official Cursor links

- [Cloud Agents overview](https://cursor.com/docs/cloud-agents)
- [Cloud Agent setup — environment, `environment.json`, Secrets](https://cursor.com/docs/cloud-agent/setup)
- Onboarding: [cursor.com/onboard](https://cursor.com/onboard) (first-time environment setup)

## Prerequisites

| Tool | Version | Notes |
|------|---------|--------|
| Node.js | **22+** | Matches [`.github/workflows/ci.yml`](../.github/workflows/ci.yml); see `.nvmrc` |
| pnpm | **10+** | Lockfile: `pnpm-lock.yaml` |
| Supabase CLI | Latest | For `supabase db push` / migrations — install separately |

Repo layout: app lives at the repository root (`clandestine-fulfillment`). If `supabase/config.toml` is missing in your clone, obtain it from your team or run `supabase init` / link per [Supabase CLI](https://supabase.com/docs/guides/cli) docs before pushing migrations.

## Environment tiers

### Tier A — CI-style build (minimal secrets)

Used by GitHub Actions for `pnpm build` and by `scripts/cloud-agent-verify.sh` for the build step. **Does not** satisfy runtime `env()` for a long-running `pnpm dev` session.

Set these in **Cursor Dashboard → Cloud Agents → Secrets** (or export in shell):

```bash
export NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder"
export NEXT_PUBLIC_SENTRY_DSN="https://placeholder@sentry.io/0"
export NEXT_PUBLIC_APP_URL="https://placeholder.vercel.app"
```

Same values as in `.github/workflows/ci.yml` (Next.js build step).

### Tier B — Full application (dev / integration / E2E)

Copy [`.env.example`](../.env.example) to `.env.local` locally, or add **all** required variables to Cursor Secrets. Server validation is in [`src/lib/shared/env.ts`](../src/lib/shared/env.ts) (`env()` / Zod).

Required categories include: Supabase (URL, anon, service role, `DATABASE_URL`, `DIRECT_URL`), Upstash Redis, Sentry, Shopify, AfterShip, Stripe, Bandcamp, Resend, etc. Use **dev/test** projects — never commit production keys.

### What cannot be fully automated in a clean VM

| Task | Why |
|------|-----|
| `supabase login` | Browser / token |
| `supabase link` | Project ref + auth |
| OAuth flows (Shopify, Bandcamp, …) | Browser / user consent |
| Trigger.dev production deploy | `TRIGGER_SECRET_KEY` in CI secrets or manual |

## Repo automation for agents

| File / script | Purpose |
|----------------|---------|
| [`.cursor/environment.json`](../.cursor/environment.json) | Default `install` for Cloud Agent VM ([resolution order](https://cursor.com/docs/cloud-agent/setup)) |
| [`scripts/cloud-agent-verify.sh`](../scripts/cloud-agent-verify.sh) | Lint, typecheck, test, build (Tier A env), CI guard scripts |

Make the verify script executable once: `chmod +x scripts/cloud-agent-verify.sh`

## Manual setup in Cursor (operator checklist)

### 1. GitHub or GitLab

1. Connect your **GitHub** or **GitLab** account to Cursor with **read-write** access to this repository ([docs](https://cursor.com/docs/cloud-agents)).
2. Ensure organization policies allow Cursor’s integration to create branches and open PRs if you use that workflow.

### 2. Cloud Agent environment

1. Complete [onboarding](https://cursor.com/onboard) if prompted, or rely on this repo’s `.cursor/environment.json` plus Secrets.
2. Open **Dashboard → Cloud Agents → [Secrets](https://cursor.com/docs/cloud-agent/setup)** and add Tier A variables at minimum for build verification; add Tier B for dev/E2E.
3. **Restart** the agent after changing Secrets (Cursor troubleshooting guidance).

### 3. Billing / access

- Cloud Agents require a plan with **on-demand usage** enabled where applicable ([docs](https://cursor.com/docs/cloud-agents)).
- Cloud Agents run in **Max Mode** for models (no toggle off).

### 4. Commands reference

| Step | Command |
|------|---------|
| Install | `pnpm install --frozen-lockfile` |
| Verify (recommended) | `bash scripts/cloud-agent-verify.sh` |
| Dev server | `pnpm dev` (Tier B env) |
| E2E | `pnpm test:e2e` (Tier B + Playwright; not part of default verify) |

## Cloud Agents vs My Machines

| Use **Cloud Agents** when | Use **My Machines** when |
|----------------------------|---------------------------|
| You want runs from **phone / web** ([cursor.com/agents](https://cursor.com/agents)) | Keys must **not** leave your network |
| Parallel agents, no laptop online | You need **VPN** or **local** `supabase start` only on your box |
| You can put **dev/test** secrets in Cursor Secrets | You refuse cloud-stored credentials |

## Secrets checklist (Tier B — from `.env.example`)

Use your real dev/test values; do not paste production secrets into chat.

- [ ] `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `DATABASE_URL`, `DIRECT_URL`
- [ ] `TRIGGER_SECRET_KEY` (for Trigger deploy / tasks — not required for static `pnpm build` with Tier A)
- [ ] `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- [ ] `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`
- [ ] Shopify, Stripe, Bandcamp, Resend, AfterShip, EasyPost, etc. per [`.env.example`](../.env.example) and [`src/lib/shared/env.ts`](../src/lib/shared/env.ts)

## Appendix — copy-paste Cloud Agent prompts

Shared rules for all prompts: work in **small checkpoints**; **stop and ask** before major architecture changes; prefer **reversible** changes; run **`pnpm check`**, **`pnpm typecheck`**, **`pnpm test`** after meaningful edits; **summarize blockers**; **avoid silent assumptions**; keep updates **short** for mobile.

### A. Setup verification

```
You are working in the clandestine-fulfillment repo (Next.js 14, pnpm). Goal: VERIFY the Cloud Agent environment before feature work.

Rules: Work in small steps. Do not change product behavior unless a check fails and a minimal fix is required. After edits, run pnpm check, pnpm typecheck, pnpm test. If pnpm build is requested, use the same NEXT_PUBLIC_* placeholders as .github/workflows/ci.yml unless real secrets are already in the environment. Summarize blockers in bullets.

Steps:
1. Confirm Node and pnpm versions (expect Node 22+, pnpm 10+). If wrong, stop and report.
2. Run: pnpm install --frozen-lockfile
3. Run: bash scripts/cloud-agent-verify.sh (if missing, run: pnpm check && pnpm typecheck && pnpm test && pnpm build with CI placeholder env for build)
4. Report: pass/fail per step, and any missing tools (e.g. supabase CLI) as non-fatal unless the user asked for migrations.

End with a mobile-friendly summary: OK / not OK, next action if not OK.
```

### B. Main implementation (interactive)

```
You are in clandestine-fulfillment. Read AGENTS.md and CLAUDE.md before coding.

Goal: [DESCRIBE FEATURE / TICKET HERE]

Operating mode: Interactive. Work in phases with checkpoints. Before any large refactor, new table, or API contract change, STOP and ask me with 2–3 options and your recommendation. Prefer reversible steps (feature flags, small PR-sized commits).

After each logical chunk: (1) what you changed, (2) commands you ran, (3) results, (4) risks. Run pnpm check, pnpm typecheck, pnpm test after substantive code changes.

If blocked (missing secret, unclear requirement, failing test): stop, list the blocker in one short paragraph, and ask one concrete question.

Assume I may reply from a phone — keep updates concise.
```

### C. Checkpoint / status

```
Checkpoint. Read-only summary for mobile — no new code unless I ask.

Reply in exactly these sections:

1) Done: bullet list of what changed (files/areas only if known)
2) Blocked: bullets, or "None"
3) Decision needed: one question max, or "None"
4) Recommended next action: one sentence
5) Commands already run: single line or "None"

Keep total under ~120 words.
```
