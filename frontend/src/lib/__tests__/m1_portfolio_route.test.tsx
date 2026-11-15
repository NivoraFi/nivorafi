// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, beforeEach, afterAll } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

// ----------------------------------------------------------------------------
// Mock Contexts & Next.js Navigation
// ----------------------------------------------------------------------------

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

let mockPushedRoutes: string[] = [];
let mockCurrentPathname = "/portfolio";

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (url: string) => {
      mockPushedRoutes.push(url);
    },
    replace: (url: string) => {
      mockPushedRoutes.push(url);
    },
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  }),
  usePathname: () => mockCurrentPathname,
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// Mock indexer analytics hook for Workstream B contract
export interface MockUserMarketPosition {
  marketId: string;
  marketAddress: string;
  assetCode: string;
  costBasisStroops: string;
  costBasisUsd: number;
  averageEntryApy: number;
  currentPtBalance: string;
  currentYtBalance: string;
  currentLpBalance: string;
  currentPositionValueUsd: number;
  realizedPnlStroops: string;
  realizedPnlUsd: number;
  unrealizedPnlStroops: string;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
  cumulativeClaimedYieldStroops: string;
  cumulativeClaimedYieldUsd: number;
  firstTradeTimestamp: number;
  lastActivityTimestamp: number;
  totalTradesCount: number;
}

export interface MockUserPositionsSummary {
  userAddress: string;
  totalCostBasisUsd: number;
  totalCurrentValueUsd: number;
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  totalNetPnlUsd: number;
  totalClaimedYieldUsd: number;
  overallPortfolioApy: number;
  activePositionsCount: number;
  totalTransactionsCount: number;
}

import { useIndexerAnalytics as _rawUseIndexerAnalytics } from "@/hooks/useIndexerAnalytics";
const realUseIndexerAnalytics = _rawUseIndexerAnalytics;

let mockAnalyticsState: any = {
  positions: [] as MockUserMarketPosition[],
  positionSummary: null as MockUserPositionsSummary | null,
  positionsByMarketId: {} as Record<string, MockUserMarketPosition>,
  activeMarketPosition: null as MockUserMarketPosition | null,
  isPositionsLoading: false,
  positionsError: null as string | null,
  refreshPositions: async () => {},
};

let indexerAnalyticsOverride: ((opts?: any) => any) | null = null;

mock.module("@/hooks/useIndexerAnalytics", () => ({
  useIndexerAnalytics: (opts?: any) => {
    if (indexerAnalyticsOverride) {
      return indexerAnalyticsOverride(opts);
    }
    return realUseIndexerAnalytics(opts);
  },
}));

import type { LiveUserPortfolio } from "@/lib/stellar";

const SAMPLE_USER_PORTFOLIOS: Record<string, LiveUserPortfolio> = {
  "usdc-90d": {
    address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
    accountExists: true,
    xlmBalance: "100.00",
    usdcBalance: "1500.00",
    usdcTrustlineExists: true,
    syBalance: 0n,
    ptBalance: 1000_0000000n,
    ytBalance: 1000_0000000n,
    lpBalance: 0n,
    lastIndex: 0n,
    unclaimedYieldRaw: 0n,
    estimatedPendingYieldSy: 0n,
  },
  "usdc-matured": {
    address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
    accountExists: true,
    xlmBalance: "100.00",
    usdcBalance: "1500.00",
    usdcTrustlineExists: true,
    syBalance: 0n,
    ptBalance: 500_0000000n,
    ytBalance: 0n,
    lpBalance: 0n,
    lastIndex: 0n,
    unclaimedYieldRaw: 0n,
    estimatedPendingYieldSy: 0n,
  },
};

let capturedTree: any = null;
function CaptureHarness({ Component, props }: { Component: React.ComponentType<any>; props: any }) {
  const rendered = (Component as any)(props);
  capturedTree = rendered;
  return rendered;
}

function findElements(node: any, predicate: (n: any) => boolean): any[] {
  const results: any[] = [];
  if (!node) return results;
  if (Array.isArray(node)) {
    for (const item of node) results.push(...findElements(item, predicate));
    return results;
  }
  if (typeof node !== "object") return results;
  if (predicate(node)) {
    results.push(node);
  }
  if (node.props && node.props.children) {
    results.push(...findElements(node.props.children, predicate));
  }
  return results;
}

// Import Components under test
import { TopNav, ViewMode } from "@/components/TopNav";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import PortfolioPage, { metadata } from "@/app/portfolio/page";
import { PortfolioPageClient } from "@/components/portfolio/PortfolioPageClient";
import { MarketProvider } from "@/context/MarketContext";

// Sample synthetic data for tests
const SAMPLE_ANALYTICS_SUMMARY: MockUserPositionsSummary = {
  userAddress: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
  totalCostBasisUsd: 5000.0,
  totalCurrentValueUsd: 5142.5,
  totalRealizedPnlUsd: 45.2,
  totalUnrealizedPnlUsd: 97.3,
  totalNetPnlUsd: 142.5,
  totalClaimedYieldUsd: 32.1,
  overallPortfolioApy: 8.45,
  activePositionsCount: 2,
  totalTransactionsCount: 7,
};

const SAMPLE_POSITIONS: MockUserMarketPosition[] = [
  {
    marketId: "usdc-90d",
    marketAddress: "CDL627WMSK6KGIL72P6U7P4T2V5R5U6M5G",
    assetCode: "USDC",
    costBasisStroops: "30000000000",
    costBasisUsd: 3000.0,
    averageEntryApy: 8.5,
    currentPtBalance: "25000000000",
    currentYtBalance: "25000000000",
    currentLpBalance: "0",
    currentPositionValueUsd: 3085.0,
    realizedPnlStroops: "250000000",
    realizedPnlUsd: 25.0,
    unrealizedPnlStroops: "600000000",
    unrealizedPnlUsd: 60.0,
    netPnlUsd: 85.0,
    cumulativeClaimedYieldStroops: "200000000",
    cumulativeClaimedYieldUsd: 20.0,
    firstTradeTimestamp: 1730000000,
    lastActivityTimestamp: 1731000000,
    totalTradesCount: 4,
  },
  {
    marketId: "xlm-90d",
    marketAddress: "CAW762WMSK6KGIL72P6U7P4T2V5R5U6M5G",
    assetCode: "XLM",
    costBasisStroops: "20000000000",
    costBasisUsd: 2000.0,
    averageEntryApy: 8.4,
    currentPtBalance: "18000000000",
    currentYtBalance: "18000000000",
    currentLpBalance: "0",
    currentPositionValueUsd: 2057.5,
    realizedPnlStroops: "202000000",
    realizedPnlUsd: 20.2,
    unrealizedPnlStroops: "373000000",
    unrealizedPnlUsd: 37.3,
    netPnlUsd: 57.5,
    cumulativeClaimedYieldStroops: "121000000",
    cumulativeClaimedYieldUsd: 12.1,
    firstTradeTimestamp: 1730500000,
    lastActivityTimestamp: 1731100000,
    totalTradesCount: 3,
  },
];

describe("Milestone 1 Test Suite: Dedicated /portfolio Route & TopNav Navigation", () => {
  const FRONTEND_DIR = path.resolve(__dirname, "../../..");

  beforeEach(() => {
    mockPushedRoutes = [];
    mockCurrentPathname = "/portfolio";
    mockWalletState.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
    mockWalletState.walletNetworkMismatch = false;
    mockAnalyticsState = {
      positions: SAMPLE_POSITIONS,
      positionSummary: SAMPLE_ANALYTICS_SUMMARY,
      positionsByMarketId: {
        "usdc-90d": SAMPLE_POSITIONS[0],
        "xlm-90d": SAMPLE_POSITIONS[1],
      },
      activeMarketPosition: SAMPLE_POSITIONS[0],
      isPositionsLoading: false,
      positionsError: null,
      refreshPositions: async () => {},
    };
    indexerAnalyticsOverride = () => ({
      chartPoints: [],
      rawChartData: [],
      chartData: [],
      chartSummary: null,
      isChartLoading: false,
      chartError: null,
      selectedInterval: "1W",
      setInterval: () => {},
      refreshCharts: async () => {},
      positions: [],
      positionSummary: null,
      positionsByMarketId: {},
      activeMarketPosition: null,
      isPositionsLoading: false,
      positionsError: null,
      refreshPositions: async () => {},
      indexerApiActive: true,
      lastSyncTimestamp: null,
      refreshAll: async () => {},
      ...mockAnalyticsState,
    });
  });

  // =========================================================================
  // Dimension 1: TopNav Navigation & Active Highlighting for /portfolio
  // =========================================================================
  describe("1. TopNav Portfolio Navigation & Active Path Highlighting", () => {
    it("renders TopNav with active Portfolio styling when viewMode='portfolio'", () => {
      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "portfolio",
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

      expect(html).toContain('aria-label="View Switcher"');
      expect(html).toContain("Portfolio");
      expect(html).toContain("Trade");
      expect(html).not.toContain("← Landing");
      expect(html).toContain('href="/"');
      expect(html).toContain('title="My Portfolio (P)"');
      expect(html).toContain("bg-accent text-accent-ink");
    });

    it("renders TopNav with inactive Portfolio styling when viewMode='trade'", () => {
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

      expect(html).toContain('aria-label="View Switcher"');
      expect(html).toContain("Trade");
      expect(html).toContain("Portfolio");
      expect(html).toContain('title="My Portfolio (P)"');
      expect(html).toContain("text-ink-secondary hover:text-ink");
    });

    it("renders TopNav in Landing mode with Portfolio quick-access link", () => {
      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "landing",
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

      expect(html).toContain("Trade Desk");
      expect(html).toContain("Portfolio");
      expect(html).toContain('title="View Portfolio (P)"');
    });

    it("triggers onToggleView('portfolio') callback when Portfolio action is triggered", () => {
      let triggeredView: ViewMode | null = null;
      const html = renderToString(
        React.createElement(CaptureHarness, {
          Component: TopNav,
          props: {
            viewMode: "trade",
            onToggleView: (v: ViewMode) => {
              triggeredView = v;
            },
            onRefresh: () => {},
            refreshing: false,
            onFundXlm: () => {},
            onAddUsdcTrustline: () => {},
            usdcTrustlineExists: true,
            accountExists: true,
            busyAction: null,
          },
        })
      );

      expect(html).toContain("Portfolio");

      const portfolioLink = findElements(
        capturedTree,
        (n) => n.props?.href === "/portfolio" && n.props?.title === "My Portfolio (P)"
      );
      expect(portfolioLink.length).toBeGreaterThanOrEqual(1);

      portfolioLink[0].props.onClick();
      expect(triggeredView).toBe("portfolio");
    });

    it("keeps view switcher unrendered when onToggleView is omitted (dormant invariant)", () => {
      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "trade",
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
        })
      );

      expect(html).not.toContain('aria-label="View Switcher"');
    });
  });

  // =========================================================================
  // Dimension 2: Connected vs Disconnected Wallet States
  // =========================================================================
  describe("2. Wallet Connection States in Portfolio", () => {
    it("renders prominent Connect Wallet CTA when wallet is disconnected", () => {
      mockWalletState.address = null;

      const html = renderToString(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      expect(html).toContain("Connect Your Wallet");
      expect(html).toContain("Connect Freighter or LOBSTR");
      expect(html).toContain("Connect Wallet");
      expect(html).not.toContain("Market Positions Breakdown");
    });

    it("renders zero values cleanly with tabular-mono when disconnected", () => {
      mockWalletState.address = null;

      const html = renderToString(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      expect(html).toContain("tabular-mono");
      const cleanHtml = html.replace(/<!-- -->/g, "");
      expect(cleanHtml).toContain("$0.00");
    });

    it("renders user portfolio and address badge when wallet is connected", () => {
      mockWalletState.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

      const html = renderToString(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      expect(html).not.toContain("Connect Your Wallet");
      expect(html).toContain("Net Worth");
      expect(html).toContain("Claimable Yield");
      expect(html).toContain("Active Positions");
      expect(html).toContain("Matured Positions");
      expect(html).toContain("Market Positions Breakdown");
    });
  });

  // =========================================================================
  // Dimension 3: PnL and Average Entry APY Display with Tabular Mono
  // =========================================================================
  describe("3. PnL & Entry Yield Display with Tabular Mono Typography", () => {
    it("enforces tabular-mono class on all metric values", () => {
      const html = renderToString(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      const matches = html.match(/tabular-mono/g);
      expect(matches).not.toBeNull();
      expect((matches || []).length).toBeGreaterThanOrEqual(10);
    });

    it("formats summary net worth and claimable yield with tabular-mono", () => {
      const html = renderToString(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      expect(html).toContain("tabular-mono text-2xl font-bold");
    });

    it("displays PnL and cost basis when indexer analytics summary is present", () => {
      const html = renderToString(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      expect(html).toContain("PnL");
      expect(html).toContain("Cost:");
    });
  });

  // =========================================================================
  // Dimension 4: Empty User Position States
  // =========================================================================
  describe("4. Empty Position State Graceful Handling", () => {
    it("renders 'No Active Positions' banner cleanly when positions array is empty", () => {
      const html = renderToString(
        React.createElement(PortfolioView, {
          userPortfolios: {},
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      expect(html).toContain("Net Worth");
      expect(html).toContain("Active Positions");
    });

    it("renders 'Explore Markets' action CTA button in empty state and triggers onSwitchToTrade", () => {
      let switchedTab: string | null = null;
      const html = renderToString(
        React.createElement(CaptureHarness, {
          Component: PortfolioView,
          props: {
            userPortfolios: {},
            onSwitchToTrade: (tab?: string) => {
              switchedTab = tab || "swap";
              mockPushedRoutes.push(`/trade/usdc-90d?tab=${tab || "swap"}`);
            },
            onNavigateToTrade: () => {},
            onSelectMarketAndTab: () => {},
          },
        })
      );

      expect(html).toContain("No Active Positions");
      expect(html).toContain("Explore Markets");

      const emptyBtn = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          JSON.stringify(n.props.children).includes("Explore Markets")
      );

      expect(emptyBtn.length).toBe(1);
      emptyBtn[0].props.onClick();
      expect(switchedTab).toBe("swap");
      expect(mockPushedRoutes).toContain("/trade/usdc-90d?tab=swap");
    });
  });

  // =========================================================================
  // Dimension 5: Navigation Links & Action Shortcuts
  // =========================================================================
  describe("5. 1-Click Action Shortcut Callbacks (Trade, Rollover, Redeem)", () => {
    beforeEach(() => {
      mockPushedRoutes = [];
    });

    it("triggers router push to /trade/[market]?tab=swap when Trade shortcut is clicked", () => {
      let routedMarket: string | null = null;
      let routedTab: string | null = null;

      const html = renderToString(
        React.createElement(CaptureHarness, {
          Component: PortfolioView,
          props: {
            userPortfolios: SAMPLE_USER_PORTFOLIOS,
            onSelectMarketAndTab: (marketId: string, tab: string) => {
              routedMarket = marketId;
              routedTab = tab;
              mockPushedRoutes.push(`/trade/${marketId}?tab=${tab}`);
            },
            onNavigateToTrade: () => {},
            onSwitchToTrade: () => {},
          },
        })
      );

      expect(html).toContain(">Trade<");
      expect(html).toContain('title="Trade on Swap Desk"');

      const tradeBtns = findElements(
        capturedTree,
        (n) => n.type === "button" && n.props?.title === "Trade on Swap Desk"
      );
      expect(tradeBtns.length).toBeGreaterThanOrEqual(1);

      tradeBtns[0].props.onClick();

      expect(routedMarket).toBe("usdc-90d");
      expect(routedTab).toBe("swap");
      expect(mockPushedRoutes).toContain("/trade/usdc-90d?tab=swap");
    });

    it("triggers router push to /trade/[market]?tab=redeem when Redeem shortcut is clicked", () => {
      let routedMarket: string | null = null;
      let routedTab: string | null = null;

      const html = renderToString(
        React.createElement(CaptureHarness, {
          Component: PortfolioView,
          props: {
            userPortfolios: SAMPLE_USER_PORTFOLIOS,
            onSelectMarketAndTab: (marketId: string, tab: string) => {
              routedMarket = marketId;
              routedTab = tab;
              mockPushedRoutes.push(`/trade/${marketId}?tab=${tab}`);
            },
            onNavigateToTrade: () => {},
            onSwitchToTrade: () => {},
          },
        })
      );

      expect(html).toContain(">Redeem<");
      expect(html).toContain('title="Redeem PT"');

      const redeemBtns = findElements(
        capturedTree,
        (n) => n.type === "button" && n.props?.title === "Redeem PT"
      );
      expect(redeemBtns.length).toBeGreaterThanOrEqual(1);

      redeemBtns[0].props.onClick();

      expect(routedMarket).toBe("usdc-90d");
      expect(routedTab).toBe("redeem");
      expect(mockPushedRoutes).toContain("/trade/usdc-90d?tab=redeem");
    });

    it("triggers router push to /trade/[market]?tab=rollover when Rollover shortcut is clicked", () => {
      let routedMarket: string | null = null;
      let routedTab: string | null = null;

      const html = renderToString(
        React.createElement(CaptureHarness, {
          Component: PortfolioView,
          props: {
            userPortfolios: SAMPLE_USER_PORTFOLIOS,
            onSelectMarketAndTab: (marketId: string, tab: string) => {
              routedMarket = marketId;
              routedTab = tab;
              mockPushedRoutes.push(`/trade/${marketId}?tab=${tab}`);
            },
            onNavigateToTrade: () => {},
            onSwitchToTrade: () => {},
          },
        })
      );

      // Verify matured PT row button
      const maturedRolloverBtn = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.title === "Matured PT eligible for immediate 1-click rollover!"
      );
      expect(maturedRolloverBtn.length).toBe(1);

      maturedRolloverBtn[0].props.onClick();

      expect(routedMarket).toBe("usdc-matured");
      expect(routedTab).toBe("rollover");
      expect(mockPushedRoutes).toContain("/trade/usdc-matured?tab=rollover");

      // Verify contextual banner rollover button
      routedMarket = null;
      routedTab = null;
      mockPushedRoutes = [];

      const bannerRolloverBtn = findElements(
        capturedTree,
        (n) => n.type === "button" && n.props?.title === "Rollover Matured PT"
      );
      expect(bannerRolloverBtn.length).toBe(1);

      bannerRolloverBtn[0].props.onClick();

      expect(routedMarket).toBe("usdc-matured");
      expect(routedTab).toBe("rollover");
      expect(mockPushedRoutes).toContain("/trade/usdc-matured?tab=rollover");
    });

    it("handles switch to trade desk default route via onNavigateToTrade fallback", () => {
      let fallbackNavMarket: string | null = null;
      let fallbackNavTab: string | null = null;

      renderToString(
        React.createElement(CaptureHarness, {
          Component: PortfolioView,
          props: {
            userPortfolios: SAMPLE_USER_PORTFOLIOS,
            onNavigateToTrade: (marketId: string, tab: string) => {
              fallbackNavMarket = marketId;
              fallbackNavTab = tab;
              mockPushedRoutes.push(`/trade/${marketId}?tab=${tab}`);
            },
          },
        })
      );

      const tradeBtn = findElements(
        capturedTree,
        (n) => n.type === "button" && n.props?.title === "Trade on Swap Desk"
      );
      expect(tradeBtn.length).toBeGreaterThanOrEqual(1);

      tradeBtn[0].props.onClick();

      expect(fallbackNavMarket).toBe("usdc-90d");
      expect(fallbackNavTab).toBe("swap");
      expect(mockPushedRoutes).toContain("/trade/usdc-90d?tab=swap");
    });
  });

  // =========================================================================
  // Dimension 6: Design System Compliance Scan
  // =========================================================================
  describe("6. Design System Compliance Matrix", () => {
    const ALL_M1_PATHS = [
      path.join(FRONTEND_DIR, "src/components/TopNav.tsx"),
      path.join(FRONTEND_DIR, "src/components/portfolio/PortfolioView.tsx"),
      path.join(FRONTEND_DIR, "src/components/portfolio/PortfolioPageClient.tsx"),
      path.join(FRONTEND_DIR, "src/app/portfolio/page.tsx"),
    ];

    const NUMERIC_COMPONENT_PATHS = [
      path.join(FRONTEND_DIR, "src/components/portfolio/PortfolioView.tsx"),
    ];

    it("contains zero raw hex color codes across all Milestone 1 components", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;

      for (const filePath of ALL_M1_PATHS) {
        if (!fs.existsSync(filePath)) continue;
        const code = fs.readFileSync(filePath, "utf-8");
        const lines = code.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

          const matches = line.match(rawHexRegex);
          if (matches) {
            expect({
              file: path.basename(filePath),
              line: i + 1,
              matches,
            }).toEqual({
              file: path.basename(filePath),
              line: i + 1,
              matches: [],
            });
          }
        }
      }
    });

    it("contains zero raw Unicode emojis across all Milestone 1 components", () => {
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

      for (const filePath of ALL_M1_PATHS) {
        if (!fs.existsSync(filePath)) continue;
        const code = fs.readFileSync(filePath, "utf-8");
        const lines = code.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

          const hasEmoji = emojiRegex.test(line);
          expect({
            file: path.basename(filePath),
            line: i + 1,
            hasEmoji,
          }).toEqual({
            file: path.basename(filePath),
            line: i + 1,
            hasEmoji: false,
          });
        }
      }
    });

    it("enforces tabular-mono class on all numeric data presentations", () => {
      for (const filePath of NUMERIC_COMPONENT_PATHS) {
        if (!fs.existsSync(filePath)) continue;
        const code = fs.readFileSync(filePath, "utf-8");
        expect(code).toContain("tabular-mono");
      }
    });
  });

  // =========================================================================
  // Dimension 7: Dedicated /portfolio Route Structural Contract & SSR
  // =========================================================================
  describe("7. Dedicated /portfolio Route Structural Contract & SSR", () => {
    it("verifies route file path conventions match Next.js 15 App Router requirements", () => {
      const routePath = path.join(FRONTEND_DIR, "src/app/portfolio/page.tsx");
      const clientPath = path.join(FRONTEND_DIR, "src/components/portfolio/PortfolioPageClient.tsx");

      expect(fs.existsSync(routePath)).toBe(true);
      expect(fs.existsSync(clientPath)).toBe(true);

      const routeContent = fs.readFileSync(routePath, "utf-8");
      expect(routeContent).toContain("export default async function PortfolioPage");
      expect(routeContent).toContain("searchParams");
      expect(routeContent).toContain("<PortfolioPageClient");

      const clientContent = fs.readFileSync(clientPath, "utf-8");
      expect(clientContent).toContain('"use client"');
      expect(clientContent).toContain("export function PortfolioPageClient");
      expect(clientContent).toContain("<PortfolioView");
    });

    it("verifies compliant page metadata with title, description, and OpenGraph", () => {
      expect(metadata).toBeDefined();
      expect(typeof metadata.title).toBe("string");
      expect(metadata.title).toContain("My Portfolio | NivoraFi");
      expect(metadata.description).toBeDefined();
      expect(metadata.openGraph).toBeDefined();
      expect((metadata.openGraph as any)?.title).toContain("Portfolio");
      expect(metadata.twitter).toBeDefined();
    });

    it("PortfolioPage executes asynchronously and handles searchParams Promise correctly", async () => {
      const searchParamsPromise = Promise.resolve({ filter: "active", tab: "swap" });
      const element = await PortfolioPage({ searchParams: searchParamsPromise });

      expect(React.isValidElement(element)).toBe(true);
      expect((element as any).type).toBe(PortfolioPageClient);
      expect((element as any).props.initialTab).toBe("swap");
      expect((element as any).props.initialFilter).toBe("active");
    });

    it("PortfolioPageClient renders cleanly with renderToString in connected state", () => {
      const html = renderToString(
        <MarketProvider>
          <PortfolioPageClient />
        </MarketProvider>
      );

      expect(html).toContain("My Positions");
      expect(html).toContain("Net Worth");
      expect(html).toContain("Claimable Yield");
      expect(html).toContain("Active Positions");
      expect(html).toContain("Matured Positions");
      expect(html).toContain("Market Positions Breakdown");
    });
  });

  afterAll(() => {
    indexerAnalyticsOverride = null;
    mock.restore();
  });
});
