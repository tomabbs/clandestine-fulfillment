#!/usr/bin/env bash
# CI guard: all webhook route handlers must use the webhook_events dedup pattern.
# See CLAUDE.md rule 62.

set -euo pipefail

WEBHOOK_DIR="src/app/api/webhooks"

if [ ! -d "$WEBHOOK_DIR" ]; then
  echo "OK: No webhook handlers directory found yet."
  exit 0
fi

# Find all route.ts files under the webhooks directory
ROUTE_FILES=$(find "$WEBHOOK_DIR" -name "route.ts" -type f 2>/dev/null || true)

if [ -z "$ROUTE_FILES" ]; then
  echo "OK: No webhook route handlers found yet."
  exit 0
fi

VIOLATIONS=""

for file in $ROUTE_FILES; do
  if ! grep -q "webhook_events" "$file"; then
    VIOLATIONS="${VIOLATIONS}${file}: missing webhook_events dedup pattern\n"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Webhook route handlers missing dedup pattern (webhook_events table insert)."
  echo "All webhook handlers must INSERT INTO webhook_events for dedup. See CLAUDE.md rule 62."
  echo ""
  echo -e "$VIOLATIONS"
  exit 1
fi

echo "OK: All webhook handlers include dedup pattern."
