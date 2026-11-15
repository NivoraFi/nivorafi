import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EventStorage, type UserPositionsResponse } from "../indexer/index";

describe("Adversarial Critic Suite: Milestone 2 User Position & PnL Accounting", () => {
  const testDb = join(import.meta.dir, "adversarial_m2_critic.db");
  let storage: EventStorage;

  const cleanup = () => {
    try {
      if (existsSync(testDb)) unlinkSync(testDb);
      if (existsSync(`${testDb}-wal`)) unlinkSync(`${testDb}-wal`);
      if (existsSync(`${testDb}-shm`)) unlinkSync(`${testDb}-shm`);
    } catch {
      // Ignore
    }
  };

  beforeEach(() => {
    cleanup();
    storage = new EventStorage(testDb);
  });

  afterEach(() => {
    storage.close();
    cleanup();
  });

  // --------------------------------------------------------------------------
  // 1. Greenfield & Zero-State Invariants
  // --------------------------------------------------------------------------
  it("AC-1: Greenfield query returns HTTP 200 zero-state with zeroed numeric metrics", () => {
    const randomWallet = "GADV" + Math.random().toString(36).substring(2, 12).toUpperCase().padEnd(52, "0");
    const res = storage.getUserPositions(randomWallet);

    expect(res.success).toBe(true);
    expect(res.user).toBe(randomWallet);
    expect(res.count).toBe(0);
    expect(res.positions).toEqual([]);

    expect(res.summary).toEqual({
      userAddress: randomWallet,
      totalCostBasisUsd: 0,
      totalCurrentValueUsd: 0,
      totalRealizedPnlUsd: 0,
      totalUnrealizedPnlUsd: 0,
      totalNetPnlUsd: 0,
      totalClaimedYieldUsd: 0,
      overallPortfolioApy: 0,
      activePositionsCount: 0,
      totalTransactionsCount: 0,
    });
  });

  it("AC-2: Missing user address throws an explicit error for HTTP 400 validation", () => {
    expect(() => storage.getUserPositions("")).toThrow("Missing required query parameter: user");
  });

  // --------------------------------------------------------------------------
  // 2. Mathematical Integrity: Weighted Average Entry APY & Invariance
  // --------------------------------------------------------------------------
  it("AC-3: Weighted average entry APY weights exactly by token quantity and remains invariant on partial sell", () => {
    const user = "GTEST_WEIGHTED_APY_USER_001";
    const now = 1794200000;

    // Trade 1: Buy 100 PT for 95 SY
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now,
      caller: user,
      receiver: user,
      direction: 1,
      amountIn: 95_0000000n,
      amountOut: 100_0000000n,
      fee: 0n,
    });

    let res = storage.getUserPositions(user);
    const apy1 = res.positions[0].averageEntryApy;
    expect(apy1).toBeGreaterThan(0);

    // Trade 2: Buy 100 PT for 90 SY (deeper discount -> higher APY)
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now + 60,
      caller: user,
      receiver: user,
      direction: 1,
      amountIn: 90_0000000n,
      amountOut: 100_0000000n,
      fee: 0n,
    });

    res = storage.getUserPositions(user);
    const apy2 = res.positions[0].averageEntryApy;
    expect(res.positions[0].currentPtBalance).toBe("2000000000");
    expect(apy2).toBeGreaterThan(apy1);

    // Trade 3: Partial sell 50 PT (25% inventory)
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now + 120,
      caller: user,
      receiver: user,
      direction: 0,
      amountIn: 50_0000000n,
      amountOut: 47_0000000n,
      fee: 0n,
    });

    res = storage.getUserPositions(user);
    // CRITICAL: Entry APY of remaining tokens must not be distorted by selling
    expect(res.positions[0].averageEntryApy).toBe(apy2);
    expect(res.positions[0].currentPtBalance).toBe("1500000000");
  });

  // --------------------------------------------------------------------------
  // 3. Mathematical Integrity: Realized PnL Symmetry (Gains vs Losses)
  // --------------------------------------------------------------------------
  it("AC-4: Realized PnL computes signed deltas correctly across profitable and loss-making sales", () => {
    const user = "GTEST_PNL_SYMMETRY_USER_002";
    const now = 1794200000;

    // Buy 200 PT for 180 SY (unit cost = 0.90 SY)
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now,
      caller: user,
      receiver: user,
      direction: 1,
      amountIn: 180_0000000n,
      amountOut: 200_0000000n,
      fee: 0n,
    });

    // Sell 100 PT at 0.95 SY -> cost = 90 SY, revenue = 95 SY -> profit = +5 SY (+50000000 stroops)
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now + 100,
      caller: user,
      receiver: user,
      direction: 0,
      amountIn: 100_0000000n,
      amountOut: 95_0000000n,
      fee: 0n,
    });

    let res = storage.getUserPositions(user);
    expect(res.positions[0].realizedPnlStroops).toBe("50000000");
    expect(res.positions[0].realizedPnlUsd).toBe(5.0);

    // Sell remaining 100 PT at 0.85 SY -> cost = 90 SY, revenue = 85 SY -> loss = -5 SY (-50000000 stroops)
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now + 200,
      caller: user,
      receiver: user,
      direction: 0,
      amountIn: 100_0000000n,
      amountOut: 85_0000000n,
      fee: 0n,
    });

    res = storage.getUserPositions(user);
    // Net realized PnL = +5 - 5 = 0
    expect(res.positions[0].realizedPnlStroops).toBe("0");
    expect(res.positions[0].realizedPnlUsd).toBe(0.0);
    expect(res.positions[0].currentPtBalance).toBe("0");
    expect(res.positions[0].costBasisStroops).toBe("0");
  });

  // --------------------------------------------------------------------------
  // 4. Conservation of Cost Basis on mint_py
  // --------------------------------------------------------------------------
  it("AC-5: mint_py strictly conserves cost basis between PT and YT splits", () => {
    const user = "GTEST_MINT_CONSERVATION_USER_003";
    const depositSy = 500_0000000n; // 500 SY
    const spotPt = 0.96;

    storage.recordMintPy({
      marketId: "usdc-90d",
      caller: user,
      receiver: user,
      syIn: depositSy,
      pyOut: depositSy,
      timestamp: 1794200000,
      spotPtPrice: spotPt,
    });

    const res = storage.getUserPositions(user);
    const pos = res.positions[0];

    expect(pos.currentPtBalance).toBe(depositSy.toString());
    expect(pos.currentYtBalance).toBe(depositSy.toString());

    // Cost basis in stroops must strictly equal total deposit
    expect(pos.costBasisStroops).toBe(depositSy.toString());
    expect(pos.costBasisUsd).toBe(500.0);
  });

  // --------------------------------------------------------------------------
  // 5. Yield Claiming & Post-Maturity Redemption PnL
  // --------------------------------------------------------------------------
  it("AC-6: yield_claimed and redeem_pt increment realized PnL and cumulative yield", () => {
    const user = "GTEST_YIELD_REDEEM_USER_004";
    const now = 1794200000;

    // 1. Buy 100 PT at discount for 92 SY
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now,
      caller: user,
      receiver: user,
      direction: 1,
      amountIn: 92_0000000n,
      amountOut: 100_0000000n,
      fee: 0n,
    });

    // 2. Harvest 10 SY yield
    storage.recordYieldClaimed({
      marketId: "usdc-90d",
      user,
      yieldOut: 10_0000000n,
      timestamp: now + 50,
    });

    let res = storage.getUserPositions(user);
    expect(res.positions[0].cumulativeClaimedYieldUsd).toBe(10.0);
    expect(res.positions[0].realizedPnlUsd).toBe(10.0);

    // 3. Post maturity: redeem 100 PT for 100 SY (profit = 8 SY)
    storage.recordRedeemPt({
      marketId: "usdc-90d",
      caller: user,
      ptBurned: 100_0000000n,
      payout: 100_0000000n,
      timestamp: now + 100,
    });

    res = storage.getUserPositions(user);
    // Total realized PnL = 10 (yield) + 8 (discount settlement) = 18 USD
    expect(res.positions[0].realizedPnlUsd).toBe(18.0);
    expect(res.positions[0].currentPtBalance).toBe("0");
    expect(res.positions[0].cumulativeClaimedYieldUsd).toBe(10.0);
  });

  // --------------------------------------------------------------------------
  // 6. Cross-Currency Portfolio Aggregation (USDC $1.0 vs XLM $0.12)
  // --------------------------------------------------------------------------
  it("AC-7: Portfolio summary correctly values cross-currency positions with different asset prices", () => {
    const user = "GTEST_MULTI_CURRENCY_USER_005";
    const now = 1794200000;

    // Position 1: 100 USDC in usdc-90d ($1.00 per USDC)
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now,
      caller: user,
      receiver: user,
      direction: 1,
      amountIn: 100_0000000n,
      amountOut: 100_0000000n,
      fee: 0n,
    });

    // Position 2: 1,000 XLM in xlm-90d ($0.12 per XLM)
    storage.recordSwap({
      marketId: "xlm-90d",
      timestamp: now,
      caller: user,
      receiver: user,
      direction: 1,
      amountIn: 1000_0000000n,
      amountOut: 1000_0000000n,
      fee: 0n,
    });

    const res = storage.getUserPositions(user);
    expect(res.count).toBe(2);

    const usdcPos = res.positions.find((p) => p.assetCode === "USDC")!;
    const xlmPos = res.positions.find((p) => p.assetCode === "XLM")!;

    expect(usdcPos.costBasisUsd).toBe(100.0);
    expect(xlmPos.costBasisUsd).toBe(120.0); // 1,000 * 0.12 = 120 USD

    // Summary totalCostBasisUsd = 100 + 120 = 220 USD
    expect(res.summary.totalCostBasisUsd).toBe(220.0);
    expect(res.summary.activePositionsCount).toBe(2);
  });

  // --------------------------------------------------------------------------
  // 7. Stress Testing: Rapid Trade Sequence & Dust Cleaning
  // --------------------------------------------------------------------------
  it("AC-8: Handles high-volume trade loops and dust cleanup (<10 stroops) gracefully", () => {
    const user = "GTEST_STRESS_LOOP_USER_006";
    let now = 1794200000;

    // 50 iterations of buy, yield, partial sell
    for (let i = 0; i < 50; i++) {
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now++,
        caller: user,
        receiver: user,
        direction: 1,
        amountIn: 10_0000000n,
        amountOut: 10_5000000n,
        fee: 0n,
      });

      storage.recordYieldClaimed({
        marketId: "usdc-90d",
        user,
        yieldOut: 1000000n,
        timestamp: now++,
      });

      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now++,
        caller: user,
        receiver: user,
        direction: 0,
        amountIn: 5_0000000n,
        amountOut: 4_8000000n,
        fee: 0n,
      });
    }

    const res = storage.getUserPositions(user);
    expect(res.count).toBe(1);
    expect(res.positions[0].totalTradesCount).toBe(150); // 50 * 3
    expect(res.summary.totalTransactionsCount).toBe(150);
    expect(isFinite(res.summary.overallPortfolioApy)).toBe(true);
    expect(isNaN(res.summary.overallPortfolioApy)).toBe(false);

    // Dust test: sell almost all remaining, leaving 4 stroops
    const remainingPt = BigInt(res.positions[0].currentPtBalance);
    storage.recordSwap({
      marketId: "usdc-90d",
      timestamp: now++,
      caller: user,
      receiver: user,
      direction: 0,
      amountIn: remainingPt - 4n,
      amountOut: 1000n,
      fee: 0n,
    });

    const dustRes = storage.getUserPositions(user);
    // Dust auto-cleaned to 0
    expect(dustRes.positions[0].currentPtBalance).toBe("0");
    expect(dustRes.positions[0].costBasisStroops).toBe("0");
  });
});
