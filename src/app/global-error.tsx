"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "system-ui, sans-serif",
            padding: "2rem",
          }}
        >
          <div style={{ maxWidth: "400px", textAlign: "center" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.5rem" }}>
              Something went wrong
            </h1>
            <p style={{ color: "#666", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
              An unexpected error occurred. The error has been reported.
            </p>
            {error.digest && (
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "#999",
                  fontFamily: "monospace",
                  marginBottom: "1rem",
                }}
              >
                Error ID: {error.digest}
              </p>
            )}
            <button
              type="button"
              onClick={reset}
              style={{
                padding: "0.5rem 1.5rem",
                border: "1px solid #ddd",
                borderRadius: "0.375rem",
                background: "white",
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
