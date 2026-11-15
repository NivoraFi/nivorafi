import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import {
  EventStorage,
  calculateImpliedApy,
  MARKETS,
  resolveMarket,
  UserPositionsResponse,
} from "../indexer/index";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";

describe("Empirical Accounting Math Stress Suite — Milestone 2", () => {
  const testDbPath = join(import.meta.dir, "test_m2_accounting_stress.db");
  let storage: EventStorage;
  let dateSpy: any = null;

  const cleanupDb = () => {
    try {
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
      if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
      if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    } catch {
      // Ignore
    }
  };

  beforeEach(() => {
    cleanupDb();
    storage = new EventStorage(testDbPath);
  });

  afterEach(() => {
    if (dateSpy) {
      dateSpy.mockRestore();
      dateSpy = null;
    }
    if (storage) {
      storage.close();
    }
    cleanupDb();
  });

  // ==========================================================================
  // Area 1: Buy PT -> Sell Partial PT -> Verify Remaining Unit Cost Basis & Realized PnL
  // ==========================================================================
  describe("Area 1: Unit Cost Basis & Realized PnL Accounting Invariants", () => {
    const USER = "GCHALLENGER_A1_WALLET_STROOPS_TESTING_11111111111111111";

    it("1.1 Multi-stage partial sales preserve exact unit cost basis and cashflow PnL conservation", () => {
      const now = 1794270000;
      // Step 1: Buy 10,000 PT for 9,200 SY (Unit cost = 0.92 SY per PT)
      const buyPt = 10_000_0000000n;
      const buySy = 9_200_0000000n;
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: buySy,
        amountOut: buyPt,
        fee: 0n,
      });

      let pos = storage.getUserPositions(USER).positions[0];
      expect(BigInt(pos.currentPtBalance)).toBe(buyPt);
      expect(BigInt(pos.costBasisStroops)).toBe(buySy);
      const initialUnitCost = Number(pos.costBasisStroops) / Number(pos.currentPtBalance);
      expect(initialUnitCost).toBe(0.92);

      // Step 2: Partial Sale 1 — Sell 1,000 PT (10%) for 950 SY (Profitable sale: 950 - 920 = +30 SY)
      const sell1Pt = 1_000_0000000n;
      const sell1Sy = 950_0000000n;
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 60,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: sell1Pt,
        amountOut: sell1Sy,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER).positions[0];
      expect(BigInt(pos.currentPtBalance)).toBe(9_000_0000000n);
      // Expected remaining cost basis: 9200 - 920 = 8280 SY
      expect(BigInt(pos.costBasisStroops)).toBe(8_280_0000000n);
      const unitCostAfterSale1 = Number(pos.costBasisStroops) / Number(pos.currentPtBalance);
      // INVARIANT: Unit cost basis MUST remain invariant after partial sale!
      expect(unitCostAfterSale1).toBeCloseTo(initialUnitCost, 8);
      // Realized PnL: 950 - 920 = 30 SY ($30.00)
      expect(BigInt(pos.realizedPnlStroops)).toBe(30_0000000n);
      expect(pos.realizedPnlUsd).toBe(30.0);

      // Step 3: Partial Sale 2 — Sell 2,500 PT (25% of original) for 2,400 SY (2400 - (2500 * 0.92 = 2300) = +100 SY)
      const sell2Pt = 2_500_0000000n;
      const sell2Sy = 2_400_0000000n;
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 120,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: sell2Pt,
        amountOut: sell2Sy,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER).positions[0];
      expect(BigInt(pos.currentPtBalance)).toBe(6_500_0000000n);
      // Expected remaining cost basis: 8280 - 2300 = 5980 SY
      expect(BigInt(pos.costBasisStroops)).toBe(5_980_0000000n);
      const unitCostAfterSale2 = Number(pos.costBasisStroops) / Number(pos.currentPtBalance);
      expect(unitCostAfterSale2).toBeCloseTo(initialUnitCost, 8);
      // Cumulative Realized PnL: 30 + 100 = 130 SY ($130.00)
      expect(BigInt(pos.realizedPnlStroops)).toBe(130_0000000n);
      expect(pos.realizedPnlUsd).toBe(130.0);

      // Step 4: Final Sale — Sell all remaining 6,500 PT for 6,300 SY (6300 - 5980 = +320 SY)
      const sell3Pt = 6_500_0000000n;
      const sell3Sy = 6_300_0000000n;
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 180,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: sell3Pt,
        amountOut: sell3Sy,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER).positions[0];
      expect(BigInt(pos.currentPtBalance)).toBe(0n);
      expect(BigInt(pos.costBasisStroops)).toBe(0n);

      // Total cashflow audit:
      // Paid: 9,200 SY
      // Received: 950 + 2,400 + 6,300 = 9,650 SY
      // Total net gain: 9,650 - 9,200 = +450 SY ($450.00)
      // Realized PnL: 30 + 100 + 320 = 450 SY
      expect(BigInt(pos.realizedPnlStroops)).toBe(450_0000000n);
      expect(pos.realizedPnlUsd).toBe(450.0);
    });

    it("1.2 Selling PT at a loss correctly produces negative realized PnL and reduces cost basis", () => {
      const now = 1794270000;
      // Buy 1,000 PT for 950 SY (unit cost = 0.95)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 950_0000000n,
        amountOut: 1_000_0000000n,
        fee: 0n,
      });

      // Sell 400 PT for 360 SY (unit sell price = 0.90 -> loss = 360 - 380 = -20 SY)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 60,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: 400_0000000n,
        amountOut: 360_0000000n,
        fee: 0n,
      });

      const pos = storage.getUserPositions(USER).positions[0];
      expect(BigInt(pos.currentPtBalance)).toBe(600_0000000n);
      expect(BigInt(pos.costBasisStroops)).toBe(570_0000000n);
      // Realized PnL must be strictly negative (-20 SY = -200,000,000 stroops = -$20.00)
      expect(BigInt(pos.realizedPnlStroops)).toBe(-20_0000000n);
      expect(pos.realizedPnlUsd).toBe(-20.0);
    });

    it("1.3 High-precision fractional/prime amounts: verifies stroop rounding drift <= 1 stroop", () => {
      const now = 1794270000;
      // Prime number stroops: Buy 7,777,777 PT for 7,111,111 SY
      const ptBought = 7_777_777n;
      const syPaid = 7_111_111n;

      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: syPaid,
        amountOut: ptBought,
        fee: 0n,
      });

      // Execute 7 fractional sales of 1,000,000 PT each
      let cumRealizedExpected = 0n;
      let remainingCostExpected = syPaid;
      let remainingPtExpected = ptBought;

      for (let i = 1; i <= 7; i++) {
        const ptChunk = 1_000_000n;
        const syReceived = 920_000n; // sold at ~0.92

        const unitCost = Number(remainingCostExpected) / Number(remainingPtExpected);
        const costDeducted = BigInt(Math.floor(Number(ptChunk) * unitCost));
        const pnl = syReceived - costDeducted;

        cumRealizedExpected += pnl;
        remainingCostExpected -= costDeducted;
        remainingPtExpected -= ptChunk;

        storage.recordSwap({
          marketId: "usdc-90d",
          timestamp: now + i * 10,
          caller: USER,
          receiver: USER,
          direction: 0,
          amountIn: ptChunk,
          amountOut: syReceived,
          fee: 0n,
        });
      }

      const pos = storage.getUserPositions(USER).positions[0];
      expect(BigInt(pos.currentPtBalance)).toBe(remainingPtExpected);
      // Verify difference between database cost basis and exact integer oracle is <= 1 stroop
      const costDiff = BigInt(pos.costBasisStroops) - remainingCostExpected;
      expect(Math.abs(Number(costDiff))).toBeLessThanOrEqual(1);
      const pnlDiff = BigInt(pos.realizedPnlStroops) - cumRealizedExpected;
      expect(Math.abs(Number(pnlDiff))).toBeLessThanOrEqual(1);
    });

    it("1.4 YT trading (Dir 2 Buy, Dir 3 Sell) preserves YT unit cost basis and computes exact PnL", () => {
      const now = 1794270000;
      // Buy 5,000 YT for 250 SY (unit cost = 0.05 SY per YT)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: USER,
        receiver: USER,
        direction: 2, // Buy YT
        amountIn: 250_0000000n,
        amountOut: 5_000_0000000n,
        fee: 0n,
      });

      let pos = storage.getUserPositions(USER).positions[0];
      expect(BigInt(pos.currentYtBalance)).toBe(5_000_0000000n);
      expect(BigInt(pos.costBasisStroops)).toBe(250_0000000n);

      // Sell 2,000 YT for 140 SY (unit sell = 0.07 -> profit = 140 - (2000 * 0.05 = 100) = +40 SY)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 60,
        caller: USER,
        receiver: USER,
        direction: 3, // Sell YT
        amountIn: 2_000_0000000n,
        amountOut: 140_0000000n,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER).positions[0];
      expect(BigInt(pos.currentYtBalance)).toBe(3_000_0000000n);
      expect(BigInt(pos.costBasisStroops)).toBe(150_0000000n); // 250 - 100 = 150 SY
      expect(BigInt(pos.realizedPnlStroops)).toBe(40_0000000n);
      expect(pos.realizedPnlUsd).toBe(40.0);
    });

    it("1.5 Dust cleanup threshold (< 10 stroops) cleanly wipes micro-residue without division-by-zero", () => {
      const now = 1794270000;
      // Buy 100 stroops of PT
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 95n,
        amountOut: 100n,
        fee: 0n,
      });

      // Sell 95 stroops (leaves 5 stroops < 10 threshold)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 60,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: 95n,
        amountOut: 90n,
        fee: 0n,
      });

      const pos = storage.getUserPositions(USER).positions[0];
      // Must be safely clamped to 0
      expect(pos.currentPtBalance).toBe("0");
      expect(pos.costBasisStroops).toBe("0");
      expect(pos.costBasisUsd).toBe(0);
      expect(Number.isFinite(pos.averageEntryApy)).toBe(true);
    });
  });

  // ==========================================================================
  // Area 2: Secondary Purchases -> Verify Weighted Average Entry APY
  // ==========================================================================
  describe("Area 2: Secondary Purchases & Weighted Average Entry APY Oracle", () => {
    const USER = "GCHALLENGER_A2_SECONDARY_APY_ORACLE_TESTING_2222222222";
    const market = MARKETS["usdc-90d"];

    it("2.1 Multi-tranche secondary purchases exactly match theoretical weighted average APY", () => {
      const baseTs = 1794258000;
      const tau = Math.max(0, market.maturity - baseTs) / 31536000;

      // Tranche 1: Buy 1,000 PT for 950 SY (spot = 0.95)
      const t1Tokens = 1_000_0000000n;
      const t1In = 950_0000000n;
      const apy1 = calculateImpliedApy(0.95, tau);

      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: t1In,
        amountOut: t1Tokens,
        fee: 0n,
      });

      let pos = storage.getUserPositions(USER).positions[0];
      expect(pos.averageEntryApy).toBe(Number(apy1.toFixed(2)));

      // Tranche 2: Buy 3,000 PT for 2,700 SY (spot = 0.90 -> higher APY)
      const t2Tokens = 3_000_0000000n;
      const t2In = 2_700_0000000n;
      const apy2 = calculateImpliedApy(0.90, tau);

      // Theoretical weighted oracle:
      const totalTokensAfterT2 = Number(t1Tokens + t2Tokens);
      const expectedApyAfterT2 = Number(
        ((apy1 * Number(t1Tokens) + apy2 * Number(t2Tokens)) / totalTokensAfterT2).toFixed(2)
      );

      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs + 10,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: t2In,
        amountOut: t2Tokens,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER).positions[0];
      expect(pos.averageEntryApy).toBe(expectedApyAfterT2);

      // Tranche 3: Buy 6,000 PT for 5,820 SY (spot = 0.97 -> lower APY)
      const t3Tokens = 6_000_0000000n;
      const t3In = 5_820_0000000n;
      const apy3 = calculateImpliedApy(0.97, tau);

      const totalTokensAfterT3 = totalTokensAfterT2 + Number(t3Tokens);
      const expectedApyAfterT3 = Number(
        ((expectedApyAfterT2 * totalTokensAfterT2 + apy3 * Number(t3Tokens)) / totalTokensAfterT3).toFixed(2)
      );

      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs + 20,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: t3In,
        amountOut: t3Tokens,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER).positions[0];
      expect(pos.averageEntryApy).toBe(expectedApyAfterT3);
    });

    it("2.2 Partial sale does NOT alter the Average Entry APY of remaining tokens", () => {
      const baseTs = 1794258000;
      // Buy 5,000 PT
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 4_600_0000000n,
        amountOut: 5_000_0000000n,
        fee: 0n,
      });

      let pos = storage.getUserPositions(USER).positions[0];
      const entryApyBeforeSale = pos.averageEntryApy;
      expect(entryApyBeforeSale).toBeGreaterThan(0);

      // Sell 2,000 PT (40% of position)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs + 60,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: 2_000_0000000n,
        amountOut: 1_900_0000000n,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER).positions[0];
      // CRITICAL MATHEMATICAL INVARIANT:
      // Selling tokens realizes PnL but MUST NOT change the entry APY of remaining tokens
      expect(pos.averageEntryApy).toBe(entryApyBeforeSale);
    });

    it("2.3 Secondary purchase after partial sale weights against remaining token balance", () => {
      const baseTs = 1794258000;
      const tau = Math.max(0, market.maturity - baseTs) / 31536000;

      // 1. Buy 2,000 PT at 0.95
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 1_900_0000000n,
        amountOut: 2_000_0000000n,
        fee: 0n,
      });
      const initialApy = storage.getUserPositions(USER).positions[0].averageEntryApy;

      // 2. Sell 1,000 PT (leaving 1,000 PT with initialApy)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs + 60,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: 1_000_0000000n,
        amountOut: 960_0000000n,
        fee: 0n,
      });

      // 3. Buy 3,000 PT at 0.91
      const newTokens = 3_000_0000000n;
      const apyNew = calculateImpliedApy(0.91, tau);
      const remainingTokens = 1_000_0000000n;

      const expectedApy = Number(
        ((initialApy * Number(remainingTokens) + apyNew * Number(newTokens)) / Number(remainingTokens + newTokens)).toFixed(2)
      );

      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs + 120,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 2_730_0000000n,
        amountOut: newTokens,
        fee: 0n,
      });

      const pos = storage.getUserPositions(USER).positions[0];
      expect(pos.averageEntryApy).toBe(expectedApy);
    });

    it("2.4 Full liquidation and re-purchase cleanly resets entry APY to new trade rate", () => {
      const baseTs = 1794258000;
      const tau = Math.max(0, market.maturity - baseTs) / 31536000;

      // Buy 1,000 PT at 0.95
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 950_0000000n,
        amountOut: 1_000_0000000n,
        fee: 0n,
      });

      // Liquidate 100% (sell all 1,000 PT)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs + 60,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: 1_000_0000000n,
        amountOut: 960_0000000n,
        fee: 0n,
      });

      let pos = storage.getUserPositions(USER).positions[0];
      expect(pos.currentPtBalance).toBe("0");

      // Re-buy 500 PT at 0.88 (higher APY)
      const newApy = calculateImpliedApy(0.88, tau);
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs + 120,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 440_0000000n,
        amountOut: 500_0000000n,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER).positions[0];
      // Previous position history should NOT contaminate new position's entry APY
      expect(pos.averageEntryApy).toBe(Number(newApy.toFixed(2)));
    });

    it("2.5 Extreme size asymmetries (micro after whale, whale after micro) maintain numerical stability", () => {
      const baseTs = 1794258000;
      const tau = Math.max(0, market.maturity - baseTs) / 31536000;

      // Case A: Micro-trade (1 PT) followed by Whale-trade (1,000,000 PT)
      const WHALE_USER = "GWHALE_ASYMMETRY_WALLET_TESTING_1234567890";
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs,
        caller: WHALE_USER,
        receiver: WHALE_USER,
        direction: 1,
        amountIn: 95_00000n, // 0.95 SY
        amountOut: 100_00000n, // 1 PT
        fee: 0n,
      });

      // Whale buys 1,000,000 PT at 0.90
      const whaleApy = calculateImpliedApy(0.90, tau);
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: baseTs + 10,
        caller: WHALE_USER,
        receiver: WHALE_USER,
        direction: 1,
        amountIn: 900_000_0000000n,
        amountOut: 1_000_000_0000000n,
        fee: 0n,
      });

      const whalePos = storage.getUserPositions(WHALE_USER).positions[0];
      // Whale trade (1,000,000 vs 1) should dominate 99.9999% of the APY
      expect(whalePos.averageEntryApy).toBeCloseTo(Number(whaleApy.toFixed(2)), 1);
      expect(Number.isFinite(whalePos.averageEntryApy)).toBe(true);
    });
  });

  // ==========================================================================
  // Area 3: Mint PY -> Split Cost Basis -> Harvest Yield -> Redeem PT at Maturity
  //         -> Verify Total Net PnL Conservation
  // ==========================================================================
  describe("Area 3: Mint PY Lifecycle & Absolute Net PnL Conservation Invariant", () => {
    const LIFECYCLE_USER = "GCHALLENGER_A3_LIFECYCLE_CONSERVATION_33333333333333";
    const market = MARKETS["usdc-90d"];

    it("3.1 Complete Lifecycle Conservation: Net PnL == Total Cashflow Out - Total Cashflow In", () => {
      // Step 1: Mint PY from 10,000 SY (10,000 USDC)
      const depositSy = 10_000_0000000n; // 10,000 SY = $10,000.00
      const mintTs = 1794260000; // Pre-maturity
      const spotPtAtMint = 0.94; // YT spot = 0.06

      storage.recordMintPy({
        marketId: "usdc-90d",
        caller: LIFECYCLE_USER,
        receiver: LIFECYCLE_USER,
        syIn: depositSy,
        pyOut: depositSy,
        timestamp: mintTs,
        spotPtPrice: spotPtAtMint,
      });

      let pos = storage.getUserPositions(LIFECYCLE_USER).positions[0];
      // Conservation check at minting:
      // Total cost basis must equal depositSy exactly
      expect(BigInt(pos.costBasisStroops)).toBe(depositSy);
      expect(pos.costBasisUsd).toBe(10000.0);
      expect(BigInt(pos.currentPtBalance)).toBe(depositSy);
      expect(BigInt(pos.currentYtBalance)).toBe(depositSy);

      // Step 2: Harvest Floating Yield in 3 batches over the life of the market
      const yield1 = 120_0000000n; // 120 SY ($120)
      const yield2 = 180_0000000n; // 180 SY ($180)
      const yield3 = 150_0000000n; // 150 SY ($150)
      const totalYieldHarvested = yield1 + yield2 + yield3; // 450 SY ($450)

      storage.recordYieldClaimed({
        marketId: "usdc-90d",
        user: LIFECYCLE_USER,
        yieldOut: yield1,
        timestamp: mintTs + 86400 * 10,
      });
      storage.recordYieldClaimed({
        marketId: "usdc-90d",
        user: LIFECYCLE_USER,
        yieldOut: yield2,
        timestamp: mintTs + 86400 * 30,
      });
      storage.recordYieldClaimed({
        marketId: "usdc-90d",
        user: LIFECYCLE_USER,
        yieldOut: yield3,
        timestamp: mintTs + 86400 * 60,
      });

      pos = storage.getUserPositions(LIFECYCLE_USER).positions[0];
      expect(BigInt(pos.cumulativeClaimedYieldStroops)).toBe(totalYieldHarvested);
      expect(pos.cumulativeClaimedYieldUsd).toBe(450.0);
      expect(pos.realizedPnlUsd).toBe(450.0);

      // Step 3: Maturity Arrival & PT Redemption
      // At maturity, 1 PT redeems for 1 SY. Payout = 10,000 SY.
      const maturityTs = market.maturity + 100;
      // Mock wall-clock time to post-maturity for mark-to-market evaluation
      dateSpy = spyOn(Date, "now").mockReturnValue(maturityTs * 1000);

      storage.recordRedeemPt({
        marketId: "usdc-90d",
        caller: LIFECYCLE_USER,
        ptBurned: depositSy,
        payout: depositSy, // Full 1:1 redemption at par
        timestamp: maturityTs,
      });

      pos = storage.getUserPositions(LIFECYCLE_USER).positions[0];
      expect(pos.currentPtBalance).toBe("0");
      expect(BigInt(pos.currentYtBalance)).toBe(depositSy);

      // Realized PnL breakdown:
      // Initial PT cost: 10,000 * 0.94 = 9,400 SY.
      // Redemption payout: 10,000 SY.
      // PT Discount profit: 10,000 - 9,400 = +600 SY.
      // Total Realized PnL = Yield (450 SY) + PT Discount (600 SY) = 1,050 SY ($1,050.00).
      expect(pos.realizedPnlUsd).toBe(1050.0);

      // YT Unrealized PnL breakdown at maturity:
      // YT initial cost = 10,000 - 9,400 = 600 SY ($600.00).
      // At maturity (isMatured = true), YT spot price = 0.0 (expired).
      // YT current value = 0.
      // YT Unrealized PnL = 0 - 600 SY = -600 SY (-$600.00).
      expect(pos.unrealizedPnlUsd).toBe(-600.0);

      // ABSOLUTE CONSERVATION CHECK:
      // Total Net PnL = Realized PnL (+1050) + Unrealized PnL (-600) = +$450.00 (+450 SY).
      // External Cashflow:
      // User deposited: 10,000 SY
      // User received: 450 SY (yield) + 10,000 SY (PT payout) = 10,450 SY.
      // Actual Net Profit = 10,450 - 10,000 = +450 SY (+450.00 USD).
      // INVARIANT: Net PnL MUST EQUAL ACTUAL NET CASHFLOW TO THE CENT!
      expect(pos.netPnlUsd).toBe(450.0);
    });

    it("3.2 Zero-yield scenario: Net PnL is 0 and initial principal is perfectly conserved", () => {
      // If a minter holds PT and YT to maturity but zero floating yield was generated:
      // User deposited 5,000 SY ($5,000).
      // PT redeemed for 5,000 SY ($5,000).
      // YT expired worthless.
      // Net PnL must be exactly $0.00.
      const ZERO_YIELD_USER = "GZERO_YIELD_USER_CONSERVATION_TESTING_44444444444444";
      const depositSy = 5_000_0000000n;
      const maturityTs = market.maturity + 100;

      storage.recordMintPy({
        marketId: "usdc-90d",
        caller: ZERO_YIELD_USER,
        receiver: ZERO_YIELD_USER,
        syIn: depositSy,
        pyOut: depositSy,
        timestamp: 1794260000,
        spotPtPrice: 0.95, // PT cost 4750, YT cost 250
      });

      dateSpy = spyOn(Date, "now").mockReturnValue(maturityTs * 1000);

      // Post-maturity PT redemption
      storage.recordRedeemPt({
        marketId: "usdc-90d",
        caller: ZERO_YIELD_USER,
        ptBurned: depositSy,
        payout: depositSy,
        timestamp: maturityTs,
      });

      const pos = storage.getUserPositions(ZERO_YIELD_USER).positions[0];
      // PT realized profit = 5000 - 4750 = +250 SY ($250.00)
      expect(pos.realizedPnlUsd).toBe(250.0);
      // YT unrealized loss = 0 - 250 = -250 SY (-$250.00)
      expect(pos.unrealizedPnlUsd).toBe(-250.0);
      // Net PnL = +250 + (-250) = $0.00
      expect(pos.netPnlUsd).toBe(0.0);
    });

    it("3.3 Partial redemption at maturity (50% redeemed, 50% unredeemed) conserves PnL partition", () => {
      const PARTIAL_USER = "GPARTIAL_REDEMPTION_USER_TESTING_55555555555555";
      const depositSy = 4_000_0000000n; // 4,000 SY ($4,000)
      const maturityTs = market.maturity + 100;

      storage.recordMintPy({
        marketId: "usdc-90d",
        caller: PARTIAL_USER,
        receiver: PARTIAL_USER,
        syIn: depositSy,
        pyOut: depositSy,
        timestamp: 1794260000,
        spotPtPrice: 0.90, // PT cost 3600, YT cost 400
      });

      dateSpy = spyOn(Date, "now").mockReturnValue(maturityTs * 1000);

      // Redeem 50% of PT post-maturity: 2,000 PT for 2,000 SY
      storage.recordRedeemPt({
        marketId: "usdc-90d",
        caller: PARTIAL_USER,
        ptBurned: 2_000_0000000n,
        payout: 2_000_0000000n,
        timestamp: maturityTs,
      });

      const pos = storage.getUserPositions(PARTIAL_USER).positions[0];
      // Realized profit on 2000 PT = 2000 - 1800 = +200 SY ($200.00)
      expect(pos.realizedPnlUsd).toBe(200.0);
      // Remaining inventory at maturity:
      // Remaining 2000 PT valued at 1.0 = 2000 SY. Remaining PT cost = 1800 SY. Unrealized PT gain = +200 SY ($200).
      // Remaining 4000 YT valued at 0.0 = 0 SY. YT cost = 400 SY. Unrealized YT loss = -400 SY (-$400).
      // Total Unrealized PnL = +200 - 400 = -200 SY (-$200.00).
      expect(pos.unrealizedPnlUsd).toBe(-200.0);
      // Net PnL = Realized (+200) + Unrealized (-200) = $0.00.
      expect(pos.netPnlUsd).toBe(0.0);
    });

    it("3.4 Early pre-maturity redeem_py cleanly unlocks underlying SY and zeroes cost basis", () => {
      const EARLY_USER = "GEARLY_REDEEM_PY_USER_TESTING_66666666666666";
      const depositSy = 2_000_0000000n;

      storage.recordMintPy({
        marketId: "usdc-90d",
        caller: EARLY_USER,
        receiver: EARLY_USER,
        syIn: depositSy,
        pyOut: depositSy,
        timestamp: 1794260000,
        spotPtPrice: 0.95,
      });

      // Redeem 1,000 PY early (50%)
      const pyBurned = 1_000_0000000n;
      const syOut = 1_000_0000000n;

      // Manually record redeem_py event
      storage.saveEvents([
        {
          id: "evt_redeem_py_early",
          contractId: market.poolId,
          txHash: "tx_redeem_py",
          ledger: 100010,
          ledgerClosedAt: new Date(1794261000 * 1000).toISOString(),
          timestamp: 1794261000,
          type: "redeem_py",
          topicSymbol: "redeem_py",
          caller: EARLY_USER,
          receiver: EARLY_USER,
          data: {
            pyBurned: pyBurned.toString(),
            syOut: syOut.toString(),
            marketId: market.id,
          },
          rawJson: "",
        },
      ]);

      const pos = storage.getUserPositions(EARLY_USER).positions[0];
      expect(BigInt(pos.currentPtBalance)).toBe(1_000_0000000n);
      expect(BigInt(pos.currentYtBalance)).toBe(1_000_0000000n);
      expect(BigInt(pos.costBasisStroops)).toBe(1_000_0000000n);
      // Zero realized gain/loss on direct neutral un-bundling
      expect(pos.realizedPnlUsd).toBe(0.0);
    });
  });

  // ==========================================================================
  // Area 4: Mark-to-Market Unrealized PnL Sensitivity to Pool Price Changes
  // ==========================================================================
  describe("Area 4: Mark-to-Market Valuation & Pool Price Sensitivity", () => {
    const PT_HOLDER = "GCHALLENGER_A4_PT_HOLDER_TESTING_77777777777777";
    const YT_HOLDER = "GCHALLENGER_A4_YT_HOLDER_TESTING_88888888888888";
    const PY_MINTER = "GCHALLENGER_A4_PY_MINTER_TESTING_99999999999999";

    it("4.1 Directional sensitivity for PT-only position matches d(Unrealized)/d(Price) = ptBal", () => {
      const now = 1794260000; // Pre-maturity
      // Buy 10,000 PT at 0.92 (Cost = 9,200 SY = $9,200.00)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: PT_HOLDER,
        receiver: PT_HOLDER,
        direction: 1,
        amountIn: 9_200_0000000n,
        amountOut: 10_000_0000000n,
        fee: 0n,
      });

      // Price jump 1: Market trades at 0.95 (+0.03 delta)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 3600,
        caller: "GBOB_OTHER_MARKET_PARTICIPANT_1",
        receiver: "GBOB_OTHER_MARKET_PARTICIPANT_1",
        direction: 1,
        amountIn: 950_0000000n,
        amountOut: 1_000_0000000n,
        fee: 0n,
      });

      let pos = storage.getUserPositions(PT_HOLDER).positions[0];
      // 10,000 PT marked at 0.95 = 9,500 SY ($9,500.00).
      // Unrealized PnL = 9,500 - 9,200 = +300 SY ($300.00).
      expect(pos.unrealizedPnlUsd).toBe(300.0);
      expect(pos.currentPositionValueUsd).toBe(9500.0);

      // Price jump 2: Market drops to 0.89 (-0.06 delta from 0.95)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 7200,
        caller: "GBOB_OTHER_MARKET_PARTICIPANT_2",
        receiver: "GBOB_OTHER_MARKET_PARTICIPANT_2",
        direction: 1,
        amountIn: 890_0000000n,
        amountOut: 1_000_0000000n,
        fee: 0n,
      });

      pos = storage.getUserPositions(PT_HOLDER).positions[0];
      // 10,000 PT marked at 0.89 = 8,900 SY ($8,900.00).
      // Unrealized PnL = 8,900 - 9,200 = -300 SY (-$300.00).
      expect(pos.unrealizedPnlUsd).toBe(-300.0);
      expect(pos.currentPositionValueUsd).toBe(8900.0);
    });

    it("4.2 Directional sensitivity for YT-only position matches d(Unrealized)/d(Price) = ytBal", () => {
      const now = 1794260000;
      // Buy 10,000 YT at 0.05 (Cost = 500 SY = $500.00)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: YT_HOLDER,
        receiver: YT_HOLDER,
        direction: 2,
        amountIn: 500_0000000n,
        amountOut: 10_000_0000000n,
        fee: 0n,
      });

      // Market PT drops to 0.92 -> YT price rises to 1.0 - 0.92 = 0.08 (+0.03 delta)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 3600,
        caller: "GBOB_OTHER_MARKET_PARTICIPANT_3",
        receiver: "GBOB_OTHER_MARKET_PARTICIPANT_3",
        direction: 1,
        amountIn: 920_0000000n,
        amountOut: 1_000_0000000n,
        fee: 0n,
      });

      const pos = storage.getUserPositions(YT_HOLDER).positions[0];
      // 10,000 YT marked at 0.08 = 800 SY ($800.00).
      // Unrealized PnL = 800 - 500 = +300 SY ($300.00).
      expect(pos.unrealizedPnlUsd).toBe(300.0);
      expect(pos.currentPositionValueUsd).toBe(800.0);
    });

    it("4.3 Fundamental Pendle Delta-Neutrality: Minted PY holder has ZERO unrealized sensitivity to PT price swings", () => {
      const now = 1794260000;
      // User mints 10,000 PY from 10,000 SY (holds 10,000 PT + 10,000 YT, cost basis 10,000 SY = $10,000.00)
      storage.recordMintPy({
        marketId: "usdc-90d",
        caller: PY_MINTER,
        receiver: PY_MINTER,
        syIn: 10_000_0000000n,
        pyOut: 10_000_0000000n,
        timestamp: now,
        spotPtPrice: 0.95,
      });

      // Price Swing 1: Deep discount PT = 0.85, YT = 0.15
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 3600,
        caller: "GBOB_OTHER_SWAP_1",
        receiver: "GBOB_OTHER_SWAP_1",
        direction: 1,
        amountIn: 850_0000000n,
        amountOut: 1_000_0000000n,
        fee: 0n,
      });

      let pos = storage.getUserPositions(PY_MINTER).positions[0];
      // Value = 10,000 * 0.85 + 10,000 * 0.15 = 8,500 + 1,500 = 10,000 SY.
      // Unrealized PnL MUST BE EXACTLY $0.00!
      expect(pos.unrealizedPnlUsd).toBe(0.0);
      expect(pos.currentPositionValueUsd).toBe(10000.0);

      // Price Swing 2: Parity approach PT = 0.98, YT = 0.02
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now + 7200,
        caller: "GBOB_OTHER_SWAP_2",
        receiver: "GBOB_OTHER_SWAP_2",
        direction: 1,
        amountIn: 980_0000000n,
        amountOut: 1_000_0000000n,
        fee: 0n,
      });

      pos = storage.getUserPositions(PY_MINTER).positions[0];
      // Value = 10,000 * 0.98 + 10,000 * 0.02 = 9,800 + 200 = 10,000 SY.
      // INVARIANT: Perfectly delta-neutral!
      expect(pos.unrealizedPnlUsd).toBe(0.0);
      expect(pos.currentPositionValueUsd).toBe(10000.0);
    });

    it("4.4 Post-maturity invariant: Market pool trades after maturity timestamp cannot alter fixed 1.0 PT valuation", () => {
      const maturityTs = MARKETS["usdc-90d"].maturity + 1000;
      dateSpy = spyOn(Date, "now").mockReturnValue(maturityTs * 1000);
      const POST_MATURITY_USER = "GPOST_MATURITY_INSENSITIVITY_TESTING_0000000000000";

      // User holds 5,000 PT (bought before maturity at 0.92, cost = 4,600 SY = $4,600.00)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: 1794260000,
        caller: POST_MATURITY_USER,
        receiver: POST_MATURITY_USER,
        direction: 1,
        amountIn: 4_600_0000000n,
        amountOut: 5_000_0000000n,
        fee: 0n,
      });

      // Even if a rogue snapshot exists with an arbitrary price like 0.70 post maturity:
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: maturityTs,
        caller: "GBOB_LATE_TRADER",
        receiver: "GBOB_LATE_TRADER",
        direction: 1,
        amountIn: 700_0000000n,
        amountOut: 1_000_0000000n,
        fee: 0n,
      });

      const pos = storage.getUserPositions(POST_MATURITY_USER).positions[0];
      // Since now >= market.maturity, spotPt MUST be pinned to 1.0 par.
      // Value = 5,000 PT * 1.0 = 5,000 SY ($5,000.00).
      // Unrealized PnL = 5,000 - 4,600 = +400 SY ($400.00).
      expect(pos.currentPositionValueUsd).toBe(5000.0);
      expect(pos.unrealizedPnlUsd).toBe(400.0);
    });
  });

  // ==========================================================================
  // Area 5: Multi-Market Portfolio Rollup & Multi-Asset Valuation (USDC + XLM)
  // ==========================================================================
  describe("Area 5: Multi-Asset Multi-Market Portfolio Rollup", () => {
    const MULTI_USER = "GMULTI_ASSET_TRADER_USDC_XLM_999999999999999999";

    it("5.1 Portfolio summary correctly aggregates USDC ($1.00) and XLM ($0.12) positions", () => {
      const now = 1794270000;

      // Position 1: usdc-90d: Buy 10,000 PT for 9,500 SY ($9,500 USD)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: MULTI_USER,
        receiver: MULTI_USER,
        direction: 1,
        amountIn: 9_500_0000000n,
        amountOut: 10_000_0000000n,
        fee: 0n,
      });

      // Position 2: xlm-90d: Buy 50,000 XLM PT for 48,000 XLM SY
      // Note: assetPriceUsd for XLM is 0.12!
      // Cost in XLM = 48,000 XLM.
      // Cost in USD = 48,000 * 0.12 = $5,760 USD.
      storage.recordSwap({
        marketId: "xlm-90d",
        timestamp: now + 10,
        caller: MULTI_USER,
        receiver: MULTI_USER,
        direction: 1,
        amountIn: 48_000_0000000n,
        amountOut: 50_000_0000000n,
        fee: 0n,
      });

      const res = storage.getUserPositions(MULTI_USER);
      expect(res.count).toBe(2);
      expect(res.positions.length).toBe(2);

      const usdcPos = res.positions.find((p) => p.marketId === "usdc-90d")!;
      const xlmPos = res.positions.find((p) => p.marketId === "xlm-90d")!;

      expect(usdcPos).toBeDefined();
      expect(xlmPos).toBeDefined();

      expect(usdcPos.costBasisUsd).toBe(9500.0);
      expect(xlmPos.costBasisUsd).toBe(5760.0); // 48000 * 0.12

      // Portfolio Summary Rollup:
      // Total Cost Basis = 9,500 + 5,760 = $15,260.00
      expect(res.summary.totalCostBasisUsd).toBe(15260.0);
      expect(res.summary.activePositionsCount).toBe(2);
      expect(res.summary.totalTransactionsCount).toBe(2);
      expect(res.summary.overallPortfolioApy).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Area 6: Randomized Fuzzing Stress Harness (50 Randomized DeFi Actions)
  // ==========================================================================
  describe("Area 6: Randomized Fuzzing & Stress Invariant Harness", () => {
    const FUZZ_USER = "GFUZZ_RANDOM_STRESS_WALLET_INVARIANTS_888888888888888";

    it("6.1 Executes 50 randomized trades, mints, and redeems while strictly upholding mathematical invariants", () => {
      let now = 1794270000;
      let totalClaimedExpected = 0n;

      // Seed with initial mint
      storage.recordMintPy({
        marketId: "usdc-90d",
        caller: FUZZ_USER,
        receiver: FUZZ_USER,
        syIn: 10_000_0000000n,
        pyOut: 10_000_0000000n,
        timestamp: now,
        spotPtPrice: 0.95,
      });

      for (let step = 1; step <= 50; step++) {
        now += 60;
        const action = step % 5;

        if (action === 0) {
          // Buy PT
          const amtPt = BigInt((Math.floor(Math.random() * 500) + 10) * 1e7);
          const amtSy = BigInt(Math.floor(Number(amtPt) * (0.90 + Math.random() * 0.08)));
          storage.recordSwap({
            marketId: "usdc-90d",
            timestamp: now,
            caller: FUZZ_USER,
            receiver: FUZZ_USER,
            direction: 1,
            amountIn: amtSy,
            amountOut: amtPt,
            fee: 0n,
          });
        } else if (action === 1) {
          // Sell partial PT if balance exists
          const currentPos = storage.getUserPositions(FUZZ_USER).positions[0];
          const ptBal = BigInt(currentPos.currentPtBalance);
          if (ptBal > 100_0000000n) {
            const sellPt = ptBal / 4n;
            const sellSy = BigInt(Math.floor(Number(sellPt) * (0.91 + Math.random() * 0.07)));
            storage.recordSwap({
              marketId: "usdc-90d",
              timestamp: now,
              caller: FUZZ_USER,
              receiver: FUZZ_USER,
              direction: 0,
              amountIn: sellPt,
              amountOut: sellSy,
              fee: 0n,
            });
          }
        } else if (action === 2) {
          // Harvest floating yield
          const yieldAmt = BigInt((Math.floor(Math.random() * 50) + 1) * 1e7);
          totalClaimedExpected += yieldAmt;
          storage.recordYieldClaimed({
            marketId: "usdc-90d",
            user: FUZZ_USER,
            yieldOut: yieldAmt,
            timestamp: now,
          });
        } else if (action === 3) {
          // Secondary Mint PY
          const syIn = BigInt((Math.floor(Math.random() * 1000) + 50) * 1e7);
          storage.recordMintPy({
            marketId: "usdc-90d",
            caller: FUZZ_USER,
            receiver: FUZZ_USER,
            syIn,
            pyOut: syIn,
            timestamp: now,
            spotPtPrice: 0.94,
          });
        } else if (action === 4) {
          // Market price shift trade from counterparty
          const randomPrice = 0.88 + Math.random() * 0.10;
          const otherPt = 1_000_0000000n;
          const otherSy = BigInt(Math.floor(Number(otherPt) * randomPrice));
          storage.recordSwap({
            marketId: "usdc-90d",
            timestamp: now,
            caller: "GCOUNTERPARTY_RANDOM_TRADER",
            receiver: "GCOUNTERPARTY_RANDOM_TRADER",
            direction: 1,
            amountIn: otherSy,
            amountOut: otherPt,
            fee: 0n,
          });
        }

        // CONTINUOUS INVARIANT AUDIT:
        const posRes = storage.getUserPositions(FUZZ_USER);
        expect(posRes.success).toBe(true);
        expect(posRes.positions.length).toBe(1);
        const p = posRes.positions[0];

        // 1. Balances and cost basis are non-negative
        expect(BigInt(p.currentPtBalance)).toBeGreaterThanOrEqual(0n);
        expect(BigInt(p.currentYtBalance)).toBeGreaterThanOrEqual(0n);
        expect(BigInt(p.costBasisStroops)).toBeGreaterThanOrEqual(0n);

        // 2. All numbers are finite and non-NaN
        expect(Number.isFinite(p.averageEntryApy)).toBe(true);
        expect(Number.isNaN(p.averageEntryApy)).toBe(false);
        expect(p.averageEntryApy).toBeGreaterThanOrEqual(0);

        expect(Number.isFinite(p.costBasisUsd)).toBe(true);
        expect(Number.isFinite(p.currentPositionValueUsd)).toBe(true);
        expect(Number.isFinite(p.realizedPnlUsd)).toBe(true);
        expect(Number.isFinite(p.unrealizedPnlUsd)).toBe(true);
        expect(Number.isFinite(p.netPnlUsd)).toBe(true);

        // 3. Net PnL is exact sum of Realized and Unrealized (within 0.01 due to unrounded sum vs rounded sum)
        expect(Math.abs((p.netPnlUsd || 0) - (p.realizedPnlUsd + p.unrealizedPnlUsd))).toBeLessThanOrEqual(0.01);

        // 4. Summary rollups are internally consistent
        const s = posRes.summary;
        expect(Math.abs((s.totalNetPnlUsd || 0) - (s.totalRealizedPnlUsd + s.totalUnrealizedPnlUsd))).toBeLessThanOrEqual(0.01);
        expect(s.totalCostBasisUsd).toBe(p.costBasisUsd);
        expect(s.totalCurrentValueUsd).toBe(p.currentPositionValueUsd);
      }

      // Check cumulative yield claimed
      const finalPos = storage.getUserPositions(FUZZ_USER).positions[0];
      expect(BigInt(finalPos.cumulativeClaimedYieldStroops)).toBe(totalClaimedExpected);
    });
  });
});
