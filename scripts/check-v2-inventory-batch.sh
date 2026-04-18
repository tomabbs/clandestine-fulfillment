#!/usr/bin/env bash
# Phase 2 — CI guard: ShipStation v2 inventory READS must batch.
#
# Plan ref: §7.1.6 ("batching is a code-level constraint, not just prose").
# The single chokepoint is `listInventory({ skus: [...] })` in
# src/lib/clients/shipstation-inventory-v2.ts. v2 has a ~60 req/min budget;
# a forgotten single-SKU convenience helper inside an admin page or task
# silently burns the budget under load.
#
# This script greps for forbidden symbol shapes and fails the build if any
# appear OUTSIDE the v2 client itself or its tests.

set -euo pipefail

cd "$(dirname "$0")/.."

# Forbidden symbol patterns (single-SKU v2 read helpers).
# Matches function declarations, exports, or named imports that imply a
# single-SKU lookup against the v2 inventory API.
FORBIDDEN_REGEX='\b(getInventoryBySku|findInventoryBySku|inventoryFor|getV2InventoryBySku|fetchInventoryBySku|readInventoryBySku|loadInventoryBySku)\b'

# Files / directories where the symbols are allowed (the client itself
# documents them as forbidden, and tests reference them by name).
ALLOWLIST=(
  "src/lib/clients/shipstation-inventory-v2.ts"
  "tests/unit/lib/clients/shipstation-inventory-v2.test.ts"
  "scripts/check-v2-inventory-batch.sh"
)

VIOLATIONS=()

while IFS= read -r file; do
  skip=0
  for allowed in "${ALLOWLIST[@]}"; do
    if [ "$file" = "$allowed" ]; then
      skip=1
      break
    fi
  done
  [ "$skip" -eq 1 ] && continue
  VIOLATIONS+=("$file")
done < <(grep -rlE --include='*.ts' --include='*.tsx' "$FORBIDDEN_REGEX" src/ tests/ 2>/dev/null || true)

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  echo "ERROR: Single-SKU ShipStation v2 inventory read helper detected."
  echo "Plan ref: §7.1.6 — v2 inventory READS must batch via listInventory({ skus: [...] })."
  echo ""
  printf '  %s\n' "${VIOLATIONS[@]}"
  echo ""
  echo "If you genuinely need a single-SKU read, call:"
  echo "  const [record] = await listInventory({ skus: [sku] });"
  echo "The single-element batch path costs the same one HTTP call and stays"
  echo "within the v2 API's ~60 req/min budget under load."
  exit 1
fi

echo "OK: No forbidden single-SKU v2 inventory read helpers."
