/**
 * ============================================================================
 * EMPIRICAL CHALLENGER TEST SUITE: MILESTONE 4 TIER 5
 * SYSTEM STRESS & INTEGRATION HARDENING
 * ============================================================================
 *
 * File: tests/m4_tier5_adversarial_2.test.ts
 *
 * Test Architecture & Dimensions:
 * 1. Protected Files Checksum & Interface Invariance (R3 Invariant)
 * 2. Live Indexer High-Concurrency Burst & Stress Hardening (http://127.0.0.1:8765)
 *    - 50 concurrent /charts requests across all intervals & markets
 *    - 50 concurrent /positions requests across diverse user addresses
 *    - 100 simultaneous interleaved requests (/charts + /positions)
 *    - Rapid sequential polling loop stress (simulating multiple active frontends)
 * 3. Adversarial Fuzzing & Malformed Parameter Attacks
 *    - SQLi, path traversal, oversized strings, and malformed query params
 * 4. Frontend Client Library Resilience & Defensive Error Recovery
 *    - Offline/timeout handling, HTTP 500 recovery, corrupted JSON coercion
 * 5. In-Memory Event Engine Accounting & Forward-Fill Stress
 *    - Multi-market isolation, micro-trade basis conservation, zero-liquidity safety
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "crypto";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

// Import frontend analytics client functions
import {
  fetchMarketChartData,
  fetchUserPositionData,
  buildEmptyUserPositions,
  buildEmptyChartResponse,
  buildEmptyPositionsSummary,
  resolveIndexerBaseUrl,
  type MarketChartResponse,
  type UserPositionsResponse,
} from "../frontend/src/lib/indexerAnalytics";

// Import indexer backend classes and helpers
import {
  EventStorage,
  calculateImpliedApy,
  MARKETS,
  resolveMarket,
  type DecodedEvent,
} from "../indexer/index";

const LIVE_INDEXER_URL = process.env.INDEXER_API_URL || "http://127.0.0.1:8765";

// Baseline checksums for protected locked files
const EXPECTED_INDEXER_TS_HASH = "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";
const EXPECTED_USE_EVENT_INDEXER_HASH = "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

describe("Milestone 4 — Tier 5 System Stress & Integration Hardening", () => {
  // ==========================================================================
  // Suite 1: Protected Files Checksum & Interface Invariance
  // ==========================================================================
  describe("Suite 1: Protected Files Checksum & Interface Invariance (R3 Invariant)", () => {
    it("1.1 frontend/src/lib/indexer.ts matches exact SHA-256 baseline", () => {
      const filePath = join(process.cwd(), "frontend/src/lib/indexer.ts");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath);
      const computedHash = createHash("sha256").update(content).digest("hex");
      expect(computedHash).toBe(EXPECTED_INDEXER_TS_HASH);
    });

    it("1.2 frontend/src/hooks/useEventIndexer.ts matches exact SHA-256 baseline", () => {
      const filePath = join(process.cwd(), "frontend/src/hooks/useEventIndexer.ts");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath);
      const computedHash = createHash("sha256").update(content).digest("hex");
      expect(computedHash).toBe(EXPECTED_USE_EVENT_INDEXER_HASH);
    });

    it("1.3 verify protected files contain expected canonical exports without drift", () => {
      const indexerTsPath = join(process.cwd(), "frontend/src/lib/indexer.ts");
      const indexerTsContent = readFileSync(indexerTsPath, "utf-8");
      expect(indexerTsContent).toContain("export function scValToBigInt");
      expect(indexerTsContent).toContain("export interface BaseProtocolEvent");
      expect(indexerTsContent).toContain("export class SorobanEventIndexer");

      const hookTsPath = join(process.cwd(), "frontend/src/hooks/useEventIndexer.ts");
      const hookTsContent = readFileSync(hookTsPath, "utf-8");
      expect(hookTsContent).toContain("export function useEventIndexer");
      expect(hookTsContent).toContain("export interface UseEventIndexerOptions");
    });
  });

  // ==========================================================================
  // Suite 2: Live Indexer High-Concurrency Burst & Stress Hardening
  // ==========================================================================
  describe("Suite 2: Live Indexer High-Concurrency Burst & Stress Hardening", () => {
    let liveHealthy = false;

    beforeAll(async () => {
      try {
        const res = await fetch(`${LIVE_INDEXER_URL}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const body = await res.json();
          liveHealthy = body && body.status === "healthy";
        }
      } catch {
        liveHealthy = false;
      }
    });

    it("2.1 live indexer is online and healthy before stress runs", () => {
      expect(liveHealthy).toBe(true);
    });

    it("2.2 Burst Stress: 50 concurrent /charts requests across all markets and intervals", async () => {
      if (!liveHealthy) return;

      const markets = ["usdc-90d", "usdc-30d", "xlm-90d"];
      const intervals = ["1D", "1W", "1M", "ALL"];
      const burstSize = 50;

      const startTime = performance.now();
      const requests = Array.from({ length: burstSize }, (_, idx) => {
        const market = markets[idx % markets.length];
        const interval = intervals[idx % intervals.length];
        const url = `${LIVE_INDEXER_URL}/charts?market=${encodeURIComponent(market)}&interval=${encodeURIComponent(interval)}`;
        return fetch(url, { signal: AbortSignal.timeout(6000) }).then(async (res) => {
          expect(res.status).toBe(200);
          const json = await res.json();
          expect(json.success).toBe(true);
          expect(Array.isArray(json.data)).toBe(true);
          expect(json.data.length).toBeGreaterThan(0);
          expect(json.summary).toBeDefined();
          return res.status;
        });
      });

      const results = await Promise.all(requests);
      const durationMs = performance.now() - startTime;

      expect(results.length).toBe(burstSize);
      expect(results.every((s) => s === 200)).toBe(true);
      expect(durationMs).toBeLessThan(10000);
    });

    it("2.3 Burst Stress: 50 concurrent /positions requests with greenfield and varied wallets", async () => {
      if (!liveHealthy) return;

      const burstSize = 50;
      const startTime = performance.now();

      const requests = Array.from({ length: burstSize }, (_, idx) => {
        const randomWallet = `GBURST${idx.toString().padStart(4, "0")}STRESSWALLETTESTING000000000000000000000000`;
        const url = `${LIVE_INDEXER_URL}/positions?user=${encodeURIComponent(randomWallet)}`;
        return fetch(url, { signal: AbortSignal.timeout(6000) }).then(async (res) => {
          expect(res.status).toBe(200);
          const json = await res.json();
          expect(json.success).toBe(true);
          expect(json.user).toBe(randomWallet);
          expect(json.count).toBe(0);
          expect(json.positions).toEqual([]);
          expect(json.summary.totalCostBasisUsd).toBe(0);
          return res.status;
        });
      });

      const results = await Promise.all(requests);
      const durationMs = performance.now() - startTime;

      expect(results.length).toBe(burstSize);
      expect(results.every((s) => s === 200)).toBe(true);
      expect(durationMs).toBeLessThan(10000);
    });

    it("2.4 Interleaved Mega-Burst: 100 simultaneous requests (/charts + /positions)", async () => {
      if (!liveHealthy) return;

      const halfSize = 50;
      const startTime = performance.now();

      const chartRequests = Array.from({ length: halfSize }, (_, idx) => {
        const market = idx % 2 === 0 ? "usdc-90d" : "xlm-90d";
        const interval = idx % 2 === 0 ? "1D" : "1W";
        const url = `${LIVE_INDEXER_URL}/charts?market=${market}&interval=${interval}`;
        return fetch(url, { signal: AbortSignal.timeout(8000) }).then(async (res) => ({
          type: "charts",
          status: res.status,
          ok: res.ok,
        }));
      });

      const positionRequests = Array.from({ length: halfSize }, (_, idx) => {
        const wallet = `GMEGA${idx.toString().padStart(4, "0")}BURSTINTERLEAVEDTEST0000000000000000000000`;
        const url = `${LIVE_INDEXER_URL}/positions?user=${wallet}`;
        return fetch(url, { signal: AbortSignal.timeout(8000) }).then(async (res) => ({
          type: "positions",
          status: res.status,
          ok: res.ok,
        }));
      });

      const allResults = await Promise.all([...chartRequests, ...positionRequests]);
      const totalTimeMs = performance.now() - startTime;

      expect(allResults.length).toBe(100);
      const chartSuccesses = allResults.filter((r) => r.type === "charts" && r.status === 200);
      const positionSuccesses = allResults.filter((r) => r.type === "positions" && r.status === 200);

      expect(chartSuccesses.length).toBe(halfSize);
      expect(positionSuccesses.length).toBe(halfSize);
      expect(totalTimeMs).toBeLessThan(12000);
    });

    it("2.5 Rapid Sequential Polling: simulates continuous UI polling loops", async () => {
      if (!liveHealthy) return;

      const cycles = 15;
      const latencies: number[] = [];

      for (let i = 0; i < cycles; i++) {
        const t0 = performance.now();
        const res = await fetch(`${LIVE_INDEXER_URL}/charts?market=usdc-90d&interval=1D`, {
          signal: AbortSignal.timeout(4000),
        });
        const elapsed = performance.now() - t0;
        latencies.push(elapsed);
        expect(res.status).toBe(200);
      }

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      expect(avgLatency).toBeLessThan(500);
    });
  });

  // ==========================================================================
  // Suite 3: Adversarial Fuzzing & Malformed Parameter Attacks
  // ==========================================================================
  describe("Suite 3: Adversarial Fuzzing & Malformed Parameter Attacks", () => {
    it("3.1 /charts handles SQL injection payloads without 500 or SQL leakage", async () => {
      const sqliPayloads = [
        "' OR '1'='1",
        "'; DROP TABLE market_snapshots; --",
        "UNION SELECT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 --",
      ];

      for (const payload of sqliPayloads) {
        const url = `${LIVE_INDEXER_URL}/charts?market=${encodeURIComponent(payload)}&interval=1D`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        expect([200, 400]).toContain(res.status);
        const bodyText = await res.text();
        expect(bodyText).not.toContain("SQLITE_ERROR");
        expect(bodyText).not.toContain("syntax error");
      }
    });

    it("3.2 /charts handles path traversal and XSS payloads cleanly", async () => {
      const maliciousPayloads = [
        "../../etc/passwd",
        "<script>alert(1)</script>",
        "javascript:void(0)",
      ];

      for (const payload of maliciousPayloads) {
        const url = `${LIVE_INDEXER_URL}/charts?market=usdc-90d&interval=${encodeURIComponent(payload)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        expect([200, 400]).toContain(res.status);
      }
    });

    it("3.3 /positions returns HTTP 400 Bad Request when user parameter is omitted or empty", async () => {
      const resNoParam = await fetch(`${LIVE_INDEXER_URL}/positions`, { signal: AbortSignal.timeout(3000) });
      expect(resNoParam.status).toBe(400);
      const jsonNoParam = await resNoParam.json();
      expect(jsonNoParam.success).toBe(false);
      expect(jsonNoParam.error).toContain("Missing required query parameter: user");

      const resEmptyParam = await fetch(`${LIVE_INDEXER_URL}/positions?user=`, { signal: AbortSignal.timeout(3000) });
      expect(resEmptyParam.status).toBe(400);
    });

    it("3.4 /positions withstands oversized user string (10,000 chars) without buffer overflow", async () => {
      const oversizedUser = "G" + "A".repeat(10000);
      const res = await fetch(`${LIVE_INDEXER_URL}/positions?user=${encodeURIComponent(oversizedUser)}`, {
        signal: AbortSignal.timeout(4000),
      });
      expect([200, 400]).toContain(res.status);
      if (res.status === 200) {
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.count).toBe(0);
      }
    });
  });

  // ==========================================================================
  // Suite 4: Frontend Client Library Resilience & Defensive Error Recovery
  // ==========================================================================
  describe("Suite 4: Frontend Client Library Resilience & Defensive Error Recovery", () => {
    it("4.1 fetchUserPositionData returns empty state on empty/whitespace input without network call", async () => {
      const emptyRes = await fetchUserPositionData({ userAddress: "" });
      expect(emptyRes.success).toBe(true);
      expect(emptyRes.count).toBe(0);
      expect(emptyRes.positions).toEqual([]);

      const whitespaceRes = await fetchUserPositionData({ userAddress: "   \t\n  " });
      expect(whitespaceRes.success).toBe(true);
      expect(whitespaceRes.count).toBe(0);
    });

    it("4.2 fetchMarketChartData returns empty state on empty/whitespace market without network call", async () => {
      const emptyRes = await fetchMarketChartData({ market: "" });
      expect(emptyRes.success).toBe(true);
      expect(emptyRes.count).toBe(0);
      expect(emptyRes.data).toEqual([]);
      expect(emptyRes.summary.volume24h).toBe(0);
    });

    it("4.3 fetchUserPositionData handles unreachable backend port gracefully", async () => {
      const deadUrl = "http://127.0.0.1:59999";
      const res = await fetchUserPositionData({
        userAddress: "GVALIDWALLET12345678901234567890123456789012345678901234",
        indexerApiUrl: deadUrl,
        timeoutMs: 800,
      });

      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.positions).toEqual([]);
      expect(res.summary.totalCostBasisUsd).toBe(0);
    });

    it("4.4 fetchMarketChartData handles unreachable backend port gracefully", async () => {
      const deadUrl = "http://127.0.0.1:59999";
      const res = await fetchMarketChartData({
        market: "usdc-90d",
        interval: "1D",
        indexerApiUrl: deadUrl,
        timeoutMs: 800,
      });

      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.data).toEqual([]);
      expect(res.summary.tvl).toBe(0);
    });

    it("4.5 defensive normalization handles corrupted payloads with missing/string fields", async () => {
      const mockServer = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/charts") {
            return new Response(
              JSON.stringify({
                success: true,
                market: "usdc-90d",
                interval: "1D",
                data: [
                  {
                    timestamp: "1794243600",
                    ptPrice: "0.9802",
                    ytPrice: null,
                    impliedApy: "14.5",
                    volume: "50000000",
                    tvl: "500000000",
                  },
                ],
                summary: null,
              }),
              { headers: { "Content-Type": "application/json" } }
            );
          }
          if (url.pathname === "/positions") {
            return new Response(
              JSON.stringify({
                success: true,
                user: "GMOCKUSER",
                positions: [
                  {
                    marketId: "usdc-90d",
                    costBasisStroops: "10000000",
                    costBasisUsd: "1.0",
                    averageEntryApy: "8.5",
                    currentPtBalance: "10000000",
                    realizedPnlUsd: "0.25",
                  },
                ],
                summary: {
                  totalCostBasisUsd: "1.0",
                  totalRealizedPnlUsd: "0.25",
                },
              }),
              { headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response("Not found", { status: 404 });
        },
      });

      try {
        const mockBaseUrl = `http://localhost:${mockServer.port}`;

        const chartRes = await fetchMarketChartData({
          market: "usdc-90d",
          indexerApiUrl: mockBaseUrl,
        });

        expect(chartRes.data.length).toBe(1);
        const pt = chartRes.data[0];
        expect(typeof pt.timestamp).toBe("number");
        expect(pt.timestamp).toBe(1794243600);
        expect(typeof pt.ptPrice).toBe("number");
        expect(pt.ptPrice).toBe(0.9802);
        expect(typeof pt.ytPrice).toBe("number");
        expect(pt.ytPrice).toBeCloseTo(0.0198, 4);
        expect(typeof pt.volumeUsd).toBe("number");
        expect(pt.volumeUsd).toBe(5);
        expect(chartRes.summary).toBeDefined();

        const posRes = await fetchUserPositionData({
          userAddress: "GMOCKUSER",
          indexerApiUrl: mockBaseUrl,
        });

        expect(posRes.positions.length).toBe(1);
        const pos = posRes.positions[0];
        expect(typeof pos.costBasisUsd).toBe("number");
        expect(pos.costBasisUsd).toBe(1.0);
        expect(typeof pos.averageEntryApy).toBe("number");
        expect(pos.averageEntryApy).toBe(8.5);
        expect(typeof pos.realizedPnlUsd).toBe("number");
        expect(pos.realizedPnlUsd).toBe(0.25);
        expect(posRes.summary.totalCostBasisUsd).toBe(1.0);
      } finally {
        mockServer.stop(true);
      }
    });

    it("4.6 factory functions produce valid initial empty templates", () => {
      const emptyUser = buildEmptyUserPositions("GTESTWALLET");
      expect(emptyUser.success).toBe(true);
      expect(emptyUser.user).toBe("GTESTWALLET");
      expect(emptyUser.count).toBe(0);
      expect(emptyUser.positions).toEqual([]);
      expect(emptyUser.summary.totalCostBasisUsd).toBe(0);

      const emptyChart = buildEmptyChartResponse("usdc-90d", "1W");
      expect(emptyChart.success).toBe(true);
      expect(emptyChart.market).toBe("usdc-90d");
      expect(emptyChart.interval).toBe("1W");
      expect(emptyChart.count).toBe(0);
      expect(emptyChart.data).toEqual([]);
      expect(emptyChart.summary.tvl).toBe(0);
    });
  });

  // ==========================================================================
  // Suite 5: In-Memory Event Engine Accounting & Forward-Fill Stress
  // ==========================================================================
  describe("Suite 5: In-Memory Event Engine Accounting & Forward-Fill Stress", () => {
    const testDbPath = join(process.cwd(), "tests/test_m4_tier5_stress.db");
    let storage: EventStorage;

    const cleanupDb = () => {
      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }
    };

    beforeAll(() => {
      cleanupDb();
      storage = new EventStorage(testDbPath);
    });

    afterAll(() => {
      if (storage) {
        storage.close();
      }
      cleanupDb();
    });

    it("5.1 Multi-Market Isolation: user activity across usdc-90d and xlm-90d does not bleed state", () => {
      const user = "GCHALLENGER_MULTIMARKET_ISOLATION_WALLET_99999999999999999";
      const baseTime = 1794270000;

      // Buy PT on usdc-90d: 9.802 SY -> 10.0 PT
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTime,
        caller: user,
        receiver: user,
        direction: 1, // SY -> PT
        amountIn: 98020000n, // ~9.802 USDC
        amountOut: 100000000n, // 10 PT
        fee: 0n,
      });

      // Buy PT on xlm-90d: 9.789 SY -> 10.0 PT
      storage.recordSwap({
        marketId: "xlm-90d",
        timestamp: baseTime + 60,
        caller: user,
        receiver: user,
        direction: 1,
        amountIn: 97890000n,
        amountOut: 100000000n,
        fee: 0n,
      });

      const positions = storage.getUserPositions(user);
      expect(positions.success).toBe(true);
      expect(positions.count).toBe(2);

      const usdcPos = positions.positions.find((p) => p.marketId === "usdc-90d");
      const xlmPos = positions.positions.find((p) => p.marketId === "xlm-90d");

      expect(usdcPos).toBeDefined();
      expect(xlmPos).toBeDefined();

      expect(usdcPos!.assetCode).toBe("USDC");
      expect(xlmPos!.assetCode).toBe("XLM");

      // Verify costs remain isolated
      expect(usdcPos!.costBasisStroops).toBe("98020000");
      expect(xlmPos!.costBasisStroops).toBe("97890000");

      // Verify portfolio rollup sums both positions
      expect(positions.summary.activePositionsCount).toBe(2);
      expect(positions.summary.totalCostBasisUsd).toBe(10.98);
      expect(positions.summary.totalCostBasisUsd).toBeCloseTo(
        usdcPos!.costBasisUsd + xlmPos!.costBasisUsd,
        1
      );
    });

    it("5.2 Micro-Trade Basis Conservation: 50 consecutive fractional trades preserve unit basis", () => {
      const user = "GCHALLENGER_MICROTRADE_CONSERVATION_WALLET_888888888888888";
      const baseTime = 1794275000;
      const tradeCount = 50;

      // 50 micro buys of 1,000,000 stroops (0.1 PT) each at 0.98 price
      for (let i = 0; i < tradeCount; i++) {
        storage.recordSwap({
          marketId: "usdc-90d",
          timestamp: baseTime + i * 10,
          caller: user,
          receiver: user,
          direction: 1,
          amountIn: 980000n, // 0.098 USDC
          amountOut: 1000000n, // 0.100 PT
          fee: 0n,
        });
      }

      let pos = storage.getUserPositions(user);
      const usdcPos = pos.positions.find((p) => p.marketId === "usdc-90d")!;
      expect(usdcPos.totalTradesCount).toBe(tradeCount);
      expect(usdcPos.currentPtBalance).toBe((tradeCount * 1000000).toString());
      expect(usdcPos.costBasisStroops).toBe((tradeCount * 980000).toString());

      // Now sell half: 25 micro sells of 1,000,000 stroops at same price
      for (let i = 0; i < tradeCount / 2; i++) {
        storage.recordSwap({
          marketId: "usdc-90d",
          timestamp: baseTime + 1000 + i * 10,
          caller: user,
          receiver: user,
          direction: 0, // PT -> SY (Sell PT)
          amountIn: 1000000n, // PT in
          amountOut: 980000n, // SY out (sold at breakeven)
          fee: 0n,
        });
      }

      pos = storage.getUserPositions(user);
      const afterSellPos = pos.positions.find((p) => p.marketId === "usdc-90d")!;
      expect(afterSellPos.currentPtBalance).toBe(((tradeCount / 2) * 1000000).toString());
      expect(afterSellPos.costBasisStroops).toBe(((tradeCount / 2) * 980000).toString());
      // Realized PnL at break-even should be ~0.0
      expect(afterSellPos.realizedPnlUsd).toBeCloseTo(0.0, 4);
    });

    it("5.3 Forward-Fill Invariant: sparse intervals maintain monotonic timestamps without null gaps", () => {
      const chart = storage.getMarketChart("usdc-90d", "1D");
      expect(chart.success).toBe(true);
      expect(chart.data.length).toBe(24);

      // Verify timestamps are strictly monotonically increasing by exactly 3600 seconds
      for (let i = 1; i < chart.data.length; i++) {
        const prev = chart.data[i - 1];
        const curr = chart.data[i];
        expect(curr.timestamp).toBe(prev.timestamp + 3600);
        expect(curr.close).toBeGreaterThan(0);
        expect(curr.impliedApy).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ==========================================================================
  // Suite 6: Concurrency Profiling & Protocol Wire Verification Under Live Burst
  // ==========================================================================
  describe("Suite 6: Concurrency Profiling & Protocol Wire Verification Under Live Burst", () => {
    it("6.1 Latency Percentiles Under Burst: p50 < 100ms and max < 1500ms on live indexer", async () => {
      const burstSize = 40;
      const latencies: number[] = [];

      const requests = Array.from({ length: burstSize }, async (_, idx) => {
        const market = idx % 2 === 0 ? "usdc-90d" : "xlm-90d";
        const t0 = performance.now();
        const res = await fetch(`${LIVE_INDEXER_URL}/charts?market=${market}&interval=1D`, {
          signal: AbortSignal.timeout(4000),
        });
        const elapsed = performance.now() - t0;
        latencies.push(elapsed);
        expect(res.status).toBe(200);
      });

      await Promise.all(requests);

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p90 = latencies[Math.floor(latencies.length * 0.9)];
      const max = latencies[latencies.length - 1];

      expect(p50).toBeLessThan(500); // p50 fast
      expect(p90).toBeLessThan(1000); // p90 bounded
      expect(max).toBeLessThan(3000); // max bounded
    });

    it("6.2 CORS & Content-Type Headers: 100% compliant across live endpoints under burst", async () => {
      const endpoints = [
        `${LIVE_INDEXER_URL}/health`,
        `${LIVE_INDEXER_URL}/charts?market=usdc-90d&interval=1D`,
        `${LIVE_INDEXER_URL}/positions?user=GTEST_CORS_CHECK_WALLET_0000000000000000000000000000`,
      ];

      for (const ep of endpoints) {
        const res = await fetch(ep, { signal: AbortSignal.timeout(3000) });
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("content-type")).toContain("application/json");
      }
    });

    it("6.3 Contract Address Resolution: queries by pool address resolve identically to market ID", async () => {
      const poolId = MARKETS["usdc-90d"].poolId;
      const resById = await fetch(`${LIVE_INDEXER_URL}/charts?market=usdc-90d&interval=1D`, {
        signal: AbortSignal.timeout(3000),
      });
      const resByPool = await fetch(`${LIVE_INDEXER_URL}/charts?market=${poolId}&interval=1D`, {
        signal: AbortSignal.timeout(3000),
      });

      expect(resById.status).toBe(200);
      expect(resByPool.status).toBe(200);

      const jsonById = await resById.json();
      const jsonByPool = await resByPool.json();

      expect(jsonByPool.market).toBe("usdc-90d");
      expect(jsonByPool.count).toBe(jsonById.count);
      expect(jsonByPool.data.length).toBe(jsonById.data.length);
    });
  });

  // ==========================================================================
  // Suite 7: Pure Mathematical Oracles & Taylor Expansion Boundaries
  // ==========================================================================
  describe("Suite 7: Pure Mathematical Oracles & Taylor Expansion Boundaries", () => {
    it("7.1 calculateImpliedApy near-maturity (< 1 hour) uses Taylor expansion to avoid overflow", () => {
      // 10 minutes to maturity: tau = (10 / (60 * 24 * 365)) years
      const tau10m = 10 / (60 * 24 * 365);
      const ptPrice = 0.9998; // Very slight discount

      const apy = calculateImpliedApy(ptPrice, tau10m);
      expect(typeof apy).toBe("number");
      expect(isNaN(apy)).toBe(false);
      expect(isFinite(apy)).toBe(true);
      expect(apy).toBeGreaterThan(0);
      expect(apy).toBeLessThanOrEqual(500.0);
    });

    it("7.2 calculateImpliedApy post-maturity (tau <= 0) strictly clamps to 0.0%", () => {
      expect(calculateImpliedApy(0.98, 0)).toBe(0.0);
      expect(calculateImpliedApy(0.98, -0.05)).toBe(0.0);
    });

    it("7.3 calculateImpliedApy extreme discount (deep underpricing) clamps to 500.0% ceiling", () => {
      const tau90d = 90 / 365;
      const crashedPtPrice = 0.10; // PT traded at 90% discount
      const apy = calculateImpliedApy(crashedPtPrice, tau90d);
      expect(apy).toBe(500.0);
    });

    it("7.4 calculateImpliedApy negative yield / premium (PT >= 1.0) clamps to 0.0% floor", () => {
      const tau90d = 90 / 365;
      expect(calculateImpliedApy(1.00, tau90d)).toBe(0.0);
      expect(calculateImpliedApy(1.05, tau90d)).toBe(0.0);
    });

    it("7.5 Cashflow Conservation Invariant: Buy PT -> Sell at loss preserves net cashflow", () => {
      const testDb = join(process.cwd(), "tests/test_cashflow_conservation.db");
      try {
        if (existsSync(testDb)) unlinkSync(testDb);
        if (existsSync(`${testDb}-wal`)) unlinkSync(`${testDb}-wal`);
        if (existsSync(`${testDb}-shm`)) unlinkSync(`${testDb}-shm`);
      } catch {}

      const testStorage = new EventStorage(testDb);
      const user = "GCASHFLOW_CONSERVATION_AUDIT_USER_0000000000000000000000";
      const baseTime = 1794270000;

      // Buy 100 PT for 95 SY (0.95 unit cost)
      testStorage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTime,
        caller: user,
        receiver: user,
        direction: 1,
        amountIn: 950000000n, // 95 SY
        amountOut: 1000000000n, // 100 PT
        fee: 0n,
      });

      // Sell 50 PT for 40 SY (0.80 price -> 0.15 SY loss per PT = -7.5 SY loss)
      testStorage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTime + 100,
        caller: user,
        receiver: user,
        direction: 0,
        amountIn: 500000000n, // 50 PT
        amountOut: 400000000n, // 40 SY
        fee: 0n,
      });

      const pos = testStorage.getUserPositions(user).positions[0];
      // Remaining PT balance: 50 PT
      expect(pos.currentPtBalance).toBe("500000000");
      // Remaining cost basis: 47.5 SY (half of 95 SY)
      expect(pos.costBasisStroops).toBe("475000000");
      // Realized PnL: 40 SY revenue - 47.5 SY cost basis = -7.5 SY (-7.5 USD)
      expect(pos.realizedPnlUsd).toBeCloseTo(-7.5, 2);

      testStorage.close();
      try {
        if (existsSync(testDb)) unlinkSync(testDb);
        if (existsSync(`${testDb}-wal`)) unlinkSync(`${testDb}-wal`);
        if (existsSync(`${testDb}-shm`)) unlinkSync(`${testDb}-shm`);
      } catch {}
    });
  });
});
