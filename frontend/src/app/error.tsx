"use client";

import React, { useEffect } from "react";
import { AlertCircle, RefreshCw, Home } from "lucide-react";
import { decodeSorobanError } from "@/lib/math";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Route segment error:", error);
  }, [error]);

  const decoded = decodeSorobanError(error);

  return (
    <div className="min-h-screen bg-canvas flex flex-col items-center justify-center p-4">
      <div className="double-bezel rounded-2xl p-8 bg-surface-muted/80 border border-hairline max-w-md w-full text-center backdrop-blur-xl">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger mx-auto mb-4 border border-hairline">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h2 className="text-base font-semibold text-ink mb-1">
          Trading Desk Execution Interrupted
        </h2>
        <p className="text-xs text-ink-muted mb-4 font-mono break-words">
          {decoded}
        </p>
        {error.digest && (
          <div className="text-[10px] text-ink-muted/60 mb-6">
            Digest: <code className="font-mono">{error.digest}</code>
          </div>
        )}
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-xl border border-hairline bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.98] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Try Again</span>
          </button>
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-hairline bg-surface-muted px-4 py-2 text-xs font-semibold text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.98] transition-colors cursor-pointer"
          >
            <Home className="h-4 w-4" />
            <span>Return to Desk</span>
          </a>
        </div>
      </div>
    </div>
  );
}
