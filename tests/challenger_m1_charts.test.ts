/**
 * ============================================================================
 * EMPIRICAL CHALLENGER TEST SUITE: MILESTONE 1 TIME-SERIES & OHLCV CHARTS
 * ============================================================================
 *
 * File: tests/challenger_m1_charts.test.ts
 * Target: http://127.0.0.1:8765
 *
 * Verification Dimensions:
 * 1. Health & Database State Baseline
 * 2. Protected Files SHA256 Checksum Invariance
 * 3. Multi-Market x Multi-Interval Matrix (1D, 1W, 1M, ALL across usdc-90d, usdc-30d, xlm-90d, pool/pt/yt addresses)
 * 4. Deep Mathematical Consistency & Data Oracles (monotonicity, OHLC bounds, APY finite bounds, summary calculations)
 * 5. High-Concurrency Stress Burst (100 parallel requests, latency profiling, zero SQLITE_BUSY, crash detection)
 * 6. Adversarial Fuzzing & Injection Handling (SQLi, XSS, Path Traversal, Unknown Markets, Malformed Intervals)
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const INDEXER_URL = process.env.INDEXER_API_URL || "http://127.0.0.1:8765";

interface MarketChartPoint {
  timestamp: number;
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  impliedApy: number;
  underlyingApy: number;
  ptPrice: number;
  ytPrice: number;
  volume: string;
  tvl: string;
  tradeCount: number;
}

interface MarketChartSummary {
  marketId: string;
  interval: string;
  highApy: number;
  lowApy: number;
  currentApy: number;
  highPrice: number;
  lowPrice: number;
  currentPrice: number;
  volumeTotal: string;
  currentTvl: string;
  tradesCount: number;
}

interface MarketChartsResponse {
  success: boolean;
  market: string;
  interval: string;
  count: number;
  data: MarketChartPoint[];
  summary: MarketChartSummary;
}

interface HealthResponse {
  status: string;
  uptimeSeconds: number;
  totalEvents: number;
  dbSizeBytes: number;
  walSizeBytes: number;
  catalogedContracts: number;
  lastIndexedLedger: number;
}

let baselineHealth: HealthResponse;

describe("EMPIRICAL CHALLENGER: Milestone 1 Verification Suite", () => {
  // --------------------------------------------------------------------------
  // Group 1: Service Baseline & Protected Files Invariants
  // --------------------------------------------------------------------------
  describe("1. Service Baseline & Protected Checksums", () => {
    it("connects to live Soroban Indexer and reports healthy status", async () => {
      const res = await fetch(`${INDEXER_URL}/health`);
      expect(res.status).toBe(200);
      const health = (await res.json()) as HealthResponse;
      expect(health.status).toBe("healthy");
      expect(health.uptimeSeconds).toBeGreaterThan(0);
      expect(health.totalEvents).toBeGreaterThan(100000);
      expect(health.catalogedContracts).toBe(16);
      baselineHealth = health;
    });

    it("verifies protected frontend files remain strictly unmodified (SHA256)", () => {
      const projectRoot = join(__dirname, "..");
      const indexerPath = join(projectRoot, "frontend", "src", "lib", "indexer.ts");
      const hookPath = join(projectRoot, "frontend", "src", "hooks", "useEventIndexer.ts");

      expect(existsSync(indexerPath)).toBe(true);
      expect(existsSync(hookPath)).toBe(true);

      const indexerSha = createHash("sha256").update(readFileSync(indexerPath)).digest("hex");
      const hookSha = createHash("sha256").update(readFileSync(hookPath)).digest("hex");

      expect(indexerSha).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
      expect(hookSha).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
    });
  });

  // --------------------------------------------------------------------------
  // Group 2: Multi-Market x Multi-Interval Matrix Verification
  // --------------------------------------------------------------------------
  describe("2. Multi-Market x Multi-Interval Matrix Verification", () => {
    const markets = ["usdc-90d", "usdc-30d", "xlm-90d"];
    const intervals: Array<{ name: string; expectedPoints: number | null; minPoints: number; strideSec: number }> = [
      { name: "1D", expectedPoints: 24, minPoints: 24, strideSec: 3600 },
      { name: "1W", expectedPoints: 168, minPoints: 168, strideSec: 3600 },
      { name: "1M", expectedPoints: 30, minPoints: 30, strideSec: 86400 },
      { name: "ALL", expectedPoints: null, minPoints: 30, strideSec: 86400 },
    ];

    for (const market of markets) {
      for (const interval of intervals) {
        it(`fetches ${market} chart for interval ${interval.name}`, async () => {
          const res = await fetch(`${INDEXER_URL}/charts?market=${market}&interval=${interval.name}`);
          expect(res.status).toBe(200);
          const body = (await res.json()) as MarketChartsResponse;

          expect(body.success).toBe(true);
          expect(body.market).toBe(market);
          expect(body.interval).toBe(interval.name);

          if (interval.expectedPoints !== null) {
            expect(body.count).toBe(interval.expectedPoints);
            expect(body.data.length).toBe(interval.expectedPoints);
          } else {
            expect(body.count).toBeGreaterThanOrEqual(interval.minPoints);
            expect(body.data.length).toBeGreaterThanOrEqual(interval.minPoints);
          }
        });
      }
    }

    it("supports /timeseries route alias identically to /charts", async () => {
      const chartRes = await fetch(`${INDEXER_URL}/charts?market=usdc-90d&interval=1D`);
      const timeseriesRes = await fetch(`${INDEXER_URL}/timeseries?market=usdc-90d&interval=1D`);

      expect(chartRes.status).toBe(200);
      expect(timeseriesRes.status).toBe(200);

      const chartBody = (await chartRes.json()) as MarketChartsResponse;
      const tsBody = (await timeseriesRes.json()) as MarketChartsResponse;

      expect(tsBody.success).toBe(true);
      expect(tsBody.count).toBe(chartBody.count);
      expect(tsBody.data.length).toBe(24);
      expect(tsBody.data[0].timestamp).toBe(chartBody.data[0].timestamp);
      expect(tsBody.data[23].timestamp).toBe(chartBody.data[23].timestamp);
    });

    it("resolves market via Pool contract address", async () => {
      const poolContract = "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF";
      const res = await fetch(`${INDEXER_URL}/charts?market=${poolContract}&interval=1D`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as MarketChartsResponse;
      expect(body.market).toBe("usdc-90d");
      expect(body.count).toBe(24);
    });

    it("resolves market via PT token contract address", async () => {
      const ptContract = "CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A";
      const res = await fetch(`${INDEXER_URL}/charts?market=${ptContract}&interval=1D`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as MarketChartsResponse;
      expect(body.market).toBe("usdc-90d");
      expect(body.count).toBe(24);
    });

    it("resolves market via YT token contract address", async () => {
      const ytContract = "CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73";
      const res = await fetch(`${INDEXER_URL}/charts?market=${ytContract}&interval=1D`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as MarketChartsResponse;
      expect(body.market).toBe("usdc-90d");
      expect(body.count).toBe(24);
    });
  });

  // --------------------------------------------------------------------------
  // Group 3: Deep Mathematical Consistency & Data Oracles
  // --------------------------------------------------------------------------
  describe("3. Deep Mathematical Consistency & Data Oracles", () => {
    const testCases = [
      { market: "usdc-90d", interval: "1D", stride: 3600 },
      { market: "usdc-90d", interval: "1W", stride: 3600 },
      { market: "usdc-90d", interval: "1M", stride: 86400 },
      { market: "usdc-90d", interval: "ALL", stride: 86400 },
      { market: "usdc-30d", interval: "1D", stride: 3600 },
      { market: "xlm-90d", interval: "1D", stride: 3600 },
    ];

    for (const tc of testCases) {
      it(`enforces strict monotonic timestamps and step sizes for ${tc.market} ${tc.interval}`, async () => {
        const res = await fetch(`${INDEXER_URL}/charts?market=${tc.market}&interval=${tc.interval}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as MarketChartsResponse;

        for (let i = 0; i < body.data.length; i++) {
          const pt = body.data[i];

          // 1. Timestamp is positive integer
          expect(Number.isInteger(pt.timestamp)).toBe(true);
          expect(pt.timestamp).toBeGreaterThan(0);

          // 2. Datetime is valid ISO 8601 string matching timestamp
          const parsedDate = new Date(pt.datetime);
          expect(isNaN(parsedDate.getTime())).toBe(false);
          expect(Math.floor(parsedDate.getTime() / 1000)).toBe(pt.timestamp);

          // 3. Strict Monotonicity: timestamps must strictly increase
          if (i > 0) {
            const prevPt = body.data[i - 1];
            expect(pt.timestamp).toBeGreaterThan(prevPt.timestamp);
            expect(pt.timestamp - prevPt.timestamp).toBe(tc.stride);
          }
        }
      });

      it(`enforces OHLC integrity, PT/YT price bounds, and finite APYs for ${tc.market} ${tc.interval}`, async () => {
        const res = await fetch(`${INDEXER_URL}/charts?market=${tc.market}&interval=${tc.interval}`);
        const body = (await res.json()) as MarketChartsResponse;

        for (let i = 0; i < body.data.length; i++) {
          const pt = body.data[i];

          // No NaN or undefined in any field
          expect(Number.isNaN(pt.open)).toBe(false);
          expect(Number.isNaN(pt.high)).toBe(false);
          expect(Number.isNaN(pt.low)).toBe(false);
          expect(Number.isNaN(pt.close)).toBe(false);
          expect(Number.isNaN(pt.impliedApy)).toBe(false);
          expect(Number.isNaN(pt.underlyingApy)).toBe(false);
          expect(Number.isNaN(pt.ptPrice)).toBe(false);
          expect(Number.isNaN(pt.ytPrice)).toBe(false);

          // High >= Low strictly
          expect(pt.high).toBeGreaterThanOrEqual(pt.low);

          // High >= Open, High >= Close, Low <= Open, Low <= Close (OHLC Envelope)
          expect(pt.high).toBeGreaterThanOrEqual(pt.open - 1e-9);
          expect(pt.high).toBeGreaterThanOrEqual(pt.close - 1e-9);
          expect(pt.low).toBeLessThanOrEqual(pt.open + 1e-9);
          expect(pt.low).toBeLessThanOrEqual(pt.close + 1e-9);

          // Prices strictly positive
          expect(pt.open).toBeGreaterThan(0);
          expect(pt.close).toBeGreaterThan(0);
          expect(pt.ptPrice).toBeGreaterThan(0);
          expect(pt.ptPrice).toBeLessThanOrEqual(1.05); // Reasonable DeFi upper bound

          // PT + YT sum constraint (approx 1.0)
          expect(pt.ytPrice).toBeGreaterThanOrEqual(0);
          const priceSum = pt.ptPrice + pt.ytPrice;
          expect(Math.abs(priceSum - 1.0)).toBeLessThan(0.005);

          // Implied APY bounds: non-negative and finite
          expect(pt.impliedApy).toBeGreaterThanOrEqual(0);
          expect(pt.impliedApy).toBeLessThanOrEqual(500); // Indexer clamp guard

          // Underlying APY bounds
          expect(pt.underlyingApy).toBeGreaterThanOrEqual(0);
          expect(pt.underlyingApy).toBeLessThanOrEqual(100);

          // Volume and TVL valid string representations
          expect(typeof pt.volume).toBe("string");
          expect(/^\d+$/.test(pt.volume)).toBe(true);
          expect(typeof pt.tvl).toBe("string");
          expect(/^\d+$/.test(pt.tvl)).toBe(true);

          // Trade count non-negative integer
          expect(Number.isInteger(pt.tradeCount)).toBe(true);
          expect(pt.tradeCount).toBeGreaterThanOrEqual(0);
        }
      });

      it(`validates summary metric aggregations for ${tc.market} ${tc.interval}`, async () => {
        const res = await fetch(`${INDEXER_URL}/charts?market=${tc.market}&interval=${tc.interval}`);
        const body = (await res.json()) as MarketChartsResponse;
        const summary = body.summary;
        const data = body.data;

        expect(summary.marketId).toBe(tc.market);
        expect(summary.interval).toBe(tc.interval);

        // High >= Low
        expect(summary.highPrice).toBeGreaterThanOrEqual(summary.lowPrice);
        expect(summary.highApy).toBeGreaterThanOrEqual(summary.lowApy);

        // Current price & APY match last point
        const lastPt = data[data.length - 1];
        expect(summary.currentPrice).toBe(lastPt.close);
        expect(summary.currentApy).toBe(lastPt.impliedApy);

        // Trades count matches sum of points
        const expectedTrades = data.reduce((acc, p) => acc + (p.tradeCount || 0), 0);
        expect(summary.tradesCount).toBe(expectedTrades);

        // Volume total matches sum of points
        const expectedVolume = data.reduce((acc, p) => acc + BigInt(p.volume || "0"), 0n).toString();
        expect(summary.volumeTotal).toBe(expectedVolume);

        // No NaN in summary
        expect(Number.isNaN(summary.highApy)).toBe(false);
        expect(Number.isNaN(summary.lowApy)).toBe(false);
        expect(Number.isNaN(summary.currentApy)).toBe(false);
        expect(Number.isNaN(summary.highPrice)).toBe(false);
        expect(Number.isNaN(summary.lowPrice)).toBe(false);
        expect(Number.isNaN(summary.currentPrice)).toBe(false);
      });
    }
  });

  // --------------------------------------------------------------------------
  // Group 4: High-Concurrency Burst & Stress Testing (Empirical Challenge)
  // --------------------------------------------------------------------------
  describe("4. High-Concurrency Stress Testing & SQLite Lock Verification", () => {
    it("handles 100 concurrent multi-market/multi-interval queries with zero SQLITE_BUSY errors", async () => {
      const CONCURRENCY = 100;
      const marketsPool = ["usdc-90d", "usdc-30d", "xlm-90d"];
      const intervalsPool = ["1D", "1W", "1M", "ALL"];
      const endpointsPool = ["/charts", "/timeseries"];

      const requests: Array<Promise<{ status: number; durationMs: number; text: string; success: boolean }>> = [];

      const startTime = performance.now();

      for (let i = 0; i < CONCURRENCY; i++) {
        const market = marketsPool[i % marketsPool.length];
        const interval = intervalsPool[i % intervalsPool.length];
        const endpoint = endpointsPool[i % endpointsPool.length];
        const url = `${INDEXER_URL}${endpoint}?market=${market}&interval=${interval}`;

        requests.push(
          (async () => {
            const reqStart = performance.now();
            try {
              const res = await fetch(url);
              const text = await res.text();
              const reqDuration = performance.now() - reqStart;
              let success = false;
              if (res.status === 200) {
                const parsed = JSON.parse(text);
                success = parsed.success === true && Array.isArray(parsed.data);
              }
              return { status: res.status, durationMs: reqDuration, text, success };
            } catch (err) {
              return { status: 0, durationMs: performance.now() - reqStart, text: String(err), success: false };
            }
          })()
        );
      }

      const results = await Promise.all(requests);
      const totalTimeMs = performance.now() - startTime;

      // 1. Verify 100% success rate
      const successfulRequests = results.filter((r) => r.status === 200 && r.success);
      expect(successfulRequests.length).toBe(CONCURRENCY);

      // 2. Verify ZERO SQLITE_BUSY errors in any response
      for (const res of results) {
        expect(res.text.includes("SQLITE_BUSY")).toBe(false);
        expect(res.text.includes("database is locked")).toBe(false);
        expect(res.text.includes("Internal Server Error")).toBe(false);
      }

      // 3. Compute Latency Profile
      const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
      const minLatency = durations[0];
      const maxLatency = durations[durations.length - 1];
      const meanLatency = durations.reduce((a, b) => a + b, 0) / durations.length;
      const p50 = durations[Math.floor(durations.length * 0.5)];
      const p95 = durations[Math.floor(durations.length * 0.95)];
      const p99 = durations[Math.floor(durations.length * 0.99)];

      console.log(`\n      [Empirical Concurrency Benchmark - ${CONCURRENCY} Parallel Requests]`);
      console.log(`      Total Burst Duration : ${totalTimeMs.toFixed(1)} ms`);
      console.log(`      Throughput           : ${(CONCURRENCY / (totalTimeMs / 1000)).toFixed(1)} req/sec`);
      console.log(`      Min Latency          : ${minLatency.toFixed(1)} ms`);
      console.log(`      Mean Latency         : ${meanLatency.toFixed(1)} ms`);
      console.log(`      Median (p50) Latency : ${p50.toFixed(1)} ms`);
      console.log(`      p95 Latency          : ${p95.toFixed(1)} ms`);
      console.log(`      p99 Latency          : ${p99.toFixed(1)} ms`);
      console.log(`      Max Latency          : ${maxLatency.toFixed(1)} ms\n`);

      // 4. Assert strict latency SLA: p99 must be under 3000ms over LAN/WiFi
      expect(p99).toBeLessThan(3000);
      expect(meanLatency).toBeLessThan(500);
    });

    it("survives heavy burst of 200 rapid concurrent queries without database lock degradation", async () => {
      const CONCURRENCY = 200;
      const marketsPool = ["usdc-90d", "usdc-30d", "xlm-90d", "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF"];
      const intervalsPool = ["1D", "1W", "1M", "ALL"];
      const endpointsPool = ["/charts", "/timeseries"];

      const requests: Array<Promise<{ status: number; durationMs: number; text: string; success: boolean }>> = [];

      const startTime = performance.now();

      for (let i = 0; i < CONCURRENCY; i++) {
        const market = marketsPool[i % marketsPool.length];
        const interval = intervalsPool[i % intervalsPool.length];
        const endpoint = endpointsPool[i % endpointsPool.length];
        const url = `${INDEXER_URL}${endpoint}?market=${encodeURIComponent(market)}&interval=${interval}`;

        requests.push(
          (async () => {
            const reqStart = performance.now();
            try {
              const res = await fetch(url);
              const text = await res.text();
              const reqDuration = performance.now() - reqStart;
              let success = false;
              if (res.status === 200) {
                const parsed = JSON.parse(text);
                success = parsed.success === true && Array.isArray(parsed.data);
              }
              return { status: res.status, durationMs: reqDuration, text, success };
            } catch (err) {
              return { status: 0, durationMs: performance.now() - reqStart, text: String(err), success: false };
            }
          })()
        );
      }

      const results = await Promise.all(requests);
      const totalTimeMs = performance.now() - startTime;

      const successfulRequests = results.filter((r) => r.status === 200 && r.success);
      expect(successfulRequests.length).toBe(CONCURRENCY);

      for (const res of results) {
        expect(res.text.includes("SQLITE_BUSY")).toBe(false);
        expect(res.text.includes("database is locked")).toBe(false);
      }

      const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
      const minLatency = durations[0];
      const maxLatency = durations[durations.length - 1];
      const meanLatency = durations.reduce((a, b) => a + b, 0) / durations.length;
      const p50 = durations[Math.floor(durations.length * 0.5)];
      const p95 = durations[Math.floor(durations.length * 0.95)];
      const p99 = durations[Math.floor(durations.length * 0.99)];

      console.log(`\n      [Empirical Sustained Stress Benchmark - ${CONCURRENCY} Parallel Requests]`);
      console.log(`      Total Burst Duration : ${totalTimeMs.toFixed(1)} ms`);
      console.log(`      Throughput           : ${(CONCURRENCY / (totalTimeMs / 1000)).toFixed(1)} req/sec`);
      console.log(`      Min Latency          : ${minLatency.toFixed(1)} ms`);
      console.log(`      Mean Latency         : ${meanLatency.toFixed(1)} ms`);
      console.log(`      Median (p50) Latency : ${p50.toFixed(1)} ms`);
      console.log(`      p95 Latency          : ${p95.toFixed(1)} ms`);
      console.log(`      p99 Latency          : ${p99.toFixed(1)} ms`);
      console.log(`      Max Latency          : ${maxLatency.toFixed(1)} ms\n`);

      expect(p99).toBeLessThan(4000);
      expect(meanLatency).toBeLessThan(800);
    });

    it("verifies indexer health and memory stability post-stress burst", async () => {
      const res = await fetch(`${INDEXER_URL}/health`);
      expect(res.status).toBe(200);
      const currentHealth = (await res.json()) as HealthResponse;

      expect(currentHealth.status).toBe("healthy");
      // Uptime must have increased, proving the daemon did NOT crash or restart!
      expect(currentHealth.uptimeSeconds).toBeGreaterThanOrEqual(baselineHealth.uptimeSeconds);
      // DB size must be intact and non-corrupted
      expect(currentHealth.dbSizeBytes).toBeGreaterThan(400 * 1024 * 1024);
    });
  });

  // --------------------------------------------------------------------------
  // Group 5: Adversarial Inputs, Security Injections & Edge Cases
  // --------------------------------------------------------------------------
  describe("5. Adversarial Fuzzing, Injections & Edge Cases", () => {
    it("handles lowercase and mixed-case intervals gracefully", async () => {
      const res1 = await fetch(`${INDEXER_URL}/charts?market=usdc-90d&interval=1d`);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.interval).toBe("1D");
      expect(body1.count).toBe(24);

      const res2 = await fetch(`${INDEXER_URL}/charts?market=usdc-90d&interval=1w`);
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.interval).toBe("1W");
      expect(body2.count).toBe(168);
    });

    it("normalizes uppercase market identifier", async () => {
      const res = await fetch(`${INDEXER_URL}/charts?market=USDC-90D&interval=1D`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.market).toBe("usdc-90d");
      expect(body.count).toBe(24);
    });

    it("handles whitespace-padded market slugs safely", async () => {
      const res = await fetch(`${INDEXER_URL}/charts?market=%20usdc-90d%20&interval=1D`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.market).toBe("usdc-90d");
      expect(body.count).toBe(24);
    });

    it("defaults to 1D when given an unrecognized interval string", async () => {
      const res = await fetch(`${INDEXER_URL}/charts?market=usdc-90d&interval=INVALID_INTERVAL_100Y`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.interval).toBe("1D");
      expect(body.count).toBe(24);
    });

    it("defaults to usdc-90d and 1D when parameters are omitted", async () => {
      const res = await fetch(`${INDEXER_URL}/charts`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.market).toBe("usdc-90d");
      expect(body.interval).toBe("1D");
      expect(body.count).toBe(24);
    });

    it("rejects unknown market slug with HTTP 400 and clean JSON error", async () => {
      const res = await fetch(`${INDEXER_URL}/charts?market=nonexistent-market-xyz`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Market not found: nonexistent-market-xyz");
    });

    it("defends against SQL injection attempts cleanly without crashing", async () => {
      const sqliAttempts = [
        "usdc-90d' OR '1'='1",
        "usdc-90d'; DROP TABLE market_snapshots; --",
        "usdc-90d' UNION SELECT 1,2,3,4,5,6,7,8,9,10,11,12,13 --",
      ];

      for (const sqli of sqliAttempts) {
        const res = await fetch(`${INDEXER_URL}/charts?market=${encodeURIComponent(sqli)}&interval=1D`);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error).toContain("Market not found");
      }
    });

    it("defends against path traversal attacks cleanly", async () => {
      const traversalAttempts = [
        "../../../../etc/passwd",
        "..\\..\\..\\windows\\system32\\cmd.exe",
        "%2e%2e%2f%2e%2e%2f",
      ];

      for (const path of traversalAttempts) {
        const res = await fetch(`${INDEXER_URL}/charts?market=${encodeURIComponent(path)}&interval=1D`);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
      }
    });

    it("defends against XSS payloads cleanly", async () => {
      const xssPayload = "<script>alert('pwned')</script>";
      const res = await fetch(`${INDEXER_URL}/charts?market=${encodeURIComponent(xssPayload)}&interval=1D`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });
});
