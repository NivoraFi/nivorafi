"use client";

import React, { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity } from "lucide-react";
import { TopNav, ViewMode } from "@/components/TopNav";
import { MarketExplorerTable } from "@/components/markets/MarketExplorerTable";
import { TestnetFaucetModal } from "@/components/faucet/TestnetFaucetModal";
import { DirectionalReveal, InteractiveLiftCard } from "@/components/ui/motion-primitives";
import { useMarket } from "@/context/MarketContext";
import { useWallet } from "@/context/WalletProvider";
import { useTxToast } from "@/hooks/useTxToast";
import { deriveMarketStatus } from "@/lib/markets";
import {
  prepareChangeTrustUsdcTx,
  requestFriendbotFunding,
  submitSignedHorizonTx,
} from "@/lib/stellar";

function useSafeRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

export function MarketsPageClient() {
  const router = useSafeRouter();
  const { address, signTransactionXdr } = useWallet();
  const {
    markets = [],
    activeMarketId,
    activePortfolio,
    loadingSnapshot,
    marketMetrics = {},
    refreshAllMetrics,
  } = useMarket();
  const { notifyTxPending, notifyTxSuccess, notifyTxError } = useTxToast();
  const [isFaucetOpen, setIsFaucetOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const handleSwitchView = useCallback(
    (view: ViewMode) => {
      const targetUrl =
        view === "trade"
          ? `/trade/${activeMarketId || "usdc-90d"}`
          : view === "portfolio"
          ? "/portfolio"
          : "/";
      if (router) {
        try {
          router.push(targetUrl);
          return;
        } catch {}
      }
      if (typeof window !== "undefined") {
        window.location.href = targetUrl;
      }
    },
    [router, activeMarketId]
  );

  const handleRefresh = useCallback(async () => {
    await refreshAllMetrics();
  }, [refreshAllMetrics]);

  const handleFundXlm = useCallback(async () => {
    if (!address) return;
    setBusyAction("Requesting Friendbot XLM...");
    const toastId = notifyTxPending("Friendbot XLM", "Requesting 10,000 testnet XLM...");
    try {
      await requestFriendbotFunding(address);
      notifyTxSuccess(toastId, "", "Friendbot XLM", "10,000 Testnet XLM credited to wallet.");
      await refreshAllMetrics();
    } catch (err) {
      notifyTxError(toastId, err, undefined, "Friendbot XLM");
    } finally {
      setBusyAction(null);
    }
  }, [address, refreshAllMetrics, notifyTxPending, notifyTxSuccess, notifyTxError]);

  const handleAddUsdcTrustline = useCallback(async () => {
    if (!address) return;
    setBusyAction("Signing USDC Trustline...");
    const toastId = notifyTxPending("USDC Trustline", "Signing USDC trustline on Horizon...");
    try {
      const unsignedXdr = await prepareChangeTrustUsdcTx(address);
      const signedXdr = await signTransactionXdr(unsignedXdr);
      setBusyAction("Submitting USDC Trustline...");
      const res = await submitSignedHorizonTx(signedXdr);
      notifyTxSuccess(toastId, res.hash, "USDC Trustline", "USDC trustline established on Testnet.");
      await refreshAllMetrics();
    } catch (err) {
      notifyTxError(toastId, err, (err as any)?.txHash, "USDC Trustline");
    } finally {
      setBusyAction(null);
    }
  }, [address, signTransactionXdr, refreshAllMetrics, notifyTxPending, notifyTxSuccess, notifyTxError]);

  // Aggregate live metrics summary for top strip (zero synthetic baselines)
  const { totalTvlUsd, peakImpliedApy, activeCount } = useMemo(() => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    let tvl = 0;
    let peakApy = 0;
    let active = 0;

    for (const m of markets) {
      const met = marketMetrics[m.id];
      const mtvl = met?.tvlUsd ?? 0;
      const mapy = met?.impliedApyPct ?? 0;
      const isMatured = met ? met.isMatured : deriveMarketStatus(m.maturity, nowSeconds) === "MATURED";
      tvl += mtvl;
      if (mapy > peakApy) peakApy = mapy;
      if (!isMatured) active++;
    }

    return {
      totalTvlUsd: tvl,
      peakImpliedApy: peakApy,
      activeCount: active,
    };
  }, [markets, marketMetrics]);

  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col">
      {/* Top Navigation */}
      <DirectionalReveal from="top" distance={16} duration={0.40}>
        <TopNav
          viewMode="landing"
          activeTab="markets"
          onToggleView={handleSwitchView}
          onRefresh={() => void handleRefresh()}
          refreshing={loadingSnapshot}
          onFundXlm={() => void handleFundXlm()}
          onAddUsdcTrustline={() => void handleAddUsdcTrustline()}
          onOpenFaucet={() => setIsFaucetOpen(true)}
          usdcTrustlineExists={activePortfolio ? activePortfolio.usdcTrustlineExists : null}
          accountExists={activePortfolio ? activePortfolio.accountExists : null}
          busyAction={busyAction}
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
