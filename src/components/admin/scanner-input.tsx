"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const SCANNER_KEYSTROKE_THRESHOLD_MS = 30;
const SCANNER_MIN_LENGTH = 4;

export interface ScannerInputProps {
  onScan: (barcode: string) => void;
  disabled?: boolean;
  className?: string;
}

export function ScannerInput({ onScan, disabled = false, className }: ScannerInputProps) {
  const [status, setStatus] = useState<"ready" | "scanning" | "preview">("ready");
  const [preview, setPreview] = useState("");

  const bufferRef = useRef<string[]>([]);
  const lastKeystrokeRef = useRef<number>(0);
  const isScannerRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetBuffer = useCallback(() => {
    bufferRef.current = [];
    isScannerRef.current = false;
    lastKeystrokeRef.current = 0;
    setStatus("ready");
    setPreview("");
  }, []);

  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore modifier keys and non-printable keys (except Enter)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt") return;

      // Ignore if focus is on an interactive element
      const target = e.target as HTMLElement;
      const tagName = target.tagName.toLowerCase();
      if (
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        target.isContentEditable
      ) {
        return;
      }

      const now = performance.now();
      const delta = now - lastKeystrokeRef.current;
      lastKeystrokeRef.current = now;

      if (e.key === "Enter") {
        e.preventDefault();
        const barcode = bufferRef.current.join("");
        if (barcode.length >= SCANNER_MIN_LENGTH && isScannerRef.current) {
          setStatus("preview");
          setPreview(barcode);
          onScan(barcode);
          // Clear preview after a brief display
          if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
          resetTimerRef.current = setTimeout(resetBuffer, 1500);
        } else {
          resetBuffer();
        }
        return;
      }

      // Only buffer single printable characters
      if (e.key.length !== 1) return;

      // Detect scanner: rapid succession of keystrokes
      if (bufferRef.current.length > 0 && delta < SCANNER_KEYSTROKE_THRESHOLD_MS) {
        isScannerRef.current = true;
      }

      bufferRef.current.push(e.key);
      if (isScannerRef.current) {
        setStatus("scanning");
        setPreview(bufferRef.current.join(""));
      }

      // Reset buffer if no keystroke for 200ms (typing ended without Enter)
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(resetBuffer, 200);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [disabled, onScan, resetBuffer]);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        status === "ready" && "border-border text-muted-foreground",
        status === "scanning" && "border-primary bg-primary/5 text-primary",
        status === "preview" &&
          "border-green-500 bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400",
        disabled && "opacity-50",
        className,
      )}
    >
      <div
        className={cn(
          "size-2 rounded-full",
          status === "ready" && "bg-muted-foreground/40",
          status === "scanning" && "bg-primary animate-pulse",
          status === "preview" && "bg-green-500",
        )}
      />
      {status === "ready" && "Ready to scan"}
      {status === "scanning" && `Scanning... ${preview}`}
      {status === "preview" && preview}
    </div>
  );
}
