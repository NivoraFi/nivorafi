// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  deriveMarketStatus,
  calculateDaysToMaturity,
  filterMarkets,
  getTopYieldMarket,
  findMarketById,
  getDefaultMarket,
  MarketDefinition,
  MarketSummaryMetrics,
} from "../markets";

describe("Milestone M5 — Challenger M5.1: Multi-Market State, Filtering & Temporal Invariant Challenge Suite", () => {
  // =========================================================================
  // SECTION 1: Temporal Status Boundaries & Invariants
  // =========================================================================
  describe("1. Temporal Status Boundary Invariants (deriveMarketStatus & calculateDaysToMaturity)", () => {
    const maturity = 1800000000; // Reference fixed maturity timestamp

    it("evaluates exact boundary timestamp now === maturity as MATURED with 0.0 days", () => {
      const now = maturity;
      const status = deriveMarketStatus(maturity, now);
      const days = calculateDaysToMaturity(maturity, now);

      expect(status).toBe("MATURED");
      expect(days).toBe(0);
    });

    it("evaluates now === maturity - 1 as ACTIVE with positive non-zero fractional days", () => {
      const now = maturity - 1;
      const status = deriveMarketStatus(maturity, now);
      const days = calculateDaysToMaturity(maturity, now);

      expect(status).toBe("ACTIVE");
      expect(days).toBeGreaterThan(0);
      expect(days).toBeCloseTo(1 / 86400, 7);
    });

    it("evaluates now === maturity + 1 as MATURED with strictly clamped 0.0 days", () => {
      const now = maturity + 1;
      const status = deriveMarketStatus(maturity, now);
      const days = calculateDaysToMaturity(maturity, now);

      expect(status).toBe("MATURED");
      expect(days).toBe(0);
    });

    it("handles sub-second fractional timestamps around maturity boundary", () => {
      const microBefore = maturity - 0.0001;
      expect(deriveMarketStatus(maturity, microBefore)).toBe("ACTIVE");
      expect(calculateDaysToMaturity(maturity, microBefore)).toBeGreaterThan(0);

      const microAfter = maturity + 0.0001;
      expect(deriveMarketStatus(maturity, microAfter)).toBe("MATURED");
      expect(calculateDaysToMaturity(maturity, microAfter)).toBe(0);
    });

    it("maintains strict mathematical invariant across 1,000 fuzzed (maturity, now) pairs", () => {
      for (let i = 0; i < 1000; i++) {
        const mat = 1700000000 + Math.floor(Math.random() * 200000000);
        // Offset range from -100 days to +100 days
        const delta = Math.floor(Math.random() * 17280000) - 8640000;
        const now = mat + delta;

        const status = deriveMarketStatus(mat, now);
        const days = calculateDaysToMaturity(mat, now);

        if (now >= mat) {
          expect(status).toBe("MATURED");
          expect(days).toBe(0);
        } else {
          expect(status).toBe("ACTIVE");
          expect(days).toBeGreaterThan(0);
          expect(days).toBeCloseTo((mat - now) / 86400, 5);
        }
      }
    });

    it("handles extreme temporal offsets (far future, far past, zero timestamp)", () => {
      // 50 years into the future
      const farFutureMaturity = 1800000000 + 86400 * 365 * 50;
      const now = 1800000000;
      expect(deriveMarketStatus(farFutureMaturity, now)).toBe("ACTIVE");
      expect(calculateDaysToMaturity(farFutureMaturity, now)).toBeCloseTo(365 * 50, 0);

      // 50 years into the past
      const farPastMaturity = 1800000000 - 86400 * 365 * 50;
      expect(deriveMarketStatus(farPastMaturity, now)).toBe("MATURED");
      expect(calculateDaysToMaturity(farPastMaturity, now)).toBe(0);

      // Zero maturity
      expect(deriveMarketStatus(0, 100)).toBe("MATURED");
      expect(calculateDaysToMaturity(0, 100)).toBe(0);
    });
  });

  // =========================================================================
  // SECTION 2: Comparative APY Ranking & getTopYieldMarket
  // =========================================================================
  describe("2. Comparative APY Ranking & getTopYieldMarket Stress Matrix", () => {
    const baseNow = 1750000000;

    const testPools: MarketDefinition[] = [
      {
        ...PRESET_MARKETS[0],
        id: "pool-usdc-active-1",
        maturity: baseNow + 86400 * 30, // 30D active
      },
      {
        ...PRESET_MARKETS[1],
        id: "pool-usdc-active-2",
        maturity: baseNow + 86400 * 90, // 90D active
      },
      {
        ...PRESET_MARKETS[2],
        id: "pool-xlm-active",
        maturity: baseNow + 86400 * 60, // 60D active
      },
      {
        ...PRESET_MARKETS[3],
        id: "pool-matured-high-apy",
        maturity: baseNow - 100, // Matured pool
      },
    ];

    const makeMetrics = (
      poolId: string,
      apy: number,
      isMatured: boolean
    ): MarketSummaryMetrics => ({
      marketId: poolId,
      status: isMatured ? "MATURED" : "ACTIVE",
      daysToMaturity: isMatured ? 0 : 30,
      impliedApyPct: apy,
      blendRate: 1.0,
      ptPriceInSy: 0.98,
      tvlSy: 1000n,
      tvlUsd: 1000,
      ptReserve: 500n,
      syReserve: 500n,
      isMatured,
      isLoading: false,
    });

    it("strictly excludes matured pools even when their historical APY is 1000%", () => {
      const metrics: Record<string, MarketSummaryMetrics> = {
        "pool-usdc-active-1": makeMetrics("pool-usdc-active-1", 6.5, false),
        "pool-usdc-active-2": makeMetrics("pool-usdc-active-2", 8.2, false),
        "pool-xlm-active": makeMetrics("pool-xlm-active", 7.0, false),
        "pool-matured-high-apy": makeMetrics("pool-matured-high-apy", 999.99, true),
      };

      const top = getTopYieldMarket(testPools, metrics, baseNow);
      expect(top).not.toBeNull();
      expect(top?.id).toBe("pool-usdc-active-2"); // 8.2% is the highest ACTIVE APY
      expect(top?.id).not.toBe("pool-matured-high-apy");
    });

    it("returns null when all provided pools are matured", () => {
      const allMatured: MarketDefinition[] = [
        { ...testPools[0], id: "mat-1", maturity: baseNow - 1000 },
        { ...testPools[1], id: "mat-2", maturity: baseNow - 50 },
      ];
      const metrics: Record<string, MarketSummaryMetrics> = {
        "mat-1": makeMetrics("mat-1", 12.0, true),
        "mat-2": makeMetrics("mat-2", 15.0, true),
      };

      const top = getTopYieldMarket(allMatured, metrics, baseNow);
      expect(top).toBeNull();
    });

    it("handles zero APY pools and selects first active pool gracefully", () => {
      const metrics: Record<string, MarketSummaryMetrics> = {
        "pool-usdc-active-1": makeMetrics("pool-usdc-active-1", 0, false),
        "pool-usdc-active-2": makeMetrics("pool-usdc-active-2", 0, false),
        "pool-xlm-active": makeMetrics("pool-xlm-active", 0, false),
      };

      const top = getTopYieldMarket(testPools.slice(0, 3), metrics, baseNow);
      expect(top).not.toBeNull();
      expect(top?.id).toBe("pool-usdc-active-1");
    });

    it("distinguishes zero APY from positive APY (e.g. 0.01% APY beats 0.00%)", () => {
      const metrics: Record<string, MarketSummaryMetrics> = {
        "pool-usdc-active-1": makeMetrics("pool-usdc-active-1", 0.0, false),
        "pool-usdc-active-2": makeMetrics("pool-usdc-active-2", 0.01, false),
        "pool-xlm-active": makeMetrics("pool-xlm-active", 0.0, false),
      };

      const top = getTopYieldMarket(testPools.slice(0, 3), metrics, baseNow);
      expect(top).not.toBeNull();
      expect(top?.id).toBe("pool-usdc-active-2");
    });

    it("handles negative APY pools gracefully and selects higher (or 0 fallback) APY", () => {
      const metrics: Record<string, MarketSummaryMetrics> = {
        "pool-usdc-active-1": makeMetrics("pool-usdc-active-1", -5.5, false),
        "pool-usdc-active-2": makeMetrics("pool-usdc-active-2", -1.2, false),
        "pool-xlm-active": makeMetrics("pool-xlm-active", -8.0, false),
      };

      const top = getTopYieldMarket(testPools.slice(0, 3), metrics, baseNow);
      expect(top).not.toBeNull();
      // -1.2 is mathematically greater than -5.5 and -8.0
      expect(top?.id).toBe("pool-usdc-active-2");
    });

    it("provides stable deterministic tie-breaking on identical highest APY", () => {
      const metrics: Record<string, MarketSummaryMetrics> = {
        "pool-usdc-active-1": makeMetrics("pool-usdc-active-1", 9.5, false),
        "pool-usdc-active-2": makeMetrics("pool-usdc-active-2", 9.5, false),
        "pool-xlm-active": makeMetrics("pool-xlm-active", 4.0, false),
      };

      // Array order: active-1 then active-2
      const top1 = getTopYieldMarket(testPools.slice(0, 3), metrics, baseNow);
      expect(top1?.id).toBe("pool-usdc-active-1");

      // Inverted array order: active-2 then active-1
      const inverted = [testPools[1], testPools[0], testPools[2]];
      const top2 = getTopYieldMarket(inverted, metrics, baseNow);
      expect(top2?.id).toBe("pool-usdc-active-2");
    });

    it("handles missing metrics object keys without crashing (defaults APY to 0)", () => {
      // Empty metrics record
      const emptyMetrics: Record<string, MarketSummaryMetrics> = {};
      const top = getTopYieldMarket(testPools.slice(0, 3), emptyMetrics, baseNow);
      expect(top).not.toBeNull();
      expect(top?.id).toBe("pool-usdc-active-1");
    });

    it("handles NaN APY values without corrupting ranking of valid pools", () => {
      const metrics: Record<string, MarketSummaryMetrics> = {
        "pool-usdc-active-1": makeMetrics("pool-usdc-active-1", NaN, false),
        "pool-usdc-active-2": makeMetrics("pool-usdc-active-2", 7.8, false),
        "pool-xlm-active": makeMetrics("pool-xlm-active", 5.2, false),
      };

      const top = getTopYieldMarket(testPools.slice(0, 3), metrics, baseNow);
      expect(top).not.toBeNull();
      expect(top?.id).toBe("pool-usdc-active-2");
    });

    it("fuzzes 500 randomized APY matrices verifying empirical oracle correctness", () => {
      for (let i = 0; i < 500; i++) {
        const apys = [
          Math.random() * 20,
          Math.random() * 20,
          Math.random() * 20,
        ];
        const activeSub = testPools.slice(0, 3);
        const fuzzedMetrics: Record<string, MarketSummaryMetrics> = {
          "pool-usdc-active-1": makeMetrics("pool-usdc-active-1", apys[0], false),
          "pool-usdc-active-2": makeMetrics("pool-usdc-active-2", apys[1], false),
          "pool-xlm-active": makeMetrics("pool-xlm-active", apys[2], false),
        };

        const top = getTopYieldMarket(activeSub, fuzzedMetrics, baseNow);
        expect(top).not.toBeNull();

        const maxApy = Math.max(...apys);
        const topMetric = fuzzedMetrics[top!.id];
        expect(topMetric.impliedApyPct).toBe(maxApy);
      }
    });
  });

  // =========================================================================
  // SECTION 3: Filter Engine Stress Testing (filterMarkets)
  // =========================================================================
  describe("3. Filter Engine Stress Testing (Asset, Status, Search)", () => {
    const now = Math.floor(Date.now() / 1000);

    it("filters precisely by asset code across all supported tokens", () => {
      const usdc = filterMarkets(PRESET_MARKETS, "USDC", "ALL", undefined, now);
      expect(usdc.length).toBeGreaterThanOrEqual(3);
      expect(usdc.every((m) => m.asset.code === "USDC")).toBe(true);

      const xlm = filterMarkets(PRESET_MARKETS, "XLM", "ALL", undefined, now);
      expect(xlm.length).toBeGreaterThanOrEqual(1);
      expect(xlm.every((m) => m.asset.code === "XLM")).toBe(true);

      const eurcPreset = filterMarkets(PRESET_MARKETS, "EURC", "ALL", undefined, now);
      expect(eurcPreset.length).toBe(0);

      const mockEurc: MarketDefinition = {
        ...PRESET_MARKETS[0],
        id: "mock-eurc-90d",
        asset: KNOWN_ASSETS.EURC,
      };
      const eurcCustom = filterMarkets([mockEurc], "EURC", "ALL", undefined, now);
      expect(eurcCustom.length).toBe(1);
      expect(eurcCustom.every((m) => m.asset.code === "EURC")).toBe(true);
    });

    it("normalizes asset filter with leading/trailing whitespace and mixed case", () => {
      const resUpper = filterMarkets(PRESET_MARKETS, "USDC", "ALL", undefined, now);
      const resLower = filterMarkets(PRESET_MARKETS, "  usdc  ", "ALL", undefined, now);
      const resMixed = filterMarkets(PRESET_MARKETS, "UsDc", "ALL", undefined, now);

      expect(resLower.length).toBe(resUpper.length);
      expect(resMixed.length).toBe(resUpper.length);
    });

    it("normalizes status filter with whitespace and mixed case", () => {
      const active1 = filterMarkets(PRESET_MARKETS, "ALL", "ACTIVE", undefined, now);
      const active2 = filterMarkets(PRESET_MARKETS, "ALL", "  active  ", undefined, now);
      const active3 = filterMarkets(PRESET_MARKETS, "ALL", "AcTiVe", undefined, now);

      expect(active2.length).toBe(active1.length);
      expect(active3.length).toBe(active1.length);
      expect(active1.every((m) => m.maturity > now)).toBe(true);
    });

    it("returns empty array on unsupported or nonexistent asset code", () => {
      const btc = filterMarkets(PRESET_MARKETS, "BTC", "ALL", undefined, now);
      expect(btc).toEqual([]);

      const sol = filterMarkets(PRESET_MARKETS, "SOL", "ALL", undefined, now);
      expect(sol).toEqual([]);
    });

    it("returns empty array on unsupported status filter", () => {
      const expired = filterMarkets(PRESET_MARKETS, "ALL", "EXPIRED", undefined, now);
      expect(expired).toEqual([]);

      const paused = filterMarkets(PRESET_MARKETS, "ALL", "PAUSED", undefined, now);
      expect(paused).toEqual([]);
    });

    it("filters correctly on intersection of asset and status with empty result sets", () => {
      // In canonical preset markets, only USDC has a matured pool
      const xlmMatured = filterMarkets(PRESET_MARKETS, "XLM", "MATURED", undefined, now);
      expect(xlmMatured).toEqual([]);

      const eurcMatured = filterMarkets(PRESET_MARKETS, "EURC", "MATURED", undefined, now);
      expect(eurcMatured).toEqual([]);

      const usdcMatured = filterMarkets(PRESET_MARKETS, "USDC", "MATURED", undefined, now);
      expect(usdcMatured.length).toBe(1);
      expect(usdcMatured[0].id).toBe("usdc-matured");
    });

    it("survives search queries containing regex metacharacters without throwing", () => {
      const regexPatterns = [
        ".*",
        "+",
        "?",
        "^$",
        "(.*)",
        "[a-z]+",
        "\\",
        "|",
        "{1,3}",
        "PT-[bUSDC]+",
      ];

      for (const pattern of regexPatterns) {
        expect(() => {
          filterMarkets(PRESET_MARKETS, "ALL", "ALL", pattern, now);
        }).not.toThrow();
      }
    });

    it("survives search queries containing SQL injection / XSS payloads safely", () => {
      const maliciousQueries = [
        "' OR 1=1 --",
        "\"; DROP TABLE markets; --",
        "<script>alert('xss')</script>",
        "javascript:void(0)",
        "><img src=x onerror=alert(1)>",
      ];

      for (const q of maliciousQueries) {
        const res = filterMarkets(PRESET_MARKETS, "ALL", "ALL", q, now);
        expect(Array.isArray(res)).toBe(true);
        expect(res.length).toBe(0);
      }
    });

    it("handles unicode, emojis, and whitespace-only search strings", () => {
      const whitespaceOnly = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "     ", now);
      expect(whitespaceOnly.length).toBe(PRESET_MARKETS.length);

      const emojiQuery = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "🚀🔥", now);
      expect(emojiQuery).toEqual([]);
    });

    it("matches search query across pool ID substring", () => {
      // Find by contract pool ID prefix
      const matchPool = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "cboadrsn", now);
      expect(matchPool.length).toBeGreaterThan(0);
      expect(matchPool.some((m) => m.id === "usdc-90d")).toBe(true);
    });

    it("matches search query across tenor substring", () => {
      const match90 = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "90d", now);
      expect(match90.some((m) => m.tenor === "90D")).toBe(true);
      const match30 = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "30d", now);
      expect(match30.some((m) => m.tenor === "30D")).toBe(true);
    });

    it("does not mutate the source markets array during filtering", () => {
      const originalLength = PRESET_MARKETS.length;
      const originalFirst = PRESET_MARKETS[0];

      filterMarkets(PRESET_MARKETS, "USDC", "ACTIVE", "90D", now);

      expect(PRESET_MARKETS.length).toBe(originalLength);
      expect(PRESET_MARKETS[0]).toBe(originalFirst);
    });
  });

  // =========================================================================
  // SECTION 4: Market Switching State Integrity & Concurrency Simulation
  // =========================================================================
  describe("4. Market Switching State Integrity & Fallback Simulation", () => {
    it("finds all preset markets by their exact ID", () => {
      for (const market of PRESET_MARKETS) {
        const found = findMarketById(market.id, PRESET_MARKETS);
        expect(found).toBeDefined();
        expect(found.id).toBe(market.id);
        expect(found.asset.code).toBe(market.asset.code);
        expect(found.tenor).toBe(market.tenor);
        expect(found.maturity).toBe(market.maturity);
      }
    });

    it("falls back safely to default market when queried with an invalid ID", () => {
      const fallback = findMarketById("non-existent-market-id-9999", PRESET_MARKETS);
      expect(fallback).toBeDefined();
      expect(fallback.id).toBe(PRESET_MARKETS[0].id);
    });

    it("falls back to PRESET_MARKETS[0] even when custom markets array is empty", () => {
      const fallback = findMarketById("any-id", []);
      expect(fallback).toBeDefined();
      expect(fallback.id).toBe(PRESET_MARKETS[0].id);
    });

    it("verifies rapid market switching across USDC -> XLM -> Matured retains contract integrity", () => {
      const sequence = ["usdc-90d", "xlm-90d", "usdc-30d", "usdc-matured"];
      const resolvedMarkets: MarketDefinition[] = [];

      for (const id of sequence) {
        const m = findMarketById(id, PRESET_MARKETS);
        resolvedMarkets.push(m);
      }

      expect(resolvedMarkets.map((m) => m.asset.code)).toEqual([
        "USDC",
        "XLM",
        "USDC",
        "USDC",
      ]);

      expect(resolvedMarkets.map((m) => m.tenor)).toEqual([
        "90D",
        "90D",
        "30D",
        "90D",
      ]);

      // Verify each resolved market has complete contract addresses
      for (const m of resolvedMarkets) {
        expect(m.contracts.poolId.length).toBeGreaterThan(20);
        expect(m.contracts.syId.length).toBeGreaterThan(20);
        expect(m.contracts.ptId.length).toBeGreaterThan(20);
        expect(m.contracts.ytId.length).toBeGreaterThan(20);
        expect(m.contracts.blendPoolId.length).toBeGreaterThan(20);
        expect(m.asset.sacContractId.length).toBeGreaterThan(20);
      }
    });

    it("simulates async out-of-order resolution in rapid switching and confirms race condition risk", async () => {
      // Empirical simulation of MarketContext refreshActiveMarket async pattern
      let currentActiveMarketId = "usdc-90d";
      let activeSnapshotMarketId: string | null = null;

      // Unprotected fetch simulation (analogous to current MarketContext implementation)
      const unprotectedFetchSnapshot = async (targetId: string, delayMs: number) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // Stale write occurs if currentActiveMarketId moved on
        activeSnapshotMarketId = targetId;
      };

      // User initiates switch to USDC-90D (slow response: 50ms)
      currentActiveMarketId = "usdc-90d";
      const p1 = unprotectedFetchSnapshot("usdc-90d", 50);

      // User immediately clicks XLM-90D (fast response: 10ms)
      currentActiveMarketId = "xlm-90d";
      const p2 = unprotectedFetchSnapshot("xlm-90d", 10);

      await Promise.all([p1, p2]);

      // Unprotected result: p1 finished last, so activeSnapshot holds usdc-90d while activeMarketId is xlm-90d!
      expect(activeSnapshotMarketId).toBe("usdc-90d");
      expect(currentActiveMarketId).toBe("xlm-90d");
      // This empirically proves the race condition exists without an activeMarketId guard!
    });

    it("verifies protected async pattern with target ID guard prevents stale snapshot overwrite", async () => {
      let currentActiveMarketId = "usdc-90d";
      let activeSnapshotMarketId: string | null = null;

      // Protected fetch simulation (with ID guard pattern)
      const protectedFetchSnapshot = async (targetId: string, delayMs: number) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // Guard: only commit if targetId is STILL the currentActiveMarketId
        if (targetId === currentActiveMarketId) {
          activeSnapshotMarketId = targetId;
        }
      };

      // User initiates switch to USDC-90D (slow response: 50ms)
      currentActiveMarketId = "usdc-90d";
      const p1 = protectedFetchSnapshot("usdc-90d", 50);

      // User immediately clicks XLM-90D (fast response: 10ms)
      currentActiveMarketId = "xlm-90d";
      const p2 = protectedFetchSnapshot("xlm-90d", 10);

      await Promise.all([p1, p2]);

      // Protected result: p1 resolution was ignored because targetId !== currentActiveMarketId!
      expect(activeSnapshotMarketId).toBe("xlm-90d");
      expect(currentActiveMarketId).toBe("xlm-90d");
    });
  });
});
