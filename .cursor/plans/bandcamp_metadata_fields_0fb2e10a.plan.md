---
name: Bandcamp Metadata Fields
overview: Extend the Bandcamp album page scraper to capture `about`, `credits`, and `upc` from `data-tralbum.current`, store them in the DB, and backfill all 45 already-scraped products plus trigger the remaining 505.
todos:
  - id: migration-metadata
    content: Create migration 20260331000001_bandcamp_metadata_fields.sql adding description_html + bandcamp_upc to warehouse_products and bandcamp_about + bandcamp_credits to bandcamp_product_mappings
    status: completed
  - id: zod-schema
    content: Extend tralbumDataSchema current object and ScrapedAlbumData interface with about, credits, upc fields in bandcamp-scraper.ts
    status: completed
  - id: task-write
    content: Write bandcamp_about and bandcamp_credits to mapping update, and conditionally write description_html + bandcamp_upc to warehouse_products in bandcamp-scrape-page task
    status: completed
  - id: idempotency-guard
    content: Extend triggerScrapeIfNeeded condition to also re-trigger when bandcamp_art_url is set but bandcamp_about is null (backfill for 45 already-scraped products)
    status: pending
  - id: unit-tests
    content: Add fixture with about/credits/upc to bandcamp-scraper unit tests
    status: completed
  - id: deploy-backfill
    content: Deploy updated task and trigger one bandcamp-sync run to queue all backfill scrapes
    status: completed
isProject: false
---

