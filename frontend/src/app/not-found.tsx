import React from "react";
import Link from "next/link";
import { Compass, ArrowRight, Layers, Terminal } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-canvas atmospheric-mesh text-ink flex flex-col items-center justify-center p-4">
      <div className="glass-panel-elevated border-gradient rounded-2xl p-8 max-w-lg w-full text-center shadow-glass-elevated">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent mx-auto mb-5 border border-glass-rim shadow-glass">
          <Compass className="h-6 w-6" />
        </div>

        <span className="pendle-yt-pill tabular-mono font-mono inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold mb-3">
          <Terminal className="h-3.5 w-3.5" />
          <span>HTTP 404 · LEDGER_ENTRY_MISSING</span>
        </span>

        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">
          Ledger Entry Not Found
        </h1>

        <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
          The requested route or Soroban contract resource does not exist on this NivoraFi node.
        </p>

        <div className="mt-6 rounded-xl bg-console border border-console-hairline p-3 text-left text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-console-muted">Status</span>
            <span className="tabular-mono font-mono text-console-accent font-semibold">
              404_NOT_FOUND
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-console-muted">Network</span>
            <span className="tabular-mono font-mono text-console-text">
              Stellar Testnet (Soroban)
            </span>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="btn-monochrome inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-semibold"
          >
            <span>Return to Desk</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link
            href="/markets"
            className="btn-monochrome-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold"
          >
            <Layers className="h-3.5 w-3.5 text-accent" />
            <span>Explore Markets</span>
          </Link>
        </div>

        <div className="mt-6 pt-4 border-t border-glass-rim flex items-center justify-center gap-4 text-xs text-ink-muted">
          <Link href="/terms" className="hover:text-ink transition-colors">
            Terms
          </Link>
          <span>·</span>
          <Link href="/privacy" className="hover:text-ink transition-colors">
            Privacy
          </Link>
          <span>·</span>
          <a
            href="https://github.com/NivoraFi/nivorafi"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink transition-colors"
          >
            GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
