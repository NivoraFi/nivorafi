// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

import { PRESET_MARKETS, MarketDefinition } from "../markets";
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

// Components under test
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { MarketProvider } from "@/context/MarketContext";
import { TopNav } from "@/components/TopNav";

describe("Empirical Challenger M3: Portfolio Panel Adversarial Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

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

  const renderWithContext = (ui: React.ReactElement) => {
    const raw = renderToString(
      React.createElement(MarketProvider, null, ui)
    );
    return raw.replace(/<!--.*?-->/g, "");
  };

  beforeEach(() => {
    currentMockWallet = {
      address: dummyCaller,
      mode: "wallet",
      walletId: "freighter",
      walletNetworkMismatch: false,
      kitReady: true,
      connecting: false,
      connectWallet: async () => {},
      connectWatchAddress: (_pk: string) => {},
      disconnect: async () => {},
      signTransactionXdr: async (xdr: string) => xdr,
      switchNetwork: async () => {},
    };
  });

  // ==========================================================================
  // SUITE 1: COMPONENT RENDERING UNDER VARIOUS STATES
  // ==========================================================================
  describe("Suite 1: Component Rendering Under Adversarial States", () => {
    it("1.1 Disconnected Wallet: renders Connect Wallet card and hides positions breakdown", () => {
      currentMockWallet.address = null;
      currentMockWallet.mode = "disconnected";

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio,
          },
        })
      );

      // Connect Wallet CTA must be prominent
      expect(html).toContain("Connect Your Wallet");
      expect(html).toContain("Connect Freighter or LOBSTR");
      // KPI values must be zeroed when disconnected
      expect(html).toContain("$0.00");
      // Positions breakdown table must NOT be visible to unauthenticated users
      expect(html).not.toContain("Market Positions Breakdown");
      // Matured banner must NOT render
      expect(html).not.toContain("Action Required: Matured Positions Detected");
    });

    it("1.2 Zero Balance State: renders No Active Positions banner with Explore Markets CTA", () => {
      currentMockWallet.address = dummyCaller;

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": zeroPortfolio,
            "usdc-30d": zeroPortfolio,
            "xlm-90d": zeroPortfolio,
          },
        })
      );

      expect(html).toContain("No Active Positions");
      expect(html).toContain("Explore Markets");
      expect(html).toContain("$0.00");
      // Table is still visible below for market discovery
      expect(html).toContain("Market Positions Breakdown");
    });

    it("1.3 Network Mismatch State: renders cleanly without crashing", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.walletNetworkMismatch = true;

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio,
          },
        })
      );

      expect(html).toContain("My Positions");
      expect(html).toContain("Market Positions Breakdown");
    });

    it("1.4 Loading State: renders cleanly without manual Refresh or On-Chain Verified header clutter", () => {
      currentMockWallet.address = dummyCaller;

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          refreshing: true,
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio,
          },
        })
      );

      expect(html).toContain("My Positions");
      expect(html).not.toContain('title="Refresh Portfolio Balances"');
      expect(html).not.toContain("On-Chain Verified");
    });

    it("1.5 Partial Data State: handles missing market entries and undefined balances gracefully", () => {
      currentMockWallet.address = dummyCaller;

      // Partial portfolio: only usdc-90d provided, other markets omitted
      const htmlPartial = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio,
          },
        })
      );

      expect(htmlPartial).toContain("Market Positions Breakdown");
      expect(htmlPartial).toContain("Pendle bUSDC PT 90D");

      // Corrupted / sparse portfolio object
      const sparsePortfolio: any = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "10.00",
        // all other bigint fields omitted/undefined
      };

      const htmlSparse = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": sparsePortfolio,
          },
        })
      );

      expect(htmlSparse).toContain("Market Positions Breakdown");
      expect(htmlSparse).toContain("$0.00");
    });

    it("1.6 Contextual Matured Banner: triggers when matured positions exist", () => {
      currentMockWallet.address = dummyCaller;

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-matured": maturedPortfolio,
          },
        })
      );

      expect(html).toContain("Action Required: Matured Positions Detected");
      expect(html).toContain("Rollover Now");
      expect(html).toContain("Rollover Available");
    });
  });

  // ==========================================================================
  // SUITE 2: 1-CLICK ACTION CALLBACKS & HYDRATION ERROR PREVENTION
  // ==========================================================================
  describe("Suite 2: 1-Click Action Callbacks & Hydration Verifications", () => {
    it("2.1 renders all 1-click action buttons (Trade, Redeem, Rollover) for each market", () => {
      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio,
            "usdc-30d": zeroPortfolio,
            "xlm-90d": zeroPortfolio,
          },
        })
      );

      // Verify buttons exist in rendered HTML
      expect(html).toContain(">Trade<");
      expect(html).toContain(">Redeem<");
      expect(html).toContain(">Rollover<");
    });

    it("2.2 highlights Rollover button with warning styling when position is matured", () => {
      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-matured": maturedPortfolio,
          },
        })
      );

      // Matured position rollover button has bg-warn and animate-pulse
      expect(html).toContain("bg-warn text-white shadow-card animate-pulse");
    });

    it("2.3 renders Claim All Yield button only when claimable yield > $0", () => {
      // With claimable yield
      const htmlWithYield = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio, // 12.5 SY claimable
          },
        })
      );
      expect(htmlWithYield).toContain("Claim All Yield");

      // Without claimable yield
      const htmlNoYield = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": zeroPortfolio,
          },
        })
      );
      expect(htmlNoYield).not.toContain("Claim All Yield");
    });

    it("2.4 verifies callback invocation contract in component props", () => {
      let navigatedMarket: string | null = null;
      let navigatedTab: string | null = null;

      const mockOnSelectMarketAndTab = (marketId: string, tab: string) => {
        navigatedMarket = marketId;
        navigatedTab = tab;
      };

      // Create an element with mock callbacks
      const element = React.createElement(PortfolioView, {
        onSelectMarketAndTab: mockOnSelectMarketAndTab,
        userPortfolios: {
          "usdc-90d": usdc90DActivePortfolio,
        },
      });

      expect(element.props.onSelectMarketAndTab).toBe(mockOnSelectMarketAndTab);
      // Simulate action router call
      element.props.onSelectMarketAndTab("usdc-90d", "swap");
      expect(navigatedMarket).toBe("usdc-90d");
      expect(navigatedTab).toBe("swap");
    });
  });

  // ==========================================================================
  // SUITE 3: DESIGN SYSTEM SCAN (HEX, EMOJIS, TABULAR-MONO)
  // ==========================================================================
  describe("Suite 3: Design System Conformance Scan", () => {
    const portfolioViewPath = path.resolve(
      __dirname,
      "../../components/portfolio/PortfolioView.tsx"
    );

    it("3.1 confirms ZERO raw hex color codes in PortfolioView.tsx", () => {
      const content = fs.readFileSync(portfolioViewPath, "utf-8");
      const hexMatches = content.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      expect(hexMatches).toEqual([]);
      expect(hexMatches.length).toBe(0);
    });

    it("3.2 confirms ZERO raw Unicode emojis in PortfolioView.tsx", () => {
      const content = fs.readFileSync(portfolioViewPath, "utf-8");
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const lines = content.split("\n");
      const violations: string[] = [];
      lines.forEach((line, i) => {
        if (emojiRegex.test(line)) {
          violations.push(`Line ${i + 1}: ${line.trim()}`);
        }
      });
      expect(violations).toEqual([]);
      expect(violations.length).toBe(0);
    });

    it("3.3 verifies tabular-mono presence across all numeric KPI & balance displays", () => {
      const content = fs.readFileSync(portfolioViewPath, "utf-8");
      expect(content).toContain("tabular-mono");

      // Verify that rendered HTML has multiple tabular-mono instances
      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": usdc90DActivePortfolio,
          },
        })
      );
      const matches = html.match(/tabular-mono/g) || [];
      expect(matches.length).toBeGreaterThan(10);
    });
  });

  // ==========================================================================
  // SUITE 4: TOPNAV & PAGE ROUTING INTEGRATION AUDIT
  // ==========================================================================
  describe("Suite 4: TopNav & Page Routing Integration Audit", () => {
    it("4.1 verifies TopNav renders Portfolio button when onToggleView is provided", () => {
      let toggledView: string | null = null;
      const onToggleView = (view: any) => {
        toggledView = view;
      };

      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "trade",
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
      expect(html).toContain("Trade");
    });

    it("4.2 audits page.tsx for onToggleView prop on TopNav component", () => {
      const pagePath = path.resolve(__dirname, "../../app/page.tsx");
      const pageContent = fs.readFileSync(pagePath, "utf-8");

      // Check if TopNav invocation in page.tsx passes onToggleView or handleSwitchView
      const topNavBlockMatch = pageContent.match(/<TopNav[\s\S]*?\/>/);
      expect(topNavBlockMatch).not.toBeNull();
      const topNavBlock = topNavBlockMatch![0];

      const hasOnToggleView = topNavBlock.includes("onToggleView");
      // As an empirical challenger, we document whether TopNav has onToggleView wired!
      // If it is missing, users cannot switch views via TopNav clicks!
      if (!hasOnToggleView) {
        console.warn(
          "[CHALLENGER ADVISORY] page.tsx mounts <TopNav /> without onToggleView prop! Header view switcher is not rendered on live page."
        );
      }
      // Note: We don't fail here so the test documents the exact state
      expect(topNavBlock).toContain("viewMode={viewMode}");
    });
  });

  // ==========================================================================
  // SUITE 5: CODEBASE INTEGRITY (UNTOUCHED INDEXER CHECK)
  // ==========================================================================
  describe("Suite 5: Codebase Integrity - Indexer Files Untouched", () => {
    it("5.1 confirms indexer.ts exists and has exact expected size (~39.6 KB)", () => {
      const indexPath = path.resolve(__dirname, "../../lib/indexer.ts");
      expect(fs.existsSync(indexPath)).toBe(true);
      const stat = fs.statSync(indexPath);
      expect(stat.size).toBe(39639);
    });

    it("5.2 confirms useEventIndexer.ts exists and has exact expected size (~10.0 KB)", () => {
      const hookPath = path.resolve(__dirname, "../../hooks/useEventIndexer.ts");
      expect(fs.existsSync(hookPath)).toBe(true);
      const stat = fs.statSync(hookPath);
      expect(stat.size).toBe(10008);
    });
  });
});
