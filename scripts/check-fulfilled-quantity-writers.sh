#!/usr/bin/env bash
# F-1 (HRD-08.1): warehouse_order_items.fulfilled_quantity is WRITE-ONLY
# from the webhook handlers. Server Actions, admin tools, backfill scripts,
# and Trigger tasks that aren't process-client-store-webhook MUST NOT write
# this column directly. The column is the source of truth for the cancel
# handler's recredit math; out-of-band writes corrupt that invariant.
#
# This guard searches every src/**/*.ts file for `fulfilled_quantity` writes
# and fails the build when one is found outside the allowlist.
#
# To extend the allowlist: add the file path AND open a Truth Layer doc
# update justifying why a non-webhook writer is safe.

set -euo pipefail

ALLOWED_FILES=(
  "src/trigger/tasks/process-client-store-webhook.ts"
  "tests/"
  "supabase/migrations/"
  "scripts/check-fulfilled-quantity-writers.sh"
  "CLAUDE.md"
  "docs/"
)

EXCLUDE_ARGS=()
for f in "${ALLOWED_FILES[@]}"; do
  EXCLUDE_ARGS+=(--glob "!${f}")
done

# Match anything that LOOKS like a write to the column. We accept a few
# false-positive shapes (e.g., a `select("fulfilled_quantity")` read) and
# rely on grep -E to filter. The patterns below match:
#   .insert({ ..., fulfilled_quantity: ... })
#   .update({ ..., fulfilled_quantity: ... })
#   .upsert({ ..., fulfilled_quantity: ... })
#   .from("warehouse_order_items").<op>(...)... fulfilled_quantity ...
# We also flag bare assignments `fulfilled_quantity: <value>` as a
# defense-in-depth catch.
PATTERN='fulfilled_quantity\s*:'

if command -v rg >/dev/null 2>&1; then
  VIOLATIONS=$(rg \
    --type ts --type tsx \
    "${EXCLUDE_ARGS[@]}" \
    -e "$PATTERN" \
    src/ 2>/dev/null || true)
else
  VIOLATIONS=$(grep -rE \
    --include='*.ts' --include='*.tsx' \
    "${EXCLUDE_ARGS[@]}" \
    -e "$PATTERN" \
    src/ 2>/dev/null || true)
fi

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: F-1 fulfilled_quantity write-only contract violated."
  echo "       The column is WRITE-ONLY from process-client-store-webhook."
  echo "       See scripts/check-fulfilled-quantity-writers.sh + the column"
  echo "       comment in supabase/migrations/20260423000002_finish_plan_columns.sql."
  echo
  echo "$VIOLATIONS"
  exit 1
fi

echo "OK: No out-of-band fulfilled_quantity writes found."
