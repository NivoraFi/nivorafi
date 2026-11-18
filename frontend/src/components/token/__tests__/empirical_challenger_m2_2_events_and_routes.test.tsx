// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// Mock WalletProvider for deterministic headless testing
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
  isNetworkMismatch: () => mockWalletState.walletNetworkMismatch,
}));

// Mock Next.js router & navigation
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
  }),
  usePathname: () => "/trade/usdc-90d",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    const error = new Error("NEXT_NOT_FOUND");
    (error as any).digest = "NEXT_NOT_FOUND";
    throw error;
  },
}));

import {
  TokenActivityFeed,
  formatProtocolEvent,
  formatRelativeTime,
  isEventForMarket,
} from "../TokenActivityFeed";
import { TokenProfileHeader } from "../TokenProfileHeader";
import { YieldBreakdownCards } from "../YieldBreakdownCards";
import { InteractiveYieldChart } from "../InteractiveYieldChart";
import { TradePageClient } from "@/components/trade/TradePageClient";
import TradePage, {
  generateMetadata as tradeGenerateMetadata,
  generateStaticParams as tradeGenerateStaticParams,
} from "@/app/trade/[market]/page";
import MarketDetailPage, {
  generateMetadata as marketsGenerateMetadata,
  generateStaticParams as marketsGenerateStaticParams,
} from "@/app/markets/[id]/page";
import { MarketProvider } from "@/context/MarketContext";
import { PRESET_MARKETS, MarketDefinition, getMarketDefinition } from "@/lib/markets";
import {
  DepositEventParsed,
  LiquidityEventParsed,
  MintPyEventParsed,
  ProtocolEvent,
  RedeemEventParsed,
  RedeemPtEventParsed,
  RedeemPyEventParsed,
  RolloverEventParsed,
  RolloverPyEventParsed,
  SwapEventParsed,
} from "@/lib/indexer";
import { LiveMarketSnapshot } from "@/lib/stellar";

describe("Empirical Challenger M2.2: Event Filtering, Activity Feed & Page Integration", () => {
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

  const renderClean = (element: React.ReactElement): string => {
    return renderToString(element).replace(/<!-- -->/g, "");
  };

  const wrapWithContext = (element: React.ReactElement, marketId = "usdc-90d") => {
    return renderClean(
      React.createElement(MarketProvider, { initialMarketId: marketId, children: element })
    );
  };

  // Helper generator to produce standard protocol events
  const createMockEvent = (
    overrides: Partial<SwapEventParsed> & { [key: string]: any } = {}
  ): ProtocolEvent => {
    return {
      id: "ev_test_" + Math.random().toString(36).substring(2, 9),
      txHash: "4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
      ledger: 1005000,
      ledgerClosedAt: "2026-11-10T12:00:00Z",
      timestamp: Math.floor(Date.now() / 1000) - 60,
      type: "swap",
      topicSymbol: "swap",
      contractId: usdc90D.contracts.poolId,
      caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      amountIn: 100_0000000n,
      amountOut: 98_0000000n,
      direction: 1,
      directionLabel: "SY_FOR_PT",
      fee: 300000n,
      ...overrides,
    } as ProtocolEvent;
  };

  // ==========================================================================
  // Suite 1: Event Filtering Adversarial Matrix & Cross-Market Isolation
  // ==========================================================================
  describe("Suite 1: Event Filtering Adversarial Matrix & Cross-Market Isolation", () => {
    it("1.1 Cross-market pairwise event isolation: disjoint markets have 0% event leakage", () => {
      // usdc-90d and xlm-90d have completely disjoint contracts across poolId, syId, ptId, ytId
      const disjointPairs: [MarketDefinition, MarketDefinition][] = [
        [usdc90D, xlm90D],
        [usdc30D, xlm90D],
      ];

      for (const [marketA, marketB] of disjointPairs) {
        const contractsA = [
          marketA.contracts.poolId,
          marketA.contracts.syId,
          marketA.contracts.ptId,
          marketA.contracts.ytId,
        ];

        for (const contractId of contractsA) {
          const evA = createMockEvent({ contractId });
          expect(isEventForMarket(evA, marketA)).toBe(true);
          // Strict isolation: market A events must NEVER leak into market B
          expect(isEventForMarket(evA, marketB)).toBe(false);
        }

        const contractsB = [
          marketB.contracts.poolId,
          marketB.contracts.syId,
          marketB.contracts.ptId,
          marketB.contracts.ytId,
        ];

        for (const contractId of contractsB) {
          const evB = createMockEvent({ contractId });
          expect(isEventForMarket(evB, marketB)).toBe(true);
          expect(isEventForMarket(evB, marketA)).toBe(false);
        }
      }

      // Between usdc-90d and usdc-30d: market-specific contracts (poolId, ptId, ytId) are disjoint
      const marketSpecificRoles: (keyof typeof usdc90D.contracts)[] = ["poolId", "ptId", "ytId"];
      for (const role of marketSpecificRoles) {
        const contract90D = usdc90D.contracts[role];
        const contract30D = usdc30D.contracts[role];

        const ev90 = createMockEvent({ contractId: contract90D });
        expect(isEventForMarket(ev90, usdc90D)).toBe(true);
        expect(isEventForMarket(ev90, usdc30D)).toBe(false);

        const ev30 = createMockEvent({ contractId: contract30D });
        expect(isEventForMarket(ev30, usdc30D)).toBe(true);
        expect(isEventForMarket(ev30, usdc90D)).toBe(false);
      }

      // Shared SY wrapper contract: both usdc-90d and usdc-30d share syId (bUSDC wrapper)
      expect(usdc90D.contracts.syId).toBe(usdc30D.contracts.syId);
      const sharedSyEv = createMockEvent({ contractId: usdc90D.contracts.syId });
      expect(isEventForMarket(sharedSyEv, usdc90D)).toBe(true);
      expect(isEventForMarket(sharedSyEv, usdc30D)).toBe(true);
      // But neither leaks to xlm-90d
      expect(isEventForMarket(sharedSyEv, xlm90D)).toBe(false);
    });

    it("1.2 Synthetic multi-market isolation matrix: 100 synthetic events across 5 distinct markets", () => {
      // Create 5 synthetic markets with completely randomized C... contract addresses
      const syntheticMarkets: MarketDefinition[] = Array.from({ length: 5 }, (_, mIdx) => ({
        ...usdc90D,
        id: `synth-market-${mIdx}`,
        contracts: {
          poolId: `C${mIdx}POOL` + "A".repeat(50),
          syId: `C${mIdx}SY` + "B".repeat(52),
          ptId: `C${mIdx}PT` + "C".repeat(52),
          ytId: `C${mIdx}YT` + "D".repeat(52),
          blendPoolId: `C${mIdx}BLEND` + "E".repeat(49),
        },
      }));

      // Generate 20 events per market (100 total)
      for (let mIdx = 0; mIdx < syntheticMarkets.length; mIdx++) {
        const currentMarket = syntheticMarkets[mIdx];
        const roles: (keyof typeof currentMarket.contracts)[] = ["poolId", "syId", "ptId", "ytId"];

        for (let k = 0; k < 20; k++) {
          const role = roles[k % roles.length];
          const contractId = currentMarket.contracts[role];
          const ev = createMockEvent({ contractId });

          // Must match currentMarket
          expect(isEventForMarket(ev, currentMarket)).toBe(true);

          // Must NEVER match any other synthetic market
          for (let otherIdx = 0; otherIdx < syntheticMarkets.length; otherIdx++) {
            if (otherIdx !== mIdx) {
              expect(isEventForMarket(ev, syntheticMarkets[otherIdx])).toBe(false);
            }
          }
        }
      }
    });

    it("1.3 Strict address equality vs prefix, suffix, and substring spoofing", () => {
      const realPool = usdc90D.contracts.poolId;

      const spoofAttempts = [
        realPool + "_EXTRA",
        realPool + "1",
        "PREFIX_" + realPool,
        realPool.substring(0, realPool.length - 2),
        realPool.substring(4),
        realPool.substring(4, 30),
        "C" + "0".repeat(55),
        "G" + "A".repeat(55),
        "",
        "null",
        "undefined",
      ];

      for (const fakeContract of spoofAttempts) {
        const ev = createMockEvent({ contractId: fakeContract });
        expect(isEventForMarket(ev, usdc90D)).toBe(false);
      }
    });

    it("1.4 Case-insensitivity stress testing across all contract roles", () => {
      const roles: (keyof typeof usdc90D.contracts)[] = ["poolId", "syId", "ptId", "ytId"];

      for (const role of roles) {
        const addr = usdc90D.contracts[role];
        if (!addr) continue;

        // Uppercase
        const upperEv = createMockEvent({ contractId: addr.toUpperCase() });
        expect(isEventForMarket(upperEv, usdc90D)).toBe(true);

        // Lowercase
        const lowerEv = createMockEvent({ contractId: addr.toLowerCase() });
        expect(isEventForMarket(lowerEv, usdc90D)).toBe(true);

        // Mixed alternating case
        const mixed = addr
          .split("")
          .map((ch, idx) => (idx % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");
        const mixedEv = createMockEvent({ contractId: mixed });
        expect(isEventForMarket(mixedEv, usdc90D)).toBe(true);

        // Also test case-insensitivity when market contracts themselves have varying case
        const marketWithUpperContracts: MarketDefinition = {
          ...usdc90D,
          contracts: {
            ...usdc90D.contracts,
            [role]: addr.toUpperCase(),
          },
        };
        expect(isEventForMarket(lowerEv, marketWithUpperContracts)).toBe(true);
      }
    });

    it("1.5 Nested rawData payload permutation stress testing (snake_case, camelCase, short)", () => {
      const foreignContractId = "CBAD_UNRELATED_ORCHESTRATOR_CONTRACT_99999999999999999";

      // Testing poolId variations in rawData
      const poolPermutations = [
        { pool_id: usdc90D.contracts.poolId },
        { poolId: usdc90D.contracts.poolId },
        { pool: usdc90D.contracts.poolId },
        { pool_id: usdc90D.contracts.poolId.toUpperCase() },
        { pool_id: usdc90D.contracts.poolId.toLowerCase() },
      ];

      for (const rd of poolPermutations) {
        const ev = createMockEvent({
          contractId: foreignContractId,
          rawData: rd,
        });
        expect(isEventForMarket(ev, usdc90D)).toBe(true);
        // Ensure it doesn't match a different market
        expect(isEventForMarket(ev, xlm90D)).toBe(false);
      }

      // Testing syId variations in rawData
      const syPermutations = [
        { sy_id: usdc90D.contracts.syId },
        { syId: usdc90D.contracts.syId },
        { sy: usdc90D.contracts.syId },
        { sy_id: usdc90D.contracts.syId.toUpperCase() },
      ];

      for (const rd of syPermutations) {
        const ev = createMockEvent({
          contractId: foreignContractId,
          rawData: rd,
        });
        expect(isEventForMarket(ev, usdc90D)).toBe(true);
        expect(isEventForMarket(ev, xlm90D)).toBe(false);
      }

      // Testing ptId variations in rawData
      const ptPermutations = [
        { pt_id: usdc90D.contracts.ptId },
        { ptId: usdc90D.contracts.ptId },
        { pt: usdc90D.contracts.ptId },
        { pt_id: usdc90D.contracts.ptId.toUpperCase() },
      ];

      for (const rd of ptPermutations) {
        const ev = createMockEvent({
          contractId: foreignContractId,
          rawData: rd,
        });
        expect(isEventForMarket(ev, usdc90D)).toBe(true);
        expect(isEventForMarket(ev, xlm90D)).toBe(false);
      }
    });

    it("1.6 rawData corrupted, primitive, or malformed values never crash filter", () => {
      const malformedRawData = [
        null,
        undefined,
        42,
        true,
        false,
        "string_instead_of_object",
        [],
        [1, 2, 3],
        {},
        { pool_id: null },
        { pool_id: undefined },
        { pool_id: 12345 },
        { pool_id: {} },
        { unassociated_key: "value" },
      ];

      for (const rd of malformedRawData) {
        const ev = createMockEvent({
          contractId: "CBAD_SOME_OTHER_CONTRACT",
          rawData: rd as any,
        });
        expect(() => isEventForMarket(ev, usdc90D)).not.toThrow();
        expect(isEventForMarket(ev, usdc90D)).toBe(false);
      }
    });

    it("1.7 Top-level generic field fallback matching (sourcePool, targetPool, yt_id)", () => {
      const foreignContractId = "CBAD_SOME_FACTORY_OR_ROUTER";

      // sourcePool (common in rollover events)
      const rolloverEv = createMockEvent({
        contractId: foreignContractId,
        sourcePool: usdc90D.contracts.poolId,
      });
      expect(isEventForMarket(rolloverEv, usdc90D)).toBe(true);

      // targetPool
      const targetPoolEv = createMockEvent({
        contractId: foreignContractId,
        targetPool: usdc90D.contracts.poolId,
      });
      expect(isEventForMarket(targetPoolEv, usdc90D)).toBe(true);

      // yt_id top-level field
      const ytEv = createMockEvent({
        contractId: foreignContractId,
        yt_id: usdc90D.contracts.ytId,
      });
      expect(isEventForMarket(ytEv, usdc90D)).toBe(true);
      expect(isEventForMarket(ytEv, xlm90D)).toBe(false);
    });

    it("1.8 Boundary conditions: null/undefined market or contracts gracefully handled", () => {
      const ev = createMockEvent();
      expect(isEventForMarket(ev, null as any)).toBe(false);
      expect(isEventForMarket(ev, undefined as any)).toBe(false);
      expect(isEventForMarket(ev, { ...usdc90D, contracts: null as any })).toBe(false);
      expect(isEventForMarket(ev, { ...usdc90D, contracts: {} as any })).toBe(false);
    });
  });

  // ==========================================================================
  // Suite 2: TokenActivityFeed Rendering & Verbatim Empty State Invariant
  // ==========================================================================
  describe("Suite 2: TokenActivityFeed Rendering & Verbatim Empty State Invariant", () => {
    const requiredEmptyState = "No recent transactions on Stellar Testnet for this asset";

    it("2.1 Verbatim empty state string renders when rawEvents is explicitly empty array", () => {
      const html = renderClean(
        React.createElement(TokenActivityFeed, {
          market: usdc90D,
          rawEvents: [],
        })
      );

      expect(html).toContain(requiredEmptyState);
      expect(html).toContain("Live Soroban RPC indexer is monitoring");
      expect(html).toContain("(0 events)");
    });

    it("2.2 Verbatim empty state string renders when all events belong to another market", () => {
      // 5 events strictly targeting xlm90D
      const xlmEvents: ProtocolEvent[] = [
        createMockEvent({ id: "x1", contractId: xlm90D.contracts.poolId }),
        createMockEvent({ id: "x2", contractId: xlm90D.contracts.syId }),
        createMockEvent({ id: "x3", contractId: xlm90D.contracts.ptId }),
        createMockEvent({ id: "x4", contractId: xlm90D.contracts.ytId }),
        createMockEvent({ id: "x5", contractId: xlm90D.contracts.poolId, pool_id: xlm90D.contracts.poolId }),
      ];

      // Feed rendered for usdc-90d must filter out all 5 events and show verbatim empty state
      const html = renderClean(
        React.createElement(TokenActivityFeed, {
          market: usdc90D,
          rawEvents: xlmEvents,
        })
      );

      expect(html).toContain(requiredEmptyState);
      expect(html).toContain("(0 events)");
      expect(html).not.toContain("x1");
      expect(html).not.toContain("x2");
    });

    it("2.3 Formats and renders all 7 standard protocol event categories", () => {
      const now = Math.floor(Date.now() / 1000);

      const events: ProtocolEvent[] = [
        // 1. Swap
        {
          id: "ev_swap",
          txHash: "1111111111111111111111111111111111111111111111111111111111111111",
          ledger: 1000001,
          ledgerClosedAt: "2026-11-10T12:00:00Z",
          timestamp: now - 30,
          type: "swap",
          topicSymbol: "swap",
          contractId: usdc90D.contracts.poolId,
          caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          amountIn: 100_0000000n,
          amountOut: 98_1200000n,
          direction: 0, // PT_FOR_SY
          directionLabel: "PT_FOR_SY",
          fee: 300000n,
        } as SwapEventParsed,

        // 2. Mint PY
        {
          id: "ev_mint_py",
          txHash: "2222222222222222222222222222222222222222222222222222222222222222",
          ledger: 1000002,
          ledgerClosedAt: "2026-11-10T12:01:00Z",
          timestamp: now - 120,
          type: "mint_py",
          topicSymbol: "mint_py",
          contractId: usdc90D.contracts.syId,
          caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          syIn: 50_0000000n,
          pyOut: 50_0000000n,
        } as MintPyEventParsed,

        // 3. Deposit
        {
          id: "ev_deposit",
          txHash: "3333333333333333333333333333333333333333333333333333333333333333",
          ledger: 1000003,
          ledgerClosedAt: "2026-11-10T12:02:00Z",
          timestamp: now - 300,
          type: "deposit",
          topicSymbol: "deposit",
          contractId: usdc90D.contracts.syId,
          caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          underlyingAmount: 200_0000000n,
          sharesMinted: 200_0000000n,
        } as DepositEventParsed,

        // 4. Redeem PY
        {
          id: "ev_redeem_py",
          txHash: "4444444444444444444444444444444444444444444444444444444444444444",
          ledger: 1000004,
          ledgerClosedAt: "2026-11-10T12:03:00Z",
          timestamp: now - 600,
          type: "redeem_py",
          topicSymbol: "redeem_py",
          contractId: usdc90D.contracts.poolId,
          caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          pyBurned: 25_0000000n,
          syOut: 25_0000000n,
        } as RedeemPyEventParsed,

        // 5. Redeem PT Post-Maturity
        {
          id: "ev_redeem_pt",
          txHash: "5555555555555555555555555555555555555555555555555555555555555555",
          ledger: 1000005,
          ledgerClosedAt: "2026-11-10T12:04:00Z",
          timestamp: now - 1200,
          type: "redeem_pt",
          topicSymbol: "redeem_pt",
          contractId: usdc90D.contracts.ptId,
          caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          ptBurned: 10_0000000n,
          payout: 10_0000000n,
          isBtoken: false,
        } as RedeemPtEventParsed,

        // 6. Liquidity Add & Remove
        {
          id: "ev_liq_add",
          txHash: "6666666666666666666666666666666666666666666666666666666666666666",
          ledger: 1000006,
          ledgerClosedAt: "2026-11-10T12:05:00Z",
          timestamp: now - 3600,
          type: "liquidity",
          topicSymbol: "liquidity",
          contractId: usdc90D.contracts.poolId,
          caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          isAdd: true,
          ptAmount: 100_0000000n,
          syAmount: 50_0000000n,
          lpAmount: 70_0000000n,
        } as LiquidityEventParsed,

        // 7. Rollover
        {
          id: "ev_rollover",
          txHash: "7777777777777777777777777777777777777777777777777777777777777777",
          ledger: 1000007,
          ledgerClosedAt: "2026-11-10T12:06:00Z",
          timestamp: now - 7200,
          type: "rollover",
          topicSymbol: "rollover",
          contractId: usdc90D.contracts.poolId,
          user: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          sourcePool: "CCITOO7WPWXHNWQIF62CD7UEW6I3TKXCMPTW4BRTV4UCKBXXEZMZDSFD",
          targetPool: usdc90D.contracts.poolId,
          ptBurned: 50_0000000n,
          syReceived: 50_0000000n,
          targetPtMinted: 51_0000000n,
        } as RolloverEventParsed,
      ];

      const html = renderClean(
        React.createElement(TokenActivityFeed, {
          market: usdc90D,
          rawEvents: events,
        })
      );

      // Verify all badges and action descriptions render
      expect(html).toContain("Swap");
      expect(html).toContain("Mint");
      expect(html).toContain("Redeem");
      expect(html).toContain("Pool");
      expect(html).toContain("Rollover");
      expect(html).toContain("Swapped");
      expect(html).toContain("Minted");
      expect(html).toContain("Deposited");
      expect(html).toContain("Added Liquidity");
      expect(html).toContain("Rolled over");
      expect(html).toContain("(7 events)");
      expect(html).toContain("tabular-mono");
      expect(html).toContain("stellar.expert");
    });

    it("2.4 Relative time formatter edge cases", () => {
      const now = Math.floor(Date.now() / 1000);
      expect(formatRelativeTime(0)).toBe("--");
      expect(formatRelativeTime(now - 10)).toBe("Just now");
      expect(formatRelativeTime(now - 59)).toBe("Just now");
      expect(formatRelativeTime(now - 60)).toBe("1m ago");
      expect(formatRelativeTime(now - 3599)).toBe("59m ago");
      expect(formatRelativeTime(now - 3600)).toBe("1h ago");
      expect(formatRelativeTime(now - 86399)).toBe("23h ago");
      expect(formatRelativeTime(now - 86400)).toBe("1d ago");
      expect(formatRelativeTime(now - 259200)).toBe("3d ago");
    });
  });

  // ==========================================================================
  // Suite 3: Dynamic Route Rendering Across All 4 Preset Markets
  // ==========================================================================
  describe("Suite 3: Dynamic Route Rendering Across All 4 Preset Markets", () => {
    const marketIds = [
      "usdc-90d",
      "usdc-30d",
      "xlm-90d",
      "usdc-matured",
    ];

    it("3.1 TradePageClient mounts all 4 core components cleanly across all 4 preset markets", () => {
      for (const marketId of marketIds) {
        const market = getMarketDefinition(marketId)!;
        expect(market).toBeDefined();

        const html = wrapWithContext(
          React.createElement(TradePageClient, {
            market,
            initialTab: "swap",
          }),
          market.id
        );

        // Verify HTML length is substantial
        expect(html.length).toBeGreaterThan(1200);

        // Verify Component 1: TokenProfileHeader
        expect(html).toContain(market.name);
        expect(html).toContain(market.asset.code);
        expect(html).toContain(market.tenor);
        expect(html).toContain(market.ptSymbol);
        expect(html).toContain(market.ytSymbol);
        expect(html).toContain("Pool");
        expect(html).toContain("SY");
        expect(html).toContain("PT");
        expect(html).toContain("YT");

        // Verify Component 2: YieldBreakdownCards
        expect(html).toContain("Implied APY");
        expect(html).toContain("Underlying APY");
        expect(html).toContain("Fixed APY");
        expect(html).toContain("Long Yield Leverage");
        expect(html).toContain("Maturity");
        expect(html).toContain("Pool TVL");

        // Verify Component 3: InteractiveYieldChart
        expect(html).toContain("Yield APY");
        expect(html).toContain("Token Price");
        expect(html).toContain("<svg");
        expect(html).toContain("1D");
        expect(html).toContain("1W");
        expect(html).toContain("1M");
        expect(html).toContain("ALL");

        // Verify Market Activity feed was intentionally removed from TradePageClient
        expect(html).not.toContain("Market Activity");

        // Verify Side Column: TradingDesk
        expect(html).toContain("Trade Fixed Yield");
        expect(html).toContain("Swap");
        expect(html).toContain("Mint");
        expect(html).toContain("Redeem");
        expect(html).toContain("Liquidity");
        expect(html).toContain("Rollover");
      }
    });

    it("3.2 TradePage (src/app/trade/[market]/page.tsx) static params and metadata resolution", async () => {
      // 1. generateStaticParams must return all 5 slugs
      const staticParams = await tradeGenerateStaticParams();
      expect(staticParams).toEqual([
        { market: "usdc-90d" },
        { market: "usdc-30d" },
        { market: "xlm-90d" },
        { market: "usdc-matured" },
        { market: "usdc-slender-90d" },
      ]);

      // 2. generateMetadata must resolve proper title and description for all 4
      for (const marketId of marketIds) {
        const meta = await tradeGenerateMetadata({
          params: Promise.resolve({ market: marketId }),
        });
        const market = getMarketDefinition(marketId)!;
        expect(meta.title).toContain(market.name);
        expect(meta.title).toContain(market.ptSymbol);
        expect(meta.description).toContain(market.ptSymbol);
      }

      // 3. generateMetadata for invalid market returns 404 title
      const notFoundMeta = await tradeGenerateMetadata({
        params: Promise.resolve({ market: "non-existent-token" }),
      });
      expect(notFoundMeta.title).toBe("Market Not Found | NivoraFi");
    });

    it("3.3 TradePage Server Component renders cleanly for all 4 markets and throws notFound for invalid slug", async () => {
      for (const marketId of marketIds) {
        const pageElement = await TradePage({
          params: Promise.resolve({ market: marketId }),
        });
        expect(React.isValidElement(pageElement)).toBe(true);

        const html = wrapWithContext(pageElement, marketId);
        expect(html).not.toContain("Market Activity");
        expect(html).toContain(getMarketDefinition(marketId)!.name);
      }

      // Invalid slug must trigger notFound()
      let notFoundTriggered = false;
      try {
        await TradePage({
          params: Promise.resolve({ market: "invalid-token-route" }),
        });
      } catch (err: any) {
        if (err.message === "NEXT_NOT_FOUND" || err.digest === "NEXT_NOT_FOUND") {
          notFoundTriggered = true;
        }
      }
      expect(notFoundTriggered).toBe(true);
    });

    it("3.4 MarketDetailPage (src/app/markets/[id]/page.tsx) static params, metadata and page rendering", async () => {
      const staticParams = await marketsGenerateStaticParams();
      expect(staticParams).toEqual([
        { id: "usdc-90d" },
        { id: "usdc-30d" },
        { id: "xlm-90d" },
        { id: "usdc-matured" },
        { id: "usdc-slender-90d" },
      ]);

      for (const marketId of marketIds) {
        const meta = await marketsGenerateMetadata({
          params: Promise.resolve({ id: marketId }),
        });
        expect(meta.title).toContain(getMarketDefinition(marketId)!.name);

        const pageElement = await MarketDetailPage({
          params: Promise.resolve({ id: marketId }),
        });
        expect(React.isValidElement(pageElement)).toBe(true);
        const html = wrapWithContext(pageElement, marketId);
        expect(html).not.toContain("Market Activity");
        expect(html).toContain(getMarketDefinition(marketId)!.name);
      }

      // Invalid ID must trigger notFound()
      let notFoundTriggered = false;
      try {
        await MarketDetailPage({
          params: Promise.resolve({ id: "unknown-market-slug" }),
        });
      } catch (err: any) {
        if (err.message === "NEXT_NOT_FOUND" || err.digest === "NEXT_NOT_FOUND") {
          notFoundTriggered = true;
        }
      }
      expect(notFoundTriggered).toBe(true);
    });
  });

  // ==========================================================================
  // Suite 4: Protected Checksum Verification
  // ==========================================================================
  describe("Suite 4: Protected Checksum Verification", () => {
    const EXPECTED_INDEXER_SHA256 =
      "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";
    const EXPECTED_HOOK_SHA256 =
      "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

    it("4.1 Cryptographic SHA256 integrity of src/lib/indexer.ts exactly matches baseline", () => {
      const filePath = path.resolve(__dirname, "../../../lib/indexer.ts");
      const fileBuffer = fs.readFileSync(filePath);
      const computedHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

      expect(computedHash).toBe(EXPECTED_INDEXER_SHA256);
    });

    it("4.2 Cryptographic SHA256 integrity of src/hooks/useEventIndexer.ts exactly matches baseline", () => {
      const filePath = path.resolve(__dirname, "../../../hooks/useEventIndexer.ts");
      const fileBuffer = fs.readFileSync(filePath);
      const computedHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

      expect(computedHash).toBe(EXPECTED_HOOK_SHA256);
    });
  });
});
