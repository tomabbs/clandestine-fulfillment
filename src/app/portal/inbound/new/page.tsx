"use client";

import { ArrowLeft, Loader2, Package, Plus, Search, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { searchProductVariants } from "@/actions/catalog";
import { type CreateInboundInput, createInbound } from "@/actions/inbound";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";

const CARRIERS = [
  "UPS",
  "FedEx",
  "USPS",
  "DHL",
  "Freight / LTL",
  "Hand Delivery",
  "Other",
] as const;
const FORMATS = [
  "LP",
  "2xLP",
  '7"',
  "CD",
  "Cassette",
  "T-Shirt",
  "Poster",
  "Tote Bag",
  "Box Set",
  "Other",
] as const;

// --- Item types ---

interface CatalogItem {
  id: string;
  mode: "catalog";
  variantId: string;
  productTitle: string;
  sku: string;
  format: string | null;
  currentStock: number | null;
  expected_quantity: string;
}

interface ManualItem {
  id: string;
  mode: "manual";
  sku: string;
  title: string;
  format: string;
  expected_quantity: string;
}

type InboundItem = CatalogItem | ManualItem;

function emptyCatalogItem(): CatalogItem {
  return {
    id: crypto.randomUUID(),
    mode: "catalog",
    variantId: "",
    productTitle: "",
    sku: "",
    format: null,
    currentStock: null,
    expected_quantity: "1",
  };
}

function emptyManualItem(): ManualItem {
  return {
    id: crypto.randomUUID(),
    mode: "manual",
    sku: "",
    title: "",
    format: "",
    expected_quantity: "1",
  };
}

// --- Product search hook (debounced) ---

function useProductSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    Array<{
      variantId: string;
      productTitle: string;
      sku: string;
      format: string | null;
      currentStock: number | null;
    }>
  >([]);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((term: string) => {
    setQuery(term);
    if (term.length < 2) {
      setResults([]);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await searchProductVariants(term);
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, []);

  const clear = useCallback(() => {
    setQuery("");
    setResults([]);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { query, results, searching, search, clear };
}

// --- Manifest Item component ---

function ManifestItemRow({
  item,
  index,
  onUpdate,
  onRemove,
  canRemove,
}: {
  item: InboundItem;
  index: number;
  onUpdate: (index: number, item: InboundItem) => void;
  onRemove: (index: number) => void;
  canRemove: boolean;
}) {
  const productSearch = useProductSearch();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSelectVariant = (variant: (typeof productSearch.results)[0]) => {
    onUpdate(index, {
      id: item.id,
      mode: "catalog",
      variantId: variant.variantId,
      productTitle: variant.productTitle,
      sku: variant.sku,
      format: variant.format,
      currentStock: variant.currentStock,
      expected_quantity: item.expected_quantity,
    });
    productSearch.clear();
    setDropdownOpen(false);
  };

  const toggleMode = () => {
    if (item.mode === "catalog") {
      onUpdate(index, {
        ...emptyManualItem(),
        id: item.id,
        expected_quantity: item.expected_quantity,
      });
    } else {
      onUpdate(index, {
        ...emptyCatalogItem(),
        id: item.id,
        expected_quantity: item.expected_quantity,
      });
    }
    productSearch.clear();
  };

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">Item {index + 1}</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleMode}
            className="text-xs wh-accent-text hover:underline"
          >
            {item.mode === "catalog" ? "Adding a new product?" : "Search existing catalog"}
          </button>
          {canRemove && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {item.mode === "catalog" ? (
        <div className="space-y-3">
          {item.variantId ? (
            /* Selected product display */
            <div className="flex items-center gap-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3">
              <Package className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.productTitle}</p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="font-mono">{item.sku}</span>
                  {item.format && <Badge variant="secondary">{item.format}</Badge>}
                  {item.currentStock != null && <span>Stock: {item.currentStock}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  onUpdate(index, {
                    ...emptyCatalogItem(),
                    id: item.id,
                    expected_quantity: item.expected_quantity,
                  })
                }
                className="p-1 rounded text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            /* Product search */
            <div className="relative" ref={dropdownRef}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={productSearch.query}
                  onChange={(e) => {
                    productSearch.search(e.target.value);
                    setDropdownOpen(true);
                  }}
                  onFocus={() => {
                    if (productSearch.results.length > 0) setDropdownOpen(true);
                  }}
                  placeholder="Search by product name or SKU..."
                  className="pl-10"
                />
                {productSearch.searching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
                )}
              </div>

              {dropdownOpen &&
                (productSearch.results.length > 0 ||
                  (productSearch.query.length >= 2 && !productSearch.searching)) && (
                  <div className="absolute z-20 mt-1 w-full bg-popover border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                    {productSearch.results.length > 0 ? (
                      productSearch.results.map((variant) => (
                        <button
                          key={variant.variantId}
                          type="button"
                          onClick={() => handleSelectVariant(variant)}
                          className="w-full text-left px-4 py-3 hover:bg-accent border-b last:border-b-0 transition-colors"
                        >
                          <p className="text-sm font-medium truncate">{variant.productTitle}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                            <span className="font-mono">{variant.sku}</span>
                            {variant.format && (
                              <Badge variant="outline" className="text-[10px] px-1">
                                {variant.format}
                              </Badge>
                            )}
                            {variant.currentStock != null && (
                              <span>Stock: {variant.currentStock}</span>
                            )}
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="px-4 py-3 text-sm text-muted-foreground">
                        No products found for &ldquo;{productSearch.query}&rdquo;
                      </div>
                    )}
                  </div>
                )}
            </div>
          )}

          {/* Quantity for catalog items */}
          <div className="w-32">
            <label htmlFor={`cat-qty-${item.id}`} className="text-sm font-medium mb-1 block">
              Expected Qty <span className="text-destructive">*</span>
            </label>
            <Input
              id={`cat-qty-${item.id}`}
              type="number"
              min={1}
              value={item.expected_quantity}
              onChange={(e) => onUpdate(index, { ...item, expected_quantity: e.target.value })}
              required
            />
          </div>
        </div>
      ) : (
        /* Manual entry mode */
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`man-sku-${item.id}`} className="text-sm font-medium mb-1 block">
                SKU <span className="text-muted-foreground font-normal">(if known)</span>
              </label>
              <Input
                id={`man-sku-${item.id}`}
                value={item.sku}
                onChange={(e) => onUpdate(index, { ...item, sku: e.target.value })}
                placeholder="e.g. LP-AV!-064"
              />
            </div>
            <div>
              <label htmlFor={`man-title-${item.id}`} className="text-sm font-medium mb-1 block">
                Title <span className="text-destructive">*</span>
              </label>
              <Input
                id={`man-title-${item.id}`}
                value={item.title}
                onChange={(e) => onUpdate(index, { ...item, title: e.target.value })}
                placeholder="e.g. Album Name - Vinyl LP"
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`man-fmt-${item.id}`} className="text-sm font-medium mb-1 block">
                Format
              </label>
              <select
                id={`man-fmt-${item.id}`}
                value={item.format}
                onChange={(e) => onUpdate(index, { ...item, format: e.target.value })}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Select format...</option>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`man-qty-${item.id}`} className="text-sm font-medium mb-1 block">
                Expected Qty <span className="text-destructive">*</span>
              </label>
              <Input
                id={`man-qty-${item.id}`}
                type="number"
                min={1}
                value={item.expected_quantity}
                onChange={(e) => onUpdate(index, { ...item, expected_quantity: e.target.value })}
                required
              />
            </div>
          </div>
          {!item.sku && item.title && (
            <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 rounded px-2 py-1">
              No SKU — this item will be flagged for new product creation during check-in.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// --- Main page ---

export default function NewInboundPage() {
  const router = useRouter();
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<InboundItem[]>([emptyCatalogItem()]);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useAppMutation({
    mutationFn: (input: CreateInboundInput) => createInbound(input),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => router.push("/portal/inbound"),
  });

  function addItem(mode: "catalog" | "manual") {
    setItems((prev) => [...prev, mode === "catalog" ? emptyCatalogItem() : emptyManualItem()]);
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function updateItem(index: number, updated: InboundItem) {
    setItems((prev) => prev.map((item, i) => (i === index ? updated : item)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const validItems = items.filter((item) => {
      if (item.mode === "catalog") return !!item.variantId;
      return !!item.title.trim();
    });

    if (validItems.length === 0) {
      setError("At least one item is required. Select a product or enter a title.");
      return;
    }

    const invalidQty = validItems.find(
      (item) => !item.expected_quantity || Number.parseInt(item.expected_quantity, 10) < 1,
    );
    if (invalidQty) {
      setError("All items must have a quantity of at least 1.");
      return;
    }

    const input: CreateInboundInput = {
      tracking_number: trackingNumber.trim() || undefined,
      carrier: carrier || undefined,
      expected_date: expectedDate || undefined,
      notes: notes.trim() || undefined,
      items: validItems.map((item) => {
        if (item.mode === "catalog") {
          return {
            sku: item.sku,
            title: item.productTitle,
            format: item.format || undefined,
            expected_quantity: Number.parseInt(item.expected_quantity, 10),
          };
        }
        return {
          sku: item.sku.trim() || undefined,
          title: item.title.trim(),
          format: item.format.trim() || undefined,
          expected_quantity: Number.parseInt(item.expected_quantity, 10),
        };
      }),
    };

    createMutation.mutate(input);
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <button
        type="button"
        onClick={() => router.push("/portal/inbound")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Inbound
      </button>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Submit New Inbound Shipment</h1>
        <p className="text-muted-foreground mt-1">
          Tell us what you&apos;re sending so we can prepare for receiving.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Shipment Details */}
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Shipment Details</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="tracking-number" className="text-sm font-medium mb-1 block">
                Tracking Number
              </label>
              <Input
                id="tracking-number"
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                placeholder="Enter tracking number"
              />
            </div>
            <div>
              <label htmlFor="carrier-select" className="text-sm font-medium mb-1 block">
                Carrier
              </label>
              <select
                id="carrier-select"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Select carrier...</option>
                {CARRIERS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="expected-date" className="text-sm font-medium mb-1 block">
                Expected Arrival Date
              </label>
              <Input
                id="expected-date"
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label htmlFor="special-instructions" className="text-sm font-medium mb-1 block">
              Special Instructions
            </label>
            <Textarea
              id="special-instructions"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any special handling instructions..."
              rows={3}
            />
          </div>
        </div>

        {/* Items */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">
              Items{" "}
              <span className="text-muted-foreground font-normal text-sm">({items.length})</span>
            </h2>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => addItem("catalog")}>
                <Search className="h-3 w-3 mr-1" />
                From Catalog
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => addItem("manual")}>
                <Plus className="h-3 w-3 mr-1" />
                New Item
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {items.map((item, index) => (
              <ManifestItemRow
                key={item.id}
                item={item}
                index={index}
                onUpdate={updateItem}
                onRemove={removeItem}
                canRemove={items.length > 1}
              />
            ))}
          </div>
        </div>

        {(error || createMutation.error) && (
          <p className="text-sm text-destructive">
            {error || (createMutation.error as Error)?.message || "An error occurred"}
          </p>
        )}

        <div className="flex gap-3">
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Submitting..." : "Submit Inbound Shipment"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push("/portal/inbound")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
