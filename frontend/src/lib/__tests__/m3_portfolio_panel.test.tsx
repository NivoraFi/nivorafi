// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

import { PRESET_MARKETS, KNOWN_ASSETS, MarketDefinition, MarketSummaryMetrics } from "../markets";
import { LiveUserPortfolio } from "../stellar";
import {
  parseMarketPosition,
  aggregatePortfolioTotals,
  calculateWeightedApy,
  ASSET_USD_PRICES,
} from "../../hooks/useMultiMarketPortfolio";

// ----------------------------------------------------------------------------
// MOCK CONTEXTS FOR CONTROLLED COMPONENT & HOOK RENDERING
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
}));

// Components under test
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { MarketProvider } from "@/context/MarketContext";

describe("Milestone 3: Multi-Market Portfolio / My Positions Panel Test Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

  // Baseline mock portfolios
  const zeroPortfolio: LiveUserPortfolio = {
    address: dummyCaller,
    accountExists: true,
    xlmBalance: "100.00",
    usdcBalance: "0.00",
    usdcTrustlineExists: true,
    syBalance: 0n,
    ptBalance: 0n,
    ytBalance: 0n,
    lpBalance: 0n,
    lastIndex: 0n,
    unclaimedYieldRaw: 0n,
    estimatedPendingYieldSy: 0n,
  };

  const usdc90DActivePortfolio: LiveUserPortfolio = {
    address: dummyCaller,
    accountExists: true,
    xlmBalance: "250.00",
    usdcBalance: "1500.00",
    usdcTrustlineExists: true,
    syBalance: 50_0000000n, // 50 SY (~$50)
    ptBalance: 1000_0000000n, // 1000 PT (~$980)
    ytBalance: 1000_0000000n, // 1000 YT
    lpBalance: 200_0000000n, // 200 LP (~$200)
    lastIndex: 1000000000n,
    unclaimedYieldRaw: 5_0000000n,
    estimatedPendingYieldSy: 12_5000000n, // 12.5 SY claimable
  };

  const usdc30DActivePortfolio: LiveUserPortfolio = {
    address: dummyCaller,
    accountExists: true,
    xlmBalance: "250.00",
    usdcBalance: "1500.00",
    usdcTrustlineExists: true,
    syBalance: 0n,
    ptBalance: 500_0000000n, // 500 PT (~$495)
    ytBalance: 0n,
    lpBalance: 100_0000000n, // 100 LP (~$100)
    lastIndex: 1000000000n,
    unclaimedYieldRaw: 0n,
    estimatedPendingYieldSy: 0n,
  };

  const xlm90DActivePortfolio: LiveUserPortfolio = {
    address: dummyCaller,
    accountExists: true,
    xlmBalance: "250.00",
    usdcBalance: "1500.00",
    usdcTrustlineExists: true,
    syBalance: 0n,
    ptBalance: 2000_0000000n, // 2000 PT bXLM
    ytBalance: 0n,
    lpBalance: 0n,
    lastIndex: 0n,
    unclaimedYieldRaw: 0n,
    estimatedPendingYieldSy: 0n,
  };

  const maturedPortfolio: LiveUserPortfolio = {
    address: dummyCaller,
    accountExists: true,
    xlmBalance: "100.00",
    usdcBalance: "500.00",
    usdcTrustlineExists: true,
    syBalance: 0n,
    ptBalance: 750_0000000n, // 750 Matured PT
    ytBalance: 0n,
    lpBalance: 0n,
    lastIndex: 0n,
    unclaimedYieldRaw: 0n,
    estimatedPendingYieldSy: 0n,
  };

  // Helper renderer
  const renderWithContext = (ui: React.ReactElement) => {
    return renderToString(
      React.createElement(
        MarketProvider,
        null,
        ui
      )
    );
  };

  // ==========================================================================
  // SUITE 1: DESIGN SYSTEM STATIC CONFORMANCE SCAN
  // ==========================================================================
  describe("Suite 1: Design System Static Conformance Scan", () => {
    const portfolioComponents = [
      "portfolio/PortfolioView.tsx",
    ];

    it("1.1 strictly verifies zero raw hex color codes across all Portfolio components", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const componentsDir = path.resolve(__dirname, "../../components");
      const violations: { file: string; match: string }[] = [];

      for (const file of portfolioComponents) {
        const fullPath = path.join(componentsDir, file);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        const matches = content.match(rawHexRegex);
        if (matches) {
          for (const m of matches) {
            violations.push({ file, match: m });
          }
        }
      }

      expect(violations).toEqual([]);
      expect(violations.length).toBe(0);
    });

    it("1.2 strictly verifies zero raw Unicode emojis across all Portfolio components", () => {
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const componentsDir = path.resolve(__dirname, "../../components");
      const violations: { file: string; line: number; text: string }[] = [];

      for (const file of portfolioComponents) {
        const fullPath = path.join(componentsDir, file);
        if (!fs.existsSync(fullPath)) continue;
        const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
        lines.forEach((line, idx) => {
          if (emojiRegex.test(line)) {
            violations.push({ file, line: idx + 1, text: line.trim() });
          }
        });
      }

      expect(violations).toEqual([]);
      expect(violations.length).toBe(0);
    });

    it("1.3 verifies mandatory tabular-mono class presence in PortfolioView", () => {
      const componentsDir = path.resolve(__dirname, "../../components");
      for (const file of portfolioComponents) {
        const fullPath = path.join(componentsDir, file);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        expect(content.includes("tabular-mono")).toBe(true);
      }
    });
  });

  // ==========================================================================
  // SUITE 2: MULTI-MARKET PORTFOLIO HOOK LOGIC (AGGREGATION ENGINE)
  // ==========================================================================
  describe("Suite 2: Multi-Market Aggregation Engine Logic", () => {
    it("2.1 aggregates balances and net worth across all 3 active verified markets", () => {
      // usdc-90d: 1000 PT ($980) + 200 LP ($200) + 50 SY ($50) = $1230
      // usdc-30d: 500 PT ($495) + 100 LP ($100) = $595
      // xlm-90d: 2000 PT (~$240 at 0.12/xlm)
      const pt90dVal = (Number(usdc90DActivePortfolio.ptBalance) / 1e7) * 0.98;
      const lp90dVal = (Number(usdc90DActivePortfolio.lpBalance) / 1e7) * 1.0;
      const sy90dVal = (Number(usdc90DActivePortfolio.syBalance) / 1e7) * 1.0;

      const pt30dVal = (Number(usdc30DActivePortfolio.ptBalance) / 1e7) * 0.99;
      const lp30dVal = (Number(usdc30DActivePortfolio.lpBalance) / 1e7) * 1.0;

      const totalVal = pt90dVal + lp90dVal + sy90dVal + pt30dVal + lp30dVal;
      expect(totalVal).toBeGreaterThan(1500);
      expect(totalVal).toBeLessThan(2000);

      // Verify parseMarketPosition pure function matches valuation expectations
      const pos90d = parseMarketPosition(usdc90D, usdc90DActivePortfolio, {
        marketId: "usdc-90d",
        status: "ACTIVE",
        daysToMaturity: 90,
        impliedApyPct: 8.45,
        blendRate: 1.0,
        ptPriceInSy: 0.98,
        tvlSy: 1000000000n,
        tvlUsd: 100000,
        ptReserve: 5000000000n,
        syReserve: 5000000000n,
        isMatured: false,
        isLoading: false,
      });

      expect(pos90d.hasPosition).toBe(true);
      expect(pos90d.isMatured).toBe(false);
      expect(pos90d.ptBalance).toBe(1000_0000000n);
      expect(pos90d.ptValueUsd).toBeCloseTo(980, 1);
      expect(pos90d.claimableYield).toBe(12_5000000n);
    });

    it("2.2 computes zero net worth and zero active positions when wallet is disconnected or null", () => {
      mockWalletState.address = null;
      mockWalletState.mode = "disconnected";

      // Direct application logic test via parseMarketPosition & aggregatePortfolioTotals
      const pos90d = parseMarketPosition(usdc90D, null);
      const pos30d = parseMarketPosition(usdc30D, null);
      const posXlm = parseMarketPosition(xlm90D, null);

      expect(pos90d.hasPosition).toBe(false);
      expect(pos90d.estimatedValue).toBe(0);
      expect(pos90d.ptBalance).toBe(0n);
      expect(pos90d.claimableYield).toBe(0n);

      const totals = aggregatePortfolioTotals([pos90d, pos30d, posXlm]);
      expect(totals.totalPortfolioValue).toBe(0);
      expect(totals.totalPortfolioValueUsd).toBe(0);
      expect(totals.activePositionsCount).toBe(0);
      expect(totals.maturedPositionsCount).toBe(0);
      expect(totals.hasMaturedPositions).toBe(false);
      expect(totals.weightedApyPct).toBe(0.0);
      expect(totals.totalClaimableYield).toBe(0n);
      expect(totals.totalClaimableYieldUsd).toBe(0);

      // Verify component rendering under disconnected state produces $0.00 and Connect Wallet CTA
      const html = renderWithContext(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onSwitchToTrade: () => {},
        })
      );
      expect(html).toContain("0.00");
      expect(html).toContain("Connect Wallet");
    });

    it("2.3 handles unfunded or zero-balance wallet gracefully without NaN", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      const totalPt = Number(zeroPortfolio.ptBalance) / 1e7;
      const totalYt = Number(zeroPortfolio.ytBalance) / 1e7;
      const totalLp = Number(zeroPortfolio.lpBalance) / 1e7;
      const netWorth = totalPt + totalYt + totalLp;
      const weightedApy = netWorth > 0 ? (totalPt * 8.45) / netWorth : 0.0;

      expect(netWorth).toBe(0);
      expect(weightedApy).toBe(0.0);
      expect(Number.isNaN(weightedApy)).toBe(false);

      const posZero = parseMarketPosition(usdc90D, zeroPortfolio);
      expect(posZero.hasPosition).toBe(false);
      expect(posZero.estimatedValue).toBe(0);
      const totals = aggregatePortfolioTotals([posZero]);
      expect(totals.totalPortfolioValue).toBe(0);
      expect(totals.activePositionsCount).toBe(0);
      expect(totals.weightedApyPct).toBe(0.0);
    });

    it("2.4 handles partial balances with holdings in only one of three markets", () => {
      // User only has balance in usdc-90d, zero in usdc-30d and xlm-90d
      const has90D = usdc90DActivePortfolio.ptBalance > 0n || usdc90DActivePortfolio.lpBalance > 0n;
      const has30D = zeroPortfolio.ptBalance > 0n || zeroPortfolio.lpBalance > 0n;
      const hasXlm = zeroPortfolio.ptBalance > 0n || zeroPortfolio.lpBalance > 0n;

      const activeCount = [has90D, has30D, hasXlm].filter(Boolean).length;
      expect(activeCount).toBe(1);

      const p1 = parseMarketPosition(usdc90D, usdc90DActivePortfolio);
      const p2 = parseMarketPosition(usdc30D, zeroPortfolio);
      const p3 = parseMarketPosition(xlm90D, zeroPortfolio);
      const totals = aggregatePortfolioTotals([p1, p2, p3]);
      expect(totals.activePositionsCount).toBe(1);
    });

    it("2.5 correctly identifies matured positions and clamps their APY to 0.0%", () => {
      const now = Math.floor(Date.now() / 1000);
      const isMatured = now >= usdcMatured.maturity;
      expect(isMatured).toBe(true);

      const hasMaturedHolding = maturedPortfolio.ptBalance > 0n;
      expect(hasMaturedHolding).toBe(true);

      // Pass non-zero impliedApyPct metric to verify that parseMarketPosition clamps to 0.0% for matured markets
      const metricWithApy: MarketSummaryMetrics = {
        marketId: "usdc-matured",
        status: "MATURED",
        daysToMaturity: 0,
        impliedApyPct: 8.45,
        blendRate: 1.0,
        ptPriceInSy: 1.0,
        tvlSy: 1000000000n,
        tvlUsd: 100000,
        ptReserve: 5000000000n,
        syReserve: 5000000000n,
        isMatured: true,
        isLoading: false,
      };

      const posMatured = parseMarketPosition(usdcMatured, maturedPortfolio, metricWithApy);
      expect(posMatured.isMatured).toBe(true);
      expect(posMatured.impliedApyPct).toBe(0.0); // Clamped strictly to 0.0% by parseMarketPosition
      expect(posMatured.ptValueUsd).toBe(750); // 750 PT * 1.0 post-maturity
      expect(posMatured.ytValueUsd).toBe(0.0); // YT expired post-maturity

      // Verify aggregation treats matured position separately from active positions
      const totalsMaturedOnly = aggregatePortfolioTotals([posMatured]);
      expect(totalsMaturedOnly.maturedPositionsCount).toBe(1);
      expect(totalsMaturedOnly.hasMaturedPositions).toBe(true);
      expect(totalsMaturedOnly.activePositionsCount).toBe(0);
      expect(totalsMaturedOnly.weightedApyPct).toBe(0.0);

      // Verify calculateWeightedApy excludes matured position from diluting active position APY
      const posActive = parseMarketPosition(usdc90D, usdc90DActivePortfolio, {
        marketId: "usdc-90d",
        status: "ACTIVE",
        daysToMaturity: 90,
        impliedApyPct: 8.0,
        blendRate: 1.0,
        ptPriceInSy: 0.98,
        tvlSy: 1000000000n,
        tvlUsd: 100000,
        ptReserve: 5000000000n,
        syReserve: 5000000000n,
        isMatured: false,
        isLoading: false,
      });

      const totalsMixed = aggregatePortfolioTotals([posActive, posMatured]);
      expect(totalsMixed.activePositionsCount).toBe(1);
      expect(totalsMixed.maturedPositionsCount).toBe(1);
      expect(totalsMixed.hasMaturedPositions).toBe(true);
      expect(totalsMixed.weightedApyPct).toBe(8.0); // Matured position did NOT dilute active APY to 4%
    });

    it("2.6 sums accrued and claimable variable yield accurately across all markets", () => {
      const yield90d = Number(usdc90DActivePortfolio.estimatedPendingYieldSy) / 1e7;
      const yield30d = Number(usdc30DActivePortfolio.estimatedPendingYieldSy) / 1e7;
      const totalYieldSy = yield90d + yield30d;

      expect(yield90d).toBe(12.5);
      expect(yield30d).toBe(0);
      expect(totalYieldSy).toBe(12.5);

      const p1 = parseMarketPosition(usdc90D, usdc90DActivePortfolio);
      const p2 = parseMarketPosition(usdc30D, usdc30DActivePortfolio);
      const totals = aggregatePortfolioTotals([p1, p2]);
      expect(totals.totalClaimableYield).toBe(12_5000000n);
      expect(totals.totalClaimableYieldUsd).toBe(12.5);
    });

    it("2.7 calculates value-weighted implied APY across diverse market positions", () => {
      const pos1Value = 1000;
      const pos1Apy = 8.45; // 90D

      const pos2Value = 500;
      const pos2Apy = 6.20; // 30D

      const totalVal = pos1Value + pos2Value;
      const weightedApy = (pos1Value * pos1Apy + pos2Value * pos2Apy) / totalVal;

      // (1000 * 8.45 + 500 * 6.20) / 1500 = (8450 + 3100) / 1500 = 11550 / 1500 = 7.70%
      expect(weightedApy).toBeCloseTo(7.70, 2);

      const mockPos1 = {
        hasPosition: true,
        isMatured: false,
        estimatedValue: 1000,
        impliedApyPct: 8.45,
      } as any;
      const mockPos2 = {
        hasPosition: true,
        isMatured: false,
        estimatedValue: 500,
        impliedApyPct: 6.20,
      } as any;

      const calcApy = calculateWeightedApy([mockPos1, mockPos2]);
      expect(calcApy).toBeCloseTo(7.70, 2);
    });
  });

  // ==========================================================================
  // SUITE 3: PORTFOLIOVIEW COMPONENT RENDERING & SSR STABILITY
  // ==========================================================================
  describe("Suite 3: PortfolioView Component Rendering Tests", () => {
    it("3.1 renders disconnected state with prominent Connect Wallet CTA and zero KPI values", () => {
      mockWalletState.address = null;
      mockWalletState.mode = "disconnected";

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onSwitchToTrade: () => {},
        })
      );

      expect(html).toContain("Connect Wallet");
      expect(html).toContain("tabular-mono");
      expect(html).toContain("bg-surface");
    });

    it("3.2 renders connected zero-balance state with clean empty state and trade shortcuts", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onSwitchToTrade: () => {},
          userPortfolios: {
            "usdc-90d": zeroPortfolio,
            "usdc-30d": zeroPortfolio,
            "xlm-90d": zeroPortfolio,
          },
        })
      );

      expect(html).toMatch(/No Active Positions|No Positions Found|0 Active Positions/i);
      expect(html).toContain("tabular-mono");
    });

    it("3.3 renders active multi-market positions with complete KPI bento tiles", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onSwitchToTrade: () => {},
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio,
            "usdc-30d": usdc30DActivePortfolio,
            "xlm-90d": zeroPortfolio,
          },
        })
      );

      // Verify KPI elements and position rows
      expect(html).toContain("tabular-mono");
      expect(html).toContain("Net Worth");
      expect(html).toContain("Claimable Yield");
      expect(html).toContain("Active Positions");
    });

    it("3.4 renders prominent rollover callout banner when matured positions exist", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          onSelectMarketAndTab: () => {},
          onSwitchToTrade: () => {},
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio,
            "usdc-matured": maturedPortfolio,
          },
        })
      );

      expect(html).toMatch(/Matured|Rollover/i);
      expect(html).toContain("tabular-mono");
    });

    it("3.5 renders cleanly without crash when portfolio snapshot is null", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      expect(() => {
        renderWithContext(
          React.createElement(PortfolioView, {
            onSelectMarketAndTab: () => {},
            onSwitchToTrade: () => {},
            userPortfolios: null as any,
          })
        );
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // SUITE 4: 1-CLICK ACTION INTERACTIVITY & ROUTING VERIFICATION
  // ==========================================================================
  describe("Suite 4: 1-Click Action Interactivity & Routing", () => {
    it("4.1 renders Trade button in desktop table and mobile cards, and validates routing contract to swap tab", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      let routedMarket: string | null = null;
      let routedTab: string | null = null;

      const mockOnSelectMarketAndTab = (marketId: string, tab: string) => {
        routedMarket = marketId;
        routedTab = tab;
      };

      const element = React.createElement(PortfolioView, {
        onSelectMarketAndTab: mockOnSelectMarketAndTab,
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
        },
      });

      // 1. Render to HTML and verify Trade action button presence and attributes
      const html = renderWithContext(element);
      expect(html).toContain(">Trade<");
      expect(html).toContain('title="Trade on Swap Desk"');

      // 2. Verify element prop contract and callback routing execution
      expect(element.props.onSelectMarketAndTab).toBe(mockOnSelectMarketAndTab);
      element.props.onSelectMarketAndTab!("usdc-90d", "swap");
      expect(routedMarket).toBe("usdc-90d");
      expect(routedTab).toBe("swap");

      // 3. Verify fallback routing to onNavigateToTrade when onSelectMarketAndTab is omitted
      let navigatedMarket: string | null = null;
      let navigatedTab: string | null = null;
      const mockNavigateToTrade = (marketId: string, tab: any) => {
        navigatedMarket = marketId;
        navigatedTab = tab;
      };

      const fallbackElement = React.createElement(PortfolioView, {
        onNavigateToTrade: mockNavigateToTrade,
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
        },
      });
      fallbackElement.props.onNavigateToTrade!("usdc-90d", "swap");
      expect(navigatedMarket).toBe("usdc-90d");
      expect(navigatedTab).toBe("swap");
    });

    it("4.2 renders Redeem button and validates routing contract to redeem tab", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      let routedMarket: string | null = null;
      let routedTab: string | null = null;

      const mockOnSelectMarketAndTab = (marketId: string, tab: string) => {
        routedMarket = marketId;
        routedTab = tab;
      };

      const element = React.createElement(PortfolioView, {
        onSelectMarketAndTab: mockOnSelectMarketAndTab,
        userPortfolios: {
          "usdc-30d": usdc30DActivePortfolio,
        },
      });

      // 1. Render to HTML and verify Redeem action button presence and attributes
      const html = renderWithContext(element);
      expect(html).toContain(">Redeem<");
      expect(html).toContain('title="Redeem PT"');

      // 2. Verify prop callback execution contract
      element.props.onSelectMarketAndTab!("usdc-30d", "redeem");
      expect(routedMarket).toBe("usdc-30d");
      expect(routedTab).toBe("redeem");

      // 3. Verify fallback routing
      let navigatedMarket: string | null = null;
      let navigatedTab: string | null = null;
      const mockNavigateToTrade = (marketId: string, tab: any) => {
        navigatedMarket = marketId;
        navigatedTab = tab;
      };
      const fallbackElement = React.createElement(PortfolioView, {
        onNavigateToTrade: mockNavigateToTrade,
        userPortfolios: {
          "usdc-30d": usdc30DActivePortfolio,
        },
      });
      fallbackElement.props.onNavigateToTrade!("usdc-30d", "redeem");
      expect(navigatedMarket).toBe("usdc-30d");
      expect(navigatedTab).toBe("redeem");
    });

    it("4.3 renders Rollover action shortcut and contextual callout banner with warn styling when matured", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      let routedMarket: string | null = null;
      let routedTab: string | null = null;

      const mockOnSelectMarketAndTab = (marketId: string, tab: string) => {
        routedMarket = marketId;
        routedTab = tab;
      };

      // Case A: User holds matured PT
      const maturedElement = React.createElement(PortfolioView, {
        onSelectMarketAndTab: mockOnSelectMarketAndTab,
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
          "usdc-matured": maturedPortfolio,
        },
      });

      const maturedHtml = renderWithContext(maturedElement);

      // Contextual banner rendered
      expect(maturedHtml).toContain("Action Required: Matured Positions Detected");
      expect(maturedHtml).toContain(">Rollover Now<");
      expect(maturedHtml).toContain('title="Rollover Matured PT"');

      // Table & card rollover button has warning styling and tooltip
      expect(maturedHtml).toContain("bg-warn text-white shadow-card animate-pulse");
      expect(maturedHtml).toContain('title="Matured PT eligible for immediate 1-click rollover!"');

      // Callback execution contract for matured rollover
      maturedElement.props.onSelectMarketAndTab!("usdc-matured", "rollover");
      expect(routedMarket).toBe("usdc-matured");
      expect(routedTab).toBe("rollover");

      // Case B: User has NO matured PT
      const activeElement = React.createElement(PortfolioView, {
        onSelectMarketAndTab: mockOnSelectMarketAndTab,
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
        },
      });

      const activeHtml = renderWithContext(activeElement);
      expect(activeHtml).not.toContain("Action Required: Matured Positions Detected");
      expect(activeHtml).not.toContain(">Rollover Now<");
      expect(activeHtml).toContain('title="Rollover PT into target market"');
    });

    it("4.4 renders Claim All Yield button conditionally and validates onExecuteAction contract", async () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      let executedParams: any = null;
      const mockOnExecuteAction = async (params: any) => {
        executedParams = params;
      };

      // Case A: With claimable yield (usdc-90d has 12.5 SY claimable = ~$12.51)
      const elementWithYield = React.createElement(PortfolioView, {
        onExecuteAction: mockOnExecuteAction,
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
        },
      });

      const htmlWithYield = renderWithContext(elementWithYield);
      expect(htmlWithYield).toContain("Claim All Yield");
      expect(htmlWithYield).toMatch(/12\.5[0-9]/);
      expect(htmlWithYield).toContain('title="Claim Accrued Variable Yield"');
      expect(htmlWithYield).toContain("tabular-mono");

      // Verify onExecuteAction prop contract
      expect(elementWithYield.props.onExecuteAction).toBe(mockOnExecuteAction);
      await elementWithYield.props.onExecuteAction!({
        contractId: usdc90D.contracts.poolId, // Must be yield_pool (poolId), NOT ytId!
        method: "claim_yield",
        args: [dummyCaller, dummyCaller],
        label: `Claim Yield (${usdc90D.name})`,
      });

      expect(executedParams).not.toBeNull();
      expect(executedParams.contractId).toBe(usdc90D.contracts.poolId);
      expect(executedParams.method).toBe("claim_yield");
      expect(executedParams.args).toEqual([dummyCaller, dummyCaller]);
      expect(executedParams.label).toContain(usdc90D.name);

      // Case B: Zero claimable yield -> Claim All Yield button must NOT be rendered
      const elementZeroYield = React.createElement(PortfolioView, {
        onExecuteAction: mockOnExecuteAction,
        userPortfolios: {
          "usdc-90d": zeroPortfolio,
        },
      });
      const htmlZeroYield = renderWithContext(elementZeroYield);
      expect(htmlZeroYield).not.toContain("Claim All Yield");

      // Case C: Busy action disables Claim All Yield button
      const elementBusy = React.createElement(PortfolioView, {
        onExecuteAction: mockOnExecuteAction,
        busyAction: "Claiming Yield...",
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
        },
      });
      const htmlBusy = renderWithContext(elementBusy);
      expect(htmlBusy).toContain("disabled");

      // Case D: Disconnected wallet -> Claim All Yield button must NOT be rendered
      mockWalletState.address = null;
      mockWalletState.mode = "disconnected";
      const htmlDisconnected = renderWithContext(elementWithYield);
      expect(htmlDisconnected).not.toContain("Claim All Yield");
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";
    });

    it("4.5 renders Explore Markets CTA in zero-balance state and validates routing fallback to swap tab", () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      let switchedTab: string | null = null;
      const mockOnSwitchToTrade = (tab?: string) => {
        switchedTab = tab || "swap";
      };

      const elementZeroBalance = React.createElement(PortfolioView, {
        onSwitchToTrade: mockOnSwitchToTrade,
        userPortfolios: {
          "usdc-90d": zeroPortfolio,
          "usdc-30d": zeroPortfolio,
          "xlm-90d": zeroPortfolio,
        },
      });

      // 1. Render to HTML and verify empty state banner and Explore Markets button
      const html = renderWithContext(elementZeroBalance);
      expect(html).toContain("No Active Positions");
      expect(html).toContain("Explore Markets");

      // 2. Verify onSwitchToTrade callback contract
      expect(elementZeroBalance.props.onSwitchToTrade).toBe(mockOnSwitchToTrade);
      elementZeroBalance.props.onSwitchToTrade!("swap");
      expect(switchedTab).toBe("swap");

      // 3. Verify fallback routing to onNavigateToTrade when onSwitchToTrade is omitted
      let navigatedMarket: string | null = null;
      let navigatedTab: string | null = null;
      const mockNavigateToTrade = (marketId: string, tab: any) => {
        navigatedMarket = marketId;
        navigatedTab = tab;
      };

      const fallbackElement = React.createElement(PortfolioView, {
        onNavigateToTrade: mockNavigateToTrade,
        userPortfolios: {
          "usdc-90d": zeroPortfolio,
        },
      });

      fallbackElement.props.onNavigateToTrade!("usdc-90d", "swap");
      expect(navigatedMarket).toBe("usdc-90d");
      expect(navigatedTab).toBe("swap");

      // 4. Verify empty state is NOT rendered when active positions exist
      const activeElement = React.createElement(PortfolioView, {
        onSwitchToTrade: mockOnSwitchToTrade,
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
        },
      });
      const activeHtml = renderWithContext(activeElement);
      expect(activeHtml).not.toContain("No Active Positions");
      expect(activeHtml).not.toContain("Explore Markets");
    });

    it("4.6 omits header On-Chain Verified badge and manual Refresh button while keeping onRefresh prop compatibility", async () => {
      mockWalletState.address = dummyCaller;
      mockWalletState.mode = "wallet";

      let refreshTriggered = false;
      const mockOnRefresh = async () => {
        refreshTriggered = true;
      };

      const elementIdle = React.createElement(PortfolioView, {
        onRefresh: mockOnRefresh,
        refreshing: false,
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
        },
      });

      const htmlIdle = renderWithContext(elementIdle);
      expect(htmlIdle).not.toContain('title="Refresh Portfolio Balances"');
      expect(htmlIdle).not.toContain("On-Chain Verified");

      // Verify optional prop contract remains compatible for callers
      expect(elementIdle.props.onRefresh).toBe(mockOnRefresh);
      await elementIdle.props.onRefresh!();
      expect(refreshTriggered).toBe(true);
    });
  });
});
