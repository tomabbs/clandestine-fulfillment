#!/usr/bin/env bash

set -euo pipefail

DOSSIER_PATH="${1:-}"

if [[ -z "$DOSSIER_PATH" ]]; then
  echo "Usage: $0 <dossier-markdown-path>"
  exit 1
fi

if [[ ! -f "$DOSSIER_PATH" ]]; then
  echo "File not found: $DOSSIER_PATH"
  exit 1
fi

echo "Scanning $DOSSIER_PATH"

fail_if_found() {
  local pattern="$1"
  local message="$2"
  if rg -n --hidden -e "$pattern" "$DOSSIER_PATH" >/dev/null 2>&1; then
    echo "FAIL: $message"
    exit 1
  fi
}

warn_if_found() {
  local pattern="$1"
  local message="$2"
  if rg -n --hidden -e "$pattern" "$DOSSIER_PATH" >/dev/null 2>&1; then
    echo "WARN: $message"
  fi
}

# Hard fails: common credential patterns and machine-local paths.
fail_if_found 'shpat_[A-Za-z0-9]+' 'Shopify access token detected'
fail_if_found 'shpca_[A-Za-z0-9]+' 'Shopify custom-app credential detected'
fail_if_found 'shpss_[A-Za-z0-9]+' 'Shopify app secret detected'
fail_if_found 'ck_[A-Za-z0-9]{20,}' 'WooCommerce consumer key detected'
fail_if_found 'cs_[A-Za-z0-9]{20,}' 'WooCommerce consumer secret detected'
fail_if_found 'SUPABASE_SERVICE_ROLE_KEY|postgresql://|postgres://' 'Database secret or DSN detected'
fail_if_found '/Users/[^ ]+/.cursor/' 'Editor-local absolute path detected'
fail_if_found '/Users/[^ ]+/\.cursor/' 'Editor-local absolute path detected'

# Warnings: sensitive-adjacent patterns that should be reviewed manually.
warn_if_found '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' 'Email address pattern found; confirm it is intentional'
warn_if_found '\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b' 'SSN-like pattern found; review immediately'
warn_if_found '\b[0-9]{13,19}\b' 'Long numeric pattern found; verify it is not payment data'
warn_if_found 'inventory_quantity|unitCost|consumerSecret|accessToken|api_secret' 'Sensitive raw payload field name found; verify allowlist discipline'

echo "PASS: no hard-fail redaction patterns detected"
