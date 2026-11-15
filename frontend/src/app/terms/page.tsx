import React from "react";
import Link from "next/link";
import { ShieldAlert, ArrowLeft, ArrowUpRight, Terminal, Scale, Lock, Code2 } from "lucide-react";
import { constructMetadata } from "@/lib/seo";

export const metadata = constructMetadata({
  title: "Terms of Service",
  description:
    "Non-custodial protocol terms, Stellar Testnet scope, and smart contract risk disclosures for NivoraFi.",
  path: "/terms",
});

export default function TermsOfServicePage() {
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
              aria-current="page"
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-glass-elevated border border-glass-rim text-ink shadow-glass"
            >
              Terms
            </Link>
            <Link
              href="/privacy"
              className="px-3 py-1.5 rounded-xl text-xs font-medium text-ink-secondary hover:text-ink transition-colors"
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
            <span className="pendle-yt-pill inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold">
              <Scale className="h-3.5 w-3.5" />
              <span>Protocol Governance & Terms</span>
            </span>
            <span className="tabular-mono font-mono text-xs text-ink-muted">
              Updated: 2026-11-15 · Rev 1.0
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-ink">
            Terms of Service
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-secondary leading-relaxed">
            By connecting a Stellar wallet or submitting Soroban transactions through NivoraFi, you agree to these non-custodial protocol terms.
          </p>
        </section>

        {/* Asymmetric Glass Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
          {/* Card 1: Non-Custodial Architecture */}
          <article className="md:col-span-7 glass-card border-gradient glass-interactive rounded-2xl p-6 flex flex-col justify-between shadow-glass">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="tabular-mono font-mono text-xs font-semibold text-accent">
                  SECTION 01
                </span>
                <Lock className="h-4 w-4 text-accent" />
              </div>
              <h2 className="text-lg font-semibold text-ink">
                Non-Custodial Smart Contract Interface
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
                NivoraFi never holds, custody-manages, or accesses user private keys; every transaction envelope is constructed as an unsigned XDR and signed locally in your own wallet extension.
              </p>
            </div>

            <div className="mt-5 pt-4 border-t border-glass-rim flex items-center justify-between text-xs text-ink-muted">
              <span>Supported Signers</span>
              <span className="tabular-mono font-mono text-ink font-medium">
                Freighter · LOBSTR · xBull · Albedo
              </span>
            </div>
          </article>

          {/* Card 2: Stellar Testnet Scope */}
          <article className="md:col-span-5 glass-card border-gradient glass-interactive rounded-2xl p-6 flex flex-col justify-between shadow-glass">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="tabular-mono font-mono text-xs font-semibold text-positive">
                  SECTION 02
                </span>
                <Terminal className="h-4 w-4 text-positive" />
              </div>
              <h2 className="text-lg font-semibold text-ink">
                Stellar Testnet Execution Scope
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
                All NivoraFi smart contracts currently operate exclusively on Stellar Testnet and carry zero real-world monetary value.
              </p>
            </div>

            <div className="mt-4 rounded-xl bg-console border border-console-hairline p-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-console-muted">Network</span>
                <span className="tabular-mono font-mono text-console-accent font-semibold">
                  Test SDF Network ; September 2015
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-console-muted">Core AMM Pool</span>
                <span className="tabular-mono font-mono text-console-text">
                  CBOADR...JLAGBF
                </span>
              </div>
            </div>
          </article>

          {/* Card 3: No Financial Advice */}
          <article className="md:col-span-5 glass-card border-gradient glass-interactive rounded-2xl p-6 flex flex-col justify-between shadow-glass">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="tabular-mono font-mono text-xs font-semibold text-ink-muted">
                  SECTION 03
                </span>
                <ShieldAlert className="h-4 w-4 text-warn" />
              </div>
              <h2 className="text-lg font-semibold text-ink">
                No Financial or Legal Advice
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
                Implied fixed APY metrics, Yield Token leverage quotes, and log-normal curve simulations are deterministic math outputs provided strictly for technical evaluation.
              </p>
            </div>

            <div className="mt-5 pt-4 border-t border-glass-rim flex items-center justify-between text-xs text-ink-muted">
              <span>Oracle Precision</span>
              <span className="tabular-mono font-mono text-ink font-semibold">
                18-Decimal WAD Fixed-Point
              </span>
            </div>
          </article>

          {/* Card 4: Smart Contract & AMM Risks */}
          <article className="md:col-span-7 glass-card border-gradient glass-interactive rounded-2xl p-6 flex flex-col justify-between shadow-glass">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="tabular-mono font-mono text-xs font-semibold text-ink-muted">
                  SECTION 04
                </span>
                <Code2 className="h-4 w-4 text-accent" />
              </div>
              <h2 className="text-lg font-semibold text-ink">
                Protocol & Smart Contract Risks
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary leading-relaxed">
                Interacting with Soroban smart contracts, 2-step Picard iteration flash swaps, and atomic maturity rollovers involves experimental software and state-expiration risks assumed solely by the user.
              </p>
            </div>

            <div className="mt-5 pt-4 border-t border-glass-rim flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
              <span>Open-Source License</span>
              <a
                href="https://github.com/NivoraFi/nivorafi/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 tabular-mono font-mono text-accent hover:underline"
              >
                <span>MIT License (AS-IS)</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
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
            <Link href="/privacy" className="hover:text-ink transition-colors">
              Privacy Policy
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
