# SKU Review Dossier

This folder holds the generated reviewer-facing SKU dossier and its repo-relative snapshot artifacts.

## Purpose

The dossier is a Bandcamp-first review artifact for the current SKU-matching system. It is meant to help outside reviewers understand:

- current live Shopify/WooCommerce matching state
- the current Bandcamp linkage gap for the target orgs
- the real code/schema/Trigger surfaces behind the system
- remediation options without overclaiming runtime behavior

## Generate

Internal/named build:

```bash
npx tsx scripts/generate-sku-review-dossier.ts --mode=internal
```

External/pseudonymized build:

```bash
npx tsx scripts/generate-sku-review-dossier.ts --mode=external
```

Optional custom output directory:

```bash
npx tsx scripts/generate-sku-review-dossier.ts --mode=internal --out-dir=reports/sku-review-dossier
```

## Outputs

Each run writes:

- `sku-review-dossier-<timestamp>.md`
- `sku-review-dossier-snapshot-<timestamp>.json`
- `sku-review-dossier-summary-<timestamp>.csv`

## Publication checks

Run the redaction gate before sharing:

```bash
bash scripts/check-dossier-redaction.sh "reports/sku-review-dossier/sku-review-dossier-<timestamp>.md"
```

## Safety rules

- The dossier should never reference editor-local, terminal-local, or agent-cache absolute paths.
- The markdown should only include allowlisted reviewer-safe fields.
- Do not hand-edit the generated markdown to paste raw API payloads into it.
- `internal` mode can keep named orgs/store URLs; `external` mode pseudonymizes workspace, org, connection, and store-host labels for broader sharing.

## Known limitations

- The target orgs currently have zero linked Bandcamp mapping/URL rows in the DB slice reviewed by this artifact.
- WooCommerce remote-catalog comparison can be incomplete if the fetch path times out.
- Current Bandcamp scraper unit coverage is primarily synthetic, not based on the checked-in HTML fixture as the CI regression source.
