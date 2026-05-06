#!/usr/bin/env bash

set -uo pipefail

RUN_E2E=0
RUN_INVENTORY_SYNC_PREFLIGHT=0
INVENTORY_WORKSPACE_ID=""
INVENTORY_CONNECTION_ID=""
INVENTORY_ORG_ID=""
MARKDOWN_PREFLIGHT=0
for arg in "$@"; do
  case "$arg" in
    --with-e2e)
      RUN_E2E=1
      ;;
    --inventory-sync-preflight)
      RUN_INVENTORY_SYNC_PREFLIGHT=1
      ;;
    --workspace-id=*)
      INVENTORY_WORKSPACE_ID="${arg#*=}"
      ;;
    --connection-id=*)
      INVENTORY_CONNECTION_ID="${arg#*=}"
      ;;
    --org-id=*)
      INVENTORY_ORG_ID="${arg#*=}"
      ;;
    --preflight-markdown)
      MARKDOWN_PREFLIGHT=1
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: bash scripts/release-gate.sh [--with-e2e] [--inventory-sync-preflight --workspace-id=<uuid> [--connection-id=<uuid>] [--org-id=<uuid>] [--preflight-markdown]]"
      exit 2
      ;;
  esac
done

step() {
  local name="$1"
  echo ""
  echo "==> $name"
}

declare -a FAILURES=()

run_cmd() {
  local label="$1"
  shift
  echo "  -> $label"
  if "$@"; then
    echo "     [PASS] $label"
  else
    echo "     [FAIL] $label"
    FAILURES+=("$label")
  fi
}

echo "Release Gate Runner"
echo "Automated checks start now."

step "Section A: Static + build checks"
run_cmd "Biome check" pnpm check
run_cmd "TypeScript check" pnpm typecheck
run_cmd "Unit/contract test suite" pnpm test
run_cmd "Next build" pnpm build
run_cmd "Inventory guard" bash scripts/ci-inventory-guard.sh
run_cmd "Webhook dedup guard" bash scripts/ci-webhook-dedup-guard.sh
run_cmd "Notification status writes guard" bash scripts/check-notification-status-writes.sh
run_cmd "Client store fanout-gate guard" bash scripts/check-fanout-gate.sh
run_cmd "ShipStation v2 inventory batch guard" bash scripts/check-v2-inventory-batch.sh
run_cmd "InventorySource ↔ DB CHECK sync guard" npx tsx scripts/check-source-union-sync.ts
run_cmd "SKU identity rows not read in fanout guard" bash scripts/ci-checks/sku-identity-no-fanout.sh
run_cmd "SKU alias single-writer guard (SKU-AUTO-2)" bash scripts/ci-checks/sku-aliases-single-writer.sh

if [ "$RUN_INVENTORY_SYNC_PREFLIGHT" -eq 1 ]; then
  step "Section A.1: Inventory sync cutover preflight"
  if [ -z "$INVENTORY_WORKSPACE_ID" ]; then
    echo "  -> [FAIL] Inventory sync preflight requires --workspace-id=<uuid>"
    FAILURES+=("Inventory sync preflight missing workspace id")
  else
    PREFLIGHT_ARGS=(scripts/inventory-sync-preflight.ts --strict --workspace-id "$INVENTORY_WORKSPACE_ID")
    if [ -n "$INVENTORY_CONNECTION_ID" ]; then
      PREFLIGHT_ARGS+=(--connection-id "$INVENTORY_CONNECTION_ID")
    fi
    if [ -n "$INVENTORY_ORG_ID" ]; then
      PREFLIGHT_ARGS+=(--org-id "$INVENTORY_ORG_ID")
    fi
    if [ "$MARKDOWN_PREFLIGHT" -eq 1 ]; then
      PREFLIGHT_ARGS+=(--markdown)
    fi
    run_cmd "Inventory sync cutover preflight" npx tsx "${PREFLIGHT_ARGS[@]}"
  fi
fi

step "Section B: Focused reliability regression tests"
run_cmd "Support/inbound/invite envelope tests" pnpm vitest run tests/unit/actions/support-envelope.test.ts tests/unit/actions/inbound-create-envelope.test.ts tests/unit/actions/users-invite-envelope.test.ts

if [ "$RUN_E2E" -eq 1 ]; then
  step "Section C: Critical E2E subset"
  run_cmd "Inbound + Inventory E2E" pnpm test:e2e -- tests/e2e/inbound-flow.spec.ts tests/e2e/inventory-flow.spec.ts
else
  step "Section C: Critical E2E subset"
  echo "  -> skipped (pass --with-e2e to run)"
fi

step "Section D: Manual checks required (cannot auto-run from local script)"
echo "  1) Run SQL parity checks in target environment:"
echo "     - scripts/sql/prod_parity_checks.sql"
echo "  2) Run webhook health snapshot in target environment:"
echo "     - scripts/sql/webhook_health_snapshot.sql"
echo "  3) Complete Trigger smoke checklist:"
echo "     - docs/TRIGGER_SMOKE_CHECKLIST.md"
echo "  4) Confirm integration registration matrix fields (owner/status/date):"
echo "     - docs/INTEGRATION_REGISTRATION_MATRIX.md"

echo ""
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "Automated release gate checks completed successfully."
  echo "Next: finish manual checks listed above before deployment."
  exit 0
fi

echo "Automated release gate checks completed with failures:"
for f in "${FAILURES[@]}"; do
  echo "  - $f"
done
echo ""
echo "Fix failures above, then rerun. Manual checks are still required."
exit 1
