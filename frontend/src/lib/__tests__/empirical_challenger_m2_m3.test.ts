// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  WAD,
  SCALAR_9,
  applySlippage,
  validateSlippage,
  validateAmountInput,
  parseUnitsSafe,
  formatUnitsExact,
  formatUnits,
  wadMul,
  wadDiv,
  lnWad,
  getExchangeRateWad,
  quoteSwapLocal,
  MarketStateRaw,
} from "../math";

describe("Empirical Challenger: AMM Slippage Math Soundness", () => {
  it("verifies applySlippage mathematical properties across slippage tolerances [1, 1000] bps", () => {
    const testAmounts = [
      1n, // 1 stroop (0.0000001 USDC)
      10n,
      100n,
      1_000n,
      10_000n,
      10_000_000n, // 1 USDC
      100_000_000_000n, // 10,000 USDC
      10_000_000_000_000_000n, // 1,000,000,000 USDC
    ];

    const testBps = [1, 10, 25, 50, 100, 250, 500, 999, 1000];

    for (const amount of testAmounts) {
      let previousMinOut = amount;
      for (const bps of testBps) {
        const minOut = applySlippage(amount, bps);

        // Invariant 1: minOut must be >= 1n (never 0n or negative)
        expect(minOut >= 1n).toBe(true);

        // Invariant 2: minOut must be <= amount
        expect(minOut <= amount).toBe(true);

        // Invariant 3: Monotonicity with respect to bps:
        // As slippage tolerance increases, minimum guaranteed output must be non-increasing
        expect(minOut <= previousMinOut).toBe(true);
        previousMinOut = minOut;

        // Invariant 4: Exact formula check: minOut = (amount * (10000 - bps)) / 10000
        const expectedRaw = (amount * BigInt(10_000 - bps)) / 10_000n;
        const expected = expectedRaw > 0n ? expectedRaw : 1n;
        expect(minOut).toBe(expected);
      }
    }
  });

  it("verifies applySlippage monotonicity with respect to input amounts", () => {
    const bps = 50; // 0.50% standard slippage
    for (let amt = 1000; amt <= 100_000; amt += 1000) {
      const a1 = BigInt(amt);
      const a2 = BigInt(amt + 500);
      const min1 = applySlippage(a1, bps);
      const min2 = applySlippage(a2, bps);
      expect(min1 <= min2).toBe(true);
    }
  });

  it("verifies applySlippage floor protection against zero output", () => {
    // When amount is so small that (amount * (10000 - bps)) / 10000 evaluates to 0
    expect(applySlippage(0n, 50)).toBe(1n);
    expect(applySlippage(1n, 50)).toBe(1n);
    expect(applySlippage(1n, 1000)).toBe(1n);
    expect(applySlippage(2n, 5000)).toBe(1n);
  });

  it("empirically verifies applySlippage across all 4 AMM swap directions in quoteSwapLocal", () => {
    const state: MarketStateRaw = {
      total_pt_reserve: 100_000n * WAD,
      total_sy_reserve: 100_000n * WAD,
      total_lp_supply: 100_000n * WAD,
      scalar_root: 10n * WAD,
      initial_anchor: 1_050_000_000_000_000_000n,
      annual_fee_rate: 10_000_000_000_000_000n,
      protocol_fee_bps: 1000n,
      fee_recipient: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      maturity: 2_000_000_000n,
      maturity_index: WAD,
      is_settled: false,
    };
    const now = 1_900_000_000n;

    const directions = ["pt_for_sy", "sy_for_pt", "sy_for_yt", "yt_for_sy"] as const;

    for (const dir of directions) {
      const quote50 = quoteSwapLocal(state, dir, 100n * WAD, now, 50);
      const quote100 = quoteSwapLocal(state, dir, 100n * WAD, now, 100);

      // minOutWithSlippage must match applySlippage(estimatedOut, bps)
      expect(quote50.minOutWithSlippage).toBe(applySlippage(quote50.estimatedOut, 50));
      expect(quote100.minOutWithSlippage).toBe(applySlippage(quote100.estimatedOut, 100));

      // 100 bps slippage must yield <= 50 bps slippage minOut
      expect(quote100.minOutWithSlippage <= quote50.minOutWithSlippage).toBe(true);

      // minOut must be positive
      expect(quote50.minOutWithSlippage > 0n).toBe(true);
    }
  });
});

describe("Empirical Challenger: LiquidityCard.tsx Code & Protection Audit", () => {
  it("empirically verifies that LiquidityCard.tsx source no longer uses hardcoded 1n min amounts in remove_liquidity", () => {
    const componentPath = resolve(__dirname, "../../components/trading/LiquidityCard.tsx");
    const code = readFileSync(componentPath, "utf8");

    // Negative check: The old flawed pattern "minPt: 1n" or "minSy: 1n" must NOT exist
    expect(code.includes("minPt: 1n,")).toBe(false);
    expect(code.includes("minSy: 1n,")).toBe(false);
    expect(code.includes("minPt: 1n")).toBe(false);
    expect(code.includes("minSy: 1n")).toBe(false);

    // Positive check: Must use dynamic applySlippage on liquidityEstimate
    expect(code).toContain("applySlippage(liquidityEstimate.estPtOut, slippageBps)");
    expect(code).toContain("applySlippage(liquidityEstimate.estSyOut, slippageBps)");
    expect(code).toContain("applySlippage(liquidityEstimate.estLp, slippageBps)");
  });

  it("verifies remove_liquidity sandwich attack defense calculation", () => {
    // Model realistic pool state:
    // Reserves: 1,000,000 PT (10^13 stroops), 1,000,000 SY (10^13 stroops), 1,000,000 LP (10^13 stroops)
    const totalPtReserve = 1_000_000n * 10_000_000n; // 1,000,000 PT
    const totalSyReserve = 1_000_000n * 10_000_000n; // 1,000,000 SY
    const totalLpSupply = 1_000_000n * 10_000_000n;  // 1,000,000 LP

    // User burns 10,000 LP shares (1% of the pool)
    const lpRemoveAmt = 10_000n * 10_000_000n;

    const estPtOut = (lpRemoveAmt * totalPtReserve) / totalLpSupply;
    const estSyOut = (lpRemoveAmt * totalSyReserve) / totalLpSupply;

    expect(estPtOut).toBe(10_000n * 10_000_000n); // 10,000 PT
    expect(estSyOut).toBe(10_000n * 10_000_000n); // 10,000 SY

    // With 50 bps slippage (0.50%):
    const slippageBps = 50;
    const minPt = applySlippage(estPtOut, slippageBps);
    const minSy = applySlippage(estSyOut, slippageBps);

    // User is guaranteed at least 9,950 PT and 9,950 SY
    expect(minPt).toBe(9_950n * 10_000_000n);
    expect(minSy).toBe(9_950n * 10_000_000n);

    // Old flawed code would have passed 1n (0.0000001 PT)
    // The protection difference is 9,950,000,000x better!
    expect(minPt > 1n).toBe(true);
    expect(minSy > 1n).toBe(true);
  });
});

describe("Empirical Challenger: 7-Decimal Stroop to Contract WAD Math Soundness", () => {
  const STROOP_SCALAR = 10_000_000n; // 10^7
  const WAD_SCALAR = 1_000_000_000_000_000_000n; // 10^18
  const CONVERSION_SCALAR_11 = 100_000_000_000n; // 10^11

  it("verifies mathematical exactness of 7-decimal stroop to WAD scalar conversion (10^7 * 10^11 = 10^18)", () => {
    expect(STROOP_SCALAR * CONVERSION_SCALAR_11).toBe(WAD_SCALAR);
  });

  it("verifies lossless round-trip stroop <-> WAD conversion across 1,000 pseudorandom amounts", () => {
    let seed = 42;
    const lcg = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed;
    };

    for (let i = 0; i < 1000; i++) {
      // Generate stroop amounts ranging from 1 stroop to 100,000,000 USDC
      const randUnits = BigInt(lcg());
      const stroopAmount = (randUnits % 100_000_000_000_000n) + 1n;

      // Convert stroop -> WAD
      const wadAmount = stroopAmount * CONVERSION_SCALAR_11;

      // Convert WAD -> stroop
      const recoveredStroop = wadAmount / CONVERSION_SCALAR_11;
      const remainder = wadAmount % CONVERSION_SCALAR_11;

      // Invariant: Exact lossless recovery, zero remainder, zero rounding drift
      expect(recoveredStroop).toBe(stroopAmount);
      expect(remainder).toBe(0n);
    }
  });

  it("verifies AMM reserve ratio wadDiv(pt, sy) invariance under stroop scaling", () => {
    // Let pt and sy be raw stroop reserve amounts
    const ptStroops = 1_234_567_890_123n; // ~123,456.7890123 PT
    const syStroops = 987_654_321_098n;   // ~98,765.4321098 SY

    // Contract AMM computes wadDiv directly on stroop reserves:
    // (ptStroops * WAD) / syStroops
    const ratioDirectStroops = wadDiv(ptStroops, syStroops);

    // If scaled to WAD first, then divided:
    const ptWad = ptStroops * CONVERSION_SCALAR_11;
    const syWad = syStroops * CONVERSION_SCALAR_11;
    const ratioFromWad = wadDiv(ptWad, syWad);

    // Because (A * 10^11 * 10^18) / (B * 10^11) == (A * 10^18) / B
    // The ratio in WAD is identically identical without any rounding drift!
    expect(ratioDirectStroops).toBe(ratioFromWad);
  });

  it("verifies validateAmountInput and formatUnitsExact preserve 7-decimal stroop precision", () => {
    const testCases = [
      "0.0000001", // 1 stroop
      "0.0000010", // 10 stroops
      "1.0000000", // 10,000,000 stroops
      "123.4567890",
      "999999.9999999",
    ];

    for (const human of testCases) {
      const res = validateAmountInput(human, 7);
      expect(res.valid).toBe(true);
      expect(res.amount).toBeDefined();

      const exact = formatUnitsExact(res.amount!, 7);
      // Normalized representation must match original string (minus trailing zeroes if parsed)
      const expectedNormalized = Number(human).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
      const actualNormalized = exact.replace(/0+$/, "").replace(/\.$/, "");
      expect(actualNormalized).toBe(expectedNormalized);
    }
  });

  it("verifies strict rejection of decimal precision exceeding 7 digits (stroop ceiling)", () => {
    const invalidInputs = [
      "0.00000001", // 8 decimals
      "1.12345678", // 8 decimals
      "0.123456789012345678", // 18 decimals (WAD in human representation)
    ];

    for (const input of invalidInputs) {
      const res = validateAmountInput(input, 7);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Precision cannot exceed 7 decimal places");
    }
  });

  it("verifies validateSlippage strict bounds [1, 1000] bps", () => {
    expect(validateSlippage(1).valid).toBe(true);
    expect(validateSlippage(50).valid).toBe(true);
    expect(validateSlippage(500).valid).toBe(true);
    expect(validateSlippage(501).isHigh).toBe(true);
    expect(validateSlippage(1000).valid).toBe(true);

    expect(validateSlippage(0).valid).toBe(false);
    expect(validateSlippage(-5).valid).toBe(false);
    expect(validateSlippage(1001).valid).toBe(false);
    expect(validateSlippage(NaN).valid).toBe(false);
  });
});
