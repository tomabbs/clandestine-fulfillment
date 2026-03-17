"use client";

import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type CreateInboundInput, createInbound } from "@/actions/inbound";
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

interface ItemForm {
  id: string;
  sku: string;
  title: string;
  format: string;
  expected_quantity: string;
}

function emptyItem(): ItemForm {
  return {
    id: crypto.randomUUID(),
    sku: "",
    title: "",
    format: "",
    expected_quantity: "1",
  };
}

export default function NewInboundPage() {
  const router = useRouter();
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ItemForm[]>([emptyItem()]);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useAppMutation({
    mutationFn: (input: CreateInboundInput) => createInbound(input),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => {
      router.push("/portal/inbound");
    },
  });

  function addItem() {
    setItems((prev) => [...prev, emptyItem()]);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function updateItem(id: string, field: keyof ItemForm, value: string) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Validate items
    const validItems = items.filter((item) => item.title.trim());
    if (validItems.length === 0) {
      setError("At least one item with a title is required.");
      return;
    }

    const invalidQty = validItems.find(
      (item) => !item.expected_quantity || Number.parseInt(item.expected_quantity, 10) < 1,
    );
    if (invalidQty) {
      setError(`Invalid quantity for item "${invalidQty.title}".`);
      return;
    }

    const input: CreateInboundInput = {
      tracking_number: trackingNumber.trim() || undefined,
      carrier: carrier || undefined,
      expected_date: expectedDate || undefined,
      notes: notes.trim() || undefined,
      items: validItems.map((item) => ({
        sku: item.sku.trim() || undefined,
        title: item.title.trim(),
        format: item.format.trim() || undefined,
        expected_quantity: Number.parseInt(item.expected_quantity, 10),
      })),
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
          Tell us what you're sending so we can prepare for receiving.
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
            <h2 className="text-lg font-medium">Items</h2>
            <Button type="button" variant="outline" size="sm" onClick={addItem}>
              <Plus className="h-4 w-4 mr-1" />
              Add Item
            </Button>
          </div>

          <div className="space-y-3">
            {items.map((item, index) => (
              <div key={item.id} className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">
                    Item {index + 1}
                  </span>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={`sku-${item.id}`} className="text-sm font-medium mb-1 block">
                      SKU <span className="text-muted-foreground font-normal">(if known)</span>
                    </label>
                    <Input
                      id={`sku-${item.id}`}
                      value={item.sku}
                      onChange={(e) => updateItem(item.id, "sku", e.target.value)}
                      placeholder="e.g. VNL-001"
                    />
                  </div>
                  <div>
                    <label htmlFor={`title-${item.id}`} className="text-sm font-medium mb-1 block">
                      Title <span className="text-destructive">*</span>
                    </label>
                    <Input
                      id={`title-${item.id}`}
                      value={item.title}
                      onChange={(e) => updateItem(item.id, "title", e.target.value)}
                      placeholder="e.g. Album Name - Vinyl LP"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={`format-${item.id}`} className="text-sm font-medium mb-1 block">
                      Format
                    </label>
                    <Input
                      id={`format-${item.id}`}
                      value={item.format}
                      onChange={(e) => updateItem(item.id, "format", e.target.value)}
                      placeholder="e.g. Vinyl LP, CD, Cassette"
                    />
                  </div>
                  <div>
                    <label htmlFor={`qty-${item.id}`} className="text-sm font-medium mb-1 block">
                      Expected Quantity <span className="text-destructive">*</span>
                    </label>
                    <Input
                      id={`qty-${item.id}`}
                      type="number"
                      min={1}
                      value={item.expected_quantity}
                      onChange={(e) => updateItem(item.id, "expected_quantity", e.target.value)}
                      required
                    />
                  </div>
                </div>

                {!item.sku && item.title && (
                  <p className="text-xs text-yellow-600 bg-yellow-50 rounded px-2 py-1">
                    No SKU provided — this item will be flagged for new product creation.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Error + Submit */}
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
