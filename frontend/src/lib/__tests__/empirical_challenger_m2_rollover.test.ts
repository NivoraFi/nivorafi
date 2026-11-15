// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { Address, scValToNative } from "@stellar/stellar-sdk";

// Mock WalletProvider state for predictable component rendering
const mockWalletState = {
  address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27" as string | null,
  mode: "wallet" as "disconnected" | "wallet" | "watch",
  walletId: "freighter" as string | null,
  walletNetworkMismatch: false,
  kitReady: true,
  connecting: false,
  connectWallet: async () => {},
  connectWatchAddress: (_pk: string) => {},
  disconnect: async () => {},
  signTransactionXdr: async (xdr: string) => xdr,
  switchNetwork: async () => {},
};

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: (payload?: { networkPassphrase?: string; network?: string } | null) => {
    if (mockWalletState.walletNetworkMismatch) return true;
    if (!payload) return false;
    const targetPassphrase = "Test SDF Network ; September 2015";
    const targetNet = "testnet";
    if (payload.networkPassphrase && payload.networkPassphrase.trim() !== targetPassphrase) {
      return true;
    }
    if (payload.network && payload.network.trim().toLowerCase() !== targetNet) {
      return true;
    }
    return false;
  },
}));

import {
  useRolloverQuote,
  UseRolloverQuoteParams,
  RolloverQuoteResult,
} from "@/hooks/useRolloverQuote";
import { PRESET_MARKETS, MarketDefinition, deriveMarketStatus } from "@/lib/markets";
import { MarketProvider } from "@/context/MarketContext";
import {
  applySlippage,
  validateSlippage,
  validateAmountInput,
  decodeSorobanError,
  CONTRACT_ERROR_MESSAGES,
} from "@/lib/math";
import { buildActionArgs, ProtocolAction } from "@/lib/stellar";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";

describe("Adversarial Empirical Challenge Suite: M2 Atomic Rollover Engine & Math", () => {
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

  const testCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
  const testReceiver = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const canonicalFactory = "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL";

  function runHook(params: UseRolloverQuoteParams): RolloverQuoteResult {
    let captured: RolloverQuoteResult | null = null;
    function TestConsumer({ p }: { p: UseRolloverQuoteParams }) {
      captured = useRolloverQuote(p);
      return null;
    }

    renderToString(
      React.createElement(
        MarketProvider,
        null,
        React.createElement(TestConsumer, { p: params })
      )
    );

    return captured!;
  }

  // ==========================================================================
  // 1. ADVERSARIAL EDGE CASE: SOURCE POOL == TARGET POOL
  // ==========================================================================
  describe("1. Edge Case: Source Pool == Target Pool (Identical Pools)", () => {
    it("rejects when source market and target market have identical poolId in useRolloverQuote", () => {
      // Create clone of usdcMatured with identical poolId
      const fakeIdenticalTarget: MarketDefinition = {
        ...usdc30D,
        contracts: {
          ...usdc30D.contracts,
          poolId: usdcMatured.contracts.poolId, // Same pool ID
        },
      };

      const quote = runHook({
        sourceMarket: usdcMatured,
        targetMarket: fakeIdenticalTarget,
        ptAmountInput: "10.0",
        sourcePtBalance: 50_0000000n,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("IDENTICAL_POOLS");
      expect(quote.errorMessage).toBe("Source and target pools cannot be identical.");
      expect(quote.parsedAmount).toBe(0n);
      expect(quote.minTargetOut).toBe(0n);
    });

    it("verifies ContractError #15 (IdenticalAddresses) decodes appropriately", () => {
      const err = new Error("Error(Contract, #15)");
      const decoded = decodeSorobanError(err);
      expect(decoded).toContain("ContractError #15");
      expect(decoded).toContain("Source and receiver addresses must differ where required.");
    });
  });

  // ==========================================================================
  // 2. ADVERSARIAL EDGE CASE: SOURCE IS NOT MATURED
  // ==========================================================================
  describe("2. Edge Case: Source Market is Not Matured", () => {
    it("strictly rejects rollover when source market is currently active", () => {
      // usdc90D is active (maturity in the future)
      const now = Math.floor(Date.now() / 1000);
      expect(deriveMarketStatus(usdc90D.maturity, now)).toBe("ACTIVE");

      const quote = runHook({
        sourceMarket: usdc90D,
        targetMarket: usdc30D,
        ptAmountInput: "15.0",
        sourcePtBalance: 50_0000000n,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("SOURCE_NOT_MATURED");
      expect(quote.errorMessage).toBe(
        "Source market has not yet matured. Wait for maturity or use Early Merge."
      );
      expect(quote.parsedAmount).toBe(0n);
    });

    it("verifies ContractError #8 (MarketNotYetMatured) decodes appropriately", () => {
      const err = new Error("HostError: Error(Contract, 8)");
      const decoded = decodeSorobanError(err);
      expect(decoded).toContain("ContractError #8");
      expect(decoded).toContain("Market has not reached maturity yet.");
    });
  });

  // ==========================================================================
  // 3. ADVERSARIAL EDGE CASE: TARGET IS ALREADY MATURED
  // ==========================================================================
  describe("3. Edge Case: Target Market is Already Matured", () => {
    it("strictly rejects rollover when target market is already matured", () => {
      const now = Math.floor(Date.now() / 1000);
      expect(deriveMarketStatus(usdcMatured.maturity, now)).toBe("MATURED");

      // Attempting to roll matured into another matured market
      const fakeMaturedTarget: MarketDefinition = {
        ...usdcMatured,
        id: "usdc-matured-2",
        contracts: {
          ...usdcMatured.contracts,
          poolId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        },
      };

      const quote = runHook({
        sourceMarket: usdcMatured,
        targetMarket: fakeMaturedTarget,
        ptAmountInput: "20.0",
        sourcePtBalance: 50_0000000n,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("TARGET_ALREADY_MATURED");
      expect(quote.errorMessage).toBe(
        "Target market has already matured. Choose an active market."
      );
      expect(quote.parsedAmount).toBe(0n);
    });

    it("verifies ContractError #7 (MarketAlreadyMatured) decodes appropriately", () => {
      const err = new Error("HostError: Error(Contract, #7)");
      const decoded = decodeSorobanError(err);
      expect(decoded).toContain("ContractError #7");
      expect(decoded).toContain("Market has already reached maturity.");
    });
  });

  // ==========================================================================
  // 4. ADVERSARIAL EDGE CASE: CROSS-ASSET ROLLOVER (USDC -> XLM / XLM -> USDC)
  // ==========================================================================
  describe("4. Edge Case: Cross-Asset Rollover Disallowed", () => {
    it("strictly rejects rollover between disparate underlying assets (USDC -> XLM)", () => {
      expect(usdcMatured.asset.code).toBe("USDC");
      expect(xlm90D.asset.code).toBe("XLM");

      const quote = runHook({
        sourceMarket: usdcMatured,
        targetMarket: xlm90D,
        ptAmountInput: "10.0",
        sourcePtBalance: 50_0000000n,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("CROSS_ASSET_DISALLOWED");
      expect(quote.errorMessage).toBe("Cannot roll over from USDC to XLM. Asset must match.");
      expect(quote.parsedAmount).toBe(0n);
    });

    it("strictly rejects reverse cross-asset rollover (XLM -> USDC)", () => {
      const fakeMaturedXlm: MarketDefinition = {
        ...xlm90D,
        id: "xlm-matured",
        maturity: 1600000000, // Past
      };

      const quote = runHook({
        sourceMarket: fakeMaturedXlm,
        targetMarket: usdc30D,
        ptAmountInput: "50.0",
        sourcePtBalance: 100_0000000n,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("CROSS_ASSET_DISALLOWED");
      expect(quote.errorMessage).toBe("Cannot roll over from XLM to USDC. Asset must match.");
    });

    it("verifies ContractError #21 (InvalidAsset) decodes appropriately", () => {
      const err = new Error("Error(Contract, #21)");
      const decoded = decodeSorobanError(err);
      expect(decoded).toContain("ContractError #21");
      expect(decoded).toContain("Target and source market assets must match for rollover.");
    });
  });

  // ==========================================================================
  // 5. ADVERSARIAL EDGE CASE: EXTREME SLIPPAGE (0%, >10%, NEGATIVE VALUES)
  // ==========================================================================
  describe("5. Edge Case: Extreme Slippage Validation & Protection Matrix", () => {
    it("rejects 0% slippage (0 bps) via validateSlippage", () => {
      const res = validateSlippage(0);
      expect(res.valid).toBe(false);
      expect(res.error).toBe(
        "Slippage tolerance must be between 0.01% (1 bps) and 10.0% (1000 bps)"
      );
    });

    it("rejects negative slippage values (-1 bps, -10 bps, -50 bps, -1000 bps)", () => {
      const negativeTolerances = [-1, -10, -50, -100, -1000];
      for (const bps of negativeTolerances) {
        const res = validateSlippage(bps);
        expect(res.valid).toBe(false);
        expect(res.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
      }
    });

    it("rejects excessive slippage exceeding 10.0% (> 1000 bps)", () => {
      const excessiveTolerances = [1001, 1500, 2500, 5000, 10000];
      for (const bps of excessiveTolerances) {
        const res = validateSlippage(bps);
        expect(res.valid).toBe(false);
        expect(res.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
      }
    });

    it("rejects non-numeric slippage representations (NaN, Infinity, -Infinity)", () => {
      expect(validateSlippage(NaN).valid).toBe(false);
      // @ts-expect-error testing invalid type
      expect(validateSlippage("50").valid).toBe(false);
      // @ts-expect-error testing invalid type
      expect(validateSlippage(null).valid).toBe(false);
      // @ts-expect-error testing invalid type
      expect(validateSlippage(undefined).valid).toBe(false);
    });

    it("accepts valid slippage bounds [1, 1000] bps and flags high slippage warning (>500 bps)", () => {
      // Lower bound: 1 bps (0.01%)
      const minValid = validateSlippage(1);
      expect(minValid.valid).toBe(true);
      expect(minValid.isHigh).toBeFalsy();

      // Normal defaults: 10, 50, 100, 500 bps
      expect(validateSlippage(10).valid).toBe(true);
      expect(validateSlippage(50).valid).toBe(true);
      expect(validateSlippage(100).valid).toBe(true);
      expect(validateSlippage(500).valid).toBe(true);
      expect(validateSlippage(500).isHigh).toBeFalsy();

      // Warning tier: 501 .. 1000 bps
      const high501 = validateSlippage(501);
      expect(high501.valid).toBe(true);
      expect(high501.isHigh).toBe(true);
      expect(high501.warning).toContain("High slippage tolerance (>5%)");

      const maxAllowed = validateSlippage(1000);
      expect(maxAllowed.valid).toBe(true);
      expect(maxAllowed.isHigh).toBe(true);
      expect(maxAllowed.warning).toContain("High slippage tolerance (>5%)");
    });

    it("verifies mathematical behavior of applySlippage across edge conditions", () => {
      const amount = 100_0000000n; // 100 USDC

      // Valid boundary values
      expect(applySlippage(amount, 1)).toBe(99_9900000n); // 0.01%
      expect(applySlippage(amount, 50)).toBe(99_5000000n); // 0.50%
      expect(applySlippage(amount, 1000)).toBe(90_0000000n); // 10.00%

      // Floor protection: even with extreme 100% or >100% slippage, floor is clamped to 1 stroop (1n)
      expect(applySlippage(amount, 10000)).toBe(1n);
      expect(applySlippage(amount, 20000)).toBe(1n);
      expect(applySlippage(1n, 5000)).toBe(1n);
      expect(applySlippage(0n, 50)).toBe(1n);
    });

    it("verifies ContractError #9 (SlippageExceeded) and #4 (ZeroAmount) decoding", () => {
      // If contract reverts with SlippageExceeded
      const errSlippage = new Error("Error(Contract, #9)");
      expect(decodeSorobanError(errSlippage)).toContain("ContractError #9");
      expect(decodeSorobanError(errSlippage)).toContain(
        "Output fell below your slippage tolerance limit."
      );

      // If negative min_target_pt is passed to contract, contract returns ZeroAmount (#4)
      const errZero = new Error("Error(Contract, 4)");
      expect(decodeSorobanError(errZero)).toContain("ContractError #4");
      expect(decodeSorobanError(errZero)).toContain(
        "Amount must be strictly greater than zero."
      );
    });
  });

  // ==========================================================================
  // 6. ADVERSARIAL ACTION BUILDING & STELLAR ENVELOPE VERIFICATION
  // ==========================================================================
  describe("6. Action Construction & Canonical Factory Resolution in stellar.ts", () => {
    it("uses canonical factory contract CCO4RP43... instead of deprecated CA3T7BOC...", () => {
      const action: ProtocolAction = {
        type: "rollover_to_pt",
        caller: testCaller,
        receiver: testReceiver,
        sourcePool: usdcMatured.contracts.poolId,
        targetPool: usdc30D.contracts.poolId,
        ptAmount: 10_0000000n,
        minTargetPt: 10_2000000n,
      };

      const built = buildActionArgs(action);
      expect(built.contractId).toBe(canonicalFactory);
      expect(built.contractId).not.toBe(
        "CA3T7BOCWGFNPMY4J5F74UGZ52X66E3A5J2P22V65XG4B7W5M77F5EGY"
      );
      expect(built.contractId).toBe(STELLAR_PENDLE_CONFIG.market_factory.contractId);
    });

    it("constructs exact 6 ScVal arguments for rollover_to_pt without leaking caller into receiver", () => {
      const action: ProtocolAction = {
        type: "rollover_to_pt",
        caller: testCaller,
        receiver: testReceiver,
        sourcePool: usdcMatured.contracts.poolId,
        targetPool: usdc30D.contracts.poolId,
        ptAmount: 25_0000000n,
        minTargetPt: 25_5000000n,
      };

      const built = buildActionArgs(action);
      expect(built.method).toBe("rollover_to_pt");
      expect(built.args.length).toBe(6);

      expect(scValToNative(built.args[0])).toBe(testCaller);
      expect(scValToNative(built.args[1])).toBe(testReceiver);
      expect(scValToNative(built.args[2])).toBe(usdcMatured.contracts.poolId);
      expect(scValToNative(built.args[3])).toBe(usdc30D.contracts.poolId);
      expect(scValToNative(built.args[4])).toBe(25_0000000n);
      expect(scValToNative(built.args[5])).toBe(25_5000000n);
    });

    it("constructs exact 6 ScVal arguments for rollover_to_py", () => {
      const action: ProtocolAction = {
        type: "rollover_to_py",
        caller: testCaller,
        receiver: testCaller,
        sourcePool: usdcMatured.contracts.poolId,
        targetPool: usdc30D.contracts.poolId,
        ptAmount: 30_0000000n,
        minNewShares: 29_7000000n,
      };

      const built = buildActionArgs(action);
      expect(built.method).toBe("rollover_to_py");
      expect(built.args.length).toBe(6);

      expect(scValToNative(built.args[0])).toBe(testCaller);
      expect(scValToNative(built.args[1])).toBe(testCaller);
      expect(scValToNative(built.args[2])).toBe(usdcMatured.contracts.poolId);
      expect(scValToNative(built.args[3])).toBe(usdc30D.contracts.poolId);
      expect(scValToNative(built.args[4])).toBe(30_0000000n);
      expect(scValToNative(built.args[5])).toBe(29_7000000n);
    });
  });

  // ==========================================================================
  // 7. INPUT VALIDATION & FUZZING ORACLE
  // ==========================================================================
  describe("7. Adversarial Amount Validation & Precision Fuzzing", () => {
    it("rejects zero, negative, and invalid string inputs with INVALID_INPUT status", () => {
      const adversarialInputs = [
        "0",
        "-1",
        "-0.0000001",
        "abc",
        "NaN",
        "Infinity",
        "",
        "   ",
        "1e-8",
        "0.00000001", // 8 decimals exceeds 7-decimal stroop limit
      ];

      for (const input of adversarialInputs) {
        const quote = runHook({
          sourceMarket: usdcMatured,
          targetMarket: usdc30D,
          ptAmountInput: input,
          sourcePtBalance: 50_0000000n,
          mode: "roll_to_pt",
        });

        expect(quote.isValid).toBe(false);
        expect(quote.status).toBe("INVALID_INPUT");
        expect(quote.parsedAmount).toBe(0n);
      }
    });

    it("rejects inputs exceeding user PT balance with INSUFFICIENT_BALANCE status", () => {
      const balance = 50_0000000n; // 50.0000000 PT

      const quote = runHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmountInput: "50.0000001", // balance + 1 stroop
        sourcePtBalance: balance,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("INSUFFICIENT_BALANCE");
      expect(quote.errorMessage).toBe("Insufficient balance");
    });

    it("accepts exact balance (100% MAX) down to single-stroop boundary", () => {
      const balance = 123_4567890n;

      const quote = runHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmountInput: "123.4567890",
        sourcePtBalance: balance,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(true);
      expect(quote.status).toBe("READY");
      expect(quote.parsedAmount).toBe(balance);
      expect(quote.sourcePtBurned).toBe(balance);
    });
  });
});
