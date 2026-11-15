"use client";

import React, { useCallback, useMemo, useState } from "react";
import { ArrowRight, Coins, Droplets, Sparkles, X } from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";

export interface TestnetOnboardingBannerProps {
  onOpenFaucet: () => void;
  onDismiss?: () => void;
  dismissible?: boolean;
  variant?: "full" | "compact";
  className?: string;
  address?: string | null;
  accountExists?: boolean | null;
  usdcTrustlineExists?: boolean | null;
  usdcBalance?: string | null;
  ptBalance?: bigint | null;
}

export function TestnetOnboardingBanner({
  onOpenFaucet,
  onDismiss,
  dismissible = false,
  variant = "full",
  className = "",
  address,
  accountExists,
  usdcTrustlineExists,
  usdcBalance,
  ptBalance,
}: TestnetOnboardingBannerProps) {
  const wallet = useWallet();
  const marketCtx = useMarket();

  const [dismissed, setDismissed] = useState(false);

  const effectiveAddress = address !== undefined ? address : wallet.address;
  const effectiveAccountExists =
    accountExists !== undefined
      ? accountExists
      : marketCtx.activePortfolio?.accountExists ?? false;
  const effectiveTrustline =
    usdcTrustlineExists !== undefined
      ? usdcTrustlineExists
      : marketCtx.activePortfolio?.usdcTrustlineExists ?? false;
  const effectiveUsdcBalance =
    usdcBalance !== undefined
      ? usdcBalance
      : marketCtx.activePortfolio?.usdcBalance ?? "0";
  const effectivePtBalance =
    ptBalance !== undefined
      ? ptBalance
      : marketCtx.activePortfolio?.ptBalance ?? 0n;

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    if (onDismiss) {
      onDismiss();
    }
  }, [onDismiss]);

  // Determine contextual guidance message (must execute unconditionally before early return)
  const guidance = useMemo(() => {
    if (!effectiveAddress) {
      return {
        title: "Testnet Assets Onboarding",
        description: "Connect your wallet and claim mock assets to trade fixed yield on Stellar.",
      };
    }
    if (!effectiveAccountExists) {
      return {
        title: "Account Unfunded",
        description: "Fund your testnet account with 10,000 Friendbot XLM to begin trading.",
      };
    }
    if (!effectiveTrustline) {
      return {
        title: "USDC Trustline Missing",
        description: "Establish USDC trustline on testnet to hold mock USDC and trade PT/YT.",
      };
    }
    if (parseFloat(effectiveUsdcBalance || "0") <= 0) {
      return {
        title: "Get Testnet USDC",
        description: "Claim mock USDC from Circle faucet to wrap into sy-bUSDC shares.",
      };
    }
    if ((effectivePtBalance ?? 0n) <= 0n) {
      return {
        title: "Mint Principal & Yield Tokens",
        description: "Mint PT and YT from the Yield Pool to explore fixed-rate yield trading.",
      };
    }
    return {
      title: "Testnet Faucet Ready",
      description: "Need more mock assets or want to mint fresh PT/YT? Launch the Faucet.",
    };
  }, [
    effectiveAddress,
    effectiveAccountExists,
    effectiveTrustline,
    effectiveUsdcBalance,
    effectivePtBalance,
  ]);

  if (dismissed) {
    return null;
  }

  if (variant === "compact") {
    return (
      <div
        className={`rounded-xl border border-accent/30 bg-accent-soft/20 px-3 py-2 flex items-center justify-between gap-3 text-xs shadow-sm ${className}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Droplets className="h-3.5 w-3.5 text-accent shrink-0" />
          <span className="font-semibold text-ink truncate">{guidance.title}:</span>
          <span className="text-ink-muted truncate hidden sm:inline">
            {guidance.description}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onOpenFaucet}
            className="inline-flex items-center gap-1 rounded-lg btn-accent px-2.5 py-1 text-xs font-semibold transition cursor-pointer"
          >
            <span>Get Testnet Assets</span>
            <ArrowRight className="h-3 w-3" />
          </button>
          {dismissible && (
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Dismiss banner"
              className="p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-hover transition cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`glass-panel double-bezel rounded-2xl border border-accent/30 bg-accent-soft/20 backdrop-blur-md p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-glass ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft border border-accent/30 text-accent shrink-0">
          <Droplets className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold text-ink">{guidance.title}</h3>
            <span className="text-[10px] font-semibold text-accent bg-accent-soft px-1.5 py-0.5 rounded-full border border-accent/20">
              Testnet
            </span>
          </div>
          <p className="text-xs text-ink-muted mt-0.5 max-w-xl">
            {guidance.description}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 w-full sm:w-auto justify-end shrink-0">
        <button
          type="button"
          onClick={onOpenFaucet}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl btn-accent px-3.5 py-2 text-xs font-semibold transition cursor-pointer w-full sm:w-auto active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent whitespace-nowrap"
        >
          <Droplets className="h-3.5 w-3.5" />
          <span>Get Testnet Assets</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>

        {dismissible && (
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss banner"
            className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-surface-hover border border-transparent hover:border-hairline transition cursor-pointer shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
