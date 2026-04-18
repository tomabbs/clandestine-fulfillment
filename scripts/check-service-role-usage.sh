#!/usr/bin/env bash
# Tier 1 hardening (Part 14.7) item #2 — service-role manifest guard.
#
# Counts every file under src/ that calls createServiceRoleClient and
# compares against the count of "- `src/" bullets in the manifest at
# docs/security/service-role-usage.md. If they differ, fail the build:
# either a new callsite landed without a manifest entry, or the manifest
# claims a callsite that no longer exists.
#
# Usage:
#   bash scripts/check-service-role-usage.sh

set -euo pipefail

MANIFEST="docs/security/service-role-usage.md"

if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: $MANIFEST not found." >&2
  exit 1
fi

CODE_FILES=$(grep -rl 'createServiceRoleClient' src --include='*.ts' | grep -v '\.test\.ts$' | sort -u)
CODE_COUNT=$(printf '%s\n' "$CODE_FILES" | sed '/^$/d' | wc -l | tr -d ' ')

# Count lines starting with "- `src/" in the manifest (one per documented file)
MANIFEST_FILES=$(grep -E '^- `src/' "$MANIFEST" | sed -E 's/^- `([^`]+)`.*/\1/' | sort -u)
MANIFEST_COUNT=$(printf '%s\n' "$MANIFEST_FILES" | sed '/^$/d' | wc -l | tr -d ' ')

if [[ "$CODE_COUNT" -ne "$MANIFEST_COUNT" ]]; then
  echo "ERROR: service-role manifest drift detected." >&2
  echo "  code files using createServiceRoleClient: $CODE_COUNT" >&2
  echo "  manifest entries:                          $MANIFEST_COUNT" >&2

  # Show the diff so the engineer can fix it
  echo "" >&2
  echo "Files in code but missing from manifest:" >&2
  comm -23 <(printf '%s\n' "$CODE_FILES") <(printf '%s\n' "$MANIFEST_FILES") | sed 's/^/  + /' >&2 || true

  echo "" >&2
  echo "Files in manifest but missing from code:" >&2
  comm -13 <(printf '%s\n' "$CODE_FILES") <(printf '%s\n' "$MANIFEST_FILES") | sed 's/^/  - /' >&2 || true

  echo "" >&2
  echo "Update docs/security/service-role-usage.md and re-run." >&2
  exit 1
fi

echo "service-role manifest OK ($CODE_COUNT files documented)."
