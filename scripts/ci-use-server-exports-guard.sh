#!/usr/bin/env bash
# CI guard: "use server" modules must export only async functions.
#
# Catches the `Next.js build` failure documented at
# https://nextjs.org/docs/messages/invalid-use-server-value at
# guard time (~200ms) instead of at `next build` time (~90s,
# cryptic stacktrace pointing at compiled chunks).
#
# See `scripts/check-use-server-exports.ts` for the full rule set.

set -euo pipefail

npx tsx scripts/check-use-server-exports.ts
