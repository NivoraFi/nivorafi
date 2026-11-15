"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveImpliedApyHistory,
  deriveTvlMetrics,
  deriveUserTransactionHistory,
  deriveVolumeMetrics,
  generateApySparkline,
} from "@/lib/analytics";
import { STELLAR_PENDLE_CONFIG, explorerTxUrl } from "@/lib/contracts";
import {
  ProtocolEvent,
  SorobanEventIndexer,
  SwapEventParsed,
} from "@/lib/indexer";
import { formatUnits, shortenAddress } from "@/lib/math";
import { ActivityEventType, ActivityItem } from "@/components/trading/ActivityPanel.types";
import { MarketAnalyticsData } from "@/components/trading/AnalyticsCard.types";

export interface UseEventIndexerOptions {
  pollIntervalMs?: number; // Default: 10,000ms
  autoPoll?: boolean;      // Default: true
  userAddress?: string | null;
  maturityTimestamp?: number;
  indexerApiUrl?: string;  // Windows Indexer API URL
}

export interface UseEventIndexerReturn {
  analytics: MarketAnalyticsData | null;
  liveFeed: ActivityItem[];
  myHistory: ActivityItem[];
  isSyncing: boolean;
  lastLedger: number;
  error: string | null;
  refresh: () => Promise<void>;
  indexer: SorobanEventIndexer;
  indexerApiActive: boolean;
  sparklineStats?: { bucket: string; count: number }[] | null;
}

// Convert a ProtocolEvent into an ActivityItem for the live feed
function protocolEventToActivityItem(ev: ProtocolEvent, explorerBaseUrl: string): ActivityItem {
  let type: ActivityEventType = "swap";
  let description = "Protocol Transaction";
  let user = ev.caller || ("user" in ev && (ev as { user?: string }).user) || STELLAR_PENDLE_CONFIG.deployer;

  switch (ev.type) {
    case "swap": {
      type = "swap";
      const swap = ev as SwapEventParsed;
      if (swap.direction === 0) {
        description = `Swapped ${formatUnits(swap.amountIn, 7, 2)} PT for ${formatUnits(swap.amountOut, 7, 2)} SY`;
      } else if (swap.direction === 1) {
        description = `Swapped ${formatUnits(swap.amountIn, 7, 2)} SY for ${formatUnits(swap.amountOut, 7, 2)} PT`;
      } else if (swap.direction === 2) {
        description = `Swapped ${formatUnits(swap.amountIn, 7, 2)} SY for ${formatUnits(swap.amountOut, 7, 2)} YT`;
      } else {
        description = `Swapped ${formatUnits(swap.amountIn, 7, 2)} YT for ${formatUnits(swap.amountOut, 7, 2)} SY`;
      }
      break;
    }
    case "mint_py": {
      type = "mint_py";
      description = `Minted ${formatUnits(ev.pyOut, 7, 2)} PT + YT from ${formatUnits(ev.syIn, 7, 2)} SY`;
      break;
    }
    case "redeem_py": {
      type = "redeem_py";
      description = `Redeemed ${formatUnits(ev.pyBurned, 7, 2)} PT + YT for ${formatUnits(ev.syOut, 7, 2)} SY`;
      break;
    }
    case "redeem_pt": {
      type = "redeem";
      description = `Settled ${formatUnits(ev.ptBurned, 7, 2)} PT for ${formatUnits(ev.payout, 7, 2)} SY`;
      break;
    }
    case "deposit": {
      type = "deposit";
      description = `Deposited ${formatUnits(ev.underlyingAmount, 7, 2)} USDC into sy-bUSDC vault`;
      break;
    }
    case "redeem": {
      type = "redeem";
      description = `Redeemed ${formatUnits(ev.sharesBurned, 7, 2)} sy-bUSDC for USDC`;
      break;
    }
    case "liquidity": {
      type = "liquidity";
      description = ev.isAdd
        ? `Added Liquidity: ${formatUnits(ev.ptAmount, 7, 2)} PT + ${formatUnits(ev.syAmount, 7, 2)} SY`
        : `Removed Liquidity: ${formatUnits(ev.lpAmount, 7, 2)} LP`;
      break;
    }
    case "rollover":
    case "rollover_py": {
      type = "rollover";
      description = `Rolled over ${formatUnits(ev.ptBurned, 7, 2)} Matured PT to new target market`;
      break;
    }
    case "yield_claimed": {
      type = "yield_claimed";
      description = `Claimed ${formatUnits(ev.yieldOut, 7, 2)} SY streaming yield`;
      break;
    }
    default: {
      type = "swap";
      description = `Contract event (${ev.topicSymbol || ev.type})`;
      break;
    }
  }

  return {
    id: ev.id,
    type,
    txHash: ev.txHash,
    ledger: ev.ledger,
    timestamp: ev.timestamp,
    user,
    receiver: ev.receiver,
    description,
    explorerUrl: `${explorerBaseUrl}/tx/${ev.txHash}`,
  };
}

// Global indexer instance singleton to avoid redundant connections across rerenders
let globalIndexerInstance: SorobanEventIndexer | null = null;

function getGlobalIndexer(customApiUrl?: string): SorobanEventIndexer {
  const apiUrl = customApiUrl ?? STELLAR_PENDLE_CONFIG.indexerApiUrl;
  if (!globalIndexerInstance) {
    const contractIds = [
      STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId,
      STELLAR_PENDLE_CONFIG.contracts.sy_blend_wrapper.contractId,
      STELLAR_PENDLE_CONFIG.contracts.pt_token.contractId,
      STELLAR_PENDLE_CONFIG.contracts.yt_token.contractId,
      STELLAR_PENDLE_CONFIG.contracts.mock_blend.contractId,
    ].filter(Boolean);

    globalIndexerInstance = new SorobanEventIndexer({
      rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
      indexerApiUrl: apiUrl,
      contractIds,
      pollIntervalMs: 10000,
      startLedger: 124800,
      maxCacheSize: 1000,
      storageKey: "stellar_pendle_events_cache",
    });
  }
  return globalIndexerInstance;
}

export function useEventIndexer({
  pollIntervalMs = 10000,
  autoPoll = true,
  userAddress = null,
  maturityTimestamp = STELLAR_PENDLE_CONFIG.market.maturity,
  indexerApiUrl,
}: UseEventIndexerOptions = {}): UseEventIndexerReturn {
  const indexer = useMemo(() => getGlobalIndexer(indexerApiUrl), [indexerApiUrl]);

  const [rawEvents, setRawEvents] = useState<ProtocolEvent[]>(() => indexer.getEvents());
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [indexerApiActive, setIndexerApiActive] = useState<boolean>(() => indexer.isApiActive());
  const [sparklineStats, setSparklineStats] = useState<{ bucket: string; count: number }[] | null>(null);

  // Subscribe to indexer state updates
  useEffect(() => {
    const unsubscribe = indexer.subscribe((events) => {
      setRawEvents(events);
    });
    return unsubscribe;
  }, [indexer]);

  // Sync execution handler
  const refresh = useCallback(async () => {
    setIsSyncing(true);
    setError(null);
    try {
      await indexer.pollOnce();
      setIndexerApiActive(indexer.isApiActive());
      if (indexer.isApiActive()) {
        const stats = await indexer.fetchSparklineFromApi(24);
        if (stats) {
          setSparklineStats(stats);
        }
      } else {
        setSparklineStats(null);
      }
    } catch (err: unknown) {
      console.warn("[useEventIndexer] Poll error:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSyncing(false);
    }
  }, [indexer]);

  // Periodic polling setup
  useEffect(() => {
    if (!autoPoll) return;

    // Trigger initial poll
    void refresh();

    const intervalId = setInterval(() => {
      void refresh();
    }, pollIntervalMs);

    return () => clearInterval(intervalId);
  }, [autoPoll, pollIntervalMs, refresh]);

  // Compute metrics and presentation objects
  const { analytics, liveFeed, myHistory } = useMemo(() => {
    const explorerBaseUrl = STELLAR_PENDLE_CONFIG.explorerBaseUrl;
    const now = Math.floor(Date.now() / 1000);

    // 1. Volume Metrics
    const volume = deriveVolumeMetrics(rawEvents, now);

    // 2. TVL Metrics
    const tvlPoints = deriveTvlMetrics(rawEvents);
    const latestTvl = tvlPoints.length > 0
      ? tvlPoints[tvlPoints.length - 1].protocolTvlStroops + tvlPoints[tvlPoints.length - 1].ammTvlStroops
      : 0n;

    // 3. Implied APY Time Series
    const apyPoints = deriveImpliedApyHistory(rawEvents, maturityTimestamp);
    let currentApy = 0;
    if (apyPoints.length > 0) {
      currentApy = apyPoints[apyPoints.length - 1].impliedApyPct;
    }

    // Generate sparkline points (24 points for 24h)
    const sparklinePoints = generateApySparkline(rawEvents, maturityTimestamp, 24, now);

    const apyHistoryData = sparklinePoints.map((sp) => ({
      timestamp: sp.timestamp,
      apyPct: sp.value,
    }));

    const marketAnalytics: MarketAnalyticsData = {
      impliedApyPct: currentApy,
      apyChange24hPct: volume.change24hPct,
      volume24hUsdc: volume.volume24hStroops,
      totalVolumeUsdc: volume.totalVolumeStroops,
      totalTvlUsdc: latestTvl,
      totalSwapsCount: volume.totalSwapCount,
      totalTransactionsCount: volume.totalSwapCount + volume.totalMintCount,
      apyHistory: apyHistoryData,
      lastIndexedLedger: indexer.getLastIndexedLedger(),
      isLoading: isSyncing,
    };

    // 4. Live Feed Items (all events descending)
    const feed = [...rawEvents]
      .sort((a, b) => b.ledger - a.ledger || b.timestamp - a.timestamp)
      .map((ev) => protocolEventToActivityItem(ev, explorerBaseUrl));

    // 5. User Personal History Items
    const userHistory = userAddress
      ? deriveUserTransactionHistory(rawEvents, userAddress, now, explorerBaseUrl).map((ui) => ({
          id: ui.id,
          type: (ui.actionType.toLowerCase().includes("swap")
            ? "swap"
            : ui.actionType.toLowerCase().includes("mint")
            ? "mint_py"
            : ui.actionType.toLowerCase().includes("liquidity")
            ? "liquidity"
            : "redeem") as ActivityEventType,
          txHash: ui.txHash,
          ledger: ui.ledger,
          timestamp: ui.timestamp,
          user: userAddress,
          description: `${ui.badge.label}: ${ui.inDescription} -> ${ui.outDescription} (${ui.rateDescription})`,
          explorerUrl: ui.explorerUrl,
        }))
      : [];

    return {
      analytics: marketAnalytics,
      liveFeed: feed,
      myHistory: userHistory,
    };
  }, [rawEvents, maturityTimestamp, userAddress, indexer, isSyncing]);

  return {
    analytics,
    liveFeed,
    myHistory,
    isSyncing,
    lastLedger: indexer.getLastIndexedLedger(),
    error,
    refresh,
    indexer,
    indexerApiActive,
    sparklineStats,
  };
}
