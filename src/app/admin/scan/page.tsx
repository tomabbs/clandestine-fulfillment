"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  lookupBarcode,
  lookupLocation,
  recordReceivingScan,
  submitCount,
} from "@/actions/scanning";
import { CountSession } from "@/components/admin/count-session";
import { ScannerInput } from "@/components/admin/scanner-input";
import { Button } from "@/components/ui/button";
import type { ScanMode } from "@/lib/hooks/use-scanner";
import { useScannerStore } from "@/lib/hooks/use-scanner";
import { cn } from "@/lib/utils";

// === Lookup Result Types ===

interface LookupResult {
  variant: Record<string, unknown>;
  product: Record<string, unknown> | null;
  inventory: Record<string, unknown> | null;
  locations: Array<Record<string, unknown>>;
}

// === Tab Config ===

const TABS: Array<{ mode: ScanMode; label: string }> = [
  { mode: "lookup", label: "Quick Lookup" },
  { mode: "count", label: "Count" },
  { mode: "receiving", label: "Receiving" },
];

// === Sub-Components ===

function LookupTab() {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleScan = useCallback(async (barcode: string) => {
    setLoading(true);
    setError(null);
    const res = await lookupBarcode(barcode);
    setLoading(false);
    if ("error" in res) {
      setError(res.error ?? "Unknown error");
      setResult(null);
    } else {
      setResult(res);
    }
  }, []);

  return (
    <div className="space-y-4">
      <ScannerInput onScan={handleScan} />
      {loading && <p className="text-muted-foreground text-sm">Looking up...</p>}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}
      {result && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-start gap-3">
            {result.product &&
              Array.isArray((result.product as Record<string, unknown>).images) &&
              ((result.product as Record<string, unknown>).images as Array<Record<string, unknown>>)
                .length > 0 && (
                <Image
                  src={
                    (
                      (
                        (result.product as Record<string, unknown>).images as Array<
                          Record<string, unknown>
                        >
                      )[0] as Record<string, unknown>
                    ).src as string
                  }
                  alt={((result.product as Record<string, unknown>).title as string) ?? ""}
                  width={64}
                  height={64}
                  className="size-16 rounded-md object-cover"
                />
              )}
            <div className="min-w-0 flex-1">
              <h3 className="font-medium leading-tight">
                {((result.product as Record<string, unknown>)?.title as string) ??
                  "Unknown product"}
              </h3>
              <p className="text-muted-foreground font-mono text-sm">
                {(result.variant as Record<string, unknown>).sku as string}
              </p>
              {(result.variant as Record<string, unknown>).barcode ? (
                <p className="text-muted-foreground text-xs">
                  Barcode: {String((result.variant as Record<string, unknown>).barcode)}
                </p>
              ) : null}
            </div>
          </div>

          {result.inventory && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-muted p-2">
                <p className="text-lg font-semibold tabular-nums">
                  {(result.inventory as Record<string, unknown>).available as number}
                </p>
                <p className="text-muted-foreground text-xs">Available</p>
              </div>
              <div className="rounded-md bg-muted p-2">
                <p className="text-lg font-semibold tabular-nums">
                  {(result.inventory as Record<string, unknown>).committed as number}
                </p>
                <p className="text-muted-foreground text-xs">Committed</p>
              </div>
              <div className="rounded-md bg-muted p-2">
                <p className="text-lg font-semibold tabular-nums">
                  {(result.inventory as Record<string, unknown>).incoming as number}
                </p>
                <p className="text-muted-foreground text-xs">Incoming</p>
              </div>
            </div>
          )}

          {result.locations.length > 0 && (
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                Locations
              </h4>
              <div className="divide-y rounded-md border">
                {result.locations.map((loc) => (
                  <div
                    key={loc.id as string}
                    className="flex items-center justify-between px-3 py-1.5 text-sm"
                  >
                    <span>
                      {((loc.warehouse_locations as Record<string, unknown>)?.name as string) ??
                        "—"}
                    </span>
                    <span className="font-medium tabular-nums">{loc.quantity as number}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CountTab() {
  const { currentLocation, countSession, setLocation, startCountSession, addScanToCount } =
    useScannerStore();
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    matchedCount: number;
    mismatchCount: number;
  } | null>(null);

  // Step 1: Scan location barcode
  const handleLocationScan = useCallback(
    async (barcode: string) => {
      const res = await lookupLocation(barcode);
      if ("error" in res) {
        return;
      }
      setLocation({
        id: res.location.id,
        name: res.location.name,
        barcode: res.location.barcode ?? barcode,
      });
    },
    [setLocation],
  );

  // Step 2: Scan product barcodes
  const handleProductScan = useCallback(
    async (barcode: string) => {
      const res = await lookupBarcode(barcode);
      if ("error" in res) return;

      const sku = (res.variant as Record<string, unknown>).sku as string;
      // Find expected count at this location
      const locationEntry = res.locations.find(
        (loc) => (loc.location_id as string) === currentLocation?.id,
      );
      const expectedCount = (locationEntry?.quantity as number) ?? 0;
      addScanToCount(sku, expectedCount);
    },
    [currentLocation, addScanToCount],
  );

  const handleComplete = useCallback(
    async (
      locationId: string,
      counts: Array<{
        sku: string;
        scannedCount: number;
        expectedCount: number;
      }>,
    ) => {
      setSubmitting(true);
      const res = await submitCount(locationId, counts);
      setSubmitting(false);
      if ("error" in res) return;
      setSubmitResult({
        matchedCount: res.matchedCount,
        mismatchCount: res.mismatchCount,
      });
      setLocation(null);
    },
    [setLocation],
  );

  // Resume prompt
  const hasActiveSession = countSession !== null;

  if (submitResult) {
    return (
      <div className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950">
        <h3 className="font-medium text-green-800 dark:text-green-200">Count submitted</h3>
        <p className="text-sm text-green-700 dark:text-green-300">
          {submitResult.matchedCount} confirmed, {submitResult.mismatchCount} sent to review queue
        </p>
        <Button size="sm" variant="outline" onClick={() => setSubmitResult(null)}>
          Start new count
        </Button>
      </div>
    );
  }

  // Step 1: No location set
  if (!currentLocation) {
    return (
      <div className="space-y-4">
        {hasActiveSession && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-900 dark:bg-yellow-950">
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              You have an active count session. Resume or start fresh?
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (countSession) {
                    setLocation({
                      id: countSession.locationId,
                      name: countSession.locationId,
                      barcode: countSession.locationId,
                    });
                  }
                }}
              >
                Resume
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => useScannerStore.getState().clearSession()}
              >
                Start fresh
              </Button>
            </div>
          </div>
        )}
        <p className="text-muted-foreground text-sm">Scan a location barcode to begin counting</p>
        <ScannerInput onScan={handleLocationScan} />
      </div>
    );
  }

  // Step 2 & 3: Location set, counting in progress
  if (!countSession) {
    startCountSession(currentLocation.id);
  }

  return (
    <div className="space-y-4">
      <ScannerInput onScan={handleProductScan} disabled={submitting} />
      <CountSession onComplete={handleComplete} />
    </div>
  );
}

function ReceivingTab() {
  const [shipmentId, setShipmentId] = useState<string | null>(null);
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [scanLog, setScanLog] = useState<
    Array<{ id: string; sku: string; received: number; expected: number; isOver: boolean }>
  >([]);
  const [completing, setCompleting] = useState(false);

  const handleShipmentScan = useCallback((barcode: string) => {
    setShipmentId(barcode);
    // In production, this would fetch inbound shipment items
  }, []);

  const handleItemScan = useCallback(
    async (barcode: string) => {
      if (!shipmentId) return;

      // Look up item by barcode to find matching inbound item
      const res = await lookupBarcode(barcode);
      if ("error" in res) return;

      const sku = (res.variant as Record<string, unknown>).sku as string;

      // Find the matching inbound item (simplified — real version matches by SKU)
      const matchingItem = items.find((item) => (item.sku as string) === sku);

      if (matchingItem) {
        const scanResult = await recordReceivingScan(matchingItem.id as string, 1);
        if (!("error" in scanResult)) {
          setScanLog((prev) => [
            {
              id: `${scanResult.inboundItemId}-${Date.now()}`,
              sku: scanResult.sku,
              received: scanResult.newReceived,
              expected: scanResult.expectedQuantity,
              isOver: scanResult.isOver,
            },
            ...prev,
          ]);
        }
      }
    },
    [shipmentId, items],
  );

  if (!shipmentId) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">Scan or enter an inbound shipment ID</p>
        <ScannerInput onScan={handleShipmentScan} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">Shipment: {shipmentId}</h3>
          <p className="text-muted-foreground text-xs">Scan items to check in</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setShipmentId(null);
            setItems([]);
            setScanLog([]);
          }}
        >
          Change
        </Button>
      </div>

      <ScannerInput onScan={handleItemScan} />

      {scanLog.length > 0 && (
        <div className="divide-y rounded-lg border">
          {scanLog.map((entry) => (
            <div key={entry.id} className="flex items-center justify-between px-3 py-2">
              <span className="font-mono text-sm">{entry.sku}</span>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    entry.isOver
                      ? "text-orange-600 dark:text-orange-400"
                      : entry.received === entry.expected
                        ? "text-green-600 dark:text-green-400"
                        : "text-foreground",
                  )}
                >
                  {entry.received}
                </span>
                <span className="text-muted-foreground text-xs">/</span>
                <span className="text-muted-foreground text-sm tabular-nums">{entry.expected}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button
        className="w-full"
        disabled={scanLog.length === 0 || completing}
        onClick={() => {
          setCompleting(true);
          // Complete check-in: in production, this calls a server action
          // to update inbound shipment status to 'checked_in'
          setTimeout(() => {
            setCompleting(false);
            setShipmentId(null);
            setItems([]);
            setScanLog([]);
          }, 500);
        }}
      >
        {completing ? "Completing..." : "Complete Check-in"}
      </Button>
    </div>
  );
}

// === Main Page ===

export default function ScanPage() {
  const { scanMode, setScanMode } = useScannerStore();

  // Default to lookup mode
  useEffect(() => {
    if (!scanMode) setScanMode("lookup");
  }, [scanMode, setScanMode]);

  const activeMode = scanMode ?? "lookup";

  return (
    <div className="mx-auto max-w-lg p-4 sm:p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Scan</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Barcode scanner hub for warehouse operations
      </p>

      {/* Mode Tabs */}
      <div className="mt-4 flex gap-1 rounded-lg bg-muted p-1">
        {TABS.map((tab) => (
          <button
            key={tab.mode}
            type="button"
            onClick={() => setScanMode(tab.mode)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              activeMode === tab.mode
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="mt-4">
        {activeMode === "lookup" && <LookupTab />}
        {activeMode === "count" && <CountTab />}
        {activeMode === "receiving" && <ReceivingTab />}
      </div>
    </div>
  );
}
