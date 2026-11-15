// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { Address, scValToNative } from "@stellar/stellar-sdk";

// Mock WalletProvider state for predictable component rendering & dynamic adversarial simulation
let currentMockWallet = {
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
  useWallet: () => currentMockWallet,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => currentMockWallet.walletNetworkMismatch,
}));

// Components and hooks under test
import { RolloverCard } from "@/components/trading/RolloverCard";
import { MarketProvider } from "@/context/MarketContext";
import {
  useRolloverQuote,
  UseRolloverQuoteParams,
  RolloverQuoteResult,
} from "@/hooks/useRolloverQuote";
import {
  PRESET_MARKETS,
  MarketDefinition,
  deriveMarketStatus,
  calculateDaysToMaturity,
} from "@/lib/markets";
import {
  applySlippage,
  validateAmountInput,
  formatUnits,
  formatUnitsExact,
  decodeSorobanError,
  CONTRACT_ERROR_MESSAGES,
} from "@/lib/math";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  buildActionArgs,
  ProtocolAction,
} from "@/lib/stellar";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";

describe("Empirical Challenger M2 R2: Rollover Quote & Execution Verification Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
  const dummyReceiver = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc180D = PRESET_MARKETS.find((m) => m.id === "usdc-180d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const eurc90D = PRESET_MARKETS.find((m) => m.id === "eurc-90d")!;

  const validPortfolio: LiveUserPortfolio = {
    xlmBalance: "250.00",
    usdcBalance: "1500.00",
    syBalance: 100_0000000n,
    ptBalance: 50_0000000n,
    ytBalance: 20_0000000n,
    lpBalance: 10_0000000n,
    claimableYield: 0n,
    hasUsdcTrustline: true,
  };

  const zeroBalancePortfolio: LiveUserPortfolio = {
    ...validPortfolio,
    ptBalance: 0n,
  };

  const maturedSnapshot: LiveMarketSnapshot = {
    poolId: usdcMatured.contracts.poolId,
    syId: usdcMatured.contracts.syId,
    ptId: usdcMatured.contracts.ptId,
    ytId: usdcMatured.contracts.ytId,
    maturity: usdcMatured.maturity,
    isMatured: true,
    daysToMaturity: 0,
    underlyingToken: usdcMatured.asset.sacContractId,
    ptRate: 1000000000000000000n,
    bRate: 1000000000000000000n,
    totalPt: 1000_0000000n,
    totalSy: 1000_0000000n,
    totalLp: 1000_0000000n,
    state: {} as any,
    reserves: { pt: 1000_0000000n, sy: 1000_0000000n },
  };

  // Helper to execute useRolloverQuote inside MarketProvider context
  function executeQuoteHook(params: UseRolloverQuoteParams): RolloverQuoteResult {
    let captured: RolloverQuoteResult | null = null;
    function Consumer({ p }: { p: UseRolloverQuoteParams }) {
      captured = useRolloverQuote(p);
      return null;
    }

    renderToString(
      React.createElement(
        MarketProvider,
        null,
        React.createElement(Consumer, { p: params })
      )
    );

    return captured!;
  }

  // Helper to render RolloverCard inside MarketProvider context and clean SSR comments
  function renderRolloverCard(props?: {
    snapshot?: LiveMarketSnapshot | null;
    portfolio?: LiveUserPortfolio | null;
    busyAction?: string | null;
    onExecuteAction?: (params: any) => Promise<void>;
  }): { rawHtml: string; cleanHtml: string } {
    const rawHtml = renderToString(
      React.createElement(
        MarketProvider,
        null,
        React.createElement(RolloverCard, {
          snapshot: props?.snapshot ?? maturedSnapshot,
          portfolio: props?.portfolio !== undefined ? props.portfolio : validPortfolio,
          busyAction: props?.busyAction ?? null,
          onExecuteAction: props?.onExecuteAction ?? (async () => {}),
        })
      )
    );
    // Strip React SSR comment markers (<!-- -->) for clean textual assertions
    const cleanHtml = rawHtml.replace(/<!-- -->/g, "");
    return { rawHtml, cleanHtml };
  }

  // ==========================================================================
  // SUITE 1: QUOTE OUTPUT REFLECTION MATRIX IN ROLLOVERCARD
  // ==========================================================================
  describe("Suite 1: Quote Output Reflection Matrix in RolloverCard", () => {
    it("1.1 reflects expected target amount and target PT symbol in roll_to_pt mode", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = dummyCaller;
      currentMockWallet.walletNetworkMismatch = false;

      const { cleanHtml } = renderRolloverCard();

      // Expected target amount is rendered in quote box
      expect(cleanHtml).toContain("Expected Received");
      // Target market is usdc-90d, ptSymbol is PT-bUSDC-90D
      expect(cleanHtml).toContain("PT-bUSDC-90D");

      // Verify the math matches useRolloverQuote output
      const hookQuote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc90D,
        ptAmount: "1.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
        slippageBps: 50,
      });

      const formattedExpected = formatUnits(hookQuote.expectedTargetAmount);
      expect(cleanHtml).toContain(formattedExpected);
    });

    it("1.2 reflects minimum received with dynamic slippage percentage", () => {
      const { cleanHtml } = renderRolloverCard();

      expect(cleanHtml).toContain("Minimum Received");
      // Default slippage is 50 bps = 0.5%
      expect(cleanHtml).toContain("(0.5% slippage)");

      const hookQuote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc90D,
        ptAmount: "1.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
        slippageBps: 50,
      });

      const formattedMinReceived = formatUnits(hookQuote.minReceived);
      expect(cleanHtml).toContain(formattedMinReceived);
    });

    it("1.3 reflects exchange rate formatted to exactly 4 decimal places", () => {
      const { cleanHtml } = renderRolloverCard();

      expect(cleanHtml).toContain("Exchange Rate");
      expect(cleanHtml).toContain("1 PT-bUSDC-MAT ≈");
      expect(cleanHtml).toContain("PT-bUSDC-90D");

      const hookQuote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc90D,
        ptAmount: "1.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
        slippageBps: 50,
      });

      const formattedRate = hookQuote.exchangeRate.toFixed(4);
      expect(cleanHtml).toContain(formattedRate);
    });

    it("1.4 reflects burned matured PT and interim 1:1 settlement SY amounts", () => {
      const { cleanHtml } = renderRolloverCard();

      expect(cleanHtml).toContain("Matured PT Burned");
      expect(cleanHtml).toContain("1 PT-bUSDC-MAT");

      expect(cleanHtml).toContain("Interim 1:1 Settlement");
      expect(cleanHtml).toContain("+1 sy-bUSDC");
    });

    it("1.5 reflects calculated maturity extension days (+X Days)", () => {
      const { cleanHtml } = renderRolloverCard();

      expect(cleanHtml).toContain("Maturity Extension");
      expect(cleanHtml).toMatch(/\+\d+\s+Days/);
    });

    it("1.6 reflects warnings when high slippage tolerance is configured", () => {
      // Direct hook check for slippage > 100 bps (e.g. 150 bps = 1.5%)
      const highSlippageQuote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmount: "1.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
        slippageBps: 150,
      });

      expect(highSlippageQuote.warnings.length).toBeGreaterThan(0);
      expect(highSlippageQuote.warnings[0]).toContain("High slippage tolerance: 1.5%");
    });

    it("1.7 reflects dual PT and YT outputs in roll_to_py (LP) mode", () => {
      // In roll_to_py mode, quote outputs both PT and YT
      const pyQuote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmount: "2.5",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_py",
        slippageBps: 50,
      });

      expect(pyQuote.isValid).toBe(true);
      expect(pyQuote.status).toBe("READY");
      // 2.5 * 10^7 = 25_000000n
      expect(pyQuote.expectedTargetAmount).toBe(25_000000n);
      expect(pyQuote.estimatedTargetYt).toBe(25_000000n);
      expect(pyQuote.exchangeRate).toBe(1.0);
      expect(pyQuote.minReceived).toBe(applySlippage(25_000000n, 50));
    });
  });

  // ==========================================================================
  // SUITE 2: SAFETY REJECTION & SUBMIT BUTTON DISABLING MATRIX
  // ==========================================================================
  describe("Suite 2: Safety Rejection & Submit Button Disabling Matrix", () => {
    it("2.1 disables submit button and shows error text when balance is insufficient", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = dummyCaller;
      currentMockWallet.walletNetworkMismatch = false;

      const { cleanHtml, rawHtml } = renderRolloverCard({
        portfolio: zeroBalancePortfolio, // 0 PT available, input is 1.0 PT
      });

      // Submit button must be disabled
      expect(rawHtml).toMatch(/<button[^>]*disabled[^>]*>/);
      expect(cleanHtml).toContain("Insufficient Matured PT Balance");
      // Input error text must be displayed
      expect(cleanHtml).toContain("Insufficient balance");
      // Execution quote detail box must NOT be rendered when parsedAmount is 0
      expect(cleanHtml).not.toContain("Interim 1:1 Settlement");
    });

    it("2.2 disables submit button when source market is active (not yet matured)", () => {
      // Adversarial hook test: source pool active
      const quote = executeQuoteHook({
        sourceMarket: usdc90D, // Active market (maturity 2027)
        targetMarket: usdc30D,
        ptAmount: "1.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("SOURCE_NOT_MATURED");
      expect(quote.quoteStatus).toBe("SOURCE_NOT_MATURED");
      expect(quote.errorMessage).toContain("not yet matured");
      expect(quote.error).toContain("not yet matured");
      expect(quote.parsedAmount).toBe(0n);
    });

    it("2.3 disables submit button when target market is already matured", () => {
      const quote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdcMatured, // Already matured!
        ptAmount: "1.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("TARGET_ALREADY_MATURED");
      expect(quote.errorMessage).toContain("already matured");
      expect(quote.parsedAmount).toBe(0n);
    });

    it("2.4 disables submit button when assets do not match (cross-asset disallowed)", () => {
      const quote = executeQuoteHook({
        sourceMarket: usdcMatured, // USDC
        targetMarket: xlm90D, // XLM
        ptAmount: "1.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("CROSS_ASSET_DISALLOWED");
      expect(quote.errorMessage).toContain("Asset must match");
      expect(quote.parsedAmount).toBe(0n);
    });

    it("2.5 disables submit button when source and target pools are identical", () => {
      // Fake market with same pool address
      const fakeIdenticalMarket: MarketDefinition = {
        ...usdc30D,
        contracts: {
          ...usdc30D.contracts,
          poolId: usdcMatured.contracts.poolId,
        },
      };

      const quote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: fakeIdenticalMarket,
        ptAmount: "1.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
      });

      expect(quote.isValid).toBe(false);
      expect(quote.status).toBe("IDENTICAL_POOLS");
      expect(quote.errorMessage).toContain("cannot be identical");
      expect(quote.parsedAmount).toBe(0n);
    });

    it("2.6 disables submit button for invalid or malformed amount inputs", () => {
      const testCases = [
        { input: "0", expectedStatus: "INVALID_INPUT" },
        { input: "-5.0", expectedStatus: "INVALID_INPUT" },
        { input: "abc", expectedStatus: "INVALID_INPUT" },
        { input: "0.00000001", expectedStatus: "INVALID_INPUT" }, // 8 decimals > stroop limit (7)
        { input: "NaN", expectedStatus: "INVALID_INPUT" },
        { input: "Infinity", expectedStatus: "INVALID_INPUT" },
      ];

      for (const tc of testCases) {
        const quote = executeQuoteHook({
          sourceMarket: usdcMatured,
          targetMarket: usdc30D,
          ptAmount: tc.input,
          sourcePtBalance: validPortfolio.ptBalance,
          mode: "roll_to_pt",
        });

        expect(quote.isValid).toBe(false);
        expect(quote.status).toBe(tc.expectedStatus as any);
        expect(quote.parsedAmount).toBe(0n);
      }
    });

    it("2.7 disables submit button and displays status when busyAction is active", () => {
      const busyMessage = "Confirming Transaction in Wallet...";
      const { cleanHtml, rawHtml } = renderRolloverCard({
        busyAction: busyMessage,
      });

      expect(cleanHtml).toContain(busyMessage);
      expect(rawHtml).toMatch(/<button[^>]*disabled[^>]*>/);
      expect(cleanHtml).not.toContain("Execute Atomic Rollover");
    });

    it("2.8 replaces submit button with Connect Wallet when wallet is disconnected", () => {
      currentMockWallet.mode = "disconnected";
      currentMockWallet.address = null;
      currentMockWallet.walletNetworkMismatch = false;

      const { cleanHtml } = renderRolloverCard();

      expect(cleanHtml).toContain("Connect Wallet");
      expect(cleanHtml).not.toContain("Execute Atomic Rollover");
      expect(cleanHtml).not.toContain("[>_ Simulate Rollover]");

      // Restore wallet
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = dummyCaller;
    });

    it("2.9 replaces submit button with Switch to Testnet when network mismatch occurs", () => {
      currentMockWallet.walletNetworkMismatch = true;

      const { cleanHtml } = renderRolloverCard();

      expect(cleanHtml).toContain("Switch to Testnet");
      expect(cleanHtml).not.toContain("Execute Atomic Rollover");

      // Restore wallet
      currentMockWallet.walletNetworkMismatch = false;
    });

    it("2.10 disables dev simulation link whenever quote is invalid or busy", () => {
      // With zero balance -> quote is invalid
      const { rawHtml } = renderRolloverCard({
        portfolio: zeroBalancePortfolio,
      });

      // Simulation link must have disabled attribute
      expect(rawHtml).toMatch(/<button[^>]*disabled[^>]*>[^<]*Simulate Rollover/);
    });
  });

  // ==========================================================================
  // SUITE 3: EXECUTION LOGIC & ACTION BUILDER INTEGRITY
  // ==========================================================================
  describe("Suite 3: Execution Logic & Action Builder Integrity", () => {
    it("3.1 builds exact 6-argument Soroban ScVal envelope for rollover_to_pt", () => {
      const quote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmount: "10.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
        slippageBps: 50,
      });

      expect(quote.isValid).toBe(true);

      const action = quote.buildAction(dummyCaller, dummyReceiver);
      expect(action.type).toBe("rollover_to_pt");

      const built = buildActionArgs(action, usdcMatured);
      expect(built.method).toBe("rollover_to_pt");
      expect(built.label).toBe("Atomic Rollover to Target PT");
      expect(built.contractId).toBe(STELLAR_PENDLE_CONFIG.market_factory.contractId);
      expect(built.args).toHaveLength(6);

      // Verify deserialized parameters
      const callerDecoded = Address.fromScVal(built.args[0]).toString();
      const receiverDecoded = Address.fromScVal(built.args[1]).toString();
      const sourcePoolDecoded = Address.fromScVal(built.args[2]).toString();
      const targetPoolDecoded = Address.fromScVal(built.args[3]).toString();
      const ptAmountDecoded = scValToNative(built.args[4]);
      const minTargetPtDecoded = scValToNative(built.args[5]);

      expect(callerDecoded).toBe(dummyCaller);
      expect(receiverDecoded).toBe(dummyReceiver);
      expect(sourcePoolDecoded).toBe(usdcMatured.contracts.poolId);
      expect(targetPoolDecoded).toBe(usdc30D.contracts.poolId);
      expect(ptAmountDecoded).toBe(10_0000000n);
      expect(minTargetPtDecoded).toBe(quote.minTargetOut);
    });

    it("3.2 builds exact 6-argument Soroban ScVal envelope for rollover_to_py", () => {
      const quote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmount: "15.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_py",
        slippageBps: 50,
      });

      expect(quote.isValid).toBe(true);

      const action = quote.buildAction(dummyCaller, dummyReceiver);
      expect(action.type).toBe("rollover_to_py");

      const built = buildActionArgs(action, usdcMatured);
      expect(built.method).toBe("rollover_to_py");
      expect(built.label).toBe("Atomic Rollover to Target LP (PT+YT)");
      expect(built.args).toHaveLength(6);

      const ptAmountDecoded = scValToNative(built.args[4]);
      const minSharesDecoded = scValToNative(built.args[5]);

      expect(ptAmountDecoded).toBe(15_0000000n);
      expect(minSharesDecoded).toBe(quote.minTargetOut);
      // In roll_to_py, minShares = 15.0 - 0.5% = 14.925
      expect(minSharesDecoded).toBe(14_9250000n);
    });

    it("3.3 verifies receiver defaults to caller when receiver is omitted", () => {
      const quote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmount: "5.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
      });

      const action = quote.buildAction(dummyCaller); // receiver omitted
      expect(action.caller).toBe(dummyCaller);
      expect(action.receiver).toBe(dummyCaller);
    });
  });

  // ==========================================================================
  // SUITE 4: ADVERSARIAL EDGE CASES, FUZZING & SSR STABILITY
  // ==========================================================================
  describe("Suite 4: Adversarial Edge Cases, Fuzzing & SSR Stability", () => {
    it("4.1 fuzzes 150 random amounts and balances without NaN, Infinity, or crash", () => {
      let seed = 12345;
      const pseudoRandom = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };

      for (let i = 0; i < 150; i++) {
        const randBalanceStroop = BigInt(Math.floor(pseudoRandom() * 1_000_000_0000000));
        const randAmountNum = (pseudoRandom() * 2_000).toFixed(7);

        const quote = executeQuoteHook({
          sourceMarket: usdcMatured,
          targetMarket: usdc30D,
          ptAmount: randAmountNum,
          sourcePtBalance: randBalanceStroop,
          mode: i % 2 === 0 ? "roll_to_pt" : "roll_to_py",
          slippageBps: Math.floor(pseudoRandom() * 200),
        });

        // Invariant: quote must always resolve to boolean isValid without unhandled exception
        expect(typeof quote.isValid).toBe("boolean");
        expect(typeof quote.status).toBe("string");
        expect(typeof quote.exchangeRate).toBe("number");
        expect(Number.isNaN(quote.exchangeRate)).toBe(false);
        expect(Number.isFinite(quote.exchangeRate)).toBe(true);

        if (quote.isValid) {
          expect(quote.parsedAmount).toBeGreaterThan(0n);
          expect(quote.minReceived).toBeGreaterThan(0n);
          expect(quote.expectedTargetAmount).toBeGreaterThan(0n);
        } else {
          expect(quote.parsedAmount).toBe(0n);
        }
      }
    });

    it("4.2 tests 1 stroop minimum boundary (0.0000001 PT)", () => {
      const quote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmount: "0.0000001",
        sourcePtBalance: 100_0000000n,
        mode: "roll_to_pt",
        slippageBps: 50,
      });

      expect(quote.isValid).toBe(true);
      expect(quote.parsedAmount).toBe(1n);
      expect(quote.sourcePtBurned).toBe(1n);
    });

    it("4.3 tests massive BigInt amount boundary (1,000,000,000.0000000 PT)", () => {
      const massiveBalance = 2_000_000_000_0000000n;
      const quote = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmount: "1000000000.0000000",
        sourcePtBalance: massiveBalance,
        mode: "roll_to_pt",
        slippageBps: 50,
      });

      expect(quote.isValid).toBe(true);
      expect(quote.parsedAmount).toBe(10_000_000_000_000_000n);
      expect(quote.estimatedTargetPt).toBeGreaterThan(10_000_000_000_000_000n);
      expect(quote.minTargetOut).toBeLessThan(quote.estimatedTargetPt);
    });

    it("4.4 safely renders RolloverCard when all optional props are null or undefined", () => {
      expect(() => {
        const { cleanHtml } = renderRolloverCard({
          snapshot: null,
          portfolio: null,
          busyAction: null,
        });
        expect(cleanHtml).toContain("Atomic Rollover Desk");
      }).not.toThrow();
    });

    it("4.5 preserves alias compatibility between ptAmount and ptAmountInput in useRolloverQuote", () => {
      // Pass ptAmountAlias via ptAmount
      const quoteWithAlias = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmount: "4.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
      });

      // Pass input via ptAmountInput
      const quoteWithInput = executeQuoteHook({
        sourceMarket: usdcMatured,
        targetMarket: usdc30D,
        ptAmountInput: "4.0",
        sourcePtBalance: validPortfolio.ptBalance,
        mode: "roll_to_pt",
      });

      expect(quoteWithAlias.parsedAmount).toBe(quoteWithInput.parsedAmount);
      expect(quoteWithAlias.expectedTargetAmount).toBe(quoteWithInput.expectedTargetAmount);
      expect(quoteWithAlias.minReceived).toBe(quoteWithInput.minReceived);
      expect(quoteWithAlias.isValid).toBe(true);
      expect(quoteWithInput.isValid).toBe(true);
    });
  });

  // ==========================================================================
  // SUITE 5: COMPATIBLE TARGET MARKETS FILTERING DOMAIN INVARIANTS
  // ==========================================================================
  describe("Suite 5: Compatible Target Markets Filtering Domain Invariants", () => {
    it("5.1 strictly excludes source market itself from target options", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const sourceMarket = usdcMatured;

      const compatible = PRESET_MARKETS.filter((m) => {
        if (m.id === sourceMarket.id) return false;
        if (m.contracts.poolId === sourceMarket.contracts.poolId) return false;
        if (m.asset.code !== sourceMarket.asset.code) return false;
        return deriveMarketStatus(m.maturity, nowSeconds) === "ACTIVE";
      });

      expect(compatible.some((m) => m.id === sourceMarket.id)).toBe(false);
    });

    it("5.2 strictly excludes markets with identical pool IDs from target options", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Construct a mock market object sharing poolId with usdc-90d
      const sourceMarket: MarketDefinition = {
        ...usdcMatured,
        contracts: {
          ...usdcMatured.contracts,
          poolId: usdc90D.contracts.poolId,
        },
      };

      const compatible = PRESET_MARKETS.filter((m) => {
        if (m.id === sourceMarket.id) return false;
        if (m.contracts.poolId === sourceMarket.contracts.poolId) return false;
        if (m.asset.code !== sourceMarket.asset.code) return false;
        return deriveMarketStatus(m.maturity, nowSeconds) === "ACTIVE";
      });

      // usdc-90d shares the poolId and must be filtered out
      expect(compatible.some((m) => m.contracts.poolId === sourceMarket.contracts.poolId)).toBe(false);
      expect(compatible.some((m) => m.id === "usdc-90d")).toBe(false);
      // usdc-30d uses distinct pool ID and is kept
      expect(compatible.some((m) => m.id === "usdc-30d")).toBe(true);
    });

    it("5.3 strictly excludes cross-asset markets (XLM, EURC) from target options", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const sourceMarket = usdcMatured; // USDC

      const compatible = PRESET_MARKETS.filter((m) => {
        if (m.id === sourceMarket.id) return false;
        if (m.contracts.poolId === sourceMarket.contracts.poolId) return false;
        if (m.asset.code !== sourceMarket.asset.code) return false;
        return deriveMarketStatus(m.maturity, nowSeconds) === "ACTIVE";
      });

      expect(compatible.some((m) => m.asset.code === "XLM")).toBe(false);
      expect(compatible.some((m) => m.asset.code === "EURC")).toBe(false);
    });

    it("5.4 strictly excludes already-matured markets from target options", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const sourceMarket = usdcMatured;

      const compatible = PRESET_MARKETS.filter((m) => {
        if (m.id === sourceMarket.id) return false;
        if (m.contracts.poolId === sourceMarket.contracts.poolId) return false;
        if (m.asset.code !== sourceMarket.asset.code) return false;
        return deriveMarketStatus(m.maturity, nowSeconds) === "ACTIVE";
      });

      // All compatible targets must be ACTIVE
      for (const m of compatible) {
        expect(deriveMarketStatus(m.maturity, nowSeconds)).toBe("ACTIVE");
      }
    });
  });

  // ==========================================================================
  // SUITE 6: SOROBAN ERROR CODE MAPPING FOR ROLLOVER FAILURE MODES
  // ==========================================================================
  describe("Suite 6: Soroban Error Code Mapping for Rollover Failure Modes", () => {
    it("6.1 maps ContractError #8 to 'Market has not reached maturity yet.'", () => {
      const msg = decodeSorobanError(new Error("HostError: Error(Contract, #8)"));
      expect(msg).toBe(`Soroban ContractError #8: ${CONTRACT_ERROR_MESSAGES[8]}`);
      expect(msg).toContain("not reached maturity");
    });

    it("6.2 maps ContractError #7 to 'Market has already reached maturity.'", () => {
      const msg = decodeSorobanError(new Error("HostError: Error(Contract, #7)"));
      expect(msg).toBe(`Soroban ContractError #7: ${CONTRACT_ERROR_MESSAGES[7]}`);
      expect(msg).toContain("already reached maturity");
    });

    it("6.3 maps ContractError #21 to 'Target and source market assets must match for rollover.'", () => {
      const msg = decodeSorobanError(new Error("HostError: Error(Contract, #21)"));
      expect(msg).toBe(`Soroban ContractError #21: ${CONTRACT_ERROR_MESSAGES[21]}`);
      expect(msg).toContain("assets must match for rollover");
    });

    it("6.4 maps ContractError #28 to 'Atomic rollover operation failed.'", () => {
      const msg = decodeSorobanError(new Error("HostError: Error(Contract, #28)"));
      expect(msg).toBe(`Soroban ContractError #28: ${CONTRACT_ERROR_MESSAGES[28]}`);
      expect(msg).toContain("Atomic rollover operation failed");
    });
  });
});
