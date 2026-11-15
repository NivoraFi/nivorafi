"use client";

import React, { useMemo, useRef, useState } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Clock, DollarSign, Layers, TrendingUp } from "lucide-react";
import { formatUnits } from "@/lib/math";
import { AnalyticsCardProps, AnalyticsTimeframe } from "./AnalyticsCard.types";
import { SvgSparkline } from "./SvgSparkline";

export function AnalyticsCard({
  analytics,
  daysToMaturity,
  loading = false,
  selectedTimeframe = "7D",
  onTimeframeChange,
  className = "",
}: AnalyticsCardProps) {
  const [internalTimeframe, setInternalTimeframe] = useState<AnalyticsTimeframe>(selectedTimeframe);
  const activeTf = onTimeframeChange ? selectedTimeframe : internalTimeframe;

  const lastValidAnalyticsRef = useRef(analytics);
  if (analytics) {
    lastValidAnalyticsRef.current = analytics;
  }
  const activeAnalytics = analytics ?? lastValidAnalyticsRef.current;
  const lastValidSparklineRef = useRef<{ timestamp: number; value: number }[]>([]);

  const handleTfSelect = (tf: AnalyticsTimeframe) => {
    if (onTimeframeChange) {
      onTimeframeChange(tf);
    } else {
      setInternalTimeframe(tf);
    }
  };

  // 1. Current Implied APY & Delta
  const apyText = activeAnalytics ? `${activeAnalytics.impliedApyPct.toFixed(2)}%` : "--";
  const apyDelta = activeAnalytics?.apyChange24hPct;
  const isPositiveDelta = (apyDelta ?? 0) >= 0;

  // 2. Financial Metrics Formatted
  const volume24h = activeAnalytics
    ? `$${Number(formatUnits(activeAnalytics.volume24hUsdc, 7, 2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "--";
  const totalTvl = activeAnalytics
    ? `$${Number(formatUnits(activeAnalytics.totalTvlUsdc, 7, 2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "--";
  const totalSwaps = activeAnalytics ? activeAnalytics.totalSwapsCount.toLocaleString() : "--";
  const daysLeftStr = daysToMaturity !== undefined ? `${daysToMaturity.toFixed(1)}d` : "--";

  // 3. Filtered Sparkline History based on timeframe (with cached fallback to prevent unmount/sync flash)
  const sparklineData = useMemo(() => {
    const hist = activeAnalytics?.apyHistory;
    if (!hist || hist.length === 0) {
      if (lastValidSparklineRef.current.length > 0) {
        return lastValidSparklineRef.current;
      }
      if (!activeAnalytics) return [];
      const now = Math.floor(Date.now() / 1000);
      const baseApy = activeAnalytics.impliedApyPct > 0 ? activeAnalytics.impliedApyPct : 5.42;
      const fallbackPts = Array.from({ length: 24 }, (_, i) => ({
        timestamp: now - (23 - i) * 3600,
        value: baseApy,
      }));
      lastValidSparklineRef.current = fallbackPts;
      return fallbackPts;
    }

    const now = Math.floor(Date.now() / 1000);
    let cutoff = 0;
    if (activeTf === "24H") cutoff = now - 86400;
    else if (activeTf === "7D") cutoff = now - 7 * 86400;
    else if (activeTf === "30D") cutoff = now - 30 * 86400;

    const filtered = cutoff > 0
      ? hist.filter((pt) => pt.timestamp >= cutoff)
      : hist;

    const dataToUse = filtered.length > 0 ? filtered : hist;

    const mapped = dataToUse.map((pt) => ({
      timestamp: pt.timestamp,
      value: pt.apyPct,
    }));
    if (mapped.length > 0) {
      lastValidSparklineRef.current = mapped;
    }
    return mapped;
  }, [activeAnalytics, activeTf]);

  const timeframes: AnalyticsTimeframe[] = ["24H", "7D", "30D", "ALL"];

  return (
    <div className={`glass-panel double-bezel rounded-2xl p-4 sm:p-5 shadow-glass-elevated ${className}`}>
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-glass-rim min-h-[57px]">
        <div className="flex items-center gap-2">
          <h2 className="text-xs sm:text-sm font-semibold tracking-tight text-ink">
            Market Analytics & APY History
          </h2>
        </div>

        {/* Timeframe Selector Pills */}
        <div className="flex items-center gap-1 rounded-xl bg-surface-muted/70 p-1 border border-glass-rim self-start sm:self-auto backdrop-blur-sm">
          {timeframes.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => handleTfSelect(tf)}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                activeTf === tf
                  ? "bg-accent text-accent-ink shadow-sm"
                  : "text-ink-secondary hover:text-ink hover:bg-surface-hover"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Primary KPI: Implied APY & Sparkline Container */}
      <div className="mt-4 glass-card double-bezel-recessed rounded-xl p-4 sm:p-5 border-glass-rim-subtle shadow-glass">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
              <TrendingUp className="h-3.5 w-3.5 text-accent" />
              <span>Implied Fixed APY</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="tabular-mono text-2xl sm:text-3xl font-extrabold text-ink">
                {loading && !activeAnalytics ? "..." : apyText}
              </span>
              {apyDelta !== undefined && (
                <span
                  className={`tabular-mono inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    isPositiveDelta
                      ? "bg-positive-soft text-positive border border-positive/30"
                      : "bg-danger-soft text-danger border border-danger/30"
                  }`}
                >
                  {isPositiveDelta ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                  {isPositiveDelta ? `+${apyDelta.toFixed(2)}%` : `${apyDelta.toFixed(2)}%`}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="tabular-mono inline-flex items-center gap-1 rounded-full border border-hairline bg-surface-muted px-2.5 py-1 text-xs text-ink-secondary">
              <Clock className="h-3 w-3 text-accent" />
              <span>Maturity in {daysLeftStr}</span>
            </span>
          </div>
        </div>

        {/* Embedded Interactive SVG Sparkline */}
        <div className="mt-4 pt-2">
          <SvgSparkline
            data={sparklineData}
            height={96}
            valueSuffix="%"
            loading={loading && sparklineData.length === 0}
          />
        </div>
      </div>

      {/* Secondary Metrics: 3-Column Bento Grid */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* 24h Volume */}
        <div className="glass-card double-bezel-recessed rounded-xl p-3.5 transition hover:border-glass-rim shadow-glass border-glass-rim-subtle">
          <div className="flex items-center justify-between text-xs text-ink-secondary">
            <span className="flex items-center gap-1">
              <DollarSign className="h-3.5 w-3.5 text-accent" />
              <span>24h Volume</span>
            </span>
            <span className="text-[11px] text-ink-muted">USDC</span>
          </div>
          <div className="mt-1.5 tabular-mono text-lg font-bold text-ink">
            {loading && !activeAnalytics ? "..." : volume24h}
          </div>
          <div className="mt-1 text-[11px] text-ink-muted">
            Aggregated pool trades
          </div>
        </div>

        {/* Total TVL */}
        <div className="glass-card double-bezel-recessed rounded-xl p-3.5 transition hover:border-glass-rim shadow-glass border-glass-rim-subtle">
          <div className="flex items-center justify-between text-xs text-ink-secondary">
            <span className="flex items-center gap-1">
              <Layers className="h-3.5 w-3.5 text-accent" />
              <span>Total TVL</span>
            </span>
            <span className="text-[11px] text-ink-muted">AMM + SY</span>
          </div>
          <div className="mt-1.5 tabular-mono text-lg font-bold text-ink">
            {loading && !activeAnalytics ? "..." : totalTvl}
          </div>
          <div className="mt-1 text-[11px] text-ink-muted">
            Underlying collateral value
          </div>
        </div>

        {/* Total Swaps */}
        <div className="glass-card double-bezel-recessed rounded-xl p-3.5 transition hover:border-glass-rim shadow-glass border-glass-rim-subtle">
          <div className="flex items-center justify-between text-xs text-ink-secondary">
            <span className="flex items-center gap-1">
              <Activity className="h-3.5 w-3.5 text-accent" />
              <span>Protocol Swaps</span>
            </span>
            <span className="text-[11px] text-ink-muted">Testnet</span>
          </div>
          <div className="mt-1.5 tabular-mono text-lg font-bold text-ink">
            {loading && !activeAnalytics ? "..." : totalSwaps}
          </div>
          <div className="mt-1 text-[11px] text-ink-muted">
            Indexed smart contracts
          </div>
        </div>
      </div>
    </div>
  );
}
