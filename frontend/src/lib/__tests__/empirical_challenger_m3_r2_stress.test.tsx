// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

// Mock WalletProvider state for component tests
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
}));

import { PRESET_MARKETS, MarketDefinition } from "../markets";
import { LiveUserPortfolio, buildActionArgs } from "../stellar";
import { STELLAR_PENDLE_CONFIG } from "../contracts";
import {
  parseMarketPosition,
  aggregatePortfolioTotals,
  MarketPositionItem,
} from "../../hooks/useMultiMarketPortfolio";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { MarketProvider } from "@/context/MarketContext";

describe("Empirical Challenger M3 R2: Integrated Stress Test & Contract Invariants Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
  const dummyCaller2 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

  const renderWithContext = (ui: React.ReactElement) => {
    return renderToString(React.createElement(MarketProvider, null, ui));
  };

  /**
   * Reference implementation matching PortfolioView.tsx:handleClaimAll execution semantics:
   * Sequential iteration over positions, checking pos.claimableYield > 0n, finding market,
   * building action args with buildActionArgs({ type: "claim_yield", caller: address }, m),
   * and awaiting onExecuteAction.
   */
  async function simulateHandleClaimAll(
    positions: MarketPositionItem[],
    address: string | null,
    onExecuteAction?: (params: {
      contractId: string;
      method: string;
      args: any[];
      label: string;
      simulateOnly?: boolean;
    }) => Promise<void>
  ): Promise<void> {
    if (!onExecuteAction || !address) return;
    for (const pos of positions) {
      if (pos.claimableYield > 0n) {
        const m = PRESET_MARKETS.find((pm) => pm.id === pos.marketId);
        if (m) {
          await onExecuteAction({
            ...buildActionArgs({ type: "claim_yield", caller: address }, m),
            label: `Claim Yield (${m.name})`,
          });
        }
      }
    }
  }

  // ==========================================================================
  // SUITE 1: BUILDACTIONARGS OUTPUT & SOROBAN CONTRACT EXPECTATIONS
  // ==========================================================================
  describe("Suite 1: buildActionArgs Soroban Contract Parity (contracts/yield_pool/src/lib.rs:419)", () => {
    it("1.1 verifies Rust contract interface in yield_pool/src/lib.rs:419 specifies claim_yield(env, user, receiver)", () => {
      const contractPath = path.resolve(
        __dirname,
        "../../../../contracts/yield_pool/src/lib.rs"
      );
      expect(fs.existsSync(contractPath)).toBe(true);

      const contractSrc = fs.readFileSync(contractPath, "utf-8");
      const lines = contractSrc.split("\n");

      // Verify line 419 (or nearby exact function definition)
      const claimYieldIndex = lines.findIndex((l) =>
        l.includes("pub fn claim_yield(env: Env, user: Address, receiver: Address)")
      );
      expect(claimYieldIndex).toBeGreaterThan(0);
      // Contract line is approximately 419 (0-indexed 418)
      expect(Math.abs(claimYieldIndex + 1 - 419)).toBeLessThanOrEqual(5);

      const fnSignature = lines[claimYieldIndex].trim();
      expect(fnSignature).toBe(
        "pub fn claim_yield(env: Env, user: Address, receiver: Address) -> Result<i128, ContractError> {"
      );

      // Verify yt_token does NOT contain claim_yield (proving the old implementation was a bug)
      const ytContractPath = path.resolve(
        __dirname,
        "../../../../contracts/yt_token/src/lib.rs"
      );
      expect(fs.existsSync(ytContractPath)).toBe(true);
      const ytSrc = fs.readFileSync(ytContractPath, "utf-8");
      expect(ytSrc).not.toContain("pub fn claim_yield");
    });

    it("1.2 verifies buildActionArgs targets yield_pool contractId (poolId), NOT ytId or syId", () => {
      const verifiedMarkets = PRESET_MARKETS.filter((m) => m.isVerifiedTestnet);

      for (const market of verifiedMarkets) {
        const actionArgs = buildActionArgs(
          { type: "claim_yield", caller: dummyCaller },
          market
        );

        // MUST be yield_pool (poolId)
        expect(actionArgs.contractId).toBe(market.contracts.poolId);
        // MUST NOT be ytId
        expect(actionArgs.contractId).not.toBe(market.contracts.ytId);
        // MUST NOT be syId
        expect(actionArgs.contractId).not.toBe(market.contracts.syId);

        expect(actionArgs.method).toBe("claim_yield");
        expect(actionArgs.label).toBe("Claim Accrued YT Yield");
      }
    });

    it("1.3 verifies buildActionArgs produces exactly 2 Address ScVal arguments matching [user, receiver]", () => {
      const actionArgs = buildActionArgs(
        { type: "claim_yield", caller: dummyCaller },
        usdc90D
      );

      expect(actionArgs.args).toBeDefined();
      expect(actionArgs.args.length).toBe(2);

      // Decode ScVal args to ensure they match dummyCaller exactly
      const decodedUser = Address.fromScVal(actionArgs.args[0]).toString();
      const decodedReceiver = Address.fromScVal(actionArgs.args[1]).toString();

      expect(decodedUser).toBe(dummyCaller);
      expect(decodedReceiver).toBe(dummyCaller);
    });

    it("1.4 handles distinct caller address correctly with zero cross-contamination", () => {
      const actionArgs = buildActionArgs(
        { type: "claim_yield", caller: dummyCaller2 },
        usdc30D
      );

      expect(actionArgs.contractId).toBe(usdc30D.contracts.poolId);
      expect(actionArgs.method).toBe("claim_yield");
      expect(actionArgs.args.length).toBe(2);

      const decodedUser = Address.fromScVal(actionArgs.args[0]).toString();
      const decodedReceiver = Address.fromScVal(actionArgs.args[1]).toString();

      expect(decodedUser).toBe(dummyCaller2);
      expect(decodedReceiver).toBe(dummyCaller2);
    });

    it("1.5 fallback: buildActionArgs without market definition targets global yield_pool contract", () => {
      const actionArgs = buildActionArgs({
        type: "claim_yield",
        caller: dummyCaller,
      });

      expect(actionArgs.contractId).toBe(
        STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId
      );
      expect(actionArgs.method).toBe("claim_yield");
      expect(actionArgs.args.length).toBe(2);
    });
  });

  // ==========================================================================
  // SUITE 2: HANDLECLAIMALL EXECUTION UNDER MULTIPLE MARKETS (MIXED YIELD)
  // ==========================================================================
  describe("Suite 2: handleClaimAll Execution with Multiple Markets & Mixed Yield", () => {
    it("2.1 handles multiple markets with mixed positive/zero claimable yield: executes positive, skips zero", async () => {
      // Setup 3 markets:
      // Market 1 (usdc-90d): 15.5 SY positive yield
      // Market 2 (usdc-30d): 0 SY zero yield
      // Market 3 (xlm-90d): 42.0 SY positive yield
      const portUsdc90D: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "100",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 0n,
        ytBalance: 1000_0000000n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 15_5000000n, // positive
      };

      const portUsdc30D: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "100",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 500_0000000n,
        ytBalance: 500_0000000n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n, // ZERO
      };

      const portXlm90D: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "0",
        usdcTrustlineExists: false,
        syBalance: 0n,
        ptBalance: 0n,
        ytBalance: 2000_0000000n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 42_0000000n, // positive
      };

      const positions = [
        parseMarketPosition(usdc90D, portUsdc90D),
        parseMarketPosition(usdc30D, portUsdc30D),
        parseMarketPosition(xlm90D, portXlm90D),
      ];

      expect(positions[0].claimableYield).toBe(15_5000000n);
      expect(positions[1].claimableYield).toBe(0n);
      expect(positions[2].claimableYield).toBe(42_0000000n);

      const executedCalls: Array<{
        contractId: string;
        method: string;
        args: any[];
        label: string;
      }> = [];

      const mockOnExecuteAction = async (params: any) => {
        executedCalls.push(params);
      };

      await simulateHandleClaimAll(positions, dummyCaller, mockOnExecuteAction);

      // Must execute exactly 2 transactions (usdc-90d and xlm-90d), strictly skipping usdc-30d
      expect(executedCalls.length).toBe(2);

      // Call 1: usdc-90d
      expect(executedCalls[0].contractId).toBe(usdc90D.contracts.poolId);
      expect(executedCalls[0].method).toBe("claim_yield");
      expect(executedCalls[0].label).toBe(`Claim Yield (${usdc90D.name})`);
      expect(Address.fromScVal(executedCalls[0].args[0]).toString()).toBe(dummyCaller);

      // Call 2: xlm-90d
      expect(executedCalls[1].contractId).toBe(xlm90D.contracts.poolId);
      expect(executedCalls[1].method).toBe("claim_yield");
      expect(executedCalls[1].label).toBe(`Claim Yield (${xlm90D.name})`);
      expect(Address.fromScVal(executedCalls[1].args[0]).toString()).toBe(dummyCaller);
    });

    it("2.2 handles all markets having zero claimable yield: zero transactions executed", async () => {
      const zeroPort: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "100",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 100_0000000n,
        ytBalance: 100_0000000n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      const positions = [
        parseMarketPosition(usdc90D, zeroPort),
        parseMarketPosition(usdc30D, zeroPort),
        parseMarketPosition(xlm90D, zeroPort),
      ];

      const executedCalls: any[] = [];
      await simulateHandleClaimAll(positions, dummyCaller, async (p) => {
        executedCalls.push(p);
      });

      expect(executedCalls.length).toBe(0);
    });

    it("2.3 handles all markets having positive claimable yield: executes all sequentially", async () => {
      const makePort = (yieldSy: bigint): LiveUserPortfolio => ({
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "100",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 0n,
        ytBalance: 100_0000000n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: yieldSy,
      });

      const positions = [
        parseMarketPosition(usdc90D, makePort(10_0000000n)),
        parseMarketPosition(usdc30D, makePort(20_0000000n)),
        parseMarketPosition(xlm90D, makePort(30_0000000n)),
      ];

      const executedCalls: any[] = [];
      await simulateHandleClaimAll(positions, dummyCaller, async (p) => {
        executedCalls.push(p);
      });

      expect(executedCalls.length).toBe(3);
      expect(executedCalls[0].contractId).toBe(usdc90D.contracts.poolId);
      expect(executedCalls[1].contractId).toBe(usdc30D.contracts.poolId);
      expect(executedCalls[2].contractId).toBe(xlm90D.contracts.poolId);
    });

    it("2.4 guards against unauthenticated execution when address is null", async () => {
      const positions = [
        parseMarketPosition(usdc90D, {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 0n,
          ytBalance: 100_0000000n,
          lpBalance: 0n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 50_0000000n,
        }),
      ];

      const executedCalls: any[] = [];
      await simulateHandleClaimAll(positions, null, async (p) => {
        executedCalls.push(p);
      });

      expect(executedCalls.length).toBe(0);
    });

    it("2.5 guards against missing onExecuteAction callback safely", async () => {
      const positions = [
        parseMarketPosition(usdc90D, {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 0n,
          ytBalance: 100_0000000n,
          lpBalance: 0n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 50_0000000n,
        }),
      ];

      // Must not throw when onExecuteAction is undefined
      let threw = false;
      try {
        await simulateHandleClaimAll(positions, dummyCaller, undefined);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  });

  // ==========================================================================
  // SUITE 3: SEQUENTIAL TRANSACTION EXECUTION & SIMULATED RPC LATENCY
  // ==========================================================================
  describe("Suite 3: Sequential Execution Semantics with Simulated RPC Latency", () => {
    it("3.1 executes transactions in strict sequence without concurrency overlap", async () => {
      const makePort = (yieldSy: bigint): LiveUserPortfolio => ({
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "100",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 0n,
        ytBalance: 100_0000000n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: yieldSy,
      });

      const positions = [
        parseMarketPosition(usdc90D, makePort(10_0000000n)),
        parseMarketPosition(usdc30D, makePort(20_0000000n)),
        parseMarketPosition(xlm90D, makePort(30_0000000n)),
      ];

      let activeExecutions = 0;
      let maxConcurrency = 0;
      const executionLog: Array<{
        marketId: string;
        startTime: number;
        endTime: number;
      }> = [];

      // Simulate heterogeneous RPC latencies
      const latencies: Record<string, number> = {
        [usdc90D.contracts.poolId]: 40,
        [usdc30D.contracts.poolId]: 60,
        [xlm90D.contracts.poolId]: 30,
      };

      const mockOnExecuteAction = async (params: { contractId: string; label: string }) => {
        activeExecutions++;
        if (activeExecutions > maxConcurrency) {
          maxConcurrency = activeExecutions;
        }

        const start = Date.now();
        const latency = latencies[params.contractId] || 20;
        await new Promise((resolve) => setTimeout(resolve, latency));
        const end = Date.now();

        executionLog.push({
          marketId: params.contractId,
          startTime: start,
          endTime: end,
        });

        activeExecutions--;
      };

      const overallStart = Date.now();
      await simulateHandleClaimAll(positions, dummyCaller, mockOnExecuteAction);
      const overallElapsed = Date.now() - overallStart;

      // STRICT INVARIANT: Concurrency must NEVER exceed 1 (strictly sequential for...of)
      expect(maxConcurrency).toBe(1);
      expect(activeExecutions).toBe(0);
      expect(executionLog.length).toBe(3);

      // Verify that tx 2 started strictly after tx 1 finished
      expect(executionLog[1].startTime).toBeGreaterThanOrEqual(executionLog[0].endTime);
      // Verify that tx 3 started strictly after tx 2 finished
      expect(executionLog[2].startTime).toBeGreaterThanOrEqual(executionLog[1].endTime);

      // Total elapsed must be at least sum of latencies (40 + 60 + 30 = 130ms)
      expect(overallElapsed).toBeGreaterThanOrEqual(120);
    });

    it("3.2 halts sequence upon RPC failure to prevent sequence number desynchronization", async () => {
      const makePort = (yieldSy: bigint): LiveUserPortfolio => ({
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "100",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 0n,
        ytBalance: 100_0000000n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: yieldSy,
      });

      const positions = [
        parseMarketPosition(usdc90D, makePort(10_0000000n)),
        parseMarketPosition(usdc30D, makePort(20_0000000n)), // Will fail here
        parseMarketPosition(xlm90D, makePort(30_0000000n)),
      ];

      const executedMarkets: string[] = [];

      const mockFailingOnExecute = async (params: { contractId: string }) => {
        executedMarkets.push(params.contractId);
        if (params.contractId === usdc30D.contracts.poolId) {
          throw new Error("Soroban RPC transaction simulation rejected: txBAD_SEQ");
        }
      };

      let errorCaught: any = null;
      try {
        await simulateHandleClaimAll(positions, dummyCaller, mockFailingOnExecute);
      } catch (err) {
        errorCaught = err;
      }

      // Error must be propagated
      expect(errorCaught).not.toBeNull();
      expect(errorCaught.message).toContain("txBAD_SEQ");

      // Market 1 succeeded, Market 2 failed, Market 3 was NEVER called
      expect(executedMarkets.length).toBe(2);
      expect(executedMarkets[0]).toBe(usdc90D.contracts.poolId);
      expect(executedMarkets[1]).toBe(usdc30D.contracts.poolId);
      expect(executedMarkets).not.toContain(xlm90D.contracts.poolId);
    });
  });

  // ==========================================================================
  // SUITE 4: COMPONENT-LEVEL VERIFICATION OF PORTFOLIOVIEW
  // ==========================================================================
  describe("Suite 4: PortfolioView Component SSR & Interaction Contract", () => {
    it("4.1 renders Claim All Yield button with tabular-mono and formatted valuation when yield > 0", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const userPortfolios = {
        "usdc-90d": {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 0n,
          ytBalance: 1000_0000000n,
          lpBalance: 0n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 12_5000000n, // ~$12.51
        },
      };

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios,
        })
      );

      expect(html).toContain("Claim All Yield");
      expect(html).toContain("tabular-mono");
      expect(html).toContain('title="Claim Accrued Variable Yield"');
      expect(html).toMatch(/\$(<!-- -->)?12\.5[0-9]/);
    });

    it("4.2 does NOT render Claim All Yield button when total claimable yield is 0", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const userPortfolios = {
        "usdc-90d": {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 100_0000000n,
          ytBalance: 0n,
          lpBalance: 0n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 0n,
        },
      };

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios,
        })
      );

      expect(html).not.toContain("Claim All Yield");
    });

    it("4.3 does NOT render Claim All Yield button when wallet is disconnected", () => {
      currentMockWallet.address = null;
      currentMockWallet.mode = "disconnected";

      const userPortfolios = {
        "usdc-90d": {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 0n,
          ytBalance: 1000_0000000n,
          lpBalance: 0n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 12_5000000n,
        },
      };

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios,
        })
      );

      expect(html).not.toContain("Claim All Yield");
      // Restore wallet state
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";
    });

    it("4.4 renders disabled Claim All Yield button when busyAction is active", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const userPortfolios = {
        "usdc-90d": {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 0n,
          ytBalance: 1000_0000000n,
          lpBalance: 0n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 12_5000000n,
        },
      };

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios,
          busyAction: "Claiming Yield...",
        })
      );

      expect(html).toContain("Claim All Yield");
      expect(html).toContain("disabled");
    });

    it("4.5 renders mobile card valuation parity with tabular-mono in mobile card header", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const userPortfolios = {
        "usdc-90d": {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 250_0000000n, // 250 PT @ 0.98 = $245.00
          ytBalance: 0n,
          lpBalance: 0n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 0n,
        },
      };

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios,
        })
      );

      // Check mobile card header valuation with blendRate 1.001
      expect(html).toMatch(/\$(<!-- -->)?245\.2[45]/);
      expect(html).toContain("tabular-mono text-xs font-bold text-ink");
    });
  });

  // ==========================================================================
  // SUITE 5: STRICT FORBIDDEN FILE IMMUTABILITY & ISOLATION
  // ==========================================================================
  describe("Suite 5: Strictly Prohibited Files Immutability & Independence", () => {
    it("5.1 frontend/src/lib/indexer.ts matches baseline SHA256 byte-for-byte", () => {
      const indexerPath = path.resolve(__dirname, "../indexer.ts");
      expect(fs.existsSync(indexerPath)).toBe(true);

      const content = fs.readFileSync(indexerPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      expect(hash).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
    });

    it("5.2 frontend/src/hooks/useEventIndexer.ts matches baseline SHA256 byte-for-byte", () => {
      const hookPath = path.resolve(__dirname, "../../hooks/useEventIndexer.ts");
      expect(fs.existsSync(hookPath)).toBe(true);

      const content = fs.readFileSync(hookPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      expect(hash).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
    });

    it("5.3 verifies useMultiMarketPortfolio.ts and PortfolioView.tsx do NOT import from forbidden files", () => {
      const portfolioViewPath = path.resolve(
        __dirname,
        "../../components/portfolio/PortfolioView.tsx"
      );
      const multiMarketPath = path.resolve(
        __dirname,
        "../../hooks/useMultiMarketPortfolio.ts"
      );

      const pvContent = fs.readFileSync(portfolioViewPath, "utf-8");
      const mmContent = fs.readFileSync(multiMarketPath, "utf-8");

      expect(pvContent).not.toMatch(/(['"])@\/lib\/indexer\b/);
      expect(pvContent).not.toMatch(/(['"])@\/hooks\/useEventIndexer\b/);
      expect(mmContent).not.toMatch(/(['"])@\/lib\/indexer\b/);
      expect(mmContent).not.toMatch(/(['"])@\/hooks\/useEventIndexer\b/);
    });

    it("5.4 verifies AST of PortfolioView.tsx: handleClaimAll uses buildActionArgs and sequential for...of", () => {
      const portfolioViewPath = path.resolve(
        __dirname,
        "../../components/portfolio/PortfolioView.tsx"
      );
      const content = fs.readFileSync(portfolioViewPath, "utf-8");

      // Verify buildActionArgs import
      expect(content).toContain("buildActionArgs");

      // Verify handleClaimAll implementation details
      expect(content).toContain("const handleClaimAll = useCallback(async () => {");
      expect(content).toContain("if (!onExecuteAction || !address) return;");
      expect(content).toContain("for (const pos of portfolio.positions) {");
      expect(content).toContain("if (pos.claimableYield > 0n) {");
      expect(content).toContain("buildActionArgs({ type: \"claim_yield\", caller: address }, m)");
      expect(content).toContain("await onExecuteAction({");

      // Verify no remaining references to ytId in handleClaimAll
      const handleClaimBlock = content.slice(
        content.indexOf("const handleClaimAll"),
        content.indexOf("}, [onExecuteAction, address, portfolio.positions]);")
      );
      expect(handleClaimBlock).not.toContain("ytId");
      expect(handleClaimBlock).not.toContain("args: []");
    });
  });
});
