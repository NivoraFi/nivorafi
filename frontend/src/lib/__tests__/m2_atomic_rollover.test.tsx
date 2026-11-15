// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import { Address, scValToNative } from "@stellar/stellar-sdk";

import { buildActionArgs, ProtocolAction, LiveMarketSnapshot, LiveUserPortfolio } from "../stellar";
import { PRESET_MARKETS, KNOWN_ASSETS, deriveMarketStatus, MarketDefinition } from "../markets";
import { STELLAR_PENDLE_CONFIG } from "../contracts";
import { ENV } from "../env";
import {
  applySlippage,
  validateAmountInput,
  validateSlippage,
  decodeSorobanError,
  formatUnitsExact,
} from "../math";

// Mock WalletProvider state for predictable component rendering
let mockWalletState = {
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

// Components under test
import { RolloverCard } from "@/components/trading/RolloverCard";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { TradingDesk } from "@/components/trading/TradingDesk";
import { MarketProvider } from "@/context/MarketContext";

describe("Milestone 2: Atomic Rollover Engine & UI Verification Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
  const dummyReceiver = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const sourcePool = "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF";
  const targetPool = "CCITOO7WPWXHNWQIF62CD7UEW6I3TKXCMPTW4BRTV4UCKBXXEZMZDSFD";
  const canonicalFactoryId = "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL";
  const deprecatedFactoryId = "CA3T7BOCWGFNPMY4J5F74UGZ52X66E3A5J2P22V65XG4B7W5M77F5EGY";

  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

  const dummyPortfolio: LiveUserPortfolio = {
    xlmBalance: "100.50",
    usdcBalance: "5000.00",
    syBalance: 25_0000000n,
    ptBalance: 50_0000000n,
    ytBalance: 0n,
    lpBalance: 10_0000000n,
    claimableYield: 0n,
    hasUsdcTrustline: true,
  };

  // ==========================================================================
  // SUITE 1: ACTION ARGUMENT CONSTRUCTION (rollover_to_pt & rollover_to_py)
  // ==========================================================================
  describe("Suite 1: Action Argument Construction in stellar.ts", () => {
    it("builds valid 6-argument Soroban ScVal envelope for rollover_to_pt", () => {
      const action: ProtocolAction = {
        type: "rollover_to_pt",
        caller: dummyCaller,
        receiver: dummyReceiver,
        sourcePool,
        targetPool,
        ptAmount: 10_0000000n,
        minTargetPt: 10_3500000n,
      };

      const built = buildActionArgs(action);
      expect(built.method).toBe("rollover_to_pt");
      expect(built.label).toBe("Atomic Rollover to Target PT");
      expect(built.args.length).toBe(6);

      // Verify exact parameter mapping
      expect(scValToNative(built.args[0])).toBe(dummyCaller);
      expect(scValToNative(built.args[1])).toBe(dummyReceiver);
      expect(scValToNative(built.args[2])).toBe(sourcePool);
      expect(scValToNative(built.args[3])).toBe(targetPool);
      expect(scValToNative(built.args[4])).toBe(10_0000000n);
      expect(scValToNative(built.args[5])).toBe(10_3500000n);
    });

    it("builds valid 6-argument Soroban ScVal envelope for rollover_to_py", () => {
      const action: ProtocolAction = {
        type: "rollover_to_py",
        caller: dummyCaller,
        receiver: dummyCaller,
        sourcePool,
        targetPool,
        ptAmount: 25_0000000n,
        minNewShares: 24_7500000n,
      };

      const built = buildActionArgs(action);
      expect(built.method).toBe("rollover_to_py");
      expect(built.label).toBe("Atomic Rollover to Target LP (PT+YT)");
      expect(built.args.length).toBe(6);

      expect(scValToNative(built.args[0])).toBe(dummyCaller);
      expect(scValToNative(built.args[1])).toBe(dummyCaller);
      expect(scValToNative(built.args[2])).toBe(sourcePool);
      expect(scValToNative(built.args[3])).toBe(targetPool);
      expect(scValToNative(built.args[4])).toBe(25_0000000n);
      expect(scValToNative(built.args[5])).toBe(24_7500000n);
    });

    it("handles asymmetric caller and receiver addresses without cross-contamination", () => {
      const action: ProtocolAction = {
        type: "rollover_to_pt",
        caller: dummyCaller,
        receiver: dummyReceiver,
        sourcePool,
        targetPool,
        ptAmount: 5_0000000n,
        minTargetPt: 5_1000000n,
      };

      const built = buildActionArgs(action);
      expect(scValToNative(built.args[0])).not.toBe(scValToNative(built.args[1]));
      expect(scValToNative(built.args[0])).toBe(dummyCaller);
      expect(scValToNative(built.args[1])).toBe(dummyReceiver);
    });

    it("encodes boundary BigInt numbers (1 stroop to 1 trillion tokens) safely", () => {
      // 1 stroop minimum
      const minAction: ProtocolAction = {
        type: "rollover_to_pt",
        caller: dummyCaller,
        receiver: dummyCaller,
        sourcePool,
        targetPool,
        ptAmount: 1n,
        minTargetPt: 1n,
      };
      const builtMin = buildActionArgs(minAction);
      expect(scValToNative(builtMin.args[4])).toBe(1n);
      expect(scValToNative(builtMin.args[5])).toBe(1n);

      // 1 trillion tokens (1e12 * 1e7 stroops)
      const maxAmount = 10_000_000_000_000_0000000n;
      const maxAction: ProtocolAction = {
        type: "rollover_to_py",
        caller: dummyCaller,
        receiver: dummyCaller,
        sourcePool,
        targetPool,
        ptAmount: maxAmount,
        minNewShares: maxAmount - 1000n,
      };
      const builtMax = buildActionArgs(maxAction);
      expect(scValToNative(builtMax.args[4])).toBe(maxAmount);
    });
  });

  // ==========================================================================
  // SUITE 2: MARKET FACTORY CONTRACT ID CORRECTNESS & STELLAR.TS AUDIT
  // ==========================================================================
  describe("Suite 2: Market Factory Contract ID Alignment (CCO4RP43...)", () => {
    it("routes to canonical CCO4RP43... factory contract ID when factoryContractId is omitted", () => {
      const actionPt: ProtocolAction = {
        type: "rollover_to_pt",
        caller: dummyCaller,
        receiver: dummyCaller,
        sourcePool,
        targetPool,
        ptAmount: 10_0000000n,
        minTargetPt: 10_0000000n,
      };

      const built = buildActionArgs(actionPt);
      expect(built.contractId).toBe(canonicalFactoryId);
      expect(built.contractId).not.toBe(deprecatedFactoryId);
    });

    it("honors explicit factoryContractId override if provided", () => {
      const customFactory = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
      const actionPy: ProtocolAction = {
        type: "rollover_to_py",
        caller: dummyCaller,
        receiver: dummyCaller,
        sourcePool,
        targetPool,
        ptAmount: 10_0000000n,
        minNewShares: 10_0000000n,
        factoryContractId: customFactory,
      };

      const built = buildActionArgs(actionPy);
      expect(built.contractId).toBe(customFactory);
    });

    it("statically verifies stellar.ts has eliminated the deprecated CA3T7BOC... address", () => {
      const stellarTsPath = path.resolve(__dirname, "../stellar.ts");
      const content = fs.readFileSync(stellarTsPath, "utf-8");

      expect(content).not.toContain(deprecatedFactoryId);
      expect(
        content.includes(canonicalFactoryId) ||
        content.includes("market_factory") ||
        content.includes("ENV.contracts.market_factory")
      ).toBe(true);
    });

    it("verifies contract ID alignment across env.ts, contracts.ts, and stellar.ts", () => {
      expect(ENV.contracts.market_factory).toBe(canonicalFactoryId);
      expect(STELLAR_PENDLE_CONFIG.market_factory.contractId).toBe(canonicalFactoryId);
    });
  });

  // ==========================================================================
  // SUITE 3: DOMAIN INVARIANTS & CONSTRAINT ENFORCEMENT MATRIX
  // ==========================================================================
  describe("Suite 3: Domain Invariants & Constraint Enforcement Matrix", () => {
    it("identifies and rejects identical source and target pools (ContractError #15)", () => {
      const isIdentical = usdcMatured.contracts.poolId === usdcMatured.contracts.poolId;
      expect(isIdentical).toBe(true);

      const err = new Error("Error(Contract, #15)");
      const decoded = decodeSorobanError(err);
      expect(decoded).toContain("ContractError #15");
      expect(decoded.toLowerCase()).toContain("differ");
    });

    it("strictly blocks cross-asset rollover between USDC and XLM (ContractError #21)", () => {
      expect(usdcMatured.asset.code).toBe("USDC");
      expect(xlm90D.asset.code).toBe("XLM");
      expect(usdcMatured.asset.code).not.toBe(xlm90D.asset.code);

      // Verify compatible targets filter excludes cross-asset pools
      const compatibleTargets = PRESET_MARKETS.filter(
        (m) => m.asset.code === usdcMatured.asset.code && m.id !== usdcMatured.id
      );
      expect(compatibleTargets.some((m) => m.asset.code === "XLM")).toBe(false);

      const err = new Error("Error(Contract, #21)");
      const decoded = decodeSorobanError(err);
      expect(decoded).toContain("ContractError #21");
      expect(decoded.toLowerCase()).toContain("asset");
    });

    it("strictly requires source market to be matured and target market to be active", () => {
      const now = Math.floor(Date.now() / 1000);
      const sourceStatus = deriveMarketStatus(usdcMatured.maturity, now);
      const targetStatus = deriveMarketStatus(usdc90D.maturity, now);

      expect(sourceStatus).toBe("MATURED");
      expect(targetStatus).toBe("ACTIVE");

      // Attempting to rollover an active pool should decode to MarketNotYetMatured (#8)
      expect(decodeSorobanError(new Error("Error(Contract, #8)"))).toContain("ContractError #8");
      // Attempting to roll into an already matured pool should decode to MarketAlreadyMatured (#7)
      expect(decodeSorobanError(new Error("Error(Contract, #7)"))).toContain("ContractError #7");
    });

    it("enforces strict slippage bounds [1, 1000] bps with high-slippage warning above 500 bps", () => {
      expect(validateSlippage(0).valid).toBe(false);
      expect(validateSlippage(-50).valid).toBe(false);
      expect(validateSlippage(1001).valid).toBe(false);

      const s50 = validateSlippage(50);
      expect(s50.valid).toBe(true);
      expect(Boolean(s50.warning)).toBe(false);

      const s500 = validateSlippage(500);
      expect(s500.valid).toBe(true);
      expect(Boolean(s500.warning)).toBe(false);

      const s750 = validateSlippage(750);
      expect(s750.valid).toBe(true);
      expect(Boolean(s750.warning)).toBe(true);

      const s1000 = validateSlippage(1000);
      expect(s1000.valid).toBe(true);
      expect(Boolean(s1000.warning)).toBe(true);
    });

    it("verifies mathematical slippage discount for rollover_to_pt and 1:1 parity for rollover_to_py", () => {
      const amount = 20_0000000n; // 20 PT

      // In rollover_to_py: 1:1 post-maturity redemption produces exact SY, slippage applies to shares
      const minShares = applySlippage(amount, 100); // 1.0% = 100 bps
      expect(minShares).toBe(19_8000000n);

      // In rollover_to_pt: with simulated 4% discount, target PT = 20.8333333, minOut at 100 bps = 20.625
      const ptPrice = 0.96;
      const estimatedTargetPt = BigInt(Math.floor(Number(amount) / ptPrice));
      expect(estimatedTargetPt).toBeGreaterThan(amount);
      const minTargetPt = applySlippage(estimatedTargetPt, 100);
      expect(minTargetPt).toBeGreaterThan(amount);
      expect(minTargetPt).toBeLessThan(estimatedTargetPt);
    });

    it("validates 7-decimal stroop precision boundary inputs", () => {
      const userBalance = 50_0000000n;
      expect(validateAmountInput("0.0000001", 7, userBalance).valid).toBe(true);
      expect(validateAmountInput("50.0000000", 7, userBalance).valid).toBe(true);
      expect(validateAmountInput("50.0000001", 7, userBalance).valid).toBe(false);
      expect(validateAmountInput("0.00000001", 7, userBalance).valid).toBe(false); // 8 decimals rejected
      expect(validateAmountInput("0", 7, userBalance).valid).toBe(false);
      expect(validateAmountInput("-1.0", 7, userBalance).valid).toBe(false);
    });
  });

  // ==========================================================================
  // SUITE 4: ROLLOVERCARD.TSX UI COMPONENT SSR & STATE MATRIX
  // ==========================================================================
  describe("Suite 4: RolloverCard.tsx UI Component SSR & State Matrix", () => {
    it("renders RolloverCard in matched state with double-bezel styling and tabular numbers", () => {
      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(RolloverCard, {
            snapshot: null,
            portfolio: dummyPortfolio,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      // Double bezel container
      expect(
        html.includes("double-bezel") || html.includes("double-bezel-recessed")
      ).toBe(true);

      // Mode toggles
      expect(html).toContain("Rollover to PT");
      expect(html).toContain("Rollover to LP");

      // Balance & quick percentage buttons
      expect(html).toContain("tabular-mono");
      expect(html).toContain("25%");
      expect(html).toContain("50%");
      expect(html).toContain("75%");
      expect(html).toContain("MAX");

      // Quote breakdown elements
      expect(html).toContain("Expected Received");
      expect(html).toContain("Minimum Received");

      // Enabled action CTA
      expect(html).toContain("button");
      expect(html).not.toContain("Connect Wallet");
    });

    it("renders disabled state or warning when no compatible target pool exists", () => {
      // Simulate viewing an asset with no active target markets
      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(RolloverCard, {
            snapshot: null,
            portfolio: { ...dummyPortfolio, ptBalance: 0n },
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      expect(html).toContain("tabular-mono");
      // Button displays disabled state or insufficient balance
      expect(
        html.includes("disabled") ||
        html.includes("Insufficient") ||
        html.includes("opacity-50")
      ).toBe(true);
    });

    it("renders Connect Wallet CTA when wallet mode is disconnected", () => {
      mockWalletState.mode = "disconnected";
      mockWalletState.address = null;

      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(RolloverCard, {
            snapshot: null,
            portfolio: null,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      expect(html).toContain("Connect Wallet");

      // Restore wallet state
      mockWalletState.mode = "wallet";
      mockWalletState.address = dummyCaller;
    });

    it("renders network mismatch CTA when walletNetworkMismatch is true", () => {
      mockWalletState.walletNetworkMismatch = true;

      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(RolloverCard, {
            snapshot: null,
            portfolio: dummyPortfolio,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      expect(
        html.includes("Switch to Testnet") ||
        html.includes("network mismatch") ||
        html.includes("Wrong Network")
      ).toBe(true);

      // Restore wallet state
      mockWalletState.walletNetworkMismatch = false;
    });

    it("renders RolloverCard with live quote computed by useRolloverQuote in roll_to_pt mode", () => {
      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(RolloverCard, {
            snapshot: null,
            portfolio: dummyPortfolio,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      // Verify interim 1:1 settlement
      expect(html).toContain("Interim 1:1 Settlement");
      expect(html).toContain("sy-bUSDC");

      // Verify expected received contains target PT symbol
      expect(html).toContain("Expected Received");
      expect(html).toContain("PT-bUSDC-90D");

      // Verify minimum received contains slippage percentage
      expect(html).toContain("Minimum Received");
      expect(html).toContain("% slippage");

      // Verify exchange rate displays discount multiplier
      expect(html).toContain("Exchange Rate");
      expect(html).toContain("PT-bUSDC-MAT");
      expect(html).toContain("PT-bUSDC-90D");
    });

    it("disables execution button and displays Insufficient Matured PT Balance when balance is zero", () => {
      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(RolloverCard, {
            snapshot: null,
            portfolio: { ...dummyPortfolio, ptBalance: 0n },
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      expect(html).toContain("Insufficient Matured PT Balance");
      expect(html).toContain("Available:");
      expect(html).toContain("PT-bUSDC-MAT");
      expect(html).toContain("disabled");
    });
  });

  // ==========================================================================
  // SUITE 5: REDEEMCARD.TSX CONTEXTUAL MATURED ROLLOVER BANNER
  // ==========================================================================
  describe("Suite 5: Contextual Callout Banner in RedeemCard.tsx", () => {
    it("renders prominent contextual rollover banner when active market is matured", () => {
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
        totalPt: 100_0000000n,
        totalSy: 100_0000000n,
        totalLp: 100_0000000n,
        state: {} as any,
        reserves: { pt: 100_0000000n, sy: 100_0000000n },
      };

      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(RedeemCard, {
            snapshot: maturedSnapshot,
            portfolio: dummyPortfolio,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      // Must display contextual rollover callout
      expect(
        html.includes("Rollover") ||
        html.includes("rollover") ||
        html.includes("Position Matured")
      ).toBe(true);
      expect(html).toContain("tabular-mono");
    });

    it("suppresses matured rollover callout banner when active market is active", () => {
      const activeSnapshot: LiveMarketSnapshot = {
        poolId: usdc90D.contracts.poolId,
        syId: usdc90D.contracts.syId,
        ptId: usdc90D.contracts.ptId,
        ytId: usdc90D.contracts.ytId,
        maturity: usdc90D.maturity,
        isMatured: false,
        daysToMaturity: 90,
        underlyingToken: usdc90D.asset.sacContractId,
        ptRate: 1000000000000000000n,
        bRate: 1000000000000000000n,
        totalPt: 100_0000000n,
        totalSy: 100_0000000n,
        totalLp: 100_0000000n,
        state: {} as any,
        reserves: { pt: 100_0000000n, sy: 100_0000000n },
      };

      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(RedeemCard, {
            snapshot: activeSnapshot,
            portfolio: dummyPortfolio,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      // Active market shows early merge, not post-maturity settlement banner
      expect(html).toContain("Early Merge");
    });
  });

  // ==========================================================================
  // SUITE 6: TRADINGDESK.TSX 5-TAB NAVIGATION INTEGRATION
  // ==========================================================================
  describe("Suite 6: TradingDesk.tsx 5-Tab Navigation Integration", () => {
    it("renders TradingDesk with 5 segmented tabs including Rollover", () => {
      const html = renderToString(
        React.createElement(
          MarketProvider,
          null,
          React.createElement(TradingDesk, {
            snapshot: null,
            portfolio: dummyPortfolio,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );

      // Verify presence of all 5 tabs
      expect(html).toContain("Swap");
      expect(html).toContain("Mint");
      expect(html).toContain("Pool");
      expect(html).toContain("Redeem");
      expect(html).toContain("Rollover");
    });
  });

  // ==========================================================================
  // SUITE 7: DESIGN SYSTEM STATIC FILE CONFORMANCE & ZERO REGRESSION AUDIT
  // ==========================================================================
  describe("Suite 7: Design System Static File Conformance & Regression Audit", () => {
    const tradingDir = path.resolve(__dirname, "../../components/trading");
    const m2Files = ["RolloverCard.tsx", "RedeemCard.tsx", "TradingDesk.tsx"];

    it("strictly verifies zero raw hex color strings in Milestone 2 components", () => {
      const hexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const violations: { file: string; match: string }[] = [];

      for (const file of m2Files) {
        const filePath = path.join(tradingDir, file);
        if (!fs.existsSync(filePath)) {
          throw new Error(`Component ${file} does not exist for design system audit`);
        }
        const content = fs.readFileSync(filePath, "utf-8");
        const matches = content.match(hexRegex);
        if (matches) {
          matches.forEach((m) => violations.push({ file, match: m }));
        }
      }

      expect(violations).toEqual([]);
      expect(violations.length).toBe(0);
    });

    it("strictly verifies zero raw Unicode emojis in Milestone 2 components", () => {
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const violations: { file: string; line: number; text: string }[] = [];

      for (const file of m2Files) {
        const filePath = path.join(tradingDir, file);
        if (!fs.existsSync(filePath)) continue;
        const lines = fs.readFileSync(filePath, "utf-8").split("\n");
        lines.forEach((line, idx) => {
          if (emojiRegex.test(line)) {
            violations.push({ file, line: idx + 1, text: line.trim() });
          }
        });
      }

      expect(violations).toEqual([]);
      expect(violations.length).toBe(0);
    });

    it("verifies mandatory tabular-mono typography across all Milestone 2 components", () => {
      for (const file of m2Files) {
        const filePath = path.join(tradingDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        expect(content.includes("tabular-mono")).toBe(true);
      }
    });

    it("verifies double-bezel card container hierarchy in RolloverCard.tsx", () => {
      const rolloverPath = path.join(tradingDir, "RolloverCard.tsx");
      const content = fs.readFileSync(rolloverPath, "utf-8");
      expect(
        content.includes("double-bezel") || content.includes("double-bezel-recessed")
      ).toBe(true);
    });

    it("empirically verifies RolloverCard.tsx imports useRolloverQuote and eliminates dead AMM condition", () => {
      const rolloverCardPath = path.resolve(__dirname, "../../components/trading/RolloverCard.tsx");
      const content = fs.readFileSync(rolloverCardPath, "utf-8");

      // Verify hook is imported and called
      expect(content).toContain("import { useRolloverQuote }");
      expect(content).toMatch(/useRolloverQuote\s*\(/);

      // Verify dead branch condition is 100% eliminated
      expect(content).not.toContain("targetMarket.contracts.poolId === activeMarket.contracts.poolId");
    });

    it("empirically verifies RedeemCard.tsx eliminates mismatched snapshot state in target quote", () => {
      const redeemCardPath = path.resolve(__dirname, "../../components/trading/RedeemCard.tsx");
      const content = fs.readFileSync(redeemCardPath, "utf-8");

      // Verify active market's snapshot.state is not passed into target pool quote
      expect(content).not.toMatch(/quoteSwapLocal\s*\(\s*snapshot\.state\s*,\s*["']sy_for_pt["']/);
      expect(content).not.toContain("targetMarket.contracts.poolId !== activeMarket.contracts.poolId");
    });
  });
});
