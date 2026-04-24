# Phase 4 X-1 + X-1.b — consolidated decision document

**Date drafted**: 2026-04-24
**Status**: FINAL — Run #2 captured and decision closed
**Scope**: Decides whether to commit to the §9.5 webhook ingress hardening build (Edge migration + waitUntil decoupling + batch enqueue), defer it, or close it.
**Inputs**: 4 production probes against Northern Spy (`cutover_state=legacy`, `do_not_fanout=true`, observe-only path):
  1. Sub-pass A.1 baseline run #1 — `reports/phase4-burst/2026-04-24T11-09-18-489Z-run1-summary.md`
  2. Sub-pass A.2 baseline run #2 — `reports/phase4-burst/2026-04-24T16-01-34-343Z-run2-summary.md` (scheduler output in `reports/phase4-burst/run2-scheduler.log`)
  3. X-1.b rate-limit characterization probe — `reports/phase4-burst/x1b-probe-2026-04-24T12-05-50-247Z-summary.md`
  4. X-1.b historical burst audit + status verification — `reports/phase4-burst/historical-burst-2026-04-24T12-31-10-853Z-summary.md`

---

## Executive summary

| Question | Answer | Confidence |
|---|---|---|
| **F-7**: is cold-start ingress p95 below 800 ms? | **NO** — Run #1 = 1,507 ms p95; Run #2 = 1,817 ms p95 | High |
| **X-1**: does that fail justify Edge migration? | **DEFERRED** — the cold-start budget fails, but production volume still sits well below the failure-mode threshold | High |
| **X-1.b**: does Trigger.dev's enqueue ceiling justify Phase 4 mitigations beyond Edge? | **NO** — production has hit the ceiling 0 times in 30 days; 30 rps peak only as a single-second aberration | High |
| **Phase 4 build**: should we ship the §9.5 deliverables (Edge route + waitUntil + batchTrigger)? | **DEFER** until production scale grows 5-10× OR Vercel cold-start degrades materially | High |

**Recommendation**: pivot to Phase 5 (ATP layer + per-channel safety stock UI per plan §9.6). Keep the §9.5 deliverables in the plan as a future hardening epic with a clear trigger-to-build (operational metrics, see "When to revisit" below).

---

## Detailed findings

### F-7 — cold-start ingress latency

**Sub-pass A.1 (Run #1)** and **Sub-pass A.2 (Run #2)** both captured the full §9.5 spec: 50 concurrent × 60s sustained against the production Node ingress.

| Metric | Run #1 | Run #2 | Threshold | Verdict |
|---|---:|---:|---:|:---:|
| 200-only path p95 | 1,507 ms | 1,817 ms | < 800 ms (F-7) | **FAIL** |
| 200-only path p99 / pipeline p99 | 1,611 ms | 9,345 ms | < 5,000 ms (Shopify) | Mixed / FAIL |
| 200-only / total samples | 2,800 | 2,799 | n/a | n/a |
| OK / error | not needed for X-1 closeout | 624 / 2,175 | n/a | n/a |

The OK-path p95 is now **confirmed above budget on two full-scale runs**. Run #2 was worse than Run #1 (1,817 ms vs 1,507 ms), so X-1 is no longer waiting on more evidence for the cold-start conclusion itself.

#### Run #2 notes

- Wall clock: 61.60 s
- Samples: 2,799
- Status breakdown: `{"200":624,"503":2175}`
- Latency, all samples: p95 `8,874 ms`, p99 `9,345 ms`
- Cold-start proxy (n=50): p95 `1,817 ms`, max `2,656 ms`
- Cleanup ran immediately after and deleted all 2,799 probe rows (`external_webhook_id LIKE 'phase4-burst-%-run2-%'`)

**Interpretation:** F-7 fails decisively, but the result still does **not** justify immediate Edge work because the operational question is not "can we make the benchmark fail?" but "does production traffic naturally enter the failure envelope?" The answer remains no.

### X-1.b — Trigger.dev `tasks.trigger()` enqueue ceiling

**Probe** (`scripts/_phase4-x1b-trigger-rate-limit-probe.ts`) binary-stepped concurrency through `[2, 5, 10, 15, 20, 30, 40, 50]` × 10s burst with 60s recovery between.

| Concurrency | Total req | OK | 503 | Saturation | Sustained 200-rps | Time-to-first-503 |
|---:|---:|---:|---:|---:|---:|---:|
| 2 | 53 | 53 | 0 | 0% | 5.3 | n/a |
| 5 | 156 | 156 | 0 | 0% | 15.6 | n/a |
| **10** | **275** | **275** | **0** | **0%** | **27.5** | **n/a** |
| **15** | **619** | **68** | **551** | **89%** | **6.8** | **1,377 ms** |
| 20 | 975 | 0 | 975 | 100% | 0 | **0 ms** |
| 30-50 | 5,931 | 0 | 5,931 | 100% | 0 | 0 ms |

**Two material discoveries:**

1. **Sustainable ceiling = 27.5 enqueues/sec at concurrency 10.** Hard cliff between concurrency 10 and 15; not a gradual degradation curve.
2. **Penalty-box behavior at concurrency ≥20.** `ms_to_first_503=0` across 4 consecutive steps means the very first request of each step gets 503 before anything else lands, even after 60s recovery. Implies Trigger.dev's rate-limit window is at least minutes (suspected 5-min) AND severe bursts trigger an extended cooldown that locks out subsequent legitimate webhooks.

### X-1.b operational reality check — does production actually hit the ceiling?

The probe characterized the **theoretical** ceiling. Two follow-up scripts answered the **operational** question: does production ever reach this regime?

**Historical burst audit** (`scripts/_phase4-x1b-historical-burst-audit.ts`) — last 30 days, 66,415 production webhook events:

| Bracket | Count | Interpretation |
|---|---:|---|
| Single seconds ≥10 rps (warning) | 716 | Common during Shopify bulk-edits |
| Single seconds ≥15 rps (X-1.b ceiling) | 60 | Brushes the cliff |
| Single seconds ≥20 rps (penalty-box) | 6 | All clustered in 3 minutes (2026-04-20T15:37-15:39 UTC), single event |
| Worst 60s sustained burst | 786 events / 60s = 13.1 rps | **Below** sustainable ceiling |
| Worst 5-min sustained burst | 3,080 events / 5min = 10.3 rps | **Below** sustainable ceiling |

**Operational verification** (`scripts/_phase4-x1b-status-verification.ts`) — actual `webhook_events.status` distribution over 30 days:

| Status | Count | % | Interpretation |
|---|---:|---:|---|
| `parse_failed` | 33,528 | 50.5% | **Past fire — see below** |
| `pending` | 22,902 | 34.5% | **Past fire — see below** |
| `received` | 8,381 | 12.6% | Healthy (current pipeline) |
| `enqueued` / `processed` / `review_queued` | 968 | 1.5% | Healthy |
| **`enqueue_failed`** | **0** | **0.0%** | **Trigger.dev rate-limit has never fired in production** |

**Production has never tripped the Trigger.dev enqueue ceiling.** Despite 30 rps single-second peaks, those peaks are too short / too spread to consume the rate-limit bucket. The X-1.b ceiling is **theoretical at our current scale**.

### Bonus discovery — `parse_failed` and `pending` were past fires already fixed

Temporal distribution (`scripts/_phase4-x1b-temporal-distribution.ts`) shows both statuses concentrated 2026-04-09 → 2026-04-20, dropping to **zero** from Apr 21 onward:

```
Apr 11:  7,645 pending in one day
Apr 13-20: ~33,000 parse_failed total
Apr 21+ : near zero (5 stragglers; oldest 83h)
```

These were operational fires caused by webhook workspace resolution issues, fixed by the **2026-04-20 workspace-first stabilization** (per engineering_map prior_update). The data confirms the fix worked — Apr 23 (3,587 events) and Apr 24 (4,824 events so far) all show clean `received` status with no parse_failed or pending.

**5 residual `pending` rows** from Apr 21-22 are recorded as a deferred follow-up for cleanup investigation (`webhook-events-post-stabilization-stragglers`).

---

## Decision

### What we will NOT do

1. **NOT building the Edge ingress route (Phase 4 §9.5 deliverable 1).** F-7 fails on both full-scale runs, but we still have no operational pain caused by this cold-start envelope: no missed Shopify SLA in the last 30 days, no webhook subscription deactivations, no production `enqueue_failed`, no customer-visible backlog.
2. **NOT adding `waitUntil()` decoupling yet.** It would be needed if we ever sustained above the enqueue ceiling. We never have.
3. **NOT evaluating `tasks.batchTrigger()` yet.** Same reasoning.
4. **NOT building the Postgres NOTIFY consumer architecture.** Heavy lift, no current need.

### What we WILL do

1. **Mark Phase 4 §9.5 as "deferred — no operational signal triggers build."** Keep the analysis visible in the plan as future-state preparation.
2. **Pivot to Phase 5 (plan §9.6)** — ATP layer + per-channel safety stock UI. This is the next user-visible improvement and is now the active build track.
3. **Stand up the operational signals that would trigger a Phase 4 build** (see "When to revisit" below).
4. **Clean up the 5 post-stabilization `pending` stragglers** (separate small task, tracked as `webhook-events-post-stabilization-stragglers`).
5. **Keep the harness scripts** (`_phase4-burst-test.ts` + `_phase4-x1b-*.ts`) — they're the empirical instruments we'd use again to re-validate before any future Phase 4 build.

---

## When to revisit (operational triggers)

Re-open Phase 4 build planning if **any** of these signals fire:

1. **`enqueue_failed > 0` for 3+ consecutive days** in production (currently 0 for 30 days).
2. **Single-second peaks ≥30 rps in 5+ separate hours within a week** (currently 6 seconds total in 30 days, all in one 3-minute event).
3. **Sustained 60s rate ≥20 rps** (currently max 13.1 rps).
4. **Vercel cold-start p95 degrades to >2,500 ms** (currently Run #1 = 1,507 ms; Run #2 = 1,817 ms; both above target but still below this "build now" threshold).
5. **Shopify deactivates a webhook subscription** for our app on any client connection (would indicate we exceeded the 5s ingress budget badly enough to trigger Shopify's auto-cleanup).
6. **A new platform integration** (e.g. Squarespace, BigCommerce) ships and adds 3-5× current webhook volume.

Each of these conditions has a measurable signal — sensors or status-distribution auditing can be wired to surface them automatically. Recommend a **weekly automated re-run of `_phase4-x1b-status-verification.ts`** as a defensive monitor.

---

## Risks of this decision

- **Risk A**: production traffic doubles in next 6 months and X-1.b becomes operational. **Mitigation**: weekly status verification; we'd see the trend 2-4 weeks before crisis.
- **Risk B**: Vercel cold-start latency degrades silently. **Mitigation**: re-run `_phase4-burst-test.ts --apply --scale=full` quarterly; the harness is the canonical measurement.
- **Risk C**: a new client onboarding (e.g., a single high-volume label) spikes webhook traffic by 10×. **Mitigation**: pre-launch capacity plan for any client ≥5× our current largest.

All three risks are managed by **monitoring, not by pre-emptive engineering**.

---

## Attachments

- `reports/phase4-burst/2026-04-24T11-09-18-489Z-run1-summary.md` — Sub-pass A.1 baseline
- `reports/phase4-burst/2026-04-24T16-01-34-343Z-run2-summary.md` — Sub-pass A.2 baseline
- `reports/phase4-burst/run2-scheduler.log` — scheduler output + automatic cleanup confirmation
- `reports/phase4-burst/x1b-probe-2026-04-24T12-05-50-247Z-summary.md` — X-1.b probe
- `reports/phase4-burst/historical-burst-2026-04-24T12-31-10-853Z-summary.md` — historical audit (66,415 events)
