// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import {
  CONTRACT_ERROR_MESSAGES,
  HORIZON_ERROR_MESSAGES,
  decodeSorobanError,
  validateAmountInput,
  validateSlippage,
} from "../math";

describe("Adversarial Empirical Challenge Suite: M2/M3 Frontend Hardening", () => {
  describe("Adversarial Amount Validation & Precision Fuzzing", () => {
    it("rejects negative amount '-0.0000001'", () => {
      const res = validateAmountInput("-0.0000001", 7);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Amount cannot be negative");
    });

    it("rejects zero amount '0' and zero-padded '0.0000000'", () => {
      const res1 = validateAmountInput("0", 7);
      expect(res1.valid).toBe(false);
      expect(res1.error).toBe("Amount must be strictly greater than zero");

      const res2 = validateAmountInput("0.0000000", 7);
      expect(res2.valid).toBe(false);
      expect(res2.error).toBe("Amount must be strictly greater than zero");
    });

    it("rejects precision exceeding 7 decimal places ('0.00000001' with 8 decimals)", () => {
      const res = validateAmountInput("0.00000001", 7);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Precision cannot exceed 7 decimal places");
    });

    it("rejects scientific notation '1e-8' and '1e7'", () => {
      const res1 = validateAmountInput("1e-8", 7);
      expect(res1.valid).toBe(false);
      expect(res1.error).toBe("Please enter a valid numeric amount");

      const res2 = validateAmountInput("1e7", 7);
      expect(res2.valid).toBe(false);
      expect(res2.error).toBe("Please enter a valid numeric amount");
    });

    it("rejects non-numeric literal 'NaN'", () => {
      const res = validateAmountInput("NaN", 7);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Please enter a valid numeric amount");
    });

    it("rejects non-numeric literal 'Infinity' and '-Infinity'", () => {
      const res1 = validateAmountInput("Infinity", 7);
      expect(res1.valid).toBe(false);
      expect(res1.error).toBe("Please enter a valid numeric amount");

      const res2 = validateAmountInput("-Infinity", 7);
      expect(res2.valid).toBe(false);
      expect(res2.error).toBe("Amount cannot be negative");
    });

    it("rejects whitespace-only strings '   '", () => {
      const res = validateAmountInput("   ", 7);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Amount is required");
    });

    it("rejects arbitrary alphabetic input 'abc'", () => {
      const res = validateAmountInput("abc", 7);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("Please enter a valid numeric amount");
    });

    it("safely handles extremely large numbers (10^25) without precision loss", () => {
      const bigNumStr = "10000000000000000000000000"; // 10^25
      const resWithoutBalance = validateAmountInput(bigNumStr, 7);
      expect(resWithoutBalance.valid).toBe(true);
      expect(resWithoutBalance.amount).toBe(100000000000000000000000000000000n); // 10^32 stroops

      // When balance constraint is applied (e.g. 100 USDC = 1_000_000_000 stroops)
      const resWithBalance = validateAmountInput(bigNumStr, 7, 1_000_000_000n);
      expect(resWithBalance.valid).toBe(false);
      expect(resWithBalance.error).toBe("Insufficient balance");
      expect(resWithBalance.amount).toBe(100000000000000000000000000000000n);
    });

    it("handles boundary 1-stroop minimum '0.0000001' cleanly", () => {
      const res = validateAmountInput("0.0000001", 7);
      expect(res.valid).toBe(true);
      expect(res.amount).toBe(1n);
      expect(res.error).toBeUndefined();
    });
  });

  describe("Pre-Flight Balance Delta Verification (±1 Stroop)", () => {
    const balanceStroops = 10_000_000n; // 1.0000000 tokens

    it("accepts balance - 1 stroop (0.9999999 tokens)", () => {
      const res = validateAmountInput("0.9999999", 7, balanceStroops);
      expect(res.valid).toBe(true);
      expect(res.amount).toBe(9_999_999n);
      expect(res.error).toBeUndefined();
    });

    it("accepts exact balance (1.0000000 tokens)", () => {
      const res = validateAmountInput("1.0000000", 7, balanceStroops);
      expect(res.valid).toBe(true);
      expect(res.amount).toBe(10_000_000n);
      expect(res.error).toBeUndefined();
    });

    it("rejects balance + 1 stroop (1.0000001 tokens) with 'Insufficient balance'", () => {
      const res = validateAmountInput("1.0000001", 7, balanceStroops);
      expect(res.valid).toBe(false);
      expect(res.amount).toBe(10_000_001n);
      expect(res.error).toBe("Insufficient balance");
    });

    it("evaluates string balance representation with exact stroop boundaries", () => {
      const stringBal = "25.5000000";
      // balance - 1 stroop
      const below = validateAmountInput("25.4999999", 7, stringBal);
      expect(below.valid).toBe(true);
      expect(below.amount).toBe(254_999_999n);

      // exact balance
      const exact = validateAmountInput("25.5000000", 7, stringBal);
      expect(exact.valid).toBe(true);
      expect(exact.amount).toBe(255_000_000n);

      // balance + 1 stroop
      const above = validateAmountInput("25.5000001", 7, stringBal);
      expect(above.valid).toBe(false);
      expect(above.error).toBe("Insufficient balance");
    });
  });

  describe("Slippage Tolerance Adversarial Stress Matrix", () => {
    it("rejects 0 bps slippage", () => {
      const res = validateSlippage(0);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("rejects negative slippage (-10 bps)", () => {
      const res = validateSlippage(-10);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("accepts 501 bps slippage with high-slippage warning", () => {
      const res = validateSlippage(501);
      expect(res.valid).toBe(true);
      expect(res.isHigh).toBe(true);
      expect(res.warning).toBe("High slippage tolerance (>5%). Your transaction may be frontrun.");
    });

    it("accepts upper bound 1000 bps slippage with high-slippage warning", () => {
      const res = validateSlippage(1000);
      expect(res.valid).toBe(true);
      expect(res.isHigh).toBe(true);
      expect(res.warning).toBe("High slippage tolerance (>5%). Your transaction may be frontrun.");
    });

    it("rejects out-of-range slippage (5001 bps / 50.01%)", () => {
      const res = validateSlippage(5001);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("accepts lower bound 1 bps slippage without warning", () => {
      const res = validateSlippage(1);
      expect(res.valid).toBe(true);
      expect(res.isHigh).toBeUndefined();
      expect(res.warning).toBeUndefined();
    });

    it("accepts warning threshold 500 bps (5.00%) without warning", () => {
      const res = validateSlippage(500);
      expect(res.valid).toBe(true);
      expect(res.isHigh).toBeUndefined();
      expect(res.warning).toBeUndefined();
    });

    it("rejects 1001 bps slippage (10.01%)", () => {
      const res = validateSlippage(1001);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
    });
  });

  describe("Error Decoding Oracle: ContractError (1..20) & Horizon Result Codes", () => {
    it("empirically verifies all 20 ContractError codes decode to clear, non-empty, human-readable strings", () => {
      for (let code = 1; code <= 20; code++) {
        const rawMsg = CONTRACT_ERROR_MESSAGES[code];
        expect(rawMsg).toBeDefined();
        expect(typeof rawMsg).toBe("string");
        expect(rawMsg.length).toBeGreaterThan(15);

        // Test decoding via standard Soroban RPC exception string format
        const rpcPayload = `HostError: Error(Contract, #${code})`;
        const decoded = decodeSorobanError(rpcPayload);
        expect(decoded).toBe(`Soroban ContractError #${code}: ${rawMsg}`);

        // Test decoding via ContractError(#N) format
        const altPayload = `ContractError(${code})`;
        const altDecoded = decodeSorobanError(altPayload);
        expect(altDecoded).toBe(`Soroban ContractError #${code}: ${rawMsg}`);
      }
    });

    it("empirically verifies key Horizon & Stellar Core error codes decode to clear, non-empty messages", () => {
      const expectedCodes: (keyof typeof HORIZON_ERROR_MESSAGES)[] = [
        "tx_bad_seq",
        "tx_bad_auth",
        "tx_insufficient_fee",
        "tx_insufficient_balance",
        "tx_too_early",
        "tx_too_late",
        "op_underfunded",
        "op_low_reserve",
        "op_no_trust",
        "op_line_full",
        "RESOURCE_LIMIT_EXCEEDED",
        "ENTRY_EXPIRED",
        "FEE_TOO_LOW",
      ];

      for (const code of expectedCodes) {
        const expected = HORIZON_ERROR_MESSAGES[code];
        expect(expected).toBeDefined();
        expect(expected.length).toBeGreaterThan(15);

        const decoded = decodeSorobanError(`Transaction failed with Horizon result: ${code}`);
        expect(decoded).toBe(expected);
      }
    });

    it("safely decodes unrecognized contract error codes gracefully", () => {
      const unkDecoded = decodeSorobanError("Error(Contract, #99)");
      expect(unkDecoded).toBe("Soroban ContractError #99: Unknown contract error code.");
    });
  });
});
