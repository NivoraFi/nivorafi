// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, afterEach, beforeAll, afterAll } from "bun:test";
import {
  MarketChartInterval,
  MarketChartPoint,
  MarketChartSummary,
  MarketChartResponse,
  UserPositionsResponse,
  UserPositionsSummary,
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
import { PRESET_MARKETS, MarketDefinition } from "@/lib/markets";

// Fixture helpers
function getMockMarket(id: string = "usdc-90d"): MarketDefinition {
  const m = PRESET_MARKETS.find((market) => market.id === id);
  if (!m) throw new Error(`Market not found: ${id}`);
  return m;
}

const TEST_WALLET = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const TEST_MARKET_ID = "usdc-90d";

describe("Empirical Challenger M3: Network & Error Resilience for indexerAnalytics.ts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ==========================================================================
  // Suite 1: Offline Fallback Synthesis When Indexer Is Unreachable
  // ==========================================================================
  describe("Suite 1: Offline Fallback Synthesis & Schema Invariants", () => {
    it("1.1 synthesizes exact bucket counts and step sizes for all supported intervals", () => {
      const market = getMockMarket("usdc-90d");

      // 1D: 24 buckets of 3600 seconds
      const chart1D = synthesizeFallbackChart(market, "1D");
      expect(chart1D.success).toBe(true);
      expect(chart1D.interval).toBe("1D");
      expect(chart1D.count).toBe(24);
      expect(chart1D.data.length).toBe(24);
      for (let i = 1; i < chart1D.data.length; i++) {
        expect(chart1D.data[i].timestamp - chart1D.data[i - 1].timestamp).toBe(3600);
      }

      // 1W: 168 buckets of 3600 seconds
      const chart1W = synthesizeFallbackChart(market, "1W");
      expect(chart1W.success).toBe(true);
      expect(chart1W.interval).toBe("1W");
      expect(chart1W.count).toBe(168);
      expect(chart1W.data.length).toBe(168);
      for (let i = 1; i < chart1W.data.length; i++) {
        expect(chart1W.data[i].timestamp - chart1W.data[i - 1].timestamp).toBe(3600);
      }

      // 1M: 30 buckets of 86400 seconds (1 day)
      const chart1M = synthesizeFallbackChart(market, "1M");
      expect(chart1M.success).toBe(true);
      expect(chart1M.interval).toBe("1M");
      expect(chart1M.count).toBe(30);
      expect(chart1M.data.length).toBe(30);
      for (let i = 1; i < chart1M.data.length; i++) {
        expect(chart1M.data[i].timestamp - chart1M.data[i - 1].timestamp).toBe(86400);
      }

      // ALL: 30 buckets of 86400 seconds
      const chartALL = synthesizeFallbackChart(market, "ALL");
      expect(chartALL.success).toBe(true);
      expect(chartALL.interval).toBe("ALL");
      expect(chartALL.count).toBe(30);
      expect(chartALL.data.length).toBe(30);
      for (let i = 1; i < chartALL.data.length; i++) {
        expect(chartALL.data[i].timestamp - chartALL.data[i - 1].timestamp).toBe(86400);
      }
    });

    it("1.2 gracefully defaults to 24 hourly buckets on unrecognized interval parameter", () => {
      const market = getMockMarket("usdc-90d");
      // @ts-expect-error deliberately passing invalid interval
      const fallback = synthesizeFallbackChart(market, "INVALID_INTERVAL");
      expect(fallback.success).toBe(true);
      expect(fallback.count).toBe(24);
      expect(fallback.data.length).toBe(24);
      expect(fallback.data[1].timestamp - fallback.data[0].timestamp).toBe(3600);
    });

    it("1.3 applies correct asset-specific yields for XLM, EURC, and USDC/default", () => {
      const xlmMarket = getMockMarket("xlm-90d");
      const xlmChart = synthesizeFallbackChart(xlmMarket, "1D");
      expect(xlmChart.data[0].underlyingApyPct).toBe(3.2);
      expect(xlmChart.data[0].impliedApyPct).toBe(6.5);
      expect(xlmChart.summary.currentUnderlyingApy).toBe(3.2);
      expect(xlmChart.summary.tvl).toBe(150000);

      const eurcMarket: MarketDefinition = {
        id: "eurc-90d",
        name: "Pendle bEURC PT 90D",
        ptSymbol: "PT-bEURC-90D",
        ytSymbol: "YT-bEURC-90D",
        sySymbol: "sy-bEURC",
        lpSymbol: "LP-bEURC-90D",
        asset: {
          code: "EURC",
          symbol: "EURC",
          name: "Euro Coin",
          decimals: 7,
          sacContractId: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
          iconName: "eurc",
        },
        tenor: "90D",
        maturity: 1801909055,
        contracts: {
          poolId: "MOCK_EURC_POOL",
          syId: "MOCK_EURC_SY",
          ptId: "MOCK_EURC_PT",
          ytId: "MOCK_EURC_YT",
        },
      };
      const eurcChart = synthesizeFallbackChart(eurcMarket, "1D");
      expect(eurcChart.data[0].underlyingApyPct).toBe(3.8);
      expect(eurcChart.data[0].impliedApyPct).toBe(7.2);
      expect(eurcChart.summary.currentUnderlyingApy).toBe(3.8);
      expect(eurcChart.summary.tvl).toBe(542000);

      const usdcMarket = getMockMarket("usdc-90d");
      const usdcChart = synthesizeFallbackChart(usdcMarket, "1D");
      expect(usdcChart.data[0].underlyingApyPct).toBe(4.85);
      expect(usdcChart.data[0].impliedApyPct).toBe(8.57);
      expect(usdcChart.summary.currentUnderlyingApy).toBe(4.85);
      expect(usdcChart.summary.tvl).toBe(542000);
    });

    it("1.4 handles matured markets: guarantees PT=1.0, YT=0.0, ImpliedApy=0.0 across all buckets", () => {
      // Test a market that matured prior to the chart window
      const maturedMarket: MarketDefinition = {
        ...getMockMarket("usdc-matured"),
        maturity: Math.floor(Date.now() / 1000) - 86400 * 30, // matured 30 days ago
      };
      const chart = synthesizeFallbackChart(maturedMarket, "1W");

      expect(chart.count).toBe(168);
      for (const pt of chart.data) {
        expect(pt.ptPrice).toBe(1.0);
        expect(pt.ytPrice).toBe(0.0);
        expect(pt.impliedApyPct).toBe(0.0);
        expect(pt.impliedApy).toBe(0.0);
        expect(pt.close).toBe(1.0);
      }
      expect(chart.summary.currentPtPrice).toBe(1.0);
      expect(chart.summary.currentYtPrice).toBe(0.0);
      expect(chart.summary.currentApy).toBe(0.0);
      expect(chart.summary.currentImpliedApy).toBe(0.0);
    });

    it("1.5 survives sparse or minimal MarketDefinition objects without throwing", () => {
      const sparseMarket: MarketDefinition = {
        id: "sparse-test",
        name: "Sparse Test",
        asset: { code: "CUSTOM", name: "Custom", icon: "", color: "" },
        maturity: Math.floor(Date.now() / 1000) + 86400 * 30,
        contracts: {} as any,
        category: "fixed",
      };

      const chart = synthesizeFallbackChart(sparseMarket, "1D");
      expect(chart.success).toBe(true);
      expect(chart.market).toBe("sparse-test");
      expect(chart.count).toBe(24);
      expect(chart.summary.marketAddress).toBe("");
    });

    it("1.6 buildEmptyPositionsSummary and buildEmptyUserPositions guarantee finite zero numbers", () => {
      const summary = buildEmptyPositionsSummary(TEST_WALLET);
      expect(summary.userAddress).toBe(TEST_WALLET);
      expect(summary.totalCostBasisUsd).toBe(0);
      expect(summary.totalCurrentValueUsd).toBe(0);
      expect(summary.totalRealizedPnlUsd).toBe(0);
      expect(summary.totalUnrealizedPnlUsd).toBe(0);
      expect(summary.totalNetPnlUsd).toBe(0);
      expect(summary.totalClaimedYieldUsd).toBe(0);
      expect(summary.overallPortfolioApy).toBe(0);
      expect(summary.activePositionsCount).toBe(0);
      expect(summary.totalTransactionsCount).toBe(0);

      const positions = buildEmptyUserPositions(TEST_WALLET);
      expect(positions.success).toBe(true);
      expect(positions.user).toBe(TEST_WALLET);
      expect(positions.count).toBe(0);
      expect(positions.positions).toEqual([]);
      expect(positions.summary).toEqual(summary);
    });

    it("1.7 buildEmptyChartResponse generates safe zero-value summary and empty array", () => {
      const emptyChart = buildEmptyChartResponse("test-market", "1M");
      expect(emptyChart.success).toBe(true);
      expect(emptyChart.market).toBe("test-market");
      expect(emptyChart.interval).toBe("1M");
      expect(emptyChart.count).toBe(0);
      expect(emptyChart.data).toEqual([]);
      expect(emptyChart.summary.tvl).toBe(0);
      expect(emptyChart.summary.volume24h).toBe(0);
      expect(emptyChart.summary.volume7d).toBe(0);
      expect(emptyChart.summary.highApy).toBe(0);
      expect(emptyChart.summary.lowApy).toBe(0);
    });
  });

  // ==========================================================================
  // Suite 2: Timeout Behavior & AbortController Verification
  // ==========================================================================
  describe("Suite 2: Timeout Behavior & AbortController Triggering", () => {
    it("2.1 triggers AbortController signal when request exceeds timeoutMs in fetchMarketChartData", async () => {
      let capturedSignal: AbortSignal | undefined;

      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve, reject) => {
          if (capturedSignal) {
            capturedSignal.addEventListener("abort", () => {
              reject(new DOMException("The user aborted a request.", "AbortError"));
            });
          }
        });
      };

      const start = Date.now();
      const res = await fetchMarketChartData({
        market: TEST_MARKET_ID,
        interval: "1D",
        timeoutMs: 60,
      });
      const elapsed = Date.now() - start;

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(50);
      // Returns fallback gracefully
      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.data).toEqual([]);
      expect(res.summary.tvl).toBe(0);
    });

    it("2.2 triggers AbortController signal when request exceeds timeoutMs in fetchUserPositionData", async () => {
      let capturedSignal: AbortSignal | undefined;

      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve, reject) => {
          if (capturedSignal) {
            capturedSignal.addEventListener("abort", () => {
              reject(new DOMException("The user aborted a request.", "AbortError"));
            });
          }
        });
      };

      const start = Date.now();
      const res = await fetchUserPositionData({
        userAddress: TEST_WALLET,
        timeoutMs: 60,
      });
      const elapsed = Date.now() - start;

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(50);
      // Returns fallback gracefully
      expect(res.success).toBe(true);
      expect(res.user).toBe(TEST_WALLET);
      expect(res.count).toBe(0);
      expect(res.positions).toEqual([]);
      expect(res.summary.totalNetPnlUsd).toBe(0);
    });

    it("2.3 completes successfully when response arrives before timeoutMs", async () => {
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        // Fast response in 10ms
        await new Promise((r) => setTimeout(r, 10));
        expect(signal?.aborted).toBe(false);
        return new Response(
          JSON.stringify({
            success: true,
            user: TEST_WALLET,
            count: 0,
            positions: [],
            summary: buildEmptyPositionsSummary(TEST_WALLET),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await fetchUserPositionData({
        userAddress: TEST_WALLET,
        timeoutMs: 1000,
      });

      expect(res.success).toBe(true);
      expect(res.user).toBe(TEST_WALLET);
    });

    it("2.4 handles immediate timeout (0ms) gracefully without uncaught rejection", async () => {
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
          } else {
            signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }
        });
      };

      const chartRes = await fetchMarketChartData({
        market: TEST_MARKET_ID,
        timeoutMs: 0,
      });
      expect(chartRes.success).toBe(true);
      expect(chartRes.count).toBe(0);

      const posRes = await fetchUserPositionData({
        userAddress: TEST_WALLET,
        timeoutMs: 0,
      });
      expect(posRes.success).toBe(true);
      expect(posRes.count).toBe(0);
    });
  });

  // ==========================================================================
  // Suite 3: Malformed & Empty Payload Ingestion Resilience
  // ==========================================================================
  describe("Suite 3: Malformed, Empty, and Corrupt JSON Responses", () => {
    it("3.1 handles completely empty HTTP 200 response (0 bytes / empty string) without throwing", async () => {
      globalThis.fetch = async () => {
        return new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const chartRes = await fetchMarketChartData({ market: TEST_MARKET_ID });
      expect(chartRes.success).toBe(true);
      expect(chartRes.count).toBe(0);
      expect(chartRes.data).toEqual([]);

      const posRes = await fetchUserPositionData({ userAddress: TEST_WALLET });
      expect(posRes.success).toBe(true);
      expect(posRes.count).toBe(0);
      expect(posRes.positions).toEqual([]);
    });

    it("3.2 handles truncated / syntax-invalid JSON chunks without crashing", async () => {
      const truncatedPayloads = [
        '{"success": true, "data": [ { "timestamp": 1234, "ptPrice":',
        '{"user": "GAWW',
        '{"success":',
        "{",
        "undefined",
      ];

      for (const payload of truncatedPayloads) {
        globalThis.fetch = async () => {
          return new Response(payload, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };

        const chartRes = await fetchMarketChartData({ market: TEST_MARKET_ID });
        expect(chartRes.success).toBe(true);
        expect(chartRes.count).toBe(0);

        const posRes = await fetchUserPositionData({ userAddress: TEST_WALLET });
        expect(posRes.success).toBe(true);
        expect(posRes.count).toBe(0);
      }
    });

    it("3.3 handles HTML error pages (e.g. Cloudflare / Nginx 502/504 error page)", async () => {
      const htmlPayload = `
        <!DOCTYPE html>
        <html>
          <head><title>504 Gateway Time-out</title></head>
          <body><h1>504 Gateway Time-out</h1><p>The server was acting as a gateway.</p></body>
        </html>
      `;

      globalThis.fetch = async () => {
        return new Response(htmlPayload, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      };

      const chartRes = await fetchMarketChartData({ market: TEST_MARKET_ID });
      expect(chartRes.success).toBe(true);
      expect(chartRes.data).toEqual([]);

      const posRes = await fetchUserPositionData({ userAddress: TEST_WALLET });
      expect(posRes.success).toBe(true);
      expect(posRes.positions).toEqual([]);
    });

    it("3.4 handles JSON primitives (null, number, boolean, string) cleanly", async () => {
      const primitives = ["null", "0", "false", '"a string"'];

      for (const prim of primitives) {
        globalThis.fetch = async () => {
          return new Response(prim, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };

        const chartRes = await fetchMarketChartData({ market: TEST_MARKET_ID });
        expect(chartRes.success).toBe(true);
        expect(chartRes.count).toBe(0);

        const posRes = await fetchUserPositionData({ userAddress: TEST_WALLET });
        expect(posRes.success).toBe(true);
        expect(posRes.count).toBe(0);
      }
    });

    it("3.5 filters out null, undefined, primitive or malformed elements from data arrays", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: true,
            market: TEST_MARKET_ID,
            interval: "1D",
            data: [
              null,
              undefined,
              "invalid string",
              12345,
              {
                timestamp: 1700000000,
                impliedApyPct: 8.5,
                underlyingApyPct: 4.85,
                ptPrice: 0.98,
                ytPrice: 0.02,
              },
              null,
            ],
            summary: {
              volume24h: 100,
              tvl: 200,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const chartRes = await fetchMarketChartData({ market: TEST_MARKET_ID });
      expect(chartRes.success).toBe(true);
      // Only 1 valid object passed filter
      expect(chartRes.data.length).toBe(1);
      expect(chartRes.count).toBe(1);
      expect(chartRes.data[0].timestamp).toBe(1700000000);
      expect(chartRes.data[0].impliedApyPct).toBe(8.5);
    });

    it("3.6 filters out null, undefined, or missing marketId items in positions array", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: true,
            user: TEST_WALLET,
            positions: [
              null,
              undefined,
              { notMarketId: "something" },
              {
                marketId: "usdc-90d",
                marketAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                costBasisUsd: 100,
              },
            ],
            summary: {
              userAddress: TEST_WALLET,
              totalCostBasisUsd: 100,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const posRes = await fetchUserPositionData({ userAddress: TEST_WALLET });
      expect(posRes.success).toBe(true);
      expect(posRes.positions.length).toBe(1);
      expect(posRes.positions[0].marketId).toBe("usdc-90d");
      expect(posRes.positions[0].costBasisUsd).toBe(100);
    });

    it("3.7 handles HTTP 400, 404, 500, 502, 503, 504 without throwing", async () => {
      const statusCodes = [400, 404, 500, 502, 503, 504];

      for (const st of statusCodes) {
        globalThis.fetch = async () => {
          return new Response(JSON.stringify({ error: `HTTP ${st}` }), { status: st });
        };

        const chartRes = await fetchMarketChartData({ market: TEST_MARKET_ID });
        expect(chartRes.success).toBe(true);
        expect(chartRes.count).toBe(0);
        expect(chartRes.data).toEqual([]);

        const posRes = await fetchUserPositionData({ userAddress: TEST_WALLET });
        expect(posRes.success).toBe(true);
        expect(posRes.count).toBe(0);
        expect(posRes.positions).toEqual([]);
      }
    });

    it("3.8 handles TypeError: Failed to fetch (TCP connection refused)", async () => {
      globalThis.fetch = async () => {
        throw new TypeError("Failed to fetch: connect ECONNREFUSED 127.0.0.1:8765");
      };

      const chartRes = await fetchMarketChartData({ market: TEST_MARKET_ID });
      expect(chartRes.success).toBe(true);
      expect(chartRes.count).toBe(0);

      const posRes = await fetchUserPositionData({ userAddress: TEST_WALLET });
      expect(posRes.success).toBe(true);
      expect(posRes.count).toBe(0);
    });
  });

  // ==========================================================================
  // Suite 4: convertToChartDataPoints & convertToApyDataPoints Extreme Rigor
  // ==========================================================================
  describe("Suite 4: Conversion Functions With Valid, Sparse, and Extreme Data", () => {
    it("4.1 correctly transforms standard valid MarketChartPoint array", () => {
      const validPoints: MarketChartPoint[] = [
        {
          timestamp: 1700000000,
          impliedApyPct: 8.5,
          underlyingApyPct: 4.85,
          ptPrice: 0.9805,
          ytPrice: 0.0195,
          volumeUsd: 12000,
          tvlUsd: 500000,
          ledger: 554321,
        },
      ];

      const chartPoints = convertToChartDataPoints(validPoints);
      expect(chartPoints.length).toBe(1);
      expect(chartPoints[0].timestamp).toBe(1700000000);
      expect(chartPoints[0].impliedApy).toBe(8.5);
      expect(chartPoints[0].underlyingApy).toBe(4.85);
      expect(chartPoints[0].ptPrice).toBe(0.9805);
      expect(chartPoints[0].ytPrice).toBe(0.0195);
      expect(chartPoints[0].ledger).toBe(554321);

      const apyPoints = convertToApyDataPoints(validPoints);
      expect(apyPoints.length).toBe(1);
      expect(apyPoints[0].timestamp).toBe(1700000000);
      expect(apyPoints[0].apyPct).toBe(8.5);
      expect(apyPoints[0].ptPriceInSy).toBe(0.9805);
      expect(apyPoints[0].ledger).toBe(554321);
    });

    it("4.2 handles sparse points with field aliases (impliedApy, currentApy, close, closePrice)", () => {
      const sparsePointA = {
        timestamp: 1700001000,
        // No impliedApyPct, has impliedApy
        impliedApy: 7.2,
        underlyingApy: 3.5,
        close: 0.97,
        volumeUsd: 0,
        tvlUsd: 0,
      } as unknown as MarketChartPoint;

      const resA = convertToChartDataPoints([sparsePointA]);
      expect(resA[0].impliedApy).toBe(7.2);
      expect(resA[0].underlyingApy).toBe(3.5);
      expect(resA[0].ptPrice).toBe(0.97);
      expect(resA[0].ytPrice).toBeCloseTo(0.03, 4); // 1 - 0.97

      const sparsePointB = {
        timestamp: 1700002000,
        // No impliedApyPct or impliedApy, has currentApy
        currentApy: 9.1,
        underlyingApyPct: 4.0,
        closePrice: 0.95,
        volumeUsd: 0,
        tvlUsd: 0,
      } as unknown as MarketChartPoint;

      const resB = convertToChartDataPoints([sparsePointB]);
      expect(resB[0].impliedApy).toBe(9.1);
      expect(resB[0].ptPrice).toBe(0.95);
      expect(resB[0].ytPrice).toBeCloseTo(0.05, 4);
    });

    it("4.3 handles extreme boundary values: zero, high yields, micro prices, and massive timestamps", () => {
      const extremePoints: MarketChartPoint[] = [
        // All zeros
        {
          timestamp: 0,
          impliedApyPct: 0,
          underlyingApyPct: 0,
          ptPrice: 0,
          ytPrice: 0,
          volumeUsd: 0,
          tvlUsd: 0,
        },
        // Micro prices and large numbers
        {
          timestamp: 253402300799, // Year 9999
          impliedApyPct: 99999.99,
          underlyingApyPct: 50000.0,
          ptPrice: 0.000001,
          ytPrice: 0.999999,
          volumeUsd: 1e12,
          tvlUsd: 1e15,
          ledger: 2147483647,
        },
        // Negative yield scenario
        {
          timestamp: 1700000000,
          impliedApyPct: -15.5,
          underlyingApyPct: -2.0,
          ptPrice: 1.05,
          ytPrice: 0,
          volumeUsd: 0,
          tvlUsd: 0,
        },
      ];

      const chartPoints = convertToChartDataPoints(extremePoints);
      expect(chartPoints.length).toBe(3);

      expect(chartPoints[0].impliedApy).toBe(0);
      expect(chartPoints[0].ptPrice).toBe(0);

      expect(chartPoints[1].timestamp).toBe(253402300799);
      expect(chartPoints[1].impliedApy).toBe(99999.99);
      expect(chartPoints[1].ptPrice).toBe(0.000001);
      expect(chartPoints[1].ledger).toBe(2147483647);

      expect(chartPoints[2].impliedApy).toBe(-15.5);
      expect(chartPoints[2].underlyingApy).toBe(-2.0);
      expect(chartPoints[2].ptPrice).toBe(1.05);

      const apyPoints = convertToApyDataPoints(extremePoints);
      expect(apyPoints.length).toBe(3);
      expect(apyPoints[0].apyPct).toBe(0);
      expect(apyPoints[1].apyPct).toBe(99999.99);
      expect(apyPoints[2].apyPct).toBe(-15.5);
    });

    it("4.4 sanitizes non-numeric and NaN / undefined fields into safe zeroes", () => {
      const corruptPoint: any = {
        timestamp: "not-a-timestamp",
        impliedApyPct: NaN,
        underlyingApyPct: null,
        ptPrice: undefined,
        ytPrice: null,
      };

      const chartPoints = convertToChartDataPoints([corruptPoint]);
      expect(chartPoints.length).toBe(1);
      expect(chartPoints[0].timestamp).toBe(0);
      expect(chartPoints[0].impliedApy).toBe(0);
      expect(chartPoints[0].underlyingApy).toBe(0);
      expect(chartPoints[0].ptPrice).toBe(0);
      expect(chartPoints[0].ytPrice).toBe(1); // 1 - 0 = 1

      const apyPoints = convertToApyDataPoints([corruptPoint]);
      expect(apyPoints.length).toBe(1);
      expect(apyPoints[0].timestamp).toBe(0);
      expect(apyPoints[0].apyPct).toBe(0);
    });

    it("4.5 handles corrupt arrays containing null, undefined, primitives, or non-arrays safely", () => {
      const dirtyArray: any[] = [
        null,
        undefined,
        1234,
        "string",
        {},
        { timestamp: 1700000000, impliedApyPct: 5.0, ptPrice: 0.99 },
      ];

      const chartPoints = convertToChartDataPoints(dirtyArray as any);
      // Valid objects are converted, nulls/primitives are safely filtered out
      expect(chartPoints.length).toBe(2);
      expect(chartPoints[1].timestamp).toBe(1700000000);
      expect(chartPoints[1].impliedApy).toBe(5.0);

      const apyPoints = convertToApyDataPoints(dirtyArray as any);
      expect(apyPoints.length).toBe(2);

      // Non-array inputs
      // @ts-expect-error test non-array
      expect(convertToChartDataPoints(null)).toEqual([]);
      // @ts-expect-error test non-array
      expect(convertToChartDataPoints(undefined)).toEqual([]);
      // @ts-expect-error test non-array
      expect(convertToChartDataPoints("not-array")).toEqual([]);
      // @ts-expect-error test non-array
      expect(convertToChartDataPoints(12345)).toEqual([]);

      // @ts-expect-error test non-array
      expect(convertToApyDataPoints(null)).toEqual([]);
      // @ts-expect-error test non-array
      expect(convertToApyDataPoints(undefined)).toEqual([]);
      // @ts-expect-error test non-array
      expect(convertToApyDataPoints({})).toEqual([]);
    });

    it("4.6 preserves optional ledger parameter when present, omits when absent", () => {
      const withLedger: MarketChartPoint = {
        timestamp: 1700000000,
        impliedApyPct: 5,
        underlyingApyPct: 4,
        ptPrice: 0.98,
        ytPrice: 0.02,
        volumeUsd: 0,
        tvlUsd: 0,
        ledger: 987654,
      };

      const withoutLedger: MarketChartPoint = {
        timestamp: 1700000000,
        impliedApyPct: 5,
        underlyingApyPct: 4,
        ptPrice: 0.98,
        ytPrice: 0.02,
        volumeUsd: 0,
        tvlUsd: 0,
      };

      const chartWith = convertToChartDataPoints([withLedger]);
      expect(chartWith[0].ledger).toBe(987654);

      const chartWithout = convertToChartDataPoints([withoutLedger]);
      expect(chartWithout[0].ledger).toBeUndefined();

      const apyWith = convertToApyDataPoints([withLedger]);
      expect(apyWith[0].ledger).toBe(987654);

      const apyWithout = convertToApyDataPoints([withoutLedger]);
      expect(apyWithout[0].ledger).toBeUndefined();
    });
  });

  // ==========================================================================
  // Suite 5: Live Indexer Integration & Contract Verification (Real HTTP)
  // ==========================================================================
  describe("Suite 5: Live Indexer Verification Against Local Service", () => {
    let mockServer: any;
    let liveIndexerUrl: string;

    beforeAll(() => {
      mockServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const url = new URL(req.url);

          if (url.pathname === "/charts") {
            const market = url.searchParams.get("market") || "usdc-90d";
            const interval = url.searchParams.get("interval") || "1W";
            const points = [
              {
                timestamp: 1735689600,
                datetime: "2025-01-01T00:00:00.000Z",
                bucket: "2025-01-01T00:00:00.000Z",
                impliedApyPct: 8.5,
                impliedApy: 8.5,
                underlyingApyPct: 4.8,
                underlyingApy: 4.8,
                ptPrice: 0.98,
                ytPrice: 0.02,
                volumeUsd: 15000,
                volumeStroops: "150000000000",
                tvlUsd: 250000,
                tvlStroops: "2500000000000",
                open: 0.978,
                high: 0.982,
                low: 0.977,
                close: 0.98,
                tradeCount: 12,
              },
              {
                timestamp: 1735776000,
                datetime: "2025-01-02T00:00:00.000Z",
                bucket: "2025-01-02T00:00:00.000Z",
                impliedApyPct: 8.7,
                impliedApy: 8.7,
                underlyingApyPct: 4.85,
                underlyingApy: 4.85,
                ptPrice: 0.981,
                ytPrice: 0.019,
                volumeUsd: 18000,
                volumeStroops: "180000000000",
                tvlUsd: 260000,
                tvlStroops: "2600000000000",
                open: 0.98,
                high: 0.983,
                low: 0.979,
                close: 0.981,
                tradeCount: 15,
              },
            ];

            return Response.json({
              success: true,
              market,
              interval,
              count: points.length,
              data: points,
              summary: {
                volume24h: 18000,
                volume7d: 33000,
                tvl: 260000,
                highApy: 8.7,
                lowApy: 8.5,
                currentApy: 8.7,
                currentImpliedApy: 8.7,
                currentUnderlyingApy: 4.85,
                currentPrice: 0.981,
                currentPtPrice: 0.981,
                currentYtPrice: 0.019,
              },
            });
          }

          if (url.pathname === "/positions") {
            const user = url.searchParams.get("user") || "";
            if (user === "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27") {
              const positions = [
                {
                  marketId: "usdc-90d",
                  marketAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                  assetCode: "USDC",
                  costBasisStroops: "100000000",
                  costBasisUsd: 10.0,
                  averageEntryApy: 8.5,
                  currentPtBalance: "100000000",
                  currentYtBalance: "100000000",
                  currentLpBalance: "0",
                  currentPositionValueUsd: 10.5,
                  realizedPnlStroops: "0",
                  realizedPnlUsd: 0.0,
                  unrealizedPnlStroops: "5000000",
                  unrealizedPnlUsd: 0.5,
                  netPnlUsd: 0.5,
                  cumulativeClaimedYieldStroops: "0",
                  cumulativeClaimedYieldUsd: 0.0,
                  firstTradeTimestamp: 1735689600,
                  lastActivityTimestamp: 1735776000,
                  totalTradesCount: 2,
                },
              ];

              return Response.json({
                success: true,
                user,
                count: positions.length,
                positions,
                summary: {
                  userAddress: user,
                  totalCostBasisUsd: 10.0,
                  totalCurrentValueUsd: 10.5,
                  totalRealizedPnlUsd: 0.0,
                  totalUnrealizedPnlUsd: 0.5,
                  totalNetPnlUsd: 0.5,
                  totalClaimedYieldUsd: 0.0,
                  overallPortfolioApy: 8.5,
                  activePositionsCount: 1,
                  totalTransactionsCount: 2,
                },
              });
            }

            // Unknown or other user
            return Response.json({
              success: true,
              user,
              count: 0,
              positions: [],
              summary: {
                userAddress: user,
                totalCostBasisUsd: 0,
                totalCurrentValueUsd: 0,
                totalRealizedPnlUsd: 0,
                totalUnrealizedPnlUsd: 0,
                totalNetPnlUsd: 0,
                totalClaimedYieldUsd: 0,
                overallPortfolioApy: 0,
                activePositionsCount: 0,
                totalTransactionsCount: 0,
              },
            });
          }

          return new Response("Not Found", { status: 404 });
        },
      });

      liveIndexerUrl = `http://127.0.0.1:${mockServer.port}`;
    });

    afterAll(() => {
      mockServer?.stop(true);
    });

    it("5.1 queries live indexer /charts and maps real data points via conversion functions", async () => {
      const response = await fetchMarketChartData({
        market: "usdc-90d",
        interval: "1W",
        indexerApiUrl: liveIndexerUrl,
      });

      expect(response.success).toBe(true);
      expect(response.market).toBe("usdc-90d");
      expect(response.interval).toBe("1W");
      expect(response.count).toBeGreaterThan(0);
      expect(response.data.length).toBe(response.count);

      // Verify conversion
      const chartPoints = convertToChartDataPoints(response.data);
      expect(chartPoints.length).toBe(response.count);
      expect(chartPoints[0].impliedApy).toBeGreaterThan(0);
      expect(chartPoints[0].ptPrice).toBeGreaterThan(0);

      const apyPoints = convertToApyDataPoints(response.data);
      expect(apyPoints.length).toBe(response.count);
      expect(apyPoints[0].apyPct).toBeGreaterThan(0);
    });

    it("5.2 queries live indexer /positions for active test wallet with real positions", async () => {
      const response = await fetchUserPositionData({
        userAddress: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
        indexerApiUrl: liveIndexerUrl,
      });

      expect(response.success).toBe(true);
      expect(response.user).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(response.count).toBeGreaterThanOrEqual(1);
      expect(response.positions.length).toBe(response.count);
      expect(response.summary.userAddress).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(response.summary.totalCostBasisUsd).toBeGreaterThan(0);
    });

    it("5.3 queries live indexer /positions for unknown user returning HTTP 200 empty position state", async () => {
      const unknownUser = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
      const response = await fetchUserPositionData({
        userAddress: unknownUser,
        indexerApiUrl: liveIndexerUrl,
      });

      expect(response.success).toBe(true);
      expect(response.user).toBe(unknownUser);
      expect(response.count).toBe(0);
      expect(response.positions).toEqual([]);
      expect(response.summary.totalCostBasisUsd).toBe(0);
      expect(response.summary.activePositionsCount).toBe(0);
      expect(response.summary.totalTransactionsCount).toBe(0);
    });
  });
});

