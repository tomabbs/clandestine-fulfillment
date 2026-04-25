/**
 * Slice 1 / Slice 2 — preflight check for webhook signing secrets.
 *
 * Runs in two modes:
 *
 *   1. `pnpm ops:check-webhook-secrets` (default) — asserts that the
 *      EasyPost and Resend webhook signing secrets are present in
 *      `process.env`. Fails (exit 1) if either is missing. Intended to
 *      gate the production deploy of the Slice 1 fail-closed verifier.
 *
 *   2. `pnpm ops:check-webhook-secrets --rotation-status` — additionally
 *      reports which previous-secret slots are populated so operators can
 *      see at a glance what the rotation overlap window looks like.
 *
 * The script intentionally does NOT load `.env.local` — it expects the
 * caller to supply env (Vercel CLI `vercel env pull`, `direnv`, or the
 * shell's exported variables) so a stale local `.env` cannot mask a
 * missing production secret.
 */

const REQUIRED: Array<{ name: string; description: string }> = [
  {
    name: "EASYPOST_WEBHOOK_SECRET",
    description: "EasyPost webhook signing secret. Without it the route fails closed (401).",
  },
  {
    name: "RESEND_WEBHOOK_SECRET",
    description:
      "Resend (Svix) webhook signing secret. Without it Resend webhooks cannot be verified.",
  },
];

const OPTIONAL_ROTATION: Array<{ name: string; description: string }> = [
  {
    name: "EASYPOST_WEBHOOK_SECRET_PREVIOUS",
    description: "Previous EasyPost secret kept live during a rotation overlap window.",
  },
  {
    name: "RESEND_WEBHOOK_SECRET_PREVIOUS",
    description: "Previous Resend secret kept live during a rotation overlap window.",
  },
];

export interface CheckWebhookSecretsResult {
  exitCode: number;
  /** Lines that would be written to stderr (for missing-secret diagnostics). */
  errors: string[];
  /** Lines that would be written to stdout (OK + rotation status). */
  out: string[];
}

/**
 * Pure runner used by both the CLI entry-point and the unit tests.
 * Takes its env explicitly so callers can sandbox without leaking
 * process.env state.
 */
export function checkWebhookSecrets(
  env: Record<string, string | undefined>,
  options: { showRotation?: boolean } = {},
): CheckWebhookSecretsResult {
  const errors: string[] = [];
  const out: string[] = [];
  const missing: string[] = [];
  for (const { name, description } of REQUIRED) {
    const value = env[name];
    if (!value || value.length === 0) {
      missing.push(`  - ${name}: ${description}`);
    }
  }
  if (missing.length > 0) {
    errors.push("ERROR: required webhook signing secrets are missing from process.env:");
    errors.push(missing.join("\n"));
    errors.push("\nResolve by setting them in Vercel (Production scope) and re-running.");
    return { exitCode: 1, errors, out };
  }
  out.push("OK: required webhook signing secrets are present.");
  if (options.showRotation) {
    out.push("\nRotation overlap status:");
    for (const { name, description } of OPTIONAL_ROTATION) {
      const value = env[name];
      const present = !!value && value.length > 0;
      out.push(`  - ${name}: ${present ? "PRESENT" : "absent"}`);
      if (!present) {
        out.push(`      ${description}`);
      }
    }
  }
  return { exitCode: 0, errors, out };
}

function main(): number {
  const result = checkWebhookSecrets(process.env, {
    showRotation: process.argv.includes("--rotation-status"),
  });
  for (const line of result.errors) console.error(line);
  for (const line of result.out) console.log(line);
  return result.exitCode;
}

// Only invoke the CLI when this module is the script entry-point (so unit
// tests can import `checkWebhookSecrets` without process.exit firing).
const invokedDirectly =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;
if (invokedDirectly) {
  process.exit(main());
}
