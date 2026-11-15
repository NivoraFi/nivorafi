"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Clock,
  Coins,
  Layers,
  Loader2,
  RefreshCw,
  Repeat,
  Sparkles,
  Wallet,
} from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import {
  buildActionArgs,
  LiveUserPortfolio,
} from "@/lib/stellar";
import { PRESET_MARKETS } from "@/lib/markets";
import {
  aggregatePortfolioTotals,
  parseMarketPosition,
  useMultiMarketPortfolio,
} from "@/hooks/useMultiMarketPortfolio";
import { useIndexerAnalytics } from "@/hooks/useIndexerAnalytics";
import {
  hasStoredWalletSession,
  mapIndexedPositionsToPortfolios,
  probeIndexerPositionsFast,
} from "@/lib/hybridPortfolio";
import { TokenIcon } from "@/components/ui/TokenIcon";

export interface PortfolioViewProps {
  onSelectMarketAndTab?: (marketId: string, tab: string) => void;
  onNavigateToTrade?: (
    marketId: string,
    tab: "swap" | "redeem" | "rollover" | "mint" | "liquidity"
  ) => void;
  onSwitchToTrade?: (tab?: string) => void;
  userPortfolios?: Record<string, LiveUserPortfolio> | null;
  onExecuteAction?: (params: {
    contractId: string;
    method: string;
    args: any[];
    label: string;
    simulateOnly?: boolean;
  }) => Promise<void>;
  busyAction?: string | null;
  onRefresh?: () => Promise<void> | void;
  refreshing?: boolean;
  className?: string;
}

export function PortfolioView({
  onSelectMarketAndTab,
  onNavigateToTrade,
  onSwitchToTrade,
  userPortfolios,
  onExecuteAction,
  busyAction,
  onRefresh,
  refreshing = false,
  className = "",
}: PortfolioViewProps) {
  const { address, connectWallet, connecting } = useWallet();
  const { marketMetrics } = useMarket();

  const [hasMountedClient, setHasMountedClient] = useState(false);
  const [restoringWallet, setRestoringWallet] = useState(false);
  const [fastIndexedPortfolios, setFastIndexedPortfolios] = useState<Record<
    string,
    LiveUserPortfolio
  > | null>(null);
  const [fastIndexerOnline, setFastIndexerOnline] = useState(false);

  // 1. Live On-Chain Soroban Balances + Local Snapshot Cache
  const portfolio = useMultiMarketPortfolio({
    initialPortfolios: userPortfolios,
  });

  // 2. Off-Chain Indexed Historical PnL & Position Accounting (Workstream B Interop)
  const {
    positions: indexerPositions,
    positionSummary: indexerSummary,
    positionsByMarketId: indexerPositionsByMarket,
    isPositionsLoading,
    refreshPositions,
  } = useIndexerAnalytics({
    userAddress: address,
    autoPoll: true,
  });

  // Client mount & persisted wallet session guard (prevents Connect Wallet flash on reload)
  useEffect(() => {
    setHasMountedClient(true);
    if (!address && hasStoredWalletSession()) {
      setRestoringWallet(true);
      const timer = setTimeout(() => setRestoringWallet(false), 600);
      return () => clearTimeout(timer);
    }
    setRestoringWallet(false);
  }, [address]);

  // Fast SQLite Indexer probe (~15ms when online, 900ms fail-fast timeout when offline)
  const verifiedMarkets = useMemo(
    () => PRESET_MARKETS.filter((m) => m.isVerifiedTestnet),
    []
  );

  useEffect(() => {
    if (userPortfolios !== undefined || !address) {
      setFastIndexedPortfolios(null);
      setFastIndexerOnline(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const probe = await probeIndexerPositionsFast({
        userAddress: address,
        timeoutMs: 900,
      });
      if (cancelled) return;
      if (probe.reachable && probe.response) {
        const mapped = mapIndexedPositionsToPortfolios(
          address,
          probe.response.positions,
          verifiedMarkets,
          portfolio.rawPortfolios
        );
        setFastIndexedPortfolios(mapped);
        setFastIndexerOnline(true);
      } else {
        setFastIndexerOnline(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, userPortfolios, verifiedMarkets]);

  // Hybrid multi-tier resolution: Props to On-Chain RPC to Fast Indexer to Local Cache to Pending
  const { viewSource, displayPositions, displayTotals } = useMemo(() => {
    if (userPortfolios !== undefined) {
      return {
        viewSource: "props" as const,
        displayPositions: portfolio.positions,
        displayTotals: portfolio,
      };
    }

    if (portfolio.lastUpdated !== null) {
      return {
        viewSource: "rpc" as const,
        displayPositions: portfolio.positions,
        displayTotals: portfolio,
      };
    }

    if (fastIndexerOnline && fastIndexedPortfolios && address) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const mergedPositions = verifiedMarkets.map((m) => {
        const idxPort = fastIndexedPortfolios[m.id] ?? null;
        const cachedPort = portfolio.rawPortfolios[m.id] ?? null;
        const mergedPort: LiveUserPortfolio | null = idxPort
          ? {
              ...idxPort,
              syBalance: cachedPort?.syBalance ?? idxPort.syBalance,
              estimatedPendingYieldSy:
                cachedPort?.estimatedPendingYieldSy ?? idxPort.estimatedPendingYieldSy,
            }
          : cachedPort;
        return parseMarketPosition(m, mergedPort, marketMetrics[m.id] ?? null, nowSeconds);
      });
      return {
        viewSource: "indexer" as const,
        displayPositions: mergedPositions,
        displayTotals: aggregatePortfolioTotals(mergedPositions),
      };
    }

    if (portfolio.hasCachedSnapshot) {
      return {
        viewSource: "cache" as const,
        displayPositions: portfolio.positions,
        displayTotals: portfolio,
      };
    }

    if (address && indexerPositions.length > 0) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const mapped = mapIndexedPositionsToPortfolios(
        address,
        indexerPositions,
        verifiedMarkets,
        portfolio.rawPortfolios
      );
      const mergedPositions = verifiedMarkets.map((m) =>
        parseMarketPosition(m, mapped[m.id] ?? null, marketMetrics[m.id] ?? null, nowSeconds)
      );
      return {
        viewSource: "indexer" as const,
        displayPositions: mergedPositions,
        displayTotals: aggregatePortfolioTotals(mergedPositions),
      };
    }

    return {
      viewSource: "pending" as const,
      displayPositions: portfolio.positions,
      displayTotals: portfolio,
    };
  }, [
    userPortfolios,
    portfolio,
    fastIndexerOnline,
    fastIndexedPortfolios,
    address,
    verifiedMarkets,
    marketMetrics,
    indexerPositions,
  ]);

  const isBusy = Boolean(busyAction);
  void refreshing;
  void onRefresh;

  const handleAction = useCallback(
    (marketId: string, tab: string) => {
      if (onSelectMarketAndTab) {
        onSelectMarketAndTab(marketId, tab);
      } else if (onNavigateToTrade) {
        onNavigateToTrade(marketId, tab as any);
      }
    },
    [onSelectMarketAndTab, onNavigateToTrade]
  );

  const handleSwitchToTrade = useCallback(
    (tab: string = "swap") => {
      if (onSwitchToTrade) {
        onSwitchToTrade(tab);
      } else if (onNavigateToTrade) {
        const targetId = portfolio.positions[0]?.marketId ?? "usdc-90d";
        onNavigateToTrade(targetId, tab as any);
      }
    },
    [onSwitchToTrade, onNavigateToTrade, portfolio.positions]
  );

  const handleClaimAll = useCallback(async () => {
    if (!onExecuteAction || !address) return;
    for (const pos of portfolio.positions) {
      if (pos.claimableYield > 0n) {
        const m = PRESET_MARKETS.find((pm) => pm.id === pos.marketId);
        if (m) {
          await onExecuteAction({
            ...buildActionArgs({ type: "claim_yield", caller: address }, m),
            label: `Claim Yield (${m.name})`,
          });
        }
      }
    }
  }, [onExecuteAction, address, portfolio.positions]);

  const firstMaturedMarketId = useMemo(() => {
    const found = displayPositions.find((p) => p.isMatured && p.hasPosition);
    if (found) return found.marketId;
    const anyMatured = displayPositions.find((p) => p.isMatured);
    return anyMatured ? anyMatured.marketId : "usdc-matured";
  }, [displayPositions]);

  const hasAnyPosition = useMemo(() => {
    return displayPositions.some((p) => p.hasPosition);
  }, [displayPositions]);

  // Suppress transient zero-balance flash while initial live RPC query has not yet settled
  const isInitialPortfolioPending =
    Boolean(address) &&
    userPortfolios === undefined &&
    viewSource === "pending" &&
    (portfolio.isLoading || (portfolio.lastUpdated === null && !portfolio.error));

  // Centered cold-start loading gate (only when neither cache, indexer, nor RPC has hydrated yet)
  const isColdStartSyncing =
    hasMountedClient &&
    userPortfolios === undefined &&
    ((!address && restoringWallet) || isInitialPortfolioPending);

  return (
    <div className={`w-full max-w-7xl mx-auto space-y-6 ${className}`}>
      {/* 1. Header Section */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-hairline">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ink">
            My Positions
          </h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Aggregated yield positions across all active NivoraFi markets.
          </p>
        </div>

        {address && displayTotals.totalClaimableYieldUsd > 0 && (
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              aria-label="Claim All Yield"
              onClick={() => void handleClaimAll()}
              disabled={isBusy}
              className="btn-accent inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold whitespace-nowrap hover:opacity-90 active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 transition-colors cursor-pointer"
              title="Claim Accrued Variable Yield"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>
                {busyAction ? (
                  busyAction
                ) : (
                  <>Claim All Yield (<span className="tabular-mono">${displayTotals.totalClaimableYieldUsd.toFixed(2)}</span>)</>
                )}
              </span>
            </button>
          </div>
        )}
      </div>

      {isColdStartSyncing ? (
        <div className="double-bezel rounded-2xl py-16 px-6 text-center bg-surface flex flex-col items-center justify-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-muted border border-hairline text-accent mb-4">
            <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" />
          </div>
          <h2 className="text-base font-bold text-ink">
            Syncing Portfolio Positions
          </h2>
          <p className="text-xs text-ink-muted mt-1.5 max-w-md mx-auto">
            Reading indexed positions and verifying Soroban contract balances on Stellar Testnet.
          </p>
        </div>
      ) : (
        <>
      {/* 2. 4-Tile KPI Bento Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI Tile 1: Net Worth / Total Value + PnL + Cost Basis */}
        <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between shadow-glass">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-secondary">
              Net Worth
            </span>
          </div>
          <div className="mt-3">
            <div className="tabular-mono text-2xl font-bold tracking-tight text-ink">
              ${address ? displayTotals.totalPortfolioValue.toFixed(2) : "0.00"}
            </div>
            {address && indexerSummary && (indexerSummary.totalCostBasisUsd > 0 || indexerSummary.totalNetPnlUsd !== 0) ? (
              <div className="flex items-center gap-1.5 mt-1">
                <span
                  className={`tabular-mono text-xs font-semibold ${
                    indexerSummary.totalNetPnlUsd >= 0 ? "text-positive" : "text-warn"
                  }`}
                >
                  {indexerSummary.totalNetPnlUsd >= 0 ? "+" : ""}${indexerSummary.totalNetPnlUsd.toFixed(2)} PnL
                </span>
                <span className="text-[11px] text-ink-muted">
                  · Cost: <span className="tabular-mono">${indexerSummary.totalCostBasisUsd.toFixed(2)}</span>
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-ink-muted mt-1">
                Across 3 active markets
              </p>
            )}
          </div>
        </div>

        {/* KPI Tile 2: Accrued Claimable Yield + Lifetime Claimed Yield */}
        <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between shadow-glass">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-secondary">
              Claimable Yield
            </span>
          </div>
          <div className="mt-3">
            <div className="tabular-mono text-2xl font-bold tracking-tight text-positive">
              ${address ? displayTotals.totalClaimableYieldUsd.toFixed(2) : "0.00"}
            </div>
            <p className="text-[11px] text-ink-muted mt-1">
              {displayTotals.totalClaimableYieldUsd > 0 ? (
                "Ready to claim"
              ) : indexerSummary && indexerSummary.totalClaimedYieldUsd > 0 ? (
                <>
                  Lifetime claimed:{" "}
                  <span className="tabular-mono text-positive font-medium">
                    ${indexerSummary.totalClaimedYieldUsd.toFixed(2)}
                  </span>
                </>
              ) : (
                "No pending yield"
              )}
            </p>
          </div>
        </div>

        {/* KPI Tile 3: Active Positions Count + Entry APY */}
        <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between shadow-glass">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-secondary">
              Active Positions
            </span>
          </div>
          <div className="mt-3">
            <div className="tabular-mono text-2xl font-bold tracking-tight text-ink">
              {address ? displayTotals.activePositionsCount : 0}
            </div>
            <p className="text-[11px] text-ink-muted mt-1">
              {indexerSummary && indexerSummary.overallPortfolioApy > 0 ? (
                <>
                  Entry APY:{" "}
                  <span className="tabular-mono font-medium text-ink">
                    {indexerSummary.overallPortfolioApy.toFixed(2)}%
                  </span>
                  {displayTotals.weightedApyPct > 0 && (
                    <>
                      {" "}· Cur:{" "}
                      <span className="tabular-mono">
                        {displayTotals.weightedApyPct.toFixed(2)}%
                      </span>
                    </>
                  )}
                </>
              ) : displayTotals.weightedApyPct > 0 ? (
                <>
                  Weighted APY:{" "}
                  <span className="tabular-mono">
                    {displayTotals.weightedApyPct.toFixed(2)}%
                  </span>
                </>
              ) : (
                "Generating fixed/variable yield"
              )}
            </p>
          </div>
        </div>

        {/* KPI Tile 4: Matured Positions Count */}
        <div className="glass-card border-gradient rounded-2xl p-4 flex flex-col justify-between shadow-glass">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-secondary">
              Matured Positions
            </span>
          </div>
          <div className="mt-3">
            <div
              className={`tabular-mono text-2xl font-bold tracking-tight ${
                displayTotals.maturedPositionsCount > 0 ? "text-warn" : "text-ink"
              }`}
            >
              {address ? displayTotals.maturedPositionsCount : 0}
            </div>
            {displayTotals.maturedPositionsCount > 0 ? (
              <div className="mt-1 inline-flex items-center gap-1 rounded-md border border-warn/30 bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn">
                <AlertCircle className="h-3 w-3 shrink-0" />
                <span>Rollover Available</span>
              </div>
            ) : (
              <p className="text-[11px] text-ink-muted mt-1">
                All positions active
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 3. Disconnected Wallet State Banner */}
      {!address && (
        <div className="glass-panel bg-surface border-gradient rounded-2xl p-8 text-center shadow-glass">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-glass-card border border-glass-rim text-ink-secondary mb-3 shadow-glass">
            <Wallet className="h-6 w-6" />
          </div>
          <h2 className="text-base font-bold text-ink">
            Connect Your Wallet
          </h2>
          <p className="text-xs text-ink-muted mt-1 max-w-md mx-auto">
            Connect Freighter or LOBSTR to inspect your multi-market yield balances and active positions.
          </p>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void connectWallet()}
              disabled={connecting}
              className="btn-accent inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold whitespace-nowrap hover:opacity-90 active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Wallet className="h-4 w-4" />
              <span>{connecting ? "Connecting..." : "Connect Wallet"}</span>
            </button>
          </div>
        </div>
      )}

      {/* 4. Contextual Matured Position Banner */}
      {address && (displayTotals.hasMaturedPositions || displayTotals.maturedPositionsCount > 0) && (
        <div className="rounded-2xl border border-warn/40 bg-warn-soft/20 p-4 glass-panel shadow-glass">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-warn/20 p-2 text-warn shrink-0">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-xs sm:text-sm font-semibold text-warn">
                  Action Required: Matured Positions Detected
                </h3>
                <p className="text-xs text-ink-secondary mt-0.5">
                  You have Principal Tokens in matured markets. Roll over your matured PT into active markets to continue earning fixed yield with zero slippage or redeem 1:1.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleAction(firstMaturedMarketId, "rollover")}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-warn px-3.5 py-1.5 text-xs font-semibold text-white shadow-card hover:opacity-90 active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-warn transition-colors shrink-0 cursor-pointer whitespace-nowrap"
              title="Rollover Matured PT"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Rollover Now</span>
            </button>
          </div>
        </div>
      )}

      {/* 5. Connected Zero Balance State */}
      {address && !hasAnyPosition && !isInitialPortfolioPending && (
        <div className="glass-panel border-gradient rounded-2xl p-8 text-center shadow-glass">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-glass-card border border-glass-rim text-ink-secondary mb-3 shadow-glass">
            <Layers className="h-6 w-6" />
          </div>
          <h2 className="text-base font-bold text-ink">
            No Active Positions
          </h2>
          <p className="text-xs text-ink-muted mt-1 max-w-md mx-auto">
            You do not currently hold any PT, YT, or LP tokens in NivoraFi testnet markets.
          </p>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => handleSwitchToTrade("swap")}
              className="btn-accent inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold whitespace-nowrap hover:opacity-90 active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent transition-colors cursor-pointer"
            >
              <span>Explore Markets</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 6. Multi-Market Positions Breakdown */}
      {address && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink tracking-tight">
              Market Positions Breakdown
            </h2>
            <span className="tabular-mono text-xs text-ink-muted">
              {displayPositions.length} Markets Tracked
            </span>
          </div>

          {/* Desktop Table View */}
          <div className="hidden md:block glass-panel rounded-2xl overflow-hidden shadow-glass">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-glass-rim bg-glass-interactive text-ink-secondary font-medium">
                  <tr>
                    <th className="py-3 px-4">Market</th>
                    <th className="py-3 px-4">Status & Maturity</th>
                    <th className="py-3 px-4 text-right">PT Balance</th>
                    <th className="py-3 px-4 text-right">YT & Entry APY</th>
                    <th className="py-3 px-4 text-right">LP Shares</th>
                    <th className="py-3 px-4 text-right">Claimable Yield</th>
                    <th className="py-3 px-4 text-right">Total Value & PnL</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-glass-rim/40">
                  {displayPositions.map((pos) => {
                    const hasMaturedPt = pos.isMatured && pos.ptBalance > 0n;
                    const idxPos =
                      indexerPositionsByMarket[pos.marketId] ||
                      indexerPositionsByMarket[pos.assetCode];

                    return (
                      <tr
                        key={pos.marketId}
                        className="hover:bg-glass-interactive transition-colors"
                      >
                        {/* Market Asset & Tenor */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-2.5">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-glass-card border border-glass-rim font-mono font-bold text-ink shadow-glass">
                              <TokenIcon symbol={pos.assetCode} size="md" showSymbolSrOnly />
                            </div>
                            <div>
                              <div className="font-semibold text-ink">{pos.marketName}</div>
                              <div className="text-[11px] text-ink-muted flex items-center gap-1.5">
                                <span>{pos.tenor} Tenor</span>
                                {pos.syBalance > 0n && (
                                  <span className="text-accent">
                                    · <span className="tabular-mono font-mono">{(Number(pos.syBalance) / 1e7).toFixed(4)}</span> SY
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Status & Maturity */}
                        <td className="py-3.5 px-4">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border ${
                              pos.isMatured
                                ? "border-warn/30 bg-warn-soft text-warn"
                                : "border-positive/20 bg-positive-soft text-positive"
                            }`}
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                            <span>
                              {pos.isMatured
                                ? "Matured"
                                : `Active · ${Math.ceil(pos.daysToMaturity)}d`}
                            </span>
                          </span>
                        </td>

                        {/* PT Balance */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="tabular-mono font-semibold text-ink">
                            {pos.formattedPtBalance}
                          </div>
                          <div className="tabular-mono text-[11px] text-ink-muted">
                            PT (${pos.ptValueUsd.toFixed(2)})
                          </div>
                        </td>

                        {/* YT & Entry APY */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="tabular-mono font-semibold text-ink">
                            {pos.formattedYtBalance}
                          </div>
                          <div className="tabular-mono text-[11px] text-ink-muted">
                            {idxPos && idxPos.averageEntryApy > 0 ? (
                              <>
                                Entry:{" "}
                                <span className="font-medium text-ink">
                                  {idxPos.averageEntryApy.toFixed(2)}%
                                </span>{" "}
                                · {pos.impliedApyPct.toFixed(2)}% cur
                              </>
                            ) : (
                              <>{pos.impliedApyPct.toFixed(2)}% APY</>
                            )}
                          </div>
                        </td>

                        {/* LP Shares */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="tabular-mono font-semibold text-ink">
                            {pos.formattedLpBalance}
                          </div>
                          <div className="tabular-mono text-[11px] text-ink-muted">
                            LP (${pos.lpValueUsd.toFixed(2)})
                          </div>
                        </td>

                        {/* Claimable Yield */}
                        <td className="py-3.5 px-4 text-right">
                          <div
                            className={`tabular-mono font-semibold ${
                              pos.claimableYieldUsd > 0
                                ? "text-positive"
                                : "text-ink-secondary"
                            }`}
                          >
                            ${pos.claimableYieldUsd.toFixed(2)}
                          </div>
                          <div className="tabular-mono text-[11px] text-ink-muted">
                            {pos.formattedClaimableYieldSy} SY
                          </div>
                        </td>

                        {/* Total Value & PnL */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="tabular-mono font-bold text-ink text-sm">
                            ${pos.totalValueUsd.toFixed(2)}
                          </div>
                          {idxPos && (idxPos.netPnlUsd !== 0 || idxPos.realizedPnlUsd !== 0) && (
                            <div
                              className={`tabular-mono text-[11px] font-semibold ${
                                idxPos.netPnlUsd >= 0 ? "text-positive" : "text-warn"
                              }`}
                            >
                              {idxPos.netPnlUsd >= 0 ? "+" : ""}${idxPos.netPnlUsd.toFixed(2)} PnL
                            </div>
                          )}
                        </td>

                        {/* 1-Click Action Shortcuts */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {/* Trade Button */}
                            <button
                              type="button"
                              onClick={() => handleAction(pos.marketId, "swap")}
                              className="btn-monochrome-secondary inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
                              title="Trade on Swap Desk"
                            >
                              <Repeat className="h-3 w-3" />
                              <span>Trade</span>
                            </button>

                            {/* Redeem Button */}
                            <button
                              type="button"
                              onClick={() => handleAction(pos.marketId, "redeem")}
                              className="btn-monochrome-secondary inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
                              title="Redeem PT"
                            >
                              <Coins className="h-3 w-3" />
                              <span>Redeem</span>
                            </button>

                            {/* Rollover Button */}
                            <button
                              type="button"
                              onClick={() => handleAction(pos.marketId, "rollover")}
                              className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent ${
                                hasMaturedPt
                                  ? "bg-warn text-white shadow-card animate-pulse motion-reduce:animate-none hover:opacity-90"
                                  : "btn-monochrome-secondary"
                              }`}
                              title={
                                hasMaturedPt
                                  ? "Matured PT eligible for immediate 1-click rollover!"
                                  : "Rollover PT into target market"
                              }
                            >
                              <RefreshCw className="h-3 w-3" />
                              <span>Rollover</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile Card View */}
          <div className="space-y-4 md:hidden">
            {displayPositions.map((pos) => {
              const hasMaturedPt = pos.isMatured && pos.ptBalance > 0n;
              const idxPos =
                indexerPositionsByMarket[pos.marketId] ||
                indexerPositionsByMarket[pos.assetCode];

              return (
                <div
                  key={pos.marketId}
                  className="glass-panel border-gradient rounded-2xl p-4 shadow-glass"
                >
                  {/* Card Header */}
                  <div className="flex items-center justify-between pb-3 border-b border-glass-rim">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-muted/60 border border-glass-rim font-mono font-bold text-xs text-ink shadow-glass">
                        <TokenIcon symbol={pos.assetCode} size="sm" showSymbolSrOnly />
                      </div>
                      <div>
                        <div className="font-semibold text-xs text-ink">{pos.marketName}</div>
                        <div className="text-[10px] text-ink-muted">{pos.tenor}</div>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <div className="tabular-mono text-xs font-bold text-ink">
                        ${pos.totalValueUsd.toFixed(2)}
                      </div>
                      {idxPos && (idxPos.netPnlUsd !== 0 || idxPos.realizedPnlUsd !== 0) && (
                        <div
                          className={`tabular-mono text-[10px] font-semibold ${
                            idxPos.netPnlUsd >= 0 ? "text-positive" : "text-warn"
                          }`}
                        >
                          {idxPos.netPnlUsd >= 0 ? "+" : ""}${idxPos.netPnlUsd.toFixed(2)} PnL
                        </div>
                      )}
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                          pos.isMatured
                            ? "border-warn/30 bg-warn-soft text-warn"
                            : "border-positive/20 bg-positive-soft text-positive"
                        }`}
                      >
                        <span>{pos.isMatured ? "Matured" : <><span className="tabular-mono font-mono">{Math.ceil(pos.daysToMaturity)}</span>d left</>}</span>
                      </span>
                    </div>
                  </div>

                  {/* 4-Box Recessed Metrics Grid */}
                  <div className="grid grid-cols-2 gap-2 my-3">
                    <div className="bg-surface-muted/60 border border-glass-rim rounded-xl p-2.5">
                      <div className="text-[10px] text-ink-muted">PT Balance</div>
                      <div className="tabular-mono text-xs font-semibold text-ink mt-0.5">
                        {pos.formattedPtBalance} PT
                      </div>
                    </div>
                    <div className="bg-surface-muted/60 border border-glass-rim rounded-xl p-2.5">
                      <div className="text-[10px] text-ink-muted">
                        {idxPos && idxPos.averageEntryApy > 0 ? "YT · Entry APY" : "YT Balance"}
                      </div>
                      <div className="tabular-mono text-xs font-semibold text-ink mt-0.5">
                        {pos.formattedYtBalance} YT
                      </div>
                      {idxPos && idxPos.averageEntryApy > 0 && (
                        <div className="tabular-mono text-[10px] text-ink-muted">
                          Entry: {idxPos.averageEntryApy.toFixed(2)}%
                        </div>
                      )}
                    </div>
                    <div className="bg-surface-muted/60 border border-glass-rim rounded-xl p-2.5">
                      <div className="text-[10px] text-ink-muted">LP Shares</div>
                      <div className="tabular-mono text-xs font-semibold text-ink mt-0.5">
                        {pos.formattedLpBalance} LP
                      </div>
                    </div>
                    <div className="bg-surface-muted/60 border border-glass-rim rounded-xl p-2.5">
                      <div className="text-[10px] text-ink-muted">Claimable Yield</div>
                      <div className="tabular-mono text-xs font-semibold text-positive mt-0.5">
                        ${pos.claimableYieldUsd.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {/* Card Footer Actions */}
                  <div className="grid grid-cols-3 gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => handleAction(pos.marketId, "swap")}
                      className="btn-monochrome-secondary inline-flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-semibold whitespace-nowrap active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
                    >
                      <Repeat className="h-3 w-3" />
                      <span>Trade</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAction(pos.marketId, "redeem")}
                      className="btn-monochrome-secondary inline-flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-semibold whitespace-nowrap active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
                    >
                      <Coins className="h-3 w-3" />
                      <span>Redeem</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAction(pos.marketId, "rollover")}
                      className={`inline-flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-accent ${
                        hasMaturedPt
                          ? "bg-warn text-white shadow-card animate-pulse motion-reduce:animate-none"
                          : "btn-monochrome-secondary"
                      }`}
                    >
                      <RefreshCw className="h-3 w-3" />
                      <span>Rollover</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
