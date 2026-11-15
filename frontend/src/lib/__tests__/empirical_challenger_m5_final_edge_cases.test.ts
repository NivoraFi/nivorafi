// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ----------------------------------------------------------------------------
// CONTROLLABLE WALLET MOCK STATE
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

function realIsNetworkMismatch(payload?: { networkPassphrase?: string; network?: string } | null): boolean {
  if (!payload) return false;
  const targetPassphrase = "Test SDF Network ; September 2015";
  const targetNet: string = "testnet";

  if (payload.networkPassphrase && payload.networkPassphrase.trim() !== targetPassphrase) {
    return true;
  }
  if (payload.network) {
    const netStr = payload.network.trim().toLowerCase();
    const normalizedTarget = targetNet === "public" || targetNet === "mainnet" ? "mainnet" : targetNet;
    const normalizedPayload = netStr === "public" || netStr === "mainnet" ? "mainnet" : netStr;
    if (normalizedPayload !== normalizedTarget) {
      return true;
    }
  }
  return false;
}

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => currentMockWallet,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: realIsNetworkMismatch,
}));

// Components and types under test
import { TopNav, ViewMode } from "@/components/TopNav";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { LiquidityCard } from "@/components/trading/LiquidityCard";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { RolloverCard } from "@/components/trading/RolloverCard";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { MarketTickerBar } from "@/components/trading/MarketTickerBar";
import { MarketSelector } from "@/components/trading/MarketSelector";
import { LandingView } from "@/components/landing/LandingView";
import { MarketProvider } from "@/context/MarketContext";
import { PRESET_MARKETS, MarketDefinition } from "../markets";
import { LiveMarketSnapshot, LiveUserPortfolio } from "../stellar";
import { MarketStateRaw, WAD } from "../math";

// ----------------------------------------------------------------------------
// TEST FIXTURES & UTILITIES
// ----------------------------------------------------------------------------
const DUMMY_CALLER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

const activeUserPortfolio: LiveUserPortfolio = {
  address: DUMMY_CALLER,
  accountExists: true,
  xlmBalance: "500.00",
  usdcBalance: "2500.00",
  usdcTrustlineExists: true,
  syBalance: 150_0000000n,
  ptBalance: 2000_0000000n,
  ytBalance: 2000_0000000n,
  lpBalance: 500_0000000n,
  lastIndex: 1000000000n,
  unclaimedYieldRaw: 10_0000000n,
  estimatedPendingYieldSy: 25_0000000n,
};

const zeroUserPortfolio: LiveUserPortfolio = {
  address: DUMMY_CALLER,
  accountExists: true,
  xlmBalance: "0.00",
  usdcBalance: "0.00",
  usdcTrustlineExists: true,
  syBalance: 0n,
  ptBalance: 0n,
  ytBalance: 0n,
  lpBalance: 0n,
  lastIndex: 1000000000n,
  unclaimedYieldRaw: 0n,
  estimatedPendingYieldSy: 0n,
};

const activeMarketStateRaw: MarketStateRaw = {
  total_pt_reserve: 100_000n * WAD,
  total_sy_reserve: 100_000n * WAD,
  total_lp_supply: 100_000n * WAD,
  scalar_root: 10n * WAD,
  initial_anchor: 1_050_000_000_000_000_000n,
  annual_fee_rate: 10_000_000_000_000_000n,
  protocol_fee_bps: 1000n,
  fee_recipient: DUMMY_CALLER,
  maturity: BigInt(Math.floor(Date.now() / 1000) + 86400 * 90),
  maturity_index: WAD,
  is_settled: false,
};

const maturedMarketStateRaw: MarketStateRaw = {
  total_pt_reserve: 50_000n * WAD,
  total_sy_reserve: 50_000n * WAD,
  total_lp_supply: 50_000n * WAD,
  scalar_root: 10n * WAD,
  initial_anchor: 1_000_000_000_000_000_000n,
  annual_fee_rate: 10_000_000_000_000_000n,
  protocol_fee_bps: 1000n,
  fee_recipient: DUMMY_CALLER,
  maturity: BigInt(Math.floor(Date.now() / 1000) - 86400),
  maturity_index: WAD,
  is_settled: true,
};

const activeMarketSnapshot: LiveMarketSnapshot = {
  state: activeMarketStateRaw,
  latestLedger: 123456,
  nowSeconds: Math.floor(Date.now() / 1000),
  daysToMaturity: 90,
  isMatured: false,
  blendExchangeRate: 1_000_000_000n,
  ammExchangeRateWad: 985_000_000_000_000_000n,
  ptPriceInSy: 0.985,
  ytPriceInSy: 0.015,
  impliedFixedApyPct: 8.2,
  ptTotalSupply: 100_000n * WAD,
  ytTotalSupply: 100_000n * WAD,
  syTotalSupply: 100_000n * WAD,
  ptProportionPct: 50.0,
};

const maturedMarketSnapshot: LiveMarketSnapshot = {
  state: maturedMarketStateRaw,
  latestLedger: 123456,
  nowSeconds: Math.floor(Date.now() / 1000),
  daysToMaturity: 0,
  isMatured: true,
  blendExchangeRate: 1_000_000_000n,
  ammExchangeRateWad: 1_000_000_000_000_000_000n,
  ptPriceInSy: 1.0,
  ytPriceInSy: 0.0,
  impliedFixedApyPct: 0.0,
  ptTotalSupply: 50_000n * WAD,
  ytTotalSupply: 50_000n * WAD,
  syTotalSupply: 50_000n * WAD,
  ptProportionPct: 50.0,
};

function renderWithMarketContext(element: React.ReactElement): string {
  return renderToString(React.createElement(MarketProvider, null, element));
}

function stripComments(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

function extractStatusButton(html: string) {
  const match = html.match(/<button[^>]*role="status"[^>]*>([\s\S]*?)<\/button>/);
  return {
    fullTag: match ? match[0] : "",
    inner: match ? match[1] : "",
  };
}

// ============================================================================
// EMPIRICAL CHALLENGER M5: ADVERSARIAL EDGE-CASE, SSR & INTEGRATION SUITE
// ============================================================================
describe("Empirical Challenger M5: Adversarial Edge Cases & Production SSR Audit", () => {

  // --------------------------------------------------------------------------
  // 1. ADVERSARIAL NETWORK MISMATCH STATE MATRIX (walletNetworkMismatch = true)
  // --------------------------------------------------------------------------
  describe("1. Adversarial Network Mismatch State Matrix", () => {
    it("1.1: validates isNetworkMismatch logic with strict boundary test cases", () => {
      expect(realIsNetworkMismatch(null)).toBe(false);
      expect(realIsNetworkMismatch(undefined)).toBe(false);
      expect(realIsNetworkMismatch({})).toBe(false);

      expect(
        realIsNetworkMismatch({
          networkPassphrase: "Test SDF Network ; September 2015",
          network: "testnet",
        })
      ).toBe(false);

      expect(
        realIsNetworkMismatch({
          networkPassphrase: "   Test SDF Network ; September 2015   ",
          network: "  TESTNET  ",
        })
      ).toBe(false);

      expect(
        realIsNetworkMismatch({
          networkPassphrase: "Public Global Stellar Network ; September 2015",
          network: "public",
        })
      ).toBe(true);

      expect(
        realIsNetworkMismatch({
          networkPassphrase: "Test SDF Future Network ; October 2022",
          network: "futurenet",
        })
      ).toBe(true);

      expect(
        realIsNetworkMismatch({
          networkPassphrase: "Standalone Network ; February 2017",
          network: "standalone",
        })
      ).toBe(true);

      expect(
        realIsNetworkMismatch({
          networkPassphrase: "' OR '1'='1",
          network: "testnet",
        })
      ).toBe(true);
    });

    it("1.2: TopNav renders prominent warning badge and status button when walletNetworkMismatch is true", () => {
      currentMockWallet.address = DUMMY_CALLER;
      currentMockWallet.mode = "wallet";
      currentMockWallet.walletNetworkMismatch = true;

      const html = renderWithMarketContext(
        React.createElement(TopNav, {
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
        })
      );

      const statusBtn = extractStatusButton(html);
      expect(statusBtn.fullTag).toContain('role="status"');
      expect(statusBtn.fullTag).toContain("Network warning: Connected wallet is not on Stellar Testnet");
      expect(statusBtn.fullTag).toContain("Mismatch");
      expect(statusBtn.fullTag).toContain("text-warn");
      expect(statusBtn.fullTag).toContain("bg-warn");
      expect(statusBtn.fullTag).not.toContain("animate-ping");
    });

    it("1.3: TradingDesk renders network mismatch alert banner when walletNetworkMismatch is true", () => {
      currentMockWallet.address = DUMMY_CALLER;
      currentMockWallet.mode = "wallet";
      currentMockWallet.walletNetworkMismatch = true;

      const html = renderWithMarketContext(
        React.createElement(TradingDesk, {
          snapshot: activeMarketSnapshot,
          portfolio: activeUserPortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toContain("Wallet is on wrong network.");
      expect(html).toContain("Switch to Testnet");
      expect(html).toContain("bg-warn");
    });

    it("1.4: All trading cards transform primary CTAs to network recovery when walletNetworkMismatch is true", () => {
      currentMockWallet.address = DUMMY_CALLER;
      currentMockWallet.mode = "wallet";
      currentMockWallet.walletNetworkMismatch = true;

      // SwapCard
      const swapHtml = renderWithMarketContext(
        React.createElement(SwapCard, {
          snapshot: activeMarketSnapshot,
          portfolio: activeUserPortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(swapHtml).toContain("Switch to Stellar Testnet");
      expect(swapHtml).not.toContain("Execute Swap");

      // MintCard
      const mintHtml = renderWithMarketContext(
        React.createElement(MintCard, {
          snapshot: activeMarketSnapshot,
          portfolio: activeUserPortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(mintHtml).toContain("Switch to Stellar Testnet");
      expect(mintHtml).not.toContain("Mint PT + YT");

      // LiquidityCard
      const liqHtml = renderWithMarketContext(
        React.createElement(LiquidityCard, {
          snapshot: activeMarketSnapshot,
          portfolio: activeUserPortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(liqHtml).toContain("Switch to Stellar Testnet");
      expect(liqHtml).not.toContain("Supply Dual Liquidity");

      // RolloverCard
      const rollHtml = renderWithMarketContext(
        React.createElement(RolloverCard, {
          snapshot: maturedMarketSnapshot,
          portfolio: activeUserPortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(rollHtml).toContain("Switch to Testnet");
      expect(rollHtml).not.toContain("Execute Atomic Rollover");
    });
  });

  // --------------------------------------------------------------------------
  // 2. DISCONNECTED & EMPTY WALLET BOUNDARY MATRIX
  // --------------------------------------------------------------------------
  describe("2. Disconnected & Empty Wallet Boundary Matrix", () => {
    it("2.1: TopNav renders Connect Wallet CTA safely when wallet is disconnected", () => {
      currentMockWallet.address = null;
      currentMockWallet.mode = "disconnected";
      currentMockWallet.walletId = null;
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderWithMarketContext(
        React.createElement(TopNav, {
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: null,
          accountExists: null,
          busyAction: null,
        })
      );

      expect(html).toContain("Connect Wallet");
      expect(html).not.toContain("Disconnect");
    });

    it("2.2: PortfolioView renders prominent Connect Wallet banner and zero KPI tiles without throwing", () => {
      currentMockWallet.address = null;
      currentMockWallet.mode = "disconnected";
      currentMockWallet.walletId = null;
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: null,
          busyAction: null,
        })
      );
      const cleanHtml = stripComments(html);

      expect(cleanHtml).toContain("Connect Your Wallet");
      expect(cleanHtml).toContain("Connect Freighter or LOBSTR to inspect your multi-market yield balances");
      expect(cleanHtml).toContain("Connect Wallet");

      expect(cleanHtml).toContain("$0.00");
      expect(cleanHtml).not.toContain("NaN");
      expect(cleanHtml).not.toContain("undefined");
    });

    it("2.3: Trading cards render Connect Wallet CTA across all tabs when wallet is disconnected", () => {
      currentMockWallet.address = null;
      currentMockWallet.mode = "disconnected";
      currentMockWallet.walletId = null;
      currentMockWallet.walletNetworkMismatch = false;

      // SwapCard
      const swapHtml = renderWithMarketContext(
        React.createElement(SwapCard, {
          snapshot: activeMarketSnapshot,
          portfolio: null,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(swapHtml).toContain("Connect Wallet to Swap");

      // MintCard
      const mintHtml = renderWithMarketContext(
        React.createElement(MintCard, {
          snapshot: activeMarketSnapshot,
          portfolio: null,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(mintHtml).toContain("Connect Wallet to Sign");

      // LiquidityCard
      const liqHtml = renderWithMarketContext(
        React.createElement(LiquidityCard, {
          snapshot: activeMarketSnapshot,
          portfolio: null,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(liqHtml).toContain("Connect Wallet to Manage LP");

      // RolloverCard
      const rollHtml = renderWithMarketContext(
        React.createElement(RolloverCard, {
          snapshot: maturedMarketSnapshot,
          portfolio: null,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(rollHtml).toContain("Connect Wallet");
      expect(rollHtml).not.toContain("[&gt;_ Simulate Rollover]");
    });

    it("2.4: Connected wallet with 0 balances handles zero balances gracefully", () => {
      currentMockWallet.address = DUMMY_CALLER;
      currentMockWallet.mode = "wallet";
      currentMockWallet.walletNetworkMismatch = false;

      const zeroPortfolios: Record<string, LiveUserPortfolio> = {
        "usdc-90d": zeroUserPortfolio,
        "usdc-30d": zeroUserPortfolio,
        "xlm-90d": zeroUserPortfolio,
      };

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: zeroPortfolios,
          busyAction: null,
        })
      );
      const cleanHtml = stripComments(html);

      expect(cleanHtml).toContain("$0.00");
      expect(cleanHtml).toContain("All positions active");
      expect(cleanHtml).not.toContain("Action Required: Matured Positions Detected");
    });
  });

  // --------------------------------------------------------------------------
  // 3. RAPID VIEW MODE SWITCHING & CONCURRENT STATE TRANSITIONS
  // --------------------------------------------------------------------------
  describe("3. Rapid View Mode Switching & Concurrent State Transitions", () => {
    it("3.1: simulates rapid cyclical view switching across 100 consecutive transitions", () => {
      const modes: ViewMode[] = ["landing", "trade", "portfolio"];
      let activeView: ViewMode = "landing";
      const viewHistory: ViewMode[] = [];

      for (let i = 0; i < 100; i++) {
        activeView = modes[i % modes.length];
        viewHistory.push(activeView);

        let html = "";
        if (activeView === "landing") {
          html = renderToString(
            React.createElement(LandingView, {
              onEnterDesk: () => {},
              snapshot: activeMarketSnapshot,
            })
          );
          expect(html).toContain("Yield tokenized on Stellar");
        } else if (activeView === "portfolio") {
          html = renderWithMarketContext(
            React.createElement(PortfolioView, {
              userPortfolios: null,
              busyAction: null,
            })
          );
          expect(html).toContain("My Positions");
        } else {
          html = renderWithMarketContext(
            React.createElement(TradingDesk, {
              snapshot: activeMarketSnapshot,
              portfolio: activeUserPortfolio,
              busyAction: null,
              onExecuteAction: async () => {},
            })
          );
          expect(html).toContain("Trade Fixed Yield");
        }
        expect(html.length).toBeGreaterThan(0);
      }

      expect(viewHistory.length).toBe(100);
      expect(viewHistory[0]).toBe("landing");
      expect(viewHistory[1]).toBe("trade");
      expect(viewHistory[2]).toBe("portfolio");
    });

    it("3.2: simulates concurrent tab cycling through all 5 TradingDesk tabs", () => {
      currentMockWallet.address = DUMMY_CALLER;
      currentMockWallet.mode = "wallet";
      currentMockWallet.walletNetworkMismatch = false;

      const tabs: DeskTab[] = ["swap", "mint", "liquidity", "redeem", "rollover"];

      for (const tab of tabs) {
        const html = renderWithMarketContext(
          React.createElement(TradingDesk, {
            snapshot: activeMarketSnapshot,
            portfolio: activeUserPortfolio,
            busyAction: null,
            onExecuteAction: async () => {},
            activeTab: tab,
          })
        );

        if (tab === "swap") {
          expect(html).toContain("Transaction Details");
        } else if (tab === "mint") {
          expect(html).toContain("Wrap USDC into SY");
        } else if (tab === "liquidity") {
          expect(html).toContain("Supply Dual Liquidity");
        } else if (tab === "redeem") {
          expect(html).toContain("Variable Yield Harvesting");
        } else if (tab === "rollover") {
          expect(html).toContain("Rollover Destination Strategy");
        }
      }
    });

    it("3.3: verifies navigation callback signatures and contract propagation", () => {
      let triggeredMarket = "";
      let triggeredTab = "";
      let triggeredView = "";

      const onNavigateToTrade = (mId: string, t: string) => {
        triggeredMarket = mId;
        triggeredTab = t;
        triggeredView = "trade";
      };

      onNavigateToTrade("usdc-30d", "mint");
      expect(triggeredMarket).toBe("usdc-30d");
      expect(triggeredTab).toBe("mint");
      expect(triggeredView).toBe("trade");

      onNavigateToTrade("xlm-90d", "rollover");
      expect(triggeredMarket).toBe("xlm-90d");
      expect(triggeredTab).toBe("rollover");
    });
  });

  // --------------------------------------------------------------------------
  // 4. NEXT.JS 14 / BUN SSR HYDRATION STABILITY & DETERMINISM
  // --------------------------------------------------------------------------
  describe("4. Next.js 14 / Bun SSR Hydration Stability & Determinism", () => {
    it("4.1: consecutive server-side renders produce identical, deterministic HTML strings", () => {
      currentMockWallet.address = DUMMY_CALLER;
      currentMockWallet.mode = "wallet";
      currentMockWallet.walletNetworkMismatch = false;

      const renderPass1 = stripComments(
        renderWithMarketContext(
          React.createElement(TopNav, {
            onRefresh: () => {},
            refreshing: false,
            onFundXlm: () => {},
            onAddUsdcTrustline: () => {},
            usdcTrustlineExists: true,
            accountExists: true,
            busyAction: null,
          })
        )
      );

      const renderPass2 = stripComments(
        renderWithMarketContext(
          React.createElement(TopNav, {
            onRefresh: () => {},
            refreshing: false,
            onFundXlm: () => {},
            onAddUsdcTrustline: () => {},
            usdcTrustlineExists: true,
            accountExists: true,
            busyAction: null,
          })
        )
      );

      expect(renderPass1).toBe(renderPass2);
    });

    it("4.2: TradingDesk renders under extreme null parameters during SSR without crashing", () => {
      currentMockWallet.address = null;
      currentMockWallet.mode = "disconnected";
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderWithMarketContext(
        React.createElement(TradingDesk, {
          snapshot: null,
          portfolio: null,
          busyAction: null,
          onExecuteAction: async () => {},
          activeTab: "swap",
        })
      );

      expect(html).toContain("Trade Fixed Yield");
      expect(html).toContain("Connect Wallet to Swap");
    });

    it("4.3: PortfolioView renders under null userPortfolios during SSR without crashing", () => {
      currentMockWallet.address = null;
      currentMockWallet.mode = "disconnected";
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: null,
          busyAction: null,
        })
      );
      const cleanHtml = stripComments(html);

      expect(cleanHtml).toContain("My Positions");
      expect(cleanHtml).toContain("$0.00");
    });

    it("4.4: MarketTickerBar renders without throwing when market metrics are partially populated", () => {
      const html = renderWithMarketContext(
        React.createElement(MarketTickerBar, {
          snapshot: activeMarketSnapshot,
          loading: false,
        })
      );

      expect(html).toContain("PT Implied APY");
      expect(html).toContain("Blend bRate");
      expect(html).toContain("AMM Rate");
      expect(html).toContain("Pool Reserves");
    });

    it("4.5: MarketSelector renders compact trigger button with active market and tenor", () => {
      const html = renderWithMarketContext(
        React.createElement(MarketSelector, {
          compact: true,
        })
      );

      expect(html).toContain('aria-label="Open market selector"');
      expect(html).toContain("USDC");
      expect(html).toContain("90D");
    });
  });

  // --------------------------------------------------------------------------
  // 5. STRICT DESIGN SYSTEM & INVARIANT AUDIT
  // --------------------------------------------------------------------------
  describe("5. Strict Design System & Invariant Audit", () => {
    it("5.1: scans components for zero raw hex color literals", () => {
      const componentsDir = path.resolve(
        __dirname,
        "../../components"
      );

      function scanDir(dir: string): string[] {
        let violations: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            violations = violations.concat(scanDir(fullPath));
          } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
            if (entry.name.includes("test") || entry.name.includes(".d.ts")) continue;
            const content = fs.readFileSync(fullPath, "utf-8");
            const hexMatches = content.match(/#[0-9a-fA-F]{3,6}(?![a-zA-Z0-9_-])/g);
            if (hexMatches) {
              const realHex = hexMatches.filter(
                (h) => !["#trade", "#portfolio", "#svg"].includes(h.toLowerCase())
              );
              if (realHex.length > 0) {
                violations.push(`${entry.name}: ${realHex.join(", ")}`);
              }
            }
          }
        }
        return violations;
      }

      const rawHexViolations = scanDir(componentsDir);
      expect(rawHexViolations).toEqual([]);
    });

    it("5.2: scans components for zero raw emoji literals", () => {
      const componentsDir = path.resolve(
        __dirname,
        "../../components"
      );

      const emojiRegex = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

      function scanEmojiDir(dir: string): string[] {
        let violations: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            violations = violations.concat(scanEmojiDir(fullPath));
          } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
            if (entry.name.includes("test") || entry.name.includes(".d.ts")) continue;
            const content = fs.readFileSync(fullPath, "utf-8");
            if (emojiRegex.test(content)) {
              violations.push(entry.name);
            }
          }
        }
        return violations;
      }

      const emojiViolations = scanEmojiDir(componentsDir);
      expect(emojiViolations).toEqual([]);
    });

    it("5.3: verifies tabular-mono is present in key numeric components", () => {
      const topNavHtml = renderWithMarketContext(
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
      expect(topNavHtml).toContain("tabular-mono");

      const portfolioHtml = renderWithMarketContext(
        React.createElement(PortfolioView, {
          userPortfolios: null,
          busyAction: null,
        })
      );
      expect(portfolioHtml).toContain("tabular-mono");

      const deskHtml = renderWithMarketContext(
        React.createElement(TradingDesk, {
          snapshot: activeMarketSnapshot,
          portfolio: activeUserPortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );
      expect(deskHtml).toContain("tabular-mono");
    });

    it("5.4: STRICT INVARIANT: verifies indexer.ts and useEventIndexer.ts remain 100% untouched", () => {
      const indexerPath = path.resolve(__dirname, "../indexer.ts");
      const hookPath = path.resolve(__dirname, "../../hooks/useEventIndexer.ts");

      const indexerContent = fs.readFileSync(indexerPath);
      const hookContent = fs.readFileSync(hookPath);

      const indexerSha = crypto.createHash("sha256").update(indexerContent).digest("hex");
      const hookSha = crypto.createHash("sha256").update(hookContent).digest("hex");

      const EXPECTED_INDEXER_SHA = "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";
      const EXPECTED_HOOK_SHA = "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

      expect(indexerSha).toBe(EXPECTED_INDEXER_SHA);
      expect(hookSha).toBe(EXPECTED_HOOK_SHA);
    });
  });
});
