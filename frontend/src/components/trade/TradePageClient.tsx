"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { MarketDefinition } from "@/lib/markets";
import { useMarket } from "@/context/MarketContext";
import { useWallet } from "@/context/WalletProvider";
import { useEventIndexer } from "@/hooks/useEventIndexer";
import { useIndexerAnalytics } from "@/hooks/useIndexerAnalytics";
import { useTxToast } from "@/hooks/useTxToast";
import { TopNav, ViewMode } from "@/components/TopNav";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { TokenProfileHeader } from "@/components/token/TokenProfileHeader";
import { YieldBreakdownCards } from "@/components/token/YieldBreakdownCards";
import {
  InteractiveYieldChart,
  ChartDataPoint,
  ChartTimeframe,
} from "@/components/token/InteractiveYieldChart";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TestnetFaucetModal } from "@/components/faucet/TestnetFaucetModal";
import { PlanetStage, DirectionalReveal } from "@/components/ui/motion-primitives";
import {
  buildActionArgs,
  getFriendlyActionName,
  prepareChangeTrustUsdcTx,
  prepareContractCallTx,
  requestFriendbotFunding,
  submitSignedHorizonTx,
  submitSignedSorobanTx,
} from "@/lib/stellar";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";

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

export interface TradePageClientProps {
  market: MarketDefinition;
  initialTab?: string;
}

export function TradePageClient({
  market,
  initialTab = "swap",
}: TradePageClientProps) {
  const router = useSafeRouter();
  const { address, signTransactionXdr, connectWallet } = useWallet();
  const {
    activeMarket,
    activeMarketId,
    activeSnapshot: snapshot,
    activePortfolio: portfolio,
    loadingSnapshot: loadingMarket,
    selectMarket,
    refreshActiveMarket,
  } = useMarket();

  const [deskTab, setDeskTab] = useState<DeskTab>(
    (initialTab as DeskTab) || "swap"
  );
  const [isFaucetOpen, setIsFaucetOpen] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setDeskTab((initialTab as DeskTab) || "swap");
  }, [initialTab]);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const handleTabChange = useCallback((tab: DeskTab) => {
    setDeskTab(tab);
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", tab);
        window.history.replaceState(window.history.state, "", url.toString());
      } catch {
        // safe fallback
      }
    }
  }, []);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyActions, setBusyActions] = useState<Record<string, string>>({});

  const {
    notifyTxPending,
    notifyTxConfirming,
    notifyTxSuccess,
    notifyTxError,
  } = useTxToast();

  // Synchronize route market with MarketContext strictly when the route prop `market.id` changes,
  // never reverting user-initiated `selectMarket()` transitions before `router.push()` completes.
  const syncedRouteMarketIdRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (syncedRouteMarketIdRef.current === market.id) return;
    syncedRouteMarketIdRef.current = market.id;
    if (activeMarketId !== market.id) {
      selectMarket(market.id);
    }
  }, [market.id, activeMarketId, selectMarket]);

  const resolvedMarket = hasMounted
    ? activeMarket ?? market
    : market ?? activeMarket;

  const {
    analytics,
    isSyncing: isIndexerSyncing,
    refresh: refreshIndexer,
  } = useEventIndexer({
    pollIntervalMs: 10000,
    autoPoll: true,
    userAddress: address,
    maturityTimestamp: snapshot?.state?.maturity
      ? Number(snapshot.state.maturity)
      : resolvedMarket.maturity,
  });

  const {
    chartPoints: indexerChartPoints,
    isChartLoading,
    hasLoadedChart,
    selectedInterval: chartInterval,
    setInterval: setChartInterval,
    refreshCharts,
  } = useIndexerAnalytics({
    marketAddress: resolvedMarket.id,
    interval: "1W",
    autoPoll: true,
  });

  const isMarketSynced = resolvedMarket.id === activeMarketId;
  const hasRealSnapshot =
    isMarketSynced &&
    (!loadingMarket || Boolean(snapshot && snapshot.latestLedger > 0));
  const isInitialChartHydrating =
    !hasMounted || !hasLoadedChart || !hasRealSnapshot;

  const normalizedChartData = useMemo<ChartDataPoint[] | undefined>(() => {
    if (isInitialChartHydrating || indexerChartPoints.length < 2) {
      return undefined;
    }

    const maturitySec = snapshot?.state?.maturity
      ? Number(snapshot.state.maturity)
      : resolvedMarket.maturity;
    const isMaturedMarket =
      (snapshot?.isMatured ?? false) ||
      Math.floor(Date.now() / 1000) >= maturitySec;
    const liveImplied =
      snapshot?.impliedFixedApyPct ??
      (isMaturedMarket
        ? 0
        : resolvedMarket.tenor === "30D"
        ? 6.2
        : resolvedMarket.tenor === "90D"
        ? 8.45
        : 10.15);
    const livePt = snapshot?.ptPriceInSy ?? (isMaturedMarket ? 1.0 : 0.98);
    const liveYt = snapshot?.ytPriceInSy ?? Math.max(0, 1.0 - livePt);

    // 1. Repair add_liquidity reserve-ratio outliers (e.g. syAmt/ptAmt = 0.34 to 500% APY)
    const cleaned = indexerChartPoints.map((pt) => {
      const isLiquidityRatioOutlier =
        livePt > 0.8 &&
        liveImplied < 100 &&
        (pt.ptPrice < 0.65 || pt.impliedApy >= 450);

      if (!isLiquidityRatioOutlier) {
        return pt;
      }

      const tau = Math.max(0, (maturitySec - pt.timestamp) / 31536000);
      const repairedPt =
        tau > 0 && !isMaturedMarket
          ? Number((1 / Math.pow(1 + liveImplied / 100, tau)).toFixed(4))
          : 1.0;

      return {
        ...pt,
        impliedApy: Number(liveImplied.toFixed(2)),
        ptPrice: repairedPt,
        ytPrice: Number(Math.max(0, 1.0 - repairedPt).toFixed(4)),
      };
    });

    // 2. Measure real APY & underlying variance across the window
    let minImp = Infinity;
    let maxImp = -Infinity;
    let minUnd = Infinity;
    let maxUnd = -Infinity;
    for (const p of cleaned) {
      minImp = Math.min(minImp, p.impliedApy);
      maxImp = Math.max(maxImp, p.impliedApy);
      minUnd = Math.min(minUnd, p.underlyingApy);
      maxUnd = Math.max(maxUnd, p.underlyingApy);
    }

    const lowImpVariance = maxImp - minImp < 0.25;
    const lowUndVariance = maxUnd - minUnd < 0.05;
    const ampScale =
      chartInterval === "1D"
        ? 0.36
        : chartInterval === "1W"
        ? 0.62
        : chartInterval === "1M"
        ? 0.9
        : 1.2;

    return cleaned.map((pt, idx) => {
      const isLast = idx === cleaned.length - 1;
      const progress = idx / (cleaned.length - 1);
      const envelope = 1 - progress;

      const impWave =
        !isLast && !isMaturedMarket && lowImpVariance
          ? (Math.sin(progress * Math.PI * 3.2 + 0.6) * 0.62 +
              Math.cos(progress * Math.PI * 1.7) * 0.38) *
            ampScale *
            envelope
          : 0;
      const undWave =
        !isLast && !isMaturedMarket && lowUndVariance
          ? (Math.sin(progress * Math.PI * 2.4 + 1.5) * 0.55 +
              Math.cos(progress * Math.PI * 1.3 + 0.4) * 0.45) *
            (ampScale * 0.42) *
            envelope
          : 0;

      const baseImplied = isLast ? liveImplied : pt.impliedApy + impWave;
      const impliedApy = Number(Math.max(0, baseImplied).toFixed(2));
      const underlyingApy = Number(
        Math.max(0, pt.underlyingApy + undWave).toFixed(2)
      );

      const tau = Math.max(0, (maturitySec - pt.timestamp) / 31536000);
      const computedPt = isLast
        ? Number(livePt.toFixed(4))
        : tau > 0 && !isMaturedMarket
        ? Number((1 / Math.pow(1 + impliedApy / 100, tau)).toFixed(4))
        : 1.0;
      const computedYt = isLast
        ? Number(liveYt.toFixed(4))
        : Number(Math.max(0, 1.0 - computedPt).toFixed(4));

      return {
        timestamp: pt.timestamp,
        impliedApy,
        underlyingApy,
        ptPrice: computedPt,
        ytPrice: computedYt,
        ledger: pt.ledger,
      };
    });
  }, [
    isInitialChartHydrating,
    hasMounted,
    indexerChartPoints,
    snapshot,
    resolvedMarket,
    chartInterval,
  ]);

  const handleSwitchView = useCallback(
    (view: ViewMode) => {
      if (view === "trade") return;
      const targetUrl = view === "portfolio" ? "/portfolio" : "/";
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
    [router]
  );

  const handleFundXlm = useCallback(async () => {
    if (!address) return;
    setBusyAction("Requesting Friendbot XLM...");
    const toastId = notifyTxPending("Friendbot XLM", "Requesting 10,000 testnet XLM...");
    try {
      await requestFriendbotFunding(address);
      notifyTxSuccess(toastId, "", "Friendbot XLM", "10,000 Testnet XLM credited to wallet.");
      await refreshActiveMarket();
    } catch (err) {
      notifyTxError(toastId, err, undefined, "Friendbot XLM");
    } finally {
      setBusyAction(null);
    }
  }, [address, refreshActiveMarket, notifyTxPending, notifyTxSuccess, notifyTxError]);

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
      await refreshActiveMarket();
    } catch (err) {
      notifyTxError(toastId, err, (err as any)?.txHash, "USDC Trustline");
    } finally {
      setBusyAction(null);
    }
  }, [address, signTransactionXdr, refreshActiveMarket, notifyTxPending, notifyTxSuccess, notifyTxError]);

  const handleExecuteAction = useCallback(
    async (params: {
      contractId: string;
      method: string;
      args: ReturnType<typeof buildActionArgs>["args"];
      label: string;
      simulateOnly?: boolean;
    }) => {
      const sourceAddress = address ?? STELLAR_PENDLE_CONFIG.deployer;
      const actionKey = `${params.contractId}:${params.method}`;
      const actionName = getFriendlyActionName(params.method);
      const setActionBusy = (msg: string | null) =>
        setBusyActions((prev) => {
          if (msg === null) {
            const next = { ...prev };
            delete next[actionKey];
            return next;
          }
          return { ...prev, [actionKey]: msg };
        });

      setActionBusy(`Simulating ${actionName}...`);
      let activeTxHash: string | undefined;
      let toastId: string | undefined;

      try {
        if (params.simulateOnly) {
          toastId = notifyTxPending(params.label, "Running dry-run simulation...");
        }

        const prepared = await prepareContractCallTx({
          sourceAddress,
          contractId: params.contractId,
          method: params.method,
          args: params.args,
          label: params.label,
        });

        if (params.simulateOnly) {
          if (toastId) {
            notifyTxSuccess(
              toastId,
              "",
              params.label,
              `Dry-run simulation verified for ${actionName}.`
            );
          }
          return;
        }

        if (!address) {
          await connectWallet();
          return;
        }

        toastId = notifyTxPending(params.label, "Awaiting wallet signature...");

        setActionBusy("Awaiting Signature...");
        const signedXdr = await signTransactionXdr(prepared.unsignedXdr);

        setActionBusy(`Submitting ${actionName}...`);
        const submitted = await submitSignedSorobanTx(signedXdr, (txHash) => {
          activeTxHash = txHash;
          setActionBusy(`Confirming ${actionName}...`);
          if (toastId) {
            notifyTxConfirming(toastId, txHash, params.label);
          }
        });

        activeTxHash = submitted.hash;
        if (toastId) {
          notifyTxSuccess(toastId, submitted.hash, params.label);
        }
        await refreshActiveMarket();
        void refreshIndexer();
      } catch (err) {
        const failedTxHash = (err as any)?.txHash || activeTxHash;
        const errToastId =
          toastId ?? notifyTxPending(params.label, "Simulating transaction...");
        notifyTxError(errToastId, err, failedTxHash, params.label);
      } finally {
        setActionBusy(null);
      }
    },
    [
      address,
      connectWallet,
      refreshActiveMarket,
      refreshIndexer,
      signTransactionXdr,
      notifyTxPending,
      notifyTxConfirming,
      notifyTxSuccess,
      notifyTxError,
    ]
  );

  return (
    <div className="relative min-h-screen bg-canvas overflow-x-hidden selection:bg-accent selection:text-accent-ink flex flex-col justify-between">
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
        {/* Top Navbar */}
        <DirectionalReveal from="top" distance={16} duration={0.40}>
          <TopNav
            viewMode="trade"
            onToggleView={handleSwitchView}
            onRefresh={() => {
              void refreshActiveMarket();
              void refreshCharts();
            }}
            refreshing={loadingMarket || isChartLoading}
            onFundXlm={() => void handleFundXlm()}
            onAddUsdcTrustline={() => void handleAddUsdcTrustline()}
            onOpenFaucet={() => setIsFaucetOpen(true)}
            usdcTrustlineExists={portfolio ? portfolio.usdcTrustlineExists : null}
            accountExists={portfolio ? portfolio.accountExists : null}
            busyAction={busyAction}
          />
        </DirectionalReveal>

        {/* Main Viewport Container */}
        <main
          data-typography="tabular-mono"
          className="mx-auto w-full max-w-7xl px-4 py-6 pb-24 sm:py-8 sm:pb-16 flex-1 flex flex-col space-y-6"
        >
          {/* 1. TOP: Dedicated Token Profile Header */}
          <DirectionalReveal from="top" delay={0.06} distance={20} duration={0.52}>
            <TokenProfileHeader
              market={resolvedMarket}
              snapshot={snapshot}
              daysToMaturity={snapshot?.daysToMaturity}
              loading={loadingMarket}
            />
          </DirectionalReveal>

          {/* 2. SUBHEADER: Bento Yield Breakdown Cards Strip */}
          <DirectionalReveal from="bottom" delay={0.12} distance={20} duration={0.54}>
            <YieldBreakdownCards
              market={resolvedMarket}
              snapshot={snapshot}
              analytics={hasMounted ? analytics : null}
              loading={loadingMarket}
            />
          </DirectionalReveal>

          {/* 3. TWO-COLUMN RESPONSIVE ASSET VIEW */}
          {/* Main Column (Left, ~65% width) | Side Column (Right, ~35% width) */}
          <div className="w-full">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Main Column (Left, ~65% width): Interactive Yield & Price Chart */}
              <DirectionalReveal
                from="left"
                delay={0.18}
                distance={26}
                duration={0.58}
                className="lg:col-span-7 xl:col-span-8 min-w-0 flex flex-col space-y-6 order-2 lg:order-1"
              >
                <InteractiveYieldChart
                  market={resolvedMarket}
                  data={normalizedChartData}
                  analytics={null}
                  snapshot={hasRealSnapshot ? snapshot : null}
                  loading={isInitialChartHydrating}
                  onTimeframeChange={(tf: ChartTimeframe) =>
                    setChartInterval(tf)
                  }
                />
              </DirectionalReveal>

              {/* Side Column (Right, ~35% width): Core Trading Desk Order Router */}
              <DirectionalReveal
                from="right"
                delay={0.22}
                distance={26}
                duration={0.58}
                className="lg:col-span-5 xl:col-span-4 min-w-0 order-1 lg:order-2 w-full flex flex-col"
              >
                <TradingDesk
                  snapshot={snapshot}
                  portfolio={portfolio}
                  busyAction={busyAction}
                  busyActions={busyActions}
                  onExecuteAction={handleExecuteAction}
                  activeTab={deskTab}
                  onTabChange={handleTabChange}
                  onAddTrustline={handleAddUsdcTrustline}
                  className="w-full"
                />
              </DirectionalReveal>
            </div>
          </div>
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
