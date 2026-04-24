"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { SAFETY_STOCK_MAX_VALUE } from "@/lib/shared/constants";

export function clampSafetyStockInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 0 || n > SAFETY_STOCK_MAX_VALUE) return null;
  return n;
}

export function SafetyStockInput({
  value,
  isDirty,
  onCommit,
}: {
  value: number;
  isDirty: boolean;
  onCommit: (next: number) => void;
}) {
  const [local, setLocal] = useState(String(value));

  useEffect(() => {
    setLocal(String(value));
  }, [value]);

  function stageIfValid(raw: string) {
    const n = clampSafetyStockInput(raw);
    if (n !== null && n !== value) {
      onCommit(n);
    }
  }

  function commit() {
    const n = clampSafetyStockInput(local);
    if (n === null) {
      setLocal(String(value));
      toast.error(`Safety stock must be 0–${SAFETY_STOCK_MAX_VALUE}`);
      return;
    }
    setLocal(String(n));
    if (n !== value) onCommit(n);
  }

  return (
    <Input
      value={local}
      onChange={(e) => {
        const next = e.target.value;
        setLocal(next);
        // Stage valid edits immediately so the page-level Save button
        // reflects dirty state even before the field blurs.
        stageIfValid(next);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setLocal(String(value));
          e.currentTarget.blur();
        }
      }}
      className={`h-8 text-right tabular-nums w-20 ml-auto ${
        isDirty ? "border-amber-500 ring-1 ring-amber-200" : ""
      }`}
      inputMode="numeric"
    />
  );
}
