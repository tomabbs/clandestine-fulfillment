import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/components/support/support-launcher.tsx"),
  "utf8",
);

describe("SupportLauncher source contract", () => {
  it("does not persist or restore open state across refreshes", () => {
    expect(source).not.toContain("support_launcher_open");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });

  it("does not auto-open when unread support messages arrive", () => {
    expect(source).toContain("setHasNewAlert(true)");
    expect(source).not.toContain("setOpen(true)");
  });
});
