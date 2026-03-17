"use client";

import { ErrorBoundary } from "@/components/shared/error-boundary";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} variant="admin" />;
}
