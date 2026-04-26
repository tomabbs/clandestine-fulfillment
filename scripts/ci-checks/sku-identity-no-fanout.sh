#!/usr/bin/env bash
# Phase 1 — CI guard: autonomous SKU identity rows MUST NEVER be read in
# fanout / multi-store-push / webhook-write paths.
#
# Plan ref: autonomous_sku_matching_da557209.plan.md
#   §"Fanout safety" → "CI grep guard"
#   §"New table: client_store_product_identity_matches" →
#     "Rows in this table MUST NEVER be read by inventory-fanout.ts,
#      client-store-fanout-gate.ts, multi-store-inventory-push, or any
#      webhook write path. The one allowed consumer outside the
#      autonomous pipeline is evaluateOrderForHold(), which lives in a
#      dedicated module that the webhook task imports."
#
# This guard is additive to the existing check-fanout-gate.sh guard. It
# does NOT validate correctness of evaluateOrderForHold(); it only
# enforces the structural invariant that the identity table name never
# appears as a literal in the guarded files. Any future attempt to
# read identity rows for fanout purposes will fail CI.
#
# Release gate: SKU-AUTO-fanout-isolation (documented in
# docs/RELEASE_GATE_CRITERIA.md under the SKU-AUTO-* namespace).

set -euo pipefail

cd "$(dirname "$0")/../.."

# Files that must NEVER reference the identity table. These are the
# canonical fanout / multi-store-push / webhook-write paths. Any new
# fanout path added in the future should be added to this list.
GUARDED_FILES=(
  "src/lib/server/inventory-fanout.ts"
  "src/lib/server/client-store-fanout-gate.ts"
  "src/trigger/tasks/multi-store-inventory-push.ts"
  "src/trigger/tasks/process-client-store-webhook.ts"
)

IDENTITY_TABLE="client_store_product_identity_matches"

VIOLATIONS=()

for file in "${GUARDED_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    # Missing guarded file — fail loudly so the guard cannot be
    # silently bypassed by renaming the file.
    echo "ERROR: guarded file not found: $file"
    echo "If the file has been renamed, update scripts/ci-checks/sku-identity-no-fanout.sh"
    echo "to point at the new canonical path."
    exit 1
  fi

  if grep -q "$IDENTITY_TABLE" "$file"; then
    VIOLATIONS+=("$file")
  fi
done

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  echo "ERROR: Autonomous SKU identity rows must never be read in fanout paths."
  echo ""
  echo "Plan ref: autonomous_sku_matching_da557209.plan.md §\"Fanout safety\"."
  echo ""
  echo "The following files reference \`$IDENTITY_TABLE\` and would"
  echo "break the Option B commitment that identity rows are never consumed"
  echo "by fanout:"
  echo ""
  printf '  %s\n' "${VIOLATIONS[@]}"
  echo ""
  echo "If you need to classify a line as identity_only_match for order-hold"
  echo "purposes, do it via evaluateOrderForHold() (which lives in its own"
  echo "module) and have the webhook task IMPORT that function rather than"
  echo "querying the identity table directly."
  exit 1
fi

echo "OK: No fanout path references $IDENTITY_TABLE."
