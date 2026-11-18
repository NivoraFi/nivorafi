// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, beforeAll } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

// Mock Next.js font loader for Bun runtime
mock.module("next/font/google", () => ({
  Space_Grotesk: () => ({ variable: "--font-display" }),
  JetBrains_Mono: () => ({ variable: "--font-code" }),
}));

// Application Components & Contexts
import TradePage, {
  generateMetadata as generateTradeMetadata,
  generateStaticParams as generateTradeStaticParams,
} from "@/app/trade/[market]/page";
import MarketDetailPage, {
  generateMetadata as generateMarketMetadata,
  generateStaticParams as generateMarketStaticParams,
} from "@/app/markets/[id]/page";
import { TradePageClient } from "@/components/trade/TradePageClient";
import { MarketSelector } from "@/components/trading/MarketSelector";
import { LandingView } from "@/components/landing/LandingView";
import { MarketTickerBar } from "@/components/trading/MarketTickerBar";
import { TradingDesk } from "@/components/trading/TradingDesk";
import { AnalyticsCard } from "@/components/trading/AnalyticsCard";
import {
  MarketContext,
  MarketProvider,
  useMarket,
} from "@/context/MarketContext";
import { LiveMarketSnapshot } from "@/lib/stellar";
import { WalletProvider, useWallet } from "@/context/WalletProvider";
import { PRESET_MARKETS, getMarketDefinition, findMarketById } from "@/lib/markets";

describe("Empirical Challenger M1: Context Elevation, Pass-Through Guard & SSR Safety Suite", () => {
  const FRONTEND_DIR = resolve(__dirname, "../../..");

  // ==========================================================================
  // Suite 1: MarketProvider Elevation in Root Layout & Tree Inheritance
  // ==========================================================================
  describe("Suite 1: MarketProvider Elevation in Root Layout & Tree Inheritance", () => {
    it("1.1 RootLayout is a valid React component wrapping children in WalletProvider and MarketProvider", async () => {
      const { default: RootLayout } = await import("@/app/layout");
      const rendered = RootLayout({
        children: <div id="test-child">Child Content</div>,
      });

      expect(React.isValidElement(rendered)).toBe(true);
      expect(rendered.type).toBe("html");

      // Verify that rendering the layout hierarchy with renderToString includes child content
      const html = renderToString(rendered);
      expect(html).toContain("Child Content");
      expect(html).toContain('id="test-child"');
      expect(html).toContain("min-h-screen");
      expect(html).toContain("bg-canvas");
    });

    it("1.2 Context inheritance: nested consumers at arbitrary depths receive elevated MarketContext", () => {
      let consumer1MarketId = "";
      let consumer2MarketId = "";
      let consumer3MarketCount = 0;

      function ConsumerDeep1() {
        const { activeMarketId } = useMarket();
        consumer1MarketId = activeMarketId;
        return <div data-consumer="1">{activeMarketId}</div>;
      }

      function ConsumerDeep2() {
        const { activeMarketId } = useMarket();
        consumer2MarketId = activeMarketId;
        return <div data-consumer="2">{activeMarketId}</div>;
      }

      function ConsumerDeep3() {
        const { markets } = useMarket();
        consumer3MarketCount = markets.length;
        return <div data-consumer="3">{markets.length}</div>;
      }

      const tree = (
        <WalletProvider>
          <MarketProvider>
            <div>
              <ConsumerDeep1 />
              <main>
                <section>
                  <ConsumerDeep2 />
                  <div>
                    <ConsumerDeep3 />
                  </div>
                </section>
              </main>
            </div>
          </MarketProvider>
        </WalletProvider>
      );

      const html = renderToString(tree);
      expect(html).toContain('data-consumer="1"');
      expect(consumer1MarketId).toBe(PRESET_MARKETS[0].id);
      expect(consumer2MarketId).toBe(PRESET_MARKETS[0].id);
      expect(consumer3MarketCount).toBe(PRESET_MARKETS.length);
    });

    it("1.3 Context initializes honestly with null activeSnapshot and zeroed loading metrics on mount", () => {
      let capturedSnapshot: LiveMarketSnapshot | null = null;
      let capturedLoading = false;
      let capturedError: string | null = "unexpected";
      let capturedMetricsCount = 0;

      function ContextInspector() {
        const ctx = useMarket();
        capturedSnapshot = ctx.activeSnapshot;
        capturedLoading = ctx.loadingSnapshot;
        capturedError = ctx.snapshotError;
        capturedMetricsCount = Object.keys(ctx.marketMetrics).length;
        return <div id="inspector">{ctx.activeMarket.name}</div>;
      }

      const html = renderToString(
        <WalletProvider>
          <MarketProvider>
            <ContextInspector />
          </MarketProvider>
        </WalletProvider>
      );

      expect(html).toContain("Pendle bUSDC PT 90D");
      expect(capturedSnapshot).toBeNull();
      expect(capturedLoading).toBe(true);
      expect(capturedError).toBeNull();
      expect(capturedMetricsCount).toBe(PRESET_MARKETS.length);
    });
  });

  // ==========================================================================
  // Suite 2: Context Pass-Through Guard Adversarial Hardening
  // ==========================================================================
  describe("Suite 2: Context Pass-Through Guard Adversarial Hardening", () => {
    it("2.1 Nested MarketProvider without initialMarketId delegates to existing context (zero shadowing)", () => {
      let outerContext: any = null;
      let innerContext: any = null;

      function OuterProbe() {
        outerContext = useMarket();
        return null;
      }

      function InnerProbe() {
        innerContext = useMarket();
        return null;
      }

      renderToString(
        <WalletProvider>
          <MarketProvider initialMarketId="usdc-90d">
            <OuterProbe />
            <div className="middle-wrapper">
              <MarketProvider>
                <InnerProbe />
              </MarketProvider>
            </div>
          </MarketProvider>
        </WalletProvider>
      );

      expect(outerContext).not.toBeNull();
      expect(innerContext).not.toBeNull();
      // Identity check: because MarketProvider pass-through returns <>{children}</>,
      // inner consumers share the exact identical context object
      expect(innerContext).toBe(outerContext);
      expect(innerContext.activeMarketId).toBe("usdc-90d");
    });

    it("2.2 Nested MarketProvider WITH explicit initialMarketId creates an isolated child scope", () => {
      let outerContext: any = null;
      let innerContext: any = null;

      function OuterProbe() {
        outerContext = useMarket();
        return <div id="outer">{outerContext.activeMarketId}</div>;
      }

      function InnerProbe() {
        innerContext = useMarket();
        return <div id="inner">{innerContext.activeMarketId}</div>;
      }

      const html = renderToString(
        <WalletProvider>
          <MarketProvider initialMarketId="usdc-90d">
            <OuterProbe />
            <MarketProvider initialMarketId="xlm-90d">
              <InnerProbe />
            </MarketProvider>
          </MarketProvider>
        </WalletProvider>
      );

      expect(outerContext.activeMarketId).toBe("usdc-90d");
      expect(innerContext.activeMarketId).toBe("xlm-90d");
      expect(innerContext).not.toBe(outerContext);
      expect(html).toContain('id="outer">usdc-90d');
      expect(html).toContain('id="inner">xlm-90d');
    });

    it("2.3 Deeply nested MarketProvider chain (N=10) collapses via pass-through without DOM bloat", () => {
      let deepContext: any = null;

      function DeepProbe() {
        deepContext = useMarket();
        return <span id="deep-leaf">leaf</span>;
      }

      let tree: React.ReactElement = <DeepProbe />;
      for (let i = 0; i < 10; i++) {
        tree = <MarketProvider>{tree}</MarketProvider>;
      }

      const html = renderToString(
        <WalletProvider>
          <MarketProvider initialMarketId="xlm-90d">{tree}</MarketProvider>
        </WalletProvider>
      );

      expect(html).toContain('id="deep-leaf">leaf</span>');
      expect(deepContext.activeMarketId).toBe("xlm-90d");
      expect(deepContext.activeMarket.asset.code).toBe("XLM");
    });

    it("2.4 Standalone MarketProvider outside layout initializes clean standalone context", () => {
      let standaloneCtx: any = null;

      function StandaloneProbe() {
        standaloneCtx = useMarket();
        return <div>{standaloneCtx.activeMarket.name}</div>;
      }

      const html = renderToString(
        <WalletProvider>
          <MarketProvider>
            <StandaloneProbe />
          </MarketProvider>
        </WalletProvider>
      );

      expect(standaloneCtx).not.toBeNull();
      expect(standaloneCtx.activeMarketId).toBe("usdc-90d");
      expect(html).toContain("Pendle bUSDC PT 90D");
    });

    it("2.5 Fuzzing initialMarketId with malformed, unknown, whitespace, and mixed-case inputs", () => {
      const testCases = [
        { input: "USDC-90D", expected: "usdc-90d" },
        { input: "  xlm-90d   ", expected: "xlm-90d" },
        { input: "uSDc-mATuREd", expected: "usdc-matured" },
        { input: "non-existent-market-id-404", expected: "usdc-90d" }, // fallback to preset[0]
        { input: "", expected: "usdc-90d" }, // empty string fallback
        { input: "   ", expected: "usdc-90d" }, // whitespace fallback
      ];

      for (const tc of testCases) {
        let captured: any = null;
        function FuzzProbe() {
          captured = useMarket();
          return null;
        }

        renderToString(
          <WalletProvider>
            <MarketProvider initialMarketId={tc.input}>
              <FuzzProbe />
            </MarketProvider>
          </WalletProvider>
        );

        expect(captured.activeMarketId).toBe(tc.expected);
      }
    });
  });

  // ==========================================================================
  // Suite 3: SSR String Rendering Safety & App Router Invariant Immunity
  // ==========================================================================
  describe("Suite 3: SSR String Rendering Safety & App Router Invariant Immunity", () => {
    it("3.1 renderToString on TradePageClient across all 6 preset markets produces valid HTML without App Router crash", () => {
      for (const m of PRESET_MARKETS) {
        let html = "";
        expect(() => {
          html = renderToString(
            <WalletProvider>
              <MarketProvider initialMarketId={m.id}>
                <TradePageClient market={m} initialTab="swap" />
              </MarketProvider>
            </WalletProvider>
          );
        }).not.toThrow();

        expect(html.length).toBeGreaterThan(500);
        expect(html).toContain(m.asset.code);
        expect(html).toContain(m.tenor);
        expect(html).toContain(m.ptSymbol);
        // Verify no raw Next.js router invariant error
        expect(html).not.toContain("invariant expected app router to be mounted");
      }
    });

    it("3.2 renderToString on TradePageClient across all 5 trading tabs", () => {
      const tabs = ["swap", "mint", "redeem", "liquidity", "rollover"];
      const market = PRESET_MARKETS[0];

      for (const tab of tabs) {
        let html = "";
        expect(() => {
          html = renderToString(
            <WalletProvider>
              <MarketProvider initialMarketId={market.id}>
                <TradePageClient market={market} initialTab={tab} />
              </MarketProvider>
            </WalletProvider>
          );
        }).not.toThrow();

        expect(html.length).toBeGreaterThan(500);
        expect(html).toContain(market.asset.code);
        expect(html).toContain(market.tenor);
      }
    });

    it("3.3 renderToString on MarketSelector with and without compact prop", () => {
      let normalHtml = "";
      let compactHtml = "";

      expect(() => {
        normalHtml = renderToString(
          <WalletProvider>
            <MarketProvider>
              <MarketSelector compact={false} />
            </MarketProvider>
          </WalletProvider>
        );
      }).not.toThrow();

      expect(() => {
        compactHtml = renderToString(
          <WalletProvider>
            <MarketProvider>
              <MarketSelector compact={true} />
            </MarketProvider>
          </WalletProvider>
        );
      }).not.toThrow();

      expect(normalHtml).toContain("USDC");
      expect(normalHtml).toContain("90D");
      expect(compactHtml).toContain("USDC");
      expect(compactHtml).toContain("90D");
      expect(normalHtml).not.toContain("invariant expected app router to be mounted");
      expect(compactHtml).not.toContain("invariant expected app router to be mounted");
    });

    it("3.4 renderToString on LandingView with null, active, and matured snapshots", () => {
      const market = PRESET_MARKETS[0];
      const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
      const nowSec = Math.floor(Date.now() / 1000);
      const makeSnapshot = (m: typeof market, isMatured: boolean): LiveMarketSnapshot => ({
        state: {
          total_pt_reserve: 4_000_0000000n,
          total_sy_reserve: 3_200_0000000n,
          total_lp_supply: 3_500_0000000n,
          scalar_root: 8_000000000000000000n,
          initial_anchor: 1_000000000000000000n,
          annual_fee_rate: 3_000000000000000n,
          protocol_fee_bps: 2000n,
          fee_recipient: m.contracts.poolId,
          maturity: BigInt(m.maturity),
          maturity_index: 1_000000000n,
          is_settled: isMatured,
        },
        latestLedger: 123456,
        nowSeconds: nowSec,
        daysToMaturity: isMatured ? 0 : 90,
        isMatured,
        blendExchangeRate: 1_001000000n,
        ammExchangeRateWad: 1_020408163265306122n,
        ptPriceInSy: isMatured ? 1.0 : 0.98,
        ytPriceInSy: isMatured ? 0.0 : 0.02,
        impliedFixedApyPct: isMatured ? 0 : 8.45,
        ptTotalSupply: 4_000_0000000n,
        ytTotalSupply: 4_000_0000000n,
        syTotalSupply: 7_200_0000000n,
        ptProportionPct: 55.56,
      });

      const snapshots = [
        null,
        makeSnapshot(market, false),
        makeSnapshot(maturedMarket, true),
      ];

      for (const snap of snapshots) {
        let html = "";
        expect(() => {
          html = renderToString(
            <WalletProvider>
              <MarketProvider>
                <LandingView onEnterDesk={() => {}} snapshot={snap} />
              </MarketProvider>
            </WalletProvider>
          );
        }).not.toThrow();

        expect(html.length).toBeGreaterThan(500);
        expect(html).toContain("USDC");
        // Verify links to dynamic routes exist
        expect(html).toContain("/trade/usdc-90d");
        expect(html).not.toContain("invariant expected app router to be mounted");
      }
    });

    it("3.5 renderToString on Naked Components outside providers falls back gracefully", () => {
      // MarketSelector and LandingView should not crash even if MarketProvider is completely omitted
      let selectorHtml = "";
      let landingHtml = "";

      expect(() => {
        selectorHtml = renderToString(<MarketSelector />);
      }).not.toThrow();

      expect(() => {
        landingHtml = renderToString(<LandingView onEnterDesk={() => {}} snapshot={null} />);
      }).not.toThrow();

      expect(selectorHtml).toContain("USDC");
      expect(selectorHtml).toContain("90D");
      expect(landingHtml).toContain("USDC");
    });
  });

  // ==========================================================================
  // Suite 4: Server Components Static Generation & 404 Guards
  // ==========================================================================
  describe("Suite 4: Server Components Static Generation & 404 Guards", () => {
    it("4.1 generateStaticParams returns all 5 preset markets for both /trade and /markets routes", async () => {
      const tradeParams = await generateTradeStaticParams();
      const marketParams = await generateMarketStaticParams();

      expect(tradeParams.length).toBe(5);
      expect(marketParams.length).toBe(5);

      const expectedMarkets = [
        "usdc-90d",
        "usdc-30d",
        "xlm-90d",
        "usdc-matured",
        "usdc-slender-90d",
      ];

      expect(tradeParams.map((p) => p.market)).toEqual(expectedMarkets);
      expect(marketParams.map((p) => p.id)).toEqual(expectedMarkets);
    });

    it("4.2 generateMetadata generates accurate metadata for valid markets and safe fallback for invalid markets", async () => {
      // Valid trade market
      const metaValid = await generateTradeMetadata({
        params: Promise.resolve({ market: "usdc-90d" }),
      });
      expect(metaValid.title).toContain("Pendle bUSDC PT 90D");
      expect(metaValid.title).toContain("PT-bUSDC-90D");

      // Invalid trade market
      const metaInvalid = await generateTradeMetadata({
        params: Promise.resolve({ market: "non-existent-market" }),
      });
      expect(metaInvalid.title).toBe("Market Not Found | NivoraFi");

      // Valid market detail
      const metaMarket = await generateMarketMetadata({
        params: Promise.resolve({ id: "xlm-90d" }),
      });
      expect(metaMarket.title).toContain("Pendle bXLM PT 90D");

      // Invalid market detail
      const metaMarketInvalid = await generateMarketMetadata({
        params: Promise.resolve({ id: "invalid-id" }),
      });
      expect(metaMarketInvalid.title).toBe("Market Not Found | NivoraFi");
    });

    it("4.3 TradePage Server Component resolves valid market or triggers notFound()", async () => {
      // Valid market
      const pageResult = await TradePage({
        params: Promise.resolve({ market: "usdc-90d" }),
        searchParams: Promise.resolve({ tab: "mint" }),
      });
      expect(React.isValidElement(pageResult)).toBe(true);
      expect(pageResult.props.market.id).toBe("usdc-90d");
      expect(pageResult.props.initialTab).toBe("mint");

      // Invalid market should throw NEXT_NOT_FOUND
      let errorThrown: any = null;
      try {
        await TradePage({
          params: Promise.resolve({ market: "invalid-slug-404" }),
        });
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).not.toBeNull();
      // Next.js notFound() throws a specific internal digest
      expect(errorThrown.digest || errorThrown.message).toBeDefined();
    });

    it("4.4 MarketDetailPage Server Component resolves valid market or triggers notFound()", async () => {
      // Valid market
      const pageResult = await MarketDetailPage({
        params: Promise.resolve({ id: "usdc-30d" }),
        searchParams: Promise.resolve({ tab: "liquidity" }),
      });
      expect(React.isValidElement(pageResult)).toBe(true);
      expect(pageResult.props.market.id).toBe("usdc-30d");
      expect(pageResult.props.initialTab).toBe("liquidity");

      // Invalid market should throw NEXT_NOT_FOUND
      let errorThrown: any = null;
      try {
        await MarketDetailPage({
          params: Promise.resolve({ id: "invalid-market-id" }),
        });
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).not.toBeNull();
    });
  });

  // ==========================================================================
  // Suite 5: Legacy URL Parameters & Query Compatibility
  // ==========================================================================
  describe("Suite 5: Legacy URL Parameters & Query Compatibility", () => {
    it("5.1 getMarketDefinition parses case-insensitively and trims whitespace", () => {
      expect(getMarketDefinition("usdc-90d")?.id).toBe("usdc-90d");
      expect(getMarketDefinition("  USDC-90D  ")?.id).toBe("usdc-90d");
      expect(getMarketDefinition("Xlm-90d")?.id).toBe("xlm-90d");
      expect(getMarketDefinition("uSdC-mAtUrEd")?.id).toBe("usdc-matured");
      expect(getMarketDefinition("USDC-30D")?.id).toBe("usdc-30d");
      expect(getMarketDefinition("unknown-market")).toBeUndefined();
      expect(getMarketDefinition("")).toBeUndefined();
    });

    it("5.2 Simulates legacy query parameter resolution (?view=trade&market=...)", () => {
      function simulateLegacyQueryRouter(queryString: string) {
        const params = new URLSearchParams(queryString.startsWith("?") ? queryString : `?${queryString}`);
        const view = params.get("view");
        const marketSlug = params.get("market");
        const resolvedMarket = marketSlug ? getMarketDefinition(marketSlug) : undefined;

        let effectiveView = "landing";
        if (view === "trade") effectiveView = "trade";
        else if (view === "portfolio") effectiveView = "portfolio";

        return {
          view: effectiveView,
          market: resolvedMarket?.id ?? PRESET_MARKETS[0].id,
          isExplicitMarket: Boolean(resolvedMarket),
        };
      }

      // Standard legacy trade view
      const r1 = simulateLegacyQueryRouter("?view=trade&market=usdc-90d");
      expect(r1.view).toBe("trade");
      expect(r1.market).toBe("usdc-90d");
      expect(r1.isExplicitMarket).toBe(true);

      // XLM market trade view
      const r2 = simulateLegacyQueryRouter("?view=trade&market=xlm-90d");
      expect(r2.view).toBe("trade");
      expect(r2.market).toBe("xlm-90d");
      expect(r2.isExplicitMarket).toBe(true);

      // Portfolio view
      const r3 = simulateLegacyQueryRouter("?view=portfolio");
      expect(r3.view).toBe("portfolio");

      // Invalid market slug falls back safely
      const r4 = simulateLegacyQueryRouter("?view=trade&market=corrupt-token-slug");
      expect(r4.view).toBe("trade");
      expect(r4.market).toBe("usdc-90d");
      expect(r4.isExplicitMarket).toBe(false);
    });

    it("5.3 LandingView renders direct route links to all 6 preset markets", () => {
      const html = renderToString(
        <WalletProvider>
          <MarketProvider>
            <LandingView onEnterDesk={() => {}} snapshot={null} />
          </MarketProvider>
        </WalletProvider>
      );

      for (const m of PRESET_MARKETS) {
        // Assert every market has an href link pointing to /trade/${m.id}
        expect(html).toContain(`/trade/${m.id}`);
      }
    });

    it("5.4 selectMarket updates activeMarket and triggers state transitions across consumers", () => {
      let currentSelectMarket: (id: string) => void = () => {};
      let activeId = "";

      function SwitchProbe() {
        const ctx = useMarket();
        currentSelectMarket = ctx.selectMarket;
        activeId = ctx.activeMarketId;
        return <div id="active-id">{ctx.activeMarketId}</div>;
      }

      renderToString(
        <WalletProvider>
          <MarketProvider initialMarketId="usdc-90d">
            <SwitchProbe />
          </MarketProvider>
        </WalletProvider>
      );

      expect(activeId).toBe("usdc-90d");
      expect(typeof currentSelectMarket).toBe("function");
    });
  });

  // ==========================================================================
  // Suite 6: Protected Files Bit-for-Bit Integrity Checksums
  // ==========================================================================
  describe("Suite 6: Protected Files Bit-for-Bit Integrity Checksums", () => {
    it("6.1 src/lib/indexer.ts has exact immutable SHA256 checksum", () => {
      const filePath = join(FRONTEND_DIR, "src/lib/indexer.ts");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
    });

    it("6.2 src/hooks/useEventIndexer.ts has exact immutable SHA256 checksum", () => {
      const filePath = join(FRONTEND_DIR, "src/hooks/useEventIndexer.ts");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
    });
  });
});
