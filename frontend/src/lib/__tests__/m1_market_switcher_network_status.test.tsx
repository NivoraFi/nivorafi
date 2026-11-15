// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

import { TopNav } from "@/components/TopNav";
import { MarketSelector } from "@/components/trading/MarketSelector";
import { MarketTickerBar } from "@/components/trading/MarketTickerBar";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { LiquidityCard } from "@/components/trading/LiquidityCard";
import { MarketProvider } from "@/context/MarketContext";
import { WalletProvider } from "@/context/WalletProvider";
import { PRESET_MARKETS, findMarketById } from "../markets";
import { buildActionArgs, ProtocolAction } from "../stellar";

describe("Milestone 1: Multi-Market Switcher & Subtle Network Status UI Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
  const m0 = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const m1 = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const m2 = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

  // --------------------------------------------------------------------------
  // 1. DESIGN SYSTEM AUDIT (ZERO RAW HEX & ZERO EMOJIS)
  // --------------------------------------------------------------------------
  describe("1. Design System Verification Scan", () => {
    const componentFiles = [
      "TopNav.tsx",
      "trading/MarketSelector.tsx",
      "trading/MarketTickerBar.tsx",
      "trading/SwapCard.tsx",
      "trading/MintCard.tsx",
      "trading/LiquidityCard.tsx",
      "trading/TradingDesk.tsx",
    ];

    it("strictly verifies zero raw hex color codes across all Milestone 1 components", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const componentsDir = path.resolve(__dirname, "../../components");
      const violations: { file: string; match: string }[] = [];

      for (const file of componentFiles) {
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

    it("strictly verifies zero raw Unicode emojis in Milestone 1 components", () => {
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const componentsDir = path.resolve(__dirname, "../../components");
      const emojiViolations: { file: string; line: number; text: string }[] = [];

      for (const file of componentFiles) {
        const fullPath = path.join(componentsDir, file);
        if (!fs.existsSync(fullPath)) continue;
        const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
        lines.forEach((line, idx) => {
          if (emojiRegex.test(line)) {
            emojiViolations.push({ file, line: idx + 1, text: line.trim() });
          }
        });
      }

      expect(emojiViolations).toEqual([]);
      expect(emojiViolations.length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 2. TOPNAV SUBTLE NETWORK STATUS BADGE
  // --------------------------------------------------------------------------
  describe("2. TopNav Subtle Network Status Badge", () => {
    it("renders subtle pulsing Testnet network status pill with accessibility attributes", () => {
      const html = renderToString(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(TopNav, {
            viewMode: "landing",
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

      // Verify network indicator presence and styling
      expect(html).toContain("Testnet");
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-label="Network status: Stellar Testnet"');
      expect(html).toContain("bg-positive");
      expect(html).toContain("animate-ping");
      expect(html).toContain("border-hairline");
    });

    it("renders network status badge under trade viewMode", () => {
      const html = renderToString(
        React.createElement(
          WalletProvider,
          null,
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
        )
      );

      expect(html).toContain("Testnet");
      expect(html).toContain('role="status"');
      expect(html).toContain("bg-positive");
    });
  });

  // --------------------------------------------------------------------------
  // 3. MULTI-MARKET SELECTOR & TICKER MOUNTING
  // --------------------------------------------------------------------------
  describe("3. Multi-Market Selector & Ticker Bar Mounting", () => {
    it("renders MarketSelector compact trigger with tabular-mono APY and tenor", () => {
      const html = renderToString(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
            null,
            React.createElement(MarketSelector, { compact: true })
          )
        )
      );

      expect(html).toContain("USDC");
      expect(html).toContain("90D");
      expect(html).toContain("tabular-mono");
      expect(html).toContain('aria-haspopup="dialog"');
    });

    it("renders MarketTickerBar with live metrics formatted in tabular-mono", () => {
      const html = renderToString(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
            null,
            React.createElement(MarketTickerBar, { snapshot: null, loading: false })
          )
        )
      );

      expect(html).toContain("PT Implied APY");
      expect(html).toContain("Blend bRate");
      expect(html).toContain("AMM Rate");
      expect(html).toContain("Pool Reserves");
      expect(html).toContain("tabular-mono");
    });
  });

  // --------------------------------------------------------------------------
  // 4. CONTRACT ID ROUTING MATRIX IN buildActionArgs
  // --------------------------------------------------------------------------
  describe("4. Contract ID Routing Matrix Across Active Markets", () => {
    it("strictly routes swap calls to the active market's pool contract ID", () => {
      const swapM0 = buildActionArgs(
        { type: "swap", caller: dummyCaller, method: "swap_exact_sy_for_pt", amountIn: 100n, minOut: 90n },
        m0
      );
      const swapM1 = buildActionArgs(
        { type: "swap", caller: dummyCaller, method: "swap_exact_sy_for_pt", amountIn: 100n, minOut: 90n },
        m1
      );
      const swapM2 = buildActionArgs(
        { type: "swap", caller: dummyCaller, method: "swap_exact_sy_for_pt", amountIn: 100n, minOut: 90n },
        m2
      );

      expect(swapM0.contractId).toBe(m0.contracts.poolId);
      expect(swapM1.contractId).toBe(m1.contracts.poolId);
      expect(swapM2.contractId).toBe(m2.contracts.poolId);

      // Verify M1 and M2 do not equal M0 pool
      expect(swapM1.contractId).not.toBe(m0.contracts.poolId);
      expect(swapM2.contractId).not.toBe(m0.contracts.poolId);
    });

    it("strictly routes deposit_sy and redeem_sy calls to the active market's SY contract ID", () => {
      const depM0 = buildActionArgs({ type: "deposit_sy", caller: dummyCaller, amount: 100n }, m0);
      const depM2 = buildActionArgs({ type: "deposit_sy", caller: dummyCaller, amount: 100n }, m2);

      expect(depM0.contractId).toBe(m0.contracts.syId);
      expect(depM2.contractId).toBe(m2.contracts.syId);

      // XLM uses a distinct SY contract from USDC
      expect(depM2.contractId).not.toBe(m0.contracts.syId);
      expect(depM2.contractId).toBe("CAOUCLCZGM3WHGQ5S653WQHAMAMPP3UW4IC5VPUIW2XFVDAR3NFJ6B3W");
    });

    it("strictly routes mint_py and liquidity actions to the active market's pool ID", () => {
      const mintM1 = buildActionArgs({ type: "mint_py", caller: dummyCaller, amount: 100n }, m1);
      const addLiqM2 = buildActionArgs(
        { type: "add_liquidity", caller: dummyCaller, ptAmount: 10n, syAmount: 10n, minLpOut: 1n },
        m2
      );

      expect(mintM1.contractId).toBe(m1.contracts.poolId);
      expect(addLiqM2.contractId).toBe(m2.contracts.poolId);
    });

    it("proves that omitting activeMarket causes critical contract misrouting to Market 0", () => {
      const unroutedSwap = buildActionArgs({
        type: "swap",
        caller: dummyCaller,
        method: "swap_exact_sy_for_pt",
        amountIn: 100n,
        minOut: 90n,
      });

      // Default targets m0 contracts
      expect(unroutedSwap.contractId).toBe(m0.contracts.poolId);
      // Fails to match m1 and m2
      expect(unroutedSwap.contractId).not.toBe(m1.contracts.poolId);
      expect(unroutedSwap.contractId).not.toBe(m2.contracts.poolId);
    });
  });

  // --------------------------------------------------------------------------
  // 5. TRADING CARD CODE AUDIT (CONSUMING useMarket)
  // --------------------------------------------------------------------------
  describe("5. Trading Cards Code Consumption Audit", () => {
    const tradingDir = path.resolve(__dirname, "../../components/trading");

    it("verifies SwapCard consumes useMarket and passes activeMarket to buildActionArgs", () => {
      const code = fs.readFileSync(path.join(tradingDir, "SwapCard.tsx"), "utf-8");
      expect(code).toContain("useMarket");
      expect(code).toContain("activeMarket");
      // Must pass activeMarket to buildActionArgs
      expect(code).toMatch(/buildActionArgs\(\s*\{[\s\S]*?\},\s*activeMarket\s*\)/);
    });

    it("verifies MintCard consumes useMarket and passes activeMarket to buildActionArgs", () => {
      const code = fs.readFileSync(path.join(tradingDir, "MintCard.tsx"), "utf-8");
      expect(code).toContain("useMarket");
      expect(code).toContain("activeMarket");
      expect(code).toMatch(/buildActionArgs\(\s*\{[\s\S]*?\},\s*activeMarket\s*\)/);
    });

    it("verifies LiquidityCard consumes useMarket and passes activeMarket to buildActionArgs", () => {
      const code = fs.readFileSync(path.join(tradingDir, "LiquidityCard.tsx"), "utf-8");
      expect(code).toContain("useMarket");
      expect(code).toContain("activeMarket");
      expect(code).toMatch(/buildActionArgs\(\s*\{[\s\S]*?\},\s*activeMarket\s*\)/);
    });
  });
});
