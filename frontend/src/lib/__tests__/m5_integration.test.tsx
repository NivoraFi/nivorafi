// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import { scValToNative } from "@stellar/stellar-sdk";

import {
  buildActionArgs,
  getFriendlyActionName,
  LiveMarketSnapshot,
} from "../stellar";
import {
  SCALAR_9,
  syToAsset,
  assetToSy,
  quoteSwapLocal,
  estimateZapInLp,
} from "../math";
import {
  PRESET_MARKETS,
  getMarketDefinition,
  filterAndSortMarkets,
} from "../markets";
import { STELLAR_PENDLE_CONFIG } from "../contracts";
import { WalletProvider } from "../../context/WalletProvider";
import { MarketProvider } from "../../context/MarketContext";
import { TradingDesk } from "../../components/trading/TradingDesk";
import { ZapCard } from "../../components/trading/ZapCard";
import { SwapCard } from "../../components/trading/SwapCard";
import { MarketExplorerTable } from "../../components/markets/MarketExplorerTable";
import { YieldBreakdownCards } from "../../components/token/YieldBreakdownCards";
import { TokenProfileHeader } from "../../components/token/TokenProfileHeader";

const DUMMY_CALLER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const DUMMY_RECEIVER = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";

function makeSnapshot(marketId = "usdc-90d", pyIndex = SCALAR_9): LiveMarketSnapshot {
  const market = getMarketDefinition(marketId) ?? PRESET_MARKETS[0];
  const nowSeconds = market.maturity - 60 * 86400;
  return {
    state: {
      total_pt_reserve: 80_000_0000000n,
      total_sy_reserve: 40_000_0000000n,
      total_lp_supply: 56_568_5424949n,
      scalar_root: BigInt(market.scalarRoot),
      initial_anchor: BigInt(market.initialAnchor),
      annual_fee_rate: 3_000000000000000n,
      protocol_fee_bps: 2000n,
      fee_recipient: market.contracts.poolId,
      maturity: BigInt(market.maturity),
      maturity_index: SCALAR_9,
      is_settled: false,
    },
    latestLedger: 100000,
    nowSeconds,
    daysToMaturity: 60,
    isMatured: false,
    blendExchangeRate: pyIndex,
    pyIndex,
    ammExchangeRateWad: 1_020000000000000000n,
    ptPriceInSy: 0.98,
    ytPriceInSy: 0.02,
    impliedFixedApyPct: 12.4,
    ptTotalSupply: 50_000_0000000n,
    ytTotalSupply: 50_000_0000000n,
    syTotalSupply: 100_000_0000000n,
    ptProportionPct: 50,
    syProportionPct: 50,
    tvlInSy: 100_000_0000000n,
  };
}

describe("M5 Client Integration: Deadlines, Zap-In, PyIndex Math, Slender Market & Honest UI", () => {
  describe("1. Deadline Encoding & Nullish Preservation", () => {
    it("preserves explicit deadline = 0n (no || truthy fallback) on mint_py, swap, rollover_*, zap_in_*", () => {
      const m = PRESET_MARKETS[0];
      const mint = buildActionArgs({
        type: "mint_py",
        caller: DUMMY_CALLER,
        amount: 10_0000000n,
        deadline: 0n,
      }, m);
      expect(mint.args).toHaveLength(4);
      expect(scValToNative(mint.args[3])).toBe(0n);

      const swap = buildActionArgs({
        type: "swap",
        caller: DUMMY_CALLER,
        method: "swap_exact_sy_for_pt",
        amountIn: 10_0000000n,
        minOut: 9_5000000n,
        deadline: 0n,
      }, m);
      expect(swap.args).toHaveLength(5);
      expect(scValToNative(swap.args[4])).toBe(0n);

      const rollPt = buildActionArgs({
        type: "rollover_to_pt",
        caller: DUMMY_CALLER,
        receiver: DUMMY_RECEIVER,
        sourcePool: PRESET_MARKETS[3].contracts.poolId,
        targetPool: m.contracts.poolId,
        ptAmount: 10_0000000n,
        minTargetPt: 9_8000000n,
      }, m, 0n);
      expect(rollPt.args).toHaveLength(7);
      expect(scValToNative(rollPt.args[6])).toBe(0n);

      const zap = buildActionArgs({
        type: "zap_in_pt",
        caller: DUMMY_CALLER,
        pool: m.contracts.poolId,
        underlyingAmount: 25_0000000n,
        minOut: 0n,
        deadline: 0n,
      }, m);
      expect(zap.args).toHaveLength(6);
      expect(scValToNative(zap.args[4])).toBe(0n);
      expect(scValToNative(zap.args[5])).toBe(0n);
    });
  });

  describe("2. Zap-In Action Builders & Swap Label Mapping", () => {
    it("encodes zap_in_pt, zap_in_yt, zap_in_lp against MarketFactory with 6 ScVals", () => {
      const m = getMarketDefinition("usdc-slender-90d")!;
      for (const type of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        const built = buildActionArgs({
          type,
          caller: DUMMY_CALLER,
          receiver: DUMMY_RECEIVER,
          poolId: m.contracts.poolId,
          underlyingAmount: 100_0000000n,
          minOut: 95_0000000n,
          deadline: 1800000000n,
        });
        expect(built.contractId).toBe(STELLAR_PENDLE_CONFIG.market_factory.contractId);
        expect(built.method).toBe(type);
        expect(built.args).toHaveLength(6);
        expect(scValToNative(built.args[0])).toBe(DUMMY_CALLER);
        expect(scValToNative(built.args[1])).toBe(DUMMY_RECEIVER);
        expect(scValToNative(built.args[2])).toBe(m.contracts.poolId);
        expect(scValToNative(built.args[3])).toBe(100_0000000n);
        expect(scValToNative(built.args[4])).toBe(95_0000000n);
        expect(scValToNative(built.args[5])).toBe(1800000000n);
      }
    });

    it("throws on zero/negative underlyingAmount, negative minOut, or invalid pool/caller addresses", () => {
      const m = PRESET_MARKETS[0];
      expect(() =>
        buildActionArgs({
          type: "zap_in_pt",
          caller: DUMMY_CALLER,
          pool: m.contracts.poolId,
          underlyingAmount: 0n,
          minOut: 0n,
        })
      ).toThrow();
      expect(() =>
        buildActionArgs({
          type: "zap_in_yt",
          caller: DUMMY_CALLER,
          pool: m.contracts.poolId,
          underlyingAmount: -1n,
          minOut: 0n,
        })
      ).toThrow();
      expect(() =>
        buildActionArgs({
          type: "zap_in_lp",
          caller: DUMMY_CALLER,
          pool: m.contracts.poolId,
          underlyingAmount: 10_0000000n,
          minOut: -5n,
        })
      ).toThrow();
      expect(() =>
        buildActionArgs({
          type: "zap_in_pt",
          caller: DUMMY_CALLER,
          pool: "INVALID_POOL",
          underlyingAmount: 10_0000000n,
          minOut: 0n,
        })
      ).toThrow();
    });

    it("maps all 4 swap_exact_* labels distinctly while getFriendlyActionName returns Swap", () => {
      const methods = [
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_pt",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
      ] as const;

      const labels = new Set<string>();
      for (const method of methods) {
        const built = buildActionArgs({
          type: "swap",
          caller: DUMMY_CALLER,
          method,
          amountIn: 10_0000000n,
          minOut: 9_0000000n,
        }, PRESET_MARKETS[0]);
        expect(built.label).not.toBe("Swap");
        labels.add(built.label);
        expect(getFriendlyActionName(method)).toBe("Swap");
      }
      expect(labels.size).toBe(4);
      expect(getFriendlyActionName("zap_in_pt")).toBe("Zap In PT");
      expect(getFriendlyActionName("zap_in_yt")).toBe("Zap In YT");
      expect(getFriendlyActionName("zap_in_lp")).toBe("Zap In LP");
    });
  });

  describe("3. PyIndex Scaling & M4 Caveat #2 Zap-In LP Guard", () => {
    it("syToAsset and assetToSy apply SCALAR_9 conversion accurately", () => {
      const pyIndex = 1_200000000n; // 1.2x
      expect(syToAsset(pyIndex, 100_0000000n)).toBe(120_0000000n);
      expect(assetToSy(pyIndex, 120_0000000n)).toBe(100_0000000n);
    });

    it("quoteSwapLocal accounts for yield-accrued pyIndex > SCALAR_9 across all 4 directions", () => {
      const snap1 = makeSnapshot("usdc-90d", SCALAR_9);
      const snap12 = makeSnapshot("usdc-90d", 1_200000000n);
      const amount = 500_0000000n;
      const now = BigInt(snap1.nowSeconds);

      const qSyToPt1 = quoteSwapLocal(snap1.state, "sy_for_pt", amount, now, 50, SCALAR_9);
      const qSyToPt12 = quoteSwapLocal(snap12.state, "sy_for_pt", amount, now, 50, 1_200000000n);
      // 1 SY = 1.2 underlying -> buys strictly more PT than when pyIndex = 1.0
      expect(qSyToPt12.estimatedOut).toBeGreaterThan(qSyToPt1.estimatedOut);

      const qPtToSy1 = quoteSwapLocal(snap1.state, "pt_for_sy", amount, now, 50, SCALAR_9);
      const qPtToSy12 = quoteSwapLocal(snap12.state, "pt_for_sy", amount, now, 50, 1_200000000n);
      // Selling PT yields fewer SY when 1 SY = 1.2 underlying
      expect(qPtToSy12.estimatedOut).toBeLessThan(qPtToSy1.estimatedOut);

      const qSyToYt12 = quoteSwapLocal(snap12.state, "sy_for_yt", 10_0000000n, now, 50, 1_200000000n);
      expect(qSyToYt12.estimatedOut).toBeGreaterThan(0n);

      const qYtToSy12 = quoteSwapLocal(snap12.state, "yt_for_sy", 50_0000000n, now, 50, 1_200000000n);
      expect(qYtToSy12.estimatedOut).toBeGreaterThan(0n);
    });

    it("estimateZapInLp flags oversized seeded-pool LP zap while permitting bounded LP zap", () => {
      const snap = makeSnapshot("usdc-90d", SCALAR_9);
      const smallCheck = estimateZapInLp(
        snap.state,
        1_000_0000000n,
        BigInt(snap.nowSeconds),
        50,
        SCALAR_9
      );
      expect(smallCheck.ok).toBe(true);
      expect(smallCheck.estLpOut).toBeGreaterThan(0n);

      const hugeCheck = estimateZapInLp(
        snap.state,
        2_000_000_0000000n,
        BigInt(snap.nowSeconds),
        50,
        SCALAR_9
      );
      expect(hugeCheck.ok).toBe(false);
      expect(hugeCheck.reason).toBeDefined();
    });

    it("enforces newPt < syToAsset(pyIndex, newSy) (#18 NegativeYieldNotSupported) when initial_anchor > WAD", () => {
      const snap = makeSnapshot("usdc-90d", SCALAR_9);
      const posAnchorState = {
        ...snap.state,
        total_pt_reserve: 120_000_000_000n,
        total_sy_reserve: 100_000_000_000n,
        total_lp_supply: 109_544_511_501n,
        scalar_root: 20n * 1_000_000_000_000_000_000n,
        initial_anchor: 1_050_000_000_000_000_000n,
      };
      const now = BigInt(snap.nowSeconds);

      expect(() =>
        quoteSwapLocal(posAnchorState, "sy_for_pt", 10_000_000_000n, now, 50, SCALAR_9)
      ).toThrow(/Negative implied yield/i);

      const zap35 = estimateZapInLp(posAnchorState, 35_000_000_000n, now, 50, SCALAR_9);
      expect(zap35.ok).toBe(false);
      expect(zap35.isOversizedError).toBe(true);

      const zap80 = estimateZapInLp(posAnchorState, 80_000_000_000n, now, 50, SCALAR_9);
      expect(zap80.ok).toBe(false);
      expect(zap80.isOversizedError).toBe(true);
    });
  });

  describe("4. Slender sUSDC Preset & UI Component Behavior", () => {
    it("registers usdc-slender-90d in PRESET_MARKETS and filters by sy-sUSDC", () => {
      const slender = getMarketDefinition("usdc-slender-90d");
      expect(slender).toBeDefined();
      expect(slender?.factoryId).toBe(5);
      expect(slender?.maturity).toBe(1801909057);
      expect(slender?.sySymbol).toBe("sy-sUSDC");
      expect(slender?.ptSymbol).toBe("PT-sUSDC-90D");
      expect(slender?.ytSymbol).toBe("YT-sUSDC-90D");

      const filtered = filterAndSortMarkets(PRESET_MARKETS, "All", "sy-sUSDC", "tvl", "desc");
      expect(filtered.map((m) => m.id)).toEqual(["usdc-slender-90d"]);
    });

    it("renders Zap tab in TradingDesk, ZapCard options, Slender labels, and honest '--' placeholders", () => {
      const slender = getMarketDefinition("usdc-slender-90d")!;
      const snap = makeSnapshot("usdc-slender-90d");

      const deskHtml = renderToString(
        <WalletProvider>
          <MarketProvider>
            <TradingDesk
              activeTab="zap"
              onTabChange={() => {}}
              snapshot={snap}
              portfolio={null}
              busyAction={null}
              onExecuteAction={async () => {}}
            />
          </MarketProvider>
        </WalletProvider>
      );
      expect(deskHtml).toContain("Zap");
      expect(deskHtml).toContain("Zap to PT");
      expect(deskHtml).toContain("Zap to YT");
      expect(deskHtml).toContain("Zap to LP");

      const zapHtml = renderToString(
        <WalletProvider>
          <MarketProvider>
            <ZapCard
              snapshot={snap}
              portfolio={null}
              busyAction={null}
              onExecuteAction={async () => {}}
            />
          </MarketProvider>
        </WalletProvider>
      );
      expect(zapHtml).toContain("Pay Underlying");
      expect(zapHtml).toContain("tabular-mono");

      const swapNullHtml = renderToString(
        <WalletProvider>
          <MarketProvider initialMarketId={slender.id}>
            <SwapCard
              snapshot={null}
              portfolio={null}
              busyAction={null}
              onExecuteAction={async () => {}}
            />
          </MarketProvider>
        </WalletProvider>
      ).replace(/<!--.*?-->/g, "");
      expect(swapNullHtml).not.toContain("+8.45%");
      expect(swapNullHtml).not.toContain("50x");
      expect(swapNullHtml).toContain("--");

      const headerHtml = renderToString(<TokenProfileHeader market={slender} />);
      expect(headerHtml).toContain("Slender Protocol");

      const yieldHtml = renderToString(
        <YieldBreakdownCards market={slender} snapshot={null} />
      );
      expect(yieldHtml).toContain("Slender");
      expect(yieldHtml).not.toContain("+8.45%");
      expect(yieldHtml).toContain("--");

      const explorerHtml = renderToString(
        <WalletProvider>
          <MarketProvider>
            <MarketExplorerTable />
          </MarketProvider>
        </WalletProvider>
      );
      expect(explorerHtml).toContain("Slender");
      expect(explorerHtml).toContain("usdc-slender-90d");
      expect(explorerHtml).toContain("--");
    });

    it("ZapCard.tsx strictly complies with design-system rules (no hex colors, rgba, or emojis)", () => {
      const zapSrc = fs.readFileSync(
        path.join(process.cwd(), "src/components/trading/ZapCard.tsx"),
        "utf8"
      );
      expect(zapSrc).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(zapSrc).not.toMatch(/rgba\s*\(/i);
      expect(zapSrc).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      expect(zapSrc).toContain("tabular-mono");
    });
  });
});
