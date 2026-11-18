/**
 * Greenfield Indexer Analytics Client Library
 * Path: frontend/src/lib/indexerAnalytics.ts
 *
 * Provides strictly typed client functions and data structures for consuming
 * time-series charts (GET /charts) and user position/PnL data (GET /positions)
 * from the SQLite Soroban Event Indexer service.
 *
 * LOCKED FILES COMPLIANCE:
 * Does NOT import, re-export, or modify `frontend/src/lib/indexer.ts` or
 * `frontend/src/hooks/useEventIndexer.ts`.
 */

import { ENV } from "@/lib/env";

// ============================================================================
// 1. Types & Data Structures (Cross-Team Contract)
// ============================================================================

/**
 * Time intervals supported by the indexer chart aggregator.
 */
export type MarketChartInterval = "1D" | "1W" | "1M" | "ALL";

/**
 * Single aggregated chart point returned by GET /charts.
 */
export interface MarketChartPoint {
  timestamp: number;
  datetime?: string;
  bucket?: string;
  impliedApyPct: number;
  impliedApy?: number;
  currentApy?: number;
  underlyingApyPct: number;
  underlyingApy?: number;
  ptPrice: number;
  ytPrice: number;
  volumeUsd: number;
  volumeStroops?: string;
  volume?: string;
  tvlUsd: number;
  tvlStroops?: string;
  tvl?: string;
  open?: number;
  openPrice?: number;
  high?: number;
  highPrice?: number;
  low?: number;
  lowPrice?: number;
  close?: number;
  closePrice?: number;
  swapCount?: number;
  tradeCount?: number;
  ledger?: number;
}

/**
 * Summary metrics returned alongside chart time-series.
 */
export interface MarketChartSummary {
  volume24h: number;
  volume7d: number;
  tvl: number;
  highApy: number;
  lowApy: number;
  marketId?: string;
  marketAddress?: string;
  interval?: MarketChartInterval;
  currentApy?: number;
  currentImpliedApy?: number;
  currentUnderlyingApy?: number;
  highPrice?: number;
  lowPrice?: number;
  currentPrice?: number;
  currentPtPrice?: number;
  currentYtPrice?: number;
  volumeTotal?: string;
  volume24hStroops?: string;
  volume24hUsd?: number;
  volume7dStroops?: string;
  volume7dUsd?: number;
  currentTvl?: string;
  currentTvlStroops?: string;
  currentTvlUsd?: number;
  tradesCount?: number;
  totalSwapsCount?: number;
  lastUpdatedTimestamp?: number;
}

/**
 * Full payload of GET /charts?market=<address>&interval=<interval>.
 */
export interface MarketChartResponse {
  success: boolean;
  market: string;
  interval: MarketChartInterval;
  count: number;
  data: MarketChartPoint[];
  summary: MarketChartSummary;
}

/**
 * Position & PnL entry for a single market from GET /positions?user=<wallet>.
 */
export interface UserMarketPosition {
  marketId: string;
  marketAddress: string;
  assetCode: string;
  costBasisStroops: string;
  costBasisUsd: number;
  averageEntryApy: number;
  currentPtBalance: string;
  currentYtBalance: string;
  currentLpBalance: string;
  currentPositionValueUsd: number;
  realizedPnlStroops: string;
  realizedPnlUsd: number;
  unrealizedPnlStroops: string;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
  cumulativeClaimedYieldStroops: string;
  cumulativeClaimedYieldUsd: number;
  firstTradeTimestamp: number;
  lastActivityTimestamp: number;
  totalTradesCount: number;
}

/**
 * Aggregated user positions overview from GET /positions?user=<wallet>.
 */
export interface UserPositionsSummary {
  userAddress: string;
  totalCostBasisUsd: number;
  totalCurrentValueUsd: number;
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  totalNetPnlUsd: number;
  totalClaimedYieldUsd: number;
  overallPortfolioApy: number;
  activePositionsCount: number;
  totalTransactionsCount: number;
}

/**
 * Full response envelope from GET /positions?user=<wallet>.
 */
export interface UserPositionsResponse {
  success: boolean;
  user: string;
  count: number;
  positions: UserMarketPosition[];
  summary: UserPositionsSummary;
}

/**
 * Compatible data point for InteractiveYieldChart.tsx.
 */
export interface ChartDataPoint {
  timestamp: number;
  impliedApy: number;
  underlyingApy: number;
  ptPrice: number;
  ytPrice: number;
  ledger?: number;
}

/**
 * Compatible data point for AnalyticsCard.tsx.
 */
export interface ApyDataPoint {
  timestamp: number;
  apyPct: number;
  ledger?: number;
  ptPriceInSy?: number;
}

export interface FetchUserPositionsParams {
  userAddress: string;
  indexerApiUrl?: string;
  timeoutMs?: number;
}

export interface FetchMarketChartParams {
  market: string;
  interval?: MarketChartInterval;
  indexerApiUrl?: string;
  timeoutMs?: number;
}

// ============================================================================
// 2. Safe Fallback Factory Functions
// ============================================================================

/**
 * Generates an empty, schema-valid UserPositionsSummary object.
 */
export function buildEmptyPositionsSummary(userAddress: string): UserPositionsSummary {
  return {
    userAddress,
    totalCostBasisUsd: 0,
    totalCurrentValueUsd: 0,
    totalRealizedPnlUsd: 0,
    totalUnrealizedPnlUsd: 0,
    totalNetPnlUsd: 0,
    totalClaimedYieldUsd: 0,
    overallPortfolioApy: 0,
    activePositionsCount: 0,
    totalTransactionsCount: 0,
  };
}

/**
 * Generates an empty, schema-valid UserPositionsResponse.
 * Guaranteed to return HTTP 200 equivalent shape when user has no transactions or
 * when backend is unreachable/reindexing.
 */
export function buildEmptyUserPositions(userAddress: string): UserPositionsResponse {
  return {
    success: true,
    user: userAddress,
    count: 0,
    positions: [],
    summary: buildEmptyPositionsSummary(userAddress),
  };
}

/**
 * Generates an empty, schema-valid MarketChartResponse.
 */
export function buildEmptyChartResponse(
  market: string,
  interval: MarketChartInterval = "1W"
): MarketChartResponse {
  return {
    success: true,
    market,
    interval,
    count: 0,
    data: [],
    summary: {
      volume24h: 0,
      volume7d: 0,
      tvl: 0,
      highApy: 0,
      lowApy: 0,
    },
  };
}

// ============================================================================
// 3. Resilient Client API Functions
// ============================================================================

/**
 * Resilient fetch wrapper with timeout support.
 * Defaults to 5000ms as per system specification.
 */
async function fetchWithTimeout(url: string, timeoutMs: number = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves the base URL for the indexer API.
 */
export function resolveIndexerBaseUrl(customUrl?: string): string {
  const url = customUrl || ENV.indexerApiUrl || "/api/indexer";
  return url.replace(/\/+$/, "");
}

/**
 * Fetches user positions and historical PnL from GET /positions?user=<address>.
 *
 * RESILIENCE GUARANTEES:
 * - If userAddress is empty/whitespace, returns empty state immediately without network call.
 * - If indexer is unreachable (timeout, connection refused, 404, 500, or SQLite migration),
 *   it catches all errors and gracefully returns a valid `UserPositionsResponse` with empty positions.
 * - Never throws unhandled exceptions that could crash UI components.
 */
export async function fetchUserPositionData({
  userAddress,
  indexerApiUrl,
  timeoutMs = 5000,
}: FetchUserPositionsParams): Promise<UserPositionsResponse> {
  const trimmedAddress = userAddress?.trim();
  if (!trimmedAddress) {
    return buildEmptyUserPositions("");
  }

  const baseUrl = resolveIndexerBaseUrl(indexerApiUrl);
  const targetUrl = `${baseUrl}/positions?user=${encodeURIComponent(trimmedAddress)}`;

  try {
    const res = await fetchWithTimeout(targetUrl, timeoutMs);

    if (!res.ok) {
      // 404 or non-200 is treated as valid empty position history
      return buildEmptyUserPositions(trimmedAddress);
    }

    const json = (await res.json()) as Partial<UserPositionsResponse>;

    // Defensive parsing: ensure arrays and summary object are intact
    if (json && typeof json === "object") {
      const rawPositions = Array.isArray(json.positions) ? json.positions : [];
      const positions: UserMarketPosition[] = rawPositions
        .filter((p): p is UserMarketPosition => Boolean(p && typeof p === "object" && p.marketId))
        .map((p) => ({
          marketId: String(p.marketId || ""),
          marketAddress: String(p.marketAddress || ""),
          assetCode: String(p.assetCode || "USDC"),
          costBasisStroops: String(p.costBasisStroops || "0"),
          costBasisUsd: Number(p.costBasisUsd) || 0,
          averageEntryApy: Number(p.averageEntryApy) || 0,
          currentPtBalance: String(p.currentPtBalance || "0"),
          currentYtBalance: String(p.currentYtBalance || "0"),
          currentLpBalance: String(p.currentLpBalance || "0"),
          currentPositionValueUsd: Number(p.currentPositionValueUsd) || 0,
          realizedPnlStroops: String(p.realizedPnlStroops || "0"),
          realizedPnlUsd: Number(p.realizedPnlUsd) || 0,
          unrealizedPnlStroops: String(p.unrealizedPnlStroops || "0"),
          unrealizedPnlUsd: Number(p.unrealizedPnlUsd) || 0,
          netPnlUsd: Number(p.netPnlUsd) || 0,
          cumulativeClaimedYieldStroops: String(p.cumulativeClaimedYieldStroops || "0"),
          cumulativeClaimedYieldUsd: Number(p.cumulativeClaimedYieldUsd) || 0,
          firstTradeTimestamp: Number(p.firstTradeTimestamp) || 0,
          lastActivityTimestamp: Number(p.lastActivityTimestamp) || 0,
          totalTradesCount: Number(p.totalTradesCount) || 0,
        }));

      const rawSummary = json.summary && typeof json.summary === "object" ? json.summary : null;
      const summary: UserPositionsSummary = rawSummary
        ? {
            userAddress: rawSummary.userAddress || trimmedAddress,
            totalCostBasisUsd: Number(rawSummary.totalCostBasisUsd) || 0,
            totalCurrentValueUsd: Number(rawSummary.totalCurrentValueUsd) || 0,
            totalRealizedPnlUsd: Number(rawSummary.totalRealizedPnlUsd) || 0,
            totalUnrealizedPnlUsd: Number(rawSummary.totalUnrealizedPnlUsd) || 0,
            totalNetPnlUsd: Number(rawSummary.totalNetPnlUsd) || 0,
            totalClaimedYieldUsd: Number(rawSummary.totalClaimedYieldUsd) || 0,
            overallPortfolioApy: Number(rawSummary.overallPortfolioApy) || 0,
            activePositionsCount: Number(rawSummary.activePositionsCount) || positions.length,
            totalTransactionsCount: Number(rawSummary.totalTransactionsCount) || 0,
          }
        : buildEmptyPositionsSummary(trimmedAddress);

      return {
        success: Boolean(json.success ?? true),
        user: trimmedAddress,
        count: positions.length,
        positions,
        summary,
      };
    }

    return buildEmptyUserPositions(trimmedAddress);
  } catch {
    // Graceful offline fallback: return valid empty state
    return buildEmptyUserPositions(trimmedAddress);
  }
}

/**
 * Fetches time-series OHLCV/yield chart data from GET /charts?market=<address>&interval=<interval>.
 */
export async function fetchMarketChartData({
  market,
  interval = "1W",
  indexerApiUrl,
  timeoutMs = 5000,
}: FetchMarketChartParams): Promise<MarketChartResponse> {
  const trimmedMarket = market?.trim();
  if (!trimmedMarket) {
    return buildEmptyChartResponse("", interval);
  }

  const baseUrl = resolveIndexerBaseUrl(indexerApiUrl);
  const targetUrl = `${baseUrl}/charts?market=${encodeURIComponent(trimmedMarket)}&interval=${encodeURIComponent(interval)}`;

  try {
    const res = await fetchWithTimeout(targetUrl, timeoutMs);

    if (!res.ok) {
      return buildEmptyChartResponse(trimmedMarket, interval);
    }

    const json = (await res.json()) as Partial<MarketChartResponse>;

    if (json && typeof json === "object" && Array.isArray(json.data)) {
      const data: MarketChartPoint[] = json.data
        .filter((d): d is MarketChartPoint => Boolean(d && typeof d === "object"))
        .map((d: any) => {
          const impliedApy = Number(d.impliedApy ?? d.impliedApyPct ?? d.currentApy ?? 0);
          const underlyingApy = Number(d.underlyingApy ?? d.underlyingApyPct ?? 0);
          const ptPrice = Number(d.ptPrice ?? d.close ?? d.closePrice ?? 0);
          const ytPrice = Number(d.ytPrice ?? Math.max(0, 1 - ptPrice));
          const volumeStroops = String(d.volume ?? d.volumeStroops ?? "0");
          const volumeUsd = Number(d.volumeUsd ?? Number(volumeStroops) / 1e7);
          const tvlStroops = String(d.tvl ?? d.tvlStroops ?? "0");
          const tvlUsd = Number(d.tvlUsd ?? Number(tvlStroops) / 1e7);

          return {
            timestamp: Number(d.timestamp) || 0,
            datetime: d.datetime || d.bucket || new Date((Number(d.timestamp) || 0) * 1000).toISOString(),
            bucket: d.bucket || d.datetime,
            impliedApyPct: impliedApy,
            impliedApy,
            underlyingApyPct: underlyingApy,
            underlyingApy,
            ptPrice,
            ytPrice,
            volumeUsd,
            volumeStroops,
            volume: volumeStroops,
            tvlUsd,
            tvlStroops,
            tvl: tvlStroops,
            open: Number(d.open ?? d.openPrice ?? ptPrice),
            openPrice: Number(d.openPrice ?? d.open ?? ptPrice),
            high: Number(d.high ?? d.highPrice ?? ptPrice),
            highPrice: Number(d.highPrice ?? d.high ?? ptPrice),
            low: Number(d.low ?? d.lowPrice ?? ptPrice),
            lowPrice: Number(d.lowPrice ?? d.low ?? ptPrice),
            close: Number(d.close ?? d.closePrice ?? ptPrice),
            closePrice: Number(d.closePrice ?? d.close ?? ptPrice),
            tradeCount: Number(d.tradeCount ?? d.swapCount ?? 0),
            swapCount: Number(d.swapCount ?? d.tradeCount ?? 0),
            ...(d.ledger !== undefined ? { ledger: Number(d.ledger) } : {}),
          };
        });

      const rawSummary = (json.summary as any) || {};
      const summary: MarketChartSummary = {
        volume24h: Number(rawSummary.volume24h ?? rawSummary.volume24hUsd ?? 0),
        volume7d: Number(rawSummary.volume7d ?? rawSummary.volume7dUsd ?? 0),
        tvl: Number(
          rawSummary.tvl ??
            rawSummary.currentTvlUsd ??
            (rawSummary.currentTvl ? Number(rawSummary.currentTvl) / 1e7 : 0)
        ),
        highApy: Number(rawSummary.highApy ?? 0),
        lowApy: Number(rawSummary.lowApy ?? 0),
        marketId: rawSummary.marketId || trimmedMarket,
        marketAddress: rawSummary.marketAddress,
        interval: rawSummary.interval || interval,
        currentApy: Number(rawSummary.currentApy ?? rawSummary.currentImpliedApy ?? 0),
        currentImpliedApy: Number(rawSummary.currentImpliedApy ?? rawSummary.currentApy ?? 0),
        currentUnderlyingApy: Number(rawSummary.currentUnderlyingApy ?? 0),
        highPrice: Number(rawSummary.highPrice ?? 0),
        lowPrice: Number(rawSummary.lowPrice ?? 0),
        currentPrice: Number(rawSummary.currentPrice ?? rawSummary.currentPtPrice ?? 0),
        currentPtPrice: Number(rawSummary.currentPtPrice ?? rawSummary.currentPrice ?? 0),
        currentYtPrice: Number(rawSummary.currentYtPrice ?? 0),
        volumeTotal: String(rawSummary.volumeTotal ?? "0"),
        volume24hStroops: String(rawSummary.volume24hStroops ?? "0"),
        volume24hUsd: Number(rawSummary.volume24hUsd ?? rawSummary.volume24h ?? 0),
        volume7dStroops: String(rawSummary.volume7dStroops ?? "0"),
        volume7dUsd: Number(rawSummary.volume7dUsd ?? rawSummary.volume7d ?? 0),
        currentTvl: String(rawSummary.currentTvl ?? "0"),
        currentTvlStroops: String(rawSummary.currentTvlStroops ?? "0"),
        currentTvlUsd: Number(rawSummary.currentTvlUsd ?? rawSummary.tvl ?? 0),
        tradesCount: Number(rawSummary.tradesCount ?? rawSummary.totalSwapsCount ?? 0),
        totalSwapsCount: Number(rawSummary.totalSwapsCount ?? rawSummary.tradesCount ?? 0),
        lastUpdatedTimestamp: Number(rawSummary.lastUpdatedTimestamp ?? Date.now()),
      };

      return {
        success: Boolean(json.success ?? true),
        market: trimmedMarket,
        interval,
        count: data.length,
        data,
        summary,
      };
    }

    return buildEmptyChartResponse(trimmedMarket, interval);
  } catch {
    return buildEmptyChartResponse(trimmedMarket, interval);
  }
}

// ============================================================================
// 4. Data Conversion Utilities
// ============================================================================

/**
 * Converts indexer chart points into ChartDataPoint format compatible with
 * InteractiveYieldChart.tsx.
 */
export function convertToChartDataPoints(points: MarketChartPoint[]): ChartDataPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((pt): pt is MarketChartPoint => Boolean(pt && typeof pt === "object"))
    .map((pt) => {
      const impliedApy = pt.impliedApyPct ?? pt.impliedApy ?? pt.currentApy ?? 0;
      const underlyingApy = pt.underlyingApyPct ?? pt.underlyingApy ?? 0;
      const ptPrice = pt.ptPrice ?? pt.close ?? pt.closePrice ?? 0;
      const ytPrice = pt.ytPrice ?? Math.max(0, 1 - ptPrice);
      return {
        timestamp: Number(pt.timestamp) || 0,
        impliedApy: Number(impliedApy) || 0,
        underlyingApy: Number(underlyingApy) || 0,
        ptPrice: Number(ptPrice) || 0,
        ytPrice: Number(ytPrice) || 0,
        ...(pt.ledger !== undefined ? { ledger: Number(pt.ledger) } : {}),
      };
    });
}

/**
 * Converts indexer chart points into ApyDataPoint format compatible with
 * AnalyticsCard.tsx.
 */
export function convertToApyDataPoints(points: MarketChartPoint[]): ApyDataPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((pt): pt is MarketChartPoint => Boolean(pt && typeof pt === "object"))
    .map((pt) => {
      const apyPct = pt.impliedApyPct ?? pt.impliedApy ?? pt.currentApy ?? 0;
      const ptPrice = pt.ptPrice ?? pt.close ?? pt.closePrice;
      return {
        timestamp: Number(pt.timestamp) || 0,
        apyPct: Number(apyPct) || 0,
        ...(pt.ledger !== undefined ? { ledger: Number(pt.ledger) } : {}),
        ...(ptPrice !== undefined ? { ptPriceInSy: Number(ptPrice) } : {}),
      };
    });
}
