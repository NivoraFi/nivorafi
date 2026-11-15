"use client";

import React, { useEffect } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Fatal root error:", error);
  }, [error]);

  return (
    <html lang="en" className="dark overflow-x-clip">
      <body className="min-h-screen bg-canvas text-ink flex flex-col items-center justify-center p-4 font-sans antialiased overflow-x-clip">
        <div className="double-bezel rounded-2xl p-8 bg-surface-muted/80 border border-hairline max-w-md w-full text-center backdrop-blur-xl">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger mx-auto mb-4 border border-hairline">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h2 className="text-base font-semibold text-ink mb-1">
            Application Error
          </h2>
          <p className="text-xs text-ink-muted mb-6 font-mono break-words">
            {error.message || "A fatal rendering exception occurred in the root layout."}
          </p>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-xl border border-hairline bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.98] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Reload Application</span>
          </button>
        </div>
      </body>
    </html>
  );
}
