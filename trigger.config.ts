// Rule #49: Trigger.dev v4 tasks run in Trigger's infra, NOT Vercel.
// Use @sentry/node here, NOT @sentry/nextjs — this code runs outside Next.js.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Sentry from "@sentry/node";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";
import { parse } from "dotenv";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
  enabled: process.env.NODE_ENV === "production",
});

// Vars that Trigger.dev manages itself — never sync these.
const EXCLUDED_VARS = new Set(["TRIGGER_SECRET_KEY"]);

export default defineConfig({
  project: "proj_lxmzyqttdjjukmshplok",
  dirs: ["src/trigger/tasks"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      factor: 2,
    },
  },
  build: {
    extensions: [
      syncEnvVars(async (ctx) => {
        // Pick the right .env file based on deploy environment.
        // prod → .env.production, everything else → .env.local
        const envFile = ctx.environment === "prod" ? ".env.production" : ".env.local";
        const envPath = resolve(process.cwd(), envFile);

        if (!existsSync(envPath)) {
          console.warn(`syncEnvVars: ${envFile} not found — skipping`);
          return [];
        }

        const parsed = parse(readFileSync(envPath));

        // Filter out Trigger-managed keys and return as { name, value } array
        const vars: Array<{ name: string; value: string }> = [];
        for (const [key, value] of Object.entries(parsed)) {
          if (!EXCLUDED_VARS.has(key)) {
            vars.push({ name: key, value });
          }
        }

        console.log(
          `syncEnvVars: syncing ${vars.length} vars from ${envFile} → ${ctx.environment}`,
        );

        return vars;
      }),
    ],
  },
  onFailure: async ({ ctx, error }) => {
    Sentry.captureException(error, {
      tags: {
        trigger_task: ctx.task?.id,
        trigger_run: ctx.run?.id,
      },
    });
    await Sentry.flush(2000);
  },
});
