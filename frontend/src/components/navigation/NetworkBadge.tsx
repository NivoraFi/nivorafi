"use client";

import React from "react";

export interface NetworkBadgeProps {
  walletNetworkMismatch: boolean;
  onSwitchNetwork: () => Promise<void> | void;
  className?: string;
}

/**
 * Network status pill displaying Stellar Testnet status or Mismatch warning.
 * Preserves strict test contract attributes:
 * - role="status"
 * - aria-label="Network status: Stellar Testnet" | "Network warning: Connected wallet is not on Stellar Testnet"
 * - title="Connected to Stellar Testnet" | "Wallet network mismatch! Click to switch to Stellar Testnet"
 * - border-positive/20, bg-positive-soft, text-positive, animate-ping, bg-positive, Testnet
 * - border-warn/30, bg-warn-soft, text-warn, bg-warn, Mismatch
 */
export function NetworkBadge({
  walletNetworkMismatch,
  onSwitchNetwork,
  className = "",
}: NetworkBadgeProps) {
  return (
    <button
      type="button"
      role="status"
      aria-label={
        walletNetworkMismatch
          ? "Network warning: Connected wallet is not on Stellar Testnet"
          : "Network status: Stellar Testnet"
      }
      onClick={(e) => {
        if (walletNetworkMismatch) {
          e.stopPropagation();
          void onSwitchNetwork();
        }
      }}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-mono font-medium border border-hairline border-glass-rim transition-colors focus-visible:outline-2 focus-visible:outline-accent active:scale-95 disabled:opacity-50 ${
        walletNetworkMismatch
          ? "border-warn/30 bg-warn-soft text-warn hover:bg-warn/25 cursor-pointer"
          : "border-positive/20 bg-positive-soft text-positive cursor-default"
      } ${className}`}
      title={
        walletNetworkMismatch
          ? "Wallet network mismatch! Click to switch to Stellar Testnet"
          : "Connected to Stellar Testnet"
      }
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {!walletNetworkMismatch && (
          <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-positive opacity-75" />
        )}
        <span
          className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
            walletNetworkMismatch ? "bg-warn" : "bg-positive"
          }`}
        />
      </span>
      <span>{walletNetworkMismatch ? "Mismatch" : "Testnet"}</span>
    </button>
  );
}
