"use client";

import React from "react";
import { Clock, Shield, TrendingUp } from "lucide-react";
import { LiveMarketSnapshot } from "@/lib/stellar";
import { formatUnits } from "@/lib/math";
import { MarketSelector } from "./MarketSelector";

interface MarketTickerBarProps {
  snapshot: LiveMarketSnapshot | null;
  loading: boolean;
}

export function MarketTickerBar({ snapshot, loading }: MarketTickerBarProps) {
  const fixedApy = snapshot?.impliedFixedApyPct != null ? `${snapshot.impliedFixedApyPct.toFixed(2)}%` : "--";
  const bRate = snapshot?.blendExchangeRate != null ? (Number(snapshot.blendExchangeRate) / 1e9).toFixed(6) : "--";
  const ammRate = snapshot?.ammExchangeRateWad != null ? (Number(snapshot.ammExchangeRateWad) / 1e18).toFixed(4) : "--";
  const ptReserve = snapshot?.state?.total_pt_reserve != null ? formatUnits(snapshot.state.total_pt_reserve, 7, 2) : "--";
  const syReserve = snapshot?.state?.total_sy_reserve != null ? formatUnits(snapshot.state.total_sy_reserve, 7, 2) : "--";
  const daysLeft = snapshot?.daysToMaturity != null ? `${snapshot.daysToMaturity.toFixed(1)}d` : "--";

  const ptPrice = snapshot
    ? (snapshot.ptPriceInSy != null
        ? snapshot.ptPriceInSy.toFixed(4)
        : Number(snapshot.ammExchangeRateWad) > 0
          ? (1 / (Number(snapshot.ammExchangeRateWad) / 1e18)).toFixed(4)
          : "--")
    : "--";
  const ytPrice = snapshot
    ? (snapshot.ytPriceInSy != null
        ? snapshot.ytPriceInSy.toFixed(4)
        : ptPrice !== "--"
          ? Math.max(0, 1 - parseFloat(ptPrice)).toFixed(4)
          : "--")
    : "--";

  return (
    <div className="relative z-30 w-full border-b border-glass-rim bg-surface-muted/60 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 overflow-x-auto px-4 py-2.5 text-xs sm:px-6">
        {/* Left: Market Selector & Maturity countdown pill */}
        <div className="flex shrink-0 items-center gap-2.5 sm:gap-3">
          <MarketSelector compact />

          <div className="flex items-center gap-1.5 rounded-full border border-glass-rim bg-surface-muted/70 px-2.5 py-1 text-ink-secondary backdrop-blur-sm">
            <Clock className="h-3.5 w-3.5 text-ink-muted" />
            <span className="tabular-mono text-xs font-medium text-ink">{daysLeft}</span>
          </div>
        </div>

        {/* Right: Metrics Strip with Crisp Vertical Dividers */}
        <div className="flex shrink-0 items-center">
          {/* 1. PT Implied APY */}
          <div className="flex items-center gap-1.5 border-l border-hairline pl-4">
            <TrendingUp className="h-3.5 w-3.5 text-positive" />
            <span className="font-medium text-ink-secondary">PT Implied APY</span>
            <span className="tabular-mono font-bold text-positive">
              {loading && !snapshot ? "..." : fixedApy}
            </span>
          </div>

          {/* 2. PT / YT Price */}
          <div className="hidden sm:flex items-center gap-2 border-l border-hairline pl-4">
            <span className="text-ink-secondary">PT / YT Price</span>
            <div className="flex items-center gap-1.5">
              <span className="text-positive tabular-mono font-medium">PT {ptPrice} SY</span>
              <span className="text-hairline">/</span>
              <span className="text-accent tabular-mono font-medium">YT {ytPrice} SY</span>
            </div>
          </div>

          {/* 3. Blend bRate */}
          <div className="hidden md:flex items-center gap-2 border-l border-hairline pl-4">
            <span className="text-ink-secondary">Blend bRate</span>
            <span className="tabular-mono font-semibold text-accent">{bRate}</span>
          </div>

          {/* 4. AMM Rate */}
          <div className="hidden lg:flex items-center gap-2 border-l border-hairline pl-4">
            <span className="text-ink-secondary">AMM Rate</span>
            <span className="tabular-mono font-semibold text-ink">{ammRate} PT/SY</span>
          </div>

          {/* 5. Pool Reserves */}
          <div className="hidden xl:flex items-center gap-2 border-l border-hairline pl-4">
            <div className="flex items-center gap-1 text-ink-secondary">
              <Shield className="h-3.5 w-3.5 text-accent" />
              <span>Pool Reserves</span>
            </div>
            <span className="tabular-mono font-medium text-ink">
              {ptReserve} PT / {syReserve} SY
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
