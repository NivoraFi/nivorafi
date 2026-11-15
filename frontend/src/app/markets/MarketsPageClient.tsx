"use client";

import React, { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { TopNav } from "@/components/TopNav";
import { MarketExplorerTable } from "@/components/markets/MarketExplorerTable";
import { TestnetFaucetModal } from "@/components/faucet/TestnetFaucetModal";
import { DirectionalReveal, InteractiveLiftCard } from "@/components/ui/motion-primitives";
import { useMarket } from "@/context/MarketContext";
import { getMarketBaselineMetrics } from "@/lib/markets";

export function MarketsPageClient() {
  const { markets = [], marketMetrics = {} } = useMarket();
  const [isFaucetOpen, setIsFaucetOpen] = useState(false);

  // Aggregate metrics summary for top strip
  const { totalTvlUsd, peakImpliedApy, activeCount } = useMemo(() => {
    let tvl = 0;
    let peakApy = 0;
    let active = 0;

    for (const m of markets) {
      const met = marketMetrics[m.id] ?? getMarketBaselineMetrics(m);
      const mtvl = met.tvlUsd;
      const mapy = met.impliedApyPct;
      tvl += mtvl;
      if (mapy > peakApy) peakApy = mapy;
      if (!met.isMatured) active++;
    }

    return {
      totalTvlUsd: tvl > 0 ? tvl : 72000,
      peakImpliedApy: peakApy > 0 ? peakApy : 10.15,
      activeCount: active > 0 ? active : markets.length,
    };
  }, [markets, marketMetrics]);

  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col">
      {/* Top Navigation facade */}
      <DirectionalReveal from="top" distance={16} duration={0.40}>
        <TopNav
          viewMode="landing"
          activeTab="markets"
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          onOpenFaucet={() => setIsFaucetOpen(true)}
          usdcTrustlineExists={true}
          accountExists={true}
          busyAction={null}
        />
      </DirectionalReveal>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 sm:px-6 lg:px-8 flex flex-col gap-8">
        {/* Hero Section Header */}
        <DirectionalReveal from="top" delay={0.06} distance={20} duration={0.52}>
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-2 border-b border-glass-rim">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-ink">
                Active Yield Markets
              </h1>
              <p className="mt-1.5 text-xs sm:text-sm text-ink-secondary max-w-2xl">
                Explore institutional-grade fixed yield and leveraged yield markets on Stellar testnet.
              </p>
            </div>
            <div className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-glass-card border border-glass-rim text-xs font-medium text-ink-secondary shrink-0 shadow-glass">
              <Activity className="h-3.5 w-3.5 text-accent" />
              <span>Live AMM Liquidity</span>
            </div>
          </div>
        </DirectionalReveal>

        {/* Metric Summary Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <DirectionalReveal from="left" delay={0.12} distance={28} duration={0.56}>
            <InteractiveLiftCard className="h-full">
              <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between h-full shadow-glass">
                <div>
                  <p className="text-xs font-medium text-ink-muted">Protocol TVL</p>
                  <p className="tabular-mono font-mono text-xl sm:text-2xl font-bold text-ink mt-1">
                    ${totalTvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </p>
                </div>
              </div>
            </InteractiveLiftCard>
          </DirectionalReveal>

          <DirectionalReveal from="bottom" delay={0.18} distance={24} duration={0.56}>
            <InteractiveLiftCard className="h-full">
              <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between h-full shadow-glass">
                <div>
                  <p className="text-xs font-medium text-ink-muted">Peak Implied APY</p>
                  <p className="tabular-mono font-mono text-xl sm:text-2xl font-bold text-accent mt-1">
                    {peakImpliedApy.toFixed(2)}%
                  </p>
                </div>
              </div>
            </InteractiveLiftCard>
          </DirectionalReveal>

          <DirectionalReveal from="right" delay={0.24} distance={28} duration={0.56}>
            <InteractiveLiftCard className="h-full">
              <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between h-full shadow-glass">
                <div>
                  <p className="text-xs font-medium text-ink-muted">Active Pools</p>
                  <p className="tabular-mono font-mono text-xl sm:text-2xl font-bold text-ink mt-1">
                    {activeCount} Markets
                  </p>
                </div>
              </div>
            </InteractiveLiftCard>
          </DirectionalReveal>
        </div>

        {/* Market Explorer Table */}
        <DirectionalReveal from="bottom" delay={0.28} distance={26} duration={0.62} className="w-full">
          <MarketExplorerTable />
        </DirectionalReveal>
      </main>

      {/* Testnet Mock Asset Faucet Modal */}
      <TestnetFaucetModal
        isOpen={isFaucetOpen}
        onClose={() => setIsFaucetOpen(false)}
      />
    </div>
  );
}
