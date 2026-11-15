// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { CONTRACT_ERROR_MESSAGES, decodeSorobanError, HORIZON_ERROR_MESSAGES } from "../math";

describe("Soroban & Horizon Error Decoding Suite", () => {
  describe("Soroban Smart Contract Errors 1..20", () => {
    it("contains descriptive human-readable definitions for all 20 contract errors", () => {
      for (let code = 1; code <= 20; code++) {
        expect(CONTRACT_ERROR_MESSAGES[code]).toBeDefined();
        expect(typeof CONTRACT_ERROR_MESSAGES[code]).toBe("string");
        expect(CONTRACT_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
      }
    });

    it("decodes ContractError codes formatted in various RPC exception formats", () => {
      // Format 1: ContractError(N)
      expect(decodeSorobanError("ContractError(4)")).toContain("Amount must be strictly greater than zero");

      // Format 2: HostError: Error(Contract, #N)
      expect(decodeSorobanError("HostError: Error(Contract, #5)")).toContain("Insufficient token or pool reserve balance");

      // Format 3: Error(Contract, #N)
      expect(decodeSorobanError("Error(Contract, #9)")).toContain("Output fell below your slippage tolerance limit");

      // Format 4: ContractError #14 (proportion bounds)
      expect(decodeSorobanError("ContractError #14")).toContain("4%-96% bounds");

      // Format 5: Reentrancy locked (#17)
      expect(decodeSorobanError("HostError: Error(Contract, #17)")).toContain("Reentrancy guard rejected nested contract call");

      // Format 6: Negative yield (#18)
      expect(decodeSorobanError("Error(Contract, #18)")).toContain("Negative implied yield is not supported");

      // Format 7: Division by zero (#20)
      expect(decodeSorobanError("ContractError(20)")).toContain("Division by zero in fixed-point math");
    });
  });

  describe("Horizon & Stellar Core Result Codes", () => {
    it("decodes transaction sequence mismatch (tx_bad_seq)", () => {
      const decoded = decodeSorobanError("Horizon submission failed: tx_bad_seq");
      expect(decoded).toContain("sequence number is stale or invalid");
    });

    it("decodes authorization failure (tx_bad_auth)", () => {
      const decoded = decodeSorobanError("Transaction rejected: tx_bad_auth");
      expect(decoded).toContain("authorization failed");
    });

    it("decodes fee insufficiency (tx_insufficient_fee & tx_insufficient_balance)", () => {
      expect(decodeSorobanError("tx_insufficient_fee")).toContain("Transaction fee is lower than the network minimum");
      expect(decodeSorobanError("tx_insufficient_balance")).toContain("insufficient native XLM balance for fees");
    });

    it("decodes time boundary constraints (tx_too_early & tx_too_late)", () => {
      expect(decodeSorobanError("tx_too_early")).toContain("before its valid time window");
      expect(decodeSorobanError("tx_too_late")).toContain("expired before ledger inclusion");
    });

    it("decodes operation failure codes", () => {
      expect(decodeSorobanError("op_underfunded")).toContain("balance is insufficient");
      expect(decodeSorobanError("op_low_reserve")).toContain("insufficient XLM reserve");
      expect(decodeSorobanError("op_no_trust")).toContain("missing Testnet USDC trustline");
      expect(decodeSorobanError("op_already_exists")).toContain("Trustline or entry already exists");
      expect(decodeSorobanError("op_no_destination")).toContain("does not exist on Stellar");
      expect(decodeSorobanError("op_line_full")).toContain("trustline limit would be exceeded");
    });

    it("decodes Soroban resource limits and expired storage", () => {
      expect(decodeSorobanError("RESOURCE_LIMIT_EXCEEDED")).toContain("exceeded Soroban CPU or memory resource limits");
      expect(decodeSorobanError("ENTRY_EXPIRED")).toContain("storage entry has expired");
      expect(decodeSorobanError("FEE_TOO_LOW")).toContain("fee bid is too low");
    });
  });

  describe("Wallet Cancellation & Fallback Handling", () => {
    it("gracefully decodes wallet user rejections", () => {
      expect(decodeSorobanError("User declined access in wallet")).toBe("Wallet signature request was cancelled by user.");
      expect(decodeSorobanError("User rejected the signing request")).toBe("Wallet signature request was cancelled by user.");
      expect(decodeSorobanError("Signature modal cancelled")).toBe("Wallet signature request was cancelled by user.");
    });

    it("truncates excessively long unmapped raw error strings to under 225 chars", () => {
      const longError = "A".repeat(400);
      const decoded = decodeSorobanError(longError);
      expect(decoded.length).toBeLessThanOrEqual(223);
      expect(decoded.endsWith("...")).toBe(true);
    });
  });
});
