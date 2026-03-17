"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ScanMode = "lookup" | "count" | "receiving" | null;

export interface ScanLocation {
  id: string;
  name: string;
  barcode: string;
}

export interface CountItem {
  sku: string;
  scannedCount: number;
  expectedCount: number;
}

export interface CountSession {
  locationId: string;
  items: CountItem[];
  startedAt: string;
}

export interface ScannerState {
  currentLocation: ScanLocation | null;
  scanMode: ScanMode;
  countSession: CountSession | null;
  scanBuffer: string;

  setLocation: (location: ScanLocation | null) => void;
  setScanMode: (mode: ScanMode) => void;
  setScanBuffer: (buffer: string) => void;
  startCountSession: (locationId: string) => void;
  addScanToCount: (sku: string, expectedCount: number) => void;
  endCountSession: () => void;
  clearSession: () => void;
}

export const useScannerStore = create<ScannerState>()(
  persist(
    (set) => ({
      currentLocation: null,
      scanMode: null,
      countSession: null,
      scanBuffer: "",

      setLocation: (location) => set({ currentLocation: location }),

      setScanMode: (mode) => set({ scanMode: mode }),

      setScanBuffer: (buffer) => set({ scanBuffer: buffer }),

      startCountSession: (locationId) =>
        set({
          countSession: {
            locationId,
            items: [],
            startedAt: new Date().toISOString(),
          },
        }),

      addScanToCount: (sku, expectedCount) =>
        set((state) => {
          if (!state.countSession) return state;
          const existing = state.countSession.items.find((item) => item.sku === sku);
          if (existing) {
            return {
              countSession: {
                ...state.countSession,
                items: state.countSession.items.map((item) =>
                  item.sku === sku ? { ...item, scannedCount: item.scannedCount + 1 } : item,
                ),
              },
            };
          }
          return {
            countSession: {
              ...state.countSession,
              items: [...state.countSession.items, { sku, scannedCount: 1, expectedCount }],
            },
          };
        }),

      endCountSession: () => set({ countSession: null }),

      clearSession: () =>
        set({
          currentLocation: null,
          scanMode: null,
          countSession: null,
          scanBuffer: "",
        }),
    }),
    {
      name: "scan-session",
      storage: createJSONStorage(() =>
        typeof window !== "undefined"
          ? sessionStorage
          : {
              getItem: () => null,
              setItem: () => {},
              removeItem: () => {},
            },
      ),
      partialize: (state) => ({
        currentLocation: state.currentLocation,
        scanMode: state.scanMode,
        countSession: state.countSession,
      }),
    },
  ),
);
