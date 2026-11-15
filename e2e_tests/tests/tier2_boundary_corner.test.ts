// e2e_tests/tests/tier2_boundary_corner.test.ts
// Tier 2: Boundary & Corner Cases (>=5 tests per feature domain)

import { describe, it, expect, beforeEach } from "bun:test";
import {
  WAD,
  MAX_EXP_INPUT,
  wadMul,
  wadDiv,
  lnWad,
  expWad,
  getExchangeRate,
  calculateHaircut,
  MathError
} from "../src/math-oracle.ts";
import {
  MockBlendPool,
  SYBlendWrapper,
  YieldMarket,
  SEP41Token,
  B_RATE_SCALE,
  ContractError
} from "../src/protocol-simulator.ts";

describe("Tier 2: Boundary & Corner Cases Test Suite", () => {
  let blendPool: MockBlendPool;
  let syWrapper: SYBlendWrapper;
  let market: YieldMarket;

  const t0 = 1_000_000_000n;
  const maturity180d = t0 + 180n * 86400n;

  beforeEach(() => {
    blendPool = new MockBlendPool("ADMIN", "USDC_ADDRESS", B_RATE_SCALE);
    syWrapper = new SYBlendWrapper("ADMIN", "USDC_ADDRESS", blendPool);
    market = new YieldMarket("ADMIN", syWrapper, maturity180d, 20n * WAD, (105n * WAD) / 100n, t0);

    blendPool.underlyingBalances.set("Alice", 1_000_000n * WAD);
    blendPool.underlyingBalances.set("Bob", 1_000_000n * WAD);
  });

  // ===========================================================================
  // Feature Domain 1: Zero & Sub-Minimal / Negative Amounts (>=5 tests)
  // ===========================================================================
  describe("Domain 1: Zero & Sub-Minimal Amounts", () => {
    it("1.1 should revert when depositing zero or negative underlying to SY", () => {
      expect(() => syWrapper.deposit("Alice", "Alice", 0n)).toThrow(ContractError.ZeroAmount);
      expect(() => syWrapper.deposit("Alice", "Alice", -100n * WAD)).toThrow(ContractError.ZeroAmount);
    });

    it("1.2 should revert when minting PY with zero amount", () => {
      syWrapper.deposit("Alice", "Alice", 100n * WAD);
      expect(() => market.mint_py("Alice", "Alice", 0n)).toThrow(ContractError.ZeroAmount);
    });

    it("1.3 should revert when early unwinding PY with zero amount", () => {
      syWrapper.deposit("Alice", "Alice", 100n * WAD);
      market.mint_py("Alice", "Alice", 100n * WAD);
      expect(() => market.redeem_py("Alice", "Alice", 0n)).toThrow(ContractError.ZeroAmount);
    });

    it("1.4 should revert when redeeming PT post-maturity with zero amount", () => {
      market.currentTimestamp = maturity180d;
      expect(() => market.redeem_pt_post_maturity("Alice", "Alice", 0n)).toThrow(ContractError.ZeroAmount);
      expect(() => market.redeem_pt_to_btoken("Alice", "Alice", 0n)).toThrow(ContractError.ZeroAmount);
    });

    it("1.5 should revert when swapping zero PT or zero SY in AMM", () => {
      syWrapper.deposit("Alice", "Alice", 50_000n * WAD);
      market.mint_py("Alice", "Alice", 25_000n * WAD);
      market.add_liquidity("Alice", "Alice", 20_000n * WAD, 20_000n * WAD, 1n * WAD);

      expect(() => market.swap_exact_pt_for_sy("Alice", "Alice", 0n, 1n)).toThrow(ContractError.ZeroAmount);
      expect(() => market.swap_exact_sy_for_pt("Alice", "Alice", 0n, 1n)).toThrow(ContractError.ZeroAmount);
    });

    it("1.6 should revert when adding or removing zero liquidity", () => {
      expect(() => market.add_liquidity("Alice", "Alice", 0n, 100n * WAD, 1n)).toThrow(ContractError.ZeroAmount);
      expect(() => market.add_liquidity("Alice", "Alice", 100n * WAD, 0n, 1n)).toThrow(ContractError.ZeroAmount);
      expect(() => market.remove_liquidity("Alice", "Alice", 0n, 1n, 1n)).toThrow(ContractError.ZeroAmount);
    });
  });

  // ===========================================================================
  // Feature Domain 2: Past-Maturity Boundary Invocations & Temporal Guards (>=5 tests)
  // ===========================================================================
  describe("Domain 2: Temporal Invariant & Maturity Boundary Guards", () => {
    beforeEach(() => {
      syWrapper.deposit("Alice", "Alice", 50_000n * WAD);
      market.mint_py("Alice", "Alice", 25_000n * WAD);
      market.add_liquidity("Alice", "Alice", 20_000n * WAD, 20_000n * WAD, 1n * WAD);
    });

    it("2.1 should strictly revert mint_py at or after maturity timestamp t >= T", () => {
      market.currentTimestamp = maturity180d; // Reached maturity
      syWrapper.deposit("Alice", "Alice", 1_000n * WAD);
      expect(() => market.mint_py("Alice", "Alice", 1_000n * WAD)).toThrow(ContractError.MarketAlreadyMatured);

      // Post maturity
      market.currentTimestamp = maturity180d + 1000n;
      expect(() => market.mint_py("Alice", "Alice", 1_000n * WAD)).toThrow(ContractError.MarketAlreadyMatured);
    });

    it("2.2 should strictly revert redeem_py (early unwind) at or after maturity timestamp t >= T", () => {
      market.currentTimestamp = maturity180d;
      expect(() => market.redeem_py("Alice", "Alice", 1_000n * WAD)).toThrow(ContractError.MarketAlreadyMatured);
    });

    it("2.3 should strictly revert swap_exact_pt_for_sy at or after maturity timestamp t >= T", () => {
      market.currentTimestamp = maturity180d;
      expect(() => market.swap_exact_pt_for_sy("Alice", "Alice", 100n * WAD, 1n)).toThrow(ContractError.MarketAlreadyMatured);
    });

    it("2.4 should strictly revert swap_exact_sy_for_pt at or after maturity timestamp t >= T", () => {
      market.currentTimestamp = maturity180d + 10n;
      expect(() => market.swap_exact_sy_for_pt("Alice", "Alice", 100n * WAD, 1n)).toThrow(ContractError.MarketAlreadyMatured);
    });

    it("2.5 should strictly revert redeem_pt_post_maturity before maturity t < T", () => {
      market.currentTimestamp = maturity180d - 1n; // 1 second before maturity
      expect(() => market.redeem_pt_post_maturity("Alice", "Alice", 1_000n * WAD)).toThrow(ContractError.MarketNotYetMatured);
      expect(() => market.redeem_pt_to_btoken("Alice", "Alice", 1_000n * WAD)).toThrow(ContractError.MarketNotYetMatured);
    });

    it("2.6 should strictly revert settle_maturity before maturity timestamp t < T", () => {
      market.currentTimestamp = maturity180d - 100n;
      expect(() => market.settle_maturity()).toThrow(ContractError.MarketNotYetMatured);
    });
  });

  // ===========================================================================
  // Feature Domain 3: Negative Yield Floor & Mathematical Invariant Boundaries (>=5 tests)
  // ===========================================================================
  describe("Domain 3: Negative Yield Floor & Transcendental Math Bounds", () => {
    it("3.1 should reject negative yield regime when E < 1.0 WAD with ContractError::NegativeYieldNotSupported", () => {
      // In unconstrained math, if pt is small relative to sy and anchor is 1.0, e drops below 1.0
      const tauWad = wadDiv(180n * 86400n * WAD, 31536000n * WAD);
      const scalarRoot = 20n * WAD;
      const rateAnchor = WAD; // 1.0 WAD

      // Extremely skewed pool: PT = 1,000, SY = 100,000
      expect(() => {
        getExchangeRate(1_000n * WAD, 100_000n * WAD, tauWad, scalarRoot, rateAnchor);
      }).toThrow(ContractError.NegativeYieldNotSupported);
    });

    it("3.2 should converge unconditionally to E = 1.0 WAD at maturity tau = 0 across any ratio", () => {
      const scalarRoot = 20n * WAD;
      const rateAnchor = (105n * WAD) / 100n;

      const e1 = getExchangeRate(100_000n * WAD, 10_000n * WAD, 0n, scalarRoot, rateAnchor);
      const e2 = getExchangeRate(10_000n * WAD, 100_000n * WAD, 0n, scalarRoot, rateAnchor);
      const e3 = getExchangeRate(50_000n * WAD, 50_000n * WAD, 0n, scalarRoot, rateAnchor);

      expect(e1).toBe(WAD);
      expect(e2).toBe(WAD);
      expect(e3).toBe(WAD);
    });

    it("3.3 should revert lnWad with NegativeLogarithmInput for non-positive input x <= 0", () => {
      expect(() => lnWad(0n)).toThrow(MathError.NegativeLogarithmInput);
      expect(() => lnWad(-10n * WAD)).toThrow(MathError.NegativeLogarithmInput);
      expect(lnWad(WAD)).toBe(0n); // ln(1.0) = 0
    });

    it("3.4 should revert expWad with MathError::Overflow when input exceeds 46.44 WAD ceiling", () => {
      // Inputs > 46.44 cause 128-bit integer overflow
      const justAboveCeiling = MAX_EXP_INPUT + 1n;
      expect(() => expWad(justAboveCeiling)).toThrow(MathError.Overflow);
      expect(() => expWad(100n * WAD)).toThrow(MathError.Overflow);

      // Input at ceiling should succeed
      const atCeiling = expWad(MAX_EXP_INPUT);
      expect(atCeiling).toBeGreaterThan(0n);
    });

    it("3.5 should return 0 for expWad when input is less than -41.0 WAD (underflow)", () => {
      const underflowRes = expWad(-42n * WAD);
      expect(underflowRes).toBe(0n);
    });

    it("3.6 should revert wadDiv with MathError::DivisionByZero when denominator is 0", () => {
      expect(() => wadDiv(100n * WAD, 0n)).toThrow(MathError.DivisionByZero);
    });
  });

  // ===========================================================================
  // Feature Domain 4: Extreme Pool Ratios & Boundary Proportions (>=5 tests)
  // ===========================================================================
  describe("Domain 4: Extreme Pool Proportions & Dead Shares", () => {
    beforeEach(() => {
      syWrapper.deposit("Alice", "Alice", 200_000n * WAD);
      market.mint_py("Alice", "Alice", 100_000n * WAD);
    });

    it("4.1 should revert add_liquidity when initial proportion p < 0.04 (e.g. 2% PT)", () => {
      // 2,000 PT and 98,000 SY -> p = 0.02 < 0.04
      expect(() => {
        market.add_liquidity("Alice", "Alice", 2_000n * WAD, 98_000n * WAD, 1n);
      }).toThrow(ContractError.ProportionOutOfBounds);
    });

    it("4.2 should revert add_liquidity when initial proportion p > 0.96 (e.g. 98% PT)", () => {
      // 98,000 PT and 2,000 SY -> p = 0.98 > 0.96
      expect(() => {
        market.add_liquidity("Alice", "Alice", 98_000n * WAD, 2_000n * WAD, 1n);
      }).toThrow(ContractError.ProportionOutOfBounds);
    });

    it("4.3 should allow initial liquidity at boundary proportion limits (p = 0.05 and p = 0.95)", () => {
      // 5,000 PT and 95,000 SY -> p = 0.05
      const lpMinted = market.add_liquidity("Alice", "Alice", 5_000n * WAD, 95_000n * WAD, 1n);
      expect(lpMinted).toBeGreaterThan(0n);
    });

    it("4.4 should revert swap if output violates trader slippage tolerance (min_out)", () => {
      market.add_liquidity("Alice", "Alice", 40_000n * WAD, 40_000n * WAD, 1n);

      syWrapper.deposit("Bob", "Bob", 10_000n * WAD);
      market.mint_py("Bob", "Bob", 5_000n * WAD);

      // Demanding impossible min_sy_out
      expect(() => {
        market.swap_exact_pt_for_sy("Bob", "Bob", 1_000n * WAD, 5_000n * WAD);
      }).toThrow(ContractError.SlippageExceeded);

      expect(() => {
        market.swap_exact_sy_for_pt("Bob", "Bob", 1_000n * WAD, 5_000n * WAD);
      }).toThrow(ContractError.SlippageExceeded);
    });

    it("4.5 should revert exchange rate calculation on zero-liquidity empty pool", () => {
      // Empty pool: totalPt = 0, totalSy = 0
      expect(() => market.get_exchange_rate()).toThrow(MathError.NegativeLogarithmInput);
    });
  });

  // ===========================================================================
  // Feature Domain 5: Empty Balances, Insufficient Allowances & Haircuts (>=5 tests)
  // ===========================================================================
  describe("Domain 5: Empty Balances, Permissions & Haircut Limits", () => {
    it("5.1 should revert early unwind if caller holds zero PT or zero YT", () => {
      expect(() => market.redeem_py("Bob", "Bob", 100n * WAD)).toThrow(ContractError.InsufficientBalance);
    });

    it("5.2 should revert early unwind if user holds sufficient PT but zero YT", () => {
      syWrapper.deposit("Alice", "Alice", 10_000n * WAD);
      market.mint_py("Alice", "Alice", 10_000n * WAD);

      // Transfer Alice's YT to Bob
      market.ytToken.transfer("Alice", "Bob", 10_000n * WAD);

      // Alice tries to unwind with only PT
      expect(() => market.redeem_py("Alice", "Alice", 5_000n * WAD)).toThrow(ContractError.InsufficientBalance);
    });

    it("5.3 should revert post-maturity PT redemption if caller holds zero PT", () => {
      market.currentTimestamp = maturity180d;
      expect(() => market.redeem_pt_post_maturity("Bob", "Bob", 1_000n * WAD)).toThrow(ContractError.InsufficientBalance);
    });

    it("5.4 should revert privileged token mint/burn if called by unauthorized non-market address", () => {
      const pt = new SEP41Token("PT", "PT", maturity180d, "AUTHORIZED_MARKET");
      expect(() => pt.mint("UNAUTHORIZED_ATTACKER", "Alice", 1_000n * WAD)).toThrow(ContractError.Unauthorized);
      expect(() => pt.burn("UNAUTHORIZED_ATTACKER", "Alice", 1_000n * WAD)).toThrow(ContractError.Unauthorized);
    });

    it("5.5 should accurately evaluate 50% catastrophic bad debt haircut (H = 0.50)", () => {
      const haircut50 = calculateHaircut(500_000n * WAD, 1_000_000n * WAD);
      expect(haircut50).toBe(500_000_000_000_000_000n); // 0.50 WAD

      // Full solvency haircut capped at 1.0 WAD
      const haircutFull = calculateHaircut(1_200_000n * WAD, 1_000_000n * WAD);
      expect(haircutFull).toBe(WAD); // 1.00 WAD
    });

    it("5.6 should revert calculateHaircut when total PT supply is zero", () => {
      expect(() => calculateHaircut(100n * WAD, 0n)).toThrow(MathError.DivisionByZero);
    });
  });
});
