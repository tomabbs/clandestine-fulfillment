#!/usr/bin/env bash
# F-7 — Direct Shopify cutover release gate check.
#
# Asserts the four hard gates listed in
# docs/RELEASE_GATE_CRITERIA.md → Section C.1 are green BEFORE tagging a
# cutover build. Run on `main` from the repo root:
#
#   bash scripts/check-release-gates.sh
#
# Exits non-zero on any failed gate; prints a one-line summary per gate so
# the GitHub Actions log clearly shows which gate failed.
#
# Gates:
#   HRD-08.1   Partial-cancel recredit honors fulfilled_quantity
#   HRD-23     Every webhook route exports runtime=nodejs + dynamic=force-dynamic
#   HRD-10     OAuth verifies myshopifyDomain + persists shopify_verified_domain
#   HRD-35.3   registerShopifyWebhookSubscriptions runs on install + idempotent
#
# Schema gates (HRD-08.1 partial fulfillment, F-4 dedup_key, F-5 verified
# domain, B-3 webhook health columns, B-4 shopify_direct_available) require
# `DATABASE_URL` and `psql` on PATH. If `DATABASE_URL` is unset, schema
# checks are skipped and the script prints a clear `SKIP` line so an
# operator knows which gates still need confirmation; the test-file gates
# remain enforced regardless.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

GATE_FAILURES=0
GATE_SKIPS=0

emit_pass() { printf "  PASS  %s — %s\n" "$1" "$2"; }
emit_skip() { printf "  SKIP  %s — %s\n" "$1" "$2"; GATE_SKIPS=$((GATE_SKIPS + 1)); }
emit_fail() { printf "  FAIL  %s — %s\n" "$1" "$2"; GATE_FAILURES=$((GATE_FAILURES + 1)); }

printf "==> Direct-Shopify cutover release gates (Section C.1)\n\n"

# ─── HRD-23 — webhook runtime + fulfilled_quantity write-only guards ─────────
if bash scripts/check-webhook-runtime.sh >/dev/null 2>&1; then
  emit_pass "HRD-23a" "scripts/check-webhook-runtime.sh"
else
  emit_fail "HRD-23a" "scripts/check-webhook-runtime.sh failed — re-run for details"
fi

if bash scripts/check-fulfilled-quantity-writers.sh >/dev/null 2>&1; then
  emit_pass "HRD-23b" "scripts/check-fulfilled-quantity-writers.sh"
else
  emit_fail "HRD-23b" "scripts/check-fulfilled-quantity-writers.sh failed — re-run for details"
fi

# ─── Phase 1 §9.2 D8 / N-13 / X-7 — push-formula source-of-truth guard ───────
# Bans inline `Math.max(0, *available* - *safety*)` reconstructions outside
# the `effective-sellable.ts` helper. Without this guard, a focused per-SKU
# push and the 5-min cron sweep can silently disagree on push value, causing
# Bandcamp / Shopify inventory to oscillate per drop.
if bash scripts/check-push-formula-helper.sh >/dev/null 2>&1; then
  emit_pass "P1-D8" "scripts/check-push-formula-helper.sh"
else
  emit_fail "P1-D8" "scripts/check-push-formula-helper.sh failed — re-run for details"
fi

# ─── Test-file gates ─────────────────────────────────────────────────────────
# Each gate is one vitest invocation. Vitest exits non-zero on any failure.
run_test_gate() {
  local gate_id="$1"
  local description="$2"
  shift 2
  if pnpm vitest run "$@" >/dev/null 2>&1; then
    emit_pass "$gate_id" "$description"
  else
    emit_fail "$gate_id" "$description (re-run \`pnpm vitest run $*\` for details)"
  fi
}

run_test_gate "HRD-08.1" "process-client-store-webhook partial-cancel suite" \
  "tests/unit/trigger/process-client-store-webhook.test.ts"

run_test_gate "HRD-10" "/api/oauth/shopify shop-domain verify suite" \
  "tests/unit/api/oauth/shopify-route.test.ts"

run_test_gate "HRD-35.3" "shopify-webhook-subscriptions registrar + diff suite" \
  "tests/unit/lib/server/shopify-webhook-subscriptions.test.ts"

# Phase 0 §9.1 D6 — GDPR webhook secret resolver release gate.
# Asserts resolveShopifyGdprWebhookSecrets returns ≥1 non-empty candidate
# whenever a connection has shopify_app_client_secret_encrypted set OR
# env.SHOPIFY_CLIENT_SECRET is set. Without this, GDPR pings to per-client
# Custom-distribution apps would silently 401 and Shopify would drop the
# subscription on next App Store review.
run_test_gate "P0-D6" "Shopify GDPR webhook secret resolver (per-connection + env fallback)" \
  "tests/unit/lib/server/shopify-gdpr-secret.test.ts"

# ─── Schema gates (require DATABASE_URL + psql) ──────────────────────────────
if [[ -z "${DATABASE_URL:-}" ]] || ! command -v psql >/dev/null 2>&1; then
  emit_skip "schema" "DATABASE_URL or psql unavailable — finish-line columns NOT verified"
else
  REQUIRED_COLUMNS=(
    "warehouse_order_items|fulfilled_quantity"
    "client_store_connections|shopify_verified_domain"
    "client_store_connections|last_webhook_at"
    "client_store_connections|webhook_topic_health"
    "client_store_connections|webhook_subscriptions_audit_at"
    "webhook_events|dedup_key"
    "megaplan_spot_check_runs|shopify_direct_available"
  )
  ALL_COLS_OK=1
  for entry in "${REQUIRED_COLUMNS[@]}"; do
    table="${entry%|*}"
    column="${entry#*|}"
    found=$(psql "$DATABASE_URL" -tAc "select 1 from information_schema.columns where table_name='${table}' and column_name='${column}' limit 1" 2>/dev/null || echo "")
    if [[ "$found" != "1" ]]; then
      emit_fail "schema" "missing column ${table}.${column} (apply 20260423000002_finish_plan_columns.sql)"
      ALL_COLS_OK=0
    fi
  done
  if [[ "$ALL_COLS_OK" == "1" ]]; then
    emit_pass "schema" "all 7 finish-line columns present"
  fi
fi

# ─── Org-constraint gate (P9 — merge_organizations_txn coverage) ─────────────
# Requires DATABASE_URL + psql (same shape as the schema gate above). Catches
# org_id-bearing tables that aren't registered in merge_organizations_txn's
# v_tables array — would trip merge_delete_failed at cutover.
if [[ -z "${DATABASE_URL:-}" ]] || ! command -v psql >/dev/null 2>&1; then
  emit_skip "org-constraints" "DATABASE_URL or psql unavailable — merge_organizations_txn coverage NOT verified"
else
  if bash scripts/check-org-constraints.sh >/dev/null 2>&1; then
    emit_pass "org-constraints" "every org_id table registered in merge_organizations_txn.v_tables"
  else
    emit_fail "org-constraints" "scripts/check-org-constraints.sh failed — re-run for the missing-table list"
  fi
fi

# ─── Env-flag gates ──────────────────────────────────────────────────────────
if [[ "${SHOPIFY_API_VERSION:-}" == "2026-01" ]]; then
  emit_pass "env-shopify-version" "SHOPIFY_API_VERSION=2026-01"
else
  emit_fail "env-shopify-version" "SHOPIFY_API_VERSION must be '2026-01' (got '${SHOPIFY_API_VERSION:-<unset>}')"
fi

if [[ -n "${WEBHOOK_ECHO_SHOPIFY_DIRECT+x}" ]]; then
  emit_pass "env-echo-flag" "WEBHOOK_ECHO_SHOPIFY_DIRECT explicitly set (value: '${WEBHOOK_ECHO_SHOPIFY_DIRECT}')"
else
  emit_fail "env-echo-flag" "WEBHOOK_ECHO_SHOPIFY_DIRECT must be explicitly set (value 'off' is fine pre-cutover)"
fi

printf "\n==> Summary: %d failure(s), %d skip(s)\n" "$GATE_FAILURES" "$GATE_SKIPS"

if [[ "$GATE_FAILURES" -gt 0 ]]; then
  printf "==> RELEASE BLOCKED — fix the FAIL lines above before tagging a cutover build.\n"
  exit 1
fi

if [[ "$GATE_SKIPS" -gt 0 ]]; then
  printf "==> Release gates green for the checks that ran. SKIP lines must be confirmed manually before cutover.\n"
fi

exit 0
