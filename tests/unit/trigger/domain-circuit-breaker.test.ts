import { describe, expect, it } from "vitest";
import {
  calculateDelayMs,
  classifyFailureReason,
  extractSubdomain,
} from "@/trigger/lib/domain-circuit-breaker";

describe("extractSubdomain", () => {
  it("extracts subdomain from standard bandcamp.com URLs", () => {
    expect(extractSubdomain("https://truepanther.bandcamp.com/album/test")).toBe("truepanther");
    expect(extractSubdomain("https://nnatapes.bandcamp.com/merch/tee")).toBe("nnatapes");
  });

  it("uses full hostname for custom domains", () => {
    expect(extractSubdomain("https://music.sufjan.com/album/test")).toBe("music.sufjan.com");
    expect(extractSubdomain("https://store.some-label.com/merch/bag")).toBe("store.some-label.com");
  });

  it("lowercases the hostname", () => {
    expect(extractSubdomain("https://TruePanther.Bandcamp.com/album/x")).toBe("truepanther");
  });

  it("returns null for invalid URLs", () => {
    expect(extractSubdomain("not-a-url")).toBeNull();
    expect(extractSubdomain("")).toBeNull();
  });

  it("handles bare bandcamp.com as custom domain (full hostname)", () => {
    expect(extractSubdomain("https://bandcamp.com/discover")).toBe("bandcamp.com");
  });
});

describe("classifyFailureReason", () => {
  it("classifies 429 as rate_limited", () => {
    expect(classifyFailureReason(429, new Error("Too Many Requests"))).toBe("rate_limited");
  });

  it("classifies 404 as not_found", () => {
    expect(classifyFailureReason(404, new Error("Not Found"))).toBe("not_found");
  });

  it("classifies 410 as gone", () => {
    expect(classifyFailureReason(410, new Error("Gone"))).toBe("gone");
  });

  it("classifies 408 and 504 as timeout", () => {
    expect(classifyFailureReason(408, new Error("Timeout"))).toBe("timeout");
    expect(classifyFailureReason(504, new Error("Gateway Timeout"))).toBe("timeout");
  });

  it("classifies 500+ as server_error", () => {
    expect(classifyFailureReason(500, new Error("ISE"))).toBe("server_error");
    expect(classifyFailureReason(502, new Error("Bad Gateway"))).toBe("server_error");
    expect(classifyFailureReason(503, new Error("Service Unavailable"))).toBe("server_error");
  });

  it("classifies parse errors from error message", () => {
    expect(classifyFailureReason(undefined, new Error("tralbum not found"))).toBe("parse_failure");
    expect(classifyFailureReason(undefined, new Error("parse error in data"))).toBe("parse_failure");
  });

  it("defaults to server_error for unknown errors", () => {
    expect(classifyFailureReason(undefined, new Error("unknown"))).toBe("server_error");
  });
});

describe("calculateDelayMs", () => {
  it("returns roughly 1000ms for 1.0 RPS", () => {
    const delays = Array.from({ length: 100 }, () => calculateDelayMs(1.0));
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
    expect(avg).toBeGreaterThan(900);
    expect(avg).toBeLessThan(1400);
  });

  it("returns shorter delays for higher RPS", () => {
    const delays = Array.from({ length: 100 }, () => calculateDelayMs(2.0));
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
    expect(avg).toBeGreaterThan(400);
    expect(avg).toBeLessThan(800);
  });

  it("caps delay for very low RPS", () => {
    const delay = calculateDelayMs(0.01);
    expect(delay).toBeLessThan(15000);
    expect(delay).toBeGreaterThan(5000);
  });

  it("adds jitter (not all identical)", () => {
    const delays = Array.from({ length: 20 }, () => calculateDelayMs(1.0));
    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(1);
  });
});
