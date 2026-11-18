// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// Mock WalletProvider for predictable testing
const mockWallet = {
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
  useWallet: () => mockWallet,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => mockWallet.walletNetworkMismatch,
}));



import {
  InteractiveYieldChart,
  ChartDataPoint,
  ChartMode,
  ChartTimeframe,
} from "../InteractiveYieldChart";
import { YieldBreakdownCards } from "../YieldBreakdownCards";
import { TokenProfileHeader } from "../TokenProfileHeader";
import { TokenActivityFeed } from "../TokenActivityFeed";
import { PRESET_MARKETS } from "@/lib/markets";
import { LiveMarketSnapshot } from "@/lib/stellar";
import { MarketAnalyticsData } from "@/components/trading/AnalyticsCard.types";

describe("Empirical Challenger M2.1: Adversarial Stress Suite (Chart, Bento Cards, Design System)", () => {
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

  const baseSnapshot: LiveMarketSnapshot = {
    state: {
      total_pt_reserve: 85_000_0000000n,
      total_sy_reserve: 42_000_0000000n,
      total_lp_supply: 60_000_0000000n,
      scalar_root: 1_0000000n,
      initial_anchor: 1_0000000n,
      annual_fee_rate: 100000n,
      protocol_fee_bps: 30n,
      fee_recipient: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      maturity: BigInt(usdc90D.maturity),
      maturity_index: 1_0000000n,
      is_settled: false,
    },
    latestLedger: 123456,
    nowSeconds: Math.floor(Date.now() / 1000),
    daysToMaturity: 88.5,
    isMatured: false,
    blendExchangeRate: 10000000n,
    ammExchangeRateWad: 1000000000000000000n,
    ptPriceInSy: 0.9812,
    ytPriceInSy: 0.0188,
    impliedFixedApyPct: 8.45,
    ptTotalSupply: 85_000_0000000n,
    ytTotalSupply: 85_000_0000000n,
    syTotalSupply: 42_000_0000000n,
    ptProportionPct: 66.9,
  };

  // Helper to audit SVG coordinates in rendered HTML
  function auditSvgCoordinates(html: string) {
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("-Infinity");

    // Extract path 'd' attributes
    const pathMatches = html.match(/d="([^"]+)"/g) || [];
    for (const p of pathMatches) {
      expect(p).not.toContain("NaN");
      expect(p).not.toContain("Infinity");
    }

    // Extract line coordinate attributes
    const lineCoords = html.match(/(?:x1|x2|y1|y2)="([^"]+)"/g) || [];
    for (const lc of lineCoords) {
      expect(lc).not.toContain("NaN");
      expect(lc).not.toContain("Infinity");
    }

    // Extract circle coordinates
    const circleCoords = html.match(/(?:cx|cy|r)="([^"]+)"/g) || [];
    for (const cc of circleCoords) {
      expect(cc).not.toContain("NaN");
      expect(cc).not.toContain("Infinity");
    }
  }

  // ==========================================================================
  // Suite 1: InteractiveYieldChart Adversarial Stress Matrix
  // ==========================================================================
  describe("Suite 1: InteractiveYieldChart Adversarial Stress Matrix", () => {
    it("1.1 Empty and null data series render gracefully without crashing or NaN", () => {
      // Test explicit empty array
      const htmlEmpty = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          data: [],
        })
      );
      expect(htmlEmpty).toContain("<svg");
      expect(htmlEmpty).toContain("Implied APY");
      auditSvgCoordinates(htmlEmpty);

      // Test null data with null snapshot and null analytics
      const htmlAllNull = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: null,
          snapshot: null,
          analytics: null,
          data: undefined,
          loading: true,
        })
      );
      expect(htmlAllNull).toContain("<svg");
      auditSvgCoordinates(htmlAllNull);
    });

    it("1.2 Single-point data series renders valid horizontal paths without NaN", () => {
      const now = Math.floor(Date.now() / 1000);
      const singlePoint: ChartDataPoint[] = [
        {
          timestamp: now - 3600,
          impliedApy: 12.5,
          underlyingApy: 5.2,
          ptPrice: 0.965,
          ytPrice: 0.035,
        },
      ];

      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          data: singlePoint,
        })
      );

      expect(html).toContain("<svg");
      expect(html).toContain("12.50%");
      expect(html).toContain("5.20%");
      auditSvgCoordinates(html);

      // Verify path starts at 0 and extends to width (600)
      expect(html).toContain("M 0,");
      expect(html).toContain("L 600,");
    });

    it("1.3 Extreme APY spikes (10,000% APY, 0.001% APY) stay within coordinate bounds", () => {
      const now = Math.floor(Date.now() / 1000);
      const extremeSpikeData: ChartDataPoint[] = [
        {
          timestamp: now - 86400 * 3,
          impliedApy: 10000.0,
          underlyingApy: 0.001,
          ptPrice: 0.0001,
          ytPrice: 0.9999,
        },
        {
          timestamp: now - 86400 * 2,
          impliedApy: 0.001,
          underlyingApy: 5000.0,
          ptPrice: 0.9999,
          ytPrice: 0.0001,
        },
        {
          timestamp: now - 86400 * 1,
          impliedApy: 8.5,
          underlyingApy: 5.0,
          ptPrice: 0.98,
          ytPrice: 0.02,
        },
      ];

      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          data: extremeSpikeData,
          initialTimeframe: "ALL",
        })
      );

      expect(html).toContain("<svg");
      expect(html).toContain("8.50%");
      auditSvgCoordinates(html);
    });

    it("1.4 Identical APY series (diff = 0) renders without division by zero", () => {
      const now = Math.floor(Date.now() / 1000);
      const flatSeries: ChartDataPoint[] = Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (10 - i) * 3600,
        impliedApy: 8.0,
        underlyingApy: 8.0,
        ptPrice: 0.98,
        ytPrice: 0.02,
      }));

      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          data: flatSeries,
        })
      );

      expect(html).toContain("8.00%");
      expect(html).toContain("+0.00%");
      expect(html).toContain("Spread");
      auditSvgCoordinates(html);
    });

    it("1.5 Token Price mode par convergence space: renders PT & YT spot prices cleanly", () => {
      const now = Math.floor(Date.now() / 1000);
      const priceSeries: ChartDataPoint[] = [
        {
          timestamp: now - 86400 * 7,
          impliedApy: 10.0,
          underlyingApy: 5.0,
          ptPrice: 0.92,
          ytPrice: 0.08,
        },
        {
          timestamp: now,
          impliedApy: 6.0,
          underlyingApy: 5.0,
          ptPrice: 0.995,
          ytPrice: 0.005,
        },
      ];

      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          data: priceSeries,
          initialMode: "price",
        })
      );

      expect(html).toContain("PT Price");
      expect(html).toContain("YT Price");
      expect(html).toContain("0.9950 SY");
      expect(html).toContain("0.0050 SY");
      expect(html).toContain("0.50");
      expect(html).toContain("Discount");
      auditSvgCoordinates(html);
    });

    it("1.6 Timeframe selector tabs and mode toggle switchers render active states", () => {
      const html1D = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          snapshot: baseSnapshot,
          initialTimeframe: "1D",
          initialMode: "yield",
        })
      );

      expect(html1D).toContain("1D");
      expect(html1D).toContain("Yield APY");
      expect(html1D).toContain("Token Price");

      const htmlAll = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          snapshot: baseSnapshot,
          initialTimeframe: "ALL",
          initialMode: "price",
        })
      );

      expect(htmlAll).toContain("ALL");
      expect(htmlAll).toContain("Token Price");
    });

    it("1.7 Mathematical verification of tooltip clamping formula", () => {
      // Clamping formula:
      // left: hoverClientX > 380 ? Math.max(10, hoverClientX - 170) : Math.min(width - 180, hoverClientX + 15)
      const width = 600;
      const clampLeft = (hoverClientX: number | null) => {
        return hoverClientX !== null && hoverClientX > 380
          ? Math.max(10, hoverClientX - 170)
          : Math.min(width - 180, (hoverClientX ?? 0) + 15);
      };

      // Near left boundary (x = 0)
      expect(clampLeft(0)).toBe(15);
      expect(clampLeft(10)).toBe(25);

      // Mid-stage (x = 200)
      expect(clampLeft(200)).toBe(215);

      // Just before threshold (x = 380)
      expect(clampLeft(380)).toBe(395);

      // Just past threshold (x = 381): flips to left side of cursor
      expect(clampLeft(381)).toBe(211);

      // Near right boundary (x = 600)
      expect(clampLeft(600)).toBe(430);

      // Extreme edge cases
      expect(clampLeft(null)).toBe(15);
      expect(clampLeft(800)).toBe(630);
    });

    it("1.8 Single-point series coordinate behavior analysis", () => {
      // When filteredSeries.length === 1, inspect if (i / (len - 1)) produces NaN
      const len = 1;
      const i = 0;
      const xCalc = (i / (len - 1)) * 600;
      expect(Number.isNaN(xCalc)).toBe(true);

      // However, buildPathAndArea protects SVG path rendering via explicit len === 1 guard:
      const now = Math.floor(Date.now() / 1000);
      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          data: [{ timestamp: now, impliedApy: 8.5, underlyingApy: 5.0, ptPrice: 0.98, ytPrice: 0.02 }],
        })
      );

      // Confirm SVG paths remain 100% NaN-free in DOM output
      expect(html).not.toContain("NaN");
    });

    it("1.9 Initial hydrating loading state suppresses synthetic curves and renders syncing indicator", () => {
      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          data: undefined,
          loading: true,
        })
      );

      expect(html).toContain("Syncing chart events…");
      expect(html).toContain("<svg");
      expect(html).not.toContain("<path");
      auditSvgCoordinates(html);
    });
  });

  // ==========================================================================
  // Suite 2: YieldBreakdownCards Adversarial Stress Matrix
  // ==========================================================================
  describe("Suite 2: YieldBreakdownCards Adversarial Stress Matrix", () => {
    it("2.1 Matured market state: Fixed APY is 0.00%, leverage is '--', countdown is 'Matured'", () => {
      const maturedSnapshot: LiveMarketSnapshot = {
        ...baseSnapshot,
        isMatured: true,
        daysToMaturity: 0,
        impliedFixedApyPct: 0.0,
        ptPriceInSy: 1.0,
        ytPriceInSy: 0.0,
      };

      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdcMatured,
          snapshot: maturedSnapshot,
        })
      );

      // Fixed APY guaranteed at maturity should be 0.00%
      expect(html).toContain("0.00%");

      // Long Yield Leverage should be '--'
      expect(html).toContain("--");
      expect(html).toContain("Market expired");

      // Maturity countdown should display 'Matured'
      expect(html).toContain("Matured");
    });

    it("2.2 Zero reserves resilience: total_pt_reserve = 0n, total_sy_reserve = 0n", () => {
      const zeroReserveSnapshot: LiveMarketSnapshot = {
        ...baseSnapshot,
        state: {
          ...baseSnapshot.state,
          total_pt_reserve: 0n,
          total_sy_reserve: 0n,
          total_lp_supply: 0n,
        },
      };

      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdc90D,
          snapshot: zeroReserveSnapshot,
          underlyingPriceUsd: 1.0,
        })
      );

      // Pool TVL should evaluate to $0 cleanly
      expect(html).toContain("$0");
      expect(html).toContain("0k PT / 0k SY");
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("Infinity");
    });

    it("2.3 Division-by-zero safety in YT leverage calculation", () => {
      // Test when ytPrice is 0.0 on an active market (ptPrice = 1.0)
      const zeroYtSnapshot: LiveMarketSnapshot = {
        ...baseSnapshot,
        isMatured: false,
        ptPriceInSy: 1.0,
        ytPriceInSy: 0.0,
      };

      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdc90D,
          snapshot: zeroYtSnapshot,
        })
      );

      // Guarded by ytPrice > 0, renders honest placeholder instead of Infinity/NaN
      expect(html).toContain("--");
      expect(html).not.toContain("Infinity");
      expect(html).not.toContain("NaN");
    });

    it("2.4 Extreme prices in leverage calculation: ptPrice = 0.0, ytPrice = 1.0", () => {
      const fullYtSnapshot: LiveMarketSnapshot = {
        ...baseSnapshot,
        isMatured: false,
        ptPriceInSy: 0.0,
        ytPriceInSy: 1.0,
      };

      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdc90D,
          snapshot: fullYtSnapshot,
        })
      );

      // 1 / 1.0 = 1x leverage
      expect(html).toContain("1x");
      expect(html).toContain("Cost: 1.0000 SY");
    });

    it("2.5 Loading state with null snapshot and analytics: shows '...' without crash", () => {
      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdc90D,
          snapshot: null,
          analytics: null,
          loading: true,
        })
      );

      expect(html).toContain("...");
      expect(html).toContain("Implied APY");
      expect(html).toContain("Fixed APY");
      expect(html).toContain("Pool TVL &amp; Depth");
    });

    it("2.6 Underlying price variations: 0 USD price results in $0 TVL", () => {
      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdc90D,
          snapshot: baseSnapshot,
          underlyingPriceUsd: 0,
        })
      );

      expect(html).toContain("$0");
    });

    it("2.7 Fallback to analytics.totalTvlUsdc when provided", () => {
      const customAnalytics: MarketAnalyticsData = {
        marketId: usdc90D.id,
        impliedApyPct: 9.25,
        totalTvlUsdc: "150000000000", // 15,000 USDC with 7 decimals
        volume24hUsdc: "25000000000",
        ptPriceInSy: 0.978,
        apyHistory: [],
      };

      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdc90D,
          snapshot: baseSnapshot,
          analytics: customAnalytics,
        })
      );

      // 150000000000 / 1e7 = 15,000
      expect(html).toContain("$15,000");
    });
  });

  // ==========================================================================
  // Suite 3: Automated Design System Conformance Matrix
  // ==========================================================================
  describe("Suite 3: Automated Design System Conformance Matrix", () => {
    const componentPaths = [
      "src/components/token/TokenProfileHeader.tsx",
      "src/components/token/YieldBreakdownCards.tsx",
      "src/components/token/InteractiveYieldChart.tsx",
      "src/components/token/TokenActivityFeed.tsx",
      "src/components/trade/TradePageClient.tsx",
    ];

    it("3.1 Strictly verifies 0 raw hex color codes across all Milestone 2 components", () => {
      const hexPattern = /#([0-9a-fA-F]{3,8})\b/g;

      for (const relPath of componentPaths) {
        const fullPath = path.resolve(process.cwd(), relPath);
        const code = fs.readFileSync(fullPath, "utf8");
        const matches = code.match(hexPattern) || [];

        expect(matches.length).toBe(0);
      }
    });

    it("3.2 Strictly verifies 0 raw Unicode emojis across all Milestone 2 components", () => {
      const emojiPattern = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;

      for (const relPath of componentPaths) {
        const fullPath = path.resolve(process.cwd(), relPath);
        const code = fs.readFileSync(fullPath, "utf8");
        const matches = code.match(new RegExp(emojiPattern, "gu")) || [];

        expect(matches.length).toBe(0);
      }
    });

    it("3.3 Enforces mandatory .tabular-mono class presence in all Milestone 2 components", () => {
      for (const relPath of componentPaths) {
        const fullPath = path.resolve(process.cwd(), relPath);
        const code = fs.readFileSync(fullPath, "utf8");

        expect(code).toContain("tabular-mono");
      }
    });
  });

  // ==========================================================================
  // Suite 4: Protected Modules Checksum Verification
  // ==========================================================================
  describe("Suite 4: Protected Modules Checksum Verification", () => {
    const EXPECTED_INDEXER_SHA256 =
      "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";
    const EXPECTED_HOOK_SHA256 =
      "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

    it("4.1 Cryptographic SHA256 integrity of src/lib/indexer.ts exactly matches baseline", () => {
      const fullPath = path.resolve(process.cwd(), "src/lib/indexer.ts");
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      expect(hash).toBe(EXPECTED_INDEXER_SHA256);
    });

    it("4.2 Cryptographic SHA256 integrity of src/hooks/useEventIndexer.ts exactly matches baseline", () => {
      const fullPath = path.resolve(process.cwd(), "src/hooks/useEventIndexer.ts");
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      expect(hash).toBe(EXPECTED_HOOK_SHA256);
    });
  });
});
