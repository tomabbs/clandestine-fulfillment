---
name: Bandcamp API Complete
overview: Capture 100% of all Bandcamp API data (Merch, Sales, Account), store permanently. Authority lifecycle model — Bandcamp-first for initial ingest, warehouse-after-review for operational fields. Fix SKU matching (option-level), backfill all-time sales history, auto-generate missing SKUs, scraper reduced to enrichment only.
todos:
  - id: phase1-schema
    content: "Migration: new columns on bandcamp_product_mappings + bandcamp_sales table + backfill_state table"
    status: pending
  - id: phase1-api-client
    content: Expand merchItemSchema + bandSchema; implement salesReport, generateSalesReport, fetchSalesReport, updateSku in bandcamp.ts
    status: completed
  - id: phase2-sync-all-data
    content: "bandcamp-sync: store ALL API fields; authority_status lifecycle governs overwrites (bandcamp_initial → warehouse_reviewed → locked); option-level SKU matching; auto-generate missing SKUs"
    status: pending
  - id: phase3-sales-backfill
    content: "New tasks: bandcamp-sales-backfill (all-time) + bandcamp-sales-sync (daily cron); backfill catalog_number/upc/isrc to mappings"
    status: pending
  - id: phase4-scraper-simplify
    content: Remove URL construction + subdomain resolution from sync + sweep; scraper only does about/credits/tracks/photos
    status: pending
  - id: phase5-ui
    content: Sales History tab on Bandcamp settings; full Bandcamp data panel on catalog page; backfill status + trigger UI
    status: pending
  - id: doc-sync
    content: Update TRUTH_LAYER, API_CATALOG, TRIGGER_TASK_CATALOG, journeys.yaml, engineering_map.yaml
    status: pending
isProject: false
---

# Bandcamp API Complete: All Data, All Time

## 1. Scope summary

Capture **every field** from all three Bandcamp API families (Account, Merch Orders, Sales Report), store permanently, and establish a clear **source-authority lifecycle**: Bandcamp is authoritative for initial ingest; after staff review or physical count, the warehouse app becomes authoritative and pushes outward.

**Authority lifecycle model:**

1. `**bandcamp_initial`** — New title arrives from Bandcamp API. Bandcamp owns all data: SKU, quantity, price, dates, URLs, metadata. Warehouse mirrors Bandcamp.
2. `**warehouse_reviewed`** — Staff has reviewed the item in the app. Warehouse now owns **operational fields** (SKU, on-hand quantity, price). Bandcamp still owns **descriptive/external fields** (URL, subdomain, album_title, options, sales data, catalog metadata). Auto-sync from Bandcamp stops overwriting operational fields.
3. `**warehouse_locked`** — Explicit staff lock. No auto-sync overwrites anything. Used for items with intentional divergence.

**Field ownership classes:**

- **Bandcamp-permanent** (always synced from API, never frozen): `url`, `subdomain`, `album_title`, `options[]`, `origin_quantities[]`, `raw_api_data`, `is_set_price`, `currency`, sales transaction data, `catalog_number`, `upc`, `isrc`, `image_url`
- **Bandcamp-initial, warehouse-after-review** (synced until staff reviews, then warehouse owns): `sku`, `quantity` (available), `street_date`, `price`, `is_preorder`

**Key changes:**

- Bandcamp is authoritative for **initial ingest**; warehouse becomes authoritative **after review**
- `new_date` from API sets `street_date` during initial ingest (confirmed identical to scraped `release_date` in 56/56 audit)
- Bandcamp SKUs overwrite warehouse SKUs **during initial ingest** (authority_status = `bandcamp_initial`)
- `url`, `subdomain`, `album_title` from API eliminate URL construction entirely — these stay Bandcamp-owned permanently
- `options[]` from API enable option-level SKU matching (currently 7.6% match rate)
- `quantity_available` from API seeds warehouse inventory during initial ingest (43% of items show 0 in warehouse but real stock on Bandcamp)
- Sales Report API provides `catalog_number`, `upc`, `isrc`, full transaction history with revenue/fees/refunds
- Auto-generate SKUs for items missing them: `{format}-{catalog_number}` or `{format}-{artist}-{album}`
- Historical sales backfill (all-time, all 17 connections) into new `bandcamp_sales` table
- Scraper reduced to 4 fields only: `about`, `credits`, `tracks`, package `arts[]` photos

---

## 1b. Complete Bandcamp API data inventory

Every field from every API endpoint, whether we capture it, and where it goes.

### Account API: `my_bands` (POST `https://bandcamp.com/api/account/1/my_bands`)


| API field                          | Currently captured? | Store location                     | Notes                                      |
| ---------------------------------- | ------------------- | ---------------------------------- | ------------------------------------------ |
| `bands[].band_id`                  | YES                 | `bandcamp_connections.band_id`     |                                            |
| `bands[].name`                     | YES                 | `bandcamp_connections.band_name`   |                                            |
| `bands[].subdomain`                | YES                 | derived for `band_url`             |                                            |
| `bands[].member_bands[].band_id`   | YES                 | `member_bands_cache`               |                                            |
| `bands[].member_bands[].name`      | YES                 | `member_bands_cache`               |                                            |
| `bands[].member_bands[].subdomain` | **NO — MISSING**    | Add to `member_bands_cache` schema | Eliminates subdomain resolution complexity |


### Merch Orders API: `get_merch_details` (POST `https://bandcamp.com/api/merchorders/1/get_merch_details`)


| API field                              | Currently captured?            | Store location                                                          | Notes                                             |
| -------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------- |
| `items[].package_id`                   | YES                            | `bandcamp_product_mappings.bandcamp_item_id`                            |                                                   |
| `items[].title`                        | YES                            | used for product title assembly                                         | Not stored on mapping                             |
| `items[].album_title`                  | Parsed but NOT stored          | **NEW:** `bandcamp_product_mappings.bandcamp_album_title`               | Available from API — eliminates need to scrape    |
| `items[].sku`                          | YES                            | matched against warehouse                                               | Now also overwrites warehouse SKU                 |
| `items[].item_type`                    | YES                            | `bandcamp_item_type`                                                    |                                                   |
| `items[].member_band_id`               | YES                            | `bandcamp_member_band_id`                                               |                                                   |
| `items[].new_date`                     | YES                            | `bandcamp_new_date` + overwrites `street_date`                          | Confirmed = release date in 56/56 audit           |
| `items[].price`                        | YES                            | backfills warehouse price                                               | Now also stores on mapping                        |
| `items[].currency`                     | In schema, NOT stored          | **NEW:** `bandcamp_product_mappings.bandcamp_currency`                  |                                                   |
| `items[].quantity_available`           | Read for sale-poll delta       | Now also seeds warehouse inventory                                      | 43% of items had 0 warehouse / real BC stock      |
| `items[].quantity_sold`                | YES                            | `last_quantity_sold`                                                    |                                                   |
| `items[].url`                          | Was IGNORED until this session | Now stored as `bandcamp_url` with source `orders_api`                   | Eliminates all URL construction                   |
| `items[].image_url`                    | YES                            | `bandcamp_image_url` (upsized to `_10.jpg`)                             |                                                   |
| `items[].subdomain`                    | **NO — MISSING**               | **NEW:** `bandcamp_product_mappings.bandcamp_subdomain`                 | Eliminates `bandIdToSubdomain` + cache logic      |
| `items[].is_set_price`                 | **NO — MISSING**               | **NEW:** `bandcamp_product_mappings.bandcamp_is_set_price`              | Pay-what-you-want flag                            |
| `items[].options[]`                    | **NO — MISSING**               | **NEW:** `bandcamp_product_mappings.bandcamp_options` (jsonb)           | Option-level SKU matching for color/size variants |
| `items[].options[].option_id`          | **NO**                         | Inside `bandcamp_options` jsonb                                         |                                                   |
| `items[].options[].title`              | **NO**                         | Inside `bandcamp_options` jsonb                                         | e.g. "Red", "Yellow"                              |
| `items[].options[].sku`                | **NO**                         | Inside `bandcamp_options` jsonb + used for matching                     | Many items match at option level, not item level  |
| `items[].options[].quantity_available` | **NO**                         | Inside `bandcamp_options` jsonb                                         | Per-variant stock                                 |
| `items[].options[].quantity_sold`      | **NO**                         | Inside `bandcamp_options` jsonb                                         | Per-variant sales                                 |
| `items[].origin_quantities[]`          | **NO — MISSING**               | **NEW:** `bandcamp_product_mappings.bandcamp_origin_quantities` (jsonb) | Per-shipping-origin stock levels                  |
| Full raw response                      | **NO**                         | **NEW:** `bandcamp_product_mappings.raw_api_data` (jsonb)               | Future-proof — catch any undocumented fields      |


### Merch Orders API: `get_orders` (POST `https://bandcamp.com/api/merchorders/4/get_orders`)


| API field                                 | Currently captured?              | Store location                          | Notes |
| ----------------------------------------- | -------------------------------- | --------------------------------------- | ----- |
| `items[].sale_item_id`                    | YES                              | used for order creation                 |       |
| `items[].payment_id`                      | YES                              | `warehouse_orders.bandcamp_payment_id`  |       |
| `items[].order_date`                      | YES                              | order creation                          |       |
| `items[].item_url`                        | YES                              | backfills `bandcamp_url` in order-sync  |       |
| `items[].item_name`                       | YES                              |                                         |       |
| `items[].artist`                          | In schema, not stored on mapping | Consider storing                        |       |
| `items[].sku`                             | YES                              | order line items                        |       |
| `items[].option`                          | In schema                        |                                         |       |
| `items[].discount_code`                   | **NO — MISSING from schema**     | Add to order item schema                |       |
| `items[].sub_total` through `order_total` | YES                              | order amounts                           |       |
| `items[].buyer_*`, `ship_to_*`            | YES                              | shipping/fulfillment                    |       |
| `items[].payment_state`                   | YES                              | `paid`, `pending`, `refunded`, `failed` |       |
| `items[].ship_from_country_name`          | In schema                        |                                         |       |


### Merch Orders API: `get_shipping_origin_details`


| API field                         | Currently captured? | Notes                                       |
| --------------------------------- | ------------------- | ------------------------------------------- |
| `shipping_origins[].origin_id`    | **NO — not called** | Useful for multi-origin fulfillment routing |
| `shipping_origins[].band_id`      | **NO**              |                                             |
| `shipping_origins[].country_name` | **NO**              |                                             |
| `shipping_origins[].state_name`   | **NO**              |                                             |
| `shipping_origins[].state_code`   | **NO**              |                                             |


**Decision:** Call once per connection, cache in `bandcamp_connections.shipping_origins` (jsonb). Not urgent — Phase 2+.

### Merch Orders API: `update_shipped` (v2) — already implemented correctly

### Merch Orders API: `mark_date_range_as_shipped` — not used, low priority

### Merch Orders API: `update_quantities` — already implemented correctly

### Merch Orders API: `update_sku` — **NEW, needed for auto-generated SKU push**

### Sales Report API: `sales_report` (v4) (POST `https://bandcamp.com/api/sales/4/sales_report`)

**Currently: ZERO implementation.** Every field stored in `bandcamp_sales` table:


| API field                         | Store column                      | Notes                                               |
| --------------------------------- | --------------------------------- | --------------------------------------------------- |
| `bandcamp_transaction_id`         | `bandcamp_transaction_id`         | Unique per transaction                              |
| `bandcamp_transaction_item_id`    | `bandcamp_transaction_item_id`    | Unique per line item (v4)                           |
| `bandcamp_related_transaction_id` | `bandcamp_related_transaction_id` | Links refunds to original (v4)                      |
| `date`                            | `sale_date`                       | Exact sale timestamp                                |
| `paid_to`                         | `paid_to`                         | **ADD:** "Bandcamp" or "PayPal"                     |
| `item_type`                       | `item_type`                       | "album", "package", "track"                         |
| `item_name`                       | `item_name`                       | Merch item name                                     |
| `artist`                          | `artist`                          | Artist/band name                                    |
| `currency`                        | `currency`                        |                                                     |
| `item_price`                      | `item_price`                      |                                                     |
| `quantity`                        | `quantity`                        |                                                     |
| `discount_code`                   | `discount_code`                   | Marketing attribution                               |
| `sub_total`                       | `sub_total`                       | Before tax/shipping                                 |
| `additional_fan_contribution`     | `additional_fan_contribution`     | Tips above asking price                             |
| `seller_tax`                      | `seller_tax`                      |                                                     |
| `marketplace_tax`                 | `marketplace_tax`                 |                                                     |
| `tax_rate`                        | `tax_rate`                        |                                                     |
| `collection_society_share`        | `collection_society_share`        | Royalty deductions                                  |
| `shipping`                        | `shipping`                        |                                                     |
| `ship_from_country_name`          | `ship_from_country_name`          |                                                     |
| `transaction_fee`                 | `transaction_fee`                 | Platform fee                                        |
| `fee_type`                        | `fee_type`                        | "paypal" etc.                                       |
| `item_total`                      | `item_total`                      | Total charge                                        |
| `amount_you_received`             | `amount_received`                 | After all fees                                      |
| `net_amount`                      | `net_amount`                      | Net to seller                                       |
| `paypal_transaction_id`           | `paypal_transaction_id`           |                                                     |
| `package`                         | `package`                         | Format: "Compact Disc", "Vinyl", "digital download" |
| `option`                          | `option_name`                     | Variant option                                      |
| `item_url`                        | `item_url`                        | Album page URL                                      |
| `catalog_number`                  | `catalog_number`                  | **Label catalog number — key for SKU generation**   |
| `upc`                             | `upc`                             | **UPC/EAN — available from API, currently scraped** |
| `isrc`                            | `isrc`                            | **ISRC per track sale**                             |
| `sku`                             | `sku`                             | Item SKU                                            |
| `buyer_name`                      | `buyer_name`                      |                                                     |
| `buyer_email`                     | `buyer_email`                     |                                                     |
| `buyer_phone`                     | `buyer_phone`                     |                                                     |
| `buyer_note`                      | `buyer_note`                      |                                                     |
| `ship_notes`                      | `ship_notes`                      |                                                     |
| `ship_to_*` (7 fields)            | `ship_to_*`                       | Full shipping address                               |
| `ship_date`                       | `ship_date`                       |                                                     |
| `payment_state`                   | `payment_state`                   | paid, pending, refunded, failed                     |
| `country`                         | `country`                         | Buyer country                                       |
| `country_code`                    | `country_code`                    |                                                     |
| `region_or_state`                 | `region_or_state`                 |                                                     |
| `city`                            | `city`                            |                                                     |
| `referer`                         | `referer`                         | **How buyer found the item** (marketing gold)       |
| `referer_url`                     | `referer_url`                     |                                                     |


### Sales Report API: `generate_sales_report` + `fetch_sales_report` (async for large reports)

Same fields as `sales_report` but handles large datasets via async CSV generation. Used for the all-time backfill.

---

## 1c. What the scraper still provides (NOT available from any API)


| Data                                      | Source                           | Why API can't provide it                                            |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `about` (album description)               | `data-tralbum.current.about`     | Not in any API endpoint                                             |
| `credits` (recording credits)             | `data-tralbum.current.credits`   | Not in any API endpoint                                             |
| `trackinfo` (track names + durations)     | `data-tralbum.trackinfo[]`       | Not in any API endpoint                                             |
| Package photos (multi-image gallery)      | `data-tralbum.packages[].arts[]` | API gives one `image_url` per item; `arts[]` has all package photos |
| `is_preorder` / `album_is_preorder` flags | `data-tralbum`                   | API has `new_date` for future dating but no explicit preorder flag  |


Everything else the scraper currently fetches is available from the API and should come from there:


| Previously scraped       | Now from API        | API field                     |
| ------------------------ | ------------------- | ----------------------------- |
| Album page URL           | `get_merch_details` | `items[].url`                 |
| Release date             | `get_merch_details` | `items[].new_date`            |
| Album title              | `get_merch_details` | `items[].album_title`         |
| Type name (CD, LP, etc.) | `get_merch_details` | `items[].title` / `item_type` |
| Art URL                  | `get_merch_details` | `items[].image_url` (upsized) |
| UPC                      | `sales_report`      | `report[].upc`                |
| Subdomain                | `get_merch_details` | `items[].subdomain`           |


---

## 1d. Rationale chain — why each decision was made


| Decision                                   | Evidence                                                                                  | Rationale                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Authority lifecycle: initial → reviewed → locked | Bandcamp is first entry point; warehouse takes over after staff review | Source-authority transition model; prevents pile of one-off overwrite exceptions |
| Bandcamp SKUs overwrite during `bandcamp_initial` | User directive + audit: BC SKUs are set by labels, warehouse SKUs were derived | Labels set SKUs on Bandcamp first; warehouse mirrors until staff reviews |
| `new_date` sets `street_date` during `bandcamp_initial` | 56/56 exact match audit between API `new_date` and scraped `release_date` | Same date; API is more reliable than scraping; stops after review |
| Seed inventory during `bandcamp_initial` only | 43% audit mismatch: 152/357 items show 0 in warehouse, real stock on BC | One-time seed; `warehouse_reviewed` prevents future auto-seeding |
| Field ownership split (permanent vs initial) | Descriptive fields (URL, subdomain) are external facts; operational fields (SKU, qty) are warehouse-controlled after review | Clean separation avoids "overwrite everything forever" vs "overwrite nothing" binary |
| Store `options[]` as jsonb                 | Official API docs show option-level SKUs                                                  | Options have their own SKUs — needed for matching color/size variants                      |
| Store `raw_api_data` jsonb                 | Bandcamp returns undocumented fields (`url`, `new_date` not in docs)                      | Future-proof: capture everything, parse what we know, keep the rest                        |
| Sales Report API for all-time backfill     | Zero implementation exists; `bandcamp-sale-poll` only tracks deltas from mapping creation | Historical sales, revenue, refunds, catalog numbers completely missing                     |
| `catalog_number` for SKU generation        | Sales API field; SKU pattern is `format-label-catalog#` (e.g. `LP-NS-167`)                | Catalog number is the canonical release identifier across formats                          |
| Remove URL construction from sweep         | 846/919 review items were "Constructed URL returned 404"                                  | URL construction from product titles fails 85%+ of the time; API provides `url` directly   |
| Remove subdomain resolution                | API provides `subdomain` per merch item AND per member band                               | Two API fields eliminate all `bandIdToSubdomain` + `memberBandParentSubdomain` cache logic |
| SKU overwrite with audit trail             | Review identified order/shipment FK risk                                                  | Log old+new to `channel_sync_log`; skip when new SKU collides with existing variant        |
| Generalized `authority_status` (replaces `inventory_seed_status`) | Review identified race condition + broader lifecycle need | Single column governs all warehouse-owned field overwrites, not just inventory |
| Sales backfill in yearly chunks            | Review identified timeout risk for 10+ years of data                                      | Self-triggering task resumes from `last_processed_date`; each chunk capped at 5 min        |
| `updateSku` behind feature flag            | Review identified sparse API docs                                                         | Ship with flag `false`; manually test before enabling push                                 |
| `bandcamp_option_skus text[]` + GIN index  | Review identified jsonb query performance risk                                            | Extracted array enables fast `@>` containment queries for option-level matching            |
| Test on one connection first               | Review recommended defensive rollout                                                      | Northern Spy for 2-3 cycles before expanding to all 17 connections                         |


---

## 2. Evidence sources

- [TRUTH_LAYER.md](TRUTH_LAYER.md) — API-first invariant (line 34)
- [docs/system_map/API_CATALOG.md](docs/system_map/API_CATALOG.md) — `src/actions/bandcamp.ts` exports
- [docs/system_map/TRIGGER_TASK_CATALOG.md](docs/system_map/TRIGGER_TASK_CATALOG.md) — `bandcamp-sync`, `bandcamp-sale-poll`, `bandcamp-scrape-sweep`, queues
- [src/lib/clients/bandcamp.ts](src/lib/clients/bandcamp.ts) — `merchItemSchema` (lines 32-47), `bandSchema` (lines 14-26), `getMerchDetails`, `getOrders`
- [src/trigger/tasks/bandcamp-sync.ts](src/trigger/tasks/bandcamp-sync.ts) — matched upsert (789-820), unmatched insert (1072-1085), `triggerScrapeIfNeeded` (613-685)
- [src/trigger/tasks/bandcamp-sale-poll.ts](src/trigger/tasks/bandcamp-sale-poll.ts) — current sales tracking via `getMerchDetails` quantity_sold delta
- [supabase/migrations/20260316000007_bandcamp.sql](supabase/migrations/20260316000007_bandcamp.sql) — `bandcamp_product_mappings` schema
- Official Bandcamp API docs: [Merch](https://bandcamp.com/developer/merch), [Sales](https://bandcamp.com/developer/sales), [Account](https://bandcamp.com/developer/account)
- Live audit: 1,367 API items, 104 SKU matches (7.6%), `new_date` = `release_date` in 56/56 verified cases

---

## 3. API boundaries impacted

- **[src/lib/clients/bandcamp.ts](src/lib/clients/bandcamp.ts)** — expand `merchItemSchema` (add `subdomain`, `options[]`, `origin_quantities[]`, `is_set_price`), expand `bandSchema.member_bands[]` (add `subdomain`), add `.passthrough()`, implement `salesReport()`, `generateSalesReport()`, `fetchSalesReport()`, `updateSku()`
- **[src/actions/bandcamp.ts](src/actions/bandcamp.ts)** — new exports: `getBandcampSalesHistory`, `triggerSalesBackfill`, `getBandcampFullItemData`; update `getBandcampScraperHealth` to include sales stats
- **[docs/system_map/API_CATALOG.md](docs/system_map/API_CATALOG.md)** — add new exports

---

## 4. Trigger touchpoint check


| Task ID                                | Change                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bandcamp-sync` / `bandcamp-sync-cron` | Store ALL merch fields; overwrite warehouse SKU + street_date with API values; option-level SKU matching; auto-generate missing SKUs |
| `bandcamp-sale-poll`                   | Keep for real-time inventory deltas; add `catalog_number`/`upc` storage when available from sales data                               |
| `bandcamp-scrape-page`                 | Remove URL/date/UPC responsibility; scrape only: about, credits, tracks, package photos                                              |
| `bandcamp-scrape-sweep`                | Simplify — only sweep for items needing enrichment (about/credits/tracks), not URL resolution                                        |
| *New* `bandcamp-sales-backfill`        | One-time + on-demand: pull all-time sales via `generate_sales_report` / `fetch_sales_report` for each connection                     |
| *New* `bandcamp-sales-sync`            | Daily cron: pull yesterday's sales via `sales_report` to keep `bandcamp_sales` current                                               |
| `catalog-stats-refresh`                | Add sales aggregates to `workspace_catalog_stats` snapshot                                                                           |
| `sensor-check`                         | Add `bandcamp.sales_sync_stale` sensor                                                                                               |


---

## 5. Proposed implementation steps

### Phase 1: Schema + API client expansion

**Migration: `<new>_bandcamp_api_complete.sql`**

```sql
-- 1. New columns on bandcamp_product_mappings (API data we're not storing)
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_subdomain text,
  ADD COLUMN IF NOT EXISTS bandcamp_album_title text,
  ADD COLUMN IF NOT EXISTS bandcamp_price numeric,
  ADD COLUMN IF NOT EXISTS bandcamp_currency text,
  ADD COLUMN IF NOT EXISTS bandcamp_is_set_price boolean,
  ADD COLUMN IF NOT EXISTS bandcamp_options jsonb,
  ADD COLUMN IF NOT EXISTS bandcamp_origin_quantities jsonb,
  ADD COLUMN IF NOT EXISTS bandcamp_catalog_number text,
  ADD COLUMN IF NOT EXISTS bandcamp_upc text,
  ADD COLUMN IF NOT EXISTS bandcamp_option_skus text[],
  ADD COLUMN IF NOT EXISTS authority_status text NOT NULL DEFAULT 'bandcamp_initial'
    CHECK (authority_status IN ('bandcamp_initial','warehouse_reviewed','warehouse_locked')),
  ADD COLUMN IF NOT EXISTS raw_api_data jsonb;

-- GIN index for option-level SKU lookups
CREATE INDEX IF NOT EXISTS idx_mappings_option_skus
  ON bandcamp_product_mappings USING GIN (bandcamp_option_skus)
  WHERE bandcamp_option_skus IS NOT NULL;

-- 2. Sales transaction table (all-time history)
CREATE TABLE IF NOT EXISTS bandcamp_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid REFERENCES bandcamp_connections(id),
  bandcamp_transaction_id bigint NOT NULL,
  bandcamp_transaction_item_id bigint NOT NULL,
  bandcamp_related_transaction_id bigint,
  sale_date timestamptz NOT NULL,
  item_type text,
  item_name text,
  artist text,
  album_title text,
  package text,
  option_name text,
  sku text,
  catalog_number text,
  upc text,
  isrc text,
  item_url text,
  currency text,
  item_price numeric,
  quantity integer,
  sub_total numeric,
  shipping numeric,
  tax numeric,
  seller_tax numeric,
  marketplace_tax numeric,
  tax_rate numeric,
  transaction_fee numeric,
  fee_type text,
  item_total numeric,
  amount_received numeric,
  net_amount numeric,
  additional_fan_contribution numeric,
  discount_code text,
  collection_society_share numeric,
  buyer_name text,
  buyer_email text,
  buyer_phone text,
  buyer_note text,
  ship_to_name text,
  ship_to_street text,
  ship_to_street_2 text,
  ship_to_city text,
  ship_to_state text,
  ship_to_zip text,
  ship_to_country text,
  ship_to_country_code text,
  ship_date timestamptz,
  ship_notes text,
  ship_from_country_name text,
  paid_to text,
  payment_state text,
  referer text,
  referer_url text,
  country text,
  country_code text,
  region_or_state text,
  city text,
  paypal_transaction_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, bandcamp_transaction_id, bandcamp_transaction_item_id)
);

CREATE INDEX idx_bandcamp_sales_workspace_date
  ON bandcamp_sales (workspace_id, sale_date DESC);
CREATE INDEX idx_bandcamp_sales_sku
  ON bandcamp_sales (workspace_id, sku)
  WHERE sku IS NOT NULL;
CREATE INDEX idx_bandcamp_sales_catalog_number
  ON bandcamp_sales (workspace_id, catalog_number)
  WHERE catalog_number IS NOT NULL;

ALTER TABLE bandcamp_sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read sales in their workspace"
  ON bandcamp_sales FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage sales"
  ON bandcamp_sales FOR ALL
  USING (true)
  WITH CHECK (true);

-- Note: We use Sales API v4 exclusively, which always provides
-- bandcamp_transaction_item_id (unique per line item within a transaction).
-- The composite (transaction_id, transaction_item_id) is globally unique.

-- 3. Track backfill progress per connection
CREATE TABLE IF NOT EXISTS bandcamp_sales_backfill_state (
  connection_id uuid PRIMARY KEY REFERENCES bandcamp_connections(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed')),
  earliest_sale_date timestamptz,
  latest_sale_date timestamptz,
  total_transactions integer DEFAULT 0,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**[src/lib/clients/bandcamp.ts](src/lib/clients/bandcamp.ts) — expand schemas + add Sales API:**

- `bandSchema.member_bands[]`: add `subdomain: z.string().optional()`
- `merchItemSchema`: add `subdomain`, `is_set_price`, `options` (array of `{option_id, title, sku, quantity_available, quantity_sold}`), `origin_quantities` (array). Add `.passthrough()` to all.
- New function: `salesReport(bandId, accessToken, startTime, endTime)` — calls `POST https://bandcamp.com/api/sales/4/sales_report`
- New function: `generateSalesReport(bandId, accessToken, startTime, endTime, format?)` — calls `POST https://bandcamp.com/api/sales/4/generate_sales_report`; returns `{ token: string }`
- New function: `fetchSalesReport(token, accessToken)` — calls `POST https://bandcamp.com/api/sales/4/fetch_sales_report`; returns `{ url: string }` (a **download URL** for the report file) or `{ error: true, error_message: "Report hasn't generated yet" }`. Caller must download from the URL separately and parse the JSON/CSV content.
- New function: `updateSku(items, accessToken)` — calls `POST https://bandcamp.com/api/merchorders/1/update_sku`

### Phase 2: Bandcamp sync — use ALL API data, fix SKU matching

**[src/trigger/tasks/bandcamp-sync.ts](src/trigger/tasks/bandcamp-sync.ts):**

**Matched item upsert (~line 789)** — store every API field:

- Add to upsert payload: `bandcamp_subdomain`, `bandcamp_album_title`, `bandcamp_price`, `bandcamp_currency`, `bandcamp_is_set_price`, `bandcamp_options` (jsonb), `bandcamp_origin_quantities` (jsonb), `raw_api_data` (full item as jsonb)
- **Always update** `bandcamp_url` with `merchItem.url` (Bandcamp-permanent field, always synced)
- **Always update** `bandcamp_new_date` with `merchItem.new_date` (Bandcamp-permanent on the mapping; warehouse `street_date` only set when `authority_status = 'bandcamp_initial'`)

**Warehouse variant updates (~line 845)** — governed by `authority_status` lifecycle:

**When `authority_status = 'bandcamp_initial'`** (default for new items):
- `street_date`: set to `merchItem.new_date`
- `sku`: overwrite warehouse SKU with Bandcamp SKU (with audit trail in `channel_sync_log`, `sync_type: "sku_overwrite"`, metadata: `{ old_sku, new_sku }`). If new SKU collides with existing variant, skip and log to review queue.
- `is_preorder`: set based on `new_date > now()`
- `price`: set from API
- `quantity`: seed warehouse `available` from `merchItem.quantity_available` when warehouse is 0 (via `recordInventoryChange`, source: `"bandcamp_initial_seed"`, idempotent correlationId)

**When `authority_status = 'warehouse_reviewed'`**:
- `street_date`, `sku`, `price`, `quantity`: **NOT overwritten** — warehouse owns these
- Bandcamp-permanent fields still update: `bandcamp_url`, `bandcamp_subdomain`, `bandcamp_album_title`, `bandcamp_options`, `bandcamp_origin_quantities`, `raw_api_data`, `bandcamp_image_url`, `bandcamp_price` (stored on mapping as reference, not pushed to variant)

**When `authority_status = 'warehouse_locked'`**:
- No auto-sync overwrites anything on warehouse tables
- Mapping still receives updated API data for reference (Bandcamp-permanent fields)

**Authority transitions:**
- Staff review in admin UI (e.g. confirming product details, editing SKU, adjusting inventory) → sets `authority_status = 'warehouse_reviewed'`
- Staff explicit lock (admin action) → sets `authority_status = 'warehouse_locked'`
- Staff explicit re-sync from Bandcamp (admin action) → sets `authority_status = 'bandcamp_initial'` to re-enable overwrites

**Option SKU extraction:**
- When syncing `options[]`, extract all option SKUs into `bandcamp_option_skus text[]` on the mapping for fast GIN-indexed lookups

**SKU matching — add option-level matching:**

- After current `matchSkuToVariants` (item-level SKU), iterate `merchItem.options[]` and try matching each `option.sku` against warehouse variants
- This should dramatically improve the 7.6% match rate since many items have option-level SKUs (color variants, etc.)

**Unmatched items — auto-generate SKUs with collision detection:**

- For items without SKU on Bandcamp: generate using pattern:
  1. If `catalog_number` available (from sales data): `{format}-{catalog_number}` (e.g. `LP-NS-167`)
  2. Else: `{format}-{artistInitials}-{slugifiedAlbumTitle}` (e.g. `LP-HL-INTERVENTIONS`)
- Format codes derived from `item_type` / `title`: LP, CD, CS (cassette), 7IN, 10IN, 12IN, TS (t-shirt), POSTER, BAG, HOODIE, etc.
- **Collision detection:** Before inserting, check `warehouse_product_variants` for existing SKU with same value. If collision found, append numeric suffix (`LP-NS-167-2`, `LP-NS-167-3`, etc.)
- Push generated SKU back to Bandcamp via `updateSku` API — **behind feature flag** (`bandcamp_scraper_settings.enable_sku_push`) until API behavior is manually verified. Flag default: `false`.
- Store `sku_source: 'auto_generated'` on the mapping for audit trail

### Phase 3: Sales Report API — implementation + all-time backfill

**New task: `bandcamp-sales-backfill` (on-demand + staff-triggered, resumable in yearly chunks):**

- Processes **one connection at a time**, in **1-year chunks** for reliability (10+ years of data could timeout in one request)
- Flow per chunk:
  1. Read `bandcamp_sales_backfill_state` for the connection — get `last_processed_date` (or start from `2010-01-01` if first run)
  2. Set `chunk_end = last_processed_date + 1 year` (capped at today)
  3. Call `generate_sales_report` with `start_time = chunk_start, end_time = chunk_end`
  4. Poll `fetch_sales_report` with exponential backoff (max 60 attempts, 5s delay) until report ready
  5. Parse response, deduplicate by `(workspace_id, bandcamp_transaction_id, bandcamp_transaction_item_id)`, upsert into `bandcamp_sales`
  6. Extract `catalog_number`, `upc`, `isrc` from sales rows and backfill onto `bandcamp_product_mappings` where matching SKU found
  7. Update `bandcamp_sales_backfill_state`: `last_processed_date = chunk_end`, `total_transactions += rows inserted`
  8. If `chunk_end < today`: **self-trigger** `bandcamp-sales-backfill` for the next chunk (recursive continuation)
  9. If `chunk_end >= today`: set `status = 'completed'`
- `maxDuration: 300` per chunk (5 minutes — enough for 1 year of data)
- If task fails mid-chunk: `status = 'failed'`, `last_error` saved. Staff can re-trigger to resume from the last successful chunk.
- Rate limit: one connection at a time via `bandcamp-api` queue (concurrency 1)

**New task: `bandcamp-sales-sync` (daily cron):**

- Schedule: `0 5` * * * (daily 5am UTC)
- For each connection: call `sales_report` (synchronous, small window) with `start_time = yesterday, end_time = now`
- Upsert into `bandcamp_sales`
- Update `catalog_number`/`upc`/`isrc` on mappings when new data found

**Staff action: `triggerSalesBackfill(connectionId?)`:**

- Triggers the backfill task for one or all connections
- Shows progress in admin UI via `bandcamp_sales_backfill_state`

### Phase 4: Scraper simplification

**[src/trigger/tasks/bandcamp-sync.ts](src/trigger/tasks/bandcamp-sync.ts) — `triggerScrapeIfNeeded`:**

- Remove URL construction fallback (`buildBandcampAlbumUrl` / `extractAlbumTitle`) — API provides `url` directly
- Remove subdomain resolution logic (`bandIdToSubdomain` / `memberBandParentSubdomain`) — API provides `subdomain` directly
- Scrape is only triggered when mapping is missing: `about`, `credits`, `tracks`, or has no package photos
- Scrape URL always comes from API `merchItem.url`

**[src/trigger/tasks/bandcamp-scrape-sweep.ts](src/trigger/tasks/bandcamp-scrape-sweep.ts):**

- **Group 1** (has URL, no type): keep as-is (re-scrape for enrichment)
- **Group 2** (no URL, no type): remove entirely — URL now comes from API, not construction
- **Group 3** (has art, no about): keep (enrichment backfill)
- Remove all `extractAlbumTitle`, `buildBandcampAlbumUrl`, subdomain resolution code from sweep

**[src/lib/clients/bandcamp-scraper.ts](src/lib/clients/bandcamp-scraper.ts):**

- `extractAlbumTitle` and related format-stripping code can be deprecated/removed
- Keep: `fetchBandcampPage`, `parseBandcampPage`, `buildBandcampAlbumUrl` (for edge cases), `BandcampFetchError`

### Phase 5: Admin UI + catalog enrichment

**Bandcamp settings page — Sales tab:**

- New tab: "Sales History" alongside Accounts and Scraper & Catalog Health
- Shows: total revenue, units sold, refund count per connection
- Backfill status per connection (pending/running/completed/failed)
- "Start Backfill" button per connection or "Backfill All"

**Catalog page (`/admin/catalog/[id]`) — Bandcamp data panel:**

- Expandable section showing ALL API data for each variant's mapping
- Fields: `album_title`, `subdomain`, `url`, `price`, `currency`, `new_date`, `options[]`, `origin_quantities[]`, `catalog_number`, `upc`, `isrc`
- Sales summary: total units sold, total revenue, last sale date (from `bandcamp_sales`)
- Raw API JSON viewer (from `raw_api_data` column)

**Server action: `getBandcampFullItemData(variantId)`:**

- Returns all mapping fields + aggregated sales data + raw API snapshot

---

## 6. Risk + rollback

- **SKU overwrite propagation**: Bandcamp SKUs overwrite warehouse during `bandcamp_initial` only. After staff reviews (`warehouse_reviewed`), SKU is frozen. **Mitigated by:** `authority_status` lifecycle; audit trail in `channel_sync_log` (`sync_type: "sku_overwrite"`) with old + new values; SKU collision check prevents overwriting when new SKU already belongs to a different variant.
- **Inventory seeding race condition**: Staff correction happens between seed cycles. **Mitigated by:** `authority_status = 'warehouse_reviewed'` permanently stops auto-seeding for that item. One-time seed only when status = `bandcamp_initial`.
- **Sales API rate limits**: Bandcamp docs don't specify limits. **Mitigated by:** one connection at a time via `bandcamp-api` queue (concurrency 1); yearly chunks with self-triggering; exponential backoff on polling.
- **Large sales reports / task timeout**: 10+ years of sales could be large. **Mitigated by:** yearly chunk pattern with resumable state; `maxDuration: 300` per chunk; failed chunks can be retried from `last_processed_date`.
- **Street date overwrite during `bandcamp_initial`**: `new_date` overwrites `street_date` only when `authority_status = 'bandcamp_initial'`. After staff review, warehouse date is frozen. Bandcamp `new_date` still stored on the mapping as reference.
- `**update_sku` API unknown behavior**: Docs are sparse. **Mitigated by:** feature flag (`enable_sku_push`) default `false`. Manually test before enabling. Plan ships without enabling by default.
- **Auto-generated SKU collisions**: Two items could generate same SKU. **Mitigated by:** uniqueness check + numeric suffix append (`-2`, `-3`).
- **Option-level SKU matching performance**: jsonb queries can be slow. **Mitigated by:** extracted `bandcamp_option_skus text[]` column with GIN index.
- **Rollback**: revert migration (drop new columns/tables); redeploy previous Trigger version; SKU changes recoverable from `channel_sync_log` audit trail; `authority_status` can be reset to `bandcamp_initial` to re-enable auto-sync if needed.

---

## 6b. Execution order (defensive — test before expanding)

```
1. Migration (with all new columns, tables, RLS, indexes)
2. API client expansion (merchItemSchema, bandSchema, Sales API funcs — WITHOUT updateSku initially)
3. bandcamp-sync changes (store all fields, SKU overwrite with audit, inventory seed with status tracking)
4. Deploy + test on ONE connection (e.g. Northern Spy) for 2-3 sync cycles
   - Verify: mappings have subdomain, album_title, options, raw_api_data
   - Verify: warehouse SKUs updated (check channel_sync_log for sku_overwrite entries)
   - Verify: inventory seeded (check channel_sync_log for bandcamp_initial_seed)
   - Verify: street_dates updated
5. Sales backfill (yearly chunks, start with Northern Spy)
   - Verify: bandcamp_sales rows appear with catalog_number, upc
   - Verify: catalog_number/upc backfilled to bandcamp_product_mappings
6. Enable for all connections
7. Scraper simplification (only after sync is stable for all connections)
8. Admin UI (Phase 5 — catalog page data panel, sales history tab)
9. Enable updateSku push (behind flag, after manual API testing)
```

---

## 7. Verification

- `pnpm typecheck`, `pnpm check`
- `supabase migration list --linked` — confirm new migration applied
- `supabase db push --yes` — apply migration
- `npx trigger.dev deploy` — deploy updated tasks
- Post-deploy checks:
  - Trigger `bandcamp-sync` manually; verify mappings now have `bandcamp_subdomain`, `bandcamp_album_title`, `bandcamp_options`, `raw_api_data`
  - Verify warehouse `street_date` updated to match API `new_date`
  - Verify warehouse SKUs updated to match Bandcamp SKUs
  - Trigger `bandcamp-sales-backfill` for one connection; verify `bandcamp_sales` rows appear with `catalog_number`, `upc`
  - Check admin catalog page shows full Bandcamp data panel
  - Check Scraper & Catalog Health tab — completeness numbers should improve (URL coverage near 100%)

---

## 8. Doc Sync Contract

- **[TRUTH_LAYER.md](TRUTH_LAYER.md)** — update invariant to authority lifecycle: "Bandcamp is authoritative for initial ingest (new titles, SKU/quantity/date bootstrap). After staff review or physical count, warehouse app becomes authoritative for operational fields (SKU, quantity, price, dates). Bandcamp remains authoritative for descriptive/external fields (URL, subdomain, album_title, options, sales data) permanently. Field ownership: Bandcamp-permanent vs warehouse-after-review, governed by `authority_status` on `bandcamp_product_mappings`."
- **[docs/system_map/API_CATALOG.md](docs/system_map/API_CATALOG.md)** — add `getBandcampSalesHistory`, `triggerSalesBackfill`, `getBandcampFullItemData`; add Sales Report API note
- **[docs/system_map/TRIGGER_TASK_CATALOG.md](docs/system_map/TRIGGER_TASK_CATALOG.md)** — add `bandcamp-sales-backfill`, `bandcamp-sales-sync`; update `bandcamp-sync` description; update `bandcamp-scrape-sweep` (Group 2 removed)
- **[project_state/journeys.yaml](project_state/journeys.yaml)** — update `bandcamp_scraper_health` journey; add `bandcamp_sales_data` journey
- **[project_state/engineering_map.yaml](project_state/engineering_map.yaml)** — add Sales API + SKU reconciliation to integrations responsibilities

---

## 9. Complete file manifest

### Files MODIFIED


| File                                         | Changes                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/clients/bandcamp.ts`                | Expand `merchItemSchema` (add subdomain, options, origin_quantities, is_set_price + .passthrough()); expand `bandSchema.member_bands[]` (add subdomain); add `salesReport()`, `generateSalesReport()`, `fetchSalesReport()`, `updateSku()` functions                |
| `src/trigger/tasks/bandcamp-sync.ts`         | Store ALL API fields on mapping upsert; overwrite warehouse SKU/street_date/price; seed inventory from quantity_available; option-level SKU matching; auto-generate missing SKUs; simplify `triggerScrapeIfNeeded` (remove URL construction + subdomain resolution) |
| `src/trigger/tasks/bandcamp-sale-poll.ts`    | When `catalog_number`/`upc` available from sales data, backfill to mapping                                                                                                                                                                                          |
| `src/trigger/tasks/bandcamp-scrape-sweep.ts` | Remove Group 2 (URL construction); remove `extractAlbumTitle`/`buildBandcampAlbumUrl`/subdomain code; keep Group 1 + 3 for enrichment only                                                                                                                          |
| `src/lib/clients/bandcamp-scraper.ts`        | Deprecate `extractAlbumTitle`; keep `fetchBandcampPage`, `parseBandcampPage`, `BandcampFetchError`                                                                                                                                                                  |
| `src/trigger/tasks/sensor-check.ts`          | Add `bandcamp.sales_sync_stale` sensor                                                                                                                                                                                                                              |
| `src/trigger/tasks/catalog-stats-refresh.ts` | Add sales aggregates to snapshot                                                                                                                                                                                                                                    |
| `src/trigger/tasks/index.ts`                 | Export new tasks: `bandcampSalesBackfillTask`, `bandcampSalesSyncSchedule`                                                                                                                                                                                          |
| `src/actions/bandcamp.ts`                    | Add `getBandcampSalesHistory`, `triggerSalesBackfill`, `getBandcampFullItemData`                                                                                                                                                                                    |
| `src/app/admin/settings/bandcamp/page.tsx`   | Add Sales History tab with backfill status + trigger                                                                                                                                                                                                                |
| `src/app/admin/catalog/[id]/page.tsx`        | Add Bandcamp data panel (all API fields + sales summary + raw JSON viewer)                                                                                                                                                                                          |
| `src/lib/shared/query-keys.ts`               | Add `bandcamp.salesHistory`, `bandcamp.fullItemData` keys                                                                                                                                                                                                           |
| `TRUTH_LAYER.md`                             | Update invariant: API data is authoritative, overwrites warehouse                                                                                                                                                                                                   |
| `docs/system_map/API_CATALOG.md`             | Add new exports + Sales Report API note                                                                                                                                                                                                                             |
| `docs/system_map/TRIGGER_TASK_CATALOG.md`    | Add new tasks; update existing task descriptions                                                                                                                                                                                                                    |
| `project_state/journeys.yaml`                | Update scraper journey; add sales data journey                                                                                                                                                                                                                      |
| `project_state/engineering_map.yaml`         | Add Sales API + SKU reconciliation responsibilities                                                                                                                                                                                                                 |


### Files CREATED


| File                                                  | Purpose                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `supabase/migrations/<new>_bandcamp_api_complete.sql` | New columns on mappings + `bandcamp_sales` table + `bandcamp_sales_backfill_state` table |
| `src/trigger/tasks/bandcamp-sales-backfill.ts`        | On-demand task: pull all-time sales history per connection via async Sales Report API    |
| `src/trigger/tasks/bandcamp-sales-sync.ts`            | Daily cron: pull yesterday's sales via synchronous Sales Report API                      |


### Files NOT changed (verified no impact)


| File                                           | Reason                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/trigger/tasks/bandcamp-order-sync.ts`     | Order sync is separate from merch/sales; no changes needed                     |
| `src/trigger/tasks/bandcamp-mark-shipped.ts`   | Shipping flow unchanged                                                        |
| `src/trigger/tasks/bandcamp-inventory-push.ts` | Inventory push direction (warehouse → BC) unchanged                            |
| `src/lib/server/record-inventory-change.ts`    | Inventory write path unchanged; called with new source `bandcamp_initial_seed` |
| `src/lib/server/inventory-fanout.ts`           | Fanout logic unchanged                                                         |


---

## 10. Handoff checklist

1. Read this plan top to bottom; confirm all API fields in §1b are accounted for
2. Verify migration SQL creates all columns/tables/indexes
3. Deploy order: migration first → Trigger deploy → Vercel push → trigger sales backfill
4. Monitor first sync cycle: check `channel_sync_log` for `bandcamp_initial_seed` entries, verify SKU overwrites in audit log
5. Trigger sales backfill for one connection (e.g. Northern Spy); verify `bandcamp_sales` rows with `catalog_number`/`upc`
6. Once verified, trigger backfill for all connections
7. After backfill: check admin catalog page for full Bandcamp data panel
8. After physical inventory counts: staff updates override Bandcamp seed and push corrections

