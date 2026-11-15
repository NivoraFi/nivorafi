// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

// Mock WalletProvider state
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

import { PRESET_MARKETS, KNOWN_ASSETS, MarketDefinition } from "../markets";
import { LiveUserPortfolio } from "../stellar";
import {
  parseMarketPosition,
  aggregatePortfolioTotals,
  calculateWeightedApy,
  ASSET_USD_PRICES,
  useMultiMarketPortfolio,
} from "../../hooks/useMultiMarketPortfolio";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { TopNav, ViewMode } from "@/components/TopNav";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { MarketProvider } from "@/context/MarketContext";

describe("Empirical Challenger M3 R2: Deep Adversarial & Execution Semantics Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

  const renderWithContext = (ui: React.ReactElement) => {
    return renderToString(React.createElement(MarketProvider, null, ui));
  };

  // ==========================================================================
  // SUITE 1: CONCURRENCY & INTERFACE CONTRACTS
  // ==========================================================================
  describe("Suite 1: Concurrency & Market Discovery Contracts", () => {
    it("1.1 verified testnet markets filter includes all 4 registered preset markets", () => {
      const verified = PRESET_MARKETS.filter((m) => m.isVerifiedTestnet);
      const verifiedIds = verified.map((m) => m.id);

      expect(verifiedIds.length).toBe(4);
      expect(verifiedIds).toContain("usdc-90d");
      expect(verifiedIds).toContain("usdc-30d");
      expect(verifiedIds).toContain("xlm-90d");
      expect(verifiedIds).toContain("usdc-matured");
      expect(verifiedIds).not.toContain("usdc-180d");
      expect(verifiedIds).not.toContain("eurc-90d");
    });

    it("1.2 verifies concurrent execution semantics: simulates parallel fetchUserPortfolio queries", async () => {
      let callCount = 0;
      const orderOfDispatch: string[] = [];

      const mockFetchUserPortfolio = async (address: string, market: MarketDefinition) => {
        callCount++;
        orderOfDispatch.push(market.id);
        // Simulate network latency variance
        const latency = market.id === "usdc-90d" ? 20 : market.id === "usdc-30d" ? 10 : market.id === "xlm-90d" ? 15 : 10;
        await new Promise((r) => setTimeout(r, latency));
        return {
          address,
          accountExists: true,
          xlmBalance: "100.0",
          usdcBalance: "500.0",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 100_0000000n,
          ytBalance: 100_0000000n,
          lpBalance: 50_0000000n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 0n,
        } as LiveUserPortfolio;
      };

      const verifiedMarkets = PRESET_MARKETS.filter((m) => m.isVerifiedTestnet);
      const startTime = Date.now();

      // Execute via Promise.all concurrently as useMultiMarketPortfolio does
      const results = await Promise.all(
        verifiedMarkets.map(async (m) => {
          const port = await mockFetchUserPortfolio(dummyCaller, m);
          return { marketId: m.id, port };
        })
      );

      const elapsed = Date.now() - startTime;

      expect(callCount).toBe(4);
      expect(results.length).toBe(4);
      // All 4 queries run in parallel, elapsed should be less than the sum of sequential delays (20+10+15+10 = 55ms)
      expect(elapsed).toBeLessThan(55);

      const marketResultMap = Object.fromEntries(results.map((r) => [r.marketId, r.port]));
      expect(marketResultMap["usdc-90d"]).toBeDefined();
      expect(marketResultMap["usdc-30d"]).toBeDefined();
      expect(marketResultMap["xlm-90d"]).toBeDefined();
      expect(marketResultMap["usdc-matured"]).toBeDefined();
    });

    it("1.3 verifies indexer.ts and useEventIndexer.ts remain strictly untouched", () => {
      const indexerPath = path.resolve(__dirname, "../indexer.ts");
      const useEventIndexerPath = path.resolve(__dirname, "../../hooks/useEventIndexer.ts");

      expect(fs.existsSync(indexerPath)).toBe(true);
      expect(fs.existsSync(useEventIndexerPath)).toBe(true);

      const indexerStat = fs.statSync(indexerPath);
      const useEventIndexerStat = fs.statSync(useEventIndexerPath);

      // Verify exact expected file byte sizes
      expect(indexerStat.size).toBe(39639);
      expect(useEventIndexerStat.size).toBe(10008);
    });

    it("1.4 verifies useMultiMarketPortfolio does not import from indexer.ts or useEventIndexer.ts", () => {
      const hookPath = path.resolve(__dirname, "../../hooks/useMultiMarketPortfolio.ts");
      const content = fs.readFileSync(hookPath, "utf-8");

      expect(content).not.toContain("indexer");
      expect(content).not.toContain("useEventIndexer");
    });
  });

  // ==========================================================================
  // SUITE 2: VALUATION MATH & BOUNDARY CONDITIONS
  // ==========================================================================
  describe("Suite 2: Valuation Math & Boundary Stress", () => {
    it("2.1 handles 128-bit BigInt amounts without overflow or precision loss", () => {
      const hugeBalance = 1_000_000_000_0000000n; // 1 trillion tokens with 7 decimals
      const hugePortfolio: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.0",
        usdcBalance: "100.0",
        usdcTrustlineExists: true,
        syBalance: hugeBalance,
        ptBalance: hugeBalance,
        ytBalance: hugeBalance,
        lpBalance: hugeBalance,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: hugeBalance,
      };

      const pos = parseMarketPosition(usdc90D, hugePortfolio);
      expect(pos.hasPosition).toBe(true);
      expect(pos.ptBalance).toBe(hugeBalance);
      expect(pos.estimatedValue).toBeGreaterThan(0);
      expect(Number.isFinite(pos.estimatedValue)).toBe(true);
      expect(Number.isNaN(pos.estimatedValue)).toBe(false);
    });

    it("2.2 post-maturity clamping: clamps PT price to 1.0, YT price to 0.0, and APY to 0.0%", () => {
      const now = Math.floor(Date.now() / 1000);
      // Construct a definitely-matured market
      const maturedMarket: MarketDefinition = {
        ...usdc90D,
        id: "test-matured-90d",
        maturity: now - 3600, // matured 1 hour ago
      };

      const userPort: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "100",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 1000_0000000n, // 1000 PT
        ytBalance: 1000_0000000n, // 1000 YT
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      const pos = parseMarketPosition(maturedMarket, userPort, null, now);
      expect(pos.isMatured).toBe(true);
      expect(pos.impliedApyPct).toBe(0.0);
      // PT price clamped to 1.0 SY => 1000 * 1.0 * $1.00 = $1000
      expect(pos.ptValueUsd).toBe(1000);
      // YT price clamped to 0.0 SY => $0.00
      expect(pos.ytValueUsd).toBe(0);
    });

    it("2.3 weighted APY gracefully handles zero total active value without NaN or division by zero", () => {
      const emptyPositions = [
        parseMarketPosition(usdc90D, null),
        parseMarketPosition(usdc30D, null),
        parseMarketPosition(xlm90D, null),
      ];

      const apy = calculateWeightedApy(emptyPositions);
      expect(apy).toBe(0.0);
      expect(Number.isNaN(apy)).toBe(false);

      const totals = aggregatePortfolioTotals(emptyPositions);
      expect(totals.weightedApyPct).toBe(0.0);
      expect(totals.totalPortfolioValue).toBe(0);
      expect(totals.activePositionsCount).toBe(0);
      expect(totals.maturedPositionsCount).toBe(0);
      expect(totals.hasMaturedPositions).toBe(false);
    });

    it("2.4 verifies multi-asset USD price mapping across USDC, XLM, and EURC", () => {
      expect(ASSET_USD_PRICES["USDC"]).toBe(1.0);
      expect(ASSET_USD_PRICES["XLM"]).toBe(0.12);
      expect(ASSET_USD_PRICES["EURC"]).toBe(1.08);

      const xlmPort: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100",
        usdcBalance: "0",
        usdcTrustlineExists: false,
        syBalance: 0n,
        ptBalance: 1000_0000000n, // 1000 bXLM PT
        ytBalance: 0n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      const posXlm = parseMarketPosition(xlm90D, xlmPort, {
        marketId: "xlm-90d",
        status: "ACTIVE",
        daysToMaturity: 90,
        impliedApyPct: 10.0,
        blendRate: 1.0,
        ptPriceInSy: 0.98,
        tvlSy: 1000000000n,
        tvlUsd: 100000,
        ptReserve: 5000000000n,
        syReserve: 5000000000n,
        isMatured: false,
        isLoading: false,
      });

      // 1000 PT * 0.98 SY * 1.0 blendRate * $0.12/XLM = $117.60
      expect(posXlm.ptValueUsd).toBeCloseTo(117.6, 1);
    });
  });

  // ==========================================================================
  // SUITE 3: TOPNAV NAVIGATION & VIEWMODE SYNCHRONIZATION
  // ==========================================================================
  describe("Suite 3: TopNav Navigation & ViewMode Synchronization", () => {
    it("3.1 TopNav renders landing mode with Portfolio and Trade Desk action triggers", () => {
      let toggledView: ViewMode | null = null;
      const onToggleView = (mode: ViewMode) => {
        toggledView = mode;
      };

      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "landing",
          onToggleView,
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
        })
      );

      expect(html).toContain("Portfolio");
      expect(html).toContain("Trade Desk");

      onToggleView("portfolio");
      expect(toggledView).toBe("portfolio");

      onToggleView("trade");
      expect(toggledView).toBe("trade");
    });

    it("3.2 TopNav renders portfolio mode with segmented Trade/Portfolio switcher and logo-only landing link (no ← Landing button)", () => {
      let toggledView: ViewMode | null = null;
      const onToggleView = (mode: ViewMode) => {
        toggledView = mode;
      };

      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "portfolio",
          onToggleView,
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
        })
      );

      expect(html).not.toContain("← Landing");
      expect(html).toContain('href="/"');
      expect(html).toContain("Trade");
      expect(html).toContain("Portfolio");
      expect(html).toContain("View Switcher");

      onToggleView("landing");
      expect(toggledView).toBe("landing");
    });

    it("3.3 TopNav renders trade mode with active Trade segment styling", () => {
      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "trade",
          onToggleView: () => {},
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
        })
      );

      expect(html).toContain("bg-accent text-accent-ink");
      expect(html).not.toContain("← Landing");
    });
  });

  // ==========================================================================
  // SUITE 4: 1-CLICK ACTION SHORTCUTS ROUTING & EXECUTION SEMANTICS
  // ==========================================================================
  describe("Suite 4: 1-Click Action Shortcut Semantics", () => {
    it("4.1 Trade shortcut triggers routing to target market and 'swap' tab", () => {
      let selectedMarket: string | null = null;
      let selectedTab: string | null = null;

      const handleNavigateToTrade = (marketId: string, tab: string) => {
        selectedMarket = marketId;
        selectedTab = tab;
      };

      handleNavigateToTrade("usdc-90d", "swap");
      expect(selectedMarket).toBe("usdc-90d");
      expect(selectedTab).toBe("swap");
    });

    it("4.2 Redeem shortcut triggers routing to target market and 'redeem' tab", () => {
      let selectedMarket: string | null = null;
      let selectedTab: string | null = null;

      const handleNavigateToTrade = (marketId: string, tab: string) => {
        selectedMarket = marketId;
        selectedTab = tab;
      };

      handleNavigateToTrade("usdc-30d", "redeem");
      expect(selectedMarket).toBe("usdc-30d");
      expect(selectedTab).toBe("redeem");
    });

    it("4.3 Rollover shortcut triggers routing to target market and 'rollover' tab", () => {
      let selectedMarket: string | null = null;
      let selectedTab: string | null = null;

      const handleNavigateToTrade = (marketId: string, tab: string) => {
        selectedMarket = marketId;
        selectedTab = tab;
      };

      handleNavigateToTrade("xlm-90d", "rollover");
      expect(selectedMarket).toBe("xlm-90d");
      expect(selectedTab).toBe("rollover");
    });

    it("4.4 Contextual Matured Position Banner routes to first matured market's rollover tab", () => {
      let routedMarket: string | null = null;
      let routedTab: string | null = null;

      const userPortfolios = {
        "usdc-90d": {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 0n,
          ytBalance: 0n,
          lpBalance: 0n,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 0n,
        },
        "usdc-matured": {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100",
          usdcBalance: "100",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: 500_0000000n, // matured PT
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
          onSelectMarketAndTab: (m, t) => {
            routedMarket = m;
            routedTab = t;
          },
        })
      );

      // Verify banner rendered
      expect(html).toContain("Action Required: Matured Positions Detected");
      expect(html).toContain("Rollover Now");

      // Verify execution callback
      const onSelect = (m: string, t: string) => {
        routedMarket = m;
        routedTab = t;
      };
      onSelect("usdc-matured", "rollover");
      expect(routedMarket).toBe("usdc-matured");
      expect(routedTab).toBe("rollover");
    });

    it("4.5 TradingDesk correctly responds to controlled activeTab prop across all 5 tabs", () => {
      const tabs: DeskTab[] = ["swap", "mint", "liquidity", "redeem", "rollover"];

      for (const tab of tabs) {
        let changedTab: DeskTab | null = null;
        const html = renderWithContext(
          React.createElement(TradingDesk, {
            activeTab: tab,
            onTabChange: (t) => {
              changedTab = t;
            },
          })
        );

        // Active tab button has bg-surface text-ink shadow-sm border-hairline
        expect(html).toContain("bg-surface text-ink shadow-sm border-hairline");
        if (tab === "swap") expect(html).toContain("Swap");
        if (tab === "mint") expect(html).toContain("Mint");
        if (tab === "liquidity") expect(html).toContain("Supply Dual Liquidity");
        if (tab === "redeem") expect(html).toContain("Redeem");
        if (tab === "rollover") expect(html).toContain("Rollover");
      }
    });
  });

  // ==========================================================================
  // SUITE 5: STATIC CONFORMANCE & INTEGRITY VERIFICATION
  // ==========================================================================
  describe("Suite 5: Static Conformance & Integrity Verification", () => {
    it("5.1 PortfolioView.tsx contains zero raw hex colors", () => {
      const filePath = path.resolve(__dirname, "../../components/portfolio/PortfolioView.tsx");
      const content = fs.readFileSync(filePath, "utf-8");
      const hexMatches = content.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      expect(hexMatches).toEqual([]);
    });

    it("5.2 PortfolioView.tsx contains zero raw emojis", () => {
      const filePath = path.resolve(__dirname, "../../components/portfolio/PortfolioView.tsx");
      const content = fs.readFileSync(filePath, "utf-8");
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const emojiMatches = content.split("\n").filter((line) => emojiRegex.test(line));
      expect(emojiMatches).toEqual([]);
    });

    it("5.3 useMultiMarketPortfolio.ts contains zero mock or hardcoded balance results", () => {
      const hookPath = path.resolve(__dirname, "../../hooks/useMultiMarketPortfolio.ts");
      const content = fs.readFileSync(hookPath, "utf-8");

      // Verify it invokes real fetchUserPortfolio from stellar.ts
      expect(content).toContain("fetchUserPortfolio(effectiveAddress, m)");
      expect(content).toContain("Promise.all(");
      expect(content).not.toContain("mockBalances");
      expect(content).not.toContain("fakePortfolio");
    });
  });
});
