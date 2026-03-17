import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for scanner-input keystroke detection logic.
 *
 * These tests validate the core discrimination between hardware scanner input
 * (rapid keystrokes <30ms apart) and manual typing (slower keystrokes).
 *
 * We test the raw logic without rendering React — simulating keydown events
 * on window and verifying the callback behavior.
 */

// Simulate the scanner detection logic extracted from the component
const SCANNER_KEYSTROKE_THRESHOLD_MS = 30;
const SCANNER_MIN_LENGTH = 4;

interface ScannerDetector {
  buffer: string[];
  lastKeystroke: number;
  isScanner: boolean;
  resetTimer: ReturnType<typeof setTimeout> | null;
  onScan: (barcode: string) => void;
  handleKeyDown: (key: string, now: number) => void;
  reset: () => void;
}

function createScannerDetector(onScan: (barcode: string) => void): ScannerDetector {
  const detector: ScannerDetector = {
    buffer: [],
    lastKeystroke: 0,
    isScanner: false,
    resetTimer: null,
    onScan,

    handleKeyDown(key: string, now: number) {
      const delta = now - detector.lastKeystroke;
      detector.lastKeystroke = now;

      if (key === "Enter") {
        const barcode = detector.buffer.join("");
        if (barcode.length >= SCANNER_MIN_LENGTH && detector.isScanner) {
          detector.onScan(barcode);
        }
        detector.reset();
        return;
      }

      if (key.length !== 1) return;

      if (detector.buffer.length > 0 && delta < SCANNER_KEYSTROKE_THRESHOLD_MS) {
        detector.isScanner = true;
      }

      detector.buffer.push(key);
    },

    reset() {
      detector.buffer = [];
      detector.isScanner = false;
      detector.lastKeystroke = 0;
      if (detector.resetTimer) {
        clearTimeout(detector.resetTimer);
        detector.resetTimer = null;
      }
    },
  };

  return detector;
}

describe("scanner-input keystroke detection", () => {
  let onScan: ReturnType<typeof vi.fn<(barcode: string) => void>>;
  let detector: ScannerDetector;

  beforeEach(() => {
    onScan = vi.fn<(barcode: string) => void>();
    detector = createScannerDetector(onScan);
  });

  afterEach(() => {
    detector.reset();
  });

  it("detects fast input as scanner (keystroke delta <30ms)", () => {
    const baseTime = 1000;
    const barcode = "ABC12345";

    for (let i = 0; i < barcode.length; i++) {
      detector.handleKeyDown(barcode[i], baseTime + i * 10); // 10ms between keys
    }
    detector.handleKeyDown("Enter", baseTime + barcode.length * 10);

    expect(onScan).toHaveBeenCalledWith("ABC12345");
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it("rejects slow input as manual typing (keystroke delta >30ms)", () => {
    const baseTime = 1000;
    const text = "ABC12345";

    for (let i = 0; i < text.length; i++) {
      detector.handleKeyDown(text[i], baseTime + i * 100); // 100ms between keys
    }
    detector.handleKeyDown("Enter", baseTime + text.length * 100);

    expect(onScan).not.toHaveBeenCalled();
  });

  it("rejects short barcodes even if fast", () => {
    const baseTime = 1000;
    // Only 3 characters — below SCANNER_MIN_LENGTH of 4
    detector.handleKeyDown("A", baseTime);
    detector.handleKeyDown("B", baseTime + 5);
    detector.handleKeyDown("C", baseTime + 10);
    detector.handleKeyDown("Enter", baseTime + 15);

    expect(onScan).not.toHaveBeenCalled();
  });

  it("handles mixed speed — first keystroke slow, rest fast", () => {
    const baseTime = 1000;
    // First char at baseTime
    detector.handleKeyDown("A", baseTime);
    // Second char 200ms later (slow — but only need ONE fast pair to flag as scanner)
    detector.handleKeyDown("B", baseTime + 200);
    // Remaining chars fast
    detector.handleKeyDown("C", baseTime + 210);
    detector.handleKeyDown("D", baseTime + 220);
    detector.handleKeyDown("E", baseTime + 230);
    detector.handleKeyDown("Enter", baseTime + 240);

    // The fast pairs (B→C, C→D, D→E) should flag as scanner
    expect(onScan).toHaveBeenCalledWith("ABCDE");
  });

  it("ignores non-printable keys (e.g., Shift)", () => {
    const baseTime = 1000;
    detector.handleKeyDown("Shift", baseTime);
    detector.handleKeyDown("A", baseTime + 5);
    detector.handleKeyDown("B", baseTime + 10);
    detector.handleKeyDown("C", baseTime + 15);
    detector.handleKeyDown("D", baseTime + 20);
    detector.handleKeyDown("Enter", baseTime + 25);

    expect(onScan).toHaveBeenCalledWith("ABCD");
  });

  it("resets buffer after processing", () => {
    const baseTime = 1000;
    // First scan
    detector.handleKeyDown("A", baseTime);
    detector.handleKeyDown("B", baseTime + 5);
    detector.handleKeyDown("C", baseTime + 10);
    detector.handleKeyDown("D", baseTime + 15);
    detector.handleKeyDown("Enter", baseTime + 20);

    expect(onScan).toHaveBeenCalledTimes(1);

    // Second scan
    const baseTime2 = 2000;
    detector.handleKeyDown("X", baseTime2);
    detector.handleKeyDown("Y", baseTime2 + 5);
    detector.handleKeyDown("Z", baseTime2 + 10);
    detector.handleKeyDown("1", baseTime2 + 15);
    detector.handleKeyDown("Enter", baseTime2 + 20);

    expect(onScan).toHaveBeenCalledTimes(2);
    expect(onScan).toHaveBeenCalledWith("XYZ1");
  });

  it("handles UPC-A barcode format (12 digits)", () => {
    const baseTime = 1000;
    const upc = "012345678901";

    for (let i = 0; i < upc.length; i++) {
      detector.handleKeyDown(upc[i], baseTime + i * 8); // 8ms typical scanner speed
    }
    detector.handleKeyDown("Enter", baseTime + upc.length * 8);

    expect(onScan).toHaveBeenCalledWith("012345678901");
  });

  it("handles EAN-13 barcode format", () => {
    const baseTime = 1000;
    const ean = "4006381333931";

    for (let i = 0; i < ean.length; i++) {
      detector.handleKeyDown(ean[i], baseTime + i * 6);
    }
    detector.handleKeyDown("Enter", baseTime + ean.length * 6);

    expect(onScan).toHaveBeenCalledWith("4006381333931");
  });

  it("does not fire onScan without Enter", () => {
    const baseTime = 1000;
    detector.handleKeyDown("A", baseTime);
    detector.handleKeyDown("B", baseTime + 5);
    detector.handleKeyDown("C", baseTime + 10);
    detector.handleKeyDown("D", baseTime + 15);
    // No Enter

    expect(onScan).not.toHaveBeenCalled();
  });

  it("Enter with empty buffer does nothing", () => {
    detector.handleKeyDown("Enter", 1000);
    expect(onScan).not.toHaveBeenCalled();
  });
});
