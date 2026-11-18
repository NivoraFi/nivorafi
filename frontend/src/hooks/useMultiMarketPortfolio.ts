"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import {
  PRESET_MARKETS,
  MarketDefinition,
  MarketSummaryMetrics,
  calculateDaysToMaturity,
  deriveMarketStatus,
  getAssetPriceUsd,
} from "@/lib/markets";
import {
  LiveUserPortfolio,
  fetchUserPortfolio,
} from "@/lib/stellar";
import { decodeSorobanError, formatUnits } from "@/lib/math";
import {
  loadCachedPortfolioSnapshot,
  saveCachedPortfolioSnapshot,
} from "@/lib/hybridPortfolio";

// Asset USD Price Oracle fallback (synced with markets.ts)
export const ASSET_USD_PRICES: Record<string, number> = {
  USDC: getAssetPriceUsd("USDC"),
  XLM: getAssetPriceUsd("XLM"),
  EURC: getAssetPriceUsd("EURC"),
};

export interface MarketPositionItem {
  marketId: string;
  marketName: string;
  assetCode: string;
  tenor: string;
  maturity: number;
  maturityIso: string;
  isMatured: boolean;
  daysToMaturity: number;
  ptBalance: bigint;
  ytBalance: bigint;
  lpBalance: bigint;
  syBalance: bigint;
  claimableYield: bigint;
  claimableYieldSy: bigint;
  estimatedValue: number;
  totalValueUsd: number;
  ptValueUsd: number;
  ytValueUsd: number;
  lpValueUsd: number;
  claimableYieldUsd: number;
  hasPosition: boolean;
  ptBalanceFormatted: string;
  formattedPtBalance: string;
  ytBalanceFormatted: string;
  formattedYtBalance: string;
  lpBalanceFormatted: string;
  formattedLpBalance: string;
  claimableYieldFormatted: string;
  formattedClaimableYieldSy: string;
  impliedApyPct: number;
}

export interface MultiMarketPortfolioTotalsBase {
  totalPortfolioValue: number;
  totalPortfolioValueUsd: number;
  totalClaimableYield: bigint;
  totalClaimableYieldUsd: number;
  activePositionsCount: number;
  maturedPositionsCount: number;
  hasMaturedPositions: boolean;
  weightedApyPct: number;
}

export interface MultiMarketPortfolioTotals extends MultiMarketPortfolioTotalsBase {
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export interface UseMultiMarketPortfolioResult extends MultiMarketPortfolioTotals {
  positions: MarketPositionItem[];
  positionsByMarketId: Record<string, MarketPositionItem>;
  rawPortfolios: Record<string, LiveUserPortfolio>;
  xlmBalance: string;
  usdcBalance: string;
  accountExists: boolean;
  lastUpdated: number | null;
  hasCachedSnapshot: boolean;
  cachedAt: number | null;
}

export interface UseMultiMarketPortfolioOptions {
  userAddress?: string | null;
  markets?: MarketDefinition[];
  autoPoll?: boolean;
  pollIntervalMs?: number;
  initialPortfolios?: Record<string, LiveUserPortfolio> | null;
}

/**
 * Pure function: calculates single market position item and its valuation.
 */
export function parseMarketPosition(
  market: MarketDefinition,
  userPort: LiveUserPortfolio | null,
  metric?: MarketSummaryMetrics | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): MarketPositionItem {
  const isMatured = nowSeconds >= market.maturity;
  const daysToMaturity = calculateDaysToMaturity(market.maturity, nowSeconds);

  const ptBalance = userPort?.ptBalance ?? 0n;
  const ytBalance = userPort?.ytBalance ?? 0n;
  const lpBalance = userPort?.lpBalance ?? 0n;
  const syBalance = userPort?.syBalance ?? 0n;
  const claimableYield = userPort?.estimatedPendingYieldSy ?? 0n;

  const hasPosition =
    ptBalance > 0n ||
    ytBalance > 0n ||
    lpBalance > 0n ||
    claimableYield > 0n ||
    syBalance > 0n;

  // Pricing & Valuation
  const settledMetric = metric && !metric.isLoading ? metric : null;
  const usdPrice = ASSET_USD_PRICES[market.asset.code] ?? getAssetPriceUsd(market.asset.code);
  const blendRate =
    settledMetric &&
    typeof settledMetric.blendRate === "number" &&
    !isNaN(settledMetric.blendRate) &&
    settledMetric.blendRate > 0
      ? settledMetric.blendRate
      : 1.0;
  const ptPriceInSy = isMatured
    ? 1.0
    : settledMetric &&
      typeof settledMetric.ptPriceInSy === "number" &&
      !isNaN(settledMetric.ptPriceInSy) &&
      settledMetric.ptPriceInSy > 0
    ? settledMetric.ptPriceInSy
    : 0.98;
  const ytPriceInSy = isMatured ? 0.0 : Math.max(0, 1.0 - ptPriceInSy);
  const impliedApyPct = isMatured
    ? 0.0
    : settledMetric &&
      typeof settledMetric.impliedApyPct === "number" &&
      !isNaN(settledMetric.impliedApyPct)
    ? settledMetric.impliedApyPct
    : 8.45;

  const ptValueSy = (Number(ptBalance) / 1e7) * ptPriceInSy;
  const ytValueSy = (Number(ytBalance) / 1e7) * ytPriceInSy;
  const lpValueSy = (Number(lpBalance) / 1e7) * 1.0; // 1 LP represents 1 share at pool parity
  const claimableYieldSy = Number(claimableYield) / 1e7;
  const syValueSy = Number(syBalance) / 1e7;

  const ptValueUsd = ptValueSy * blendRate * usdPrice;
  const ytValueUsd = ytValueSy * blendRate * usdPrice;
  const lpValueUsd = lpValueSy * blendRate * usdPrice;
  const claimableYieldUsd = claimableYieldSy * blendRate * usdPrice;
  const syValueUsd = syValueSy * blendRate * usdPrice;

  const estimatedValue = ptValueUsd + ytValueUsd + lpValueUsd + claimableYieldUsd + syValueUsd;

  const ptFormatted = formatUnits(ptBalance, 7, 4);
  const ytFormatted = formatUnits(ytBalance, 7, 4);
  const lpFormatted = formatUnits(lpBalance, 7, 4);
  const claimableFormatted = formatUnits(claimableYield, 7, 4);

  return {
    marketId: market.id,
    marketName: market.name,
    assetCode: market.asset.code,
    tenor: market.tenor,
    maturity: market.maturity,
    maturityIso: market.maturityIso,
    isMatured,
    daysToMaturity,
    ptBalance,
    ytBalance,
    lpBalance,
    syBalance,
    claimableYield,
    claimableYieldSy: claimableYield,
    estimatedValue,
    totalValueUsd: estimatedValue,
    ptValueUsd,
    ytValueUsd,
    lpValueUsd,
    claimableYieldUsd,
    hasPosition,
    ptBalanceFormatted: ptFormatted,
    formattedPtBalance: ptFormatted,
    ytBalanceFormatted: ytFormatted,
    formattedYtBalance: ytFormatted,
    lpBalanceFormatted: lpFormatted,
    formattedLpBalance: lpFormatted,
    claimableYieldFormatted: claimableFormatted,
    formattedClaimableYieldSy: claimableFormatted,
    impliedApyPct,
  };
}

/**
 * Pure function: calculates value-weighted implied APY across active positions.
 */
export function calculateWeightedApy(positions: MarketPositionItem[]): number {
  let totalActiveValue = 0;
  let weightedSum = 0;
  for (const pos of positions) {
    if (pos.hasPosition && !pos.isMatured && pos.estimatedValue > 0) {
      totalActiveValue += pos.estimatedValue;
      weightedSum += pos.estimatedValue * pos.impliedApyPct;
    }
  }
  return totalActiveValue > 0 ? weightedSum / totalActiveValue : 0.0;
}

/**
 * Pure function: aggregates portfolio totals across all positions.
 */
export function aggregatePortfolioTotals(
  positions: MarketPositionItem[]
): MultiMarketPortfolioTotalsBase {
  let totalPortfolioValue = 0;
  let totalClaimableYield = 0n;
  let totalClaimableYieldUsd = 0;
  let activePositionsCount = 0;
  let maturedPositionsCount = 0;

  for (const pos of positions) {
    totalPortfolioValue += pos.estimatedValue;
    totalClaimableYield += pos.claimableYield;
    totalClaimableYieldUsd += pos.claimableYieldUsd;

    if (pos.hasPosition) {
      if (pos.isMatured) {
        maturedPositionsCount += 1;
      } else {
        activePositionsCount += 1;
      }
    }
  }

  const hasMaturedPositions = maturedPositionsCount > 0;
  const weightedApyPct = calculateWeightedApy(positions);

  return {
    totalPortfolioValue,
    totalPortfolioValueUsd: totalPortfolioValue,
    totalClaimableYield,
    totalClaimableYieldUsd,
    activePositionsCount,
    maturedPositionsCount,
    hasMaturedPositions,
    weightedApyPct,
  };
}

/**
 * Custom React Hook: Concurrent Multi-Market Portfolio Query
 */
export function useMultiMarketPortfolio(
  options?: UseMultiMarketPortfolioOptions
): UseMultiMarketPortfolioResult {
  const { address: walletAddress } = useWallet();
  const { marketMetrics } = useMarket();

  const effectiveAddress = options?.userAddress !== undefined ? options.userAddress : walletAddress;
  const autoPoll = options?.autoPoll ?? true;
  const pollIntervalMs = options?.pollIntervalMs ?? 30000;

  const targetMarkets = useMemo(() => {
    if (options?.markets) return options.markets;
    const verified = PRESET_MARKETS.filter((m) => m.isVerifiedTestnet);
    // If initialPortfolios or userPortfolios contains other markets (e.g. usdc-matured in tests), include them as well
    if (options?.initialPortfolios) {
      const extraIds = Object.keys(options.initialPortfolios).filter(
        (id) => !verified.some((m) => m.id === id)
      );
      const extraMarkets = extraIds
        .map((id) => PRESET_MARKETS.find((m) => m.id === id))
        .filter((m): m is MarketDefinition => Boolean(m));
      return [...verified, ...extraMarkets];
    }
    return verified;
  }, [options?.markets, options?.initialPortfolios]);

  const [rawPortfolios, setRawPortfolios] = useState<Record<string, LiveUserPortfolio>>(() => {
    return options?.initialPortfolios ?? {};
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [hasCachedSnapshot, setHasCachedSnapshot] = useState<boolean>(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);

  const fetchIdRef = useRef(0);

  // Sync initialPortfolios changes if provided externally
  useEffect(() => {
    if (options?.initialPortfolios !== undefined) {
      setRawPortfolios(options.initialPortfolios ?? {});
    }
  }, [options?.initialPortfolios]);

  // Hydrate last verified on-chain snapshot from localStorage immediately on client address change
  useEffect(() => {
    if (options?.initialPortfolios !== undefined) return;
    if (!effectiveAddress) {
      setHasCachedSnapshot(false);
      setCachedAt(null);
      return;
    }
    const cached = loadCachedPortfolioSnapshot(effectiveAddress);
    if (cached && Object.keys(cached.portfolios).length > 0) {
      setRawPortfolios((prev) => (Object.keys(prev).length > 0 ? prev : cached.portfolios));
      setHasCachedSnapshot(true);
      setCachedAt(cached.savedAt);
    } else {
      setHasCachedSnapshot(false);
      setCachedAt(null);
    }
  }, [effectiveAddress, options?.initialPortfolios]);

  const fetchBalances = useCallback(async () => {
    // If explicit static portfolios were provided (e.g. in tests/SSR), do not trigger live network RPC
    if (options?.initialPortfolios !== undefined) {
      setRawPortfolios(options.initialPortfolios ?? {});
      return;
    }

    if (!effectiveAddress) {
      setRawPortfolios({});
      setError(null);
      setIsLoading(false);
      setLastUpdated(null);
      setHasCachedSnapshot(false);
      setCachedAt(null);
      return;
    }

    const currentFetchId = ++fetchIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      // Concurrently query user balances across all target markets via Promise.all
      let successCount = 0;
      let lastMarketErr: unknown = null;
      const results = await Promise.all(
        targetMarkets.map(async (m) => {
          try {
            const port = await fetchUserPortfolio(effectiveAddress, m);
            successCount += 1;
            return { marketId: m.id, port };
          } catch (marketErr) {
            lastMarketErr = marketErr;
            return null;
          }
        })
      );

      // Race condition check: ensure only latest request commits to state
      if (currentFetchId !== fetchIdRef.current) return;

      if (successCount === 0 && lastMarketErr) {
        throw lastMarketErr;
      }

      const portfolioMap: Record<string, LiveUserPortfolio> = {};
      for (const item of results) {
        if (item) {
          portfolioMap[item.marketId] = item.port;
        }
      }

      const nowMs = Date.now();
      setRawPortfolios(portfolioMap);
      setLastUpdated(nowMs);
      setHasCachedSnapshot(true);
      setCachedAt(nowMs);
      saveCachedPortfolioSnapshot(effectiveAddress, portfolioMap);
    } catch (err: unknown) {
      if (currentFetchId !== fetchIdRef.current) return;
      const msg = decodeSorobanError(err);
      setError(msg);
    } finally {
      if (currentFetchId === fetchIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [effectiveAddress, targetMarkets, options?.initialPortfolios]);

  // Initial load & trigger on address change
  useEffect(() => {
    void fetchBalances();
  }, [fetchBalances]);

  // Soft background polling (disabled if window tab is hidden or initialPortfolios supplied)
  useEffect(() => {
    if (!autoPoll || !effectiveAddress || options?.initialPortfolios !== undefined) return;

    const intervalId = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void fetchBalances();
    }, pollIntervalMs);

    return () => clearInterval(intervalId);
  }, [autoPoll, effectiveAddress, fetchBalances, pollIntervalMs, options?.initialPortfolios]);

  // Derive structured positions and totals
  const nowSeconds = Math.floor(Date.now() / 1000);

  const effectivePortfolios = options?.initialPortfolios !== undefined ? (options.initialPortfolios ?? {}) : rawPortfolios;

  const positions: MarketPositionItem[] = useMemo(() => {
    // If disconnected and no initial portfolios provided, return zeroed positions
    if (!effectiveAddress && options?.initialPortfolios === undefined) {
      return targetMarkets.map((m) => {
        const metric = marketMetrics[m.id] ?? null;
        return parseMarketPosition(m, null, metric, nowSeconds);
      });
    }

    return targetMarkets.map((m) => {
      const port = effectivePortfolios[m.id] ?? null;
      const metric = marketMetrics[m.id] ?? null;
      return parseMarketPosition(m, port, metric, nowSeconds);
    });
  }, [targetMarkets, effectivePortfolios, marketMetrics, nowSeconds, effectiveAddress, options?.initialPortfolios]);

  const positionsByMarketId: Record<string, MarketPositionItem> = useMemo(() => {
    const map: Record<string, MarketPositionItem> = {};
    for (const p of positions) {
      map[p.marketId] = p;
    }
    return map;
  }, [positions]);

  const totals = useMemo(() => {
    return aggregatePortfolioTotals(positions);
  }, [positions]);

  // Top-level account balances from Horizon
  const firstPort = Object.values(effectivePortfolios)[0];
  const xlmBalance = firstPort?.xlmBalance ?? "0";
  const usdcBalance = firstPort?.usdcBalance ?? "0";
  const accountExists = firstPort?.accountExists ?? false;

  return {
    ...totals,
    positions,
    positionsByMarketId,
    rawPortfolios: effectivePortfolios,
    xlmBalance,
    usdcBalance,
    accountExists,
    isLoading,
    isRefreshing: isLoading,
    error,
    lastUpdated,
    hasCachedSnapshot,
    cachedAt,
    refetch: fetchBalances,
  };
}
