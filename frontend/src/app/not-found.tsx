import React from "react";
import Link from "next/link";
import { Compass, ArrowRight } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-canvas flex flex-col items-center justify-center p-4">
      <div className="double-bezel rounded-2xl p-8 bg-surface-muted/80 border border-hairline max-w-md w-full text-center shadow-card backdrop-blur-xl">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent mx-auto mb-4 border border-hairline">
          <Compass className="h-6 w-6" />
        </div>
        <h2 className="text-base font-semibold text-ink mb-1">
          404 - Ledger Entry Not Found
        </h2>
        <p className="text-xs text-ink-muted mb-6">
          The requested page or contract path does not exist on this NivoraFi node.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-xl border border-hairline bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-surface-elevated transition shadow-card"
        >
          <span>Back to Markets</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
