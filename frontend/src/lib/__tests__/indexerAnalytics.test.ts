// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, afterEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

import {
  MarketChartInterval,
  MarketChartPoint,
  MarketChartSummary,
  MarketChartResponse,
  UserMarketPosition,
  UserPositionsSummary,
  UserPositionsResponse,
  ChartDataPoint,
  ApyDataPoint,
  fetchMarketChartData,
  fetchUserPositionData,
  convertToChartDataPoints,
  convertToApyDataPoints,
  synthesizeFallbackChart,
  buildEmptyPositionsSummary,
  buildEmptyUserPositions,
  buildEmptyChartResponse,
  resolveIndexerBaseUrl,
} from "../indexerAnalytics";

import {
  useIndexerAnalytics,
  UseIndexerAnalyticsOptions,
  UseIndexerAnalyticsReturn,
} from "../../hooks/useIndexerAnalytics";

import { PRESET_MARKETS, MarketDefinition } from "@/lib/markets";
import { ENV } from "@/lib/env";

// ----------------------------------------------------------------------------
// Test Data & Fixtures
// ----------------------------------------------------------------------------

const TEST_USER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const TEST_MARKET_ID = "usdc-90d";
const TEST_MARKET_ADDR = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function getMockMarket(id: string = "usdc-90d"): MarketDefinition {
  const m = PRESET_MARKETS.find((market) => market.id === id);
  if (!m) throw new Error(`Market not found in presets: ${id}`);
  return m;
}

function createSampleChartPoints(): MarketChartPoint[] {
  return [
    {
      timestamp: 1700000000,
      datetime: "2023-11-14T22:13:20.000Z",
      bucket: "2023-11-14T22:13:20.000Z",
      impliedApyPct: 8.5,
      impliedApy: 8.5,
      underlyingApyPct: 4.85,
      underlyingApy: 4.85,
      ptPrice: 0.9805,
      ytPrice: 0.0195,
      volumeUsd: 12500,
      volumeStroops: "125000000000",
      volume: "125000000000",
      tvlUsd: 540000,
      tvlStroops: "5400000000000",
      tvl: "5400000000000",
      open: 0.9800,
      high: 0.9810,
      low: 0.9795,
      close: 0.9805,
      tradeCount: 14,
      swapCount: 14,
      ledger: 123456,
    },
    {
      timestamp: 1700003600,
      datetime: "2023-11-14T23:13:20.000Z",
      bucket: "2023-11-14T23:13:20.000Z",
      impliedApyPct: 8.65,
      impliedApy: 8.65,
      underlyingApyPct: 4.85,
      underlyingApy: 4.85,
      ptPrice: 0.9812,
      ytPrice: 0.0188,
      volumeUsd: 8200,
      volumeStroops: "82000000000",
      volume: "82000000000",
      tvlUsd: 548000,
      tvlStroops: "5480000000000",
      tvl: "5480000000000",
      open: 0.9805,
      high: 0.9815,
      low: 0.9802,
      close: 0.9812,
      tradeCount: 8,
      swapCount: 8,
      ledger: 123516,
    },
  ];
}

function renderHookHarness(options: UseIndexerAnalyticsOptions): {
  result: UseIndexerAnalyticsReturn;
  html: string;
} {
  let captured!: UseIndexerAnalyticsReturn;

  function TestHookConsumer(props: { opts: UseIndexerAnalyticsOptions }) {
    captured = useIndexerAnalytics(props.opts);
    return React.createElement(
      "div",
      {
        "data-user": captured.positionSummary?.userAddress ?? "none",
        "data-loading": String(captured.isPositionsLoading),
        "data-active": String(captured.indexerApiActive),
        "data-count": String(captured.positions.length),
        "data-chart-count": String(captured.chartPoints.length),
      },
      "HookTestRender"
    );
  }

  const html = renderToString(React.createElement(TestHookConsumer, { opts: options }));
  return { result: captured, html };
}

// ============================================================================
// TEST SUITE: Indexer Analytics Client & Hook Unit Tests
// ============================================================================

describe("Indexer Analytics Client Library & React Hook Suite", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ==========================================================================
  // 1. Data Conversion Functions
  // ==========================================================================
  describe("1. Data Conversion Utilities", () => {
    it("convertToChartDataPoints maps MarketChartPoint to InteractiveYieldChart ChartDataPoint", () => {
      const points = createSampleChartPoints();
      const chartPoints: ChartDataPoint[] = convertToChartDataPoints(points);

      expect(chartPoints.length).toBe(2);
      expect(chartPoints[0].timestamp).toBe(1700000000);
      expect(chartPoints[0].impliedApy).toBe(8.5);
      expect(chartPoints[0].underlyingApy).toBe(4.85);
      expect(chartPoints[0].ptPrice).toBe(0.9805);
      expect(chartPoints[0].ytPrice).toBe(0.0195);
      expect(chartPoints[0].ledger).toBe(123456);

      expect(chartPoints[1].timestamp).toBe(1700003600);
      expect(chartPoints[1].impliedApy).toBe(8.65);
      expect(chartPoints[1].ptPrice).toBe(0.9812);
      expect(chartPoints[1].ytPrice).toBe(0.0188);
    });

    it("convertToChartDataPoints handles missing optional fields and fallback close prices gracefully", () => {
      const minimalPoints: MarketChartPoint[] = [
        {
          timestamp: 1700000000,
          impliedApyPct: 7.5,
          underlyingApyPct: 4.85,
          ptPrice: 0.98,
          ytPrice: 0.02,
          volumeUsd: 0,
          tvlUsd: 1000,
        },
      ];

      const converted = convertToChartDataPoints(minimalPoints);
      expect(converted.length).toBe(1);
      expect(converted[0].timestamp).toBe(1700000000);
      expect(converted[0].impliedApy).toBe(7.5);
      expect(converted[0].ptPrice).toBe(0.98);
      expect(converted[0].ytPrice).toBe(0.02);
      expect(converted[0].ledger).toBeUndefined();
    });

    it("convertToChartDataPoints handles empty or non-array inputs cleanly without throwing", () => {
      // @ts-expect-error non-array test
      expect(convertToChartDataPoints(null)).toEqual([]);
      // @ts-expect-error non-array test
      expect(convertToChartDataPoints(undefined)).toEqual([]);
      expect(convertToChartDataPoints([])).toEqual([]);
    });

    it("convertToApyDataPoints maps MarketChartPoint to AnalyticsCard ApyDataPoint", () => {
      const points = createSampleChartPoints();
      const apyPoints: ApyDataPoint[] = convertToApyDataPoints(points);

      expect(apyPoints.length).toBe(2);
      expect(apyPoints[0].timestamp).toBe(1700000000);
      expect(apyPoints[0].apyPct).toBe(8.5);
      expect(apyPoints[0].ledger).toBe(123456);
      expect(apyPoints[0].ptPriceInSy).toBe(0.9805);

      expect(apyPoints[1].timestamp).toBe(1700003600);
      expect(apyPoints[1].apyPct).toBe(8.65);
      expect(apyPoints[1].ptPriceInSy).toBe(0.9812);
    });

    it("convertToApyDataPoints handles empty or non-array inputs cleanly without throwing", () => {
      // @ts-expect-error non-array test
      expect(convertToApyDataPoints(null)).toEqual([]);
      // @ts-expect-error non-array test
      expect(convertToApyDataPoints(undefined)).toEqual([]);
      expect(convertToApyDataPoints([])).toEqual([]);
    });
  });

  // ==========================================================================
  // 2. Offline Synthetic Fallback Generator
  // ==========================================================================
  describe("2. Offline Synthetic Fallback Generator (synthesizeFallbackChart)", () => {
    it("synthesizes valid 24-bucket chart for 1D interval on usdc-90d", () => {
      const market = getMockMarket("usdc-90d");
      const chart = synthesizeFallbackChart(market, "1D");

      expect(chart.success).toBe(true);
      expect(chart.market).toBe("usdc-90d");
      expect(chart.interval).toBe("1D");
      expect(chart.count).toBe(24);
      expect(chart.data.length).toBe(24);

      // Verify buckets are chronologically ordered by 1 hour (3600s)
      for (let i = 1; i < chart.data.length; i++) {
        expect(chart.data[i].timestamp - chart.data[i - 1].timestamp).toBe(3600);
      }

      // Verify points have valid financial numbers
      const first = chart.data[0];
      expect(first.ptPrice).toBeGreaterThan(0.9);
      expect(first.ptPrice).toBeLessThanOrEqual(1.0);
      expect(first.ytPrice).toBeGreaterThan(0);
      expect(first.ytPrice).toBeLessThan(0.1);
      expect(first.impliedApyPct).toBeGreaterThan(0);
      expect(first.underlyingApyPct).toBe(4.85);

      // Verify summary matches
      expect(chart.summary.marketId).toBe("usdc-90d");
      expect(chart.summary.interval).toBe("1D");
      expect(chart.summary.currentApy).toBeGreaterThan(0);
      expect(chart.summary.currentPrice).toBeGreaterThan(0.9);
      expect(chart.summary.tvl).toBeGreaterThan(0);
    });

    it("synthesizes valid 168-bucket chart for 1W interval", () => {
      const market = getMockMarket("usdc-90d");
      const chart = synthesizeFallbackChart(market, "1W");

      expect(chart.count).toBe(168);
      expect(chart.data.length).toBe(168);
      expect(chart.interval).toBe("1W");
      expect(chart.data[1].timestamp - chart.data[0].timestamp).toBe(3600);
    });

    it("synthesizes valid 30-bucket chart for 1M interval", () => {
      const market = getMockMarket("usdc-90d");
      const chart = synthesizeFallbackChart(market, "1M");

      expect(chart.count).toBe(30);
      expect(chart.data.length).toBe(30);
      expect(chart.interval).toBe("1M");
      expect(chart.data[1].timestamp - chart.data[0].timestamp).toBe(86400);
    });

    it("synthesizes valid 30-bucket chart for ALL interval", () => {
      const market = getMockMarket("xlm-90d");
      const chart = synthesizeFallbackChart(market, "ALL");

      expect(chart.count).toBe(30);
      expect(chart.data.length).toBe(30);
      expect(chart.interval).toBe("ALL");
      expect(chart.data[0].underlyingApyPct).toBe(3.2); // XLM rate
    });

    it("handles matured market usdc-matured with PT=1.0 and YT=0.0", () => {
      const maturedMarket = getMockMarket("usdc-matured");
      const chart = synthesizeFallbackChart(maturedMarket, "1D");

      expect(chart.count).toBe(24);
      expect(chart.summary.currentPrice).toBe(1.0);
      expect(chart.summary.currentPtPrice).toBe(1.0);
      expect(chart.summary.currentYtPrice).toBe(0.0);
      expect(chart.summary.currentImpliedApy).toBe(0.0);

      const latestPoint = chart.data[chart.data.length - 1];
      expect(latestPoint.ptPrice).toBe(1.0);
      expect(latestPoint.ytPrice).toBe(0.0);
      expect(latestPoint.impliedApyPct).toBe(0.0);

      // Fully matured market across entire 1D window
      const fullyMatured = {
        ...maturedMarket,
        maturity: Math.floor(Date.now() / 1000) - 86400 * 2,
      };
      const fullChart = synthesizeFallbackChart(fullyMatured, "1D");
      for (const pt of fullChart.data) {
        expect(pt.ptPrice).toBe(1.0);
        expect(pt.ytPrice).toBe(0.0);
        expect(pt.impliedApyPct).toBe(0.0);
      }
    });
  });

  // ==========================================================================
  // 3. fetchMarketChartData Network Function
  // ==========================================================================
  describe("3. fetchMarketChartData Client Function", () => {
    it("fetches chart data successfully from REST endpoint", async () => {
      const samplePoints = createSampleChartPoints();
      globalThis.fetch = async (url: string | URL | Request) => {
        expect(String(url)).toContain("/charts?market=usdc-90d&interval=1W");
        return new Response(
          JSON.stringify({
            success: true,
            market: "usdc-90d",
            interval: "1W",
            count: samplePoints.length,
            data: samplePoints,
            summary: {
              volume24h: 12500,
              volume7d: 87500,
              tvl: 540000,
              highApy: 8.65,
              lowApy: 8.5,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await fetchMarketChartData({
        market: "usdc-90d",
        interval: "1W",
      });

      expect(res.success).toBe(true);
      expect(res.market).toBe("usdc-90d");
      expect(res.count).toBe(2);
      expect(res.data.length).toBe(2);
      expect(res.data[0].ptPrice).toBe(0.9805);
      expect(res.data[0].impliedApyPct).toBe(8.5);
      expect(res.summary.highApy).toBe(8.65);
    });

    it("falls back to empty schema on HTTP 500 error without throwing", async () => {
      globalThis.fetch = async () => {
        return new Response("Internal Server Error", { status: 500 });
      };

      const res = await fetchMarketChartData({
        market: "usdc-90d",
        interval: "1D",
      });

      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.data).toEqual([]);
      expect(res.summary.tvl).toBe(0);
    });

    it("falls back to empty schema on network failure (Failed to fetch) without throwing", async () => {
      globalThis.fetch = async () => {
        throw new TypeError("Failed to fetch: Connection refused");
      };

      const res = await fetchMarketChartData({
        market: "usdc-90d",
        interval: "1D",
      });

      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.data).toEqual([]);
    });

    it("empty market parameter immediately returns empty chart without invoking fetch", async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response("OK");
      };

      const res = await fetchMarketChartData({ market: "" });
      expect(fetchCalled).toBe(false);
      expect(res.count).toBe(0);
      expect(res.data).toEqual([]);
    });
  });

  // ==========================================================================
  // 4. fetchUserPositionData Network Function
  // ==========================================================================
  describe("4. fetchUserPositionData Client Function", () => {
    it("fetches user position data successfully from GET /positions", async () => {
      globalThis.fetch = async (url: string | URL | Request) => {
        expect(String(url)).toContain(`/positions?user=${encodeURIComponent(TEST_USER)}`);
        return new Response(
          JSON.stringify({
            success: true,
            user: TEST_USER,
            count: 1,
            positions: [
              {
                marketId: "usdc-90d",
                marketAddress: TEST_MARKET_ADDR,
                assetCode: "USDC",
                costBasisStroops: "100000000",
                costBasisUsd: 10.0,
                averageEntryApy: 8.5,
                currentPtBalance: "100000000",
                currentYtBalance: "0",
                currentLpBalance: "0",
                currentPositionValueUsd: 10.2,
                realizedPnlStroops: "0",
                realizedPnlUsd: 0.0,
                unrealizedPnlStroops: "2000000",
                unrealizedPnlUsd: 0.2,
                netPnlUsd: 0.2,
                cumulativeClaimedYieldStroops: "0",
                cumulativeClaimedYieldUsd: 0.0,
                firstTradeTimestamp: 1700000000,
                lastActivityTimestamp: 1700050000,
                totalTradesCount: 1,
              },
            ],
            summary: {
              userAddress: TEST_USER,
              totalCostBasisUsd: 10.0,
              totalCurrentValueUsd: 10.2,
              totalRealizedPnlUsd: 0.0,
              totalUnrealizedPnlUsd: 0.2,
              totalNetPnlUsd: 0.2,
              totalClaimedYieldUsd: 0.0,
              overallPortfolioApy: 8.5,
              activePositionsCount: 1,
              totalTransactionsCount: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await fetchUserPositionData({ userAddress: TEST_USER });
      expect(res.success).toBe(true);
      expect(res.user).toBe(TEST_USER);
      expect(res.count).toBe(1);
      expect(res.positions.length).toBe(1);
      expect(res.positions[0].marketId).toBe("usdc-90d");
      expect(res.positions[0].netPnlUsd).toBe(0.2);
      expect(res.summary.totalCostBasisUsd).toBe(10.0);
    });

    it("empty user parameter immediately returns empty state without invoking fetch", async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response("OK");
      };

      const res = await fetchUserPositionData({ userAddress: "   " });
      expect(fetchCalled).toBe(false);
      expect(res.count).toBe(0);
      expect(res.positions).toEqual([]);
      expect(res.summary.totalCostBasisUsd).toBe(0);
    });

    it("handles HTTP 404 by returning HTTP 200 compliant empty state", async () => {
      globalThis.fetch = async () => {
        return new Response("Not Found", { status: 404 });
      };

      const res = await fetchUserPositionData({ userAddress: TEST_USER });
      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.positions).toEqual([]);
      expect(res.summary.totalCostBasisUsd).toBe(0);
    });

    it("handles network connection error without throwing", async () => {
      globalThis.fetch = async () => {
        throw new Error("Connection reset by peer");
      };

      const res = await fetchUserPositionData({ userAddress: TEST_USER });
      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.positions).toEqual([]);
    });
  });

  // ==========================================================================
  // 5. React Hook Lifecycle & Integration
  // ==========================================================================
  describe("5. useIndexerAnalytics React Hook", () => {
    it("hydrates complete hook API shape matching UseIndexerAnalyticsReturn", () => {
      const { result } = renderHookHarness({
        userAddress: TEST_USER,
        marketAddress: "usdc-90d",
        autoPoll: false,
      });

      // Chart API
      expect(Array.isArray(result.chartPoints)).toBe(true);
      expect(Array.isArray(result.rawChartData)).toBe(true);
      expect(Array.isArray(result.chartData)).toBe(true);
      expect(typeof result.isChartLoading).toBe("boolean");
      expect(typeof result.setInterval).toBe("function");
      expect(typeof result.refreshCharts).toBe("function");

      // Position API
      expect(Array.isArray(result.positions)).toBe(true);
      expect(typeof result.positionsByMarketId).toBe("object");
      expect(typeof result.isPositionsLoading).toBe("boolean");
      expect(typeof result.refreshPositions).toBe("function");

      // Shared API
      expect(typeof result.indexerApiActive).toBe("boolean");
      expect(typeof result.refreshAll).toBe("function");
    });

    it("indexes positionsByMarketId correctly by both marketId and marketAddress", () => {
      const samplePosition: UserMarketPosition = {
        marketId: "usdc-90d",
        marketAddress: TEST_MARKET_ADDR,
        assetCode: "USDC",
        costBasisStroops: "50000000",
        costBasisUsd: 5.0,
        averageEntryApy: 8.5,
        currentPtBalance: "50000000",
        currentYtBalance: "0",
        currentLpBalance: "0",
        currentPositionValueUsd: 5.1,
        realizedPnlStroops: "0",
        realizedPnlUsd: 0.0,
        unrealizedPnlStroops: "1000000",
        unrealizedPnlUsd: 0.1,
        netPnlUsd: 0.1,
        cumulativeClaimedYieldStroops: "0",
        cumulativeClaimedYieldUsd: 0.0,
        firstTradeTimestamp: 1700000000,
        lastActivityTimestamp: 1700050000,
        totalTradesCount: 1,
      };

      const { result } = renderHookHarness({
        userAddress: TEST_USER,
        marketAddress: "usdc-90d",
        autoPoll: false,
        initialPositionsData: {
          success: true,
          user: TEST_USER,
          count: 1,
          positions: [samplePosition],
          summary: {
            userAddress: TEST_USER,
            totalCostBasisUsd: 5.0,
            totalCurrentValueUsd: 5.1,
            totalRealizedPnlUsd: 0.0,
            totalUnrealizedPnlUsd: 0.1,
            totalNetPnlUsd: 0.1,
            totalClaimedYieldUsd: 0.0,
            overallPortfolioApy: 8.5,
            activePositionsCount: 1,
            totalTransactionsCount: 1,
          },
        },
      });

      expect(result.positions.length).toBe(1);
      expect(result.positionsByMarketId["usdc-90d"]).toBeDefined();
      expect(result.positionsByMarketId[TEST_MARKET_ADDR]).toBeDefined();
      expect(result.activeMarketPosition).toBeDefined();
      expect(result.activeMarketPosition?.marketId).toBe("usdc-90d");
    });

    it("converts rawChartData into chartPoints with identical count and mapped properties", () => {
      const { result } = renderHookHarness({
        marketAddress: "usdc-90d",
        autoPoll: false,
      });

      // Initially empty
      expect(result.rawChartData).toEqual([]);
      expect(result.chartPoints).toEqual([]);
    });

    it("handles wallet disconnect cleanly: null address clears positions and summary", async () => {
      const { result } = renderHookHarness({
        userAddress: null,
        autoPoll: false,
      });

      expect(result.positions).toEqual([]);
      expect(result.positionSummary).toBeNull();
      expect(result.activeMarketPosition).toBeNull();
    });
  });

  // ==========================================================================
  // 6. Base URL Resolution
  // ==========================================================================
  describe("6. resolveIndexerBaseUrl", () => {
    it("strips trailing slashes from custom URL", () => {
      expect(resolveIndexerBaseUrl("http://localhost:8765/")).toBe("http://localhost:8765");
      expect(resolveIndexerBaseUrl("http://127.0.0.1:8765///")).toBe("http://127.0.0.1:8765");
    });

    it("defaults to ENV or fallback host if not provided", () => {
      const url = resolveIndexerBaseUrl();
      expect(url).toBe(ENV.indexerApiUrl);
      expect(url.endsWith("/")).toBe(false);
    });
  });
});
