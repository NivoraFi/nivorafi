// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ----------------------------------------------------------------------------
// MOCK WALLET CONTEXT FOR COMPONENT SSR HARNESS
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

import { PRESET_MARKETS, MarketDefinition, MarketSummaryMetrics } from "../markets";
import { LiveUserPortfolio } from "../stellar";
import {
  parseMarketPosition,
  aggregatePortfolioTotals,
  calculateWeightedApy,
} from "../../hooks/useMultiMarketPortfolio";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { TopNav, ViewMode } from "@/components/TopNav";
import { MarketProvider } from "@/context/MarketContext";

describe("Empirical Challenger M3 R2: UI & SSR Robustness Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

  const renderWithMarketContext = (ui: React.ReactElement) => {
    return renderToString(React.createElement(MarketProvider, null, ui));
  };

  const stripHtmlComments = (str: string) => str.replace(/<!--.*?-->/g, "");

  const activeUserPortfolio: LiveUserPortfolio = {
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

  const zeroUserPortfolio: LiveUserPortfolio = {
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

  // ==========================================================================
  // REQUIREMENT 1: TopNav View Switcher & page.tsx Mounting Contract
  // ==========================================================================
  describe("1. TopNav View Switcher & page.tsx Integration", () => {
    it("1.1 renders segmented view switcher [ Trade ] [ Portfolio ] when viewMode is 'trade'", () => {
      let selectedView: ViewMode | null = null;
      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "trade",
          onToggleView: (m: ViewMode) => {
            selectedView = m;
          },
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
        })
      );

      // Verify aria-label switcher container
      expect(html).toContain('aria-label="View Switcher"');
      expect(html).toContain("Trade");
      expect(html).toContain("Portfolio");
      expect(html).not.toContain("← Landing");
      expect(html).toContain('href="/"');

      // Verify active styling on Trade segment
      expect(html).toContain("bg-accent text-accent-ink shadow-sm");
      expect(html).toContain("title=\"Trade Desk (T)\"");
    });

    it("1.2 renders segmented view switcher [ Trade ] [ Portfolio ] when viewMode is 'portfolio'", () => {
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
      expect(html).toContain("Trade");
      expect(html).toContain("Portfolio");
      expect(html).toContain("title=\"My Portfolio (P)\"");
    });

    it("1.3 proves switcher is dormant and unrendered if onToggleView is omitted", () => {
      const html = renderToString(
        React.createElement(TopNav, {
          viewMode: "trade",
          // onToggleView omitted intentionally
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
      expect(html).not.toContain("← Landing");
    });

    it("1.4 statically verifies page.tsx mounts TopNav with onToggleView={handleSwitchView}", () => {
      const pagePath = path.resolve(__dirname, "../../app/page.tsx");
      const pageSrc = fs.readFileSync(pagePath, "utf-8");

      expect(pageSrc).toContain("<TopNav");
      expect(pageSrc).toContain("onToggleView={handleSwitchView}");
      expect(pageSrc).toContain("const handleSwitchView = useCallback((mode: ViewMode) => {");
      expect(pageSrc).toContain('setViewMode(mode);');
      expect(pageSrc).toContain('url.searchParams.set("view", "trade");');
      expect(pageSrc).toContain('url.searchParams.set("view", "portfolio");');
    });
  });

  // ==========================================================================
  // REQUIREMENT 2: Mobile Card Layout Parity & Valuation with .tabular-mono
  // ==========================================================================
  describe("2. Mobile Card Layout Parity & Valuation with .tabular-mono", () => {
    it("2.1 renders mobile cards with total position valuation formatted with .tabular-mono", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": activeUserPortfolio,
            "usdc-30d": activeUserPortfolio,
          },
          loading: false,
          refreshing: false,
        })
      );

      // Verify that the mobile cards container is present
      expect(html).toContain('space-y-4 md:hidden');

      const cleanHtml = stripHtmlComments(html);

      // Verify .tabular-mono on total position valuation in mobile card header
      const expectedMobileValuationRegex = /<div class="tabular-mono text-xs font-bold text-ink">\$\d+\.\d{2}<\/div>/;
      expect(cleanHtml).toMatch(expectedMobileValuationRegex);

      // Mobile card valuation for usdc-90d is rendered with .tabular-mono (unhydrated blendRate=1.0)
      expect(cleanHtml).toContain('<div class="tabular-mono text-xs font-bold text-ink">$1262.50</div>');
    });

    it("2.2 maintains full layout parity between desktop table and mobile cards", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": activeUserPortfolio,
          },
          loading: false,
          refreshing: false,
        })
      );

      const cleanHtml = stripHtmlComments(html);

      // Mobile card must contain:
      // 1. Asset code
      expect(cleanHtml).toContain("USDC");
      // 2. Market name
      expect(cleanHtml).toContain("Pendle bUSDC PT 90D");
      // 3. Tenor
      expect(cleanHtml).toContain("90D");
      // 4. Valuation in tabular-mono (unhydrated blendRate=1.0)
      expect(cleanHtml).toContain('<div class="tabular-mono text-xs font-bold text-ink">$1262.50</div>');
      // 5. PT Balance
      expect(cleanHtml).toContain("1000 PT");
      // 6. YT Balance
      expect(cleanHtml).toContain("1000 YT");
      // 7. LP Balance
      expect(cleanHtml).toContain("200 LP");
      // 8. Yield Accrued ($12.50 in tabular-mono)
      expect(cleanHtml).toContain("$12.50");
      // 9. Action buttons
      expect(cleanHtml).toContain("Trade");
      expect(cleanHtml).toContain("Redeem");
      expect(cleanHtml).toContain("Rollover");
    });
  });

  // ==========================================================================
  // REQUIREMENT 3: Claim All Yield Button Typography & Disconnected Wallet Guard
  // ==========================================================================
  describe("3. Claim All Yield Button Typography & Disconnected Wallet Guard", () => {
    it("3.1 renders <span className=\"tabular-mono\">$12.51</span> when wallet is connected", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": activeUserPortfolio,
          },
          loading: false,
          refreshing: false,
        })
      );

      const cleanHtml = stripHtmlComments(html);

      expect(cleanHtml).toContain("Claim All Yield (");
      expect(cleanHtml).toContain('<span class="tabular-mono">');
      expect(cleanHtml).toMatch(/Claim All Yield \(<span class="tabular-mono">\$\d+\.\d{2}<\/span>\)/);
    });

    it("3.2 completely hides Claim All Yield button when wallet is disconnected", () => {
      // Disconnect wallet
      currentMockWallet.address = null;
      currentMockWallet.mode = "disconnected";

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": activeUserPortfolio, // even with positive yield!
          },
          loading: false,
          refreshing: false,
        })
      );

      expect(html).not.toContain("Claim All Yield");
      expect(html).not.toContain("Claim Accrued Variable Yield");
    });

    it("3.3 hides Claim All Yield button when wallet is connected but claimable yield is zero", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": zeroUserPortfolio,
          },
          loading: false,
          refreshing: false,
        })
      );

      expect(html).not.toContain("Claim All Yield");
    });
  });

  // ==========================================================================
  // REQUIREMENT 4: Zero Raw Hex Codes & Zero Raw Emojis
  // ==========================================================================
  describe("4. Zero Raw Hex & Zero Raw Emoji Enforcement", () => {
    it("4.1 confirms zero raw hex codes across all components and page.tsx", () => {
      const hexRegex = /#[0-9a-fA-F]{3,8}\b/g;
      const componentsDir = path.resolve(__dirname, "../../components");
      const pageFile = path.resolve(__dirname, "../../app/page.tsx");

      const collectFiles = (dir: string): string[] => {
        let results: string[] = [];
        const list = fs.readdirSync(dir);
        for (const file of list) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            results = results.concat(collectFiles(filePath));
          } else if (file.endsWith(".tsx") || file.endsWith(".ts")) {
            results.push(filePath);
          }
        }
        return results;
      };

      const filesToCheck = [...collectFiles(componentsDir), pageFile];
      const violations: { file: string; match: string; line: number }[] = [];

      for (const file of filesToCheck) {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          // ignore comments or href anchor links
          const matches = line.match(hexRegex);
          if (matches) {
            for (const m of matches) {
              if (!line.includes(`href="${m}"`) && !line.includes(`'${m}' === href`)) {
                violations.push({ file, match: m, line: idx + 1 });
              }
            }
          }
        });
      }

      expect(violations).toEqual([]);
    });

    it("4.2 confirms zero raw emojis across all components and page.tsx", () => {
      const emojiRegex =
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu;
      const componentsDir = path.resolve(__dirname, "../../components");
      const pageFile = path.resolve(__dirname, "../../app/page.tsx");

      const collectFiles = (dir: string): string[] => {
        let results: string[] = [];
        const list = fs.readdirSync(dir);
        for (const file of list) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            results = results.concat(collectFiles(filePath));
          } else if (file.endsWith(".tsx") || file.endsWith(".ts")) {
            results.push(filePath);
          }
        }
        return results;
      };

      const filesToCheck = [...collectFiles(componentsDir), pageFile];
      const emojiViolations: { file: string; char: string; line: number }[] = [];

      for (const file of filesToCheck) {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          const matches = line.match(emojiRegex);
          if (matches) {
            for (const m of matches) {
              emojiViolations.push({ file, char: m, line: idx + 1 });
            }
          }
        });
      }

      expect(emojiViolations).toEqual([]);
    });
  });

  // ==========================================================================
  // REQUIREMENT 5: Strict Forbidden File Invariants
  // ==========================================================================
  describe("5. Forbidden Indexer File Immutability Invariant", () => {
    it("5.1 verifies frontend/src/lib/indexer.ts SHA256 checksum is unaltered", () => {
      const indexPath = path.resolve(__dirname, "../indexer.ts");
      const content = fs.readFileSync(indexPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      expect(hash).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
    });

    it("5.2 verifies frontend/src/hooks/useEventIndexer.ts SHA256 checksum is unaltered", () => {
      const hookPath = path.resolve(__dirname, "../../hooks/useEventIndexer.ts");
      const content = fs.readFileSync(hookPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      expect(hash).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
    });
  });

  // ==========================================================================
  // REQUIREMENT 6: SSR Extreme Stress & Hydration Edge Cases
  // ==========================================================================
  describe("6. SSR Robustness & Boundary Condition Stress Harness", () => {
    it("6.1 renders matured position mobile card with warning badge and .tabular-mono valuation", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const maturedPortfolio: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "500.00",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 500_0000000n, // 500 matured PT
        ytBalance: 0n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-matured": maturedPortfolio,
          },
          loading: false,
          refreshing: false,
        })
      );

      const cleanHtml = stripHtmlComments(html);

      // Must display Matured badge with warn styling
      expect(cleanHtml).toContain("Matured");
      expect(cleanHtml).toContain("border-warn/30 bg-warn-soft text-warn");

      // Mobile card valuation must be in .tabular-mono
      expect(cleanHtml).toContain('<div class="tabular-mono text-xs font-bold text-ink">$500.00</div>');

      // Rollover banner must be prominent
      expect(cleanHtml).toContain("Action Required: Matured Positions Detected");
      expect(cleanHtml).toContain("Rollover Now");
    });

    it("6.2 multi-market concurrent test: all 3 testnet markets render mobile card with .tabular-mono", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": activeUserPortfolio,
            "usdc-30d": activeUserPortfolio,
            "xlm-90d": activeUserPortfolio,
          },
          loading: false,
          refreshing: false,
        })
      );

      const cleanHtml = stripHtmlComments(html);

      // Verify each of the 3 testnet markets has its mobile card
      expect(cleanHtml).toContain("Pendle bUSDC PT 90D");
      expect(cleanHtml).toContain("Pendle bUSDC PT 30D");
      expect(cleanHtml).toContain("Pendle bXLM PT 90D");

      // Verify that every card has .tabular-mono in its header
      const matches = cleanHtml.match(/<div class="tabular-mono text-xs font-bold text-ink">/g);
      expect(matches).not.toBeNull();
      // At least 3 position cards (plus desktop table also has tabular-mono)
      expect(matches!.length).toBeGreaterThanOrEqual(3);
    });

    it("6.3 handles $1,000,000+ whale valuation without precision loss or layout truncation", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const whalePortfolio: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "50000.00",
        usdcBalance: "1000000.00",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 1_000_000_0000000n, // 1,000,000 PT
        ytBalance: 0n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": whalePortfolio,
          },
          loading: false,
          refreshing: false,
        })
      );

      const cleanHtml = stripHtmlComments(html);

      // Valuation should be $980,000.00 (1M PT * 0.98 * 1.0)
      expect(cleanHtml).toContain('<div class="tabular-mono text-xs font-bold text-ink">$980000.00</div>');
    });

    it("6.4 renders empty state gracefully when user has zero positions across all markets", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": zeroUserPortfolio,
            "usdc-30d": zeroUserPortfolio,
            "xlm-90d": zeroUserPortfolio,
          },
          loading: false,
          refreshing: false,
        })
      );

      const cleanHtml = stripHtmlComments(html);

      expect(cleanHtml).toContain("No Active Positions");
      expect(cleanHtml).toContain("Explore Markets");
      expect(cleanHtml).not.toContain("Claim All Yield");
    });

    it("6.5 disables Claim All Yield button when busyAction is set", () => {
      currentMockWallet.address = dummyCaller;
      currentMockWallet.mode = "wallet";

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: {
            "usdc-90d": activeUserPortfolio,
          },
          busyAction: "Broadcasting Claim Yield...",
          loading: false,
          refreshing: false,
        })
      );

      // Button must have disabled attribute
      expect(html).toContain('disabled=""');
      expect(html).toContain("Claim All Yield");
    });
  });
});
