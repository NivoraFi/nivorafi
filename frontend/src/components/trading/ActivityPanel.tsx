"use client";

import React, { useMemo, useState } from "react";
import {
  ArrowDownUp,
  Check,
  Coins,
  Copy,
  ExternalLink,
  Layers,
  Radio,
  RefreshCw,
  Repeat,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { shortenAddress } from "@/lib/math";
import { ActivityEventType, ActivityFilterType, ActivityItem, ActivityPanelProps } from "./ActivityPanel.types";

export function ActivityPanel({
  liveFeed,
  myHistory,
  userAddress,
  isSyncing = false,
  onRefresh,
  onConnectWallet,
  className = "",
}: ActivityPanelProps) {
  const [activeTab, setActiveTab] = useState<"live" | "history">("live");
  const [filterType, setFilterType] = useState<ActivityFilterType>("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const rawList = activeTab === "live" ? liveFeed : myHistory;

  const filteredList = useMemo(() => {
    if (filterType === "all") return rawList;
    return rawList.filter((item) => {
      switch (filterType) {
        case "swap":
          return item.type === "swap";
        case "mint":
          return item.type === "mint_py" || item.type === "deposit";
        case "liquidity":
          return item.type === "liquidity";
        case "redeem":
          return item.type === "redeem" || item.type === "redeem_py" || item.type === "rollover";
        default:
          return true;
      }
    });
  }, [rawList, filterType]);

  const copyText = (id: string, text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  const getEventBadge = (type: ActivityEventType) => {
    switch (type) {
      case "swap":
        return {
          label: "Swap",
          color: "border-accent/40 bg-accent-soft text-accent",
          icon: <ArrowDownUp className="h-3 w-3" />,
        };
      case "deposit":
      case "mint_py":
        return {
          label: "Mint",
          color: "border-console-accent/40 bg-console-accent/10 text-console-accent",
          icon: <Sparkles className="h-3 w-3" />,
        };
      case "redeem":
      case "redeem_py":
        return {
          label: "Redeem",
          color: "border-positive/40 bg-positive-soft text-positive",
          icon: <Coins className="h-3 w-3" />,
        };
      case "liquidity":
        return {
          label: "Pool",
          color: "border-warn/40 bg-warn-soft text-warn",
          icon: <Layers className="h-3 w-3" />,
        };
      case "yield_claimed":
        return {
          label: "Yield",
          color: "border-positive/40 bg-positive-soft text-positive",
          icon: <TrendingUp className="h-3 w-3" />,
        };
      case "rollover":
        return {
          label: "Rollover",
          color: "border-accent/40 bg-accent-soft text-accent",
          icon: <Repeat className="h-3 w-3" />,
        };
    }
  };

  const formatRelativeTime = (timestampSeconds: number) => {
    const diff = Math.floor(Date.now() / 1000 - timestampSeconds);
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  return (
    <div className={`glass-panel double-bezel rounded-2xl overflow-hidden shadow-glass-elevated ${className}`}>
      {/* Header Bar with Tabs & Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-glass-rim px-4 py-3 bg-surface-muted/40 backdrop-blur-md gap-3">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 rounded-xl bg-surface-muted/70 p-1 border border-glass-rim backdrop-blur-md">
          <button
            type="button"
            onClick={() => setActiveTab("live")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
              activeTab === "live"
                ? "bg-accent text-accent-ink shadow-sm"
                : "text-ink-secondary hover:text-ink hover:bg-surface-hover"
            }`}
          >
            <Radio className="h-3 w-3 animate-pulse motion-reduce:animate-none text-positive" />
            <span>Live Feed</span>
            <span className="tabular-mono text-[10px] opacity-75">({liveFeed.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("history")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
              activeTab === "history"
                ? "bg-accent text-accent-ink shadow-sm"
                : "text-ink-secondary hover:text-ink hover:bg-surface-hover"
            }`}
          >
            <Wallet className="h-3 w-3" />
            <span>My History</span>
            <span className="tabular-mono text-[10px] opacity-75">({myHistory.length})</span>
          </button>
        </div>

        {/* Filter Pills & Refresh */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <div className="flex items-center gap-1 rounded-lg bg-surface-muted p-0.5 border border-hairline text-xs">
            {(["all", "swap", "mint", "liquidity", "redeem"] as ActivityFilterType[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilterType(f)}
                className={`rounded-md px-2 py-0.5 capitalize transition ${
                  filterType === f
                    ? "bg-surface text-ink font-semibold"
                    : "text-ink-secondary hover:text-ink"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {onRefresh && (
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={isSyncing}
              className="rounded-lg border border-hairline bg-surface-muted p-1.5 text-ink-secondary hover:text-ink hover:bg-surface-hover transition disabled:opacity-50"
              title="Refresh ledger events"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin text-accent" : ""}`} />
            </button>
          )}
        </div>
      </div>

      {/* Event List Stage */}
      <div className="p-3 sm:p-4 max-h-[380px] overflow-y-auto space-y-2 min-h-[220px]">
        {activeTab === "history" && !userAddress ? (
          /* Disconnected State for My History */
          <div className="flex flex-col items-center justify-center p-8 text-center rounded-xl border border-hairline bg-surface-muted/30">
            <Wallet className="h-8 w-8 text-ink-muted mb-2" />
            <h3 className="text-xs font-semibold text-ink">Wallet Not Connected</h3>
            <p className="text-xs text-ink-secondary mt-1 max-w-xs">
              Connect your Stellar wallet to view your personal trading and liquidity history.
            </p>
            {onConnectWallet && (
              <button
                type="button"
                onClick={onConnectWallet}
                className="mt-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent hover:text-accent-ink transition"
              >
                Connect Wallet
              </button>
            )}
          </div>
        ) : filteredList.length === 0 ? (
          /* Empty List State */
          <div className="flex flex-col items-center justify-center p-8 text-center rounded-xl border border-hairline bg-surface-muted/30">
            <Radio className="h-6 w-6 text-ink-muted mb-1 opacity-50" />
            <p className="text-xs text-ink-secondary">
              {activeTab === "history"
                ? "No transactions recorded for this wallet on Testnet."
                : "No matching protocol events detected."}
            </p>
          </div>
        ) : (
          filteredList.map((item) => {
            const badge = getEventBadge(item.type);
            const isCopied = copiedId === item.id;
            return (
              <div
                key={item.id}
                className="glass-card double-bezel-recessed rounded-xl p-3 text-xs transition hover:border-glass-rim flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 border-glass-rim-subtle shadow-glass"
              >
                {/* Left Block: Badge & Summary */}
                <div className="flex items-start gap-2.5 min-w-0">
                  <span
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold shrink-0 ${badge.color}`}
                  >
                    {badge.icon}
                    <span>{badge.label}</span>
                  </span>

                  <div className="min-w-0">
                    <p className="font-medium text-ink leading-snug truncate">
                      {item.description}
                    </p>
                    <div className="tabular-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-muted">
                      <span>Actor: {shortenAddress(item.user, 4, 4)}</span>
                      <button
                        type="button"
                        onClick={() => copyText(item.id, item.user)}
                        className="hover:text-ink transition"
                        title="Copy address"
                      >
                        {isCopied ? (
                          <Check className="h-2.5 w-2.5 inline text-positive" />
                        ) : (
                          <Copy className="h-2.5 w-2.5 inline" />
                        )}
                      </button>
                      <span>*</span>
                      <span>Ledger #{item.ledger}</span>
                    </div>
                  </div>
                </div>

                {/* Right Block: Timestamp & Explorer Link */}
                <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-1 sm:pt-0 border-t sm:border-t-0 border-glass-rim-subtle">
                  <span className="tabular-mono text-[11px] text-ink-secondary">
                    {formatRelativeTime(item.timestamp)}
                  </span>

                  <a
                    href={item.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-glass-rim-subtle bg-surface-muted/80 px-2 py-1 text-[11px] text-accent hover:border-accent/40 transition-colors shrink-0"
                  >
                    <span>Tx</span>
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Info Bar */}
      <div className="border-t border-glass-rim px-4 py-2 bg-surface-muted/30 text-[10px] text-ink-muted flex items-center justify-between backdrop-blur-sm">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          <span>Soroban RPC Event Stream</span>
        </span>
        <span><span className="tabular-mono font-mono">10s</span> Auto-Polling</span>
      </div>
    </div>
  );
}
