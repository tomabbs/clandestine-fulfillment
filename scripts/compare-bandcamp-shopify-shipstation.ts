import { config } from "dotenv";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listInventory } from "@/lib/clients/shipstation-inventory-v2";
import { fetchProducts } from "@/lib/clients/shipstation";

config({ path: ".env.local" });

const BANDCAMP_CSV = "reports/bandcamp-baseline-catalog-2026-04-19T06-46-09.csv";
const SHOPIFY_VARIANTS_CSV =
  "reports/finish-line/shopify-variants-all-2026-04-19T19-21-55.273Z.csv";
const SHOPIFY_PRODUCTS_CSV =
  "reports/finish-line/shopify-products-all-2026-04-19T19-21-55.273Z.csv";

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return { header: out[0] ?? [], rows: out.slice(1).filter((r) => r.length > 1) };
}

function normalizeSku(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9\-_./]/g, "");
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `"${String(v).replaceAll('"', '""').replaceAll(/\r?\n/g, " ")}"`;
}

type BandcampRow = {
  sku: string;
  artist: string;
  album: string;
  format: string;
  band_subdomain: string;
  package_id: string;
  qty: string;
};

type ShopifyVariantRow = {
  sku: string;
  product_title: string;
  vendor: string;
  variant_title: string;
  product_status: string;
  managed: string;
  shopify_product_id: string;
};

type ShipStationRow = {
  sku: string;
  name: string;
  on_hand: number;
};

type ShipStationProductRow = {
  sku: string;
  name: string;
  product_id: number;
  active: boolean | null;
  alias_count: number;
  warehouse_location: string;
};

function loadBandcamp(): { rows: BandcampRow[]; total: number; withSku: Map<string, BandcampRow[]> } {
  const text = readFileSync(BANDCAMP_CSV, "utf8");
  const { header, rows } = parseCsv(text);
  const idx = (name: string) => header.indexOf(name);
  const skuI = idx("sku");
  const artistI = idx("artist");
  const albumI = idx("album_title");
  const itemTitleI = idx("item_title");
  const formatI = idx("format_inferred");
  const subI = idx("member_band_subdomain");
  const pkgI = idx("package_id");
  const qtyI = idx("quantity_available_now");
  const out: BandcampRow[] = [];
  const withSku = new Map<string, BandcampRow[]>();
  for (const r of rows) {
    const sku = normalizeSku(r[skuI]);
    const row: BandcampRow = {
      sku,
      artist: r[artistI] ?? "",
      album: r[albumI] ?? r[itemTitleI] ?? "",
      format: r[formatI] ?? "",
      band_subdomain: r[subI] ?? "",
      package_id: r[pkgI] ?? "",
      qty: r[qtyI] ?? "",
    };
    out.push(row);
    if (sku) {
      const arr = withSku.get(sku) ?? [];
      arr.push(row);
      withSku.set(sku, arr);
    }
  }
  return { rows: out, total: out.length, withSku };
}

function loadShopifyVariants(): {
  rows: ShopifyVariantRow[];
  total: number;
  withSku: Map<string, ShopifyVariantRow[]>;
  managedWithSku: Map<string, ShopifyVariantRow[]>;
  activeWithSku: Map<string, ShopifyVariantRow[]>;
} {
  const text = readFileSync(SHOPIFY_VARIANTS_CSV, "utf8");
  const { header, rows } = parseCsv(text);
  const idx = (name: string) => header.indexOf(name);
  const skuI = idx("sku");
  const titleI = idx("product_title");
  const vendorI = idx("vendor");
  const variantTitleI = idx("variant_title");
  const statusI = idx("product_status");
  const managedI = idx("managed_in_db");
  const productIdI = idx("shopify_product_id");

  const out: ShopifyVariantRow[] = [];
  const withSku = new Map<string, ShopifyVariantRow[]>();
  const managedWithSku = new Map<string, ShopifyVariantRow[]>();
  const activeWithSku = new Map<string, ShopifyVariantRow[]>();
  for (const r of rows) {
    const sku = normalizeSku(r[skuI]);
    const row: ShopifyVariantRow = {
      sku,
      product_title: r[titleI] ?? "",
      vendor: r[vendorI] ?? "",
      variant_title: r[variantTitleI] ?? "",
      product_status: r[statusI] ?? "",
      managed: r[managedI] ?? "",
      shopify_product_id: r[productIdI] ?? "",
    };
    out.push(row);
    if (sku) {
      const arr = withSku.get(sku) ?? [];
      arr.push(row);
      withSku.set(sku, arr);
      if (row.managed === "yes") {
        const a2 = managedWithSku.get(sku) ?? [];
        a2.push(row);
        managedWithSku.set(sku, a2);
      }
      if (row.product_status === "ACTIVE") {
        const a3 = activeWithSku.get(sku) ?? [];
        a3.push(row);
        activeWithSku.set(sku, a3);
      }
    }
  }
  return { rows: out, total: out.length, withSku, managedWithSku, activeWithSku };
}

async function loadShipStation(): Promise<{
  rows: ShipStationRow[];
  total: number;
  withSku: Map<string, ShipStationRow>;
}> {
  const records = await listInventory({ limit: 100 });
  const byNorm = new Map<string, ShipStationRow>();
  const out: ShipStationRow[] = [];
  for (const r of records) {
    const sku = normalizeSku(r.sku);
    const onHand = (() => {
      const fields: Array<keyof typeof r> = [
        "on_hand" as keyof typeof r,
        "available" as keyof typeof r,
      ];
      for (const f of fields) {
        const v = (r as unknown as Record<string, unknown>)[f as string];
        if (typeof v === "number") return v;
      }
      const sum = (r as { quantities?: Array<{ on_hand?: number; available?: number }> }).quantities?.reduce(
        (a, q) => a + (q.on_hand ?? q.available ?? 0),
        0,
      );
      return typeof sum === "number" ? sum : 0;
    })();
    const row: ShipStationRow = {
      sku,
      name: (r as { name?: string }).name ?? "",
      on_hand: onHand,
    };
    out.push(row);
    if (sku) byNorm.set(sku, row);
  }
  return { rows: out, total: out.length, withSku: byNorm };
}

async function loadShipStationV1Products(): Promise<{
  rows: ShipStationProductRow[];
  total: number;
  withSku: Map<string, ShipStationProductRow>;
  active: Set<string>;
}> {
  const rows: ShipStationProductRow[] = [];
  const seenIds = new Set<number>();
  for (const showInactive of [false, true]) {
    let page = 1;
    while (true) {
      const res = await fetchProducts({ pageSize: 500, page, showInactive });
      for (const p of res.products) {
        if (seenIds.has(p.productId)) continue;
        seenIds.add(p.productId);
        rows.push({
          sku: normalizeSku(p.sku),
          name: p.name ?? "",
          product_id: p.productId,
          active: p.active ?? null,
          alias_count: (p.aliases ?? []).length,
          warehouse_location: p.warehouseLocation ?? "",
        });
      }
      if (page >= res.pages) break;
      page += 1;
    }
  }
  const withSku = new Map<string, ShipStationProductRow>();
  const active = new Set<string>();
  for (const r of rows) {
    if (r.sku) {
      withSku.set(r.sku, r);
      if (r.active !== false) active.add(r.sku);
    }
  }
  return { rows, total: rows.length, withSku, active };
}

async function main() {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const reportDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(reportDir, { recursive: true });

  console.log("[load] bandcamp + shopify CSVs + shipstation v1 products + v2 inventory …");
  const [bandcamp, shopify, ship, shipProducts] = await Promise.all([
    Promise.resolve(loadBandcamp()),
    Promise.resolve(loadShopifyVariants()),
    loadShipStation(),
    loadShipStationV1Products(),
  ]);

  const bandcampSkus = new Set(bandcamp.withSku.keys());
  const shopifySkus = new Set(shopify.withSku.keys());
  const shopifyManagedSkus = new Set(shopify.managedWithSku.keys());
  const shopifyActiveSkus = new Set(shopify.activeWithSku.keys());
  const shipSkus = new Set(ship.withSku.keys());
  const shipProductSkus = new Set(shipProducts.withSku.keys());
  const shipProductActiveSkus = shipProducts.active;

  const intersect = (a: Set<string>, b: Set<string>) =>
    new Set([...a].filter((x) => b.has(x)));
  const minus = (a: Set<string>, b: Set<string>) =>
    new Set([...a].filter((x) => !b.has(x)));

  const bandcampInShopify = intersect(bandcampSkus, shopifySkus);
  const bandcampInShopifyManaged = intersect(bandcampSkus, shopifyManagedSkus);
  const bandcampInShopifyActive = intersect(bandcampSkus, shopifyActiveSkus);
  const bandcampInShipInv = intersect(bandcampSkus, shipSkus);
  const bandcampInShipProducts = intersect(bandcampSkus, shipProductSkus);
  const shopifyInShipInv = intersect(shopifySkus, shipSkus);
  const shopifyInShipProducts = intersect(shopifySkus, shipProductSkus);
  const shopifyManagedInShipProducts = intersect(shopifyManagedSkus, shipProductSkus);
  const shopifyActiveInShipProducts = intersect(shopifyActiveSkus, shipProductSkus);
  const allThreeInv = intersect(intersect(bandcampSkus, shopifySkus), shipSkus);
  const allThreeProducts = intersect(intersect(bandcampSkus, shopifySkus), shipProductSkus);
  const allThreeManagedActiveProducts = intersect(
    intersect(bandcampSkus, shopifyManagedSkus),
    shipProductSkus,
  );
  const shipProductsNotInInventory = minus(shipProductSkus, shipSkus);

  const summary = {
    timestamp: new Date().toISOString(),
    sources: {
      bandcamp_csv: BANDCAMP_CSV,
      shopify_csv: SHOPIFY_VARIANTS_CSV,
      shipstation: "v2 /v2/inventory (live)",
    },
    bandcamp: {
      total_rows: bandcamp.total,
      rows_with_sku: [...bandcamp.withSku.values()].reduce((a, b) => a + b.length, 0),
      rows_without_sku: bandcamp.total - [...bandcamp.withSku.values()].reduce((a, b) => a + b.length, 0),
      unique_skus: bandcampSkus.size,
    },
    shopify: {
      total_variant_rows: shopify.total,
      variants_with_sku: [...shopify.withSku.values()].reduce((a, b) => a + b.length, 0),
      variants_without_sku:
        shopify.total - [...shopify.withSku.values()].reduce((a, b) => a + b.length, 0),
      unique_skus_all_statuses: shopifySkus.size,
      unique_skus_managed_in_db: shopifyManagedSkus.size,
      unique_skus_active: shopifyActiveSkus.size,
    },
    shipstation_v2_inventory: {
      total_records: ship.total,
      unique_skus: shipSkus.size,
    },
    shipstation_v1_products: {
      total_records: shipProducts.total,
      unique_skus: shipProductSkus.size,
      active_unique_skus: shipProductActiveSkus.size,
      products_with_aliases: shipProducts.rows.filter((r) => r.alias_count > 0).length,
      total_alias_entries: shipProducts.rows.reduce((a, r) => a + r.alias_count, 0),
      v1_products_without_v2_inventory: shipProductsNotInInventory.size,
    },
    overlap_vs_v1_products: {
      bandcamp_in_shopify_any_status: bandcampInShopify.size,
      bandcamp_in_shopify_managed: bandcampInShopifyManaged.size,
      bandcamp_in_shopify_active: bandcampInShopifyActive.size,
      bandcamp_in_ship_products: bandcampInShipProducts.size,
      bandcamp_in_ship_v2_inventory: bandcampInShipInv.size,
      shopify_any_in_ship_products: shopifyInShipProducts.size,
      shopify_managed_in_ship_products: shopifyManagedInShipProducts.size,
      shopify_active_in_ship_products: shopifyActiveInShipProducts.size,
      all_three_v1_products: allThreeProducts.size,
      all_three_managed_active_v1_products: allThreeManagedActiveProducts.size,
      all_three_v2_inventory: allThreeInv.size,
    },
    gaps_vs_v1_products: {
      bandcamp_only_not_in_shopify_or_ship: minus(
        minus(bandcampSkus, shopifySkus),
        shipProductSkus,
      ).size,
      bandcamp_in_shopify_but_not_ship_products: minus(bandcampInShopify, shipProductSkus).size,
      bandcamp_in_shopify_and_ship_products_but_not_v2_inv: minus(
        intersect(bandcampInShopify, shipProductSkus),
        shipSkus,
      ).size,
      bandcamp_in_ship_but_not_shopify: minus(bandcampInShipProducts, shopifySkus).size,
      shopify_only_not_in_bandcamp_or_ship: minus(
        minus(shopifySkus, bandcampSkus),
        shipProductSkus,
      ).size,
      ship_only_not_in_shopify_or_bandcamp: minus(
        minus(shipProductSkus, shopifySkus),
        bandcampSkus,
      ).size,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  const allSkus = new Set<string>([
    ...bandcampSkus,
    ...shopifySkus,
    ...shipSkus,
    ...shipProductSkus,
  ]);
  const matrixHeader = [
    "sku",
    "in_bandcamp",
    "in_shopify_any",
    "in_shopify_active",
    "in_shopify_managed",
    "in_ship_v1_product",
    "in_ship_v1_product_active",
    "in_ship_v2_inventory",
    "bandcamp_artist",
    "bandcamp_album",
    "bandcamp_format",
    "bandcamp_qty",
    "shopify_vendor",
    "shopify_product_title",
    "shopify_status",
    "shopify_managed",
    "ship_product_id",
    "ship_product_name",
    "ship_warehouse_location",
    "ship_alias_count",
    "ship_v2_on_hand",
  ];
  const lines = [matrixHeader.join(",")];
  for (const sku of [...allSkus].sort()) {
    const bc = bandcamp.withSku.get(sku)?.[0];
    const sh = shopify.withSku.get(sku)?.[0];
    const ss = ship.withSku.get(sku);
    const sp = shipProducts.withSku.get(sku);
    lines.push(
      [
        csvCell(sku),
        csvCell(bandcampSkus.has(sku) ? "yes" : "no"),
        csvCell(shopifySkus.has(sku) ? "yes" : "no"),
        csvCell(shopifyActiveSkus.has(sku) ? "yes" : "no"),
        csvCell(shopifyManagedSkus.has(sku) ? "yes" : "no"),
        csvCell(shipProductSkus.has(sku) ? "yes" : "no"),
        csvCell(shipProductActiveSkus.has(sku) ? "yes" : "no"),
        csvCell(shipSkus.has(sku) ? "yes" : "no"),
        csvCell(bc?.artist ?? ""),
        csvCell(bc?.album ?? ""),
        csvCell(bc?.format ?? ""),
        csvCell(bc?.qty ?? ""),
        csvCell(sh?.vendor ?? ""),
        csvCell(sh?.product_title ?? ""),
        csvCell(sh?.product_status ?? ""),
        csvCell(sh?.managed ?? ""),
        csvCell(sp?.product_id ?? ""),
        csvCell(sp?.name ?? ""),
        csvCell(sp?.warehouse_location ?? ""),
        csvCell(sp?.alias_count ?? ""),
        csvCell(ss?.on_hand ?? ""),
      ].join(","),
    );
  }
  const matrixPath = join(reportDir, `catalog-three-way-${ts}.csv`);
  writeFileSync(matrixPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`[done] matrix=${matrixPath} rows=${lines.length - 1}`);

  const summaryPath = join(reportDir, `catalog-three-way-summary-${ts}.json`);
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`       summary=${summaryPath}`);

  // Reference: products csv for managed counts (sanity)
  console.log(`[ref] shopify products csv: ${SHOPIFY_PRODUCTS_CSV}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
