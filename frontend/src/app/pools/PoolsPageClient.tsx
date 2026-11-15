"use client";

import React, { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  RotateCcw,
  Search,
  TrendingUp,
} from "lucide-react";
import { TopNav } from "@/components/TopNav";
import { TestnetFaucetModal } from "@/components/faucet/TestnetFaucetModal";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  DirectionalReveal,
  InteractiveLiftCard,
  PlanetStage,
} from "@/components/ui/motion-primitives";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { useMarket } from "@/context/MarketContext";
import {
  AssetCategory,
  deriveMarketStatus,
  getMarketBaselineMetrics,
  getMarketCategory,
  getMarketSwapFeeApy,
  getMarketUnderlyingApy,
  MarketDefinition,
  PRESET_MARKETS,
} from "@/lib/markets";

function formatReserveAmount(value: number): string {
  if (value > 0 && value < 100) {
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return Math.round(value).toLocaleString("en-US");
}

function formatUsdCompact(value: number): string {
  if (value > 0 && value < 100) {
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

// Dynamically import Three.js Celestial Sphere with SSR disabled
const CelestialSphere = dynamic(() => import("@/components/CelestialSphere"), {
  ssr: false,
});

function useSafeRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

export function PoolsPageClient() {
  const router = useSafeRouter();
  const { markets = PRESET_MARKETS, marketMetrics = {}, selectMarket = () => {} } = useMarket();
  const [isFaucetOpen, setIsFaucetOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<AssetCategory>("All");
  const [searchQuery, setSearchQuery] = useState("");

  const nowSeconds = Math.floor(Date.now() / 1000);

  // Aggregate metrics summary for the 3-Card KPI Strip
  const { totalTvlUsd, peakLpApy, activeCount } = useMemo(() => {
    let tvl = 0;
    let peakApy = 0;
    let active = 0;

    for (const m of markets) {
      const met = {
        ...getMarketBaselineMetrics(m, nowSeconds),
        ...marketMetrics[m.id],
      };
      tvl += met.tvlUsd;

      const isMatured = deriveMarketStatus(m.maturity, nowSeconds) === "MATURED";
      if (!isMatured) {
        active++;
        const underlyingApy = getMarketUnderlyingApy(m);
        const feeApy = getMarketSwapFeeApy(m, false);
        const impliedApy = met.impliedApyPct;
        const lpApy = underlyingApy + feeApy + impliedApy * 0.5;
        if (lpApy > peakApy) peakApy = lpApy;
      }
    }

    return {
      totalTvlUsd: tvl > 0 ? tvl : 72000,
      peakLpApy: peakApy > 0 ? peakApy : 11.73,
      activeCount: active > 0 ? active : markets.length,
    };
  }, [markets, marketMetrics, nowSeconds]);

  // Filtered pool list based on category tabs and deep search
  const filteredMarkets = useMemo(() => {
    const norm = searchQuery.toLowerCase().trim();
    return markets.filter((m) => {
      if (categoryFilter !== "All") {
        const cat = getMarketCategory(m);
        if (cat !== categoryFilter) return false;
      }
      if (norm) {
        const matchName = m.name.toLowerCase().includes(norm);
        const matchPt = m.ptSymbol.toLowerCase().includes(norm);
        const matchSy = m.sySymbol.toLowerCase().includes(norm);
        const matchAsset = m.asset.code.toLowerCase().includes(norm);
        const matchTenor = m.tenor.toLowerCase().includes(norm);
        const matchId = m.id.toLowerCase().includes(norm);
        const matchPool = m.contracts.poolId?.toLowerCase().includes(norm);
        if (
          !matchName &&
          !matchPt &&
          !matchSy &&
          !matchAsset &&
          !matchTenor &&
          !matchId &&
          !matchPool
        ) {
          return false;
        }
      }
      return true;
    });
  }, [markets, categoryFilter, searchQuery]);

  const handleRowClick = (marketId: string) => {
    selectMarket(marketId);
    const dest = `/trade/${marketId}?tab=liquidity`;
    if (router) {
      try {
        router.push(dest);
        return;
      } catch {}
    }
    if (typeof window !== "undefined") {
      window.location.href = dest;
    }
  };

  const handleResetFilters = () => {
    setCategoryFilter("All");
    setSearchQuery("");
  };

  return (
    <div className="relative min-h-screen bg-canvas text-ink flex flex-col justify-between overflow-x-clip selection:bg-accent selection:text-accent-ink">
      {/* 3D Celestial Background Canvas */}
      <PlanetStage dimmed={true} className="fixed inset-0 pointer-events-none z-0">
        <ErrorBoundary
          fallback={<div className="fixed inset-0 pointer-events-none bg-canvas" />}
          componentName="CelestialSphere"
        >
          <CelestialSphere dimmed={true} />
        </ErrorBoundary>
      </PlanetStage>

      <div className="relative z-10 w-full flex-1 flex flex-col">
        {/* Top Navigation */}
        <DirectionalReveal from="top" distance={16} duration={0.40}>
          <TopNav
            viewMode="trade"
            activeTab="pools"
            onToggleView={() => {}}
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
                  Active Liquidity Pools
                </h1>
                <p className="mt-1.5 text-xs sm:text-sm text-ink-secondary max-w-2xl">
                  Supply principal and standardized yield liquidity to earn swap fees alongside variable protocol yield.
                </p>
              </div>
            </div>
          </DirectionalReveal>

          {/* 3-Card KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <DirectionalReveal from="left" delay={0.12} distance={28} duration={0.56}>
              <InteractiveLiftCard className="h-full">
                <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between h-full shadow-glass">
                  <div>
                    <p className="text-xs font-medium text-ink-muted">Total Pool Liquidity</p>
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
                    <p className="text-xs font-medium text-ink-muted">Peak LP APY</p>
                    <p className="tabular-mono font-mono text-xl sm:text-2xl font-bold text-positive mt-1">
                      {peakLpApy.toFixed(2)}%
                    </p>
                  </div>
                </div>
              </InteractiveLiftCard>
            </DirectionalReveal>

            <DirectionalReveal from="right" delay={0.24} distance={28} duration={0.56}>
              <InteractiveLiftCard className="h-full">
                <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between h-full shadow-glass">
                  <div>
                    <p className="text-xs font-medium text-ink-muted">AMM Swap Fee Tier</p>
                    <p className="tabular-mono font-mono text-xl sm:text-2xl font-bold text-ink mt-1">
                      0.10% - 0.30%
                    </p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      <span className="tabular-mono font-mono">{activeCount}</span> Active Pools
                    </p>
                  </div>
                </div>
              </InteractiveLiftCard>
            </DirectionalReveal>
          </div>

          {/* Filter Bar & High-Density Liquidity Pools Table */}
          <DirectionalReveal from="bottom" delay={0.28} distance={26} duration={0.62} className="w-full">
            <div className="w-full flex flex-col gap-4">
              {/* Category Filter Chips & Search Bar */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-glass-card border border-glass-rim shadow-glass">
                  {(["All", "Stables", "Crypto"] as AssetCategory[]).map((cat) => {
                    const active = categoryFilter === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategoryFilter(cat)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none disabled:opacity-50 ${
                          active
                            ? "bg-glass-elevated text-ink shadow-sm border border-glass-rim"
                            : "text-ink-secondary hover:text-ink hover:bg-glass-interactive"
                        }`}
                      >
                        {cat}
                      </button>
                    );
                  })}
                </div>

                <div className="relative min-w-[240px] sm:w-72">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-muted" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search pool, asset, tenor..."
                    className="w-full rounded-xl border border-glass-rim bg-glass-card px-3 py-2 pl-9 text-xs text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none transition-colors font-sans"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink text-xs cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none disabled:opacity-50"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Table Container */}
              <div className="w-full overflow-x-auto rounded-2xl glass-panel shadow-glass">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-glass-rim bg-glass-interactive text-xs font-medium text-ink-secondary select-none">
                      <th className="py-3 px-4">Pool Pair</th>
                      <th className="py-3 px-4">Maturity</th>
                      <th className="py-3 px-4">Pool Reserves &amp; Ratio</th>
                      <th className="py-3 px-4">Total TVL</th>
                      <th className="py-3 px-4">Swap Fee APY</th>
                      <th className="py-3 px-4">Total LP APY</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-glass-rim/40">
                    {filteredMarkets.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-12 px-4 text-center">
                          <div className="flex flex-col items-center justify-center max-w-sm mx-auto text-center gap-2.5">
                            <div className="rounded-full bg-glass-card p-3 border border-glass-rim shadow-glass">
                              <Search className="h-5 w-5 text-ink-muted" />
                            </div>
                            <p className="text-sm font-semibold text-ink">
                              No liquidity pools found.
                            </p>
                            <p className="text-xs text-ink-secondary">
                              Try clearing search filters or choosing a different asset category.
                            </p>
                            <button
                              type="button"
                              onClick={handleResetFilters}
                              className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-glass-rim bg-glass-card px-3 py-1.5 text-xs font-semibold text-ink hover:bg-glass-interactive transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none disabled:opacity-50"
                            >
                              <RotateCcw className="h-3 w-3 text-ink-secondary" />
                              <span>Reset Filters</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredMarkets.map((m) => {
                        const metrics = {
                          ...getMarketBaselineMetrics(m, nowSeconds),
                          ...marketMetrics[m.id],
                        };
                        const status = deriveMarketStatus(m.maturity, nowSeconds);
                        const isMatured = status === "MATURED";

                        const underlyingApy = getMarketUnderlyingApy(m);
                        const feeApy = getMarketSwapFeeApy(m, isMatured);
                        const impliedApy = isMatured ? 0 : metrics.impliedApyPct;
                        const totalLpApy = isMatured ? 0 : Math.round((underlyingApy + feeApy + impliedApy * 0.5) * 100) / 100;

                        const tvlUsd = metrics.tvlUsd;
                        const ptReserve =
                          typeof metrics.ptReserve === "bigint"
                            ? Number(metrics.ptReserve) / 1e7
                            : Number(metrics.ptReserve);
                        const syReserve =
                          typeof metrics.syReserve === "bigint"
                            ? Number(metrics.syReserve) / 1e7
                            : Number(metrics.syReserve);

                        const totalReserves = ptReserve + syReserve;
                        const ptSharePct = totalReserves > 0 ? Math.round((ptReserve / totalReserves) * 100) : 67;
                        const sySharePct = 100 - ptSharePct;

                        const maturityDate = new Date(m.maturity * 1000).toISOString().split("T")[0];
                        const daysRemaining = Math.max(0, Math.ceil((m.maturity - nowSeconds) / 86400));

                        return (
                          <tr
                            key={m.id}
                            onClick={(e) => {
                              const target = e.target as HTMLElement;
                              if (target.closest("a") || target.closest("button")) return;
                              handleRowClick(m.id);
                            }}
                            className="hover:bg-glass-interactive transition-colors group cursor-pointer"
                          >
                            {/* Column 1: Pool Pair */}
                            <td className="py-4 px-4 align-middle">
                              <div className="flex items-center gap-3">
                                <div className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-glass-card border border-glass-rim font-bold text-[11px] text-ink shrink-0 shadow-glass">
                                  <TokenIcon symbol={m.asset.code} size="md" showSymbolSrOnly />
                                </div>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <Link
                                      href={`/trade/${m.id}?tab=liquidity`}
                                      prefetch
                                      onClick={() => selectMarket(m.id)}
                                      className="font-semibold text-sm text-ink group-hover:text-accent transition-colors"
                                    >
                                      {`PT-${m.asset.code} / SY-${m.asset.code}`}
                                    </Link>
                                    <span className="rounded-full bg-glass-card border border-glass-rim px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">
                                      {m.tenor}
                                    </span>
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                        isMatured
                                          ? "bg-glass-card text-ink-muted border border-glass-rim"
                                          : "bg-positive-soft text-positive border border-positive/30"
                                      }`}
                                    >
                                      {isMatured ? "MATURED" : "ACTIVE"}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-ink-secondary flex items-center gap-1.5 mt-0.5">
                                    <span className="tabular-mono font-mono">{m.name}</span>
                                  </div>
                                </div>
                              </div>
                            </td>

                            {/* Column 2: Maturity */}
                            <td className="py-4 px-4 align-middle">
                              <div className="flex flex-col gap-0.5">
                                <span className="tabular-mono font-mono text-xs font-medium text-ink">
                                  {maturityDate}
                                </span>
                                <span className="tabular-mono font-mono text-[11px] text-ink-secondary">
                                  {isMatured ? "Expired" : `${daysRemaining}d left`}
                                </span>
                              </div>
                            </td>

                            {/* Column 3: Pool Reserves & Ratio */}
                            <td className="py-4 px-4 align-middle min-w-[200px]">
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between text-[11px] text-ink-secondary">
                                  <span className="tabular-mono font-mono">
                                    {`${formatReserveAmount(ptReserve)} PT (${ptSharePct}%)`}
                                  </span>
                                  <span className="tabular-mono font-mono">
                                    {`${formatReserveAmount(syReserve)} SY (${sySharePct}%)`}
                                  </span>
                                </div>
                                <div className="w-full h-1.5 rounded-full bg-surface-muted overflow-hidden flex">
                                  <div
                                    className="bg-positive h-full transition-opacity"
                                    style={{ width: `${ptSharePct}%` }}
                                    title={`PT Reserve: ${ptSharePct}%`}
                                  />
                                  <div
                                    className="bg-accent h-full transition-opacity"
                                    style={{ width: `${sySharePct}%` }}
                                    title={`SY Reserve: ${sySharePct}%`}
                                  />
                                </div>
                              </div>
                            </td>

                            {/* Column 4: Total TVL */}
                            <td className="py-4 px-4 align-middle">
                              <div className="flex flex-col gap-0.5">
                                <span className="tabular-mono font-mono font-semibold text-xs text-ink">
                                  {formatUsdCompact(tvlUsd)}
                                </span>
                                <span className="text-[11px] text-ink-muted">
                                  Dual-sided AMM
                                </span>
                              </div>
                            </td>

                            {/* Column 5: Swap Fee APY */}
                            <td className="py-4 px-4 align-middle">
                              <div className="flex flex-col gap-0.5">
                                <span className="tabular-mono font-mono font-bold text-xs text-ink">
                                  {`${feeApy.toFixed(2)}%`}
                                </span>
                                <span className="text-[11px] text-ink-muted">
                                  Dynamic fee
                                </span>
                              </div>
                            </td>

                            {/* Column 6: Total LP APY */}
                            <td className="py-4 px-4 align-middle">
                              <div className="flex flex-col gap-1 items-start">
                                <span className="tabular-mono font-mono pendle-pt-pill inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold">
                                  <TrendingUp className="h-3 w-3" />
                                  <span>{`${totalLpApy.toFixed(2)}% LP APY`}</span>
                                </span>
                                <span className="text-[11px] text-ink-muted">
                                  Fixed PT: <span className="tabular-mono font-mono">{impliedApy.toFixed(2)}%</span>
                                </span>
                              </div>
                            </td>

                            {/* Column 7: Action */}
                            <td className="py-4 px-4 align-middle text-right">
                              <div className="inline-flex items-center justify-end gap-2">
                                <Link
                                  href={`/trade/${m.id}`}
                                  prefetch
                                  onClick={() => selectMarket(m.id)}
                                  className="btn-monochrome-secondary hidden sm:inline-flex items-center rounded-xl px-3 py-1.5 text-xs font-semibold whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none"
                                >
                                  <span>Trade</span>
                                </Link>
                                <Link
                                  href={`/trade/${m.id}?tab=liquidity`}
                                  prefetch
                                  onClick={() => selectMarket(m.id)}
                                  className="btn-monochrome inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors group-hover:bg-accent group-hover:text-accent-ink cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none"
                                >
                                  <span>{isMatured ? "Manage LP" : "Add Liquidity"}</span>
                                  <ArrowRight className="h-3.5 w-3.5" />
                                </Link>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </DirectionalReveal>
        </main>
      </div>

      {/* Testnet Mock Asset Faucet Modal */}
      <TestnetFaucetModal
        isOpen={isFaucetOpen}
        onClose={() => setIsFaucetOpen(false)}
      />
    </div>
  );
}
