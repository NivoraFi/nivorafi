"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { LiveMarketSnapshot } from "@/lib/stellar";
import { useMarket } from "@/context/MarketContext";
import { MarketExplorerTable } from "@/components/markets/MarketExplorerTable";
import {
  DirectionalReveal,
  InteractiveLiftCard,
  MotionAction,
} from "@/components/ui/motion-primitives";

function useSafeRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

export interface LandingViewProps {
  onEnterDesk: () => void;
  onOpenDevDrawer?: () => void;
  snapshot: LiveMarketSnapshot | null;
}

export function LandingView({
  onEnterDesk,
  snapshot,
}: LandingViewProps) {
  const router = useSafeRouter();
  const { selectMarket = () => {}, activeMarket } = useMarket();

  const impliedApy =
    typeof snapshot?.impliedFixedApyPct === "number"
      ? `${snapshot.impliedFixedApyPct.toFixed(2)}%`
      : "--";

  const ytPrice =
    typeof snapshot?.ytPriceInSy === "number"
      ? `${snapshot.ytPriceInSy.toFixed(4)} SY`
      : "--";

  return (
    <div className="flex flex-col items-center justify-center text-center px-4 py-8 sm:py-16 w-full">
      {/* 1. Hero Headline & Subtitle */}
      <div className="max-w-4xl mx-auto flex flex-col items-center">
        <DirectionalReveal from="top" delay={0.48} distance={28} duration={0.78}>
          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold tracking-tight text-ink">
            Yield tokenized on Stellar.
          </h1>
        </DirectionalReveal>

        <DirectionalReveal from="top" delay={0.64} distance={18} duration={0.72}>
          <p className="mt-4 max-w-xl text-sm sm:text-base text-ink-secondary">
            Trade discounted principal tokens and speculative yield tokens through native log-normal liquidity pools.
          </p>
        </DirectionalReveal>

        {/* Action Group */}
        <DirectionalReveal from="bottom" delay={0.78} distance={22} duration={0.68}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <MotionAction>
              <Link
                href={`/trade/${activeMarket?.id || "usdc-90d"}`}
                prefetch
                onClick={() => {
                  if (!router) {
                    onEnterDesk();
                  }
                }}
                className="btn-monochrome group inline-flex items-center gap-2.5 rounded-xl px-6 py-3 text-sm whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none"
              >
                <span>Launch App</span>
                <ArrowRight className="h-4 w-4 transition-transform motion-reduce:transform-none group-hover:translate-x-0.5" />
              </Link>
            </MotionAction>
          </div>
        </DirectionalReveal>
      </div>

      {/* 2. Precision Metric Strip */}
      <div className="mt-12 sm:mt-16 w-full max-w-4xl">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Metric 1 - PT Fixed APY */}
          <DirectionalReveal from="left" delay={0.92} distance={38} duration={0.76}>
            <InteractiveLiftCard className="h-full">
              <div className="glass-card border-gradient rounded-2xl p-5 text-left flex flex-col justify-between h-full shadow-glass">
                <div>
                  <p className="text-xs font-medium text-ink-muted">
                    PT Implied Fixed APY
                  </p>
                  <p className="tabular-mono font-mono mt-2 text-2xl sm:text-3xl font-bold tracking-tight text-ink">
                    {impliedApy}
                  </p>
                </div>
                <p className="mt-3 text-xs text-ink-secondary">
                  Guaranteed returns locked until maturity.
                </p>
              </div>
            </InteractiveLiftCard>
          </DirectionalReveal>

          {/* Metric 2 - YT Leverage Stream */}
          <DirectionalReveal from="right" delay={1.00} distance={38} duration={0.76}>
            <InteractiveLiftCard className="h-full">
              <div className="glass-card border-gradient rounded-2xl p-5 text-left flex flex-col justify-between h-full shadow-glass">
                <div>
                  <p className="text-xs font-medium text-ink-muted">
                    YT Leverage Stream
                  </p>
                  <p className="tabular-mono font-mono mt-2 text-2xl sm:text-3xl font-bold tracking-tight text-ink">
                    {ytPrice}
                  </p>
                </div>
                <p className="mt-3 text-xs text-ink-secondary">
                  Capital-efficient yield exposure.
                </p>
              </div>
            </InteractiveLiftCard>
          </DirectionalReveal>
        </div>
      </div>

      {/* 3. Centerpiece Pendle V2 Markets Table */}
      <div className="w-full max-w-5xl mt-14 sm:mt-20 text-left">
        <DirectionalReveal from="left" delay={1.12} distance={26} duration={0.70}>
          <div className="mb-6">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">
              Active Yield Markets
            </h2>
            <p className="mt-1 text-xs sm:text-sm text-ink-secondary">
              Institutional-grade fixed yield and leveraged variable yield instruments on Stellar testnet.
            </p>
          </div>
        </DirectionalReveal>

        {/* Modular High-Density Market Explorer Table */}
        <DirectionalReveal from="bottom" delay={1.20} distance={32} duration={0.82}>
          <MarketExplorerTable
            onSelectMarket={(marketId) => {
              selectMarket(marketId);
              if (!router) {
                onEnterDesk();
              }
            }}
          />
        </DirectionalReveal>
      </div>

      {/* 4. Minimalist Value Pillar Cards */}
      <div className="mt-14 sm:mt-18 w-full max-w-5xl">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5 text-left">
          {/* Pillar 1 */}
          <DirectionalReveal from="left" delay={1.32} distance={34} duration={0.74} className="h-full md:col-span-5">
            <InteractiveLiftCard className="h-full">
              <div className="glass-card border-gradient rounded-2xl p-6 flex flex-col justify-between transition-colors hover:border-hairline-strong shadow-glass h-full">
                <div>
                  <h3 className="text-lg font-semibold text-ink">
                    Principal Tokens
                  </h3>
                  <p className="mt-2 text-xs text-ink-secondary leading-relaxed">
                    Lock in predictable fixed income by holding discounted principal tokens until maturity.
                  </p>
                </div>
                <div className="mt-4 pt-4 border-t border-glass-rim flex items-center justify-between text-xs text-ink-muted">
                  <span>Maturity Yield</span>
                  <span className="text-positive font-semibold">Fixed</span>
                </div>
              </div>
            </InteractiveLiftCard>
          </DirectionalReveal>

          {/* Pillar 2 */}
          <DirectionalReveal from="bottom" delay={1.40} distance={30} duration={0.74} className="h-full md:col-span-4">
            <InteractiveLiftCard className="h-full">
              <div className="glass-card border-gradient rounded-2xl p-6 flex flex-col justify-between transition-colors hover:border-hairline-strong shadow-glass h-full">
                <div>
                  <h3 className="text-lg font-semibold text-ink">
                    Yield Tokens
                  </h3>
                  <p className="mt-2 text-xs text-ink-secondary leading-relaxed">
                    Gain leveraged exposure to variable yield rates without risking principal capital.
                  </p>
                </div>
                <div className="mt-4 pt-4 border-t border-glass-rim flex items-center justify-between text-xs text-ink-muted">
                  <span>Capital Exposure</span>
                  <span className="text-accent font-semibold">Variable</span>
                </div>
              </div>
            </InteractiveLiftCard>
          </DirectionalReveal>

          {/* Pillar 3 */}
          <DirectionalReveal from="right" delay={1.48} distance={34} duration={0.74} className="h-full md:col-span-3">
            <InteractiveLiftCard className="h-full">
              <div className="glass-card border-gradient rounded-2xl p-6 flex flex-col justify-between transition-colors hover:border-hairline-strong shadow-glass h-full">
                <div>
                  <h3 className="text-lg font-semibold text-ink">
                    Log-Normal AMM
                  </h3>
                  <p className="mt-2 text-xs text-ink-secondary leading-relaxed">
                    Trade yield tokens with asymptotic convergence to zero at maturity.
                  </p>
                </div>
                <div className="mt-4 pt-4 border-t border-glass-rim flex items-center justify-between text-xs text-ink-muted">
                  <span>Expiry Loss</span>
                  <span className="tabular-mono font-mono text-ink font-semibold">0.00%</span>
                </div>
              </div>
            </InteractiveLiftCard>
          </DirectionalReveal>
        </div>
      </div>

      {/* 5. Minimalist Frosted Glass Footer Strip */}
      <footer className="mt-14 sm:mt-20 w-full max-w-5xl pt-6 border-t border-glass-rim flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-ink-muted">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-ink">NivoraFi</span>
          <span>·</span>
          <span>Stellar Soroban Testnet</span>
        </div>
        <nav aria-label="Footer navigation" className="flex flex-wrap items-center justify-center gap-5">
          <Link href="/terms" className="hover:text-ink transition-colors">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-ink transition-colors">
            Privacy
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
        </nav>
      </footer>
    </div>
  );
}
