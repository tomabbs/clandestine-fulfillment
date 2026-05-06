import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BANDCAMP_SYNC_SOURCE = readFileSync("src/trigger/tasks/bandcamp-sync.ts", "utf8");

describe("bandcamp-sync unmatched create schema guard", () => {
  it("does not insert unsupported image_url into warehouse_products", () => {
    const productInsertBlocks = [
      ...BANDCAMP_SYNC_SOURCE.matchAll(
        /\.from\("warehouse_products"\)\s*\n\s*\.insert\(\{[\s\S]*?\}\)\s*\n\s*\.select\("id"\)/g,
      ),
    ].map((match) => match[0]);

    expect(productInsertBlocks.length).toBeGreaterThan(0);
    for (const block of productInsertBlocks) {
      expect(block).not.toContain("image_url:");
    }
  });
});
