// Slice 1 — preflight test for `pnpm ops:check-webhook-secrets`.
//
// Exercises the pure runner exported by the script (so we don't depend
// on tsx being installed in the test sandbox). The CLI entry-point is
// a thin shim that calls the same function with `process.env`.

import { describe, expect, it } from "vitest";
import { checkWebhookSecrets } from "../../../scripts/check-webhook-secrets";

describe("checkWebhookSecrets — required secrets", () => {
  it("EXIT 0 when both required secrets are present", () => {
    const r = checkWebhookSecrets({
      EASYPOST_WEBHOOK_SECRET: "ep-secret-123",
      RESEND_WEBHOOK_SECRET: "rs-secret-456",
    });
    expect(r.exitCode).toBe(0);
    expect(r.out.join("\n")).toMatch(/OK: required webhook signing secrets are present/);
    expect(r.errors).toHaveLength(0);
  });

  it("EXIT 1 when EASYPOST_WEBHOOK_SECRET is missing", () => {
    const r = checkWebhookSecrets({
      RESEND_WEBHOOK_SECRET: "rs-secret-456",
    });
    expect(r.exitCode).toBe(1);
    const stderr = r.errors.join("\n");
    expect(stderr).toMatch(/required webhook signing secrets are missing/);
    expect(stderr).toMatch(/EASYPOST_WEBHOOK_SECRET/);
    expect(stderr).not.toMatch(/RESEND_WEBHOOK_SECRET/);
  });

  it("EXIT 1 when RESEND_WEBHOOK_SECRET is missing", () => {
    const r = checkWebhookSecrets({
      EASYPOST_WEBHOOK_SECRET: "ep-secret-123",
    });
    expect(r.exitCode).toBe(1);
    const stderr = r.errors.join("\n");
    expect(stderr).toMatch(/required webhook signing secrets are missing/);
    expect(stderr).toMatch(/RESEND_WEBHOOK_SECRET/);
    expect(stderr).not.toMatch(/EASYPOST_WEBHOOK_SECRET\b(?!.*Resend)/);
  });

  it("EXIT 1 when both required secrets are missing — both names listed", () => {
    const r = checkWebhookSecrets({});
    expect(r.exitCode).toBe(1);
    const stderr = r.errors.join("\n");
    expect(stderr).toMatch(/EASYPOST_WEBHOOK_SECRET/);
    expect(stderr).toMatch(/RESEND_WEBHOOK_SECRET/);
  });

  it("EXIT 1 when secret is present but empty string (treats as missing)", () => {
    const r = checkWebhookSecrets({
      EASYPOST_WEBHOOK_SECRET: "",
      RESEND_WEBHOOK_SECRET: "rs-secret",
    });
    expect(r.exitCode).toBe(1);
    expect(r.errors.join("\n")).toMatch(/EASYPOST_WEBHOOK_SECRET/);
  });
});

describe("checkWebhookSecrets — --rotation-status mode", () => {
  it("reports PRESENT for both rotation slots when populated", () => {
    const r = checkWebhookSecrets(
      {
        EASYPOST_WEBHOOK_SECRET: "current",
        EASYPOST_WEBHOOK_SECRET_PREVIOUS: "previous",
        RESEND_WEBHOOK_SECRET: "current",
        RESEND_WEBHOOK_SECRET_PREVIOUS: "previous",
      },
      { showRotation: true },
    );
    expect(r.exitCode).toBe(0);
    const stdout = r.out.join("\n");
    expect(stdout).toMatch(/Rotation overlap status:/);
    expect(stdout).toMatch(/EASYPOST_WEBHOOK_SECRET_PREVIOUS:\s*PRESENT/);
    expect(stdout).toMatch(/RESEND_WEBHOOK_SECRET_PREVIOUS:\s*PRESENT/);
  });

  it("reports absent for both rotation slots when unpopulated", () => {
    const r = checkWebhookSecrets(
      {
        EASYPOST_WEBHOOK_SECRET: "current",
        RESEND_WEBHOOK_SECRET: "current",
      },
      { showRotation: true },
    );
    expect(r.exitCode).toBe(0);
    const stdout = r.out.join("\n");
    expect(stdout).toMatch(/EASYPOST_WEBHOOK_SECRET_PREVIOUS:\s*absent/);
    expect(stdout).toMatch(/RESEND_WEBHOOK_SECRET_PREVIOUS:\s*absent/);
  });

  it("rotation mode does NOT mask a missing required secret (still exit 1)", () => {
    const r = checkWebhookSecrets(
      {
        // Note: only PREVIOUS slot populated; current slot is absent.
        EASYPOST_WEBHOOK_SECRET_PREVIOUS: "old",
        RESEND_WEBHOOK_SECRET: "rs",
      },
      { showRotation: true },
    );
    expect(r.exitCode).toBe(1);
    expect(r.errors.join("\n")).toMatch(/EASYPOST_WEBHOOK_SECRET/);
    // Should NOT have entered the rotation block when required secrets are
    // missing — the output check ran first.
    expect(r.out.join("\n")).not.toMatch(/Rotation overlap status:/);
  });
});
