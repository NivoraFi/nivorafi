// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

import { PRESET_MARKETS } from "../markets";
import {
  getFriendlyActionName,
  resolveScopedBusyAction,
  LiveMarketSnapshot,
  LiveUserPortfolio,
} from "../stellar";
import {
  createMockWalletState,
  createMockSnapshot,
  createMockPortfolio,
  DUMMY_TEST_WALLET_ADDRESS,
} from "./e2e/helpers/e2e-oracle";

// Controlled mock contexts
const mockWalletState = createMockWalletState();
const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
const mockSnapshot = createMockSnapshot(usdc90d);
const mockPortfolio = createMockPortfolio(usdc90d, {
  xlmBalance: "500.00",
  usdcBalance: "2500.00",
  syBalance: 1000_0000000n,
  ptBalance: 1000_0000000n,
  ytBalance: 1000_0000000n,
  lpBalance: 500_0000000n,
  usdcTrustlineExists: true,
});

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => mockWalletState.walletNetworkMismatch,
}));

mock.module("@/context/MarketContext", () => ({
  useMarket: () => ({
    markets: PRESET_MARKETS,
    activeMarket: usdc90d,
    activeMarketId: usdc90d.id,
    selectMarket: () => {},
    activeSnapshot: mockSnapshot,
    activePortfolio: mockPortfolio,
    loadingSnapshot: false,
    loadingPortfolio: false,
    marketMetrics: {
      [usdc90d.id]: {
        marketId: usdc90d.id,
        status: "ACTIVE" as const,
        daysToMaturity: mockSnapshot.daysToMaturity,
        impliedApyPct: mockSnapshot.impliedFixedApyPct,
        blendRate: 1.001,
        ptPriceInSy: mockSnapshot.ptPriceInSy,
        tvlSy: mockSnapshot.syTotalSupply,
        tvlUsd: 120000,
        ptReserve: mockSnapshot.state.total_pt_reserve,
        syReserve: mockSnapshot.state.total_sy_reserve,
        isMatured: mockSnapshot.isMatured,
        isLoading: false,
      },
    },
    refreshActiveMarket: async () => {},
    refreshAllMetrics: async () => {},
  }),
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";

describe("Scoped Busy Actions & Human-Friendly CTA Labels Test Suite", () => {
  // ==========================================================================
  // SUITE 1: getFriendlyActionName METHOD MAPPING
  // ==========================================================================
  describe("Suite 1: getFriendlyActionName Method Mapping", () => {
    const expectedMappings: Record<string, string> = {
      swap_sy_for_pt: "Swap",
      swap_pt_for_sy: "Swap",
      swap_sy_for_yt: "Swap",
      swap_yt_for_sy: "Swap",
      deposit: "Wrap",
      redeem: "Unwrap",
      mint_py: "Mint",
      add_liquidity: "Add Liquidity",
      remove_liquidity: "Remove Liquidity",
      redeem_py: "Redeem",
      redeem_pt_post_maturity: "Redeem",
      redeem_pt_to_btoken: "Redeem",
      claim_yield: "Claim Yield",
      rollover_to_pt: "Rollover",
      rollover_to_py: "Rollover",
    };

    it("1.1 maps every Soroban contract method to clean English label with zero underscores", () => {
      for (const [method, expectedLabel] of Object.entries(expectedMappings)) {
        const result = getFriendlyActionName(method);
        expect(result).toBe(expectedLabel);
        expect(result).not.toContain("_");
      }
    });

    it("1.2 gracefully formats unknown contract methods without underscores", () => {
      const unknownResult = getFriendlyActionName("emergency_withdraw_funds");
      expect(unknownResult).toBe("Emergency Withdraw Funds");
      expect(unknownResult).not.toContain("_");
    });
  });

  // ==========================================================================
  // SUITE 2: resolveScopedBusyAction ORACLE LOGIC
  // ==========================================================================
  describe("Suite 2: resolveScopedBusyAction Oracle Logic", () => {
    const poolId = usdc90d.contracts.poolId;

    it("2.1 returns matching message when method is present in busyActions for the contract", () => {
      const busyActions = {
        [`${poolId}:swap_sy_for_pt`]: "Confirming Swap...",
      };
      const result = resolveScopedBusyAction(
        busyActions,
        null,
        poolId,
        ["swap_sy_for_pt", "swap_pt_for_sy"]
      );
      expect(result).toBe("Confirming Swap...");
    });

    it("2.2 returns null when busyActions does not contain any of the requested methods", () => {
      const busyActions = {
        [`${poolId}:swap_sy_for_pt`]: "Confirming Swap...",
      };
      const result = resolveScopedBusyAction(
        busyActions,
        null,
        poolId,
        ["add_liquidity", "remove_liquidity"]
      );
      expect(result).toBeNull();
    });

    it("2.3 returns null when busyActions contains a method for a different contractId", () => {
      const busyActions = {
        [`CAAAAAAA_DIFFERENT_CONTRACT:swap_sy_for_pt`]: "Confirming Swap...",
      };
      const result = resolveScopedBusyAction(
        busyActions,
        null,
        poolId,
        ["swap_sy_for_pt"]
      );
      expect(result).toBeNull();
    });

    it("2.4 falls back to legacyBusyAction when busyActions is undefined (backward compatibility)", () => {
      const resultWithLegacy = resolveScopedBusyAction(
        undefined,
        "Submitting Action...",
        poolId,
        ["swap_sy_for_pt"]
      );
      expect(resultWithLegacy).toBe("Submitting Action...");

      const resultWithoutLegacy = resolveScopedBusyAction(
        undefined,
        null,
        poolId,
        ["swap_sy_for_pt"]
      );
      expect(resultWithoutLegacy).toBeNull();
    });
  });

  // ==========================================================================
  // SUITE 3: TradingDesk TAB ISOLATION WITH SCOPED BUSY STATE
  // ==========================================================================
  describe("Suite 3: TradingDesk Tab Isolation with Scoped Busy State", () => {
    const poolId = usdc90d.contracts.poolId;
    const busyActions: Record<string, string> = {
      [`${poolId}:swap_sy_for_pt`]: "Confirming Swap...",
    };

    const renderDesk = (activeTab: DeskTab, scopedActions?: Record<string, string>, legacyBusy: string | null = null) => {
      return renderToString(
        React.createElement(TradingDesk, {
          snapshot: mockSnapshot,
          portfolio: mockPortfolio,
          busyAction: legacyBusy,
          busyActions: scopedActions,
          activeTab,
          onExecuteAction: async () => {},
        })
      );
    };

    it("3.1 renders 'Confirming Swap...' and disables Swap button when Swap is in flight", () => {
      const html = renderDesk("swap", busyActions, null);
      expect(html).toContain("Confirming Swap...");
      // Button must be disabled
      expect(html).toContain("disabled");
    });

    it("3.2 leaves Mint tab action button unlocked without 'Confirming Swap...' when Swap is in flight", () => {
      const html = renderDesk("mint", busyActions, null);
      expect(html).not.toContain("Confirming Swap...");
      // Should show normal Mint CTA label
      expect(html).toContain("Wrap USDC into SY");
    });

    it("3.3 leaves Pool/Liquidity tab action button unlocked without 'Confirming Swap...' when Swap is in flight", () => {
      const html = renderDesk("liquidity", busyActions, null);
      expect(html).not.toContain("Confirming Swap...");
      // Should show normal Supply Dual Liquidity CTA
      expect(html).toContain("Supply Dual Liquidity");
    });

    it("3.4 leaves Redeem tab action button unlocked without 'Confirming Swap...' when Swap is in flight", () => {
      const html = renderDesk("redeem", busyActions, null);
      expect(html).not.toContain("Confirming Swap...");
      expect(html).toContain("Merge PT + YT");
    });

    it("3.5 leaves Rollover tab action button unlocked without 'Confirming Swap...' when Swap is in flight", () => {
      const html = renderDesk("rollover", busyActions, null);
      expect(html).not.toContain("Confirming Swap...");
    });
  });

  // ==========================================================================
  // SUITE 4: LEGACY FALLBACK COMPATIBILITY
  // ==========================================================================
  describe("Suite 4: Legacy Fallback Compatibility (busyAction without busyActions)", () => {
    const legacyBusy = "Confirming Swap...";

    const renderDeskLegacy = (activeTab: DeskTab) => {
      return renderToString(
        React.createElement(TradingDesk, {
          snapshot: mockSnapshot,
          portfolio: mockPortfolio,
          busyAction: legacyBusy,
          activeTab,
          onExecuteAction: async () => {},
        })
      );
    };

    it("4.1 locks Swap tab when legacy busyAction is provided without busyActions", () => {
      const html = renderDeskLegacy("swap");
      expect(html).toContain("Confirming Swap...");
    });

    it("4.2 locks Mint tab when legacy busyAction is provided without busyActions", () => {
      const html = renderDeskLegacy("mint");
      expect(html).toContain("Confirming Swap...");
    });

    it("4.3 locks Liquidity tab when legacy busyAction is provided without busyActions", () => {
      const html = renderDeskLegacy("liquidity");
      expect(html).toContain("Confirming Swap...");
    });

    it("4.4 locks Redeem tab when legacy busyAction is provided without busyActions", () => {
      const html = renderDeskLegacy("redeem");
      expect(html).toContain("Confirming Swap...");
    });

    it("4.5 locks Rollover tab when legacy busyAction is provided without busyActions", () => {
      const html = renderDeskLegacy("rollover");
      expect(html).toContain("Confirming Swap...");
    });
  });
});
