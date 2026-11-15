"use client";

import React from "react";
import { LogOut, Wallet } from "lucide-react";
import { shortenAddress } from "@/lib/math";

export interface WalletButtonProps {
  address: string | null;
  connecting: boolean;
  onConnect: () => Promise<void> | void;
  onDisconnect: () => Promise<void> | void;
  className?: string;
}

/**
 * Reusable Web3 wallet connection button.
 * Preserves strict test contract attributes:
 * - "Connect Wallet", btn-accent
 * - .tabular-mono shortened address
 * - Disconnect button with LogOut icon and title="Disconnect Wallet"
 */
export function WalletButton({
  address,
  connecting,
  onConnect,
  onDisconnect,
  className = "",
}: WalletButtonProps) {
  if (!address) {
    return (
      <button
        type="button"
        onClick={() => void onConnect()}
        disabled={connecting}
        className={`btn-accent inline-flex items-center gap-2 rounded-xl px-3 sm:px-4 py-1.5 text-xs font-semibold whitespace-nowrap disabled:opacity-50 shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98] motion-reduce:transform-none ${className}`}
      >
        <Wallet className="h-3.5 w-3.5" />
        <span>{connecting ? "Connecting..." : "Connect Wallet"}</span>
      </button>
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 rounded-xl border border-glass-rim bg-glass-card shadow-glass backdrop-blur-md p-1 shrink-0 ${className}`}
    >
      <div className="flex items-center gap-2 px-2 py-0.5 text-xs">
        <span className="h-2 w-2 rounded-full bg-positive shrink-0" />
        <span className="tabular-mono font-mono font-medium text-ink hidden sm:inline">
          {shortenAddress(address, 4, 4)}
        </span>
        <span className="tabular-mono font-mono font-medium text-ink sm:hidden">
          {shortenAddress(address, 3, 3)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => void onDisconnect()}
        className="rounded-lg p-1 text-ink-muted transition-colors hover:bg-surface-hover hover:text-danger cursor-pointer focus-visible:outline-2 focus-visible:outline-accent active:scale-95 motion-reduce:transform-none"
        title="Disconnect Wallet"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
