// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { SvgSparkline, SparklinePoint } from "@/components/trading/SvgSparkline";
import { readFileSync } from "fs";
import { join } from "path";

describe("Empirical Challenger M1.1: SvgSparkline & Page Loading Stress Matrix", () => {
  describe("1. Empty Data Invariants (data = [])", () => {
    it("renders fallback placeholder with 'Syncing historical events...' when loading=true", () => {
      const html = renderToString(
        React.createElement(SvgSparkline, { data: [], loading: true })
      );
      expect(html).toContain("Syncing historical events...");
      expect(html).not.toContain("<svg");
      expect(html).toContain("h-[96px]");
    });

    it("renders fallback placeholder with 'Accumulating ledger events...' when loading=false", () => {
      const html = renderToString(
        React.createElement(SvgSparkline, { data: [], loading: false })
      );
      expect(html).toContain("Accumulating ledger events...");
      expect(html).not.toContain("<svg");
      expect(html).toContain("h-[96px]");
    });

    it("maintains identical fallback container dimensions (96px height) across loading states", () => {
      const htmlSync = renderToString(
        React.createElement(SvgSparkline, { data: [], loading: true })
      );
      const htmlAcc = renderToString(
        React.createElement(SvgSparkline, { data: [], loading: false })
      );

      expect(htmlSync.replace("Syncing historical events...", "")).toBe(
        htmlAcc.replace("Accumulating ledger events...", "")
      );
    });
  });

  describe("2. Non-Empty Data Invariant & Zero-Flicker Under Loading Toggles", () => {
    const twoPoints: SparklinePoint[] = [
      { timestamp: 1700000000, value: 5.25 },
      { timestamp: 1700003600, value: 5.75 },
    ];

    it("renders complete SVG canvas without fallback div when loading=true and data has points", () => {
      const html = renderToString(
        React.createElement(SvgSparkline, { data: twoPoints, loading: true })
      );
      expect(html).toContain("<svg");
      expect(html).toContain('viewBox="0 0 400 96"');
      expect(html).not.toContain("Syncing historical events...");
      expect(html).not.toContain("Accumulating ledger events...");
    });

    it("renders identical SVG output whether loading=true or loading=false (zero DOM flicker)", () => {
      const htmlLoading = renderToString(
        React.createElement(SvgSparkline, { data: twoPoints, loading: true })
      );
      const htmlNotLoading = renderToString(
        React.createElement(SvgSparkline, { data: twoPoints, loading: false })
      );

      expect(htmlLoading).toBe(htmlNotLoading);
    });

    it("survives 1,000 rapid loading toggles with zero layout divergence", () => {
      const baseHtml = renderToString(
        React.createElement(SvgSparkline, { data: twoPoints, loading: false })
      );

      for (let i = 0; i < 1000; i++) {
        const toggleLoading = i % 2 === 0;
        const toggledHtml = renderToString(
          React.createElement(SvgSparkline, { data: twoPoints, loading: toggleLoading })
        );
        expect(toggledHtml).toBe(baseHtml);
      }
    });

    it("renders continuous SVG during streaming data updates while loading=true", () => {
      const pointsStream: SparklinePoint[] = [...twoPoints];
      for (let i = 1; i <= 10; i++) {
        pointsStream.push({
          timestamp: 1700003600 + i * 3600,
          value: 5.75 + i * 0.1,
        });

        const html = renderToString(
          React.createElement(SvgSparkline, { data: pointsStream, loading: true })
        );
        expect(html).toContain("<svg");
        expect(html).not.toContain("Syncing historical events...");
      }
    });
  });

  describe("3. Edge Case: Single Data Point (data.length = 1)", () => {
    it("renders horizontal centered line without division-by-zero or NaN path", () => {
      const singlePoint: SparklinePoint[] = [{ timestamp: 1700000000, value: 7.42 }];
      const html = renderToString(
        React.createElement(SvgSparkline, { data: singlePoint, height: 96 })
      );

      expect(html).toContain("<svg");
      expect(html).toContain('d="M 0,48.00 L 400,48.00"');
      expect(html).toContain('d="M 0,48.00 L 400,48.00 L 400,96 L 0,96 Z"');
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("Infinity");
      expect(html).toContain("Min: <!-- -->7.42<!-- -->%");
      expect(html).toContain("Avg: <!-- -->7.42<!-- -->%");
      expect(html).toContain("Max: <!-- -->7.42<!-- -->%");
    });

    it("respects custom height prop when centering single-point line", () => {
      const singlePoint: SparklinePoint[] = [{ timestamp: 1700000000, value: 4.0 }];
      const customHeight = 120;
      const html = renderToString(
        React.createElement(SvgSparkline, { data: singlePoint, height: customHeight })
      );

      expect(html).toContain(`viewBox="0 0 400 ${customHeight}"`);
      expect(html).toContain('d="M 0,60.00 L 400,60.00"'); // 120 / 2 = 60
    });
  });

  describe("4. Edge Case: Constant Values (Flat APY)", () => {
    it("renders centered horizontal curve when all points have identical values", () => {
      const flatData: SparklinePoint[] = [
        { timestamp: 100, value: 5.0 },
        { timestamp: 200, value: 5.0 },
        { timestamp: 300, value: 5.0 },
        { timestamp: 400, value: 5.0 },
      ];

      const html = renderToString(
        React.createElement(SvgSparkline, { data: flatData, height: 96 })
      );

      expect(html).toContain("<svg");
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("Infinity");
      expect(html).toContain("Min: <!-- -->5.00<!-- -->%");
      expect(html).toContain("Avg: <!-- -->5.00<!-- -->%");
      expect(html).toContain("Max: <!-- -->5.00<!-- -->%");
      // All Y coordinates should evaluate to y = 48.00
      expect(html).toContain("M 0.00,48.00");
    });
  });

  describe("5. High-Frequency & Large Dataset Scalability", () => {
    it("efficiently renders 1,000 points without numerical degradation", () => {
      const largeData: SparklinePoint[] = Array.from({ length: 1000 }, (_, i) => ({
        timestamp: 1700000000 + i * 60,
        value: 5.0 + Math.sin(i / 50) * 2.0,
      }));

      const start = performance.now();
      const html = renderToString(
        React.createElement(SvgSparkline, { data: largeData, height: 96 })
      );
      const elapsed = performance.now() - start;

      expect(html).toContain("<svg");
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("Infinity");
      expect(elapsed).toBeLessThan(100); // Must render in <100ms
    });

    it("preserves top-down monotonic coordinate projection", () => {
      const monotonic: SparklinePoint[] = [
        { timestamp: 100, value: 1.0 },
        { timestamp: 200, value: 2.0 },
        { timestamp: 300, value: 3.0 },
        { timestamp: 400, value: 4.0 },
      ];

      const html = renderToString(
        React.createElement(SvgSparkline, { data: monotonic, height: 96 })
      );

      expect(html).toContain("Min: <!-- -->1.00<!-- -->%");
      expect(html).toContain("Max: <!-- -->4.00<!-- -->%");
      expect(html).not.toContain("NaN");
    });
  });

  describe("6. Extreme & Adversarial Numerical Inputs", () => {
    it("handles zero APY safely", () => {
      const zeroData: SparklinePoint[] = [
        { timestamp: 100, value: 0.0 },
        { timestamp: 200, value: 0.0 },
      ];

      const html = renderToString(
        React.createElement(SvgSparkline, { data: zeroData })
      );
      expect(html).toContain("<svg");
      expect(html).toContain("Min: <!-- -->0.00<!-- -->%");
      expect(html).not.toContain("NaN");
    });

    it("handles negative values (e.g. negative discount rates) without crashing", () => {
      const negativeData: SparklinePoint[] = [
        { timestamp: 100, value: -2.5 },
        { timestamp: 200, value: -1.0 },
        { timestamp: 300, value: 0.5 },
      ];

      const html = renderToString(
        React.createElement(SvgSparkline, { data: negativeData })
      );
      expect(html).toContain("<svg");
      expect(html).toContain("Min: <!-- -->-2.50<!-- -->%");
      expect(html).not.toContain("NaN");
    });

    it("handles massive APY numbers without numeric overflow", () => {
      const hugeData: SparklinePoint[] = [
        { timestamp: 100, value: 10000.0 },
        { timestamp: 200, value: 50000.0 },
      ];

      const html = renderToString(
        React.createElement(SvgSparkline, { data: hugeData })
      );
      expect(html).toContain("<svg");
      expect(html).toContain("Max: <!-- -->50000.00<!-- -->%");
      expect(html).not.toContain("NaN");
    });

    it("survives NaN values without crashing the React component tree", () => {
      const nanData: SparklinePoint[] = [
        { timestamp: 100, value: NaN },
        { timestamp: 200, value: 5.0 },
      ];

      expect(() => {
        renderToString(React.createElement(SvgSparkline, { data: nanData }));
      }).not.toThrow();
    });
  });

  describe("7. Page & AnalyticsCard Loading Logic Invariant Verification", () => {
    // Evaluates page.tsx line 519: loading={loadingMarket || (isIndexerSyncing && !analytics)}
    function computeCardLoading(
      loadingMarket: boolean,
      isIndexerSyncing: boolean,
      hasAnalytics: boolean
    ) {
      return loadingMarket || (isIndexerSyncing && !hasAnalytics);
    }

    it("strictly isolates background indexer sync from causing card reload when analytics exist", () => {
      // Normal state: market loaded, analytics present, indexer syncs in background
      const cardLoadingDuringSync = computeCardLoading(false, true, true);
      expect(cardLoadingDuringSync).toBe(false);

      // Resting state: market loaded, analytics present, indexer idle
      const cardLoadingIdle = computeCardLoading(false, false, true);
      expect(cardLoadingIdle).toBe(false);
    });

    it("allows loading state only on initial boot when analytics have not arrived", () => {
      // Boot state: market loaded, but first indexer poll in flight, analytics null
      const initialBootLoading = computeCardLoading(false, true, false);
      expect(initialBootLoading).toBe(true);

      // Hard market loading state
      const marketLoading = computeCardLoading(true, false, true);
      expect(marketLoading).toBe(true);
    });

    it("verifies exact source code implementations in SvgSparkline.tsx and page.tsx", () => {
      const sparklineSrc = readFileSync(
        join(process.cwd(), "src/components/trading/SvgSparkline.tsx"),
        "utf-8"
      );
      // Confirms the unmount condition was strictly simplified to empty check
      expect(sparklineSrc).toContain("if (data.length === 0) {");
      expect(sparklineSrc).not.toContain("if (loading || data.length === 0)");

      const pageSrc = readFileSync(
        join(process.cwd(), "src/app/page.tsx"),
        "utf-8"
      );
      // Confirms page loading prop isolates indexer syncing when analytics exist
      expect(pageSrc).toContain(
        "loading={loadingMarket || (isIndexerSyncing && !analytics)}"
      );
    });
  });
});
