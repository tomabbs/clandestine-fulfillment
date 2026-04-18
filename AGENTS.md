# Agent instructions — clandestine-fulfillment

## Project

3PL warehouse management for independent record labels (Next.js 14, Supabase, Trigger.dev, Upstash Redis). Staff portal (`/admin/*`) and client portal (`/portal/*`).

## Before coding

1. Read **[CLAUDE.md](CLAUDE.md)** for architectural rules and conventions (inventory write path, webhooks, billing, etc.).
2. For environment and Cursor Cloud setup, read **[docs/CURSOR_CLOUD_AGENT.md](docs/CURSOR_CLOUD_AGENT.md)**.

## Default commands (repo root)

| Task | Command |
|------|---------|
| Install | `pnpm install --frozen-lockfile` |
| Lint | `pnpm check` |
| Format fix | `pnpm check:fix` |
| Typecheck | `pnpm typecheck` |
| Unit tests | `pnpm test` |
| Build | `pnpm build` (needs env — see Cloud doc) |
| Full verify (lint + types + tests + build + CI guards) | `pnpm verify:cloud` or `bash scripts/cloud-agent-verify.sh` |

Use **Node 22+** and **pnpm 10+** (see `.nvmrc` and `package.json` engines).

## After substantive edits

Run at least: `pnpm check`, `pnpm typecheck`, and `pnpm test`. For release-style validation, run `bash scripts/cloud-agent-verify.sh`.

## Cursor Cloud Agents

- Prefer **Cursor Secrets / Dashboard** for API keys — do not commit `.env.local` or real credentials.
- For `pnpm build` without a full `.env`, use the **minimal public placeholders** described in [docs/CURSOR_CLOUD_AGENT.md](docs/CURSOR_CLOUD_AGENT.md) (same pattern as `.github/workflows/ci.yml`).
- Work in **small checkpoints**. Before large refactors, new tables, or API contract changes, **stop and ask** the operator with options.
- Prefer **reversible** changes (small commits, feature flags where appropriate).
- Summarize **blockers** clearly; avoid silent assumptions.
- Keep status updates **concise** so they can be read on a phone.

## Secrets and automation limits

- **Supabase CLI**: `supabase login` / `supabase link` require human or pre-provisioned credentials — see [docs/CURSOR_CLOUD_AGENT.md](docs/CURSOR_CLOUD_AGENT.md).
- **Trigger.dev**: `npx trigger.dev@latest deploy` uses `TRIGGER_SECRET_KEY` — typically CI or manual deploy, not required for `pnpm build` / unit tests.

## Optional

- E2E: `pnpm test:e2e` — requires dev server, full env, and Playwright; heavier than the default verify script.
