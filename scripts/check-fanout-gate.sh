#!/usr/bin/env bash
# Phase 0.8 — CI guard: client store fanout paths MUST consult the dormancy gate.
#
# Plan ref: §12.4 ("leak-proof dormancy"). The single chokepoint is
# `shouldFanoutToConnection()` in src/lib/server/client-store-fanout-gate.ts.
# Any file under src/ that READS `client_store_connections` or instantiates a
# store sync client AND issues outbound mutations must reference the gate so
# dormant rows short-circuit before we hit Shopify / WooCommerce / Squarespace.
#
# This script enforces "if a file mentions both client_store_connections AND
# any of the fanout sinks (createStoreSyncClient, pushInventory, fetchOrders),
# it MUST also import shouldFanoutToConnection or be on the allow-list".
#
# Allow-list is intentionally small: the gate file itself, the wiring sites
# already audited (multi-store-inventory-push, client-store-order-detect,
# process-client-store-webhook, store-sync-client), the admin page that
# *displays* dormant rows, the reactivate Server Action, the connection
# fetchers used by display-only screens, OAuth callbacks, and tests.

set -euo pipefail

cd "$(dirname "$0")/.."

# Files that legitimately touch client_store_connections without being part of
# a fanout path. Keep this list minimal and audited.
ALLOWLIST=(
  "src/lib/server/client-store-fanout-gate.ts"
  "src/trigger/tasks/multi-store-inventory-push.ts"
  "src/trigger/tasks/client-store-order-detect.ts"
  "src/trigger/tasks/process-client-store-webhook.ts"
  "src/lib/clients/store-sync-client.ts"
  "src/actions/store-connections.ts"
  "src/actions/client-store-credentials.ts"
  "src/app/admin/settings/client-store-reconnect/page.tsx"
  "src/app/admin/settings/store-connections/"
  "src/app/admin/clients/"
  "src/app/portal/stores/page.tsx"
  "src/app/api/oauth/"
  "src/lib/shared/types.ts"
  "src/actions/portal-stores.ts"
  "src/actions/portal-dashboard.ts"
  "src/actions/portal-settings.ts"
)

# Sinks that indicate a client-store fanout path. We only consider the
# explicit factory `createStoreSyncClient` and reads of `client_store_credentials`,
# both of which exclusively drive client-store IO. Generic verbs like
# `fetchProducts` are NOT included because ShipStation/Bandcamp use the same
# names but never touch the dormancy gate.
FANOUT_SINK_REGEX='createStoreSyncClient|client_store_credentials'

VIOLATIONS=()

while IFS= read -r file; do
  # Skip allowlisted paths (prefix match).
  skip=0
  for allowed in "${ALLOWLIST[@]}"; do
    case "$file" in
      "$allowed"*) skip=1; break;;
    esac
  done
  [ "$skip" -eq 1 ] && continue

  # File mentions client_store_connections AND a fanout sink AND does NOT
  # mention shouldFanoutToConnection -> violation.
  if grep -qE "$FANOUT_SINK_REGEX" "$file" 2>/dev/null; then
    if ! grep -q "shouldFanoutToConnection" "$file" 2>/dev/null; then
      VIOLATIONS+=("$file")
    fi
  fi
done < <(grep -rl --include='*.ts' --include='*.tsx' "client_store_connections" src/ 2>/dev/null || true)

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  echo "ERROR: Client store fanout paths must consult shouldFanoutToConnection()."
  echo "Plan ref: docs/plans/* Phase 0.8 — leak-proof dormancy gate."
  echo ""
  printf '  %s\n' "${VIOLATIONS[@]}"
  echo ""
  echo "Either (a) add a shouldFanoutToConnection() check before any fanout side effect,"
  echo "or (b) if this file is a display-only / read-only path, add it to the allow-list"
  echo "in scripts/check-fanout-gate.sh with a comment explaining why."
  exit 1
fi

echo "OK: All client_store_connections fanout sites consult the dormancy gate."
