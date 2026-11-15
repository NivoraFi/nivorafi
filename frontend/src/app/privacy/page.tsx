import React from "react";
import Link from "next/link";
import { ShieldCheck, ArrowLeft, EyeOff, Database, HardDrive, Server } from "lucide-react";
import { constructMetadata } from "@/lib/seo";

export const metadata = constructMetadata({
  title: "Privacy Policy",
  description:
    "Zero-cookie, zero-tracker privacy architecture for the NivoraFi Stellar Soroban protocol.",
  path: "/privacy",
});

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-canvas atmospheric-mesh text-ink flex flex-col justify-between">
      {/* Top Frosted Glass Navigation Bar */}
      <header className="sticky top-0 z-30 glass-panel border-b border-glass-rim">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs font-semibold text-ink-secondary hover:text-ink transition-colors"
          >
            <ArrowLeft className="h-4 w-4 text-accent" />
            <span>Back to NivoraFi Desk</span>
          </Link>

          <nav aria-label="Legal navigation" className="flex items-center gap-2">
            <Link
              href="/terms"
              className="px-3 py-1.5 rounded-xl text-xs font-medium text-ink-secondary hover:text-ink transition-colors"
            >
              Terms
            </Link>
            <Link
              href="/privacy"
              aria-current="page"
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-glass-elevated border border-glass-rim text-ink shadow-glass"
            >
              Privacy
            </Link>
            <Link
              href="/markets"
              className="hidden sm:inline-flex px-3 py-1.5 rounded-xl text-xs font-medium text-ink-secondary hover:text-ink transition-colors"
            >
              Markets
            </Link>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-10 sm:py-16 flex-1 space-y-6">
        {/* Hero Glass Panel */}
        <section className="glass-panel-elevated border-gradient rounded-2xl p-6 sm:p-8 shadow-glass-elevated">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <span className="pendle-pt-pill inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Zero Cookies · Zero Trackers</span>
            </span>
            <span className="tabular-mono font-mono text-xs text-ink-muted">
              Updated: 2026-11-15 · Rev 1.0
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-ink">
            Privacy Policy
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-secondary leading-relaxed">
            NivoraFi is engineered with a strict zero-telemetry posture: we do not collect personal data, set tracking cookies, or run behavioral analytics.
          </p>
        </section>

        {/* Asymmetric Glass Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
          {/* Card 1: Zero Cookies & Trackers */}
          <article className="md:col-span-6 glass-card border-gradient glass-interactive rounded-2xl p-6 flex flex-col justify-between shadow-glass">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="tabular-mono font-mono text-xs font-semibold text-positive">
                  PRIVACY 01
                </span>
                <EyeOff className="h-4 w-4 text-positive" />
              </div>
              <h2 className="text-lg font-semibold text-ink">
                No Cookies or Fingerprinting
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
                The NivoraFi frontend deploys zero advertising cookies, zero cross-site tracking pixels, and zero third-party session recorders.
              </p>
            </div>

            <div className="mt-5 pt-4 border-t border-glass-rim flex items-center justify-between text-xs text-ink-muted">
              <span>Tracking Scripts</span>
              <span className="tabular-mono font-mono text-positive font-semibold">
                0 Loaded
              </span>
            </div>
          </article>

          {/* Card 2: Public Ledger Data */}
          <article className="md:col-span-6 glass-card border-gradient glass-interactive rounded-2xl p-6 flex flex-col justify-between shadow-glass">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="tabular-mono font-mono text-xs font-semibold text-accent">
                  PRIVACY 02
                </span>
                <Database className="h-4 w-4 text-accent" />
              </div>
              <h2 className="text-lg font-semibold text-ink">
                Public Stellar Ledger State
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
                When you connect a wallet or broadcast a signed Soroban XDR, your public Stellar account address and on-chain events are publicly visible on the Stellar Testnet ledger.
              </p>
            </div>

            <div className="mt-5 pt-4 border-t border-glass-rim flex items-center justify-between text-xs text-ink-muted">
              <span>Identity Binding</span>
              <span className="tabular-mono font-mono text-ink font-medium">
                Pseudonymous Public Key Only
              </span>
            </div>
          </article>

          {/* Card 3: Local Browser Storage */}
          <article className="md:col-span-5 glass-card border-gradient glass-interactive rounded-2xl p-6 flex flex-col justify-between shadow-glass">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="tabular-mono font-mono text-xs font-semibold text-ink-muted">
                  PRIVACY 03
                </span>
                <HardDrive className="h-4 w-4 text-ink-secondary" />
              </div>
              <h2 className="text-lg font-semibold text-ink">
                Client-Side Ephemeral State
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
                Selected market preferences and wallet connection state remain locally in your browser memory and are never transmitted to any profiling database.
              </p>
            </div>

            <div className="mt-5 pt-4 border-t border-glass-rim flex items-center justify-between text-xs text-ink-muted">
              <span>Personal Data Stored</span>
              <span className="tabular-mono font-mono text-ink font-semibold">
                None
              </span>
            </div>
          </article>

          {/* Card 4: RPC & Indexer Endpoints */}
          <article className="md:col-span-7 glass-card border-gradient glass-interactive rounded-2xl p-6 flex flex-col justify-between shadow-glass">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="tabular-mono font-mono text-xs font-semibold text-ink-muted">
                  PRIVACY 04
                </span>
                <Server className="h-4 w-4 text-accent" />
              </div>
              <h2 className="text-lg font-semibold text-ink">
                RPC & Event Indexer Routing
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
                Contract simulations and ledger queries route through public Stellar Testnet endpoints and the NivoraFi BFF proxy without logging personal identifiers.
              </p>
            </div>

            <div className="mt-4 rounded-xl bg-console border border-console-hairline p-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-console-muted">Soroban RPC</span>
                <span className="tabular-mono font-mono text-console-accent">
                  https://soroban-testnet.stellar.org
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-console-muted">BFF Event Proxy</span>
                <span className="tabular-mono font-mono text-console-text">
                  /api/indexer/*
                </span>
              </div>
            </div>
          </article>
        </div>
      </main>

      {/* Bottom Glass Footer */}
      <footer className="border-t border-glass-rim glass-panel py-6">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-ink-muted">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ink">NivoraFi</span>
            <span>·</span>
            <span>Native Yield Tokenization on Stellar Soroban</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/terms" className="hover:text-ink transition-colors">
              Terms of Service
            </Link>
            <a
              href="https://github.com/NivoraFi/nivorafi"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-ink transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://x.com/NivoraFi"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-ink transition-colors"
            >
              X (@NivoraFi)
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
