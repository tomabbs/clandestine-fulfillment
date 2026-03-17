"use client";

import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useScannerStore } from "@/lib/hooks/use-scanner";
import { cn } from "@/lib/utils";

interface CountSessionProps {
  onComplete: (
    locationId: string,
    counts: Array<{ sku: string; scannedCount: number; expectedCount: number }>,
  ) => void;
}

export function CountSession({ onComplete }: CountSessionProps) {
  const { countSession, currentLocation, endCountSession } = useScannerStore();
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Wake Lock API (Rule #50): keep screen on during count sessions
  useEffect(() => {
    if (!countSession) return;

    async function requestWakeLock() {
      try {
        if ("wakeLock" in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
          wakeLockRef.current.addEventListener("release", () => {
            wakeLockRef.current = null;
          });
        }
      } catch {
        // Wake Lock API not available or denied — continue without it
      }
    }

    requestWakeLock();

    return () => {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [countSession]);

  const handleComplete = useCallback(() => {
    if (!countSession) return;
    onComplete(countSession.locationId, countSession.items);
    endCountSession();
  }, [countSession, onComplete, endCountSession]);

  if (!countSession) return null;

  const hasMismatches = countSession.items.some((item) => item.scannedCount !== item.expectedCount);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">Counting: {currentLocation?.name ?? "Unknown location"}</h3>
          <p className="text-muted-foreground text-xs">
            Started {new Date(countSession.startedAt).toLocaleTimeString()}
          </p>
        </div>
        <span className="text-muted-foreground text-sm">
          {countSession.items.length} SKU{countSession.items.length !== 1 && "s"}
        </span>
      </div>

      {countSession.items.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          Scan product barcodes to start counting
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {countSession.items.map((item) => {
            const match = item.scannedCount === item.expectedCount;
            const over = item.scannedCount > item.expectedCount;
            return (
              <div key={item.sku} className="flex items-center justify-between px-3 py-2">
                <span className="font-mono text-sm">{item.sku}</span>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "tabular-nums text-sm font-medium",
                      match && "text-green-600 dark:text-green-400",
                      !match && over && "text-orange-600 dark:text-orange-400",
                      !match && !over && "text-red-600 dark:text-red-400",
                    )}
                  >
                    {item.scannedCount}
                  </span>
                  <span className="text-muted-foreground text-xs">/</span>
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {item.expectedCount}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={endCountSession} className="flex-1">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleComplete}
          disabled={countSession.items.length === 0}
          className="flex-1"
        >
          {hasMismatches ? "Submit Mismatches" : "Confirm Count"}
        </Button>
      </div>
    </div>
  );
}
