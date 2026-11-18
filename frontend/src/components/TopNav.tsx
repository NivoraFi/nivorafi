"use client";

import React, { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowRight,
  Droplets,
  Layers,
  Menu,
  PieChart,
  Repeat,
} from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { MarketSelector } from "@/components/trading/MarketSelector";
import { NetworkBadge } from "./navigation/NetworkBadge";
import { WalletButton } from "./navigation/WalletButton";
import { MobileNavDrawer } from "./navigation/MobileNavDrawer";

export type ViewMode = "landing" | "trade" | "portfolio";

export interface TopNavProps {
  viewMode?: ViewMode;
  activeTab?: "markets" | "trade" | "pools" | "portfolio";
  onToggleView?: (view: ViewMode) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onFundXlm?: () => void;
  onAddUsdcTrustline?: () => void;
  usdcTrustlineExists?: boolean | null;
  accountExists?: boolean | null;
  busyAction?: string | null;
  onOpenFaucet?: () => void;
  onOpenDevDrawer?: () => void;
  unreadLogsCount?: number;
}

function useSafePathname() {
  try {
    return usePathname();
  } catch {
    return null;
  }
}

export function TopNav({
  viewMode = "landing",
  activeTab,
  onToggleView,
  onRefresh: _onRefresh,
  refreshing: _refreshing,
  onFundXlm: _onFundXlm,
  onAddUsdcTrustline: _onAddUsdcTrustline,
  usdcTrustlineExists: _usdcTrustlineExists,
  accountExists: _accountExists,
  busyAction: _busyAction,
  onOpenFaucet,
  onOpenDevDrawer: _onOpenDevDrawer,
  unreadLogsCount: _unreadLogsCount = 0,
}: TopNavProps) {
  const {
    address,
    mode,
    walletNetworkMismatch,
    connecting,
    connectWallet,
    disconnect,
    switchNetwork,
  } = useWallet();

  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const pathname = useSafePathname();

  const handleViewLinkClick = (
    e: React.MouseEvent<HTMLAnchorElement> | undefined,
    targetView: ViewMode
  ) => {
    if (!onToggleView) return;
    if (pathname === "/") {
      e?.preventDefault?.();
    }
    if (!e || !pathname || pathname === "/") {
      onToggleView(targetView);
    }
  };

  // Active tab resolution supporting route params and in-page view switching
  const isPortfolioActive =
    activeTab === "portfolio" ||
    (activeTab === undefined &&
      (viewMode === "portfolio" || (viewMode === undefined && pathname === "/portfolio")));

  const isPoolsActive =
    activeTab === "pools" ||
    (activeTab === undefined &&
      (pathname === "/pools" || pathname?.includes("tab=liquidity")));

  const isTradeActive =
    activeTab === "trade" ||
    (activeTab === undefined &&
      (viewMode === "trade" || (viewMode === undefined && (pathname?.startsWith("/trade") ?? false))) &&
      !isPortfolioActive &&
      !isPoolsActive);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-glass-rim bg-glass-panel backdrop-blur-xl shadow-glass">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        {/* Brand & Protocol Tag */}
        <Link
          href="/"
          onClick={(e) => handleViewLinkClick(e, "landing")}
          className="flex items-center gap-3 shrink-0 cursor-pointer"
          title="Return to Landing Page"
        >
          <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-glass-card border border-glass-rim overflow-hidden p-1 shadow-glass">
            <Image
              src="/icon.svg"
              alt="NivoraFi Logo"
              width={36}
              height={36}
              className="object-contain"
              priority
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold tracking-tight text-ink">
                NivoraFi
              </span>
              {/* Subtle Network Status Indicator */}
              <NetworkBadge
                walletNetworkMismatch={walletNetworkMismatch}
                onSwitchNetwork={switchNetwork}
              />
            </div>
          </div>
        </Link>

        {/* Global Action Controls */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Pendle V2 Center/Right Navigation Pill Group */}
          {onToggleView ? (
            viewMode === "landing" && !isPortfolioActive ? (
              <div className="flex items-center gap-1.5 sm:gap-2">
                <Link
                  href="/trade/usdc-90d"
                  onClick={(e) => handleViewLinkClick(e, "trade")}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-glass-rim bg-glass-card px-3 py-1.5 text-xs font-semibold text-ink whitespace-nowrap transition-colors hover:bg-glass-interactive hover:border-hairline-strong cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none"
                  title="Enter Trade Desk (T)"
                >
                  <span>Trade Desk</span>
                  <ArrowRight className="h-3.5 w-3.5 text-ink-secondary" />
                </Link>
                <Link
                  href="/pools"
                  className={`hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-glass-rim bg-glass-card px-2.5 sm:px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors hover:bg-glass-interactive hover:text-ink cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${
                    isPoolsActive ? "text-accent bg-accent-soft border-accent/20" : "text-ink-secondary"
                  }`}
                  title="Liquidity Pools"
                >
                  <Layers className="h-3.5 w-3.5 text-ink-muted" />
                  <span>Pools</span>
                </Link>
                <Link
                  href="/portfolio"
                  onClick={(e) => handleViewLinkClick(e, "portfolio")}
                  className={`inline-flex items-center gap-1.5 rounded-xl border border-glass-rim bg-glass-card px-2.5 sm:px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${
                    isPortfolioActive
                      ? "bg-accent text-accent-ink shadow-accent"
                      : "text-ink-secondary hover:bg-glass-interactive hover:text-ink"
                  }`}
                  title="View Portfolio (P)"
                >
                  <PieChart className="h-3.5 w-3.5 text-ink-muted" />
                  <span className="hidden sm:inline">Portfolio</span>
                </Link>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 sm:gap-2">
                <nav
                  aria-label="View Switcher"
                  className="inline-flex items-center rounded-xl bg-glass-card p-1 border border-glass-rim shadow-glass"
                >
                  <Link
                    href="/trade/usdc-90d"
                    onClick={(e) => handleViewLinkClick(e, "trade")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none ${
                      isTradeActive
                        ? "bg-accent text-accent-ink shadow-sm"
                        : "text-ink-secondary hover:text-ink hover:bg-glass-interactive"
                    }`}
                    title="Trade Desk (T)"
                  >
                    <Repeat className="h-3.5 w-3.5" />
                    <span>Trade</span>
                  </Link>
                  <Link
                    href="/pools"
                    className={`hidden sm:inline-flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none ${
                      isPoolsActive
                        ? "bg-accent text-accent-ink shadow-sm"
                        : "text-ink-secondary hover:text-ink hover:bg-glass-interactive"
                    }`}
                    title="Liquidity Pools"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    <span>Pools</span>
                  </Link>
                  <Link
                    href="/portfolio"
                    onClick={(e) => handleViewLinkClick(e, "portfolio")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none ${
                      isPortfolioActive
                        ? "bg-accent text-accent-ink shadow-sm"
                        : "text-ink-secondary hover:text-ink hover:bg-glass-interactive"
                    }`}
                    title="My Portfolio (P)"
                  >
                    <PieChart className="h-3.5 w-3.5" />
                    <span>Portfolio</span>
                  </Link>
                </nav>
              </div>
            )
          ) : (
            // Static route standalone links
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Link
                href="/trade/usdc-90d"
                className={`inline-flex items-center gap-1.5 rounded-xl border border-glass-rim px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${
                  isTradeActive
                    ? "bg-accent text-accent-ink shadow-sm"
                    : "bg-glass-card text-ink-secondary hover:text-ink hover:bg-glass-interactive"
                }`}
                title="Trade Desk"
              >
                <span>Trade</span>
              </Link>
              <Link
                href="/pools"
                className={`hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-glass-rim px-2.5 sm:px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${
                  isPoolsActive
                    ? "bg-accent text-accent-ink shadow-sm"
                    : "bg-glass-card text-ink-secondary hover:text-ink hover:bg-glass-interactive"
                }`}
                title="Pools"
              >
                <span>Pools</span>
              </Link>
              <Link
                href="/portfolio"
                className={`inline-flex items-center gap-1.5 rounded-xl border border-glass-rim px-2.5 sm:px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${
                  isPortfolioActive
                    ? "bg-accent text-accent-ink shadow-sm"
                    : "bg-glass-card text-ink-secondary hover:text-ink hover:bg-glass-interactive"
                }`}
                title="Portfolio"
              >
                <span>Portfolio</span>
              </Link>
            </div>
          )}

          {/* Compact Market Switcher Trigger (Trade context only) */}
          {isTradeActive && (
            <div className="hidden sm:flex items-center">
              <MarketSelector compact />
            </div>
          )}

          {/* Testnet Faucet Trigger Button */}
          {onOpenFaucet && (
            <button
              type="button"
              onClick={onOpenFaucet}
              className="inline-flex items-center gap-1.5 rounded-xl border border-glass-rim bg-glass-card px-2.5 sm:px-3 py-1.5 text-xs font-medium text-ink-secondary whitespace-nowrap transition-colors hover:bg-glass-interactive hover:text-ink cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none disabled:opacity-50"
              title="Get Testnet Assets (Faucet)"
            >
              <Droplets className="h-3.5 w-3.5 text-accent" />
              <span className="hidden sm:inline">Faucet</span>
            </button>
          )}

          {/* Wallet State Button */}
          <WalletButton
            address={address}
            connecting={connecting}
            onConnect={connectWallet}
            onDisconnect={disconnect}
          />

          {/* Mobile Navigation Drawer Toggle */}
          <button
            type="button"
            onClick={() => setMobileDrawerOpen(true)}
            className="flex md:hidden items-center justify-center rounded-xl border border-glass-rim bg-glass-card p-2 text-ink-secondary hover:text-ink hover:bg-glass-interactive transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none disabled:opacity-50"
            aria-label="Open mobile menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>

      {walletNetworkMismatch && (
        <div className="border-t border-warn/40 bg-warn-soft px-4 py-2 text-center text-xs font-medium text-warn flex flex-wrap items-center justify-center gap-2">
          <span>Wallet network mismatch. Connected wallet is not on Stellar Testnet.</span>
          <button
            type="button"
            onClick={() => void switchNetwork()}
            className="rounded-lg bg-warn px-2.5 py-0.5 text-xs font-semibold text-accent-ink shadow-sm hover:opacity-90 transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none disabled:opacity-50"
          >
            Switch to Testnet
          </button>
        </div>
      )}

      {/* Mobile Slide-out Sheet */}
      <MobileNavDrawer
        isOpen={mobileDrawerOpen}
        onClose={() => setMobileDrawerOpen(false)}
        viewMode={viewMode}
        activeTab={activeTab}
        onToggleView={onToggleView}
        onOpenFaucet={onOpenFaucet}
        address={address}
        connecting={connecting}
        onConnect={connectWallet}
        onDisconnect={disconnect}
        walletNetworkMismatch={walletNetworkMismatch}
        onSwitchNetwork={switchNetwork}
      />
    </header>
  );
}
