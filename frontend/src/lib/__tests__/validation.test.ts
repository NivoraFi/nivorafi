// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { formatUnitsExact, validateAmountInput, validateSlippage } from "../math";

describe("Form Input Validation & Sanitization Suite", () => {
  describe("validateAmountInput - Syntax & Precision", () => {
    it("safely accepts and parses valid positive numbers within 7 decimals", () => {
      const res1 = validateAmountInput("1.0", 7);
      expect(res1.valid).toBe(true);
      expect(res1.amount).toBe(10_000_000n);
      expect(res1.error).toBeUndefined();

      const res2 = validateAmountInput("0.25", 7);
      expect(res2.valid).toBe(true);
      expect(res2.amount).toBe(2_500_000n);

      const res3 = validateAmountInput("0.0000001", 7);
      expect(res3.valid).toBe(true);
      expect(res3.amount).toBe(1n);

      const res4 = validateAmountInput("123.4567890", 7);
      expect(res4.valid).toBe(true);
      expect(res4.amount).toBe(1_234_567_890n);
    });

    it("rejects empty or whitespace-only strings", () => {
      const empty = validateAmountInput("", 7);
      expect(empty.valid).toBe(false);
      expect(empty.error).toBe("Amount is required");

      const spaces = validateAmountInput("   ", 7);
      expect(spaces.valid).toBe(false);
      expect(spaces.error).toBe("Amount is required");
    });

    it("rejects negative numbers with a descriptive error", () => {
      const negInt = validateAmountInput("-5", 7);
      expect(negInt.valid).toBe(false);
      expect(negInt.error).toBe("Amount cannot be negative");

      const negDec = validateAmountInput("-0.0000001", 7);
      expect(negDec.valid).toBe(false);
      expect(negDec.error).toBe("Amount cannot be negative");
    });

    it("rejects zero and near-zero values", () => {
      const zero = validateAmountInput("0", 7);
      expect(zero.valid).toBe(false);
      expect(zero.error).toBe("Amount must be strictly greater than zero");

      const zeroDec = validateAmountInput("0.0000000", 7);
      expect(zeroDec.valid).toBe(false);
      expect(zeroDec.error).toBe("Amount must be strictly greater than zero");
    });

    it("rejects non-numeric characters and multiple decimals", () => {
      const text = validateAmountInput("abc", 7);
      expect(text.valid).toBe(false);
      expect(text.error).toBe("Please enter a valid numeric amount");

      const multiDot = validateAmountInput("1.2.3", 7);
      expect(multiDot.valid).toBe(false);
      expect(multiDot.error).toBe("Please enter a valid numeric amount");

      const scientific = validateAmountInput("1e7", 7);
      expect(scientific.valid).toBe(false);
      expect(scientific.error).toBe("Please enter a valid numeric amount");
    });

    it("strictly rejects precision exceeding 7 decimal places", () => {
      const eightDecimals = validateAmountInput("0.12345678", 7);
      expect(eightDecimals.valid).toBe(false);
      expect(eightDecimals.error).toBe("Precision cannot exceed 7 decimal places");

      const tenDecimals = validateAmountInput("1.0000000001", 7);
      expect(tenDecimals.valid).toBe(false);
      expect(tenDecimals.error).toBe("Precision cannot exceed 7 decimal places");
    });
  });

  describe("validateAmountInput - Pre-Flight Balance Verification", () => {
    it("passes when parsed amount is less than or equal to user balance", () => {
      // Balance as bigint
      const resBigInt = validateAmountInput("5.0", 7, 50_000_000n);
      expect(resBigInt.valid).toBe(true);
      expect(resBigInt.amount).toBe(50_000_000n);
      expect(resBigInt.error).toBeUndefined();

      // Balance as human decimal string (e.g. from portfolio.usdcBalance)
      const resString = validateAmountInput("12.5", 7, "20.0");
      expect(resString.valid).toBe(true);
      expect(resString.amount).toBe(125_000_000n);
      expect(resString.error).toBeUndefined();
    });

    it("rejects with 'Insufficient balance' when amount exceeds balance", () => {
      // Exceeds bigint balance
      const resBigInt = validateAmountInput("10.0", 7, 50_000_000n); // 10.0 > 5.0
      expect(resBigInt.valid).toBe(false);
      expect(resBigInt.amount).toBe(100_000_000n);
      expect(resBigInt.error).toBe("Insufficient balance");

      // Exceeds string balance
      const resString = validateAmountInput("100.0", 7, "99.99");
      expect(resString.valid).toBe(false);
      expect(resString.error).toBe("Insufficient balance");
    });

    it("handles zero balance correctly", () => {
      const resZeroBigInt = validateAmountInput("1.0", 7, 0n);
      expect(resZeroBigInt.valid).toBe(false);
      expect(resZeroBigInt.error).toBe("Insufficient balance");

      const resZeroString = validateAmountInput("0.5", 7, "0.0");
      expect(resZeroString.valid).toBe(false);
      expect(resZeroString.error).toBe("Insufficient balance");
    });
  });

  describe("validateSlippage - Bounds & Types", () => {
    it("accepts valid slippage tolerances between 1 bps and 1000 bps", () => {
      expect(validateSlippage(1).valid).toBe(true); // 0.01%
      expect(validateSlippage(25).valid).toBe(true); // 0.25%
      expect(validateSlippage(50).valid).toBe(true); // 0.50%
      expect(validateSlippage(100).valid).toBe(true); // 1.00%
      expect(validateSlippage(1000).valid).toBe(true); // 10.00%
    });

    it("rejects slippage below 1 bps (0.01%)", () => {
      const res0 = validateSlippage(0);
      expect(res0.valid).toBe(false);
      expect(res0.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");

      const resNeg = validateSlippage(-50);
      expect(resNeg.valid).toBe(false);
      expect(resNeg.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("rejects slippage exceeding 1000 bps (10.0%)", () => {
      const res1001 = validateSlippage(1001);
      expect(res1001.valid).toBe(false);
      expect(res1001.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");

      const resHuge = validateSlippage(5000); // 50%
      expect(resHuge.valid).toBe(false);
      expect(resHuge.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("rejects NaN or non-number slippage", () => {
      const resNaN = validateSlippage(NaN);
      expect(resNaN.valid).toBe(false);
      expect(resNaN.error).toBe("Slippage must be a valid number");
    });

    it("surfaces a high-slippage warning when slippage exceeds 500 bps (5.0%)", () => {
      const normal = validateSlippage(500); // exactly 5.0%
      expect(normal.valid).toBe(true);
      expect(normal.isHigh).toBeUndefined();
      expect(normal.warning).toBeUndefined();

      const high501 = validateSlippage(501); // 5.01%
      expect(high501.valid).toBe(true);
      expect(high501.isHigh).toBe(true);
      expect(high501.warning).toContain("High slippage tolerance (>5%)");

      const maxAllowed = validateSlippage(1000); // 10.0%
      expect(maxAllowed.valid).toBe(true);
      expect(maxAllowed.isHigh).toBe(true);
      expect(maxAllowed.warning).toContain("High slippage tolerance (>5%)");
    });
  });

  describe("formatUnitsExact - 7-Decimal Stroop Precision", () => {
    it("preserves all 7 decimal places without 4-decimal truncation", () => {
      // 1.2345678 tokens (12,345,678 stroops)
      const exact = formatUnitsExact(12_345_678n, 7);
      expect(exact).toBe("1.2345678");

      // Small dust balance below 0.0001 (500 stroops = 0.00005)
      const dust = formatUnitsExact(500n, 7);
      expect(dust).toBe("0.00005");

      // Exact integer representation
      const whole = formatUnitsExact(10_000_000n, 7);
      expect(whole).toBe("1");
    });
  });
});
