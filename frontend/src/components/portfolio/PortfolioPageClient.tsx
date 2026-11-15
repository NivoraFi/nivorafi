"use client";

import React, { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { TopNav, ViewMode } from "@/components/TopNav";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TestnetFaucetModal } from "@/components/faucet/TestnetFaucetModal";
import { PlanetStage, DirectionalReveal } from "@/components/ui/motion-primitives";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import { useMultiMarketPortfolio } from "@/hooks/useMultiMarketPortfolio";
import { useTxToast } from "@/hooks/useTxToast";
import {
  getFriendlyActionName,
  prepareChangeTrustUsdcTx,
  prepareContractCallTx,
  requestFriendbotFunding,
  submitSignedHorizonTx,
  submitSignedSorobanTx,
} from "@/lib/stellar";
import { decodeSorobanError } from "@/lib/math";

// Celestial background sphere loaded client-side only
const CelestialSphere = dynamic(() => import("@/components/CelestialSphere"), {
  ssr: false,
});

/**
 * Safe router wrapper to prevent SSR / test invariant errors when useRouter
 * is executed outside Next.js App Router context.
 */
function useSafeRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

export interface PortfolioPageClientProps {
  initialTab?: string;
  initialFilter?: string;
}

export function PortfolioPageClient({
  initialTab,
  initialFilter,
}: PortfolioPageClientProps) {
  const router = useSafeRouter();
  const { address, signTransactionXdr, mode, walletNetworkMismatch, switchNetwork } =
    useWallet();
  const {
    activeMarketId,
    refreshActiveMarket,
    activePortfolio,
  } = useMarket();

  const portfolio = useMultiMarketPortfolio();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [isFaucetOpen, setIsFaucetOpen] = useState(false);

  const {
    notifyTxPending,
    notifyTxConfirming,
    notifyTxSuccess,
    notifyTxError,
  } = useTxToast();

  // Switch between top-level navigation modes
  const handleSwitchView = useCallback(
    (view: ViewMode) => {
      if (view === "portfolio") return;
      const targetUrl =
        view === "trade"
          ? `/trade/${activeMarketId || "usdc-90d"}`
          : "/";

      if (router) {
        try {
          router.push(targetUrl);
          return;
        } catch {
          // fallback to window.location
        }
      }
      if (typeof window !== "undefined") {
        window.location.href = targetUrl;
      }
    },
    [router, activeMarketId]
  );

  // Navigate to specific trade desk market and tab
  const handleNavigateToTrade = useCallback(
    (
      marketId: string,
      tab: "swap" | "redeem" | "rollover" | "mint" | "liquidity" | string
    ) => {
      const targetMarket = marketId || activeMarketId || "usdc-90d";
      const targetTab = tab || "swap";
      const targetUrl = `/trade/${targetMarket}?tab=${targetTab}`;

      if (router) {
        try {
          router.push(targetUrl);
          return;
        } catch {
          // fallback to window.location
        }
      }
      if (typeof window !== "undefined") {
        window.location.href = targetUrl;
      }
    },
    [router, activeMarketId]
  );

  // Fallback trade switch
  const handleSwitchToTrade = useCallback(
    (tab?: string) => {
      handleNavigateToTrade(activeMarketId || "usdc-90d", tab || "swap");
    },
    [handleNavigateToTrade, activeMarketId]
  );

  // Coordinated refresh across portfolio balances and market snapshot
  const handleRefresh = useCallback(async () => {
    await Promise.allSettled([portfolio.refetch(), refreshActiveMarket()]);
  }, [portfolio, refreshActiveMarket]);

  // Execute smart contract actions (e.g. claim yield)
  const handleExecuteAction = useCallback(
    async (params: {
      contractId: string;
      method: string;
      args: any[];
      label: string;
      simulateOnly?: boolean;
    }) => {
      if (!address) return;
      const friendlyName = getFriendlyActionName(params.method);
      const toastLabel = params.label || friendlyName;
      setBusyAction(`Submitting ${friendlyName}...`);
      const toastId = notifyTxPending(toastLabel, "Awaiting wallet signature...");
      let activeTxHash: string | undefined;

      try {
        const prepared = await prepareContractCallTx({
          sourceAddress: address,
          contractId: params.contractId,
          method: params.method,
          args: params.args,
          label: toastLabel,
        });
        const signedXdr = await signTransactionXdr(prepared.unsignedXdr);

        setBusyAction(`Confirming ${friendlyName}...`);
        const submitted = await submitSignedSorobanTx(signedXdr, (txHash) => {
          activeTxHash = txHash;
          notifyTxConfirming(toastId, txHash, toastLabel);
        });

        activeTxHash = submitted.hash;
        notifyTxSuccess(toastId, submitted.hash, toastLabel);
        await Promise.allSettled([portfolio.refetch(), refreshActiveMarket()]);
      } catch (err) {
        const msg = decodeSorobanError(err);
        console.error("[Portfolio] Action execution failed:", msg);
        notifyTxError(toastId, err, (err as any)?.txHash || activeTxHash, toastLabel);
        throw err;
      } finally {
        setBusyAction(null);
      }
    },
    [
      address,
      signTransactionXdr,
      portfolio,
      refreshActiveMarket,
      notifyTxPending,
      notifyTxConfirming,
      notifyTxSuccess,
      notifyTxError,
    ]
  );

  // Friendbot XLM funding
  const handleFundXlm = useCallback(async () => {
    if (!address) return;
    setBusyAction("Requesting Friendbot XLM...");
    const toastId = notifyTxPending("Friendbot XLM", "Requesting 10,000 testnet XLM...");
    try {
      await requestFriendbotFunding(address);
      notifyTxSuccess(toastId, "", "Friendbot XLM", "10,000 Testnet XLM credited to wallet.");
      await portfolio.refetch();
    } catch (err) {
      console.error("[Portfolio] Friendbot funding error:", decodeSorobanError(err));
      notifyTxError(toastId, err, undefined, "Friendbot XLM");
    } finally {
      setBusyAction(null);
    }
  }, [address, portfolio, notifyTxPending, notifyTxSuccess, notifyTxError]);

  // USDC Trustline addition
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
      await portfolio.refetch();
    } catch (err) {
      console.error("[Portfolio] Trustline error:", decodeSorobanError(err));
      notifyTxError(toastId, err, (err as any)?.txHash, "USDC Trustline");
    } finally {
      setBusyAction(null);
    }
  }, [address, signTransactionXdr, portfolio, notifyTxPending, notifyTxSuccess, notifyTxError]);

  // Keyboard navigation shortcuts: 'T' for Trade Desk, 'Esc' for Landing
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

      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        handleSwitchView("trade");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSwitchView]);

  return (
    <div className="relative min-h-screen bg-canvas text-ink flex flex-col font-sans selection:bg-accent selection:text-accent-ink overflow-x-clip">
      {/* Background Celestial visual layer */}
      <PlanetStage dimmed={true} className="fixed inset-0 pointer-events-none z-0 overflow-hidden opacity-30">
        <ErrorBoundary fallback={<div className="fixed inset-0 bg-canvas" />}>
          <CelestialSphere dimmed={true} />
        </ErrorBoundary>
      </PlanetStage>

      <div className="relative z-10 w-full flex-1 flex flex-col">
        {/* Institutional Top Navigation */}
        <DirectionalReveal from="top" distance={16} duration={0.40}>
          <TopNav
            viewMode="portfolio"
            onToggleView={handleSwitchView}
            onRefresh={() => void handleRefresh()}
            refreshing={portfolio.isLoading}
            onFundXlm={() => void handleFundXlm()}
            onAddUsdcTrustline={() => void handleAddUsdcTrustline()}
            onOpenFaucet={() => setIsFaucetOpen(true)}
            usdcTrustlineExists={activePortfolio ? activePortfolio.usdcTrustlineExists : null}
            accountExists={activePortfolio ? activePortfolio.accountExists : null}
            busyAction={busyAction}
          />
        </DirectionalReveal>

        {/* Main Content Area */}
        <main className="mx-auto w-full max-w-7xl px-4 py-6 pb-24 sm:py-8 sm:pb-16 flex-1 flex flex-col space-y-6">
          <DirectionalReveal from="bottom" delay={0.08} distance={20} duration={0.52} className="w-full">
            <PortfolioView
              onSelectMarketAndTab={handleNavigateToTrade}
              onNavigateToTrade={handleNavigateToTrade}
              onSwitchToTrade={handleSwitchToTrade}
              onExecuteAction={handleExecuteAction}
              busyAction={busyAction}
              onRefresh={handleRefresh}
              refreshing={portfolio.isLoading}
            />
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
