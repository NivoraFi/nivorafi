// e2e_tests/tests/tier1_feature_coverage.test.ts
// Tier 1: Feature Coverage (>=5 tests per key protocol feature)

import { describe, it, expect, beforeEach } from "bun:test";
import {
  WAD,
  calculateBumpTo,
  calculateBumpThreshold,
  calculateHaircut,
  DEFAULT_BUMP_TO,
  MAX_NETWORK_TTL,
  MIN_BUMP_THRESHOLD
} from "../src/math-oracle.ts";
import {
  MockBlendPool,
  SYBlendWrapper,
  YieldMarket,
  B_RATE_SCALE,
  DEAD_ADDRESS,
  ContractError
} from "../src/protocol-simulator.ts";

describe("Tier 1: Feature Coverage Test Suite", () => {
  let blendPool: MockBlendPool;
  let syWrapper: SYBlendWrapper;
  let market: YieldMarket;

  const t0 = 1_000_000_000n;
  const maturity180d = t0 + 180n * 86400n; // 180 days to maturity

  beforeEach(() => {
    blendPool = new MockBlendPool("ADMIN", "USDC_ADDRESS", B_RATE_SCALE);
    syWrapper = new SYBlendWrapper("ADMIN", "USDC_ADDRESS", blendPool);
    market = new YieldMarket("ADMIN", syWrapper, maturity180d, 20n * WAD, (105n * WAD) / 100n, t0);

    // Setup initial underlying balances for users
    blendPool.underlyingBalances.set("Alice", 1_000_000n * WAD);
    blendPool.underlyingBalances.set("Bob", 1_000_000n * WAD);
    blendPool.underlyingBalances.set("Charlie", 1_000_000n * WAD);
  });

  // ===========================================================================
  // Feature 1: Deposit & Mint PY (>=5 tests)
  // ===========================================================================
  describe("Feature 1: Deposit & Mint PY", () => {
    it("1.1 should atomically mint 1 PT and 1 YT per 1 SY deposited (1:1 ratio)", () => {
      syWrapper.deposit("Alice", "Alice", 10_000n * WAD);
      expect(syWrapper.balanceOf("Alice")).toBe(10_000n * WAD);

      const [ptMinted, ytMinted] = market.mint_py("Alice", "Alice", 10_000n * WAD);
      expect(ptMinted).toBe(10_000n * WAD);
      expect(ytMinted).toBe(10_000n * WAD);

      expect(market.ptToken.balanceOf("Alice")).toBe(10_000n * WAD);
      expect(market.ytToken.balanceOf("Alice")).toBe(10_000n * WAD);
      expect(syWrapper.balanceOf("Alice")).toBe(0n);
      expect(syWrapper.balanceOf("YIELD_MARKET_VAULT")).toBe(10_000n * WAD);
    });

    it("1.2 should support multi-user independent deposits with segregated balances", () => {
      syWrapper.deposit("Alice", "Alice", 5_000n * WAD);
      syWrapper.deposit("Bob", "Bob", 3_000n * WAD);

      market.mint_py("Alice", "Alice", 5_000n * WAD);
      market.mint_py("Bob", "Bob", 3_000n * WAD);

      expect(market.ptToken.balanceOf("Alice")).toBe(5_000n * WAD);
      expect(market.ytToken.balanceOf("Alice")).toBe(5_000n * WAD);
      expect(market.ptToken.balanceOf("Bob")).toBe(3_000n * WAD);
      expect(market.ytToken.balanceOf("Bob")).toBe(3_000n * WAD);
      expect(market.ptToken.totalSupply).toBe(8_000n * WAD);
      expect(market.ytToken.totalSupply).toBe(8_000n * WAD);
    });

    it("1.3 should support receiver redirection where caller funds mint for another account", () => {
      syWrapper.deposit("Alice", "Alice", 2_000n * WAD);
      market.mint_py("Alice", "Bob", 2_000n * WAD);

      expect(market.ptToken.balanceOf("Alice")).toBe(0n);
      expect(market.ytToken.balanceOf("Alice")).toBe(0n);
      expect(market.ptToken.balanceOf("Bob")).toBe(2_000n * WAD);
      expect(market.ytToken.balanceOf("Bob")).toBe(2_000n * WAD);
    });

    it("1.4 should initialize YT user checkpoint index to current Blend exchange rate", () => {
      blendPool.setBRate(1_050_000_000n); // 1.05 index
      syWrapper.deposit("Alice", "Alice", 1_000n * WAD);
      market.mint_py("Alice", "Alice", 1_000n * WAD);

      const userState = market.ytToken.userStates.get("Alice");
      expect(userState).toBeDefined();
      expect(userState!.lastIndex).toBe(1_050_000_000n);
      expect(userState!.unclaimedYield).toBe(0n);
    });

    it("1.5 should accurately wrap underlying bToken supply into SY shares", () => {
      const depositAmount = 25_000n * WAD;
      const sharesMinted = syWrapper.deposit("Alice", "Alice", depositAmount);
      expect(sharesMinted).toBe(depositAmount);
      expect(blendPool.bTokenBalances.get("SY_WRAPPER_VAULT")).toBe(depositAmount);
      expect(syWrapper.exchange_rate()).toBe(B_RATE_SCALE);
    });
  });

  // ===========================================================================
  // Feature 2: Early Unwind PY (>=5 tests)
  // ===========================================================================
  describe("Feature 2: Early Unwind PY (redeem_py)", () => {
    beforeEach(() => {
      syWrapper.deposit("Alice", "Alice", 20_000n * WAD);
      market.mint_py("Alice", "Alice", 20_000n * WAD);
    });

    it("2.1 should burn 1 PT and 1 YT simultaneously and return 1 SY before maturity", () => {
      const returnedSy = market.redeem_py("Alice", "Alice", 5_000n * WAD);
      expect(returnedSy).toBe(5_000n * WAD);

      expect(market.ptToken.balanceOf("Alice")).toBe(15_000n * WAD);
      expect(market.ytToken.balanceOf("Alice")).toBe(15_000n * WAD);
      expect(syWrapper.balanceOf("Alice")).toBe(5_000n * WAD);
      expect(syWrapper.balanceOf("YIELD_MARKET_VAULT")).toBe(15_000n * WAD);
    });

    it("2.2 should support partial early unwind leaving remaining positions active", () => {
      market.redeem_py("Alice", "Alice", 7_500n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(12_500n * WAD);
      expect(market.ytToken.balanceOf("Alice")).toBe(12_500n * WAD);

      // Subsequent partial unwind
      market.redeem_py("Alice", "Alice", 2_500n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(10_000n * WAD);
      expect(market.ytToken.balanceOf("Alice")).toBe(10_000n * WAD);
    });

    it("2.3 should support receiver redirection during early unwind", () => {
      market.redeem_py("Alice", "Bob", 4_000n * WAD);
      expect(syWrapper.balanceOf("Alice")).toBe(0n);
      expect(syWrapper.balanceOf("Bob")).toBe(4_000n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(16_000n * WAD);
    });

    it("2.4 should accrue streaming yield for user up to the moment of partial unwind", () => {
      // Advance rate from 1.00 to 1.10
      blendPool.setBRate(1_100_000_000n);
      market.redeem_py("Alice", "Alice", 10_000n * WAD);

      const state = market.ytToken.userStates.get("Alice");
      expect(state).toBeDefined();
      // Accrued yield on 20,000 YT before burn: 20,000 * 0.10 = 2,000 WAD
      expect(state!.unclaimedYield).toBe(2_000n * WAD);
      expect(state!.ytBalance).toBe(10_000n * WAD);
      expect(state!.lastIndex).toBe(1_100_000_000n);
    });

    it("2.5 should completely unwind entire position when amount equals balance", () => {
      market.redeem_py("Alice", "Alice", 20_000n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(0n);
      expect(market.ytToken.balanceOf("Alice")).toBe(0n);
      expect(syWrapper.balanceOf("Alice")).toBe(20_000n * WAD);
      expect(market.ptToken.totalSupply).toBe(0n);
      expect(market.ytToken.totalSupply).toBe(0n);
    });
  });

  // ===========================================================================
  // Feature 3: Maturity Redemption & Haircut Protection (>=5 tests)
  // ===========================================================================
  describe("Feature 3: Maturity Redemption & Haircuts", () => {
    beforeEach(() => {
      syWrapper.deposit("Alice", "Alice", 50_000n * WAD);
      market.mint_py("Alice", "Alice", 50_000n * WAD);
    });

    it("3.1 should redeem PT 1:1 for underlying assets at maturity timestamp t = T", () => {
      market.currentTimestamp = maturity180d; // Reached maturity
      const redeemed = market.redeem_pt_post_maturity("Alice", "Alice", 50_000n * WAD);
      expect(redeemed).toBe(50_000n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(0n);
      expect(syWrapper.balanceOf("Alice")).toBe(50_000n * WAD);
    });

    it("3.2 should redeem PT 1:1 for underlying assets long after maturity t > T", () => {
      market.currentTimestamp = maturity180d + 30n * 86400n; // 30 days post-maturity
      const redeemed = market.redeem_pt_post_maturity("Alice", "Alice", 20_000n * WAD);
      expect(redeemed).toBe(20_000n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(30_000n * WAD);
    });

    it("3.3 should support partial PT redemption post-maturity", () => {
      market.currentTimestamp = maturity180d;
      const part1 = market.redeem_pt_post_maturity("Alice", "Alice", 15_000n * WAD);
      expect(part1).toBe(15_000n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(35_000n * WAD);

      const part2 = market.redeem_pt_post_maturity("Alice", "Alice", 35_000n * WAD);
      expect(part2).toBe(35_000n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(0n);
    });

    it("3.4 should enforce Solvency Haircut factor H = min(1.0, B_vault / S_pt) under bad debt", () => {
      market.currentTimestamp = maturity180d;
      // Simulate Blend bad debt: Vault holds only 45,000 SY for 50,000 PT (10% bad debt, H = 0.90)
      syWrapper.balances.set("YIELD_MARKET_VAULT", 45_000n * WAD);

      const netReceived = market.redeem_pt_post_maturity("Alice", "Alice", 50_000n * WAD);
      // Net payout: 50,000 * 0.90 = 45,000 WAD
      expect(netReceived).toBe(45_000n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(0n);
      expect(syWrapper.balanceOf("Alice")).toBe(45_000n * WAD);
    });

    it("3.5 should support Track A emergency raw bToken exit under 100% Blend pool utilization", () => {
      market.currentTimestamp = maturity180d;
      // Set utilization to 100% and pool cash to 0
      blendPool.setUtilization(1.0);
      blendPool.setBRate(1_250_000_000n); // b_rate = 1.25

      // Synchronous cash withdrawal would revert, so user calls redeem_pt_to_btoken
      const bTokensOut = market.redeem_pt_to_btoken("Alice", "Alice", 25_000n * WAD);
      // bTokens = (25,000 * 10^9) / 1.25*10^9 = 20,000 bTokens
      expect(bTokensOut).toBe(20_000n * WAD);
      expect(market.ptToken.balanceOf("Alice")).toBe(25_000n * WAD);
      expect(blendPool.bTokenBalances.get("Alice")).toBe(20_000n * WAD);
    });
  });

  // ===========================================================================
  // Feature 4: Variable Yield Claiming (>=5 tests)
  // ===========================================================================
  describe("Feature 4: Variable Yield Claiming", () => {
    beforeEach(() => {
      syWrapper.deposit("Alice", "Alice", 100_000n * WAD);
      market.mint_py("Alice", "Alice", 100_000n * WAD);
    });

    it("4.1 should return zero yield if Blend exchange index b_rate has not increased", () => {
      const claimed = market.claim_yield("Alice", "Alice");
      expect(claimed).toBe(0n);
      expect(syWrapper.balanceOf("Alice")).toBe(0n);
    });

    it("4.2 should harvest accrued streaming yield when Blend index increases", () => {
      // 10% rate increase: 1.00 -> 1.10
      blendPool.setBRate(1_100_000_000n);
      // Ensure vault has yield liquidity
      syWrapper.balances.set("YIELD_MARKET_VAULT", 110_000n * WAD);

      const claimed = market.claim_yield("Alice", "Alice");
      expect(claimed).toBe(10_000n * WAD); // 100,000 * 0.10
      expect(syWrapper.balanceOf("Alice")).toBe(10_000n * WAD);

      // Immediate second claim should return zero
      const secondClaim = market.claim_yield("Alice", "Alice");
      expect(secondClaim).toBe(0n);
    });

    it("4.3 should handle multiple sequential claims across iterative rate increases", () => {
      syWrapper.balances.set("YIELD_MARKET_VAULT", 150_000n * WAD);

      // Jump 1: +5% (1.00 -> 1.05)
      blendPool.setBRate(1_050_000_000n);
      const claim1 = market.claim_yield("Alice", "Alice");
      expect(claim1).toBe(5_000n * WAD);

      // Jump 2: +10% (1.05 -> 1.155)
      blendPool.setBRate(1_155_000_000n);
      const claim2 = market.claim_yield("Alice", "Alice");
      // Delta on 1.05: (1.155 - 1.05) / 1.05 = 0.105 / 1.05 = 0.10 -> 10,000 WAD
      expect(claim2).toBe(10_000n * WAD);
    });

    it("4.4 should autonomously freeze yield accrual at maturity timestamp t >= T", () => {
      syWrapper.balances.set("YIELD_MARKET_VAULT", 200_000n * WAD);

      // Advance to maturity: rate = 1.20 (+20%)
      market.currentTimestamp = maturity180d;
      blendPool.setBRate(1_200_000_000n);

      const claimedAtMaturity = market.claim_yield("Alice", "Alice");
      expect(claimedAtMaturity).toBe(20_000n * WAD);
      expect(market.isSettled).toBe(true);
      expect(market.maturityIndex).toBe(1_200_000_000n);

      // Advance 10 days post-maturity and rate spikes to 1.50
      market.currentTimestamp = maturity180d + 10n * 86400n;
      blendPool.setBRate(1_500_000_000n);

      // Claim post-maturity: must return zero because yield is clamped to maturity
      const claimedPostMaturity = market.claim_yield("Alice", "Alice");
      expect(claimedPostMaturity).toBe(0n);
    });

    it("4.5 should allow post-maturity claim of frozen yield after explicit settle_maturity()", () => {
      syWrapper.balances.set("YIELD_MARKET_VAULT", 200_000n * WAD);

      market.currentTimestamp = maturity180d;
      blendPool.setBRate(1_150_000_000n);

      // Keeper settles market
      const [settledRate, mutated] = market.settle_maturity();
      expect(settledRate).toBe(1_150_000_000n);
      expect(mutated).toBe(true);

      // User claims yield after settlement
      const claimed = market.claim_yield("Alice", "Alice");
      expect(claimed).toBe(15_000n * WAD);
    });
  });

  // ===========================================================================
  // Feature 5: AMM Liquidity & Swaps (>=5 tests)
  // ===========================================================================
  describe("Feature 5: AMM Liquidity & Swaps", () => {
    beforeEach(() => {
      // Provide Alice and Bob with PT and SY for liquidity
      syWrapper.deposit("Alice", "Alice", 100_000n * WAD);
      market.mint_py("Alice", "Alice", 50_000n * WAD);
      // Alice has 50k PT, 50k YT, 50k SY
    });

    it("5.1 should add initial liquidity and permanently lock 1,000 dead shares to DEAD_ADDRESS", () => {
      const ptDeposit = 40_000n * WAD;
      const syDeposit = 40_000n * WAD;
      const minLp = 1n * WAD;

      const lpMinted = market.add_liquidity("Alice", "Alice", ptDeposit, syDeposit, minLp);
      expect(market.lpBalances.get(DEAD_ADDRESS)).toBe(1000n);
      expect(market.lpBalances.get("Alice")).toBe(lpMinted);
      expect(market.totalLp).toBe(lpMinted + 1000n);
      expect(market.totalPt).toBe(ptDeposit);
      expect(market.totalSy).toBe(syDeposit);
    });

    it("5.2 should remove liquidity proportionally returning PT and SY reserves", () => {
      const ptDeposit = 40_000n * WAD;
      const syDeposit = 40_000n * WAD;
      const lpMinted = market.add_liquidity("Alice", "Alice", ptDeposit, syDeposit, 1n * WAD);

      // Remove 50% of Alice's LP tokens
      const halfLp = lpMinted / 2n;
      const [ptOut, syOut] = market.remove_liquidity("Alice", "Alice", halfLp, 1n * WAD, 1n * WAD);

      expect(ptOut).toBeGreaterThan(0n);
      expect(syOut).toBeGreaterThan(0n);
      expect(market.lpBalances.get("Alice")).toBe(lpMinted - halfLp);
    });

    it("5.3 should swap exact PT for SY with log-normal invariant and 30 bps fee", () => {
      market.add_liquidity("Alice", "Alice", 40_000n * WAD, 40_000n * WAD, 1n * WAD);

      // Bob mints PT and executes swap
      syWrapper.deposit("Bob", "Bob", 10_000n * WAD);
      market.mint_py("Bob", "Bob", 5_000n * WAD);

      const [syOut, fee] = market.swap_exact_pt_for_sy("Bob", "Bob", 1_000n * WAD, 900n * WAD);
      expect(syOut).toBeGreaterThan(0n);
      expect(fee).toBeGreaterThan(0n);
      expect(syWrapper.balanceOf("Bob")).toBe(5_000n * WAD + syOut);
    });

    it("5.4 should swap exact SY for PT with log-normal invariant and fee deduction", () => {
      market.add_liquidity("Alice", "Alice", 40_000n * WAD, 40_000n * WAD, 1n * WAD);

      syWrapper.deposit("Bob", "Bob", 5_000n * WAD);
      const [ptOut, fee] = market.swap_exact_sy_for_pt("Bob", "Bob", 1_000n * WAD, 900n * WAD);

      expect(ptOut).toBeGreaterThan(0n);
      expect(fee).toBeGreaterThan(0n);
      expect(market.ptToken.balanceOf("Bob")).toBe(ptOut);
    });

    it("5.5 should execute single-pool zero-capital flash swap buying YT", () => {
      market.add_liquidity("Alice", "Alice", 40_000n * WAD, 40_000n * WAD, 1n * WAD);

      syWrapper.deposit("Bob", "Bob", 1_000n * WAD);
      const [ytBought, sySpent] = market.swap_exact_sy_for_yt("Bob", "Bob", 1_000n * WAD, 100n * WAD);

      expect(ytBought).toBeGreaterThan(0n);
      expect(sySpent).toBe(1_000n * WAD);
      expect(market.ytToken.balanceOf("Bob")).toBe(ytBought);
      expect(syWrapper.balanceOf("Bob")).toBe(0n);
    });

    it("5.6 should execute single-pool flash swap selling YT for SY", () => {
      market.add_liquidity("Alice", "Alice", 40_000n * WAD, 40_000n * WAD, 1n * WAD);

      // Alice already has 50k YT from beforeEach
      const [syReceived, fee] = market.swap_exact_yt_for_sy("Alice", "Alice", 5_000n * WAD, 10n * WAD);
      expect(syReceived).toBeGreaterThan(0n);
      expect(fee).toBeGreaterThan(0n);
      expect(market.ytToken.balanceOf("Alice")).toBe(45_000n * WAD);
    });
  });

  // ===========================================================================
  // Feature 6: Dynamic TTL Upkeep & Reentrancy Guard (>=5 tests)
  // ===========================================================================
  describe("Feature 6: Dynamic TTL Upkeep & Reentrancy Guard", () => {
    it("6.1 should calculate dynamic BUMP_TO correctly for 30-day short-term maturity", () => {
      const mat30d = t0 + 30n * 86400n;
      const bump30 = calculateBumpTo(t0, mat30d);
      // 30 days = 518,400 ledgers + 30d buffer = 1,036,800 ledgers; clamped to DEFAULT_BUMP_TO (120d = 2,073,600)
      expect(bump30).toBe(DEFAULT_BUMP_TO);
    });

    it("6.2 should calculate dynamic BUMP_TO correctly for 90-day quarterly maturity", () => {
      const mat90d = t0 + 90n * 86400n;
      const bump90 = calculateBumpTo(t0, mat90d);
      // 90d = 1,555,200 ledgers + 30d buffer (518,400) = 2,073,600 ledgers (120d)
      expect(bump90).toBe(DEFAULT_BUMP_TO);
    });

    it("6.3 should clamp 180-day semi-annual bond BUMP_TO to MAX_NETWORK_TTL (3,110,400 ledgers)", () => {
      const mat180d = t0 + 180n * 86400n;
      const bump180 = calculateBumpTo(t0, mat180d);
      expect(bump180).toBe(MAX_NETWORK_TTL);
    });

    it("6.4 should clamp 365-day annual bond BUMP_TO to MAX_NETWORK_TTL (3,110,400 ledgers)", () => {
      const mat365d = t0 + 365n * 86400n;
      const bump365 = calculateBumpTo(t0, mat365d);
      expect(bump365).toBe(MAX_NETWORK_TTL);
    });

    it("6.5 should calculate dynamic renewal threshold max(bump_to / 4, 30 days)", () => {
      const threshold180 = calculateBumpThreshold(MAX_NETWORK_TTL);
      expect(threshold180).toBe(MAX_NETWORK_TTL / 4); // 777,600 ledgers (~45 days)
      expect(threshold180).toBeGreaterThanOrEqual(MIN_BUMP_THRESHOLD);
    });

    it("6.6 should safely teardown reentrancy guard without permanent DoS lock in same ledger", () => {
      // First transaction
      const res1 = market.withNonReentrant(() => "TX1_SUCCESS");
      expect(res1).toBe("TX1_SUCCESS");
      expect(market.temporaryStorage.has("FlashLoanGuard")).toBe(false);

      // Second transaction in exact same ledger close
      const res2 = market.withNonReentrant(() => "TX2_SUCCESS");
      expect(res2).toBe("TX2_SUCCESS");
      expect(market.temporaryStorage.has("FlashLoanGuard")).toBe(false);

      // Reentrancy attempt inside active call must fail
      expect(() => {
        market.withNonReentrant(() => {
          market.withNonReentrant(() => "INNER_SHOULD_FAIL");
        });
      }).toThrow(ContractError.ReentrancyLocked);

      // Guard must still be cleaned up after error
      expect(market.temporaryStorage.has("FlashLoanGuard")).toBe(false);
    });
  });
});
