"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { MarketDefinition } from "@/lib/markets";
import {
  DepositEventParsed,
  LiquidityEventParsed,
  MintPyEventParsed,
  ProtocolEvent,
  RedeemEventParsed,
  RedeemPtEventParsed,
  RedeemPyEventParsed,
  RolloverEventParsed,
  RolloverPyEventParsed,
  SwapEventParsed,
} from "@/lib/indexer";
import { formatUnits, shortenAddress } from "@/lib/math";
import { explorerTxUrl } from "@/lib/contracts";
import { useEventIndexer } from "@/hooks/useEventIndexer";

export type ActivityFilterTab = "all" | "swap" | "mint" | "redeem" | "liquidity";

export interface TokenActivityFeedProps {
  market: MarketDefinition;
  userAddress?: string | null;
  rawEvents?: ProtocolEvent[];
  isSyncing?: boolean;
  onRefresh?: () => Promise<void> | void;
  className?: string;
}

export interface FormattedActivityItem {
  id: string;
  category: "swap" | "mint" | "redeem" | "liquidity" | "rollover";
  txHash: string;
  ledger: number;
  timestamp: number;
  actor: string;
  description: string;
  amountSummary: string;
  explorerUrl: string;
}

/**
 * Evaluates whether a ProtocolEvent belongs to the active market.
 * Strict invariant: pool_id == poolId || sy_id == syId || pt_id == ptId.
 */
export function isEventForMarket(
  ev: ProtocolEvent,
  market: MarketDefinition
): boolean {
  if (!market?.contracts) return false;

  const targetPool = market.contracts.poolId?.toLowerCase();
  const targetSy = market.contracts.syId?.toLowerCase();
  const targetPt = market.contracts.ptId?.toLowerCase();
  const targetYt = market.contracts.ytId?.toLowerCase();

  // 1. Emitting contractId check
  const evContract = ev.contractId?.toLowerCase();
  if (
    evContract &&
    (evContract === targetPool ||
      evContract === targetSy ||
      evContract === targetPt ||
      evContract === targetYt)
  ) {
    return true;
  }

  // 2. Specific and generic event fields
  const anyEv = ev as Record<string, any>;
  const evPool = (
    anyEv.pool_id ||
    anyEv.poolId ||
    anyEv.pool ||
    anyEv.sourcePool ||
    anyEv.targetPool
  )?.toString().toLowerCase();
  const evSy = (anyEv.sy_id || anyEv.syId || anyEv.sy)?.toString().toLowerCase();
  const evPt = (anyEv.pt_id || anyEv.ptId || anyEv.pt)?.toString().toLowerCase();
  const evYt = (anyEv.yt_id || anyEv.ytId || anyEv.yt)?.toString().toLowerCase();

  if (targetPool && evPool === targetPool) return true;
  if (targetSy && evSy === targetSy) return true;
  if (targetPt && evPt === targetPt) return true;
  if (targetYt && evYt === targetYt) return true;

  // 3. Nested rawData check
  if (anyEv.rawData && typeof anyEv.rawData === "object") {
    const rdPool = (anyEv.rawData.pool_id || anyEv.rawData.poolId || anyEv.rawData.pool)?.toString().toLowerCase();
    const rdSy = (anyEv.rawData.sy_id || anyEv.rawData.syId || anyEv.rawData.sy)?.toString().toLowerCase();
    const rdPt = (anyEv.rawData.pt_id || anyEv.rawData.ptId || anyEv.rawData.pt)?.toString().toLowerCase();
    if (targetPool && rdPool === targetPool) return true;
    if (targetSy && rdSy === targetSy) return true;
    if (targetPt && rdPt === targetPt) return true;
  }

  return false;
}

/**
 * Formats a ProtocolEvent into an activity row item for the feed.
 */
export function formatProtocolEvent(
  ev: ProtocolEvent,
  market: MarketDefinition
): FormattedActivityItem {
  const actor =
    ev.caller ||
    ("user" in ev && (ev as { user?: string }).user) ||
    "Contract";

  let category: FormattedActivityItem["category"] = "swap";
  let description = "Protocol Event";
  let amountSummary = "";

  switch (ev.type) {
    case "swap": {
      category = "swap";
      const swap = ev as SwapEventParsed;
      const inFormatted = formatUnits(swap.amountIn, 7, 2);
      const outFormatted = formatUnits(swap.amountOut, 7, 2);
      if (swap.direction === 0) {
        description = `Swapped ${inFormatted} PT for ${outFormatted} SY`;
        amountSummary = `+${outFormatted} SY`;
      } else if (swap.direction === 1) {
        description = `Swapped ${inFormatted} SY for ${outFormatted} PT`;
        amountSummary = `+${outFormatted} PT`;
      } else if (swap.direction === 2) {
        description = `Swapped ${inFormatted} SY for ${outFormatted} YT`;
        amountSummary = `+${outFormatted} YT`;
      } else {
        description = `Swapped ${inFormatted} YT for ${outFormatted} SY`;
        amountSummary = `+${outFormatted} SY`;
      }
      break;
    }

    case "mint_py": {
      category = "mint";
      const m = ev as MintPyEventParsed;
      const pyOut = formatUnits(m.pyOut, 7, 2);
      const syIn = formatUnits(m.syIn, 7, 2);
      description = `Minted ${pyOut} PT + YT from ${syIn} SY`;
      amountSummary = `+${pyOut} PT+YT`;
      break;
    }

    case "deposit": {
      category = "mint";
      const d = ev as DepositEventParsed;
      const underlying = formatUnits(d.underlyingAmount, 7, 2);
      description = `Deposited ${underlying} ${market.asset.symbol} into ${market.sySymbol}`;
      amountSummary = `+${underlying} SY`;
      break;
    }

    case "redeem_py": {
      category = "redeem";
      const r = ev as RedeemPyEventParsed;
      const pyBurned = formatUnits(r.pyBurned, 7, 2);
      const syOut = formatUnits(r.syOut, 7, 2);
      description = `Redeemed ${pyBurned} PT + YT for ${syOut} SY`;
      amountSummary = `+${syOut} SY`;
      break;
    }

    case "redeem_pt": {
      category = "redeem";
      const r = ev as RedeemPtEventParsed;
      const ptBurned = formatUnits(r.ptBurned, 7, 2);
      const payout = formatUnits(r.payout, 7, 2);
      description = `Settled ${ptBurned} PT for ${payout} ${market.asset.symbol}`;
      amountSummary = `+${payout} ${market.asset.symbol}`;
      break;
    }

    case "redeem": {
      category = "redeem";
      const r = ev as RedeemEventParsed;
      const shares = formatUnits(r.sharesBurned, 7, 2);
      description = `Unwrapped ${shares} ${market.sySymbol} to ${market.asset.symbol}`;
      amountSummary = `-${shares} SY`;
      break;
    }

    case "liquidity": {
      category = "liquidity";
      const l = ev as LiquidityEventParsed;
      if (l.isAdd) {
        const pt = formatUnits(l.ptAmount, 7, 2);
        const sy = formatUnits(l.syAmount, 7, 2);
        description = `Added Liquidity: ${pt} PT + ${sy} SY`;
        amountSummary = `+${formatUnits(l.lpAmount, 7, 2)} LP`;
      } else {
        const lp = formatUnits(l.lpAmount, 7, 2);
        description = `Removed Liquidity: ${lp} LP`;
        amountSummary = `-${lp} LP`;
      }
      break;
    }

    case "rollover":
    case "rollover_py": {
      category = "rollover";
      const ro = ev as RolloverEventParsed | RolloverPyEventParsed;
      const ptBurned = formatUnits(ro.ptBurned, 7, 2);
      description = `Rolled over ${ptBurned} Matured PT to new market`;
      amountSummary = `${ptBurned} PT`;
      break;
    }

    default: {
      category = "swap";
      description = `Contract event (${ev.topicSymbol || ev.type})`;
      amountSummary = "--";
      break;
    }
  }

  return {
    id: ev.id,
    category,
    txHash: ev.txHash,
    ledger: ev.ledger,
    timestamp: ev.timestamp,
    actor,
    description,
    amountSummary,
    explorerUrl: explorerTxUrl(ev.txHash),
  };
}

export function formatRelativeTime(timestampSeconds: number): string {
  if (!timestampSeconds) return "--";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - timestampSeconds);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function TokenActivityFeed({
  market,
  userAddress = null,
  rawEvents: propRawEvents,
  isSyncing: propIsSyncing,
  onRefresh: propOnRefresh,
  className = "",
}: TokenActivityFeedProps) {
  const [filterTab, setFilterTab] = useState<ActivityFilterTab>("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Hook-level event indexing fallback if not passed directly via props
  const {
    indexer,
    isSyncing: hookSyncing,
    refresh: hookRefresh,
  } = useEventIndexer({
    pollIntervalMs: 10000,
    autoPoll: propRawEvents === undefined,
    userAddress,
    maturityTimestamp: market.maturity,
  });

  const [internalRawEvents, setInternalRawEvents] = useState<ProtocolEvent[]>(
    () => (propRawEvents !== undefined ? propRawEvents : indexer.getEvents())
  );

  // Subscribe to real-time events from indexer singleton
  useEffect(() => {
    if (propRawEvents !== undefined) {
      setInternalRawEvents(propRawEvents);
      return;
    }
    const unsubscribe = indexer.subscribe((events) => {
      setInternalRawEvents(events);
    });
    return unsubscribe;
  }, [propRawEvents, indexer]);

  const activeEvents = propRawEvents ?? internalRawEvents;
  const isSyncing = propIsSyncing ?? hookSyncing;
  const handleRefresh = propOnRefresh ?? hookRefresh;

  // Filter strictly for the active market:
  // pool_id == market.contracts.poolId || sy_id == market.contracts.syId || pt_id == market.contracts.ptId
  const marketEvents = useMemo(() => {
    return activeEvents
      .filter((ev) => isEventForMarket(ev, market))
      .sort((a, b) => b.ledger - a.ledger || b.timestamp - a.timestamp)
      .map((ev) => formatProtocolEvent(ev, market));
  }, [activeEvents, market]);

  // Tab filter
  const displayedItems = useMemo(() => {
    if (filterTab === "all") return marketEvents;
    return marketEvents.filter((item) => {
      switch (filterTab) {
        case "swap":
          return item.category === "swap";
        case "mint":
          return item.category === "mint";
        case "redeem":
          return item.category === "redeem" || item.category === "rollover";
        case "liquidity":
          return item.category === "liquidity";
        default:
          return true;
      }
    });
  }, [marketEvents, filterTab]);

  const copyText = useCallback((id: string, text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  }, []);

  const getBadgeConfig = (category: FormattedActivityItem["category"]) => {
    switch (category) {
      case "swap":
        return {
          label: "Swap",
          color: "border-accent/40 bg-accent-soft text-accent",
          icon: <ArrowDownUp className="h-3 w-3 shrink-0" />,
        };
      case "mint":
        return {
          label: "Mint",
          color: "border-console-accent/40 bg-console-accent/10 text-console-accent",
          icon: <Sparkles className="h-3 w-3 shrink-0" />,
        };
      case "redeem":
        return {
          label: "Redeem",
          color: "border-positive/40 bg-positive-soft text-positive",
          icon: <Coins className="h-3 w-3 shrink-0" />,
        };
      case "liquidity":
        return {
          label: "Pool",
          color: "border-warn/40 bg-warn-soft text-warn",
          icon: <Layers className="h-3 w-3 shrink-0" />,
        };
      case "rollover":
        return {
          label: "Rollover",
          color: "border-accent/40 bg-accent-soft text-accent",
          icon: <Repeat className="h-3 w-3 shrink-0" />,
        };
    }
  };

  const tabs: { key: ActivityFilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "swap", label: "Swaps" },
    { key: "mint", label: "Mints" },
    { key: "redeem", label: "Redeems" },
    { key: "liquidity", label: "Liquidity" },
  ];

  return (
    <div
      className={`glass-panel double-bezel rounded-2xl overflow-hidden shadow-glass-elevated flex flex-col ${className}`}
    >
      {/* Feed Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-glass-rim px-4 py-3 bg-surface-muted/40 backdrop-blur-md gap-3">
        {/* Title & Live Status */}
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5 rounded-md border border-glass-rim-subtle bg-surface-muted/60 px-2 py-0.5 text-[11px] font-semibold text-ink">
            <Radio className="h-3 w-3 text-positive animate-pulse motion-reduce:animate-none" />
            <span>Market Activity</span>
          </div>
          <span className="tabular-mono text-xs text-ink-muted">
            ({marketEvents.length} events)
          </span>
        </div>

        {/* Filter Tabs & Manual Refresh */}
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <div className="flex items-center gap-1 rounded-lg bg-surface-muted/70 p-0.5 border border-glass-rim text-xs backdrop-blur-sm">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilterTab(t.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  filterTab === t.key
                    ? "bg-surface text-ink font-semibold shadow-sm"
                    : "text-ink-secondary hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {handleRefresh && (
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={isSyncing}
              className="rounded-lg border border-glass-rim-subtle bg-surface-muted p-1.5 text-ink-secondary hover:text-ink hover:bg-surface-hover transition disabled:opacity-50"
              title="Refresh ledger events"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin text-accent" : ""}`}
              />
            </button>
          )}
        </div>
      </div>

      {/* Events List Body */}
      <div className="p-3 sm:p-4 max-h-[380px] overflow-y-auto space-y-2 min-h-[220px]">
        {displayedItems.length === 0 ? (
          /* Fallback empty state: required text verbatim */
          <div className="flex flex-col items-center justify-center p-8 text-center rounded-xl border border-hairline bg-surface-muted/30">
            <Radio className="h-6 w-6 text-ink-muted mb-2 opacity-50" />
            <p className="text-xs font-medium text-ink-secondary">
              No recent transactions on Stellar Testnet for this asset
            </p>
            <p className="text-[11px] text-ink-muted mt-1 max-w-sm">
              Live Soroban RPC indexer is monitoring {market.name} contracts.
            </p>
          </div>
        ) : (
          displayedItems.map((item) => {
            const badge = getBadgeConfig(item.category);
            const isCopied = copiedId === item.id;
            const isCurrentUser =
              userAddress &&
              item.actor.toLowerCase() === userAddress.toLowerCase();

            return (
              <div
                key={item.id}
                className={`glass-card double-bezel-recessed rounded-xl p-3 text-xs transition hover:border-glass-rim flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 border-glass-rim-subtle shadow-glass ${
                  isCurrentUser ? "border-accent/40 bg-accent-soft/10" : ""
                }`}
              >
                {/* Left: Badge, Action Description & Actor Metadata */}
                <div className="flex items-start gap-2.5 min-w-0">
                  <span
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold shrink-0 ${badge.color}`}
                  >
                    {badge.icon}
                    <span>{badge.label}</span>
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink leading-snug truncate">
                      {item.description}
                    </p>
                    <div className="tabular-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-muted">
                      <span>
                        Actor: {shortenAddress(item.actor, 4, 4)}
                        {isCurrentUser && (
                          <span className="ml-1 text-[10px] text-accent font-semibold">
                            (You)
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyText(item.id, item.actor)}
                        className="hover:text-ink active:opacity-80 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 transition-colors"
                        title="Copy address"
                      >
                        {isCopied ? (
                          <Check className="h-2.5 w-2.5 inline text-positive" />
                        ) : (
                          <Copy className="h-2.5 w-2.5 inline" />
                        )}
                      </button>
                      <span>•</span>
                      <span>Ledger #{item.ledger}</span>
                    </div>
                  </div>
                </div>

                {/* Right: Amount summary, Time Ago & StellarExpert Tx Link */}
                <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-1 sm:pt-0 border-t sm:border-t-0 border-glass-rim-subtle">
                  {item.amountSummary && item.amountSummary !== "--" && (
                    <span className="tabular-mono text-xs font-semibold text-ink">
                      {item.amountSummary}
                    </span>
                  )}

                  <span className="tabular-mono text-[11px] text-ink-secondary">
                    {formatRelativeTime(item.timestamp)}
                  </span>

                  <a
                    href={item.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-glass-rim-subtle bg-surface-muted/80 px-2 py-1 text-[11px] font-medium text-accent hover:border-accent/40 active:opacity-80 focus-visible:outline-2 focus-visible:outline-accent transition-colors shrink-0"
                    title="View on StellarExpert"
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

      {/* Footer Info Strip */}
      <div className="border-t border-glass-rim px-4 py-2 bg-surface-muted/30 text-[10px] text-ink-muted flex items-center justify-between backdrop-blur-sm">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          <span>Soroban Event Indexer</span>
        </span>
        <span>
          Contracts:{" "}
          <span className="tabular-mono font-mono">
            {market.contracts.poolId ? shortenAddress(market.contracts.poolId, 4, 4) : "--"}
          </span>
        </span>
      </div>
    </div>
  );
}
