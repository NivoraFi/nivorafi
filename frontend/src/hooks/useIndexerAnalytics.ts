/**
 * Greenfield Indexer Analytics React Hook
 * Path: frontend/src/hooks/useIndexerAnalytics.ts
 *
 * Provides reactive user position tracking, cost basis, average entry APY,
 * realized/unrealized PnL, and time-series chart data with resilient offline fallbacks.
 *
 * LOCKED FILES COMPLIANCE:
 * Does NOT import, re-export, or modify `frontend/src/lib/indexer.ts` or
 * `frontend/src/hooks/useEventIndexer.ts`.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChartDataPoint,
  MarketChartInterval,
  MarketChartPoint,
  MarketChartSummary,
  UserMarketPosition,
  UserPositionsResponse,
  UserPositionsSummary,
  buildEmptyPositionsSummary,
  buildEmptyUserPositions,
  convertToChartDataPoints,
  fetchMarketChartData,
  fetchUserPositionData,
} from "@/lib/indexerAnalytics";

export interface UseIndexerAnalyticsOptions {
  userAddress?: string | null;
  marketAddress?: string;
  interval?: MarketChartInterval;
  autoPoll?: boolean;
  positionsPollIntervalMs?: number;
  chartPollIntervalMs?: number;
  indexerApiUrl?: string;
  initialPositionsData?: UserPositionsResponse | null;
}

export interface UseIndexerAnalyticsReturn {
  // --- Chart & Time-Series State ---
  chartPoints: ChartDataPoint[];
  rawChartData: MarketChartPoint[];
  chartData: MarketChartPoint[];
  chartSummary: MarketChartSummary | null;
  isChartLoading: boolean;
  hasLoadedChart: boolean;
  chartError: string | null;
  selectedInterval: MarketChartInterval;
  setInterval: (interval: MarketChartInterval) => void;
  refreshCharts: () => Promise<void>;

  // --- User Positions & PnL State ---
  positions: UserMarketPosition[];
  positionSummary: UserPositionsSummary | null;
  positionsByMarketId: Record<string, UserMarketPosition>;
  activeMarketPosition: UserMarketPosition | null;
  isPositionsLoading: boolean;
  positionsError: string | null;
  refreshPositions: () => Promise<void>;

  // --- Connectivity & Lifecycle ---
  indexerApiActive: boolean;
  lastSyncTimestamp: number | null;
  refreshAll: () => Promise<void>;
}

export function useIndexerAnalytics({
  userAddress,
  marketAddress,
  interval = "1W",
  autoPoll = true,
  positionsPollIntervalMs = 20000,
  chartPollIntervalMs = 15000,
  indexerApiUrl,
  initialPositionsData,
}: UseIndexerAnalyticsOptions = {}): UseIndexerAnalyticsReturn {
  // Normalize address
  const effectiveAddress = userAddress?.trim() || null;

  // Selected interval state
  const [selectedInterval, setSelectedInterval] = useState<MarketChartInterval>(interval);

  // Positions state
  const [positionsResponse, setPositionsResponse] = useState<UserPositionsResponse | null>(() => {
    return initialPositionsData ?? (effectiveAddress ? buildEmptyUserPositions(effectiveAddress) : null);
  });
  const [isPositionsLoading, setIsPositionsLoading] = useState<boolean>(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);

  // Charts state
  const [rawChartData, setRawChartData] = useState<MarketChartPoint[]>([]);
  const [chartSummary, setChartSummary] = useState<MarketChartSummary | null>(null);
  const [isChartLoading, setIsChartLoading] = useState<boolean>(() => Boolean(marketAddress));
  const [chartError, setChartError] = useState<string | null>(null);
  const [loadedChartMarket, setLoadedChartMarket] = useState<string | null>(null);

  // Status & Telemetry
  const [indexerApiActive, setIndexerApiActive] = useState<boolean>(true);
  const [lastSyncTimestamp, setLastSyncTimestamp] = useState<number | null>(null);

  // Concurrency refs
  const positionsFetchIdRef = useRef(0);
  const chartsFetchIdRef = useRef(0);

  // Sync external initial data
  useEffect(() => {
    if (initialPositionsData !== undefined && initialPositionsData !== null) {
      setPositionsResponse(initialPositionsData);
    }
  }, [initialPositionsData]);

  // ==========================================================================
  // 1. Fetch User Positions Handler
  // ==========================================================================
  const refreshPositions = useCallback(async () => {
    if (!effectiveAddress) {
      ++positionsFetchIdRef.current;
      setPositionsResponse(null);
      setIsPositionsLoading(false);
      setPositionsError(null);
      return;
    }

    const currentFetchId = ++positionsFetchIdRef.current;
    setIsPositionsLoading(true);

    try {
      const response = await fetchUserPositionData({
        userAddress: effectiveAddress,
        indexerApiUrl,
        timeoutMs: 5000,
      });

      if (currentFetchId !== positionsFetchIdRef.current) return;

      setPositionsResponse(response);
      setPositionsError(null);
      setIndexerApiActive(response.success);
      setLastSyncTimestamp(Date.now());
    } catch (err: unknown) {
      if (currentFetchId !== positionsFetchIdRef.current) return;
      const message = err instanceof Error ? err.message : "Failed to load indexer position analytics";
      setPositionsError(message);
      // Fallback safely so component never encounters undefined/null runtime errors
      setPositionsResponse(buildEmptyUserPositions(effectiveAddress));
      setIndexerApiActive(false);
    } finally {
      if (currentFetchId === positionsFetchIdRef.current) {
        setIsPositionsLoading(false);
      }
    }
  }, [effectiveAddress, indexerApiUrl]);

  // Initial and reactive load on userAddress change
  useEffect(() => {
    void refreshPositions();
  }, [refreshPositions]);

  // Polling for user positions
  useEffect(() => {
    if (!autoPoll || !effectiveAddress) return;

    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void refreshPositions();
    }, positionsPollIntervalMs);

    return () => clearInterval(timer);
  }, [autoPoll, effectiveAddress, refreshPositions, positionsPollIntervalMs]);

  // ==========================================================================
  // 2. Fetch Chart Data Handler
  // ==========================================================================
  const refreshCharts = useCallback(async () => {
    if (!marketAddress) {
      ++chartsFetchIdRef.current;
      setRawChartData([]);
      setChartSummary(null);
      setIsChartLoading(false);
      setChartError(null);
      setLoadedChartMarket(null);
      return;
    }

    const currentFetchId = ++chartsFetchIdRef.current;
    setIsChartLoading(true);

    try {
      const response = await fetchMarketChartData({
        market: marketAddress,
        interval: selectedInterval,
        indexerApiUrl,
        timeoutMs: 5000,
      });

      if (currentFetchId !== chartsFetchIdRef.current) return;

      setRawChartData(response.data);
      setChartSummary(response.summary);
      setChartError(null);
      setLoadedChartMarket(marketAddress);
    } catch (err: unknown) {
      if (currentFetchId !== chartsFetchIdRef.current) return;
      const message = err instanceof Error ? err.message : "Failed to fetch market chart data";
      setChartError(message);
      setRawChartData([]);
      setLoadedChartMarket(marketAddress);
    } finally {
      if (currentFetchId === chartsFetchIdRef.current) {
        setIsChartLoading(false);
      }
    }
  }, [marketAddress, selectedInterval, indexerApiUrl]);

  // Reactive load on market or interval change
  useEffect(() => {
    void refreshCharts();
  }, [refreshCharts]);

  // Polling for charts
  useEffect(() => {
    if (!autoPoll || !marketAddress) return;

    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void refreshCharts();
    }, chartPollIntervalMs);

    return () => clearInterval(timer);
  }, [autoPoll, marketAddress, refreshCharts, chartPollIntervalMs]);

  // Refresh All
  const refreshAll = useCallback(async () => {
    await Promise.allSettled([refreshPositions(), refreshCharts()]);
  }, [refreshPositions, refreshCharts]);

  // ==========================================================================
  // 3. Derived Lookups and Mappings
  // ==========================================================================
  const positions = useMemo(() => {
    const rawPositions = positionsResponse?.positions ?? [];
    return rawPositions.filter(
      (p): p is UserMarketPosition => Boolean(p && typeof p === "object" && p.marketId)
    );
  }, [positionsResponse]);

  const positionSummary = useMemo(() => {
    if (positionsResponse?.summary) return positionsResponse.summary;
    if (effectiveAddress) return buildEmptyPositionsSummary(effectiveAddress);
    return null;
  }, [positionsResponse, effectiveAddress]);

  const positionsByMarketId = useMemo(() => {
    const map: Record<string, UserMarketPosition> = {};
    for (const p of positions) {
      if (p && typeof p === "object") {
        if (p.marketId) map[p.marketId] = p;
        if (p.marketAddress) map[p.marketAddress] = p;
      }
    }
    return map;
  }, [positions]);

  const activeMarketPosition = useMemo(() => {
    if (!marketAddress) return null;
    return positionsByMarketId[marketAddress] ?? null;
  }, [marketAddress, positionsByMarketId]);

  const hasLoadedChart = Boolean(marketAddress && loadedChartMarket === marketAddress);
  const effectiveRawChartData = useMemo(() => {
    return hasLoadedChart ? rawChartData : [];
  }, [hasLoadedChart, rawChartData]);

  // Derived chart points compatible with InteractiveYieldChart.tsx
  const chartPoints = useMemo(() => {
    return convertToChartDataPoints(effectiveRawChartData);
  }, [effectiveRawChartData]);

  return {
    // Chart states
    chartPoints,
    rawChartData: effectiveRawChartData,
    chartData: effectiveRawChartData,
    chartSummary,
    isChartLoading: isChartLoading || (Boolean(marketAddress) && !hasLoadedChart),
    hasLoadedChart,
    chartError,
    selectedInterval,
    setInterval: setSelectedInterval,
    refreshCharts,

    // Position states
    positions,
    positionSummary,
    positionsByMarketId,
    activeMarketPosition,
    isPositionsLoading,
    positionsError,
    refreshPositions,

    // Lifecycle
    indexerApiActive,
    lastSyncTimestamp,
    refreshAll,
  };
}
