// e2e_tests/tests/tier3_cross_feature.test.ts
// Tier 3: Cross-Feature Combinations (Pairwise and multi-stage lifecycle interactions)

import { describe, it, expect, beforeEach } from "bun:test";
import {
  WAD,
  calculateBumpTo,
  DEFAULT_BUMP_TO
} from "../src/math-oracle.ts";
import {
  MockBlendPool,
  SYBlendWrapper,
  YieldMarket,
  B_RATE_SCALE,
  ContractError
} from "../src/protocol-simulator.ts";

describe("Tier 3: Cross-Feature Combinations Test Suite", () => {
  let blendPool: MockBlendPool;
  let syWrapper: SYBlendWrapper;
  let market: YieldMarket;

  const t0 = 1_000_000_000n;
  const maturity180d = t0 + 180n * 86400n;

  beforeEach(() => {
    blendPool = new MockBlendPool("ADMIN", "USDC_ADDRESS", B_RATE_SCALE);
    syWrapper = new SYBlendWrapper("ADMIN", "USDC_ADDRESS", blendPool);
    market = new YieldMarket("ADMIN", syWrapper, maturity180d, 20n * WAD, (105n * WAD) / 100n, t0);

    blendPool.underlyingBalances.set("Alice", 2_000_000n * WAD);
    blendPool.underlyingBalances.set("Bob", 2_000_000n * WAD);
    blendPool.underlyingBalances.set("Charlie", 2_000_000n * WAD);
    blendPool.underlyingBalances.set("Dave", 2_000_000n * WAD);

    // Seed AMM with dual-sided liquidity from Charlie
    syWrapper.deposit("Charlie", "Charlie", 100_000n * WAD);
    market.mint_py("Charlie", "Charlie", 50_000n * WAD);
    market.add_liquidity("Charlie", "Charlie", 40_000n * WAD, 40_000n * WAD, 1n);
  });

  // ===========================================================================
  // Combination 3.1: Mint PY -> Swap PT for SY
  // ===========================================================================
  it("3.1 should mint PY and immediately swap PT for SY on AMM, maintaining vault conservation", () => {
    syWrapper.deposit("Alice", "Alice", 10_000n * WAD);
    const [ptMinted, ytMinted] = market.mint_py("Alice", "Alice", 10_000n * WAD);
    expect(ptMinted).toBe(10_000n * WAD);
    expect(ytMinted).toBe(10_000n * WAD);

    // Alice sells 5,000 PT for SY
    const [syReceived, fee] = market.swap_exact_pt_for_sy("Alice", "Alice", 5_000n * WAD, 1n);
    expect(syReceived).toBeGreaterThan(0n);
    expect(fee).toBeGreaterThan(0n);

    // Alice now holds 5,000 PT, 10,000 YT, and syReceived
    expect(market.ptToken.balanceOf("Alice")).toBe(5_000n * WAD);
    expect(market.ytToken.balanceOf("Alice")).toBe(10_000n * WAD);
    expect(syWrapper.balanceOf("Alice")).toBe(syReceived);

    // Vault still holds 10,000 SY backing Alice's mint + 50,000 from Charlie
    expect(syWrapper.balanceOf("YIELD_MARKET_VAULT")).toBe(60_000n * WAD);
  });

  // ===========================================================================
  // Combination 3.2: Mint PY -> Flash Sell YT for SY
  // ===========================================================================
  it("3.2 should mint PY and flash sell YT for SY, retaining full principal PT", () => {
    syWrapper.deposit("Bob", "Bob", 20_000n * WAD);
    market.mint_py("Bob", "Bob", 20_000n * WAD);

    // Bob flash sells 10,000 YT for SY
    const [syProfit, fee] = market.swap_exact_yt_for_sy("Bob", "Bob", 10_000n * WAD, 1n);
    expect(syProfit).toBeGreaterThan(0n);
    expect(fee).toBeGreaterThan(0n);

    expect(market.ptToken.balanceOf("Bob")).toBe(20_000n * WAD);
    expect(market.ytToken.balanceOf("Bob")).toBe(10_000n * WAD);
    expect(syWrapper.balanceOf("Bob")).toBe(syProfit);
  });

  // ===========================================================================
  // Combination 3.3: Add Liquidity -> Execute Swaps -> Remove Liquidity with Fees
  // ===========================================================================
  it("3.3 should add liquidity, execute trading volume generating fees, and remove liquidity", () => {
    // Dave adds liquidity
    syWrapper.deposit("Dave", "Dave", 50_000n * WAD);
    market.mint_py("Dave", "Dave", 25_000n * WAD);
    const lpMinted = market.add_liquidity("Dave", "Dave", 20_000n * WAD, 20_000n * WAD, 1n);

    // Alice executes swaps generating fees
    syWrapper.deposit("Alice", "Alice", 10_000n * WAD);
    market.mint_py("Alice", "Alice", 5_000n * WAD);
    market.swap_exact_pt_for_sy("Alice", "Alice", 2_000n * WAD, 1n);
    market.swap_exact_sy_for_pt("Alice", "Alice", 2_000n * WAD, 1n);

    // Dave removes liquidity
    const [ptOut, syOut] = market.remove_liquidity("Dave", "Dave", lpMinted, 1n, 1n);
    expect(ptOut).toBeGreaterThan(0n);
    expect(syOut).toBeGreaterThan(0n);
    expect(market.lpBalances.get("Dave")).toBe(0n);
  });

  // ===========================================================================
  // Combination 3.4: Complete Fixed-Income Full Lifecycle
  // ===========================================================================
  it("3.4 should execute complete fixed-income lifecycle: deposit -> accrual -> mid-claim -> settle -> redeem", () => {
    // 1. Alice deposits 50,000 USDC and mints PY
    syWrapper.deposit("Alice", "Alice", 50_000n * WAD);
    market.mint_py("Alice", "Alice", 50_000n * WAD);

    // 2. Advance time 60 days, rate jumps 1.00 -> 1.08 (+8%)
    market.currentTimestamp = t0 + 60n * 86400n;
    blendPool.setBRate(1_080_000_000n);
    syWrapper.balances.set("YIELD_MARKET_VAULT", syWrapper.balances.get("YIELD_MARKET_VAULT")! + 4_000n * WAD);

    // Mid-flight yield claim: 50,000 * 0.08 = 4,000 WAD
    const midClaim = market.claim_yield("Alice", "Alice");
    expect(midClaim).toBe(4_000n * WAD);

    // 3. Advance to maturity (180 days), rate increases to 1.15
    market.currentTimestamp = maturity180d;
    blendPool.setBRate(1_150_000_000n);
    syWrapper.balances.set("YIELD_MARKET_VAULT", syWrapper.balances.get("YIELD_MARKET_VAULT")! + 3_500n * WAD);

    // 4. Idempotent maturity settlement
    const [settledRate, mutated] = market.settle_maturity();
    expect(settledRate).toBe(1_150_000_000n);
    expect(mutated).toBe(true);

    // 5. Final yield claim: (1.15 - 1.08) / 1.08 on 50,000 -> 3,240.74 WAD
    const finalClaim = market.claim_yield("Alice", "Alice");
    expect(finalClaim).toBeGreaterThan(0n);

    // 6. Redeem 50,000 PT 1:1 post-maturity
    const ptRedeemed = market.redeem_pt_post_maturity("Alice", "Alice", 50_000n * WAD);
    expect(ptRedeemed).toBe(50_000n * WAD);
    expect(market.ptToken.balanceOf("Alice")).toBe(0n);
  });

  // ===========================================================================
  // Combination 3.5: Multi-User Concurrent Swaps & Arbitrage
  // ===========================================================================
  it("3.5 should execute multi-user interleaved trading with dynamic price response", () => {
    // Alice mints and sells PT (pressuring PT price down, increasing PT in pool)
    syWrapper.deposit("Alice", "Alice", 20_000n * WAD);
    market.mint_py("Alice", "Alice", 10_000n * WAD);
    const [syAlice] = market.swap_exact_pt_for_sy("Alice", "Alice", 3_000n * WAD, 1n);

    // Bob buys discounted PT using SY
    syWrapper.deposit("Bob", "Bob", 10_000n * WAD);
    const [ptBob] = market.swap_exact_sy_for_pt("Bob", "Bob", 3_000n * WAD, 1n);

    expect(syAlice).toBeGreaterThan(0n);
    expect(ptBob).toBeGreaterThan(0n);
    expect(market.ptToken.balanceOf("Bob")).toBe(ptBob);
  });

  // ===========================================================================
  // Combination 3.6: Reentrancy Teardown Under Failure Cascades
  // ===========================================================================
  it("3.6 should reject reentrancy attempt and cleanly allow subsequent transaction in same ledger", () => {
    // Nested reentrancy attempt fails
    let reentrancyCaught = false;
    try {
      market.withNonReentrant(() => {
        market.mint_py("Alice", "Alice", 1_000n * WAD);
      });
    } catch (err: any) {
      if (err.message.includes(ContractError.ReentrancyLocked)) {
        reentrancyCaught = true;
      }
    }
    expect(reentrancyCaught).toBe(true);

    // Guard MUST be cleared so immediate subsequent call in same ledger succeeds!
    expect(market.temporaryStorage.has("FlashLoanGuard")).toBe(false);
    syWrapper.deposit("Alice", "Alice", 2_000n * WAD);
    const [ptMinted, ytMinted] = market.mint_py("Alice", "Alice", 2_000n * WAD);
    expect(ptMinted).toBe(2_000n * WAD);
    expect(ytMinted).toBe(2_000n * WAD);
  });

  // ===========================================================================
  // Combination 3.7: High-Frequency Swaps with Dynamic TTL Bumping
  // ===========================================================================
  it("3.7 should maintain dynamic TTL bumping across 10 sequential trades", () => {
    syWrapper.deposit("Alice", "Alice", 50_000n * WAD);
    market.mint_py("Alice", "Alice", 25_000n * WAD);

    for (let i = 0; i < 5; i++) {
      market.swap_exact_pt_for_sy("Alice", "Alice", 500n * WAD, 1n);
      market.swap_exact_sy_for_pt("Alice", "Alice", 500n * WAD, 1n);
      expect(market.instanceTtl).toBeGreaterThan(0);
    }
    // Instance TTL refreshed
    expect(market.instanceTtl).toBe(calculateBumpTo(market.currentTimestamp, maturity180d));
  });

  // ===========================================================================
  // Combination 3.8: Partial Early Unwind Followed by Post-Maturity Redemption
  // ===========================================================================
  it("3.8 should partially early-unwind and redeem remainder at maturity", () => {
    syWrapper.deposit("Alice", "Alice", 30_000n * WAD);
    market.mint_py("Alice", "Alice", 30_000n * WAD);

    // Day 30: early unwind 10,000
    market.currentTimestamp = t0 + 30n * 86400n;
    const unwound = market.redeem_py("Alice", "Alice", 10_000n * WAD);
    expect(unwound).toBe(10_000n * WAD);
    expect(market.ptToken.balanceOf("Alice")).toBe(20_000n * WAD);

    // Day 180 (maturity): redeem remaining 20,000 PT
    market.currentTimestamp = maturity180d;
    const redeemed = market.redeem_pt_post_maturity("Alice", "Alice", 20_000n * WAD);
    expect(redeemed).toBe(20_000n * WAD);
    expect(market.ptToken.balanceOf("Alice")).toBe(0n);
  });

  // ===========================================================================
  // Combination 3.9: Yield Claiming Across Jump and Maturity Boundaries
  // ===========================================================================
  it("3.9 should claim yield just before maturity and clamp post-maturity accrual", () => {
    syWrapper.deposit("Alice", "Alice", 40_000n * WAD);
    market.mint_py("Alice", "Alice", 40_000n * WAD);
    syWrapper.balances.set("YIELD_MARKET_VAULT", syWrapper.balances.get("YIELD_MARKET_VAULT")! + 20_000n * WAD);

    // t = maturity - 1 day, rate = 1.10
    market.currentTimestamp = maturity180d - 86400n;
    blendPool.setBRate(1_100_000_000n);
    const claimPreMat = market.claim_yield("Alice", "Alice");
    expect(claimPreMat).toBe(4_000n * WAD); // 40,000 * 0.10

    // t = maturity, rate = 1.12
    market.currentTimestamp = maturity180d;
    blendPool.setBRate(1_120_000_000n);
    const claimAtMat = market.claim_yield("Alice", "Alice");
    expect(claimAtMat).toBeGreaterThan(0n);

    // t = maturity + 10 days, rate = 1.30
    market.currentTimestamp = maturity180d + 10n * 86400n;
    blendPool.setBRate(1_300_000_000n);
    const claimPostMat = market.claim_yield("Alice", "Alice");
    expect(claimPostMat).toBe(0n); // Accrual halted post maturity!
  });

  // ===========================================================================
  // Combination 3.10: Zero-Capital Flash Buy Followed by Immediate Flash Sale
  // ===========================================================================
  it("3.10 should flash buy YT with SY and immediately flash sell YT back, deducting fees", () => {
    syWrapper.deposit("Bob", "Bob", 2_000n * WAD);

    // Flash buy YT with 1,000 SY
    const [ytBought, sySpent] = market.swap_exact_sy_for_yt("Bob", "Bob", 1_000n * WAD, 1n);
    expect(ytBought).toBeGreaterThan(0n);
    expect(sySpent).toBe(1_000n * WAD);
    expect(market.ytToken.balanceOf("Bob")).toBe(ytBought);

    // Immediately flash sell all bought YT
    const [syRecovered, fee] = market.swap_exact_yt_for_sy("Bob", "Bob", ytBought, 1n);
    expect(syRecovered).toBeGreaterThan(0n);
    expect(fee).toBeGreaterThan(0n);
    expect(market.ytToken.balanceOf("Bob")).toBe(0n);

    // Net SY after round-trip: minor fee loss, no orphan positions
    expect(syRecovered).toBeLessThanOrEqual(1_000n * WAD);
  });
});
