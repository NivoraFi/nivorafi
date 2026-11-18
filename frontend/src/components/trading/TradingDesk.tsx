"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Coins, Layers, RefreshCw, Repeat, Sparkles, Zap } from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { LiveMarketSnapshot, LiveUserPortfolio, buildActionArgs } from "@/lib/stellar";
import { SwapCard } from "./SwapCard";
import { ZapCard } from "./ZapCard";
import { MintCard } from "./MintCard";
import { LiquidityCard } from "./LiquidityCard";
import { RedeemCard } from "./RedeemCard";
import { RolloverCard } from "./RolloverCard";

export type DeskTab = "swap" | "zap" | "mint" | "liquidity" | "redeem" | "rollover";

export interface TradingDeskProps {
  snapshot: LiveMarketSnapshot | null;
  portfolio: LiveUserPortfolio | null;
  busyAction: string | null;
  busyActions?: Record<string, string>;
  onExecuteAction: (params: {
    contractId: string;
    method: string;
    args: ReturnType<typeof buildActionArgs>["args"];
    label: string;
    simulateOnly?: boolean;
  }) => Promise<void>;
  onOpenDevDrawer?: () => void;
  className?: string;
  activeTab?: DeskTab;
  onTabChange?: (tab: DeskTab) => void;
  onAddTrustline?: () => Promise<void> | void;
}

export function TradingDesk({
  snapshot,
  portfolio,
  busyAction,
  busyActions,
  onExecuteAction,
  onOpenDevDrawer,
  className = "",
  activeTab: controlledTab,
  onTabChange,
  onAddTrustline,
}: TradingDeskProps) {
  const { walletNetworkMismatch, switchNetwork } = useWallet();
  const [internalTab, setInternalTab] = useState<DeskTab>(() => {
    if (typeof window !== "undefined") {
      try {
        const params = new URLSearchParams(window.location.search);
        const tabParam = params.get("tab") as DeskTab | null;
        if (tabParam && ["swap", "zap", "mint", "liquidity", "redeem", "rollover"].includes(tabParam)) {
          return tabParam;
        }
      } catch {
        // safe fallback for SSR
      }
    }
    return "swap";
  });
  const activeTab = controlledTab ?? internalTab;

  const syncUrlTab = useCallback((tab: DeskTab) => {
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get("tab") !== tab) {
          url.searchParams.set("tab", tab);
          window.history.replaceState(window.history.state, "", url.toString());
        }
      } catch {
        // safe fallback for SSR / non-DOM environments
      }
    }
  }, []);

  const handleTabChange = useCallback(
    (tab: DeskTab) => {
      if (onTabChange) {
        onTabChange(tab);
      } else {
        setInternalTab(tab);
      }
      syncUrlTab(tab);
    },
    [onTabChange, syncUrlTab]
  );

  useEffect(() => {
    syncUrlTab(activeTab);
  }, [activeTab, syncUrlTab]);

  const tabs: Array<{ id: DeskTab; label: string; icon: React.ReactNode }> = [
    { id: "swap", label: "Swap", icon: <Repeat className="h-3.5 w-3.5" /> },
    { id: "mint", label: "Mint", icon: <Sparkles className="h-3.5 w-3.5" /> },
    { id: "liquidity", label: "Pool", icon: <Layers className="h-3.5 w-3.5" /> },
    { id: "redeem", label: "Redeem", icon: <Coins className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className={`w-full ${className}`}>
      <div className="glass-panel double-bezel rounded-2xl overflow-hidden shadow-glass-elevated h-full flex flex-col justify-between">
        {/* Network Mismatch Warning Banner */}
        {walletNetworkMismatch && (
          <div className="border-b border-warn/30 bg-warn-soft px-4 py-2 text-xs font-semibold text-warn flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warn" />
              <span>Wallet is on wrong network.</span>
            </div>
            <button
              type="button"
              onClick={() => void switchNetwork()}
              className="rounded-lg bg-warn px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition shrink-0 cursor-pointer whitespace-nowrap"
            >
              Switch to Testnet
            </button>
          </div>
        )}

        {/* Desk Header & Segmented Tab Navigation */}
        <div className="flex items-center justify-between border-b border-glass-rim px-4 sm:px-5 py-3 bg-surface-muted/40 backdrop-blur-md">
          <h2 className="sr-only tabular-mono">Trade Fixed Yield</h2>

          <nav className="relative grid grid-cols-4 items-center gap-1 rounded-xl bg-surface-muted/70 p-1 border border-glass-rim w-full shadow-inner backdrop-blur-md">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleTabChange(tab.id)}
                  className={`group relative inline-flex items-center justify-center gap-1 sm:gap-1.5 rounded-lg border px-2 sm:px-2.5 py-2 sm:py-1.5 text-xs font-semibold whitespace-nowrap transition-colors duration-150 cursor-pointer ${
                    isActive
                      ? "bg-surface text-ink shadow-sm border-hairline glass-card border-glass-rim shadow-glass"
                      : "border-transparent text-ink-secondary hover:text-ink hover:bg-surface-hover/60"
                  }`}
                >
                  <span className={`transition-colors ${isActive ? "text-accent" : "text-ink-muted group-hover:text-ink-secondary"}`}>
                    {tab.icon}
                  </span>
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Tab Content Stage */}
        <div className="p-4 sm:p-5">
          {activeTab === "swap" && (
            <SwapCard
              snapshot={snapshot}
              portfolio={portfolio}
              busyAction={busyAction}
              busyActions={busyActions}
              onExecuteAction={onExecuteAction}
              onOpenDevDrawer={onOpenDevDrawer}
              onSwitchTab={handleTabChange}
            />
          )}

          {activeTab === "mint" && (
            <MintCard
              snapshot={snapshot}
              portfolio={portfolio}
              busyAction={busyAction}
              busyActions={busyActions}
              onExecuteAction={onExecuteAction}
              onOpenDevDrawer={onOpenDevDrawer}
              onAddTrustline={onAddTrustline}
            />
          )}

          {activeTab === "liquidity" && (
            <LiquidityCard
              snapshot={snapshot}
              portfolio={portfolio}
              busyAction={busyAction}
              busyActions={busyActions}
              onExecuteAction={onExecuteAction}
              onOpenDevDrawer={onOpenDevDrawer}
              onSwitchTab={handleTabChange}
            />
          )}

          {activeTab === "redeem" && (
            <RedeemCard
              snapshot={snapshot}
              portfolio={portfolio}
              busyAction={busyAction}
              busyActions={busyActions}
              onExecuteAction={onExecuteAction}
              onOpenDevDrawer={onOpenDevDrawer}
              onSwitchToRollover={() => handleTabChange("rollover")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
