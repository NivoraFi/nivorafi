"use client";

import React, { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { TopNav } from "@/components/TopNav";
import { LandingView } from "@/components/landing/LandingView";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { AnalyticsCard } from "@/components/trading/AnalyticsCard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PlanetStage, DirectionalReveal } from "@/components/ui/motion-primitives";
import { TestnetFaucetModal } from "@/components/faucet/TestnetFaucetModal";
import { useWallet } from "@/context/WalletProvider";
import { MarketProvider, useMarket } from "@/context/MarketContext";
import { useEventIndexer } from "@/hooks/useEventIndexer";
import { useTxToast } from "@/hooks/useTxToast";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import { decodeSorobanError, shortenAddress } from "@/lib/math";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  WireLogEntry,
  buildActionArgs,
  fetchMarketSnapshot,
  fetchUserPortfolio,
  getFriendlyActionName,
  prepareChangeTrustUsdcTx,
  prepareContractCallTx,
  requestFriendbotFunding,
  submitSignedHorizonTx,
  submitSignedSorobanTx,
} from "@/lib/stellar";

export type ViewMode = "landing" | "trade" | "portfolio";

export type TxLifecycleStage = "IDLE" | "PENDING" | "CONFIRMING" | "CONFIRMED" | "FAILED";

export interface ActiveTransaction {
  id: string;
  stage: TxLifecycleStage;
  label: string;
  method: string;
  contractId: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
  submittedAt?: number;
}

// Dynamically import Three.js Celestial Sphere with SSR disabled
const CelestialSphere = dynamic(() => import("@/components/CelestialSphere"), {
  ssr: false,
});

function nowClock(): string {
  return new Date().toISOString().slice(11, 19);
}

function makeLogId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function TradingDeskContent() {
  const { address, signTransactionXdr, connectWallet } = useWallet();
  const {
    activeMarket,
    activeSnapshot: snapshot,
    activePortfolio: portfolio,
    loadingSnapshot: loadingMarket,
    refreshActiveMarket,
    selectMarket,
  } = useMarket();

  const [viewMode, setViewMode] = useState<ViewMode>("landing");
  const [deskTab, setDeskTab] = useState<DeskTab>("swap");
  const [isFaucetOpen, setIsFaucetOpen] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyActions, setBusyActions] = useState<Record<string, string>>({});

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const {
    notifyTxPending,
    notifyTxConfirming,
    notifyTxSuccess,
    notifyTxError,
  } = useTxToast();

  const {
    analytics,
    liveFeed,
    myHistory,
    isSyncing: isIndexerSyncing,
    refresh: refreshIndexer,
  } = useEventIndexer({
    pollIntervalMs: 10000,
    autoPoll: true,
    userAddress: address,
    maturityTimestamp: snapshot?.state?.maturity
      ? Number(snapshot.state.maturity)
      : activeMarket.maturity,
  });
  const [logs, setLogs] = useState<WireLogEntry[]>([]);
  const [isDevDrawerOpen, setIsDevDrawerOpen] = useState(false);
  const [unreadLogCount, setUnreadLogCount] = useState(0);

  const pushLog = useCallback((entry: Omit<WireLogEntry, "id" | "timestamp">) => {
    setLogs((prev) => [{ ...entry, id: makeLogId(), timestamp: nowClock() }, ...prev].slice(0, 50));
    setUnreadLogCount((prev) => prev + 1);
  }, []);

  const openDrawer = useCallback(() => {
    setIsDevDrawerOpen(true);
    setUnreadLogCount(0);
  }, []);

  const closeDrawer = useCallback(() => {
    setIsDevDrawerOpen(false);
  }, []);

  const handleSwitchView = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (mode === "trade") {
        url.searchParams.set("view", "trade");
      } else if (mode === "portfolio") {
        url.searchParams.set("view", "portfolio");
      } else {
        url.searchParams.delete("view");
        if (url.hash === "#trade" || url.hash === "#portfolio") {
          url.hash = "";
        }
      }
      window.history.pushState({}, "", url.toString());
    }
  }, []);

  const handleNavigateToTrade = useCallback(
    (marketId: string, tab: string) => {
      selectMarket(marketId);
      setDeskTab(tab as DeskTab);
      handleSwitchView("trade");
    },
    [selectMarket, handleSwitchView]
  );

  const handleSwitchToTradeDesk = useCallback(
    (tab: string = "swap") => {
      setDeskTab(tab as DeskTab);
      handleSwitchView("trade");
    },
    [handleSwitchView]
  );

  // Sync initial view from URL query (?view=trade | ?view=portfolio) or hash (#trade | #portfolio) & handle browser Back/Forward
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get("view");
    const hash = window.location.hash;
    if (viewParam === "trade" || hash === "#trade") {
      setViewMode("trade");
    } else if (viewParam === "portfolio" || hash === "#portfolio") {
      setViewMode("portfolio");
    }

    const handlePopState = () => {
      const p = new URLSearchParams(window.location.search);
      const v = p.get("view");
      const h = window.location.hash;
      if (v === "trade" || h === "#trade") {
        setViewMode("trade");
      } else if (v === "portfolio" || h === "#portfolio") {
        setViewMode("portfolio");
      } else {
        setViewMode("landing");
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Keyboard navigation: 'T' / Enter to enter desk, 'P' to view portfolio, 'Esc' to return to landing or close drawer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      // Modifier key isolation: do not intercept browser shortcuts (e.g. Cmd+T, Ctrl+T, Alt+T)
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      if (e.key === "Escape") {
        if (isDevDrawerOpen) {
          closeDrawer();
        }
        return;
      }

      if (viewMode === "landing") {
        if (e.key === "t" || e.key === "T" || e.key === "Enter") {
          handleSwitchView("trade");
        } else if (e.key === "p" || e.key === "P") {
          handleSwitchView("portfolio");
        }
      } else if (viewMode === "trade") {
        if (e.key === "p" || e.key === "P") {
          handleSwitchView("portfolio");
        }
      } else if (viewMode === "portfolio") {
        if (e.key === "t" || e.key === "T") {
          handleSwitchView("trade");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode, isDevDrawerOpen, closeDrawer, handleSwitchView]);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([refreshActiveMarket(), refreshIndexer()]);
    } catch (err) {
      const errToast = notifyTxPending("Refresh Market", "Syncing market state...");
      notifyTxError(errToast, err, undefined, "Refresh Market");
    }
  }, [refreshActiveMarket, refreshIndexer, notifyTxPending, notifyTxError]);

  const handleFundXlm = useCallback(async () => {
    if (!address) return;
    setBusyAction("Funding Friendbot XLM...");
    const toastId = notifyTxPending("Friendbot XLM", "Requesting 10,000 testnet XLM...");
    try {
      await requestFriendbotFunding(address);
      pushLog({
        stage: "FAUCET",
        method: "friendbot",
        contractId: address,
        message: "Funded 10,000 Testnet XLM via Friendbot.",
      });
      notifyTxSuccess(toastId, "", "Friendbot XLM", "10,000 Testnet XLM credited to wallet.");
      await refreshAll();
    } catch (err) {
      const msg = decodeSorobanError(err);
      pushLog({
        stage: "ERROR",
        method: "friendbot",
        contractId: address,
        message: msg,
      });
      notifyTxError(toastId, err, undefined, "Friendbot XLM");
    } finally {
      setBusyAction(null);
    }
  }, [address, pushLog, refreshAll, notifyTxPending, notifyTxSuccess, notifyTxError]);

  const handleAddUsdcTrustline = useCallback(async () => {
    if (!address) return;
    setBusyAction("Signing USDC Trustline...");
    const toastId = notifyTxPending("USDC Trustline", "Signing USDC trustline on Horizon...");
    try {
      const unsignedXdr = await prepareChangeTrustUsdcTx(address);
      pushLog({
        stage: "SIGN",
        method: "change_trust(USDC)",
        contractId: STELLAR_PENDLE_CONFIG.market.underlyingAsset.sacContractId,
        message: "Prepared Classic USDC trustline XDR for Freighter/LOBSTR signature.",
        unsignedXdr,
      });
      const signedXdr = await signTransactionXdr(unsignedXdr);
      const res = await submitSignedHorizonTx(signedXdr);
      pushLog({
        stage: "CONFIRMED",
        method: "change_trust(USDC)",
        contractId: STELLAR_PENDLE_CONFIG.market.underlyingAsset.sacContractId,
        message: "Added Circle Testnet USDC trustline on Horizon.",
        txHash: res.hash,
      });
      notifyTxSuccess(toastId, res.hash, "USDC Trustline", "USDC trustline established on Testnet.");
      await refreshAll();
    } catch (err) {
      const msg = decodeSorobanError(err);
      pushLog({
        stage: "ERROR",
        method: "change_trust(USDC)",
        contractId: STELLAR_PENDLE_CONFIG.market.underlyingAsset.sacContractId,
        message: msg,
      });
      notifyTxError(toastId, err, (err as any)?.txHash, "USDC Trustline");
    } finally {
      setBusyAction(null);
    }
  }, [address, pushLog, refreshAll, signTransactionXdr, notifyTxPending, notifyTxSuccess, notifyTxError]);

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

      if (params.simulateOnly) {
        const simToastId = notifyTxPending(params.label, "Running dry-run simulation...");
        try {
          const prepared = await prepareContractCallTx({
            sourceAddress,
            contractId: params.contractId,
            method: params.method,
            args: params.args,
            label: params.label,
          });

          pushLog({
            stage: "SIMULATE",
            method: params.method,
            contractId: params.contractId,
            message: `Dry-run succeeded with ${prepared.stateChangeCount} state transitions.`,
            minResourceFee: prepared.minResourceFeeStroops,
            ledger: prepared.latestLedger,
            unsignedXdr: prepared.unsignedXdr,
            simulatedReturn: prepared.simulatedReturn,
          });

          notifyTxSuccess(
            simToastId,
            "",
            params.label,
            `Dry-run simulation verified for ${actionName}.`
          );
          openDrawer();
          return;
        } catch (simErr) {
          const msg = decodeSorobanError(simErr);
          notifyTxError(simToastId, simErr, undefined, params.label);
          pushLog({
            stage: "ERROR",
            method: params.method,
            contractId: params.contractId,
            message: msg,
          });
          return;
        } finally {
          setActionBusy(null);
        }
      }

      const toastId = notifyTxPending(params.label, "Awaiting wallet signature...");
      let activeTxHash: string | undefined;

      try {
        const prepared = await prepareContractCallTx({
          sourceAddress,
          contractId: params.contractId,
          method: params.method,
          args: params.args,
          label: params.label,
        });

        pushLog({
          stage: "SIMULATE",
          method: params.method,
          contractId: params.contractId,
          message: "Simulation succeeded. Awaiting wallet signature...",
          minResourceFee: prepared.minResourceFeeStroops,
          ledger: prepared.latestLedger,
          unsignedXdr: prepared.unsignedXdr,
          simulatedReturn: prepared.simulatedReturn,
        });

        setActionBusy("Awaiting Signature...");
        const signedXdr = await signTransactionXdr(prepared.unsignedXdr);

        setActionBusy(`Submitting ${actionName}...`);
        pushLog({
          stage: "SUBMIT",
          method: params.method,
          contractId: params.contractId,
          message: "Broadcasted signed envelope to Soroban RPC.",
        });

        const submitted = await submitSignedSorobanTx(signedXdr, (txHash) => {
          activeTxHash = txHash;
          setActionBusy(`Confirming ${actionName}...`);
          notifyTxConfirming(toastId, txHash, params.label);
          pushLog({
            stage: "CONFIRMING",
            method: params.method,
            contractId: params.contractId,
            message: `Transaction accepted by RPC [tx: ${shortenAddress(txHash, 6, 6)}]. Awaiting ledger confirmation...`,
            txHash,
          });
        });

        activeTxHash = submitted.hash;
        pushLog({
          stage: "CONFIRMED",
          method: params.method,
          contractId: params.contractId,
          message: `${params.label} settled on Testnet.`,
          txHash: submitted.hash,
          simulatedReturn: submitted.returnValue,
        });

        notifyTxSuccess(toastId, submitted.hash, params.label);
        await refreshAll();
      } catch (err) {
        const failedTxHash = (err as any)?.txHash || activeTxHash;
        const msg = decodeSorobanError(err);
        pushLog({
          stage: "ERROR",
          method: params.method,
          contractId: params.contractId,
          message: msg,
          txHash: failedTxHash,
        });
        notifyTxError(toastId, err, failedTxHash, params.label);
      } finally {
        setActionBusy(null);
      }
    },
    [
      address,
      pushLog,
      refreshAll,
      signTransactionXdr,
      openDrawer,
      notifyTxPending,
      notifyTxConfirming,
      notifyTxSuccess,
      notifyTxError,
    ]
  );

  return (
    <div className="relative min-h-screen bg-canvas overflow-x-hidden selection:bg-accent selection:text-accent-ink flex flex-col justify-between">
      {/* 3D Celestial Background Canvas */}
      <PlanetStage dimmed={viewMode !== "landing"} className="fixed inset-0 pointer-events-none z-0">
        <ErrorBoundary fallback={<div className="fixed inset-0 pointer-events-none bg-canvas" />} componentName="CelestialSphere">
          <CelestialSphere dimmed={viewMode !== "landing"} />
        </ErrorBoundary>
      </PlanetStage>

      <div className="relative z-10 w-full flex-1 flex flex-col">
        {/* Top Navbar */}
        {viewMode !== "landing" && (
          <DirectionalReveal from="top" distance={16} duration={0.42}>
            <TopNav
              viewMode={viewMode}
              onToggleView={handleSwitchView}
              onRefresh={() => void refreshAll()}
              refreshing={loadingMarket}
              onFundXlm={() => void handleFundXlm()}
              onAddUsdcTrustline={() => void handleAddUsdcTrustline()}
              onOpenFaucet={() => setIsFaucetOpen(true)}
              usdcTrustlineExists={portfolio ? portfolio.usdcTrustlineExists : null}
              accountExists={portfolio ? portfolio.accountExists : null}
              busyAction={busyAction}
            />
          </DirectionalReveal>
        )}

        {/* Main Viewport Container */}
        <main className="mx-auto w-full max-w-7xl px-4 py-8 pb-24 sm:py-16 sm:pb-16 flex-1 flex flex-col justify-center">

          {/* View Switcher: Landing Page vs Portfolio vs Trading Desk */}
          {viewMode === "landing" ? (
            <LandingView
              onEnterDesk={() => handleSwitchView("trade")}
              snapshot={snapshot}
            />
          ) : viewMode === "portfolio" ? (
            <DirectionalReveal from="bottom" distance={20} duration={0.52} className="w-full">
              <PortfolioView
                onSelectMarketAndTab={handleNavigateToTrade}
                onNavigateToTrade={handleNavigateToTrade}
                onSwitchToTrade={handleSwitchToTradeDesk}
                onExecuteAction={handleExecuteAction}
                busyAction={busyAction}
                onRefresh={refreshAll}
                refreshing={loadingMarket}
              />
            </DirectionalReveal>
          ) : (
            <div className="w-full">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
                {/* Left Wing: Analytics */}
                <DirectionalReveal from="left" delay={0.08} distance={26} duration={0.56} className="lg:col-span-7 flex flex-col order-2 lg:order-1">
                  <AnalyticsCard
                    analytics={hasMounted ? analytics : null}
                    daysToMaturity={snapshot?.daysToMaturity}
                    loading={loadingMarket || (isIndexerSyncing && !analytics)}
                    className="h-full flex flex-col justify-between"
                  />
                </DirectionalReveal>

                {/* Right Wing: Core Trading Desk Order Router */}
                <DirectionalReveal from="right" delay={0.14} distance={26} duration={0.56} className="lg:col-span-5 order-1 lg:order-2 w-full flex flex-col">
                  <TradingDesk
                    snapshot={snapshot}
                    portfolio={portfolio}
                    busyAction={busyAction}
                    busyActions={busyActions}
                    onExecuteAction={handleExecuteAction}
                    activeTab={deskTab}
                    onTabChange={setDeskTab}
                    className="h-full flex flex-col justify-between"
                  />
                </DirectionalReveal>
              </div>
            </div>
          )}
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

export default function HomePage() {
  return <TradingDeskContent />;
}
