"use client";

import { ErrorBoundary } from "@/components/shared/error-boundary";

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} variant="portal" />;
}
