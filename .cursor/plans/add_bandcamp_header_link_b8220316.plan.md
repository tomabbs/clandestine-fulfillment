---
name: Add Bandcamp Header Link
overview: Add a Bandcamp external link to the catalog product detail page header, next to the existing Shopify link, using the first available bandcamp_product_mapping URL.
todos:
  - id: add-bc-link
    content: Add Bandcamp link to catalog product header after Shopify link
    status: completed
isProject: false
---

# Add Bandcamp Link to Catalog Product Header

## Current State

The header at `[src/app/admin/catalog/[id]/page.tsx](src/app/admin/catalog/[id]/page.tsx)` line 233–245 shows:

```
Northern Spy Records · Shopify ↗ · Last synced: 2m ago
```

The `bcMappings` array (line 212) is already loaded from `getProductDetail` — it contains `bandcamp_url` for each variant's mapping.

## Change

Add a Bandcamp link immediately after the Shopify link, using `bcMappings[0]?.bandcamp_url`. A product with multiple variants all share the same album page, so the first mapping's URL is the right one to show.

**Location:** lines 244–245, after the closing `</>` of the Shopify block.

```tsx
{(() => {
  const bcUrl = bcMappings.find((m) => m.bandcamp_url)?.bandcamp_url;
  return bcUrl ? (
    <>
      {" · "}
      <a
        href={bcUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-orange-600 hover:underline"
      >
        Bandcamp <ExternalLinkIcon className="size-3" />
      </a>
    </>
  ) : null;
})()}
```

Orange color (`text-orange-600`) matches Bandcamp's brand color and visually distinguishes it from the blue Shopify link.

## What doesn't change

- The Bandcamp section lower on the page (full mapping table) stays as-is — that's the detail view, this is just a quick header link.
- No action or data changes needed — `bcMappings` is already fetched.

