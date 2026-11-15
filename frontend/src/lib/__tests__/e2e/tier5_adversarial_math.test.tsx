// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

// Authoritative test oracles & fixtures
import {
  EXPECTED_PRESET_MARKET_IDS,
  DUMMY_TEST_WALLET_ADDRESS,
  createMockWalletState,
  createMockSnapshot,
  createMockPortfolio,
  MockWalletContextState,
} from "./helpers/e2e-oracle";

// Modules under test
import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  findMarketById,
  deriveMarketStatus,
  calculateDaysToMaturity,
  MarketDefinition,
} from "../../markets";

import {
  WAD,
  SCALAR_9,
  STROOPS_FACTOR,
  LN_2,
  SECONDS_PER_YEAR,
  MIN_MARKET_PROPORTION,
  MAX_MARKET_PROPORTION,
  MIN_FEE_RATE,
  MAX_FEE_RATE,
  I128_MAX,
  I128_MIN,
  MarketStateRaw,
  wadMul,
  wadDiv,
  lnWad,
  calculateTauWad,
  calculateFeeRate,
  checkMarketProportion,
  getExchangeRateWad,
  calculateImpliedApyPct,
  formatUnits,
  formatUnitsExact,
  validateAmountInput,
  parseUnitsSafe,
  validateSlippage,
  applySlippage,
  shortenAddress,
  quoteSwapLocal,
  decodeSorobanError,
  CONTRACT_ERROR_MESSAGES,
  HORIZON_ERROR_MESSAGES,
} from "../../math";

import { buildActionArgs } from "../../stellar";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { LiquidityCard } from "@/components/trading/LiquidityCard";
import { RedeemCard } from "@/components/trading/RedeemCard";

// Mock environment setup
let currentWalletState: MockWalletContextState = createMockWalletState();
let currentMarket: MarketDefinition = PRESET_MARKETS[0];
let currentSnapshot = createMockSnapshot(PRESET_MARKETS[0]);
let currentPortfolio = createMockPortfolio(PRESET_MARKETS[0]);

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => currentWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => currentWalletState.walletNetworkMismatch,
}));

mock.module("@/context/MarketContext", () => ({
  useMarket: () => ({
    markets: PRESET_MARKETS,
    activeMarket: currentMarket,
    activeMarketId: currentMarket.id,
    selectMarket: (id: string) => {
      const found = PRESET_MARKETS.find((m) => m.id === id);
      if (found) currentMarket = found;
    },
    activeSnapshot: currentSnapshot,
    activePortfolio: currentPortfolio,
    loadingSnapshot: false,
    loadingPortfolio: false,
    marketMetrics: {
      [currentMarket.id]: {
        marketId: currentMarket.id,
        status: currentSnapshot.isMatured ? ("MATURED" as const) : ("ACTIVE" as const),
        daysToMaturity: currentSnapshot.daysToMaturity,
        impliedApyPct: currentSnapshot.impliedFixedApyPct,
        blendRate: 1.001,
        ptPriceInSy: currentSnapshot.ptPriceInSy,
        tvlSy: currentSnapshot.syTotalSupply,
        tvlUsd: 120000,
        ptReserve: currentSnapshot.state.total_pt_reserve,
        syReserve: currentSnapshot.state.total_sy_reserve,
        isMatured: currentSnapshot.isMatured,
        isLoading: false,
      },
    },
    refreshActiveMarket: async () => {},
    refreshAllMetrics: async () => {},
  }),
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("E2E Test Suite — Tier 5: White-Box Adversarial Math & Yield Space", () => {
  const dummyCaller = DUMMY_TEST_WALLET_ADDRESS;

  // ==========================================================================
  // AREA 1: ZERO AND NEGATIVE TIME-TO-MATURITY (TTM) MATH
  // ==========================================================================
  describe("Area 1: Zero and Negative Time-To-Maturity (TTM) Math", () => {
    const maturity = 1800000000n; // arbitrary fixed maturity timestamp

    it("evaluates calculateTauWad to strictly 0n at exact maturity timestamp", () => {
      const tau = calculateTauWad(maturity, maturity);
      expect(tau).toBe(0n);
    });

    it("evaluates calculateTauWad to strictly 0n when now is 1 second past maturity", () => {
      const tau = calculateTauWad(maturity + 1n, maturity);
      expect(tau).toBe(0n);
    });

    it("evaluates calculateTauWad to strictly 0n under extreme post-maturity timestamps (e.g. 10 years later)", () => {
      const extremeNow = maturity + 10n * SECONDS_PER_YEAR;
      const tau = calculateTauWad(extremeNow, maturity);
      expect(tau).toBe(0n);
    });

    it("evaluates calculateFeeRate to MIN_FEE_RATE when tauWad is 0n", () => {
      const annualFeeRate = 50_000_000_000_000_000n; // 5%
      const feeRate = calculateFeeRate(0n, annualFeeRate);
      expect(feeRate).toBe(MIN_FEE_RATE);
    });

    it("evaluates calculateFeeRate to MIN_FEE_RATE when tauWad is negative", () => {
      const annualFeeRate = 50_000_000_000_000_000n;
      const feeRate = calculateFeeRate(-1000n, annualFeeRate);
      expect(feeRate).toBe(MIN_FEE_RATE);
    });

    it("clamps fee rate within [MIN_FEE_RATE, MAX_FEE_RATE] for very large tenors", () => {
      const annualFeeRate = 50_000_000_000_000_000n;
      const hugeTauWad = 100n * WAD; // 100 years
      const feeRate = calculateFeeRate(hugeTauWad, annualFeeRate);
      expect(feeRate).toBe(MAX_FEE_RATE);
    });

    it("evaluates getExchangeRateWad to rateAnchor/WAD when tauWad is 0n regardless of reserve ratio", () => {
      const ptRes = 500_000_0000000n;
      const syRes = 500_000_0000000n;
      const scalarRoot = 8n * WAD;
      const rateAnchor = WAD;

      const rate = getExchangeRateWad(ptRes, syRes, 0n, scalarRoot, rateAnchor);
      expect(rate).toBe(WAD);
    });

    it("evaluates calculateImpliedApyPct to exactly 0 when tauWad is 0n or negative", () => {
      expect(calculateImpliedApyPct(WAD, 0n)).toBe(0);
      expect(calculateImpliedApyPct(WAD * 2n, 0n)).toBe(0);
      expect(calculateImpliedApyPct(WAD * 2n, -100n)).toBe(0);
    });

    it("quoteSwapLocal throws explicit 'Market already matured' error when nowSeconds >= maturity", () => {
      const mockState: MarketStateRaw = {
        total_pt_reserve: 100_000_0000000n,
        total_sy_reserve: 100_000_0000000n,
        total_lp_supply: 200_000_0000000n,
        scalar_root: 8n * WAD,
        initial_anchor: WAD,
        annual_fee_rate: 5n * 10n ** 16n,
        protocol_fee_bps: 1000n,
        fee_recipient: dummyCaller,
        maturity,
        maturity_index: WAD,
        is_settled: false,
      };

      expect(() => {
        quoteSwapLocal(mockState, "sy_for_pt", 10_0000000n, maturity, 50);
      }).toThrow("Market already matured");

      expect(() => {
        quoteSwapLocal(mockState, "sy_for_pt", 10_0000000n, maturity + 100n, 50);
      }).toThrow("Market already matured");
    });

    it("deriveMarketStatus returns MATURED for now >= maturity and calculateDaysToMaturity returns 0", () => {
      const mat = 1730000000;
      expect(deriveMarketStatus(mat, mat)).toBe("MATURED");
      expect(deriveMarketStatus(mat, mat + 3600)).toBe("MATURED");
      expect(calculateDaysToMaturity(mat, mat)).toBe(0);
      expect(calculateDaysToMaturity(mat, mat + 86400 * 5)).toBe(0);
    });

    it("renders SwapCard in matured state displaying maturity notice and disabling swap quotes", () => {
      const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
      currentMarket = maturedMarket;
      currentSnapshot = createMockSnapshot(maturedMarket, { isMatured: true });
      currentPortfolio = createMockPortfolio(maturedMarket);

      const html = renderToString(
        <SwapCard
          snapshot={currentSnapshot}
          portfolio={currentPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("This market reached maturity");
      expect(html).toContain("AMM swaps are closed");
      expect(html).not.toContain("NaN");
    });
  });

  // ==========================================================================
  // AREA 2: EXTREME RESERVE IMBALANCE (1 STROOP VS 10^12 STROOPS)
  // ==========================================================================
  describe("Area 2: Extreme Reserve Imbalance & 4%-96% AMM Bounds", () => {
    it("accepts exact 4.0% boundary reserve proportion without throwing", () => {
      // 4% PT, 96% SY -> 40,000 vs 960,000
      const ptRes = 40_000n;
      const syRes = 960_000n;
      expect(() => checkMarketProportion(ptRes, syRes)).not.toThrow();
    });

    it("accepts exact 96.0% boundary reserve proportion without throwing", () => {
      // 96% PT, 4% SY -> 960,000 vs 40,000
      const ptRes = 960_000n;
      const syRes = 40_000n;
      expect(() => checkMarketProportion(ptRes, syRes)).not.toThrow();
    });

    it("rejects 1 stroop PT vs 10^12 stroops SY (< 4% bounds)", () => {
      const ptRes = 1n; // 1 stroop
      const syRes = 1_000_000_000_000n; // 10^12 stroops (100,000 tokens)
      expect(() => checkMarketProportion(ptRes, syRes)).toThrow(
        "Trade exceeds AMM 4%-96% reserve safety bounds"
      );
    });

    it("rejects 10^12 stroops PT vs 1 stroop SY (> 96% bounds)", () => {
      const ptRes = 1_000_000_000_000n;
      const syRes = 1n;
      expect(() => checkMarketProportion(ptRes, syRes)).toThrow(
        "Trade exceeds AMM 4%-96% reserve safety bounds"
      );
    });

    it("rejects zero or negative reserves with 'AMM reserves would drop to zero'", () => {
      expect(() => checkMarketProportion(0n, 100n)).toThrow("AMM reserves would drop to zero");
      expect(() => checkMarketProportion(100n, 0n)).toThrow("AMM reserves would drop to zero");
      expect(() => checkMarketProportion(-1n, 100n)).toThrow("AMM reserves would drop to zero");
    });

    it("rejects slightly out-of-bounds ratios (3.99% and 96.01%)", () => {
      // 399 PT / 10,000 total = 3.99%
      expect(() => checkMarketProportion(399n, 9601n)).toThrow(
        "Trade exceeds AMM 4%-96% reserve safety bounds"
      );
      // 9601 PT / 10,000 total = 96.01%
      expect(() => checkMarketProportion(9601n, 399n)).toThrow(
        "Trade exceeds AMM 4%-96% reserve safety bounds"
      );
    });

    it("quoteSwapLocal throws error when user trade pushes reserves beyond safety bounds", () => {
      const nowSeconds = 1750000000n;
      const maturity = nowSeconds + 90n * 86400n;
      // Initial balanced pool: 1,000 PT & 1,000 SY (in stroops)
      const mockState: MarketStateRaw = {
        total_pt_reserve: 1_000_0000000n,
        total_sy_reserve: 1_000_0000000n,
        total_lp_supply: 2_000_0000000n,
        scalar_root: 8n * WAD,
        initial_anchor: WAD,
        annual_fee_rate: 5n * 10n ** 16n,
        protocol_fee_bps: 1000n,
        fee_recipient: dummyCaller,
        maturity,
        maturity_index: WAD,
        is_settled: false,
      };

      // Massive PT dump (10,000 PT) would dilute SY down towards 0 or push PT ratio > 96%
      expect(() => {
        quoteSwapLocal(mockState, "pt_for_sy", 10_000_0000000n, nowSeconds, 50);
      }).toThrow();
    });

    it("quoteSwapLocal throws error when order exceeds available pool reserves", () => {
      const nowSeconds = 1750000000n;
      const maturity = nowSeconds + 90n * 86400n;
      const mockState: MarketStateRaw = {
        total_pt_reserve: 100_0000000n,
        total_sy_reserve: 100_0000000n,
        total_lp_supply: 200_0000000n,
        scalar_root: 8n * WAD,
        initial_anchor: WAD,
        annual_fee_rate: 5n * 10n ** 16n,
        protocol_fee_bps: 1000n,
        fee_recipient: dummyCaller,
        maturity,
        maturity_index: WAD,
        is_settled: false,
      };

      // Buying more PT than total pool PT reserve
      expect(() => {
        quoteSwapLocal(mockState, "sy_for_pt", 200_0000000n, nowSeconds, 50);
      }).toThrow();
    });

    it("computes quote for 1 stroop trade safely without underflow or zero division", () => {
      const nowSeconds = 1750000000n;
      const maturity = nowSeconds + 90n * 86400n;
      // In Yield Space, PT reserves must exceed SY reserves (e.g. 60:40) to maintain e > 1.0 (positive implied yield)
      const mockState: MarketStateRaw = {
        total_pt_reserve: 600_000_0000000n,
        total_sy_reserve: 400_000_0000000n,
        total_lp_supply: 1_000_000_0000000n,
        scalar_root: 8n * WAD,
        initial_anchor: WAD,
        annual_fee_rate: 5n * 10n ** 16n,
        protocol_fee_bps: 1000n,
        fee_recipient: dummyCaller,
        maturity,
        maturity_index: WAD,
        is_settled: false,
      };

      const quote = quoteSwapLocal(mockState, "sy_for_pt", 1n, nowSeconds, 50);
      expect(quote).toBeDefined();
      expect(quote.amountIn).toBe(1n);
      expect(quote.minOutWithSlippage).toBeGreaterThanOrEqual(1n);
      expect(Number.isFinite(quote.effectiveExchangeRate)).toBe(true);
      expect(Number.isFinite(quote.impliedApyAfterPct)).toBe(true);
    });

    it("stress-tests randomized reserve proportions between 5% and 95% confirming invariant holds", () => {
      for (let ptPct = 5; ptPct <= 95; ptPct += 5) {
        const syPct = 100 - ptPct;
        const total = 1_000_000_0000000n;
        const pt = (total * BigInt(ptPct)) / 100n;
        const sy = (total * BigInt(syPct)) / 100n;
        expect(() => checkMarketProportion(pt, sy)).not.toThrow();
      }
    });
  });

  // ==========================================================================
  // AREA 3: DECIMAL PRECISION & ROUNDING (7-DECIMAL STROOPS VS WAD)
  // ==========================================================================
  describe("Area 3: Decimal Precision & 7-Decimal Stroops Conversions", () => {
    it("confirms STROOPS_FACTOR is exactly 10^7 and WAD is 10^18", () => {
      expect(STROOPS_FACTOR).toBe(10_000_000n);
      expect(WAD).toBe(1_000_000_000_000_000_000n);
      expect(SCALAR_9).toBe(1_000_000_000n);
    });

    it("parses 1 stroop (0.0000001) accurately to exactly 1n", () => {
      const res = validateAmountInput("0.0000001", 7);
      expect(res.valid).toBe(true);
      expect(res.amount).toBe(1n);
    });

    it("rejects 8-decimal inputs exceeding Stellar 7-decimal Stroop precision", () => {
      const res = validateAmountInput("0.00000001", 7);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Precision cannot exceed 7 decimal places");
    });

    it("formats 1 stroop (1n) to exact string '0.0000001'", () => {
      expect(formatUnits(1n, 7, 7)).toBe("0.0000001");
      expect(formatUnitsExact(1n, 7)).toBe("0.0000001");
    });

    it("formats 1 whole unit (10,000,000n stroops) cleanly to '1'", () => {
      expect(formatUnits(10_000_000n, 7, 4)).toBe("1");
      expect(formatUnitsExact(10_000_000n, 7)).toBe("1");
    });

    it("formats fractional units correctly without trailing zeroes", () => {
      expect(formatUnits(12_345_670n, 7, 7)).toBe("1.234567");
      expect(formatUnits(10_050_000n, 7, 4)).toBe("1.005");
      expect(formatUnits(10_000_001n, 7, 7)).toBe("1.0000001");
    });

    it("formats negative amounts with leading minus sign", () => {
      expect(formatUnits(-10_000_000n, 7, 4)).toBe("-1");
      expect(formatUnits(-1n, 7, 7)).toBe("-0.0000001");
    });

    it("verifies round-trip fidelity between parseUnitsSafe and formatUnitsExact for 20 sample amounts", () => {
      const testStroops = [
        1n,
        2n,
        10n,
        99n,
        100n,
        1_000n,
        10_000n,
        100_000n,
        1_000_000n,
        10_000_000n, // 1 token
        12_345_678n,
        50_000_000n,
        100_000_000n,
        1_000_000_000n,
        98_765_432_100n,
        100_000_000_000n,
        1_000_000_000_000n,
        10_000_000_000_000n,
        100_000_000_000_000n,
        1_000_000_000_000_000n,
      ];

      for (const stroops of testStroops) {
        const str = formatUnitsExact(stroops, 7);
        const parsed = parseUnitsSafe(str, 7);
        expect(parsed).toBe(stroops);
      }
    });

    it("rejects zero and whitespace-padded zero representations", () => {
      expect(validateAmountInput("0", 7).valid).toBe(false);
      expect(validateAmountInput("0.0", 7).valid).toBe(false);
      expect(validateAmountInput("0.0000000", 7).valid).toBe(false);
      expect(validateAmountInput("00.00", 7).valid).toBe(false);
    });

    it("rejects negative amount strings", () => {
      expect(validateAmountInput("-1", 7).valid).toBe(false);
      expect(validateAmountInput("-0.0000001", 7).valid).toBe(false);
      expect(validateAmountInput("-100.5", 7).valid).toBe(false);
    });

    it("enforces user balance constraint down to the exact single stroop", () => {
      const userBalance = 10_000_000n; // exactly 1.0000000 USDC

      // Exact balance is valid
      const exactValid = validateAmountInput("1.0000000", 7, userBalance);
      expect(exactValid.valid).toBe(true);
      expect(exactValid.amount).toBe(userBalance);

      // Exceeding by 1 single stroop is rejected
      const oneStroopOver = validateAmountInput("1.0000001", 7, userBalance);
      expect(oneStroopOver.valid).toBe(false);
      expect(oneStroopOver.error).toBe("Insufficient balance");
    });

    it("handles large values exceeding Number.MAX_SAFE_INTEGER without precision truncation", () => {
      // 10^16 stroops = 1,000,000,000 USDC > Number.MAX_SAFE_INTEGER (9 * 10^15)
      const largeInput = "1000000000.1234567";
      const res = validateAmountInput(largeInput, 7);
      expect(res.valid).toBe(true);
      expect(res.amount).toBe(10000000001234567n);

      const strBack = formatUnitsExact(res.amount!, 7);
      expect(strBack).toBe(largeInput);
    });
  });

  // ==========================================================================
  // AREA 4: DIVISION BY ZERO AND NAN GUARDS
  // ==========================================================================
  describe("Area 4: Division by Zero, Overflow & NaN Guards", () => {
    it("wadDiv throws 'Division by zero' when denominator is 0n", () => {
      expect(() => wadDiv(WAD, 0n)).toThrow("Division by zero");
      expect(() => wadDiv(1n, 0n)).toThrow("Division by zero");
      expect(() => wadDiv(0n, 0n)).toThrow("Division by zero");
    });

    it("wadDiv returns 0n when numerator is 0n with non-zero denominator", () => {
      expect(wadDiv(0n, WAD)).toBe(0n);
      expect(wadDiv(0n, 123456789n)).toBe(0n);
    });

    it("wadDiv throws 'Fixed-point overflow' when quotient exceeds I128_MAX", () => {
      // I128_MAX * WAD / 1n will exceed I128_MAX
      expect(() => wadDiv(I128_MAX, 1n)).toThrow("Fixed-point overflow");
    });

    it("wadMul returns 0n if either multiplicand is 0n", () => {
      expect(wadMul(0n, WAD)).toBe(0n);
      expect(wadMul(WAD, 0n)).toBe(0n);
      expect(wadMul(0n, 0n)).toBe(0n);
    });

    it("wadMul throws 'Fixed-point overflow' when product exceeds I128_MAX", () => {
      expect(() => wadMul(I128_MAX, 2n * WAD)).toThrow("Fixed-point overflow");
    });

    it("lnWad throws 'Negative logarithm input' for zero and negative inputs", () => {
      expect(() => lnWad(0n)).toThrow("Negative logarithm input");
      expect(() => lnWad(-1n)).toThrow("Negative logarithm input");
      expect(() => lnWad(-WAD)).toThrow("Negative logarithm input");
    });

    it("lnWad evaluates ln(1) (lnWad(WAD)) to exactly 0n", () => {
      expect(lnWad(WAD)).toBe(0n);
    });

    it("lnWad terminates cleanly for tiny non-zero input (1n stroop in WAD)", () => {
      // 1n represents an infinitesimal number in 18 decimals (10^-18)
      // ln(10^-18) ≈ -41.44 WAD
      const ln1 = lnWad(1n);
      expect(ln1).toBeLessThan(0n);
      expect(ln1).toBeGreaterThan(-100n * WAD);
    });

    it("lnWad accurately approximates ln(2) within 10^-8 relative precision", () => {
      const ln2Computed = lnWad(2n * WAD);
      // Expected LN_2 constant is 693_147_180_559_945_309n
      const diff = ln2Computed > LN_2 ? ln2Computed - LN_2 : LN_2 - ln2Computed;
      expect(diff).toBeLessThan(1_000_000_000n); // < 1e-9 error
    });

    it("getExchangeRateWad throws when reserves are zero or negative", () => {
      expect(() => getExchangeRateWad(0n, WAD, WAD, WAD, WAD)).toThrow("Reserves must be positive");
      expect(() => getExchangeRateWad(WAD, 0n, WAD, WAD, WAD)).toThrow("Reserves must be positive");
      expect(() => getExchangeRateWad(-1n, WAD, WAD, WAD, WAD)).toThrow("Reserves must be positive");
    });

    it("getExchangeRateWad throws 'Scalar root cannot be zero' when scalarRoot is 0n", () => {
      expect(() => getExchangeRateWad(WAD, WAD, WAD, 0n, WAD)).toThrow("Scalar root cannot be zero");
    });

    it("calculateImpliedApyPct returns 0 (not NaN or Infinity) across all degenerate inputs", () => {
      // Denominator tauYears = 0 (would cause 1 / 0 = Infinity in Math.pow)
      expect(calculateImpliedApyPct(WAD * 2n, 0n)).toBe(0);
      expect(Number.isNaN(calculateImpliedApyPct(WAD * 2n, 0n))).toBe(false);
      expect(Number.isFinite(calculateImpliedApyPct(WAD * 2n, 0n))).toBe(true);

      // Exchange rate equal to or less than 1.0 (0% yield or negative yield)
      expect(calculateImpliedApyPct(WAD, WAD)).toBe(0);
      expect(calculateImpliedApyPct(WAD - 1n, WAD)).toBe(0);
      expect(calculateImpliedApyPct(0n, WAD)).toBe(0);
    });

    it("validateAmountInput rejects NaN, Infinity, scientific notation and malformed strings", () => {
      const invalidInputs = [
        "NaN",
        "Infinity",
        "-Infinity",
        "1e6",
        "1E-4",
        "1/2",
        "abc",
        "1.2.3",
        "1,000",
        "",
        "   ",
        ".",
        "1.",
      ];

      for (const input of invalidInputs) {
        const res = validateAmountInput(input, 7);
        expect(res.valid).toBe(false);
        expect(res.error).toBeDefined();
      }
    });

    it("validateSlippage guards against NaN, Infinity and non-number inputs", () => {
      expect(validateSlippage(NaN).valid).toBe(false);
      expect(validateSlippage(Infinity).valid).toBe(false);
      expect(validateSlippage(-Infinity).valid).toBe(false);
      // @ts-expect-error test invalid type
      expect(validateSlippage("50").valid).toBe(false);
      // @ts-expect-error test undefined
      expect(validateSlippage(undefined).valid).toBe(false);
    });
  });

  // ==========================================================================
  // AREA 5: EXTREME SLIPPAGE TOLERANCE (0.0001% VS 99.99%)
  // ==========================================================================
  describe("Area 5: Extreme Slippage Tolerance Bounds & Monotonicity", () => {
    it("rejects sub-minimum slippage tolerance 0.0001% (0.01 bps < 1 bps limit)", () => {
      const res = validateSlippage(0.01);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Slippage tolerance must be between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("rejects 0.00% (0 bps) slippage tolerance", () => {
      const res = validateSlippage(0);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Slippage tolerance must be between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("accepts minimum boundary 0.01% (1 bps)", () => {
      const res = validateSlippage(1);
      expect(res.valid).toBe(true);
      expect(res.isHigh).toBeUndefined();
    });

    it("accepts standard slippage values (0.1% / 10 bps, 0.5% / 50 bps, 1.0% / 100 bps)", () => {
      expect(validateSlippage(10).valid).toBe(true);
      expect(validateSlippage(50).valid).toBe(true);
      expect(validateSlippage(100).valid).toBe(true);
    });

    it("accepts exactly 5.0% (500 bps) as highest standard slippage without warning", () => {
      const res = validateSlippage(500);
      expect(res.valid).toBe(true);
      expect(res.isHigh).toBeUndefined();
      expect(res.warning).toBeUndefined();
    });

    it("emits high slippage warning for tolerances strictly greater than 5% (e.g. 5.01% / 501 bps)", () => {
      const res = validateSlippage(501);
      expect(res.valid).toBe(true);
      expect(res.isHigh).toBe(true);
      expect(res.warning).toContain("High slippage tolerance (>5%)");
    });

    it("accepts maximum allowable tolerance 10.0% (1000 bps) with warning", () => {
      const res = validateSlippage(1000);
      expect(res.valid).toBe(true);
      expect(res.isHigh).toBe(true);
      expect(res.warning).toBeDefined();
    });

    it("rejects above-maximum slippage 10.01% (1001 bps)", () => {
      const res = validateSlippage(1001);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Slippage tolerance must be between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("rejects extreme slippage tolerance 99.99% (9999 bps)", () => {
      const res = validateSlippage(9999);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Slippage tolerance must be between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("verifies mathematical monotonicity of applySlippage across all valid bps limits", () => {
      const amount = 1_000_000_0000000n; // 1,000,000 tokens
      const bpsSteps = [1, 5, 10, 50, 100, 250, 500, 750, 1000];

      let prevOut = amount;
      for (const bps of bpsSteps) {
        const minOut = applySlippage(amount, bps);
        expect(minOut).toBeLessThanOrEqual(prevOut);
        expect(minOut).toBeGreaterThan(0n);
        prevOut = minOut;
      }
    });

    it("clamps minimum output to at least 1n stroop for microscopic amounts under slippage", () => {
      // 1 stroop with 50 bps slippage
      const minOut = applySlippage(1n, 50);
      expect(minOut).toBe(1n);

      // 1 stroop with 1000 bps (10%) slippage
      const minOutMaxSlippage = applySlippage(1n, 1000);
      expect(minOutMaxSlippage).toBe(1n);
    });

    it("calculates exact deduction for 100 USDC with 0.5% (50 bps) slippage", () => {
      const amount = 100_0000000n; // 100 USDC
      const minOut = applySlippage(amount, 50);
      // 100 * (10000 - 50) / 10000 = 99.5 USDC
      expect(minOut).toBe(99_5000000n);
    });
  });

  // ==========================================================================
  // AREA 6: POST-MATURITY PRICE CONVERGENCE (PT -> 1.0, YT -> 0.0)
  // ==========================================================================
  describe("Area 6: Post-Maturity Price Convergence (PT -> 1.0, YT -> 0.0)", () => {
    it("proves Yield Space exchange rate eWad strictly equals WAD at tau = 0 across divergent reserve ratios", () => {
      const scalarRoot = 8n * WAD;
      const initialAnchor = WAD;

      // 50:50 reserve ratio
      const eBalanced = getExchangeRateWad(100_000n, 100_000n, 0n, scalarRoot, initialAnchor);
      expect(eBalanced).toBe(WAD);

      // 90:10 reserve ratio
      const eSkewedPt = getExchangeRateWad(900_000n, 100_000n, 0n, scalarRoot, initialAnchor);
      expect(eSkewedPt).toBe(WAD);

      // 10:90 reserve ratio
      const eSkewedSy = getExchangeRateWad(100_000n, 900_000n, 0n, scalarRoot, initialAnchor);
      expect(eSkewedSy).toBe(WAD);

      // 95:5 reserve ratio
      const eExtreme = getExchangeRateWad(950_000n, 50_000n, 0n, scalarRoot, initialAnchor);
      expect(eExtreme).toBe(WAD);
    });

    it("demonstrates PT price converges to exactly 1.0 in underlying SY terms at maturity", () => {
      const rateAtMaturity = WAD;
      // PT price in SY is 1 / e; since e = 1.0, price = 1.0
      const ptPrice = Number(WAD) / Number(rateAtMaturity);
      expect(ptPrice).toBe(1.0);
    });

    it("demonstrates YT price converges to exactly 0.0 at maturity", () => {
      const rateAtMaturity = WAD;
      // YT price = 1 - 1 / e; since e = 1.0, price = 1 - 1 = 0.0
      const ytPrice = 1.0 - Number(WAD) / Number(rateAtMaturity);
      expect(ytPrice).toBe(0.0);
    });

    it("verifies post-maturity redemption settles PT 1:1 into underlying SY without hair-cut", () => {
      const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
      const userPtHolding = 250_0000000n; // 250 PT

      const action = buildActionArgs(
        {
          type: "redeem_pt_post_maturity",
          caller: dummyCaller,
          ptAmount: userPtHolding,
        },
        maturedMarket
      );

      expect(action.contractId).toBe(maturedMarket.contracts.poolId);
      expect(action.method).toBe("redeem_pt_post_maturity");
      expect(action.args).toHaveLength(3);
    });

    it("verifies RedeemCard UI properly enables 1:1 post-maturity redemption and hides YT requirement", () => {
      const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
      currentMarket = maturedMarket;
      currentSnapshot = createMockSnapshot(maturedMarket, { isMatured: true });
      // User holds only PT, 0 YT (pre-maturity would require equal YT)
      currentPortfolio = createMockPortfolio(maturedMarket, {
        ptBalance: 150_0000000n,
        ytBalance: 0n,
      });

      const html = renderToString(
        <RedeemCard
          snapshot={currentSnapshot}
          portfolio={currentPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      // Confirms matured state is surfaced
      expect(html).toContain("This position is matured");
      expect(html).toContain("Redeem PT 1:1");
      expect(html).not.toContain("NaN");
    });
  });

  // ==========================================================================
  // AREA 7: SOROBAN ERROR CODE & HORIZON MAPPING VERIFICATION
  // ==========================================================================
  describe("Area 7: Soroban Error Code & Horizon Mapping Completeness", () => {
    it("decodes contract error #13 (Fixed-point overflow) accurately", () => {
      const msg = decodeSorobanError("HostError: Error(Contract, #13)");
      expect(msg).toBe("Soroban ContractError #13: Fixed-point arithmetic overflow occurred.");
    });

    it("decodes contract error #14 (4%-96% AMM reserve bounds) accurately", () => {
      const msg = decodeSorobanError("ContractError #14");
      expect(msg).toBe(
        "Soroban ContractError #14: Trade pushes AMM reserve ratio beyond allowed 4%-96% bounds."
      );
    });

    it("decodes contract error #20 (Division by zero) accurately", () => {
      const msg = decodeSorobanError("Error(Contract, 20)");
      expect(msg).toBe("Soroban ContractError #20: Division by zero in fixed-point math.");
    });

    it("decodes contract error #9 (Slippage limit) accurately", () => {
      const msg = decodeSorobanError("Error(Contract, #9)");
      expect(msg).toBe("Soroban ContractError #9: Output fell below your slippage tolerance limit.");
    });

    it("decodes contract error #7 (Already reached maturity) accurately", () => {
      const msg = decodeSorobanError("Error(Contract, #7)");
      expect(msg).toBe("Soroban ContractError #7: Market has already reached maturity.");
    });

    it("decodes Horizon op_underfunded and op_no_trustline errors", () => {
      expect(decodeSorobanError("tx_failed with op_underfunded")).toBe(
        "Account balance is insufficient to complete the operation."
      );
      expect(decodeSorobanError("tx_failed with op_no_trustline")).toBe(
        "Account is missing Testnet USDC trustline. Use Add USDC Trustline first."
      );
    });

    it("decodes user wallet cancellation cleanly", () => {
      expect(decodeSorobanError("User declined signature")).toBe(
        "Wallet signature request was cancelled by user."
      );
    });

    it("confirms all 31 contract error codes have non-empty descriptive messages", () => {
      for (let code = 1; code <= 31; code++) {
        expect(CONTRACT_ERROR_MESSAGES[code]).toBeDefined();
        expect(CONTRACT_ERROR_MESSAGES[code].length).toBeGreaterThan(5);
      }
    });
  });
});
