#!/usr/bin/env bash
# F-2 (CRITICAL): Every webhook Route Handler MUST declare both
#   export const runtime = "nodejs";
#   export const dynamic = "force-dynamic";
#
# Why this matters:
#   - Default Edge runtime lacks node:crypto and a stable Supabase
#     service-role client; webhooks that silently fall back to Edge will
#     fail HMAC verification at runtime in subtle ways.
#   - Without `dynamic = 'force-dynamic'`, Next can cache the route
#     response and serve a stale 200 OK to a fresh delivery — corrupting
#     the dedup invariant (Rule #62).
#
# This guard runs in CI on every pull request and locally as part of
# `pnpm verify:cloud`. It walks every src/app/api/webhooks/**/route.ts
# file and emits one error line per missing declaration.
#
# WEBHOOK_RUNTIME_ALLOWLIST escape hatch: paths added below are exempted.
# Keep this empty by default — exemptions require a Truth Layer doc update
# (per `Doc Sync Contract`).

set -euo pipefail

# Paths exempted from the runtime check. Each entry is a path relative to
# the repo root. Empty by default — populate ONLY with explicit Truth Layer
# justification (e.g., a future read-only health endpoint that genuinely
# needs Edge).
WEBHOOK_RUNTIME_ALLOWLIST=(
)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Use `find` rather than bash globstar so this script works on macOS's
# default bash 3.2 (no globstar support) and on stripped CI containers.
routes=()
while IFS= read -r line; do
  routes+=("$line")
done < <(find src/app/api/webhooks -type f -name route.ts | LC_ALL=C sort)

if [ ${#routes[@]} -eq 0 ]; then
  echo "ERROR: No webhook routes found under src/app/api/webhooks/."
  echo "       Either the directory layout changed or the find command failed."
  exit 1
fi

violations=()

for route in "${routes[@]}"; do
  skip=false
  # bash 3.2 expands `${empty_array[@]}` with `set -u` enabled to an unbound
  # var error; guard with `${arr[@]+"${arr[@]}"}` to safely no-op when empty.
  for allowed in ${WEBHOOK_RUNTIME_ALLOWLIST[@]+"${WEBHOOK_RUNTIME_ALLOWLIST[@]}"}; do
    if [ "$route" = "$allowed" ]; then
      skip=true
      break
    fi
  done
  $skip && continue

  if ! grep -Eq '^export const runtime\s*=\s*"nodejs"\s*;?\s*$' "$route"; then
    violations+=("$route: missing 'export const runtime = \"nodejs\";'")
  fi
  if ! grep -Eq '^export const dynamic\s*=\s*"force-dynamic"\s*;?\s*$' "$route"; then
    violations+=("$route: missing 'export const dynamic = \"force-dynamic\";'")
  fi
done

if [ ${#violations[@]} -gt 0 ]; then
  echo "ERROR: F-2 webhook runtime contract violated."
  echo "       Every webhook route MUST declare runtime=\"nodejs\" and dynamic=\"force-dynamic\"."
  echo "       See scripts/check-webhook-runtime.sh for the rationale."
  echo
  for v in "${violations[@]}"; do
    echo "  - $v"
  done
  exit 1
fi

echo "OK: All ${#routes[@]} webhook routes declare runtime=\"nodejs\" and dynamic=\"force-dynamic\"."
