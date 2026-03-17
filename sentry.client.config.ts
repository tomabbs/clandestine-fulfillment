import * as Sentry from "@sentry/nextjs";

const isProd = process.env.NODE_ENV === "production";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: isProd ? "production" : "development",
  release: process.env.NEXT_PUBLIC_APP_URL
    ? `clandestine-fulfillment@${process.env.npm_package_version ?? "0.1.0"}`
    : undefined,
  tracesSampleRate: isProd ? 0.1 : 1.0,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  enabled: isProd,
});
