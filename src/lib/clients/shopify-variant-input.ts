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
}

export function buildShopifyVariantInput(params: VariantInputParams) {
  const { sku, title = "Default Title", price, cost, currency = "USD", barcode, category } = params;
  // Low-confidence default when no category — not from product data
  const weight = category ? CATEGORY_DEFAULT_WEIGHTS[category] : { value: 0.5, unit: "POUNDS" };

  return {
    optionValues: [{ optionName: "Title", name: title }],
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
