#!/usr/bin/env bash
#
# Phase 1 §9.2 D4 Step A — Shopify API version source-of-truth guard.
#
# Bans hard-coded Shopify Admin API version literals in `src/` outside
# the canonical constant `SHOPIFY_CLIENT_API_VERSION` in
# `src/lib/shared/constants.ts`.
#
# Why this matters:
#   Phase 1 Pass 2 introduces `inventorySetQuantities` with
#   `changeFromQuantity` + the `@idempotent(key:)` directive — both are
#   2026-04+ surface. If a per-client GraphQL/REST call site is left
#   pinned to `2026-01` (or any non-canonical version), the helper will
#   silently fail closed (`Field 'changeFromQuantity' doesn't exist on
#   InventorySetQuantitiesInput`) and the entire reconcile path is
#   broken for THAT call site only — a partial-failure mode that's
#   nearly impossible to detect from logs alone.
#
# What's banned:
#   Any quoted literal of the form `"YYYY-MM"` matching the Shopify API
#   version date shape (`20\d\d-(01|04|07|10)`) appearing in `src/`
#   `*.ts` / `*.tsx` files, with two exceptions:
#     1. `src/lib/shared/constants.ts` — owns the constant.
#     2. The env-singleton path may use `env().SHOPIFY_API_VERSION`
#        WITHOUT a literal (the env var carries the version string at
#        runtime; the code never inlines a literal).
#
# What's allowed:
#   - Tests — `tests/` is excluded entirely. Test fixtures simulate
#     Shopify responses at varying API versions; pinning them to the
#     canonical constant would couple test setup to a runtime value
#     that has nothing to do with what the test is asserting.
#   - Docstrings/comments referring to "the prior pinning" by writing
#     `2026-01` in backticks or prose — only QUOTED literals are matched.
#
set -euo pipefail
cd "$(dirname "$0")/.."

# Match Shopify quarterly release shapes only (Shopify ships in Jan/Apr/Jul/Oct).
# This narrows the regex enough that incidental date strings like
# `"2026-04-21T..."` (ISO timestamps in tests/fixtures) are not flagged
# because the closing quote is `-`, not `"`.
SHOPIFY_VERSION_LITERAL_REGEX='["'\'']20[0-9][0-9]-(01|04|07|10)["'\'']'

ALLOWLIST=(
  "src/lib/shared/constants.ts"
  "scripts/check-shopify-api-version.sh"
)

VIOLATIONS=()
while IFS= read -r file; do
  skip=false
  for allowed in "${ALLOWLIST[@]}"; do
    if [ "$file" = "$allowed" ]; then
      skip=true
      break
    fi
  done
  if [ "$skip" = false ]; then
    VIOLATIONS+=("$file")
  fi
done < <(grep -rlE --include='*.ts' --include='*.tsx' "$SHOPIFY_VERSION_LITERAL_REGEX" src/ 2>/dev/null || true)

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  echo "ERROR: hard-coded Shopify Admin API version literal detected outside the canonical constant."
  echo ""
  echo "Affected files:"
  for v in "${VIOLATIONS[@]}"; do
    echo "  $v"
    grep -nE "$SHOPIFY_VERSION_LITERAL_REGEX" "$v" | sed 's/^/    /'
  done
  echo ""
  echo "Replace the literal with:"
  echo "  import { SHOPIFY_CLIENT_API_VERSION } from \"@/lib/shared/constants\";"
  echo ""
  echo "Or, for the main Clandestine Shopify env-singleton path, use:"
  echo "  env().SHOPIFY_API_VERSION"
  echo ""
  echo "See: src/lib/shared/constants.ts → SHOPIFY_CLIENT_API_VERSION docstring."
  exit 1
fi

echo "OK: Shopify Admin API version literals only appear in src/lib/shared/constants.ts."
