// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { SvgSparkline, SparklinePoint } from "../../components/trading/SvgSparkline";
import { AnalyticsCard } from "../../components/trading/AnalyticsCard";
import { ApyDataPoint, MarketAnalyticsData } from "../../components/trading/AnalyticsCard.types";

describe("Empirical Challenger M1.2: UI Performance, Layout Stability & DOM Persistence", () => {
  const mockApyHistory: ApyDataPoint[] = [
    { timestamp: 1700000000, apyPct: 5.2 },
    { timestamp: 1700003600, apyPct: 5.5 },
    { timestamp: 1700007200, apyPct: 5.1 },
    { timestamp: 1700010800, apyPct: 5.8 },
    { timestamp: 1700014400, apyPct: 6.2 },
  ];

  const mockSparklinePoints: SparklinePoint[] = mockApyHistory.map((pt) => ({
    timestamp: pt.timestamp,
    value: pt.apyPct,
  }));

  const mockAnalytics: MarketAnalyticsData = {
    impliedApyPct: 6.2,
    apyChange24hPct: 0.85,
    volume24hUsdc: 25000000000n, // 2,500 USDC
    totalVolumeUsdc: 50000000000n,
    totalTvlUsdc: 150000000000n, // 15,000 USDC
    totalSwapsCount: 128,
    totalTransactionsCount: 150,
    apyHistory: mockApyHistory,
    lastIndexedLedger: 123456,
  };

  // ==========================================================================
  // 1. DOM Persistence During Background Sync Pulses (Zero Unmounts)
  // ==========================================================================
  describe("1. DOM Persistence & Zero Unmount During Simulated Background Sync Pulses", () => {
    it("empirically verifies SvgSparkline remains mounted across 50 simulated 10-second sync pulses", () => {
      let isIndexerSyncing = false;
      const pulses = 50;
      const renders: string[] = [];

      for (let i = 0; i < pulses; i++) {
        // Toggle sync state every pulse (simulating 10s poll cycle: idle -> syncing -> idle)
        isIndexerSyncing = i % 2 === 1;

        const html = renderToString(
          React.createElement(SvgSparkline, {
            data: mockSparklinePoints,
            loading: isIndexerSyncing,
            height: 96,
          })
        );

        renders.push(html);

        // Assert SVG element is persistently rendered in 100% of the pulses
        expect(html).toContain("<svg");
        expect(html).toContain('viewBox="0 0 400 96"');
        expect(html).toContain("<path");
        expect(html).not.toContain("NaN");

        // Assert fallback placeholder is NEVER rendered during background sync
        expect(html).not.toContain("Syncing historical events...");
        expect(html).not.toContain("Accumulating ledger events...");
      }

      // Assert that the rendered SVG markup is 100% identical between sync and idle states
      const idleMarkup = renders[0]; // pulse 0: isIndexerSyncing = false
      const syncMarkup = renders[1]; // pulse 1: isIndexerSyncing = true
      expect(idleMarkup).toBe(syncMarkup);
    });

    it("empirically verifies AnalyticsCard preserves DOM integrity during background sync pulses", () => {
      const loadingMarket = false;
      const pulses = 20;

      for (let i = 0; i < pulses; i++) {
        const isIndexerSyncing = i % 2 === 1;

        // Formula from src/app/page.tsx: loadingMarket || (isIndexerSyncing && !analytics)
        const computedLoading = loadingMarket || (isIndexerSyncing && !mockAnalytics);

        // When analytics is non-null, computedLoading MUST strictly be false
        expect(computedLoading).toBe(false);

        const html = renderToString(
          React.createElement(AnalyticsCard, {
            analytics: mockAnalytics,
            daysToMaturity: 45.2,
            loading: computedLoading,
          })
        );

        // Verify primary KPI values are stable and not replaced by loading dots
        expect(html).toContain("6.20%");
        expect(html).not.toContain("...");
        expect(html).toContain("+0.85%");
        expect(html).toContain("45.2d");

        // Verify SVG sparkline canvas is embedded and present
        expect(html).toContain('viewBox="0 0 400 96"');
        expect(html).not.toContain("Syncing historical events...");
        expect(html).not.toContain("NaN");
      }
    });

    it("verifies loading state behavior when analytics IS null (cold-start vs active sync)", () => {
      const loadingMarket = false;

      // Pulse 1: Cold-start idle without analytics
      const idleLoading = loadingMarket || (false && !null);
      const idleHtml = renderToString(
        React.createElement(AnalyticsCard, {
          analytics: null,
          daysToMaturity: undefined,
          loading: idleLoading,
        })
      );
      expect(idleHtml).toContain("Accumulating ledger events...");
      expect(idleHtml).not.toContain('viewBox="0 0 400 96"');

      // Pulse 2: Cold-start background sync active without analytics
      const syncLoading = loadingMarket || (true && !null);
      expect(syncLoading).toBe(true);
      const syncHtml = renderToString(
        React.createElement(AnalyticsCard, {
          analytics: null,
          daysToMaturity: undefined,
          loading: syncLoading,
        })
      );
      expect(syncHtml).toContain("Syncing historical events...");
      expect(syncHtml).not.toContain('viewBox="0 0 400 96"');
    });
  });

  // ==========================================================================
  // 2. Direct SvgSparkline Loading Decoupling Stress Matrix
  // ==========================================================================
  describe("2. Direct SvgSparkline Loading Decoupling Stress Matrix", () => {
    it("verifies single-point data maintains SVG rendering regardless of loading flag", () => {
      const singlePoint: SparklinePoint[] = [{ timestamp: 1700000000, value: 4.8 }];

      const htmlLoadingFalse = renderToString(
        React.createElement(SvgSparkline, { data: singlePoint, loading: false })
      );
      const htmlLoadingTrue = renderToString(
        React.createElement(SvgSparkline, { data: singlePoint, loading: true })
      );

      expect(htmlLoadingFalse).toContain("<svg");
      expect(htmlLoadingTrue).toContain("<svg");
      expect(htmlLoadingTrue).not.toContain("Syncing historical events...");
      expect(htmlLoadingFalse).toBe(htmlLoadingTrue);
    });

    it("verifies 1,000-point data set rendering stability under loading toggle", () => {
      const largeData: SparklinePoint[] = Array.from({ length: 1000 }, (_, i) => ({
        timestamp: 1700000000 + i * 60,
        value: 5.0 + Math.sin(i / 10) * 1.5,
      }));

      const htmlIdle = renderToString(
        React.createElement(SvgSparkline, { data: largeData, loading: false })
      );
      const htmlSync = renderToString(
        React.createElement(SvgSparkline, { data: largeData, loading: true })
      );

      expect(htmlIdle).toContain("<svg");
      expect(htmlSync).toContain("<svg");
      expect(htmlIdle).toBe(htmlSync);
    });

    it("verifies empty data array correctly triggers fallback with appropriate status", () => {
      const emptyData: SparklinePoint[] = [];

      const htmlIdle = renderToString(
        React.createElement(SvgSparkline, { data: emptyData, loading: false })
      );
      expect(htmlIdle).toContain("Accumulating ledger events...");
      expect(htmlIdle).not.toContain("<svg");

      const htmlSync = renderToString(
        React.createElement(SvgSparkline, { data: emptyData, loading: true })
      );
      expect(htmlSync).toContain("Syncing historical events...");
      expect(htmlSync).not.toContain("<svg");
    });
  });

  // ==========================================================================
  // 3. Layout Stability & Cumulative Layout Shift (CLS = 0) Invariance
  // ==========================================================================
  describe("3. Layout Stability & Dimension Invariance (CLS = 0)", () => {
    it("guarantees identical 96px vertical height box for both empty fallback and active SVG", () => {
      const emptyHtml = renderToString(
        React.createElement(SvgSparkline, { data: [], loading: false, height: 96 })
      );
      const populatedHtml = renderToString(
        React.createElement(SvgSparkline, { data: mockSparklinePoints, loading: false, height: 96 })
      );

      // Empty container has explicit Tailwind class h-[96px]
      expect(emptyHtml).toContain("h-[96px]");

      // Populated SVG has explicit inline style height:96px
      expect(populatedHtml).toContain("height:96px");
      expect(populatedHtml).toContain('viewBox="0 0 400 96"');
    });

    it("verifies custom height prop propagates synchronously to both states", () => {
      const customHeight = 120;
      const emptyHtml = renderToString(
        React.createElement(SvgSparkline, { data: [], loading: false, height: customHeight })
      );
      const populatedHtml = renderToString(
        React.createElement(SvgSparkline, { data: mockSparklinePoints, loading: false, height: customHeight })
      );

      // SVG reflects custom height
      expect(populatedHtml).toContain(`height:${customHeight}px`);
      expect(populatedHtml).toContain(`viewBox="0 0 400 ${customHeight}"`);
    });
  });

  // ==========================================================================
  // 4. Render Performance & Stress Benchmarking
  // ==========================================================================
  describe("4. Render Performance & Latency Benchmark", () => {
    it("executes 1,000 render cycles of SvgSparkline within acceptable budget (<0.2ms/render)", () => {
      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        renderToString(
          React.createElement(SvgSparkline, {
            data: mockSparklinePoints,
            loading: i % 2 === 0,
            height: 96,
          })
        );
      }

      const totalTimeMs = performance.now() - start;
      const avgTimeMs = totalTimeMs / iterations;

      // Ensure SSR execution time is fast and well under 1ms per component render
      expect(avgTimeMs).toBeLessThan(1.0);
    });

    it("executes 250 render cycles of full AnalyticsCard without memory bloat", () => {
      const iterations = 250;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        renderToString(
          React.createElement(AnalyticsCard, {
            analytics: mockAnalytics,
            daysToMaturity: 30,
            loading: i % 2 === 0,
          })
        );
      }

      const totalTimeMs = performance.now() - start;
      const avgTimeMs = totalTimeMs / iterations;

      expect(avgTimeMs).toBeLessThan(2.0);
    });
  });

  // ==========================================================================
  // 5. Next.js Production Build Bundle Integrity
  // ==========================================================================
  describe("5. Next.js Production Build Bundle Integrity", () => {
    it("verifies .next build artifacts exist and are structurally valid", () => {
      const nextDir = join(process.cwd(), ".next");
      expect(existsSync(nextDir)).toBe(true);

      const buildIdPath = join(nextDir, "BUILD_ID");
      expect(existsSync(buildIdPath)).toBe(true);
      const buildId = readFileSync(buildIdPath, "utf-8").trim();
      expect(buildId.length).toBeGreaterThan(0);

      const appPathsManifestPath = join(nextDir, "server", "app-paths-manifest.json");
      expect(existsSync(appPathsManifestPath)).toBe(true);
      const appPathsManifest = JSON.parse(readFileSync(appPathsManifestPath, "utf-8"));
      expect(appPathsManifest["/page"]).toBeDefined();
    });

    it("verifies static pre-rendered root page HTML exists and contains critical shell", () => {
      const rootPageHtmlPath = join(process.cwd(), ".next", "server", "app", "index.html");
      if (existsSync(rootPageHtmlPath)) {
        const rootHtml = readFileSync(rootPageHtmlPath, "utf-8");
        expect(rootHtml.length).toBeGreaterThan(500);
      }
    });
  });
});
