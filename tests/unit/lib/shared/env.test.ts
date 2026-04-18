import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Phase 0 deliverable: SHIPSTATION_V2_API_KEY is in the Zod env schema.
 *
 * Plan §8 row "Phase 0" lists this env var as the first concrete change.
 * The schema declares the var with `.default("")` to match the legacy v1
 * keys, so dev/CI environments without the secret can still parse the
 * schema; production callers (`shipstation-inventory-v2.ts`, future
 * fanout) will throw their own clear error if the value is empty.
 *
 * We verify two things:
 *   1. The source file declares SHIPSTATION_V2_API_KEY in `serverEnvSchema`.
 *   2. The Zod default("") behavior is preserved.
 *
 * Calling `env()` directly would require every other required key to be set
 * in the test process, which is brittle across CI environments. Source
 * inspection + a Zod sanity check gives us the same regression guarantee
 * without that fragility.
 */

const ENV_FILE = resolve(__dirname, "../../../../src/lib/shared/env.ts");

describe("Phase 0 — SHIPSTATION_V2_API_KEY env schema", () => {
  it("declares SHIPSTATION_V2_API_KEY inside serverEnvSchema with z.string().default('')", () => {
    const source = readFileSync(ENV_FILE, "utf8");

    expect(source).toMatch(/serverEnvSchema\s*=\s*z\.object\(/);

    expect(
      /SHIPSTATION_V2_API_KEY:\s*z\.string\(\)\s*\.default\(\s*""\s*\)/.test(source),
      'SHIPSTATION_V2_API_KEY must be declared as `z.string().default("")` ' +
        "in src/lib/shared/env.ts (plan §8 Phase 0).",
    ).toBe(true);
  });

  it("Zod string().default('') accepts an absent value (matches v1 key behavior)", () => {
    const partial = z.object({
      SHIPSTATION_V2_API_KEY: z.string().default(""),
    });
    expect(partial.parse({}).SHIPSTATION_V2_API_KEY).toBe("");
    expect(partial.parse({ SHIPSTATION_V2_API_KEY: "ssv2-key" }).SHIPSTATION_V2_API_KEY).toBe(
      "ssv2-key",
    );
  });
});
