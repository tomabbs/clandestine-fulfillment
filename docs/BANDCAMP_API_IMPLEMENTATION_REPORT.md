# Bandcamp API Implementation Report

**Date:** 2026-03-19  
**Purpose:** Comprehensive audit of Bandcamp API capabilities vs. our implementation, with a grid showing API vs. scraping coverage.

---

## 1. Bandcamp API Capabilities (Official)

Source: [bandcamp.com/developer](https://bandcamp.com/developer)

### Account API

| Endpoint | URL | Purpose |
|----------|-----|---------|
| `my_bands` | `POST /api/account/1/my_bands` | Get bands/labels affiliated with account, including member_bands |

**Returns:** `bands[]` with `band_id`, `name`, `subdomain`, `member_bands[]` (band_id, name, subdomain)

---

### Merch Orders API

| Endpoint | URL | Purpose |
|----------|-----|---------|
| `get_merch_details` | `POST /api/merchorders/1/get_merch_details` | List merchandise for sale |
| `get_orders` | `POST /api/merchorders/1-4/get_orders` | Query orders (v4: payment_state includes failed) |
| `get_shipping_origin_details` | `POST /api/merchorders/1/get_shipping_origin_details` | List shipping origins |
| `update_shipped` | `POST /api/merchorders/1-2/update_shipped` | Mark orders shipped (v2: carrier, tracking_code) |
| `mark_date_range_as_shipped` | `POST /api/merchorders/1/mark_date_range_as_shipped` | Batch mark shipped by date range |
| `update_quantities` | `POST /api/merchorders/1/update_quantities` | Update inventory levels |
| `update_sku` | `POST /api/merchorders/1/update_sku` | Update SKU on packages/options |

**get_merch_details documented return fields:** `package_id`, `album_title`, `title`, `image_url`, `quantity_available`, `quantity_sold`, `price`, `currency`, `subdomain`, `is_set_price`, `sku`, `options[]`, `origin_quantities[]`

**get_orders return fields:** `sale_item_id`, `payment_id`, `order_date`, `paypal_id`, `sku`, `item_name`, `item_url`, `artist`, `option`, `buyer_*`, `ship_to_*`, `ship_date`, `payment_state`, etc.

---

### Sales Report API

| Endpoint | URL | Purpose |
|----------|-----|---------|
| `sales_report` | `POST /api/sales/4/sales_report` | Sync sales report (JSON array) |
| `generate_sales_report` | `POST /api/sales/4/generate_sales_report` | Async report generation |
| `fetch_sales_report` | `POST /api/sales/4/fetch_sales_report` | Download generated report |

**Returns:** `report[]` with transaction details, buyer info, item_url, sku, etc.

---

## 2. Implementation Grid

| Capability | API Provides | We Get from API | We Scrape | Gap / Notes |
|------------|--------------|-----------------|-----------|--------------|
| **Account / Bands** | | | | |
| Band list | ✅ `my_bands` | ✅ `band_id`, `name`, `subdomain`, `member_bands` | — | Complete |
| **Merch Catalog** | | | | |
| Package ID | ✅ `get_merch_details` | ✅ `package_id` | — | Complete |
| Title | ✅ `get_merch_details` | ✅ `title` | — | Complete |
| Album title | ✅ `get_merch_details` | ✅ `album_title` | — | Complete |
| SKU | ✅ `get_merch_details` | ✅ `sku` | — | Complete |
| Price | ✅ `get_merch_details` | ✅ `price` | — | Complete |
| Currency | ✅ `get_merch_details` | ✅ `currency` | — | Complete |
| Quantity available | ✅ `get_merch_details` | ✅ `quantity_available` | — | Complete |
| Quantity sold | ✅ `get_merch_details` | ✅ `quantity_sold` | — | Complete |
| Item type (format) | ❌ Not in docs | ✅ `item_type` (undocumented) | ✅ `type_name` (TralbumData) | API may return; scraper backup |
| Release / street date | ❌ Not in docs | ✅ `new_date` (undocumented) | ✅ `release_date`, `new_date` per package | API may return; scraper backup |
| Album page URL | ❌ Not in docs | ✅ `url` (undocumented) | ✅ `url` per package | API may return; scraper uses for fetch |
| Image URL | ✅ `get_merch_details` | ✅ `image_url` (thumbnail, we upscale to _10.jpg) | — | Complete |
| **Images (richer)** | | | | |
| Album art (cover) | ❌ | — | ✅ `art_id` → bcbits URL | Scraper only |
| Multiple merch images | ❌ | — | ✅ `packages[].image_id`, `arts[]` | Scraper only |
| **Options (variants)** | | | | |
| Option variants | ✅ `options[]` | ❌ Not used | — | **Gap:** We treat 1 package = 1 SKU; options not modeled |
| Option-level SKU | ✅ `options[].sku` | ❌ | — | **Gap:** We don't create separate variants per option |
| **Inventory** | | | | |
| Push inventory | ✅ `update_quantities` | ✅ `bandcamp-inventory-push` | — | Complete |
| **Orders / Sales** | | | | |
| Orders list | ✅ `get_orders` | ❌ Not used | — | **Gap:** We poll `quantity_sold` instead of orders |
| Mark shipped | ✅ `update_shipped` | ❌ Not used | — | **Gap:** No Bandcamp shipping update |
| Sales report | ✅ `sales_report` / `generate` / `fetch` | ❌ Not used | — | **Gap:** No sales reporting integration |
| **Shipping** | | | | |
| Shipping origins | ✅ `get_shipping_origin_details` | ❌ Not used | — | **Gap:** Not used |
| **SKU** | | | | |
| Update SKU | ✅ `update_sku` | ❌ Not used | — | **Gap:** We don't push SKU changes to Bandcamp |

---

## 3. Our Implementation Summary

### API Endpoints We Use

| Endpoint | File | Usage |
|----------|------|-------|
| `oauth_token` | `bandcamp.ts` | Token refresh |
| `my_bands` | `bandcamp.ts` | Get bands for connections |
| `get_merch_details` | `bandcamp.ts` | Catalog sync, sale poll, inventory push |
| `update_quantities` | `bandcamp.ts` | Push inventory to Bandcamp |

### Scraper (HTML / TralbumData)

| Source | File | Extracts |
|--------|------|----------|
| Album page HTML | `bandcamp-scraper.ts` | `data-tralbum` or `var TralbumData` |
| `parseTralbumData` | `bandcamp-scraper.ts` | `art_id`, `release_date`, `packages[]` (type_name, new_date, url, sku, image_id, arts) |

### Trigger Tasks

| Task | Purpose |
|------|---------|
| `bandcamp-sync` | Full catalog sync (merch details + scrape) |
| `bandcamp-scrape-page` | Scrape single album page for release date + images |
| `bandcamp-sale-poll` | Poll `quantity_sold` to detect sales → inventory decrement |
| `bandcamp-inventory-push` | Push warehouse inventory to Bandcamp |

---

## 4. Gaps & Recommendations

### High Priority

| Gap | Impact | Recommendation |
|-----|--------|-----------------|
| **Options not modeled** | Products with options (e.g. T-shirt sizes) are treated as single SKU. Option-level inventory is not tracked. | Evaluate: create separate warehouse variants per `options[].sku` or document as known limitation. |
| **No orders ingestion** | We infer sales from `quantity_sold` delta; we don't get order details (buyer, address, items). | If order fulfillment is needed from Bandcamp: add `get_orders` poll and create warehouse orders. |

### Medium Priority

| Gap | Impact | Recommendation |
|-----|--------|-----------------|
| **No mark shipped** | Bandcamp doesn't know when we ship. | Add `update_shipped` when marking orders shipped in our system. |
| **No sales report** | No integration with Bandcamp sales report for accounting/billing. | Consider `sales_report` or `generate_sales_report` for reconciliation. |

### Low Priority

| Gap | Impact | Recommendation |
|-----|--------|-----------------|
| **Shipping origins** | Not used. | Only needed if we have multi-origin fulfillment. |
| **update_sku** | We don't push SKU changes to Bandcamp. | Add if SKU edits in our system should sync to Bandcamp. |

---

## 5. API vs. Scraper Field Mapping

### get_merch_details (API) — Documented + Undocumented

| Field | In Docs | We Use |
|-------|---------|--------|
| package_id | ✅ | ✅ |
| title | ✅ | ✅ |
| album_title | ✅ | ✅ |
| image_url | ✅ | ✅ (upscale to 700px) |
| quantity_available | ✅ | ✅ |
| quantity_sold | ✅ | ✅ |
| price | ✅ | ✅ |
| currency | ✅ | ✅ |
| subdomain | ✅ | ❌ |
| is_set_price | ✅ | ❌ |
| sku | ✅ | ✅ |
| options | ✅ | ❌ |
| origin_quantities | ✅ | ❌ |
| url | ❌ | ✅ |
| new_date | ❌ | ✅ |
| item_type | ❌ | ✅ |
| member_band_id | ❌ | ✅ |

### TralbumData (Scraper)

| Field | Source | We Use |
|-------|--------|--------|
| art_id | HTML | ✅ → album art URL |
| release_date | HTML | ✅ → street_date |
| item_type / current.type | HTML | ✅ → format_name |
| current.title | HTML | ✅ |
| packages[].type_name | HTML | ✅ |
| packages[].new_date | HTML | ✅ → street_date |
| packages[].url | HTML | ✅ (for scrape trigger) |
| packages[].sku | HTML | ✅ → package match |
| packages[].image_id | HTML | ✅ → merch image URL |
| packages[].arts[] | HTML | ✅ → extra images |

---

## 6. Completeness Checklist

| Area | Status | Notes |
|------|--------|-------|
| Catalog sync | ✅ Complete | API + scraper for metadata + images |
| Inventory sync (inbound) | ✅ Complete | Sale poll detects sales, decrements |
| Inventory sync (outbound) | ✅ Complete | Inventory push to Bandcamp |
| Release date | ✅ Complete | API new_date + scraper release_date |
| Images | ✅ Complete | API + scraper (album art, extra images) |
| Product type/format | ✅ Complete | API item_type + scraper type_name |
| Options/variants | ⚠️ Partial | API has options; we don't model |
| Orders | ❌ Not implemented | Not used |
| Mark shipped | ❌ Not implemented | Not used |
| Sales report | ❌ Not implemented | Not used |
| Shipping origins | ❌ Not implemented | Not used |
| Update SKU | ❌ Not implemented | Not used |

---

## 7. Summary

**Implementation is complete and expansive for core 3PL use:** catalog sync, inventory sync (both directions), release dates, and images. The scraper correctly fills gaps where the API does not provide data (album art, multiple images, release date when API omits it).

**Not implemented:** Orders ingestion, mark shipped, sales report, shipping origins, SKU push. These are secondary for a warehouse fulfillment flow that prioritizes inventory sync and catalog accuracy.

**Options:** The API returns `options[]` (e.g. T-shirt sizes) with per-option SKU and inventory. We currently treat each package as one SKU. Supporting options would require either: (a) separate warehouse variants per option, or (b) explicit documentation that we only support single-option packages.
