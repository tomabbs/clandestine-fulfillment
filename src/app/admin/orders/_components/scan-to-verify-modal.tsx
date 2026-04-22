"use client";

// Phase 9.2 — Scan-to-Verify modal.
//
// Operator workflow:
//   1. In the cockpit drawer, click "Scan to Verify".
//   2. Modal shows expected SKUs from shipstation_order_items.
//   3. Operator scans barcodes (USB wedge → keystrokes ending in Enter) or
//      types SKUs manually + Enter.
//   4. Each matching SKU lights up green; unexpected SKUs raise a toast.
//   5. When every line item is verified, the "Buy Label" CTA in the parent
//      drawer flips state via the onAllVerified callback.
//
// Implementation notes:
//   - We intentionally use a focused <input> instead of a global keydown
//     listener so the modal can coexist with cockpit text fields. Operator
//     focuses the input once; subsequent scans flow into the same field.
//   - SKU matching is case-insensitive + trimmed.
//   - Per-line verification count tracks against expected quantity. If the
//     order needs 3 of LP-001, 3 scans are required.

import { CheckCircle2, ScanLine, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CockpitOrderItem } from "@/actions/shipstation-orders";
import { Button } from "@/components/ui/button";

interface ScanToVerifyModalProps {
  items: CockpitOrderItem[];
  onClose: () => void;
  onAllVerified?: () => void;
}

export function ScanToVerifyModal({ items, onClose, onAllVerified }: ScanToVerifyModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [scanText, setScanText] = useState("");
  const [scannedCounts, setScannedCounts] = useState<Record<string, number>>({});
  const [unexpectedFlash, setUnexpectedFlash] = useState<string | null>(null);

  const expectedBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      if (!it.sku) continue;
      m.set(
        it.sku.trim().toUpperCase(),
        (m.get(it.sku.trim().toUpperCase()) ?? 0) + (it.quantity ?? 1),
      );
    }
    return m;
  }, [items]);

  const remainingBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const [sku, expected] of expectedBySku) {
      m.set(sku, expected - (scannedCounts[sku] ?? 0));
    }
    return m;
  }, [expectedBySku, scannedCounts]);

  const totalExpected = useMemo(
    () => Array.from(expectedBySku.values()).reduce((a, b) => a + b, 0),
    [expectedBySku],
  );
  const totalScanned = useMemo(
    () => Object.values(scannedCounts).reduce((a, b) => a + b, 0),
    [scannedCounts],
  );
  const allVerified = totalExpected > 0 && totalScanned >= totalExpected;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (allVerified && onAllVerified) onAllVerified();
  }, [allVerified, onAllVerified]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const sku = scanText.trim().toUpperCase();
    setScanText("");
    if (!sku) return;
    const expected = expectedBySku.get(sku) ?? 0;
    const already = scannedCounts[sku] ?? 0;
    if (expected === 0 || already >= expected) {
      setUnexpectedFlash(sku);
      setTimeout(() => setUnexpectedFlash(null), 1500);
      return;
    }
    setScannedCounts((s) => ({ ...s, [sku]: (s[sku] ?? 0) + 1 }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            <ScanLine className="h-4 w-4" />
            Scan to verify
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="p-4">
          <input
            ref={inputRef}
            type="text"
            value={scanText}
            onChange={(e) => setScanText(e.target.value)}
            placeholder="Scan or type a SKU + Enter"
            className="w-full rounded border px-3 py-2 text-sm"
            autoComplete="off"
          />
          {unexpectedFlash && (
            <div className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
              Unexpected SKU: <strong>{unexpectedFlash}</strong>
            </div>
          )}
        </form>

        <div className="px-4 pb-2 text-xs text-muted-foreground">
          {totalScanned} / {totalExpected} items scanned
        </div>
        <div className="px-4 pb-4 space-y-1">
          {items.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No items on this order.</div>
          ) : (
            items.map((it, i) => {
              const sku = (it.sku ?? "").trim().toUpperCase();
              const expected = it.quantity ?? 1;
              const scanned = scannedCounts[sku] ?? 0;
              const remaining = Math.max(0, expected - scanned);
              const done = sku && remaining === 0;
              return (
                <div
                  key={`${sku}-${i}`}
                  className={`flex items-center justify-between rounded border px-2 py-1.5 text-sm ${
                    done ? "border-emerald-200 bg-emerald-50" : "border-gray-200"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {done ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <span className="inline-block h-4 w-4 rounded-full border border-gray-300" />
                    )}
                    <span className="font-mono text-xs">{sku || "(no sku)"}</span>
                    <span className="text-xs text-muted-foreground">{it.name ?? "—"}</span>
                  </div>
                  <span className="text-xs tabular-nums">
                    {scanned} / {expected}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={() => setScannedCounts({})}>
            Reset
          </Button>
          <Button onClick={onClose}>{allVerified ? "Done — close" : "Close"}</Button>
        </div>
      </div>
    </div>
  );
}
