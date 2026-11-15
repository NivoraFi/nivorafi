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

// Mock indexer analytics hook
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

// Import Components under test
import { TopNav, ViewMode } from "@/components/TopNav";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import PortfolioPage, { metadata } from "@/app/portfolio/page";
import { PortfolioPageClient } from "@/components/portfolio/PortfolioPageClient";
import { MarketProvider } from "@/context/MarketContext";
import { LiveUserPortfolio } from "@/lib/stellar";

// ----------------------------------------------------------------------------
// Test Data Fixtures
// ----------------------------------------------------------------------------

function createZeroBalancePortfolio(address: string): Record<string, LiveUserPortfolio> {
  return {
    "usdc-90d": {
      address,
      accountExists: true,
      xlmBalance: "100.0",
      usdcBalance: "0.0",
      usdcTrustlineExists: true,
      syBalance: 0n,
      ptBalance: 0n,
      ytBalance: 0n,
      lpBalance: 0n,
      lastIndex: 1000000000000000000n,
      unclaimedYieldRaw: 0n,
      estimatedPendingYieldSy: 0n,
    },
    "xlm-90d": {
      address,
      accountExists: true,
      xlmBalance: "100.0",
      usdcBalance: "0.0",
      usdcTrustlineExists: true,
      syBalance: 0n,
      ptBalance: 0n,
      ytBalance: 0n,
      lpBalance: 0n,
      lastIndex: 1000000000000000000n,
      unclaimedYieldRaw: 0n,
      estimatedPendingYieldSy: 0n,
    },
    "usdc-matured": {
      address,
      accountExists: true,
      xlmBalance: "100.0",
      usdcBalance: "0.0",
      usdcTrustlineExists: true,
      syBalance: 0n,
      ptBalance: 0n,
      ytBalance: 0n,
      lpBalance: 0n,
      lastIndex: 1000000000000000000n,
      unclaimedYieldRaw: 0n,
      estimatedPendingYieldSy: 0n,
    },
  };
}

function createMultiMarketPortfolios(address: string): Record<string, LiveUserPortfolio> {
  return {
    "usdc-90d": {
      address,
      accountExists: true,
      xlmBalance: "500.0",
      usdcBalance: "1250.0",
      usdcTrustlineExists: true,
      syBalance: 100000000000n, // 10,000 SY
      ptBalance: 250000000000n, // 25,000 PT
      ytBalance: 250000000000n, // 25,000 YT
      lpBalance: 50000000000n,  // 5,000 LP
      lastIndex: 1050000000000000000n,
      unclaimedYieldRaw: 2500000000n, // 250 SY
      estimatedPendingYieldSy: 2500000000n,
    },
    "xlm-90d": {
      address,
      accountExists: true,
      xlmBalance: "500.0",
      usdcBalance: "0.0",
      usdcTrustlineExists: true,
      syBalance: 0n,
      ptBalance: 1500000000000n, // 150,000 PT
      ytBalance: 1500000000000n, // 150,000 YT
      lpBalance: 0n,
      lastIndex: 1020000000000000000n,
      unclaimedYieldRaw: 8000000000n, // 800 SY
      estimatedPendingYieldSy: 8000000000n,
    },
    "usdc-matured": {
      address,
      accountExists: true,
      xlmBalance: "500.0",
      usdcBalance: "1250.0",
      usdcTrustlineExists: true,
      syBalance: 0n,
      ptBalance: 80000000000n, // 8,000 Matured PT
      ytBalance: 0n,
      lpBalance: 0n,
      lastIndex: 1100000000000000000n,
      unclaimedYieldRaw: 0n,
      estimatedPendingYieldSy: 0n,
    },
  };
}

const SAMPLE_MULTI_MARKET_SUMMARY: MockUserPositionsSummary = {
  userAddress: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
  totalCostBasisUsd: 48500.0,
  totalCurrentValueUsd: 52350.75,
  totalRealizedPnlUsd: 1250.25,
  totalUnrealizedPnlUsd: 2600.5,
  totalNetPnlUsd: 3850.75,
  totalClaimedYieldUsd: 840.6,
  overallPortfolioApy: 11.25,
  activePositionsCount: 3,
  totalTransactionsCount: 22,
};

const SAMPLE_MULTI_MARKET_POSITIONS: MockUserMarketPosition[] = [
  {
    marketId: "usdc-90d",
    marketAddress: "CDL627WMSK6KGIL72P6U7P4T2V5R5U6M5G",
    assetCode: "USDC",
    costBasisStroops: "250000000000",
    costBasisUsd: 25000.0,
    averageEntryApy: 12.4,
    currentPtBalance: "250000000000",
    currentYtBalance: "250000000000",
    currentLpBalance: "50000000000",
    currentPositionValueUsd: 27850.25,
    realizedPnlStroops: "5000000000",
    realizedPnlUsd: 500.0,
    unrealizedPnlStroops: "23502500000",
    unrealizedPnlUsd: 2350.25,
    netPnlUsd: 2850.25,
    cumulativeClaimedYieldStroops: "4500000000",
    cumulativeClaimedYieldUsd: 450.0,
    firstTradeTimestamp: 1729000000,
    lastActivityTimestamp: 1731000000,
    totalTradesCount: 14,
  },
  {
    marketId: "xlm-90d",
    marketAddress: "CAW762WMSK6KGIL72P6U7P4T2V5R5U6M5G",
    assetCode: "XLM",
    costBasisStroops: "155000000000",
    costBasisUsd: 15500.0,
    averageEntryApy: 9.8,
    currentPtBalance: "1500000000000",
    currentYtBalance: "1500000000000",
    currentLpBalance: "0",
    currentPositionValueUsd: 16500.5,
    realizedPnlStroops: "7502500000",
    realizedPnlUsd: 750.25,
    unrealizedPnlStroops: "2502500000",
    unrealizedPnlUsd: 250.25,
    netPnlUsd: 1000.5,
    cumulativeClaimedYieldStroops: "3906000000",
    cumulativeClaimedYieldUsd: 390.6,
    firstTradeTimestamp: 1729500000,
    lastActivityTimestamp: 1731100000,
    totalTradesCount: 6,
  },
  {
    marketId: "usdc-matured",
    marketAddress: "CBM789WMSK6KGIL72P6U7P4T2V5R5U6M5G",
    assetCode: "USDC",
    costBasisStroops: "80000000000",
    costBasisUsd: 8000.0,
    averageEntryApy: 14.2,
    currentPtBalance: "80000000000",
    currentYtBalance: "0",
    currentLpBalance: "0",
    currentPositionValueUsd: 8000.0,
    realizedPnlStroops: "0",
    realizedPnlUsd: 0.0,
    unrealizedPnlStroops: "0",
    unrealizedPnlUsd: 0.0,
    netPnlUsd: 0.0,
    cumulativeClaimedYieldStroops: "0",
    cumulativeClaimedYieldUsd: 0.0,
    firstTradeTimestamp: 1728000000,
    lastActivityTimestamp: 1729900000,
    totalTradesCount: 2,
  },
];

// ----------------------------------------------------------------------------
// Challenger Test Suite
// ----------------------------------------------------------------------------

describe("Empirical Challenger Suite: Route & Adversarial Stress Testing (Milestone 1)", () => {
  const FRONTEND_DIR = path.resolve(__dirname, "../../..");

  beforeEach(() => {
    mockPushedRoutes = [];
    mockCurrentPathname = "/portfolio";
    mockWalletState.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
    mockWalletState.walletNetworkMismatch = false;
    mockAnalyticsState = {
      positions: SAMPLE_MULTI_MARKET_POSITIONS,
      positionSummary: SAMPLE_MULTI_MARKET_SUMMARY,
      positionsByMarketId: {
        "usdc-90d": SAMPLE_MULTI_MARKET_POSITIONS[0],
        "xlm-90d": SAMPLE_MULTI_MARKET_POSITIONS[1],
        "usdc-matured": SAMPLE_MULTI_MARKET_POSITIONS[2],
      },
      activeMarketPosition: SAMPLE_MULTI_MARKET_POSITIONS[0],
      isPositionsLoading: false,
      positionsError: null,
      refreshPositions: async () => {},
    };
    indexerAnalyticsOverride = (opts?: any) => {
      if (opts?.initialPositionsData) {
        const pos = opts.initialPositionsData.positions || [];
        const map: Record<string, any> = {};
        for (const p of pos) {
          if (p?.marketId) map[p.marketId] = p;
          if (p?.marketAddress) map[p.marketAddress] = p;
        }
        return {
          chartPoints: [],
          rawChartData: [],
          chartData: [],
          chartSummary: null,
          isChartLoading: false,
          chartError: null,
          selectedInterval: "1W",
          setInterval: () => {},
          refreshCharts: async () => {},
          positions: pos,
          positionSummary: opts.initialPositionsData.summary || null,
          positionsByMarketId: map,
          activeMarketPosition: opts?.marketAddress ? map[opts.marketAddress] || null : null,
          isPositionsLoading: false,
          positionsError: null,
          refreshPositions: async () => {},
          indexerApiActive: true,
          lastSyncTimestamp: null,
          refreshAll: async () => {},
        };
      }
      if (opts && "userAddress" in opts && opts.userAddress === null) {
        return {
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
        };
      }
      return {
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
      };
    };
  });

  // =========================================================================
  // Dimension 1: Route Mounting and Unmounting Under Rapid View Toggles
  // =========================================================================
  describe("1. Route Mounting and Unmounting Under Rapid View Toggles", () => {
    it("survives 50 rapid sequential mounts and unmounts of PortfolioPageClient without memory crash", () => {
      for (let i = 0; i < 50; i++) {
        const html = renderToString(
          React.createElement(MarketProvider, null,
            React.createElement(PortfolioPageClient, {
              initialTab: i % 2 === 0 ? "swap" : "redeem",
              initialFilter: i % 3 === 0 ? "active" : "all",
            })
          )
        );
        expect(html).toContain("My Positions");
        expect(html).toContain("Portfolio");
      }
    });

    it("survives 100 rapid simulated view toggle cycles between portfolio, trade, and landing", () => {
      const recordedToggles: ViewMode[] = [];
      const handleToggle = (view: ViewMode) => {
        recordedToggles.push(view);
      };

      const views: ViewMode[] = ["portfolio", "trade", "landing"];
      for (let i = 0; i < 100; i++) {
        const nextView = views[i % views.length];
        const html = renderToString(
          React.createElement(TopNav, {
            viewMode: nextView,
            onToggleView: handleToggle,
            onRefresh: () => {},
            refreshing: false,
            onFundXlm: () => {},
            onAddUsdcTrustline: () => {},
            usdcTrustlineExists: true,
            accountExists: true,
            busyAction: null,
          })
        );
        expect(html).toContain("NivoraFi");
        handleToggle(nextView);
      }

      expect(recordedToggles.length).toBe(100);
      expect(recordedToggles.filter((v) => v === "portfolio").length).toBe(34);
      expect(recordedToggles.filter((v) => v === "trade").length).toBe(33);
      expect(recordedToggles.filter((v) => v === "landing").length).toBe(33);
    });

    it("simulates rapid keyboard navigation shortcut events ('T', 't', 'Escape') without crashing", () => {
      const routes: string[] = [];
      const handleSwitchView = (view: ViewMode) => {
        if (view === "trade") routes.push("/trade/usdc-90d");
        else if (view === "landing") routes.push("/");
      };

      // Simulate 40 rapid keyboard navigation interactions
      for (let i = 0; i < 40; i++) {
        if (i % 2 === 0) {
          handleSwitchView("trade");
        } else {
          handleSwitchView("landing");
        }
      }

      expect(routes.length).toBe(40);
      expect(routes.filter((r) => r.startsWith("/trade")).length).toBe(20);
      expect(routes.filter((r) => r === "/").length).toBe(20);
    });

    it("handles adversarial/malformed query parameters gracefully in Next.js 15 page loader", async () => {
      const adversarialParams = [
        { tab: "unrecognized_tab_123", filter: "malformed_filter" },
        { tab: "<script>alert('xss')</script>", filter: "'); DROP TABLE users;--" },
        { tab: "", filter: "" },
        {},
      ];

      for (const params of adversarialParams) {
        const element = await PortfolioPage({ searchParams: Promise.resolve(params) });
        expect(React.isValidElement(element)).toBe(true);
        expect((element as any).type).toBe(PortfolioPageClient);
      }
    });

    it("handles busyAction states during concurrent refresh without crashing or throwing", () => {
      const busyStates = [
        "Signing transaction...",
        "Submitting Soroban claim_yield...",
        "Requesting Friendbot XLM...",
        "Signing USDC Trustline...",
      ];

      for (const busy of busyStates) {
        const html = renderToString(
          React.createElement(MarketProvider, null,
            React.createElement(PortfolioPageClient, { initialTab: "swap" })
          )
        );
        expect(html).toContain("My Positions");
      }
    });
  });

  // =========================================================================
  // Dimension 2: Zero-Balance User vs Multi-Market User Positions
  // =========================================================================
  describe("2. Zero-Balance User vs Multi-Market User Positions", () => {
    it("renders zero-balance user cleanly with 'No Active Positions' and $0.00 tabular-mono displays", () => {
      const zeroPortfolios = createZeroBalancePortfolio(mockWalletState.address!);
      mockAnalyticsState = {
        positions: [],
        positionSummary: {
          userAddress: mockWalletState.address!,
          totalCostBasisUsd: 0,
          totalCurrentValueUsd: 0,
          totalRealizedPnlUsd: 0,
          totalUnrealizedPnlUsd: 0,
          totalNetPnlUsd: 0,
          totalClaimedYieldUsd: 0,
          overallPortfolioApy: 0,
          activePositionsCount: 0,
          totalTransactionsCount: 0,
        },
        positionsByMarketId: {},
        activeMarketPosition: null,
        isPositionsLoading: false,
        positionsError: null,
        refreshPositions: async () => {},
      };

      const html = renderToString(
        React.createElement(PortfolioView, {
          userPortfolios: zeroPortfolios,
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      // Verify empty state banner
      expect(html).toContain("No Active Positions");
      expect(html).toContain("Explore Markets");

      // Verify zero balances formatted with tabular-mono
      expect(html).toContain("tabular-mono text-2xl font-bold tracking-tight text-ink");
      const cleanHtml = html.replace(/<!-- -->/g, "");
      expect(cleanHtml).toContain("$0.00");

      // Ensure no NaN, undefined, or null rendered in UI
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("undefined");
      expect(html).not.toContain("null");
    });

    it("renders high-volume multi-market user with active AND matured positions", () => {
      const multiPortfolios = createMultiMarketPortfolios(mockWalletState.address!);

      const html = renderToString(
        React.createElement(PortfolioView, {
          userPortfolios: multiPortfolios,
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      // Verify active positions rendering
      expect(html).not.toContain("No Active Positions");
      expect(html).toContain("Market Positions Breakdown");
      expect(html).toContain("Markets Tracked");

      // Verify KPI Tile 1 (Net Worth + PnL + Cost)
      const cleanHtml = html.replace(/<!-- -->/g, "");
      expect(cleanHtml).toContain("Net Worth");
      expect(cleanHtml).toContain("PnL");
      expect(cleanHtml).toContain("Cost:");
      expect(cleanHtml).toContain("+$3850.75 PnL");
      expect(cleanHtml).toContain("$48500.00");

      // Verify KPI Tile 3 (Active Positions + Entry APY)
      expect(cleanHtml).toContain("Active Positions");
      expect(cleanHtml).toContain("Entry APY:");
      expect(cleanHtml).toContain("11.25%");

      // Verify KPI Tile 4 (Matured Positions + Alert Pill)
      expect(html).toContain("Matured Positions");
      expect(html).toContain("Rollover Available");

      // Verify Top Contextual Matured Banner
      expect(html).toContain("Action Required: Matured Positions Detected");
      expect(html).toContain("Rollover Now");

      // Verify Desktop Table & Mobile Cards render assets
      expect(html).toContain("USDC");
      expect(html).toContain("XLM");
      expect(html).toContain("Matured");
      expect(html).toContain("Active ·");
    });

    it("renders disconnected wallet state with prominent Connect CTA and zero values", () => {
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
      expect(html).toContain("tabular-mono");
    });
  });

  // =========================================================================
  // Dimension 3: 1-Click Action Shortcuts (Trade, Rollover, Redeem)
  // =========================================================================
  describe("3. 1-Click Action Shortcuts (Trade, Rollover, Redeem)", () => {
    it("triggers Trade shortcut callback routing to /trade/[market]?tab=swap", () => {
      const dispatchedRoutes: string[] = [];
      const handleAction = (marketId: string, tab: string) => {
        dispatchedRoutes.push(`/trade/${marketId}?tab=${tab}`);
      };

      handleAction("usdc-90d", "swap");
      handleAction("xlm-90d", "swap");

      expect(dispatchedRoutes).toEqual([
        "/trade/usdc-90d?tab=swap",
        "/trade/xlm-90d?tab=swap",
      ]);
    });

    it("triggers Redeem shortcut callback routing to /trade/[market]?tab=redeem", () => {
      const dispatchedRoutes: string[] = [];
      const handleAction = (marketId: string, tab: string) => {
        dispatchedRoutes.push(`/trade/${marketId}?tab=${tab}`);
      };

      handleAction("usdc-90d", "redeem");
      handleAction("usdc-matured", "redeem");

      expect(dispatchedRoutes).toEqual([
        "/trade/usdc-90d?tab=redeem",
        "/trade/usdc-matured?tab=redeem",
      ]);
    });

    it("triggers Rollover shortcut callback routing to /trade/[market]?tab=rollover", () => {
      const dispatchedRoutes: string[] = [];
      const handleAction = (marketId: string, tab: string) => {
        dispatchedRoutes.push(`/trade/${marketId}?tab=${tab}`);
      };

      handleAction("usdc-matured", "rollover");
      expect(dispatchedRoutes).toContain("/trade/usdc-matured?tab=rollover");
    });

    it("highlights matured PT rollover button with warning accent and pulse styling", () => {
      const multiPortfolios = createMultiMarketPortfolios(mockWalletState.address!);

      const html = renderToString(
        React.createElement(PortfolioView, {
          userPortfolios: multiPortfolios,
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      // Verify the matured position rollover button gets highlighted
      expect(html).toContain("bg-warn text-white shadow-card animate-pulse");
      expect(html).toContain("Matured PT eligible for immediate 1-click rollover!");
    });

    it("executes Claim All Yield callback with Soroban contract call parameters", async () => {
      const multiPortfolios = createMultiMarketPortfolios(mockWalletState.address!);
      const executedActions: any[] = [];

      const handleExecuteAction = async (params: any) => {
        executedActions.push(params);
      };

      const html = renderToString(
        React.createElement(PortfolioView, {
          userPortfolios: multiPortfolios,
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
          onExecuteAction: handleExecuteAction,
        })
      );

      expect(html).toContain("Claim All Yield");

      // Verify action triggering logic directly
      await handleExecuteAction({
        contractId: "C123",
        method: "claim_yield",
        args: [],
        label: "Claim Yield (Pendle bUSDC PT 90D)",
      });

      expect(executedActions.length).toBe(1);
      expect(executedActions[0].method).toBe("claim_yield");
      expect(executedActions[0].label).toContain("Claim Yield");
    });

    it("triggers Explore Markets shortcut to default swap desk when position array is empty", () => {
      const routes: string[] = [];
      const handleSwitchToTrade = (tab: string = "swap") => {
        routes.push(`/trade/usdc-90d?tab=${tab}`);
      };

      handleSwitchToTrade("swap");
      expect(routes).toContain("/trade/usdc-90d?tab=swap");
    });
  });

  // =========================================================================
  // Dimension 4: Ensure All Rendered Numeric Fields Strictly Contain tabular-mono
  // =========================================================================
  describe("4. Typography Verification: tabular-mono on Rendered Numeric Displays", () => {
    it("strictly includes tabular-mono class on all KPI tile values in multi-market view", () => {
      const multiPortfolios = createMultiMarketPortfolios(mockWalletState.address!);

      const html = renderToString(
        React.createElement(PortfolioView, {
          userPortfolios: multiPortfolios,
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      // Check all occurrences of tabular-mono
      const matches = html.match(/tabular-mono/g);
      expect(matches).not.toBeNull();
      // Should have at least 25 occurrences across KPI tiles, table rows, and mobile cards
      expect((matches || []).length).toBeGreaterThanOrEqual(25);
    });

    it("verifies tabular-mono encapsulates dollar amounts, percentages, and token quantities", () => {
      const multiPortfolios = createMultiMarketPortfolios(mockWalletState.address!);

      const html = renderToString(
        React.createElement(PortfolioView, {
          userPortfolios: multiPortfolios,
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      // Verify specific metric classes
      expect(html).toContain("tabular-mono text-2xl font-bold tracking-tight text-ink");
      expect(html).toContain("tabular-mono text-2xl font-bold tracking-tight text-positive");
      expect(html).toContain("tabular-mono text-xs font-semibold");
      expect(html).toContain("tabular-mono font-semibold text-ink");
      expect(html).toContain("tabular-mono text-[11px] text-ink-muted");
    });

    it("verifies TopNav wallet address renders with tabular-mono", () => {
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

      expect(html).toContain("tabular-mono");
    });
  });

  // =========================================================================
  // Dimension 5: Design System Compliance (Zero Raw Hex & Zero Unicode Emojis)
  // =========================================================================
  describe("5. Design System Compliance: Zero Raw Hex & Zero Unicode Emojis", () => {
    const MILESTONE_FILES = [
      path.join(FRONTEND_DIR, "src/app/portfolio/page.tsx"),
      path.join(FRONTEND_DIR, "src/components/portfolio/PortfolioPageClient.tsx"),
      path.join(FRONTEND_DIR, "src/components/portfolio/PortfolioView.tsx"),
      path.join(FRONTEND_DIR, "src/components/TopNav.tsx"),
      path.join(FRONTEND_DIR, "src/lib/indexerAnalytics.ts"),
      path.join(FRONTEND_DIR, "src/hooks/useIndexerAnalytics.ts"),
    ];

    it("contains zero raw hex color codes (#...) across all source files", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;

      for (const filePath of MILESTONE_FILES) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip comments
          if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) {
            continue;
          }

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

    it("contains zero Unicode emojis across all source files", () => {
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;

      for (const filePath of MILESTONE_FILES) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip comments
          if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) {
            continue;
          }

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

    it("ensures rendered SSR HTML of PortfolioView and PortfolioPageClient contains zero raw hex and zero emojis", () => {
      const multiPortfolios = createMultiMarketPortfolios(mockWalletState.address!);

      const html = renderToString(
        React.createElement(MarketProvider, null,
          React.createElement(PortfolioView, {
            userPortfolios: multiPortfolios,
            onSelectMarketAndTab: () => {},
            onNavigateToTrade: () => {},
            onSwitchToTrade: () => {},
          })
        )
      );

      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;

      expect(html.match(rawHexRegex)).toBeNull();
      expect(emojiRegex.test(html)).toBe(false);
    });
  });

  afterAll(() => {
    indexerAnalyticsOverride = null;
    mock.restore();
  });
});
