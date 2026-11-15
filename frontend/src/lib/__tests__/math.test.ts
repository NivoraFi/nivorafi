// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import {
  WAD,
  SCALAR_9,
  SECONDS_PER_YEAR,
  wadMul,
  wadDiv,
  lnWad,
  calculateTauWad,
  calculateFeeRate,
  checkMarketProportion,
  getExchangeRateWad,
  calculateImpliedApyPct,
  formatUnits,
  parseUnitsSafe,
  applySlippage,
  shortenAddress,
  quoteSwapLocal,
  decodeSorobanError,
  MarketStateRaw,
} from "../math";

describe("Fixed-Point Math (WAD 1e18)", () => {
  it("multiplies two WAD numbers correctly", () => {
    // 2.0 * 3.5 = 7.0
    const a = 2n * WAD;
    const b = (7n * WAD) / 2n;
    expect(wadMul(a, b)).toBe(7n * WAD);

    // 0 * X = 0
    expect(wadMul(0n, a)).toBe(0n);
    expect(wadMul(a, 0n)).toBe(0n);

    // 1.0 * X = X
    expect(wadMul(WAD, a)).toBe(a);
  });

  it("divides two WAD numbers correctly", () => {
    // 7.0 / 2.0 = 3.5
    const a = 7n * WAD;
    const b = 2n * WAD;
    expect(wadDiv(a, b)).toBe((7n * WAD) / 2n);

    // 0 / X = 0
    expect(wadDiv(0n, b)).toBe(0n);

    // X / 0 throws
    expect(() => wadDiv(a, 0n)).toThrow("Division by zero");
  });

  it("calculates ln(WAD) and logarithmic powers", () => {
    // ln(1.0) = 0
    expect(lnWad(WAD)).toBe(0n);

    // ln(<= 0) throws
    expect(() => lnWad(0n)).toThrow("Negative logarithm input");
    expect(() => lnWad(-1n)).toThrow("Negative logarithm input");

    // ln(2.0) should be close to LN_2 (693_147_180_559_945_309)
    const ln2 = lnWad(2n * WAD);
    const diff = ln2 > 693_147_180_559_945_309n ? ln2 - 693_147_180_559_945_309n : 693_147_180_559_945_309n - ln2;
    expect(diff < 100_000_000n).toBe(true);
  });
});

describe("Market Parameters & Fee Curves", () => {
  it("calculates tau in years as WAD", () => {
    const now = 1_000_000n;
    const maturity = now + SECONDS_PER_YEAR; // exactly 1 year
    expect(calculateTauWad(now, maturity)).toBe(WAD);

    // already matured
    expect(calculateTauWad(now, now - 100n)).toBe(0n);
    expect(calculateTauWad(now, now)).toBe(0n);
  });

  it("calculates fee rate with min and max clamping", () => {
    const annualFee = 50_000_000_000_000_000n; // 5%
    // tau = 0 yields MIN_FEE_RATE
    expect(calculateFeeRate(0n, annualFee)).toBe(200_000_000_000_000n);

    // tau = 100 years clamps to MAX_FEE_RATE
    expect(calculateFeeRate(100n * WAD, annualFee)).toBe(10_000_000_000_000_000n);
  });

  it("validates market proportions within 4% and 96%", () => {
    // 50% PT, 50% SY -> safe
    expect(() => checkMarketProportion(50n * WAD, 50n * WAD)).not.toThrow();

    // 2% PT, 98% SY -> out of bounds
    expect(() => checkMarketProportion(2n * WAD, 98n * WAD)).toThrow("safety bounds");

    // zero reserves throw
    expect(() => checkMarketProportion(0n, 100n * WAD)).toThrow("AMM reserves would drop to zero");
  });

  it("computes exchange rates and implied APY", () => {
    const totalPt = 50_000n * WAD;
    const totalSy = 50_000n * WAD;
    const tauWad = WAD / 4n; // 0.25 years (3 months)
    const scalarRoot = 10n * WAD;
    const rateAnchor = WAD; // 1.0

    const e = getExchangeRateWad(totalPt, totalSy, tauWad, scalarRoot, rateAnchor);
    expect(e).toBeGreaterThanOrEqual(WAD);

    const apy = calculateImpliedApyPct(e, tauWad);
    expect(apy).toBeGreaterThanOrEqual(0);
  });
});

describe("Units Formatting & Parsing", () => {
  it("formats 7-decimal numbers cleanly with tabular fractions", () => {
    expect(formatUnits(10_000_000n, 7)).toBe("1");
    expect(formatUnits(12_345_670n, 7, 4)).toBe("1.2345");
    expect(formatUnits(500_000n, 7, 4)).toBe("0.05");
    expect(formatUnits(0n, 7)).toBe("0");
    expect(formatUnits(-10_000_000n, 7)).toBe("-1");
  });

  it("safely parses decimal strings into 7-decimal BigInts", () => {
    expect(parseUnitsSafe("1.0", 7)).toBe(10_000_000n);
    expect(parseUnitsSafe("0.25", 7)).toBe(2_500_000n);
    expect(parseUnitsSafe("12.34567", 7)).toBe(123_456_700n);
    expect(parseUnitsSafe("100", 7)).toBe(1_000_000_000n);

    // Invalid inputs return null
    expect(parseUnitsSafe("abc", 7)).toBeNull();
    expect(parseUnitsSafe("-1.5", 7)).toBeNull();
    expect(parseUnitsSafe("1.23456789", 7)).toBeNull(); // exceeds 7 decimals
    expect(parseUnitsSafe("", 7)).toBeNull();
    expect(parseUnitsSafe("0", 7)).toBeNull();
  });

  it("applies slippage tolerance correctly", () => {
    // 1000 with 50 bps (0.5%) = 995
    expect(applySlippage(1000n, 50)).toBe(995n);
    // 1000 with 100 bps (1.0%) = 990
    expect(applySlippage(1000n, 100)).toBe(990n);
    // slippage floor is at least 1n
    expect(applySlippage(0n, 50)).toBe(1n);
  });

  it("shortens stellar addresses and hashes", () => {
    const addr = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
    expect(shortenAddress(addr, 4, 4)).toBe("GAWW...ME27");
    expect(shortenAddress("SHORT")).toBe("SHORT");
  });
});

describe("Soroban Error Decoding", () => {
  it("decodes contract error codes into human-readable messages", () => {
    expect(decodeSorobanError("ContractError(4)")).toContain("Amount must be strictly greater than zero");
    expect(decodeSorobanError("HostError: Error(Contract, #9)")).toContain("Output fell below your slippage tolerance");
    expect(decodeSorobanError("op_no_trust")).toContain("missing Testnet USDC trustline");
    expect(decodeSorobanError("User declined signature")).toContain("cancelled by user");
  });
});

describe("Local AMM Swap Quotes", () => {
  const dummyState: MarketStateRaw = {
    total_pt_reserve: 120_000n * WAD,
    total_sy_reserve: 80_000n * WAD,
    total_lp_supply: 100_000n * WAD,
    scalar_root: 10n * WAD,
    initial_anchor: 1_050_000_000_000_000_000n, // 1.05 WAD anchor
    annual_fee_rate: 10_000_000_000_000_000n, // 1%
    protocol_fee_bps: 1000n, // 10%
    fee_recipient: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
    maturity: 2_000_000_000n,
    maturity_index: WAD,
    is_settled: false,
  };

  const now = 1_900_000_000n; // before maturity

  it("quotes sy_for_pt swap accurately", () => {
    const amountIn = 100n * WAD;
    const quote = quoteSwapLocal(dummyState, "sy_for_pt", amountIn, now, 50);

    expect(quote.direction).toBe("sy_for_pt");
    expect(quote.amountIn).toBe(amountIn);
    expect(quote.estimatedOut).toBeGreaterThan(0n);
    expect(quote.minOutWithSlippage).toBeLessThanOrEqual(quote.estimatedOut);
    expect(quote.effectiveExchangeRate).toBeGreaterThan(0);
  });

  it("quotes pt_for_sy swap accurately", () => {
    const amountIn = 100n * WAD;
    const quote = quoteSwapLocal(dummyState, "pt_for_sy", amountIn, now, 50);

    expect(quote.direction).toBe("pt_for_sy");
    expect(quote.amountIn).toBe(amountIn);
    expect(quote.estimatedOut).toBeGreaterThan(0n);
    expect(quote.minOutWithSlippage).toBeLessThanOrEqual(quote.estimatedOut);
  });

  it("quotes sy_for_yt swap accurately", () => {
    const amountIn = 10n * WAD;
    const quote = quoteSwapLocal(dummyState, "sy_for_yt", amountIn, now, 50);

    expect(quote.direction).toBe("sy_for_yt");
    expect(quote.amountIn).toBe(amountIn);
    expect(quote.estimatedOut).toBeGreaterThan(0n);
    expect(quote.minOutWithSlippage).toBeLessThanOrEqual(quote.estimatedOut);
  });

  it("quotes yt_for_sy swap accurately", () => {
    const amountIn = 10n * WAD;
    const quote = quoteSwapLocal(dummyState, "yt_for_sy", amountIn, now, 50);

    expect(quote.direction).toBe("yt_for_sy");
    expect(quote.amountIn).toBe(amountIn);
    expect(quote.estimatedOut).toBeGreaterThan(0n);
    expect(quote.minOutWithSlippage).toBeLessThanOrEqual(quote.estimatedOut);
  });
});
