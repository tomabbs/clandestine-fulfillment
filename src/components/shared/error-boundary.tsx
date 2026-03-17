"use client";

import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
  variant?: "admin" | "portal";
}

export function ErrorBoundary({ error, reset, variant = "admin" }: ErrorBoundaryProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  const isAdmin = variant === "admin";

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <AlertTriangle className="h-12 w-12 text-destructive mx-auto" />
        <h2 className="text-xl font-semibold">
          {isAdmin ? "Something went wrong" : "We hit a snag"}
        </h2>
        <p className="text-muted-foreground text-sm">
          {isAdmin
            ? "An error occurred while loading this page. The error has been reported automatically."
            : "Something unexpected happened. Our team has been notified and is looking into it."}
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground font-mono">Error ID: {error.digest}</p>
        )}
        <Button onClick={reset} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Try Again
        </Button>
      </div>
    </div>
  );
}
