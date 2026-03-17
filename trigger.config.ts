// Rule #49: Trigger.dev v4 tasks run in Trigger's infra, NOT Vercel.
// Use @sentry/node here, NOT @sentry/nextjs — this code runs outside Next.js.
import * as Sentry from "@sentry/node";
import { defineConfig } from "@trigger.dev/sdk";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
  enabled: process.env.NODE_ENV === "production",
});

export default defineConfig({
  project: "clandestine-fulfillment",
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
