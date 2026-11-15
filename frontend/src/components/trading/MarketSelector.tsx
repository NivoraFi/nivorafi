"use client";

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock,
  Layers,
  Search,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { useMarket } from "@/context/MarketContext";
import {
  AssetCode,
  MarketDefinition,
  MarketStatus,
  deriveMarketStatus,
  filterMarkets,
  getTopYieldMarket,
} from "@/lib/markets";

function useSafeRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

interface MarketSelectorProps {
  compact?: boolean;
}

export function MarketSelector({ compact = false }: MarketSelectorProps) {
  const router = useSafeRouter();
  const {
    markets,
    activeMarket,
    selectMarket,
    marketMetrics,
    loadingSnapshot,
  } = useMarket();

  const [isOpen, setIsOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<string>("ALL");
  const [selectedStatus, setSelectedStatus] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Close modal on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const filteredMarkets = useMemo(() => {
    return filterMarkets(
      markets,
      selectedAsset,
      selectedStatus,
      searchQuery
    );
  }, [markets, selectedAsset, selectedStatus, searchQuery]);

  const topYieldMarket = useMemo(() => {
    return getTopYieldMarket(markets, marketMetrics);
  }, [markets, marketMetrics]);

  const activeMetric = marketMetrics[activeMarket.id];
  const activeApy =
    activeMetric && typeof activeMetric.impliedApyPct === "number"
      ? `${activeMetric.impliedApyPct.toFixed(2)}%`
      : loadingSnapshot
      ? "..."
      : "--";
  const activeDaysLeft = activeMetric
    ? activeMetric.isMatured
      ? "Matured"
      : typeof activeMetric.daysToMaturity === "number"
      ? `${activeMetric.daysToMaturity.toFixed(1)}d`
      : "--"
    : "--";

  const handleSelect = (marketId: string) => {
    selectMarket(marketId);
    setIsOpen(false);

    let nextHref = `/trade/${marketId}`;
    if (typeof window !== "undefined") {
      try {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get("tab");
        if (tab) {
          nextHref = `/trade/${marketId}?tab=${encodeURIComponent(tab)}`;
        }
      } catch {
        // ignore URL parse error
      }
    }

    if (router) {
      try {
        router.push(nextHref);
        return;
      } catch {}
    }
    if (typeof window !== "undefined") {
      if (
        window.location.pathname.startsWith("/trade/") ||
        window.location.pathname.startsWith("/markets/")
      ) {
        window.location.href = nextHref;
      }
    }
  };

  return (
    <>
      {/* Compact Header Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="group inline-flex items-center gap-2 rounded-xl border border-hairline bg-surface/80 px-2.5 py-1.5 text-xs transition-colors hover:border-accent hover:bg-surface-hover active:scale-[0.98] disabled:opacity-50 cursor-pointer"
        aria-label="Open market selector"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-1.5">
          <TokenIcon symbol={activeMarket.asset.code} size="sm" />
          <span className="inline-flex items-center justify-center rounded-md bg-accent/20 px-1.5 py-0.5 text-xs font-bold text-accent">
            {activeMarket.asset.code}
          </span>
          <span className="font-semibold text-ink">
            {activeMarket.tenor}
          </span>
        </div>

        {/* Status Indicator */}
        <div className="flex items-center gap-1">
          {activeMetric?.isMatured ? (
            <span className="rounded bg-warn/20 px-1.5 py-0.5 text-xs font-semibold text-warn">
              Matured
            </span>
          ) : (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-positive opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-positive" />
            </span>
          )}
        </div>

        {/* Active APY Pill */}
        <div className="tabular-mono font-bold text-accent pl-1 border-l border-hairline">
          {activeApy}
        </div>

        <ChevronDown className="h-3.5 w-3.5 text-ink-muted transition group-hover:text-accent" />
      </button>

      {/* Comparative Modal Dialog */}
      {isOpen &&
        (() => {
          const dialogNode = (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="market-selector-title"
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-canvas/80 backdrop-blur-md animate-fade-in"
              onClick={(e) => {
                if (e.target === e.currentTarget) setIsOpen(false);
              }}
            >
          <div className="glass-panel-elevated double-bezel max-w-2xl w-full rounded-2xl border border-glass-rim shadow-glass-elevated overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-glass-rim px-5 py-4 bg-surface-muted/40 backdrop-blur-md">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-accent" />
                <h2
                  id="market-selector-title"
                  className="text-sm font-semibold tracking-tight text-ink"
                >
                  Select Yield Market
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline text-xs text-ink-muted">
                  [<kbd className="font-mono">Esc</kbd> to close]
                </span>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-lg p-1 text-ink-muted hover:text-ink hover:bg-surface-hover transition cursor-pointer"
                  aria-label="Close dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Filter and Search Bar */}
            <div className="p-4 border-b border-glass-rim bg-surface/40 backdrop-blur-sm space-y-3">
              {/* Asset & Status Pills */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Asset Tabs */}
                <div className="flex items-center gap-1 rounded-xl bg-surface-muted/70 p-1 border border-glass-rim text-xs font-semibold backdrop-blur-sm">
                  {(["ALL", "USDC", "XLM"] as const).map((code) => {
                    const isSelected = selectedAsset === code;
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => setSelectedAsset(code)}
                        className={`rounded-lg px-2.5 py-1 transition ${
                          isSelected
                            ? "bg-accent text-accent-ink shadow-sm"
                            : "text-ink-secondary hover:text-ink hover:bg-surface-hover"
                        }`}
                      >
                        {code === "ALL" ? "All Assets" : code}
                      </button>
                    );
                  })}
                </div>

                {/* Status Tabs */}
                <div className="flex items-center gap-1 rounded-xl bg-surface-muted/70 p-1 border border-glass-rim text-xs font-semibold backdrop-blur-sm">
                  {(["ALL", "ACTIVE", "MATURED"] as const).map((status) => {
                    const isSelected = selectedStatus === status;
                    return (
                      <button
                        key={status}
                        type="button"
                        onClick={() => setSelectedStatus(status)}
                        className={`rounded-lg px-2.5 py-1 transition ${
                          isSelected
                            ? "bg-accent text-accent-ink shadow-sm"
                            : "text-ink-secondary hover:text-ink hover:bg-surface-hover"
                        }`}
                      >
                        {status === "ALL" ? "All" : status === "ACTIVE" ? "Active" : "Matured"}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Search Bar Input */}
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-ink-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by market symbol, tenor, or contract ID..."
                  className="w-full rounded-xl bg-surface/80 pl-9 pr-4 py-2 text-xs text-ink outline-none border border-glass-rim focus:border-accent transition"
                />
              </div>
            </div>

            {/* Comparative Market Cards List */}
            <div className="p-4 overflow-y-auto space-y-2.5 flex-1">
              {filteredMarkets.length === 0 ? (
                <div className="p-8 text-center text-xs text-ink-muted">
                  No matching yield markets found.
                </div>
              ) : (
                filteredMarkets.map((market) => {
                  const isSelected = market.id === activeMarket.id;
                  const metrics = marketMetrics[market.id];
                  const isTopYield = topYieldMarket?.id === market.id && !metrics?.isMatured;
                  const status = deriveMarketStatus(market.maturity);
                  const isMatured = status === "MATURED";

                  return (
                    <div
                      key={market.id}
                      onClick={() => handleSelect(market.id)}
                      className={`group relative rounded-xl p-3.5 border transition cursor-pointer ${
                        isSelected
                          ? "border-accent bg-accent-soft/20 shadow-sm"
                          : "border-hairline bg-surface/60 hover:border-accent/40 hover:bg-surface-hover"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-2">
                        {/* Left: Asset Code & Symbol */}
                        <div className="flex items-center gap-2">
                          <TokenIcon symbol={market.asset.code} size="sm" />
                          <span className="inline-flex items-center justify-center rounded-md bg-accent/20 px-2 py-0.5 text-xs font-bold text-accent">
                            {market.asset.code}
                          </span>
                          <Link
                            href={`/trade/${market.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleSelect(market.id);
                            }}
                            className="text-xs font-bold text-ink group-hover:text-accent transition-colors"
                          >
                            {market.name}
                          </Link>
                          <span className="rounded bg-surface-muted border border-hairline px-1.5 py-0.5 text-xs font-mono text-ink-secondary">
                            {market.tenor}
                          </span>
                          {isTopYield && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-positive-soft border border-positive/30 px-2 py-0.5 text-xs font-semibold text-positive">
                              <Sparkles className="h-3 w-3" />
                              <span>Top Yield</span>
                            </span>
                          )}
                        </div>

                        {/* Right: Status Pill & Check */}
                        <div className="flex items-center gap-2">
                          {isMatured ? (
                            <span className="rounded bg-warn/20 border border-warn/30 px-2 py-0.5 text-xs font-semibold text-warn">
                              Matured
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded bg-positive-soft border border-positive/30 px-2 py-0.5 text-xs font-semibold text-positive">
                              <span className="h-1.5 w-1.5 rounded-full bg-positive" />
                              <span>Active</span>
                            </span>
                          )}

                          {isSelected && (
                            <span className="rounded-full bg-accent text-accent-ink p-1">
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Metrics Comparative Row */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-hairline/60 text-xs">
                        <div>
                          <div className="text-ink-muted text-xs">Maturity Date</div>
                          <div className="tabular-mono font-medium text-ink truncate">
                            {(market.maturityIso || "").slice(0, 10)}
                          </div>
                        </div>

                        <div>
                          <div className="text-ink-muted text-xs">Days Remaining</div>
                          <div className="tabular-mono font-medium text-ink flex items-center gap-1">
                            <Clock className="h-3 w-3 text-ink-muted" />
                            <span>
                              {metrics
                                ? metrics.isMatured
                                  ? "0.0d"
                                  : `${metrics.daysToMaturity.toFixed(1)}d`
                                : "--"}
                            </span>
                          </div>
                        </div>

                        <div>
                          <div className="text-ink-muted text-xs">Implied APY</div>
                          <div className="tabular-mono font-bold text-accent flex items-center gap-1">
                            <TrendingUp className="h-3 w-3 text-accent" />
                            <span>
                              {metrics
                                ? `${metrics.impliedApyPct.toFixed(2)}%`
                                : "--"}
                            </span>
                          </div>
                        </div>

                        <div>
                          <div className="text-ink-muted text-xs">PT Price (in SY)</div>
                          <div className="tabular-mono font-medium text-ink">
                            {metrics ? `${metrics.ptPriceInSy.toFixed(4)} SY` : "--"}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between border-t border-hairline px-5 py-3 bg-surface-muted/30 text-xs text-ink-muted">
              <span>All pools settle 1:1 post-maturity on Stellar Soroban.</span>
              <span>
                Showing <span className="tabular-mono font-mono">{filteredMarkets.length}</span> verified markets
              </span>
            </div>
          </div>
        </div>
          );
          return typeof document !== "undefined" && document.body
            ? createPortal(dialogNode, document.body)
            : dialogNode;
        })()}
    </>
  );
}
