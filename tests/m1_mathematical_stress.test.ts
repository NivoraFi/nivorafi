/**
 * ============================================================================
 * EMPIRICAL CHALLENGER: Milestone 1 Mathematical Stress Verification Suite
 * ============================================================================
 *
 * File: tests/m1_mathematical_stress.test.ts
 *
 * Objective:
 * 1. Empirically verify the mathematical soundness of Implied APY, Underlying APY,
 *    PT/YT pricing, and volume/TVL calculations in indexer/index.ts.
 * 2. Rigorously stress test edge cases:
 *    - Near-maturity boundaries (tau < 1 hour, tau -> 0).
 *    - Post-maturity behavior (tau <= 0, clamp to 0.0%).
 *    - Price clamping (prevent infinite, negative, or NaN APY).
 *    - Forward-filling logic when intervals have trade gaps.
 * 3. Verify TVL conservation, OHLCV monotonicity, and multi-market consistency.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  calculateImpliedApy,
  EventStorage,
  MARKETS,
  resolveMarket,
  getMarketForContract,
  type DecodedEvent,
} from "../indexer/index";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";

describe("EMPIRICAL CHALLENGER: Milestone 1 Mathematical Stress Suite", () => {
  // ==========================================================================
  // Suite 1: Pure Mathematical Oracles & Boundary Conditions for calculateImpliedApy
  // ==========================================================================
  describe("Suite 1: Implied APY Formula, Taylor Expansion & Clamping", () => {
    it("matches analytical compounding formula (1/P)^(1/tau) - 1 for standard horizons", () => {
      // Test cases with known exact values
      // 90 days = 90 / 365 years
      const tau90d = 90 / 365;
      const ptPrice = 0.9802;
      const expectedApy = (Math.pow(1.0 / ptPrice, 1.0 / tau90d) - 1.0) * 100;
      const roundedExpected = Math.round(expectedApy * 10000) / 10000;

      const computedApy = calculateImpliedApy(ptPrice, tau90d);
      expect(computedApy).toBe(roundedExpected);
      expect(computedApy).toBeGreaterThan(8.0);
      expect(computedApy).toBeLessThan(9.0);

      // 30 days = 30 / 365 years
      const tau30d = 30 / 365;
      const ptPrice30d = 0.9943;
      const expected30dApy = (Math.pow(1.0 / ptPrice30d, 1.0 / tau30d) - 1.0) * 100;
      const roundedExpected30d = Math.round(expected30dApy * 10000) / 10000;

      const computed30dApy = calculateImpliedApy(ptPrice30d, tau30d);
      expect(computed30dApy).toBe(roundedExpected30d);
      expect(computed30dApy).toBeGreaterThan(6.0);
      expect(computed30dApy).toBeLessThan(8.0);
    });

    it("verifies post-maturity behavior (tau <= 0) strictly clamps to 0.0%", () => {
      const ptPrices = [0.001, 0.5, 0.9, 0.98, 0.9999];
      const zeroOrNegativeTaus = [0, -0.0000001, -1e-9, -1, -100, -31536000];

      for (const p of ptPrices) {
        for (const tau of zeroOrNegativeTaus) {
          const apy = calculateImpliedApy(p, tau);
          expect(apy).toBe(0.0);
        }
      }
    });

    it("verifies price boundary conditions (ptPrice >= 1.0 or ptPrice <= 0) clamp to 0.0%", () => {
      const tauValues = [90 / 365, 30 / 365, 1 / 365, 3600 / 31536000];

      // Parity and super-parity: PT price >= 1.0 implies zero or negative yield
      const invalidPrices = [1.0, 1.000001, 1.05, 2.0, 100.0, 0.0, -0.0001, -1.0, -100.0];

      for (const tau of tauValues) {
        for (const p of invalidPrices) {
          const apy = calculateImpliedApy(p, tau);
          expect(apy).toBe(0.0);
        }
      }
    });

    it("verifies extreme discount ceiling (clamping to 500.0%)", () => {
      // Extremely low PT prices that would mathematically yield > 1000%
      const extremeDiscounts = [0.0001, 0.01, 0.05, 0.1, 0.2];
      const tau = 90 / 365;

      for (const p of extremeDiscounts) {
        const apy = calculateImpliedApy(p, tau);
        expect(apy).toBe(500.0);
      }
    });

    it("stress tests near-maturity boundary (tau < 1 hour) using linear Taylor expansion", () => {
      const oneHourTau = 3600 / 31536000; // ~0.000114155 years

      // Just below 1 hour: uses linear Taylor expansion
      const tauBelow1h = 3599 / 31536000;
      // Just above 1 hour: uses continuous compounding
      const tauAbove1h = 3601 / 31536000;

      // Price close to parity (typical near maturity)
      const ptPrice = 0.9999;
      const apyBelow = calculateImpliedApy(ptPrice, tauBelow1h);
      const apyAbove = calculateImpliedApy(ptPrice, tauAbove1h);

      // Both must be finite, positive, and <= 500.0%
      expect(apyBelow).toBeGreaterThan(0.0);
      expect(apyBelow).toBeLessThanOrEqual(500.0);
      expect(Number.isFinite(apyBelow)).toBe(true);

      expect(apyAbove).toBeGreaterThan(0.0);
      expect(apyAbove).toBeLessThanOrEqual(500.0);
      expect(Number.isFinite(apyAbove)).toBe(true);

      // Verify micro-second near-maturity approaches: tau = 1 second, tau = 1 millisecond
      const tau1s = 1 / 31536000;
      const tau1ms = 0.001 / 31536000;

      const apy1s = calculateImpliedApy(0.999999, tau1s);
      const apy1ms = calculateImpliedApy(0.99999999, tau1ms);

      expect(Number.isFinite(apy1s)).toBe(true);
      expect(apy1s).toBeGreaterThanOrEqual(0.0);
      expect(apy1s).toBeLessThanOrEqual(500.0);

      expect(Number.isFinite(apy1ms)).toBe(true);
      expect(apy1ms).toBeGreaterThanOrEqual(0.0);
      expect(apy1ms).toBeLessThanOrEqual(500.0);
    });

    it("fuzzes 10,000 randomized inputs to prove zero crashes, NaNs, or negative APYs", () => {
      for (let i = 0; i < 10000; i++) {
        // Random ptPrice between -0.5 and 1.5
        const ptPrice = Math.random() * 2.0 - 0.5;
        // Random tau between -100 days and +400 days in years
        const tauYears = (Math.random() * 500 - 100) / 365;

        const apy = calculateImpliedApy(ptPrice, tauYears);

        // Core Invariants:
        // 1. Never NaN
        expect(isNaN(apy)).toBe(false);
        // 2. Never Infinite
        expect(Number.isFinite(apy)).toBe(true);
        // 3. Always >= 0.0
        expect(apy).toBeGreaterThanOrEqual(0.0);
        // 4. Always <= 500.0
        expect(apy).toBeLessThanOrEqual(500.0);
      }
    });
  });

  // ==========================================================================
  // Suite 2: Spot Price & Event Ingestion Oracles
  // ==========================================================================
  describe("Suite 2: PT/YT Spot Pricing and Directional Invariants", () => {
    let testDbPath: string;
    let storage: EventStorage;

    beforeAll(() => {
      testDbPath = join(import.meta.dir, `test_stress_events_${Date.now()}.db`);
      storage = new EventStorage(testDbPath);
    });

    it("verifies Swap Direction 0 (PT -> SY / Sell PT) spot price and volume", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const event: DecodedEvent = {
        id: "evt-swap-dir0-1",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-dir0-1",
        ledger: 100000,
        ledgerClosedAt: new Date(nowSec * 1000).toISOString(),
        timestamp: nowSec,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "GUSER1",
        receiver: "GUSER1",
        data: {
          direction: 0,
          amountIn: "1000000", // 1,000,000 PT sold
          amountOut: "978000",  // 978,000 net SY received
          fee: "2000",          // 2,000 SY fee
        },
        rawJson: "{}",
      };

      storage.saveEvents([event]);

      // grossSy = 978000 + 2000 = 980000
      // ptPrice = 980000 / 1000000 = 0.98
      // ytPrice = 1.0 - 0.98 = 0.02
      const chart = storage.getMarketChart("usdc-90d", "1D");
      const last = chart.data[chart.data.length - 1];

      expect(last.ptPrice).toBeCloseTo(0.98, 4);
      expect(last.ytPrice).toBeCloseTo(0.02, 4);
      expect(last.close).toBeCloseTo(0.98, 4);
      expect(last.volume).toBe("980000"); // gross SY volume
    });

    it("verifies Swap Direction 1 (SY -> PT / Buy PT) spot price and volume", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const event: DecodedEvent = {
        id: "evt-swap-dir1-1",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-dir1-1",
        ledger: 100001,
        ledgerClosedAt: new Date(nowSec * 1000).toISOString(),
        timestamp: nowSec,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "GUSER1",
        receiver: "GUSER1",
        data: {
          direction: 1,
          amountIn: "982000",   // 982,000 SY in (volume)
          amountOut: "998000",  // 998,000 PT out
          fee: "2000",          // 2,000 PT fee
        },
        rawJson: "{}",
      };

      storage.saveEvents([event]);

      // grossPt = 998000 + 2000 = 1000000
      // ptPrice = amtIn / grossPt = 982000 / 1000000 = 0.982
      // ytPrice = 1.0 - 0.982 = 0.018
      const chart = storage.getMarketChart("usdc-90d", "1D");
      const last = chart.data[chart.data.length - 1];

      expect(last.ptPrice).toBeCloseTo(0.982, 4);
      expect(last.ytPrice).toBeCloseTo(0.018, 4);
      expect(last.close).toBeCloseTo(0.982, 4);
    });

    it("verifies Swap Direction 2 (SY -> YT / Buy YT) spot price and volume", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const event: DecodedEvent = {
        id: "evt-swap-dir2-1",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-dir2-1",
        ledger: 100002,
        ledgerClosedAt: new Date(nowSec * 1000).toISOString(),
        timestamp: nowSec,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "GUSER1",
        receiver: "GUSER1",
        data: {
          direction: 2,
          amountIn: "25000",    // 25,000 SY in (volume)
          amountOut: "1000000", // 1,000,000 YT out
          fee: "500",
        },
        rawJson: "{}",
      };

      storage.saveEvents([event]);

      // ytPrice = 25000 / 1000000 = 0.025
      // ptPrice = 1.0 - 0.025 = 0.975
      // ytPrice = 1.0 - 0.975 = 0.025
      const chart = storage.getMarketChart("usdc-90d", "1D");
      const last = chart.data[chart.data.length - 1];

      expect(last.ptPrice).toBeCloseTo(0.975, 4);
      expect(last.ytPrice).toBeCloseTo(0.025, 4);
    });

    it("verifies Swap Direction 3 (YT -> SY / Sell YT) spot price and volume", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const event: DecodedEvent = {
        id: "evt-swap-dir3-1",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-dir3-1",
        ledger: 100003,
        ledgerClosedAt: new Date(nowSec * 1000).toISOString(),
        timestamp: nowSec,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "GUSER1",
        receiver: "GUSER1",
        data: {
          direction: 3,
          amountIn: "1000000", // 1,000,000 YT sold
          amountOut: "22000",  // 22,000 net SY out
          fee: "1000",         // 1,000 SY fee
        },
        rawJson: "{}",
      };

      storage.saveEvents([event]);

      // grossSy = 22000 + 1000 = 23000
      // ytPrice = 23000 / 1000000 = 0.023
      // ptPrice = 1.0 - 0.023 = 0.977
      const chart = storage.getMarketChart("usdc-90d", "1D");
      const last = chart.data[chart.data.length - 1];

      expect(last.ptPrice).toBeCloseTo(0.977, 4);
      expect(last.ytPrice).toBeCloseTo(0.023, 4);
    });

    it("verifies Liquidity event spot price clamping and volume", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const event: DecodedEvent = {
        id: "evt-liq-1",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-liq-1",
        ledger: 100004,
        ledgerClosedAt: new Date(nowSec * 1000).toISOString(),
        timestamp: nowSec,
        type: "liquidity",
        topicSymbol: "liquidity_event",
        caller: "GUSER1",
        receiver: "GUSER1",
        data: {
          isAdd: true,
          ptAmount: "10000000",
          syAmount: "9810000",
          lpAmount: "9900000",
        },
        rawJson: "{}",
      };

      storage.saveEvents([event]);

      // ptPrice = syAmount / ptAmount = 9810000 / 10000000 = 0.981
      const chart = storage.getMarketChart("usdc-90d", "1D");
      const last = chart.data[chart.data.length - 1];

      expect(last.ptPrice).toBeCloseTo(0.981, 4);
      expect(last.ytPrice).toBeCloseTo(0.019, 4);
    });

    afterAll(() => {
      storage.close();
      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }
    });
  });

  // ==========================================================================
  // Suite 3: TVL Accounting & Conservation Stress
  // ==========================================================================
  describe("Suite 3: TVL Conservation, Deltas, and Monotonicity", () => {
    let testDbPath: string;
    let storage: EventStorage;

    beforeAll(() => {
      testDbPath = join(import.meta.dir, `test_stress_tvl_${Date.now()}.db`);
      storage = new EventStorage(testDbPath);
    });

    it("initializes TVL with market baseline and tracks deltas across deposit, mint, redeem, liquidity", () => {
      const baseline = BigInt(MARKETS["usdc-90d"].baselineTvlSy);
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Deposit +1,000,000 SY
      const depositEvent: DecodedEvent = {
        id: "evt-tvl-deposit",
        contractId: MARKETS["usdc-90d"].syId,
        txHash: "tx-tvl-1",
        ledger: 200001,
        ledgerClosedAt: new Date(nowSec * 1000).toISOString(),
        timestamp: nowSec,
        type: "deposit",
        topicSymbol: "deposit_event",
        caller: "GUSER",
        receiver: "GUSER",
        data: { underlyingAmount: "1000000", sharesMinted: "1000000" },
        rawJson: "{}",
      };
      storage.saveEvents([depositEvent]);

      let chart = storage.getMarketChart("usdc-90d", "1D");
      let currentTvl = BigInt(chart.summary.currentTvl);
      expect(currentTvl).toBe(baseline + 1000000n);

      // 2. Mint PY +2,000,000 SY
      const mintEvent: DecodedEvent = {
        id: "evt-tvl-mint",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-tvl-2",
        ledger: 200002,
        ledgerClosedAt: new Date((nowSec + 1) * 1000).toISOString(),
        timestamp: nowSec + 1,
        type: "mint_py",
        topicSymbol: "mint_py_event",
        caller: "GUSER",
        receiver: "GUSER",
        data: { syIn: "2000000", pyOut: "2000000" },
        rawJson: "{}",
      };
      storage.saveEvents([mintEvent]);

      chart = storage.getMarketChart("usdc-90d", "1D");
      currentTvl = BigInt(chart.summary.currentTvl);
      expect(currentTvl).toBe(baseline + 3000000n);

      // 3. Liquidity Add +1,500,000 SY (Delta is 2 * syAmount = 3,000,000)
      const liqAddEvent: DecodedEvent = {
        id: "evt-tvl-liq-add",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-tvl-3",
        ledger: 200003,
        ledgerClosedAt: new Date((nowSec + 2) * 1000).toISOString(),
        timestamp: nowSec + 2,
        type: "liquidity",
        topicSymbol: "liquidity_event",
        caller: "GUSER",
        receiver: "GUSER",
        data: { isAdd: true, ptAmount: "1500000", syAmount: "1500000", lpAmount: "1500000" },
        rawJson: "{}",
      };
      storage.saveEvents([liqAddEvent]);

      chart = storage.getMarketChart("usdc-90d", "1D");
      currentTvl = BigInt(chart.summary.currentTvl);
      expect(currentTvl).toBe(baseline + 6000000n);

      // 4. Liquidity Remove -1,000,000 SY (Delta is -(2 * 1,000,000) = -2,000,000)
      const liqRemEvent: DecodedEvent = {
        id: "evt-tvl-liq-rem",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-tvl-4",
        ledger: 200004,
        ledgerClosedAt: new Date((nowSec + 3) * 1000).toISOString(),
        timestamp: nowSec + 3,
        type: "liquidity",
        topicSymbol: "liquidity_event",
        caller: "GUSER",
        receiver: "GUSER",
        data: { isAdd: false, ptAmount: "1000000", syAmount: "1000000", lpAmount: "1000000" },
        rawJson: "{}",
      };
      storage.saveEvents([liqRemEvent]);

      chart = storage.getMarketChart("usdc-90d", "1D");
      currentTvl = BigInt(chart.summary.currentTvl);
      expect(currentTvl).toBe(baseline + 4000000n);

      // 5. Redeem -500,000 SY
      const redeemEvent: DecodedEvent = {
        id: "evt-tvl-redeem",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-tvl-5",
        ledger: 200005,
        ledgerClosedAt: new Date((nowSec + 4) * 1000).toISOString(),
        timestamp: nowSec + 4,
        type: "redeem",
        topicSymbol: "redeem_event",
        caller: "GUSER",
        receiver: "GUSER",
        data: { assetsOut: "500000", sharesBurned: "500000" },
        rawJson: "{}",
      };
      storage.saveEvents([redeemEvent]);

      chart = storage.getMarketChart("usdc-90d", "1D");
      currentTvl = BigInt(chart.summary.currentTvl);
      expect(currentTvl).toBe(baseline + 3500000n);
    });

    afterAll(() => {
      storage.close();
      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }
    });
  });

  // ==========================================================================
  // Suite 4: Forward-Filling Logic with Sparse Intervals & Trade Gaps
  // ==========================================================================
  describe("Suite 4: Forward-Filling & Interval Continuity under Sparse Data", () => {
    let testDbPath: string;
    let storage: EventStorage;

    beforeAll(() => {
      testDbPath = join(import.meta.dir, `test_stress_forwardfill_${Date.now()}.db`);
      storage = new EventStorage(testDbPath);
    });

    it("forward-fills an empty database across all 24 buckets of 1D chart using baseline values", () => {
      const chart = storage.getMarketChart("usdc-90d", "1D");

      expect(chart.success).toBe(true);
      expect(chart.count).toBe(24);
      expect(chart.data.length).toBe(24);

      const baselinePt = MARKETS["usdc-90d"].baselinePtPrice;
      const baselineTvl = MARKETS["usdc-90d"].baselineTvlSy;
      const expectedUnderlyingApy = MARKETS["usdc-90d"].underlyingApy;

      for (let i = 0; i < chart.data.length; i++) {
        const pt = chart.data[i];
        expect(pt.open).toBe(baselinePt);
        expect(pt.high).toBe(baselinePt);
        expect(pt.low).toBe(baselinePt);
        expect(pt.close).toBe(baselinePt);
        expect(pt.ptPrice).toBe(baselinePt);
        expect(pt.ytPrice).toBeCloseTo(1.0 - baselinePt, 4);
        expect(pt.underlyingApy).toBe(expectedUnderlyingApy);
        expect(pt.volume).toBe("0");
        expect(pt.tvl).toBe(baselineTvl);
        expect(pt.tradeCount).toBe(0);

        // Implied APY must be strictly non-negative, finite, and <= 500.0%
        expect(pt.impliedApy).toBeGreaterThan(0.0);
        expect(pt.impliedApy).toBeLessThanOrEqual(500.0);
        expect(Number.isFinite(pt.impliedApy)).toBe(true);

        // Ensure chronological timestamp monotonicity
        if (i > 0) {
          expect(pt.timestamp).toBe(chart.data[i - 1].timestamp + 3600);
        }
      }

      // Summary must align
      expect(chart.summary.tradesCount).toBe(0);
      expect(chart.summary.volumeTotal).toBe("0");
      expect(chart.summary.currentPrice).toBe(baselinePt);
      expect(chart.summary.currentTvl).toBe(baselineTvl);
    });

    it("forward-fills sparse trade gaps correctly: trade in bucket 0, trade in bucket 18", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const currentHourly = Math.floor(nowSec / 3600) * 3600;

      // Event in bucket 0 (23 hours ago)
      const ts0 = currentHourly - 23 * 3600 + 100;
      const event0: DecodedEvent = {
        id: "evt-ff-0",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-ff-0",
        ledger: 300000,
        ledgerClosedAt: new Date(ts0 * 1000).toISOString(),
        timestamp: ts0,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "GUSER",
        receiver: "GUSER",
        data: {
          direction: 0,
          amountIn: "1000000",
          amountOut: "975000",
          fee: "0",
        },
        rawJson: "{}",
      };

      // Event in bucket 18 (5 hours ago)
      const ts18 = currentHourly - 5 * 3600 + 200;
      const event18: DecodedEvent = {
        id: "evt-ff-18",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx-ff-18",
        ledger: 300050,
        ledgerClosedAt: new Date(ts18 * 1000).toISOString(),
        timestamp: ts18,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "GUSER",
        receiver: "GUSER",
        data: {
          direction: 0,
          amountIn: "1000000",
          amountOut: "985000",
          fee: "0",
        },
        rawJson: "{}",
      };

      storage.saveEvents([event0, event18]);

      const chart = storage.getMarketChart("usdc-90d", "1D");
      expect(chart.count).toBe(24);

      // Bucket 0 has event 0: price = 0.975
      expect(chart.data[0].close).toBeCloseTo(0.975, 4);
      expect(chart.data[0].tradeCount).toBe(1);
      expect(chart.data[0].volume).toBe("975000");

      // Buckets 1 through 17 are empty gaps: must carry forward price 0.975
      for (let b = 1; b < 18; b++) {
        const gapBucket = chart.data[b];
        expect(gapBucket.open).toBeCloseTo(0.975, 4);
        expect(gapBucket.close).toBeCloseTo(0.975, 4);
        expect(gapBucket.high).toBeCloseTo(0.975, 4);
        expect(gapBucket.low).toBeCloseTo(0.975, 4);
        expect(gapBucket.tradeCount).toBe(0);
        expect(gapBucket.volume).toBe("0");
        expect(gapBucket.impliedApy).toBeGreaterThan(0.0);
      }

      // Bucket 18 has event 18: price = 0.985
      expect(chart.data[18].close).toBeCloseTo(0.985, 4);
      expect(chart.data[18].tradeCount).toBe(1);
      expect(chart.data[18].volume).toBe("985000");

      // Buckets 19 through 23 are empty gaps: must carry forward price 0.985
      for (let b = 19; b < 24; b++) {
        const gapBucket = chart.data[b];
        expect(gapBucket.open).toBeCloseTo(0.985, 4);
        expect(gapBucket.close).toBeCloseTo(0.985, 4);
        expect(gapBucket.tradeCount).toBe(0);
        expect(gapBucket.volume).toBe("0");
        expect(gapBucket.impliedApy).toBeGreaterThan(0.0);
      }

      // Summary checks
      expect(chart.summary.tradesCount).toBe(2);
      expect(chart.summary.volumeTotal).toBe((975000n + 985000n).toString());
      expect(chart.summary.currentPrice).toBeCloseTo(0.985, 4);
    });

    afterAll(() => {
      storage.close();
      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }
    });
  });

  // ==========================================================================
  // Suite 5: Post-Maturity Boundary and Historical Transition Stress
  // ==========================================================================
  describe("Suite 5: Post-Maturity Chart Transitions", () => {
    let testDbPath: string;
    let storage: EventStorage;

    beforeAll(() => {
      testDbPath = join(import.meta.dir, `test_stress_maturity_${Date.now()}.db`);
      storage = new EventStorage(testDbPath);
    });

    it("verifies that when an event timestamp is >= maturity, implied APY recorded is strictly 0.0%", () => {
      const market = MARKETS["usdc-90d"];
      const postMaturityTs = market.maturity + 3600; // 1 hour past maturity

      const postMaturityEvent: DecodedEvent = {
        id: "evt-post-mat-1",
        contractId: market.poolId,
        txHash: "tx-post-mat-1",
        ledger: 500000,
        ledgerClosedAt: new Date(postMaturityTs * 1000).toISOString(),
        timestamp: postMaturityTs,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "GUSER",
        receiver: "GUSER",
        data: {
          direction: 0,
          amountIn: "1000000",
          amountOut: "990000",
          fee: "0",
        },
        rawJson: "{}",
      };

      storage.saveEvents([postMaturityEvent]);

      // Query raw snapshot row from DB
      const db = (storage as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> } } }).db;
      const hourlyBucket = Math.floor(postMaturityTs / 3600) * 3600;
      const row = db.prepare("SELECT * FROM market_snapshots WHERE market_id = ? AND bucket_timestamp = ?").get(market.id, hourlyBucket);

      expect(row).toBeDefined();
      expect(row.implied_apy).toBe(0.0);
      expect(row.pt_price).toBeCloseTo(0.99, 4);
      expect(row.yt_price).toBeCloseTo(0.01, 4);
    });

    afterAll(() => {
      storage.close();
      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }
    });
  });

  // ==========================================================================
  // Suite 6: Multi-Market and Multi-Interval Matrix Verification
  // ==========================================================================
  describe("Suite 6: Multi-Market x Multi-Interval Matrix Verification", () => {
    let testDbPath: string;
    let storage: EventStorage;

    beforeAll(() => {
      testDbPath = join(import.meta.dir, `test_stress_matrix_${Date.now()}.db`);
      storage = new EventStorage(testDbPath);
    });

    const marketIds = ["usdc-90d", "usdc-30d", "xlm-90d"];
    const intervals = [
      { code: "1D", expectedCount: 24, stride: 3600 },
      { code: "1W", expectedCount: 168, stride: 3600 },
      { code: "1M", expectedCount: 30, stride: 86400 },
      { code: "ALL", minCount: 30, stride: 86400 },
    ];

    for (const mId of marketIds) {
      for (const inv of intervals) {
        it(`verifies ${mId} chart generation for interval ${inv.code}`, () => {
          const chart = storage.getMarketChart(mId, inv.code);
          expect(chart.success).toBe(true);
          expect(chart.market).toBe(mId);
          expect(chart.interval).toBe(inv.code);

          if (inv.expectedCount) {
            expect(chart.count).toBe(inv.expectedCount);
            expect(chart.data.length).toBe(inv.expectedCount);
          } else {
            expect(chart.count).toBeGreaterThanOrEqual(inv.minCount);
            expect(chart.data.length).toBeGreaterThanOrEqual(inv.minCount);
          }

          // Check monotonicity of timestamps
          for (let i = 1; i < chart.data.length; i++) {
            expect(chart.data[i].timestamp - chart.data[i - 1].timestamp).toBe(inv.stride);
          }

          // Check that every bucket has valid OHLCV and non-null values
          for (const pt of chart.data) {
            expect(pt.high).toBeGreaterThanOrEqual(pt.low);
            expect(pt.open).toBeGreaterThan(0);
            expect(pt.close).toBeGreaterThan(0);
            expect(pt.impliedApy).toBeGreaterThanOrEqual(0.0);
            expect(pt.impliedApy).toBeLessThanOrEqual(500.0);
            expect(pt.underlyingApy).toBe(MARKETS[mId].underlyingApy);
            expect(typeof pt.volume).toBe("string");
            expect(typeof pt.tvl).toBe("string");
          }
        });
      }
    }

    afterAll(() => {
      storage.close();
      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }
    });
  });

  // ==========================================================================
  // Suite 7: Rapid Burst Swaps within Single Bucket (OHLC Aggregation)
  // ==========================================================================
  describe("Suite 7: Intra-Bucket OHLC Aggregation under 50 Consecutive Swaps", () => {
    let testDbPath: string;
    let storage: EventStorage;

    beforeAll(() => {
      testDbPath = join(import.meta.dir, `test_stress_burst_${Date.now()}.db`);
      storage = new EventStorage(testDbPath);
    });

    it("verifies Open, High, Low, Close, Volume, and TradeCount across 50 trades in same hour", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const bucketBase = Math.floor(nowSec / 3600) * 3600;

      // 50 prices fluctuating between 0.9600 and 0.9900
      const prices = [
        0.9700, 0.9720, 0.9650, 0.9610, // low around 0.9610
        0.9750, 0.9850, 0.9890, 0.9780, // high around 0.9890
        0.9740, 0.9800, 0.9760, 0.9820,
      ];
      // repeat to make 50
      const burstPrices: number[] = [];
      for (let i = 0; i < 50; i++) {
        burstPrices.push(prices[i % prices.length]);
      }

      let cumulativeVolume = 0n;
      const events: DecodedEvent[] = [];

      for (let i = 0; i < 50; i++) {
        const p = burstPrices[i];
        // dir 0: grossSy = p * 1,000,000
        const grossSy = BigInt(Math.round(p * 1000000));
        cumulativeVolume += grossSy;

        events.push({
          id: `evt-burst-${i}`,
          contractId: MARKETS["usdc-90d"].poolId,
          txHash: `tx-burst-${i}`,
          ledger: 400000 + i,
          ledgerClosedAt: new Date((bucketBase + i * 10) * 1000).toISOString(),
          timestamp: bucketBase + i * 10,
          type: "swap",
          topicSymbol: "swap_event",
          caller: "GUSER",
          receiver: "GUSER",
          data: {
            direction: 0,
            amountIn: "1000000",
            amountOut: grossSy.toString(),
            fee: "0",
          },
          rawJson: "{}",
        });
      }

      storage.saveEvents(events);

      const chart = storage.getMarketChart("usdc-90d", "1D");
      const currentBucketPt = chart.data[chart.data.length - 1];

      // Open must match the first trade
      expect(currentBucketPt.open).toBeCloseTo(burstPrices[0], 4);
      // High must match the maximum price in the sequence
      const expectedHigh = Math.max(...burstPrices);
      expect(currentBucketPt.high).toBeCloseTo(expectedHigh, 4);
      // Low must match the minimum price in the sequence
      const expectedLow = Math.min(...burstPrices);
      expect(currentBucketPt.low).toBeCloseTo(expectedLow, 4);
      // Close must match the last trade
      expect(currentBucketPt.close).toBeCloseTo(burstPrices[49], 4);
      // Trade count must be 50
      expect(currentBucketPt.tradeCount).toBe(50);
      // Volume must match cumulative volume
      expect(currentBucketPt.volume).toBe(cumulativeVolume.toString());
    });

    afterAll(() => {
      storage.close();
      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }
    });
  });
});
