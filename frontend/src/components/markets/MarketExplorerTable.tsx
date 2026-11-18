"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Clock,
  RotateCcw,
  Search,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { useMarket } from "@/context/MarketContext";
import {
  AssetCategory,
  deriveMarketStatus,
  filterAndSortMarkets,
  getMarketCategory,
  getMarketUnderlyingApy,
  MarketDefinition,
  MarketSortKey,
  PRESET_MARKETS,
  SortDirection,
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

function useSafeRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

export interface MarketExplorerTableProps {
  onSelectMarket?: (marketId: string) => void;
  className?: string;
}

export function MarketExplorerTable({
  onSelectMarket,
  className = "",
}: MarketExplorerTableProps) {
  const router = useSafeRouter();
  const {
    markets = PRESET_MARKETS,
    marketMetrics = {},
    selectMarket = () => {},
  } = useMarket();

  // Filter state
  const [categoryFilter, setCategoryFilter] = useState<AssetCategory>("All");
  const [searchQuery, setSearchQuery] = useState("");

  // Sort state (4 sortable columns: impliedApy, tvl, maturity, underlyingApy)
  const [sortKey, setSortKey] = useState<MarketSortKey | null>("impliedApy");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const nowSeconds = Math.floor(Date.now() / 1000);

  const handleSortToggle = (key: MarketSortKey) => {
    if (sortKey === key) {
      if (sortDirection === "desc") {
        setSortDirection("asc");
      } else {
        setSortKey(null);
        setSortDirection("desc");
      }
    } else {
      setSortKey(key);
      setSortDirection("desc");
    }
  };

  const filteredAndSortedMarkets = useMemo(() => {
    return filterAndSortMarkets(
      markets,
      categoryFilter,
      searchQuery,
      sortKey,
      sortDirection,
      marketMetrics,
      nowSeconds
    );
  }, [markets, categoryFilter, searchQuery, sortKey, sortDirection, marketMetrics, nowSeconds]);

  const handleRowClick = (marketId: string) => {
    selectMarket(marketId);
    onSelectMarket?.(marketId);
    if (router) {
      try {
        router.push(`/trade/${marketId}`);
        return;
      } catch {}
    }
    if (typeof window !== "undefined") {
      window.location.href = `/trade/${marketId}`;
    }
  };

  const handleResetFilters = () => {
    setCategoryFilter("All");
    setSearchQuery("");
    setSortKey("impliedApy");
    setSortDirection("desc");
  };

  const renderSortIndicator = (key: MarketSortKey) => {
    if (sortKey !== key) {
      return <ArrowUpDown className="h-3 w-3 text-ink-muted opacity-50" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUp className="h-3 w-3 text-accent" />
    ) : (
      <ArrowDown className="h-3 w-3 text-accent" />
    );
  };

  return (
    <div className={`w-full flex flex-col gap-4 ${className}`}>
      {/* Filter Bar: Category Chips & Deep Search Input */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Category Filter Chips */}
        <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-glass-card border border-glass-rim shadow-glass">
          {(["All", "Stables", "Crypto", "Liquid Staking"] as AssetCategory[]).map(
            (cat) => {
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
            }
          )}
        </div>

        {/* Deep Search Box */}
        <div className="relative min-w-[240px] sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search symbol, tenor, address..."
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

      {/* High-Density 8-Column Market Explorer Table */}
      <div className="w-full overflow-x-auto rounded-2xl glass-panel shadow-glass">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-glass-rim bg-glass-interactive text-xs font-medium text-ink-secondary select-none">
              {/* Column 1: Market Asset & Tenor */}
              <th className="py-3 px-4">Market Asset & Tenor</th>

              {/* Column 2: Maturity Date & Countdown (Sortable) */}
              <th
                onClick={() => handleSortToggle("maturity")}
                className="py-3 px-4 cursor-pointer hover:text-ink transition"
                title="Sort by Maturity Date"
              >
                <div className="flex items-center gap-1.5">
                  <span>Maturity & Countdown</span>
                  {renderSortIndicator("maturity")}
                </div>
              </th>

              {/* Column 3: Underlying APY (Sortable) */}
              <th
                onClick={() => handleSortToggle("underlyingApy")}
                className="py-3 px-4 cursor-pointer hover:text-ink transition"
                title="Sort by Underlying Variable APY"
              >
                <div className="flex items-center gap-1.5">
                  <span>Underlying APY</span>
                  {renderSortIndicator("underlyingApy")}
                </div>
              </th>

              {/* Column 4: Implied APY (Sortable) */}
              <th
                onClick={() => handleSortToggle("impliedApy")}
                className="py-3 px-4 cursor-pointer hover:text-ink transition"
                title="Sort by Implied Fixed Rate"
              >
                <div className="flex items-center gap-1.5">
                  <span>Implied APY</span>
                  {renderSortIndicator("impliedApy")}
                </div>
              </th>

              {/* Column 5: Fixed APY (PT) */}
              <th className="py-3 px-4">Fixed APY (PT)</th>

              {/* Column 6: Long Yield (YT) Leverage */}
              <th className="py-3 px-4">Long Yield (YT)</th>

              {/* Column 7: Liquidity / TVL (Sortable) */}
              <th
                onClick={() => handleSortToggle("tvl")}
                className="py-3 px-4 cursor-pointer hover:text-ink transition"
                title="Sort by Protocol TVL"
              >
                <div className="flex items-center gap-1.5">
                  <span>Liquidity / TVL</span>
                  {renderSortIndicator("tvl")}
                </div>
              </th>

              {/* Column 8: Action ("Trade") */}
              <th className="py-3 px-4 text-right">Action</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-hairline">
            {filteredAndSortedMarkets.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 px-4 text-center">
                  <div className="flex flex-col items-center justify-center max-w-sm mx-auto text-center gap-2.5">
                    <div className="rounded-full bg-surface-muted p-3 border border-hairline">
                      <Search className="h-5 w-5 text-ink-muted" />
                    </div>
                    <p className="text-sm font-semibold text-ink">
                      No yield markets found.
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
              filteredAndSortedMarkets.map((m) => {
                const status = deriveMarketStatus(m.maturity, nowSeconds);
                const isMatured = status === "MATURED";
                const metrics = marketMetrics[m.id];
                const isHydrated = Boolean(metrics && !metrics.isLoading);
                const isSlender = m.sySymbol === "sy-sUSDC";

                const impliedApy = isMatured ? 0 : (metrics?.impliedApyPct ?? 0);
                const underlyingApy = getMarketUnderlyingApy(m);
                const blendRate =
                  isHydrated && typeof metrics?.blendRate === "number" && metrics.blendRate > 0
                    ? metrics.blendRate
                    : null;
                const tvlUsd = metrics?.tvlUsd ?? 0;
                const ptReserve = metrics?.ptReserve ? Number(metrics.ptReserve) / 1e7 : 0;
                const syReserve = metrics?.syReserve ? Number(metrics.syReserve) / 1e7 : 0;

                // Yield math & prices (honest zero/null when unhydrated)
                const ptPrice = isMatured
                  ? 1.0
                  : isHydrated && typeof metrics?.ptPriceInSy === "number" && metrics.ptPriceInSy > 0
                  ? metrics.ptPriceInSy
                  : null;
                const ytPrice = ptPrice !== null ? Math.max(0, 1 - ptPrice) : null;
                const ytLeverage =
                  !isMatured && ytPrice !== null && ytPrice > 0
                    ? Math.round(1 / ytPrice)
                    : null;

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
                    className="hover:bg-glass-interactive border-b border-glass-rim/40 last:border-b-0 transition-colors group cursor-pointer"
                  >
                    {/* Column 1: Market Asset & Tenor */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex items-center gap-3">
                        <div className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-glass-card border border-glass-rim font-bold text-[11px] text-ink shrink-0 shadow-glass">
                          <TokenIcon symbol={m.asset.code} size="md" showSymbolSrOnly />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/trade/${m.id}`}
                              onClick={() => {
                                selectMarket(m.id);
                                onSelectMarket?.(m.id);
                              }}
                              className="font-semibold text-sm text-ink group-hover:text-accent transition-colors"
                            >
                              {m.name}
                            </Link>
                            <span className="rounded-full bg-glass-card border border-glass-rim px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">
                              {m.tenor}
                            </span>
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                isMatured ? "bg-ink-muted" : "bg-positive animate-pulse motion-reduce:animate-none"
                              }`}
                              title={isMatured ? "Matured" : "Active Pool"}
                            />
                          </div>
                          <div className="text-[11px] text-ink-secondary flex items-center gap-1.5 mt-0.5">
                            <span className="tabular-mono font-mono">{m.ptSymbol}</span>
                            <span className="text-hairline-strong">/</span>
                            <span className="tabular-mono font-mono">{m.ytSymbol}</span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Column 2: Maturity Date & Countdown */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex flex-col gap-0.5">
                        <span className="tabular-mono font-mono text-xs font-medium text-ink">
                          {maturityDate}
                        </span>
                        <div className="flex items-center gap-1 text-[11px] text-ink-secondary">
                          <Clock className="h-3 w-3 text-ink-muted" />
                          <span className="tabular-mono font-mono">
                            {isMatured ? "Matured" : `${daysRemaining}d remaining`}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Column 3: Underlying APY (Blend / Slender) */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-ink">
                          <span className="tabular-mono font-mono">{underlyingApy.toFixed(2)}%</span> Variable
                        </span>
                        <span className="text-xs text-ink-muted inline-flex items-center gap-1">
                          <TokenIcon symbol={isSlender ? m.asset.code : "BLEND"} size="xs" />
                          <span>{isSlender ? "Slender" : "bRate"}: <span className="tabular-mono font-mono">{blendRate !== null ? blendRate.toFixed(4) : "--"}</span></span>
                        </span>
                      </div>
                    </td>

                    {/* Column 4: Implied APY */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex flex-col gap-0.5">
                        <span className="tabular-mono font-mono font-bold text-sm text-accent">
                          {isHydrated || isMatured ? `${impliedApy.toFixed(2)}%` : "--"}
                        </span>
                        <span className="text-[11px] text-ink-muted">
                          AMM Rate
                        </span>
                      </div>
                    </td>

                    {/* Column 5: Fixed APY (PT) */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex flex-col gap-1 items-start">
                        <span className="inline-flex items-center gap-1 rounded-full bg-positive-soft border border-positive/30 px-2.5 py-0.5 text-xs font-semibold text-positive">
                          <TrendingUp className="h-3 w-3" />
                          <span>{isHydrated || isMatured ? <>+<span className="tabular-mono font-mono">{impliedApy.toFixed(2)}%</span> Fixed</> : <>-- Fixed</>}</span>
                        </span>
                        <span className="text-[11px] text-ink-muted">
                          PT: <span className="tabular-mono font-mono">{ptPrice !== null ? ptPrice.toFixed(4) : "--"}</span> SY
                        </span>
                      </div>
                    </td>

                    {/* Column 6: Long Yield (YT) Leverage */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex flex-col gap-1 items-start">
                        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft border border-accent/30 px-2.5 py-0.5 text-xs font-semibold text-accent">
                          <Sparkles className="h-3 w-3" />
                          <span>{ytLeverage !== null ? <>~<span className="tabular-mono font-mono">{ytLeverage}</span>x Exposure</> : <>-- Exposure</>}</span>
                        </span>
                        <span className="text-[11px] text-ink-muted">
                          YT: <span className="tabular-mono font-mono">{ytPrice !== null ? ytPrice.toFixed(4) : "--"}</span> SY
                        </span>
                      </div>
                    </td>

                    {/* Column 7: Liquidity / TVL */}
                    <td className="py-4 px-4 align-middle">
                      <div className="flex flex-col gap-0.5">
                        <span className="tabular-mono font-mono font-semibold text-xs text-ink">
                          {formatUsdCompact(tvlUsd)}
                        </span>
                        <span className="text-[11px] text-ink-muted">
                          PT: <span className="tabular-mono font-mono">{formatReserveAmount(ptReserve)}</span> | SY: <span className="tabular-mono font-mono">{formatReserveAmount(syReserve)}</span>
                        </span>
                      </div>
                    </td>

                    {/* Column 8: Action ("Trade") */}
                    <td className="py-4 px-4 align-middle text-right">
                      <Link
                        href={`/trade/${m.id}`}
                        onClick={() => {
                          selectMarket(m.id);
                          onSelectMarket?.(m.id);
                        }}
                        className="btn-monochrome inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors group-hover:bg-accent group-hover:text-accent-ink cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none"
                      >
                        <span>Trade</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
