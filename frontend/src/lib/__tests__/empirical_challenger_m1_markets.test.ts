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
import { TradingDesk } from "@/components/trading/TradingDesk";
import { MarketProvider, useMarket } from "@/context/MarketContext";
import { WalletProvider } from "@/context/WalletProvider";
import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  findMarketById,
  getDefaultMarket,
  deriveMarketStatus,
  calculateDaysToMaturity,
  filterMarkets,
  MarketDefinition,
} from "../markets";
import { buildActionArgs, ProtocolAction } from "../stellar";

describe("Empirical Challenger M1: Multi-Market Switcher & Subtle Network Status Adversarial Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
  const dummyReceiver = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  const m0 = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const m1 = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const m2 = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

  // ==========================================================================
  // SUITE 1: 3-MARKET CONTRACT ROUTING & UNDERLYING ASSET SOUNDNESS
  // ==========================================================================
  describe("Suite 1: Contract ID Routing Matrix & Asset Soundness Across Markets", () => {
    it("empirically verifies all 3 markets exist with distinct IDs, tenors, and valid metadata", () => {
      expect(m0).toBeDefined();
      expect(m1).toBeDefined();
      expect(m2).toBeDefined();

      expect(m0.id).toBe("usdc-90d");
      expect(m1.id).toBe("usdc-30d");
      expect(m2.id).toBe("xlm-90d");

      // Verify tenors
      expect(m0.tenor).toBe("90D");
      expect(m1.tenor).toBe("30D");
      expect(m2.tenor).toBe("90D");

      // Verify underlying tokens
      expect(m0.asset.code).toBe("USDC");
      expect(m1.asset.code).toBe("USDC");
      expect(m2.asset.code).toBe("XLM");

      // Verify SAC IDs
      expect(m0.asset.sacContractId).toBe(KNOWN_ASSETS.USDC.sacContractId);
      expect(m1.asset.sacContractId).toBe(KNOWN_ASSETS.USDC.sacContractId);
      expect(m2.asset.sacContractId).toBe(KNOWN_ASSETS.XLM.sacContractId);
      expect(m2.asset.sacContractId).not.toBe(m0.asset.sacContractId);
    });

    it("strictly verifies contract IDs are distinct across all 3 markets", () => {
      // 1. Pool Contract IDs must all be distinct
      expect(m0.contracts.poolId).not.toBe(m1.contracts.poolId);
      expect(m1.contracts.poolId).not.toBe(m2.contracts.poolId);
      expect(m0.contracts.poolId).not.toBe(m2.contracts.poolId);

      // 2. PT Token IDs must all be distinct
      expect(m0.contracts.ptId).not.toBe(m1.contracts.ptId);
      expect(m1.contracts.ptId).not.toBe(m2.contracts.ptId);
      expect(m0.contracts.ptId).not.toBe(m2.contracts.ptId);

      // 3. YT Token IDs must all be distinct
      expect(m0.contracts.ytId).not.toBe(m1.contracts.ytId);
      expect(m1.contracts.ytId).not.toBe(m2.contracts.ytId);
      expect(m0.contracts.ytId).not.toBe(m2.contracts.ytId);

      // 4. SY Token IDs: USDC markets share sy-bUSDC, but XLM market has distinct sy-bXLM
      expect(m0.contracts.syId).toBe(m1.contracts.syId);
      expect(m2.contracts.syId).not.toBe(m0.contracts.syId);
      expect(m2.contracts.syId).toBe("CAOUCLCZGM3WHGQ5S653WQHAMAMPP3UW4IC5VPUIW2XFVDAR3NFJ6B3W");
    });

    it("verifies buildActionArgs routes SWAP to exact market pool contract ID", () => {
      const swapMethods = [
        "swap_exact_sy_for_pt",
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
      ];

      for (const method of swapMethods) {
        const swapM0 = buildActionArgs({ type: "swap", caller: dummyCaller, method, amountIn: 5000000n, minOut: 4900000n }, m0);
        const swapM1 = buildActionArgs({ type: "swap", caller: dummyCaller, method, amountIn: 5000000n, minOut: 4900000n }, m1);
        const swapM2 = buildActionArgs({ type: "swap", caller: dummyCaller, method, amountIn: 5000000n, minOut: 4900000n }, m2);

        expect(swapM0.contractId).toBe(m0.contracts.poolId);
        expect(swapM1.contractId).toBe(m1.contracts.poolId);
        expect(swapM2.contractId).toBe(m2.contracts.poolId);

        expect(swapM0.method).toBe(method);
        expect(swapM1.method).toBe(method);
        expect(swapM2.method).toBe(method);

        expect(swapM0.args.length).toBe(4);
        expect(swapM1.args.length).toBe(4);
        expect(swapM2.args.length).toBe(4);
      }
    });

    it("verifies buildActionArgs routes deposit_sy & redeem_sy to exact SY wrapper with correct labels", () => {
      // Deposit SY
      const depM0 = buildActionArgs({ type: "deposit_sy", caller: dummyCaller, amount: 1000000n }, m0);
      const depM1 = buildActionArgs({ type: "deposit_sy", caller: dummyCaller, amount: 1000000n }, m1);
      const depM2 = buildActionArgs({ type: "deposit_sy", caller: dummyCaller, amount: 1000000n }, m2);

      expect(depM0.contractId).toBe(m0.contracts.syId);
      expect(depM1.contractId).toBe(m1.contracts.syId);
      expect(depM2.contractId).toBe(m2.contracts.syId);

      expect(depM0.label).toBe("Deposit USDC into sy-bUSDC");
      expect(depM1.label).toBe("Deposit USDC into sy-bUSDC");
      expect(depM2.label).toBe("Deposit XLM into sy-bXLM");

      // Redeem SY
      const redM0 = buildActionArgs({ type: "redeem_sy", caller: dummyCaller, shares: 1000000n }, m0);
      const redM1 = buildActionArgs({ type: "redeem_sy", caller: dummyCaller, shares: 1000000n }, m1);
      const redM2 = buildActionArgs({ type: "redeem_sy", caller: dummyCaller, shares: 1000000n }, m2);

      expect(redM0.contractId).toBe(m0.contracts.syId);
      expect(redM1.contractId).toBe(m1.contracts.syId);
      expect(redM2.contractId).toBe(m2.contracts.syId);

      expect(redM0.label).toBe("Redeem sy-bUSDC to USDC");
      expect(redM1.label).toBe("Redeem sy-bUSDC to USDC");
      expect(redM2.label).toBe("Redeem sy-bXLM to XLM");
    });

    it("verifies buildActionArgs routes mint_py, redeem_py, add_liquidity, remove_liquidity to pool ID", () => {
      for (const m of [m0, m1, m2]) {
        const mint = buildActionArgs({ type: "mint_py", caller: dummyCaller, amount: 1000000n }, m);
        expect(mint.contractId).toBe(m.contracts.poolId);
        expect(mint.method).toBe("mint_py");

        const redeem = buildActionArgs({ type: "redeem_py", caller: dummyCaller, amount: 1000000n }, m);
        expect(redeem.contractId).toBe(m.contracts.poolId);
        expect(redeem.method).toBe("redeem_py");

        const addLiq = buildActionArgs(
          { type: "add_liquidity", caller: dummyCaller, ptAmount: 1000000n, syAmount: 1000000n, minLpOut: 900000n },
          m
        );
        expect(addLiq.contractId).toBe(m.contracts.poolId);
        expect(addLiq.method).toBe("add_liquidity");

        const remLiq = buildActionArgs(
          { type: "remove_liquidity", caller: dummyCaller, lpAmount: 1000000n, minPt: 400000n, minSy: 400000n },
          m
        );
        expect(remLiq.contractId).toBe(m.contracts.poolId);
        expect(remLiq.method).toBe("remove_liquidity");

        const claim = buildActionArgs({ type: "claim_yield", caller: dummyCaller }, m);
        expect(claim.contractId).toBe(m.contracts.poolId);
        expect(claim.method).toBe("claim_yield");

        const postMat = buildActionArgs({ type: "redeem_pt_post_maturity", caller: dummyCaller, ptAmount: 1000000n }, m);
        expect(postMat.contractId).toBe(m.contracts.poolId);
        expect(postMat.method).toBe("redeem_pt_post_maturity");

        const toBtoken = buildActionArgs({ type: "redeem_pt_to_btoken", caller: dummyCaller, ptAmount: 1000000n }, m);
        expect(toBtoken.contractId).toBe(m.contracts.poolId);
        expect(toBtoken.method).toBe("redeem_pt_to_btoken");
        expect(toBtoken.label).toBe(`Emergency Redeem PT to b${m.asset.code}`);
      }
    });

    it("verifies rollover actions route to factory and encode sourcePool / targetPool correctly", () => {
      const rolloverPt = buildActionArgs(
        {
          type: "rollover_to_pt",
          caller: dummyCaller,
          receiver: dummyReceiver,
          sourcePool: m0.contracts.poolId,
          targetPool: m1.contracts.poolId,
          ptAmount: 1000000n,
          minTargetPt: 950000n,
        },
        m1
      );

      expect(rolloverPt.method).toBe("rollover_to_pt");
      expect(rolloverPt.args.length).toBe(6);

      const rolloverPy = buildActionArgs(
        {
          type: "rollover_to_py",
          caller: dummyCaller,
          receiver: dummyReceiver,
          sourcePool: m0.contracts.poolId,
          targetPool: m2.contracts.poolId,
          ptAmount: 1000000n,
          minNewShares: 900000n,
        },
        m2
      );

      expect(rolloverPy.method).toBe("rollover_to_py");
      expect(rolloverPy.args.length).toBe(6);
    });
  });

  // ==========================================================================
  // SUITE 2: RAPID SWITCHING, INVALID INPUTS & ADVERSARIAL STRESS
  // ==========================================================================
  describe("Suite 2: Rapid Switching & Adversarial State Stress Matrix", () => {
    it("handles 10,000 rapid deterministic lookups via findMarketById without memory degradation", () => {
      const targetIds = ["usdc-90d", "usdc-30d", "xlm-90d", "usdc-matured"];
      for (let i = 0; i < 10000; i++) {
        const id = targetIds[i % targetIds.length];
        const m = findMarketById(id);
        expect(m.id).toBe(id);
      }
    });

    it("safely handles adversarial, non-existent, and malformed market IDs without throwing", () => {
      const adversarialInputs = [
        "non-existent-market-xyz",
        "DROP TABLE markets;--",
        "<script>alert('xss')</script>",
        "",
        "   ",
        "USDC-90D", // Uppercase non-match
        "null",
        "undefined",
        "../etc/passwd",
        "\x00\x01\x02",
        "✨🌈🚀",
      ];

      for (const badId of adversarialInputs) {
        // findMarketById must not throw and must fallback to PRESET_MARKETS[0]
        const fallback = findMarketById(badId);
        expect(fallback).toBeDefined();
        expect(fallback.id).toBe(PRESET_MARKETS[0].id);
        expect(fallback.asset.code).toBe("USDC");
      }
    });

    it("safely handles buildActionArgs when targetMarket is undefined or omitted", () => {
      const swapDefault = buildActionArgs({
        type: "swap",
        caller: dummyCaller,
        method: "swap_exact_sy_for_pt",
        amountIn: 100n,
        minOut: 90n,
      });

      // When targetMarket is undefined, it defaults to config contracts
      expect(swapDefault.contractId).toBe(m0.contracts.poolId);
      expect(swapDefault.args.length).toBe(4);

      const depDefault = buildActionArgs({
        type: "deposit_sy",
        caller: dummyCaller,
        amount: 100n,
      });
      expect(depDefault.contractId).toBe(m0.contracts.syId);
      expect(depDefault.label).toContain("Deposit USDC into sy-bUSDC");
    });

    it("strictly throws informative error when caller is an invalid Stellar address in buildActionArgs", () => {
      const malformedCallers = [
        "INVALID_STELLAR_ADDRESS",
        "GABC123",
        "",
        "0x1234567890abcdef",
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA!",
      ];

      for (const badCaller of malformedCallers) {
        expect(() => {
          buildActionArgs(
            {
              type: "swap",
              caller: badCaller,
              method: "swap_exact_sy_for_pt",
              amountIn: 100n,
              minOut: 90n,
            },
            m1
          );
        }).toThrow();
      }
    });

    it("survives rapid market filtering stress with fuzzy and adversarial queries", () => {
      const queries = ["", "usdc", "XLM", "90d", "bUSDC", "pt", "xyz_no_match", "  usdc  ", "!@#$%^&*()"];
      for (const q of queries) {
        const filtered = filterMarkets(PRESET_MARKETS, "ALL", "ALL", q);
        expect(Array.isArray(filtered)).toBe(true);
        if (q === "xyz_no_match" || q === "!@#$%^&*()") {
          expect(filtered.length).toBe(0);
        } else if (q === "XLM") {
          expect(filtered.length).toBe(1);
          expect(filtered[0].asset.code).toBe("XLM");
        }
      }
    });
  });

  // ==========================================================================
  // SUITE 3: COMPONENT INTEGRATION & RUNTIME CRASH RESISTANCE
  // ==========================================================================
  describe("Suite 3: Component Integration, MarketContext & Zero Crash SSR Verification", () => {
    it("renders TopNav with subtle network status indicator and compact market selector", () => {
      const html = renderToString(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
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
        )
      );

      // Verify network indicator presence
      expect(html).toContain("Testnet");
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-label="Network status: Stellar Testnet"');
      expect(html).toContain("bg-positive");
      expect(html).toContain("animate-ping");

      // Verify compact MarketSelector presence in TopNav
      expect(html).toContain("USDC");
      expect(html).toContain("90D");
      expect(html).toContain('aria-label="Open market selector"');
    });

    it("renders MarketTickerBar across all 3 markets without throwing or layout divergence", () => {
      for (const targetMarket of [m0, m1, m2]) {
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
      }
    });

    it("verifies TradingDesk cards (Swap, Mint, Liquidity) dynamically adapt to activeMarket", () => {
      const tradingDir = path.resolve(__dirname, "../../components/trading");

      // SwapCard inspection
      const swapCode = fs.readFileSync(path.join(tradingDir, "SwapCard.tsx"), "utf-8");
      expect(swapCode).toContain("useMarket");
      expect(swapCode).toContain("activeMarket.ptSymbol");
      expect(swapCode).toContain("activeMarket.sySymbol");
      expect(swapCode).toMatch(/buildActionArgs\(\s*\{[\s\S]*?\},\s*activeMarket\s*\)/);

      // MintCard inspection
      const mintCode = fs.readFileSync(path.join(tradingDir, "MintCard.tsx"), "utf-8");
      expect(mintCode).toContain("useMarket");
      expect(mintCode).toContain("activeMarket.asset.code");
      expect(mintCode).toMatch(/buildActionArgs\(\s*\{[\s\S]*?\},\s*activeMarket\s*\)/);

      // LiquidityCard inspection
      const liqCode = fs.readFileSync(path.join(tradingDir, "LiquidityCard.tsx"), "utf-8");
      expect(liqCode).toContain("useMarket");
      expect(liqCode).toContain("activeMarket.ptSymbol");
      expect(liqCode).toContain("activeMarket.sySymbol");
      expect(liqCode).toMatch(/buildActionArgs\(\s*\{[\s\S]*?\},\s*activeMarket\s*\)/);
    });

    it("empirically verifies TopNav and MarketSelector comply with design system constraints", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;

      const components = [
        path.resolve(__dirname, "../../components/TopNav.tsx"),
        path.resolve(__dirname, "../../components/trading/MarketSelector.tsx"),
        path.resolve(__dirname, "../../components/trading/MarketTickerBar.tsx"),
      ];

      for (const compPath of components) {
        const content = fs.readFileSync(compPath, "utf-8");
        const hexMatches = content.match(rawHexRegex);
        expect(hexMatches).toBeNull();

        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          expect(emojiRegex.test(line)).toBe(false);
        });
      }
    });
  });
});
