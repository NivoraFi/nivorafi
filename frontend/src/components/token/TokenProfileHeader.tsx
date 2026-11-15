"use client";

import React, { useEffect, useState } from "react";
import {
  Calendar,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { MarketDefinition } from "@/lib/markets";
import { LiveMarketSnapshot } from "@/lib/stellar";

export interface TokenProfileHeaderProps {
  market: MarketDefinition;
  snapshot?: LiveMarketSnapshot | null;
  daysToMaturity?: number;
  loading?: boolean;
  className?: string;
  onCopyContract?: (label: string, address: string) => void;
}

export function TokenProfileHeader({
  market,
  snapshot,
  daysToMaturity: propDaysToMaturity,
  className = "",
}: TokenProfileHeaderProps) {
  const [nowSeconds, setNowSeconds] = useState<number>(() =>
    snapshot?.nowSeconds ?? Math.floor(Date.now() / 1000)
  );

  // Live timer interval for real-time second-by-second countdown
  useEffect(() => {
    setNowSeconds(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const isMatured =
    snapshot?.isMatured ??
    (propDaysToMaturity !== undefined ? propDaysToMaturity <= 0 : nowSeconds >= market.maturity);

  // Format detailed countdown string
  const diffSeconds = Math.max(0, market.maturity - nowSeconds);
  const days = Math.floor(diffSeconds / 86400);
  const hours = Math.floor((diffSeconds % 86400) / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  const seconds = diffSeconds % 60;

  return (
    <div
      className={`glass-panel double-bezel rounded-2xl p-5 sm:p-6 shadow-glass-elevated backdrop-blur-xl ${className}`}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        {/* Left Wing: Asset Icon, Symbol, Name & Token Badges */}
        <div className="flex items-center gap-4">
          {/* Asset Icon Container */}
          <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-glass-rim bg-surface-muted/60 shadow-glass">
            <TokenIcon symbol={market.asset.code} size="xl" showSymbolSrOnly />
            {market.isVerifiedTestnet && (
              <span
                title="Verified Testnet Deployment"
                className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-canvas bg-positive text-accent-ink"
              >
                <ShieldCheck className="h-2.5 w-2.5" />
              </span>
            )}
          </div>

          {/* Asset Titles & Pills */}
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight text-ink sm:text-xl">
              {market.name}
            </h1>

            {/* Tenor Badge */}
            <span className="tabular-mono font-mono rounded-full border border-glass-rim bg-surface-muted/60 px-2.5 py-0.5 text-xs font-semibold text-ink-secondary active:opacity-90">
              {market.tenor}
            </span>

            {/* Token Pair Pills */}
            <span className="tabular-mono font-mono pendle-pt-pill rounded-full px-2.5 py-0.5 text-xs">
              {market.ptSymbol}
            </span>
            <span className="tabular-mono font-mono pendle-yt-pill rounded-full px-2.5 py-0.5 text-xs">
              {market.ytSymbol}
            </span>

            {/* Status Badge */}
            {isMatured ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-ink-muted" />
                Matured
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-positive/30 bg-positive-soft px-2.5 py-0.5 text-xs font-medium text-positive">
                <span className="h-1.5 w-1.5 rounded-full bg-positive animate-pulse motion-reduce:animate-none" />
                Active
              </span>
            )}
          </div>
        </div>

        {/* Right Wing: Protocol Name, Maturity Date & Time Left */}
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <div className="flex items-center gap-1.5 rounded-xl border border-hairline bg-surface-muted/70 px-3 py-1.5 text-xs">
            <TokenIcon symbol="BLEND" size="xs" />
            <span className="font-semibold text-ink">Blend Protocol</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-hairline bg-surface-muted/70 px-3 py-1.5 text-xs">
            <Calendar className="h-3.5 w-3.5 text-ink-muted" />
            <span className="text-ink-secondary">Maturity:</span>
            <span className="tabular-mono font-mono font-semibold text-ink">
              {(market.maturityIso || "").slice(0, 10)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-hairline bg-surface-muted/70 px-3 py-1.5 text-xs">
            <Clock className="h-3.5 w-3.5 text-accent" />
            <span
              suppressHydrationWarning
              className="tabular-mono font-mono font-semibold text-ink"
            >
              {isMatured
                ? "Settled at Maturity"
                : `${days}d ${hours}h ${minutes}m ${seconds}s left`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
