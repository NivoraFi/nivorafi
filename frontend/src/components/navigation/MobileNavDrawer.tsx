"use client";

import React, { useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowRight,
  Droplets,
  ExternalLink,
  Layers,
  PieChart,
  Repeat,
  X,
} from "lucide-react";
import { NetworkBadge } from "./NetworkBadge";
import { WalletButton } from "./WalletButton";
import { MarketSelector } from "@/components/trading/MarketSelector";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";

export interface MobileNavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  viewMode?: "landing" | "trade" | "portfolio";
  activeTab?: "markets" | "trade" | "pools" | "portfolio";
  onToggleView?: (view: "landing" | "trade" | "portfolio") => void;
  onOpenFaucet?: () => void;
  address: string | null;
  connecting: boolean;
  onConnect: () => Promise<void> | void;
  onDisconnect: () => Promise<void> | void;
  walletNetworkMismatch: boolean;
  onSwitchNetwork: () => Promise<void> | void;
}

function useSafePathname() {
  try {
    return usePathname();
  } catch {
    return null;
  }
}

export function MobileNavDrawer({
  isOpen,
  onClose,
  viewMode = "landing",
  activeTab,
  onToggleView,
  onOpenFaucet,
  address,
  connecting,
  onConnect,
  onDisconnect,
  walletNetworkMismatch,
  onSwitchNetwork,
}: MobileNavDrawerProps) {
  const pathname = useSafePathname();

  // Body scroll lock & Escape key listener
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleNavClick = (
    e: React.MouseEvent<HTMLAnchorElement> | undefined,
    view: "landing" | "trade" | "portfolio"
  ) => {
    if (onToggleView) {
      if (pathname === "/") {
        e?.preventDefault?.();
      }
      if (!e || !pathname || pathname === "/") {
        onToggleView(view);
      }
    }
    onClose();
  };

  const isCurrentTab = (tab: "markets" | "trade" | "pools" | "portfolio") => {
    if (activeTab) return activeTab === tab;
    if (tab === "pools") return pathname === "/pools";
    if (tab === "markets") return viewMode === "landing";
    if (tab === "trade")
      return (
        (viewMode === "trade" || (pathname?.startsWith("/trade") ?? false)) &&
        pathname !== "/pools" &&
        pathname !== "/portfolio"
      );
    if (tab === "portfolio") return viewMode === "portfolio" || pathname === "/portfolio";
    return false;
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Mobile Navigation Menu"
      className="fixed inset-0 z-50 md:hidden"
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-canvas/80 backdrop-blur-sm transition-opacity"
      />

      {/* Slide-out Sheet */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xs flex-col glass-panel border-l border-glass-rim shadow-glass-elevated p-5 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-glass-rim">
          <Link
            href="/"
            onClick={(e) => handleNavClick(e, "landing")}
            className="flex items-center gap-2.5 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent rounded-lg"
          >
            <div className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-glass-card border border-glass-rim overflow-hidden p-0.5 shadow-glass">
              <Image
                src="/icon.svg"
                alt="NivoraFi Logo"
                width={28}
                height={28}
                className="object-contain"
              />
            </div>
            <span className="font-semibold text-sm tracking-tight text-ink">
              NivoraFi
            </span>
          </Link>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close mobile menu"
            className="rounded-lg p-1.5 text-ink-secondary hover:text-ink hover:bg-glass-interactive transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Network & Wallet Controls */}
        <div className="mt-4 flex flex-col gap-2.5 pb-4 border-b border-glass-rim">
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-secondary">Network</span>
            <NetworkBadge
              walletNetworkMismatch={walletNetworkMismatch}
              onSwitchNetwork={onSwitchNetwork}
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-secondary">Wallet</span>
            <WalletButton
              address={address}
              connecting={connecting}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
            />
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="mt-4 flex flex-col gap-1.5 pb-4 border-b border-glass-rim">
          <span className="text-xs font-medium text-ink-muted px-2 py-1">
            Navigation
          </span>

          <Link
            href="/trade/usdc-90d"
            onClick={(e) => handleNavClick(e, "trade")}
            className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${
              isCurrentTab("trade")
                ? "bg-accent-soft text-accent border border-accent/20"
                : "text-ink hover:bg-glass-interactive"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Repeat className="h-4 w-4" />
              <span>Trade</span>
            </div>
            <ArrowRight className="h-3.5 w-3.5 opacity-60" />
          </Link>

          <Link
            href="/pools"
            onClick={onClose}
            className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${
              isCurrentTab("pools")
                ? "bg-accent-soft text-accent border border-accent/20"
                : "text-ink hover:bg-glass-interactive"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Layers className="h-4 w-4" />
              <span>Pools</span>
            </div>
            <ArrowRight className="h-3.5 w-3.5 opacity-60" />
          </Link>

          <Link
            href="/portfolio"
            onClick={(e) => handleNavClick(e, "portfolio")}
            className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${
              isCurrentTab("portfolio")
                ? "bg-accent-soft text-accent border border-accent/20"
                : "text-ink hover:bg-glass-interactive"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <PieChart className="h-4 w-4" />
              <span>Portfolio</span>
            </div>
            <ArrowRight className="h-3.5 w-3.5 opacity-60" />
          </Link>
        </div>

        {/* Active Market Selector (Trade context only) */}
        {isCurrentTab("trade") && (
          <div className="mt-4 flex flex-col gap-2 pb-4 border-b border-glass-rim">
            <span className="text-xs font-medium text-ink-muted px-2 py-1">
              Active Market
            </span>
            <MarketSelector compact={false} />
          </div>
        )}

        {/* Faucet Trigger */}
        {onOpenFaucet && (
          <div className="mt-4 pb-4 border-b border-glass-rim">
            <button
              type="button"
              onClick={() => {
                onOpenFaucet();
                onClose();
              }}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-glass-rim bg-glass-card px-3 py-2 text-xs font-semibold text-ink whitespace-nowrap transition-colors hover:bg-glass-interactive cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none disabled:opacity-50"
            >
              <Droplets className="h-3.5 w-3.5 text-accent" />
              <span>Testnet Faucet</span>
            </button>
          </div>
        )}

        {/* External Resources */}
        <div className="mt-auto pt-4 flex flex-col gap-2 text-xs text-ink-secondary">
          <a
            href={STELLAR_PENDLE_CONFIG.circleFaucetUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-between rounded-lg px-2 py-1.5 hover:text-ink hover:bg-glass-interactive transition-colors focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span>Circle USDC Faucet</span>
            <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
          </a>
          <a
            href="https://stellar.expert/explorer/testnet"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-between rounded-lg px-2 py-1.5 hover:text-ink hover:bg-glass-interactive transition-colors focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span>Stellar Expert Explorer</span>
            <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
          </a>
        </div>
      </div>
    </div>
  );
}
