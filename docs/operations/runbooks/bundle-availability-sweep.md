# `bundle-availability-sweep` runbook

## What this task does

Recomputes bundle availability for all bundle parents using
`computeEffectiveBundleAvailable()`. Used to recover from drift after
a component-level inventory change failed to fanout.

## Schedule + invocation

- **Cron:** every 6 hours.
- **Manual:** triggered after large inventory adjustments.

## Common failure modes

### 1. Bundle without components

- Symptom: result `+Infinity` (helper default).
- Means: a bundle parent has no `bundle_components` rows.
- Recovery: review queue item; staff completes bundle definition.

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
