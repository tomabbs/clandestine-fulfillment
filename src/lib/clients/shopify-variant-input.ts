import type { ProductCategory } from "@/lib/shared/product-categories";
import { CATEGORY_DEFAULT_WEIGHTS } from "@/lib/shared/product-categories";

export interface VariantInputParams {
  sku: string;
  title?: string;
  price?: number | null;
  cost?: number | null;
  currency?: string;
  barcode?: string | null;
  category?: ProductCategory | null;
  /** Shopify option name (e.g. "Title", "Size"). Defaults to "Title". */
  optionName?: string;
  /** Shopify option value (e.g. "Default Title", "Small"). Defaults to `title`. */
  optionValue?: string;
}

export function buildShopifyVariantInput(params: VariantInputParams) {
  const {
    sku,
    title = "Default Title",
    price,
    cost,
    currency = "USD",
    barcode,
    category,
    optionName = "Title",
    optionValue,
  } = params;
  // Low-confidence default when no category — not from product data
  const weight = category ? CATEGORY_DEFAULT_WEIGHTS[category] : { value: 0.5, unit: "POUNDS" };
  const value = optionValue ?? title;

  return {
    optionValues: [{ optionName, name: value }],
    sku,
    ...(price != null ? { price: String(price) } : {}),
    inventoryPolicy: "DENY" as const,
    inventoryItem: {
      tracked: true,
      ...(cost != null ? { unitCost: { amount: String(cost), currencyCode: currency } } : {}),
      measurement: {
        weight: { value: weight.value, unit: weight.unit },
      },
    },
    ...(barcode ? { barcode } : {}),
  };
}
