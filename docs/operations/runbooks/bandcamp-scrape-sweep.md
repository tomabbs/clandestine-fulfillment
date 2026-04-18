# `bandcamp-scrape-sweep` runbook

## What this task does

Scrapes Bandcamp public HTML pages for metadata (Type, street_date,
genre tags) that the API doesn't expose. Uses the SEPARATE
`bandcamp-scrape` queue (Rule #60) so HTML scraping doesn't block
OAuth API calls.

## Schedule + invocation

- **Cron:** every 30 minutes (sweeps queue of pending URLs).
- **Queue:** `bandcamp-scrape` (concurrencyLimit: 3, Rule #60).
- **Triggered:** when `bandcamp-sync` discovers a product missing
  scraped metadata.

## Common failure modes

### 1. DOM structure changes

- Symptom: parser version `parseV1` returns nulls for fields that
  previously parsed.
- Means: Bandcamp changed their HTML.
- Recovery: ship `parseV2` (Rule #25); update fixtures.

### 2. IP blocking by Bandcamp

- Symptom: HTTP 429 or 403 across all scrape URLs.
- Recovery: route through residential proxy (Rule #30).

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
