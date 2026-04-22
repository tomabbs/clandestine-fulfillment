#!/usr/bin/env bash
# Cloud Agent / CI-parity verification: lint, typecheck, unit tests, Next build (minimal public env), guard scripts.
# Does not run Playwright E2E (requires dev server + full secrets).
# Usage: from repo root — bash scripts/cloud-agent-verify.sh
# Ensure executable: chmod +x scripts/cloud-agent-verify.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-https://placeholder.supabase.co}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-placeholder}"
export NEXT_PUBLIC_SENTRY_DSN="${NEXT_PUBLIC_SENTRY_DSN:-https://placeholder@sentry.io/0}"
export NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-https://placeholder.vercel.app}"

echo "==> pnpm check"
pnpm check

echo "==> pnpm typecheck"
pnpm typecheck

echo "==> pnpm test"
pnpm test

echo "==> pnpm build (Tier A / CI-style env)"
pnpm build

echo "==> CI guard: inventory write-path"
bash scripts/ci-inventory-guard.sh

echo "==> CI guard: webhook dedup"
bash scripts/ci-webhook-dedup-guard.sh

echo "==> CI guard: webhook runtime (F-2)"
bash scripts/check-webhook-runtime.sh

echo "==> CI guard: fulfilled_quantity write-only (F-1)"
bash scripts/check-fulfilled-quantity-writers.sh

echo "cloud-agent-verify.sh: all steps passed."
