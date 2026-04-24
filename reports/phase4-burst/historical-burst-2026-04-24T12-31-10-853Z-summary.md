# Phase 4 X-1.b — historical burst audit summary

**Date**: 2026-04-24
**Window**: trailing 30 days
**Dataset**: `66,415` production `webhook_events` rows (probe traffic excluded)

## Burst envelope

| Metric | Value | Interpretation |
|---|---:|---|
| Seconds at `>= 10 rps` | `716` | Common bulk-edit spikes |
| Seconds at `>= 15 rps` | `60` | Brushes the Trigger cliff |
| Seconds at `>= 20 rps` | `6` | All clustered in a single 3-minute event |
| Worst sustained 60s burst | `786 / 60s = 13.1 rps` | Below the `27.5 rps` sustainable ceiling |
| Worst sustained 5m burst | `3,080 / 5m = 10.3 rps` | Well below the penalty-box threshold |

## Status distribution

| Status | Count | % | Interpretation |
|---|---:|---:|---|
| `parse_failed` | `33,528` | `50.5%` | historical fire, not current behavior |
| `pending` | `22,902` | `34.5%` | historical fire, not current behavior |
| `received` | `8,381` | `12.6%` | healthy current pipeline |
| `enqueued` / `processed` / `review_queued` | `968` | `1.5%` | healthy current pipeline |
| `enqueue_failed` | `0` | `0.0%` | Trigger ceiling never hit in production |

## Conclusion

Production has **not** entered the X-1.b failure envelope. The theoretical Trigger.dev enqueue cliff exists, but the live system is operating comfortably below it:

- no production `enqueue_failed` rows in 30 days
- no sustained 60s burst above `13.1 rps`
- only `6` seconds at `>= 20 rps`, all within one isolated incident window

This is the core evidence for deferring the §9.5 ingress hardening build and pivoting to Phase 5.

See also:

- `reports/phase4-burst/x1b-probe-2026-04-24T12-05-50-247Z-summary.md`
- `reports/phase4-burst/X-1-decision.md`
