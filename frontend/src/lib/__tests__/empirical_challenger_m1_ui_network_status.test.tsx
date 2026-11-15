// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";

// Controllable Wallet Mock State
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

function realIsNetworkMismatch(payload?: { networkPassphrase?: string; network?: string } | null): boolean {
  if (!payload) return false;
  const targetPassphrase = STELLAR_PENDLE_CONFIG.networkPassphrase.trim();
  const targetNet = STELLAR_PENDLE_CONFIG.network.trim().toLowerCase();

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
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: realIsNetworkMismatch,
}));

// Components under test
import { TopNav } from "@/components/TopNav";
import { MarketTickerBar } from "@/components/trading/MarketTickerBar";
import { LiveMarketSnapshot } from "@/lib/stellar";

function extractStatusButton(html: string) {
  const match = html.match(/<button[^>]*role="status"[^>]*>([\s\S]*?)<\/button>/);
  return {
    fullTag: match ? match[0] : "",
    inner: match ? match[1] : "",
  };
}

describe("Milestone 1 Adversarial Challenge: TopNav SSR & Network State Robustness", () => {
  const defaultTopNavProps = {
    viewMode: "trade" as const,
    onRefresh: () => {},
    refreshing: false,
    onFundXlm: () => {},
    onAddUsdcTrustline: () => {},
    usdcTrustlineExists: true,
    accountExists: true,
    busyAction: null,
  };

  // ==========================================================================
  // 1. SSR & Network State Robustness (Matched vs Mismatched Network)
  // ==========================================================================
  describe("1. TopNav SSR & Network State Verification", () => {
    it("renders TopNav under matched network (walletNetworkMismatch = false)", () => {
      mockWalletState.walletNetworkMismatch = false;
      mockWalletState.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      mockWalletState.mode = "wallet";

      const html = renderToString(React.createElement(TopNav, defaultTopNavProps));
      const statusBtn = extractStatusButton(html);

      // Accessibility role & aria-label
      expect(statusBtn.fullTag).toContain('role="status"');
      expect(statusBtn.fullTag).toContain('aria-label="Network status: Stellar Testnet"');
      expect(statusBtn.fullTag).toContain('title="Connected to Stellar Testnet"');

      // Status pill classes
      expect(statusBtn.fullTag).toContain("border-positive/20");
      expect(statusBtn.fullTag).toContain("bg-positive-soft");
      expect(statusBtn.fullTag).toContain("text-positive");
      expect(statusBtn.fullTag).toContain("cursor-default");

      // Pulsing indicator for active matched network
      expect(statusBtn.inner).toContain("Testnet");
      expect(statusBtn.inner).not.toContain("Mismatch");
      expect(statusBtn.inner).toContain("animate-ping");
      expect(statusBtn.inner).toContain("bg-positive");
      expect(statusBtn.inner).not.toContain("bg-warn");

      // Intrusive bottom banner must NOT be rendered when matched
      expect(html).not.toContain("Wallet network mismatch. Connected wallet is not on Stellar Testnet.");
      expect(html).not.toContain("Switch to Testnet");
    });

    it("renders TopNav under mismatched network (walletNetworkMismatch = true)", () => {
      mockWalletState.walletNetworkMismatch = true;
      mockWalletState.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      mockWalletState.mode = "wallet";

      const html = renderToString(React.createElement(TopNav, defaultTopNavProps));
      const statusBtn = extractStatusButton(html);

      // Accessibility role & warning aria-label
      expect(statusBtn.fullTag).toContain('role="status"');
      expect(statusBtn.fullTag).toContain('aria-label="Network warning: Connected wallet is not on Stellar Testnet"');
      expect(statusBtn.fullTag).toContain('title="Wallet network mismatch! Click to switch to Stellar Testnet"');

      // Status pill classes
      expect(statusBtn.fullTag).toContain("border-warn/30");
      expect(statusBtn.fullTag).toContain("bg-warn-soft");
      expect(statusBtn.fullTag).toContain("text-warn");
      expect(statusBtn.fullTag).toContain("cursor-pointer");

      // Status pill inner: Mismatch label and static warn dot (no ping)
      expect(statusBtn.inner).toContain("Mismatch");
      expect(statusBtn.inner).not.toContain("Testnet");
      expect(statusBtn.inner).toContain("bg-warn");
      expect(statusBtn.inner).not.toContain("animate-ping");

      // Intrusive bottom mismatch banner MUST be rendered
      expect(html).toContain("Wallet network mismatch. Connected wallet is not on Stellar Testnet.");
      expect(html).toContain("Switch to Testnet");
    });

    it("verifies TopNav rendering when wallet is disconnected", () => {
      mockWalletState.address = null;
      mockWalletState.mode = "disconnected";
      mockWalletState.walletNetworkMismatch = false;

      const html = renderToString(React.createElement(TopNav, defaultTopNavProps));

      // Connect Wallet button displayed
      expect(html).toContain("Connect Wallet");
      expect(html).toContain("btn-accent");

      // Disconnect button and address text should not be rendered
      expect(html).not.toContain("Disconnect Wallet");
      expect(html).not.toContain("GAWW...ME27");

      // Network badge should still be rendered (in default testnet state)
      const statusBtn = extractStatusButton(html);
      expect(statusBtn.fullTag).toContain('role="status"');
      expect(statusBtn.inner).toContain("Testnet");
    });

    it("verifies TopNav viewMode toggling between landing and trade", () => {
      mockWalletState.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      mockWalletState.walletNetworkMismatch = false;

      const landingHtml = renderToString(
        React.createElement(TopNav, {
          ...defaultTopNavProps,
          viewMode: "landing",
          onToggleView: () => {},
        })
      );
      expect(landingHtml).toContain("Trade Desk");

      const tradeHtml = renderToString(
        React.createElement(TopNav, {
          ...defaultTopNavProps,
          viewMode: "trade",
          onToggleView: () => {},
        })
      );
      expect(tradeHtml).not.toContain("← Landing");
      expect(tradeHtml).toContain('href="/"');
    });
  });

  // ==========================================================================
  // 2. MarketTickerBar SSR & Metric Robustness
  // ==========================================================================
  describe("2. MarketTickerBar SSR & Metric Robustness", () => {
    it("renders fallback placeholders cleanly when snapshot is null and loading is false", () => {
      const html = renderToString(
        React.createElement(MarketTickerBar, { snapshot: null, loading: false })
      );

      expect(html).toContain("PT Implied APY");
      expect(html).toContain("Blend bRate");
      expect(html).toContain("AMM Rate");
      expect(html).toContain("Pool Reserves");
      expect(html).toContain("--");
    });

    it("renders loading indicator '...' when snapshot is null and loading is true", () => {
      const html = renderToString(
        React.createElement(MarketTickerBar, { snapshot: null, loading: true })
      );

      expect(html).toContain("...");
    });

    it("renders formatted metrics with tabular-mono when live snapshot is provided", () => {
      const mockSnapshot: LiveMarketSnapshot = {
        marketId: "usdc-90d",
        impliedFixedApyPct: 14.82,
        blendExchangeRate: "1050000000", // 1.050000
        ammExchangeRateWad: "980000000000000000", // 0.9800
        daysToMaturity: 89.5,
        state: {
          maturity: 1750000000n,
          total_pt_reserve: 125000000000n, // 12,500.00
          total_sy_reserve: 130000000000n, // 13,000.00
          total_lp_shares: 250000000000n,
          scalar_root: 1000000000000000000n,
          initial_anchor: 1000000000n,
          fee_rate: 10000000000000000n,
        },
      };

      const html = renderToString(
        React.createElement(MarketTickerBar, { snapshot: mockSnapshot, loading: false })
      );

      expect(html).toContain("14.82%");
      expect(html).toContain("1.050000");
      expect(html).toContain("0.9800");
      expect(html).toContain("PT/SY");
      expect(html).toContain("12500");
      expect(html).toContain("13000");
      expect(html).toContain("tabular-mono");
    });
  });

  // ==========================================================================
  // 3. Design System & Static Code Invariants
  // ==========================================================================
  describe("3. Design System & Code Compliance Audit", () => {
    const componentDir = path.resolve(__dirname, "../../components");
    const m1Files = [
      "TopNav.tsx",
      "trading/MarketTickerBar.tsx",
      "trading/MarketSelector.tsx",
      "trading/SwapCard.tsx",
      "trading/MintCard.tsx",
      "trading/LiquidityCard.tsx",
    ];

    it("verifies zero raw hex color codes across all Milestone 1 components", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const violations: string[] = [];

      for (const relPath of m1Files) {
        const fullPath = path.join(componentDir, relPath);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        const matches = content.match(rawHexRegex);
        if (matches) {
          violations.push(`${relPath}: ${matches.join(", ")}`);
        }
      }

      expect(violations).toEqual([]);
    });

    it("verifies zero raw Unicode emojis in Milestone 1 components", () => {
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const violations: string[] = [];

      for (const relPath of m1Files) {
        const fullPath = path.join(componentDir, relPath);
        if (!fs.existsSync(fullPath)) continue;
        const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
        lines.forEach((line, idx) => {
          if (emojiRegex.test(line)) {
            violations.push(`${relPath}:${idx + 1}: ${line.trim()}`);
          }
        });
      }

      expect(violations).toEqual([]);
    });

    it("verifies indexer.ts and useEventIndexer.ts do not contain Milestone 1 intrusions", () => {
      const indexerPath = path.resolve(__dirname, "../indexer.ts");
      const hookPath = path.resolve(__dirname, "../../hooks/useEventIndexer.ts");

      expect(fs.existsSync(indexerPath)).toBe(true);
      expect(fs.existsSync(hookPath)).toBe(true);

      const indexerCode = fs.readFileSync(indexerPath, "utf-8");
      const hookCode = fs.readFileSync(hookPath, "utf-8");

      // Verify they don't import or touch TopNav / MarketSelector / UI switcher code
      expect(indexerCode).not.toContain("MarketSelector");
      expect(indexerCode).not.toContain("MarketTickerBar");
      expect(indexerCode).not.toContain("TopNav");

      expect(hookCode).not.toContain("MarketSelector");
      expect(hookCode).not.toContain("MarketTickerBar");
      expect(hookCode).not.toContain("TopNav");
    });
  });
});
