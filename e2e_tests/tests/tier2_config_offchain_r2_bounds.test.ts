// e2e_tests/tests/tier2_config_offchain_r2_bounds.test.ts
// Tier 2: Boundary & Corner Cases for F6 (Auth/BFF Sanitization), F7 (Market/Port/Valuation Bounds), and F8 (Zero-Liquidity & Empty-Chart Boundaries)

import { describe, it, expect } from "bun:test";
import { StrKey } from "@stellar/stellar-sdk";
import {
  CANONICAL_INDEXER_PORT,
  CANONICAL_USDC_MATURED,
  CANONICAL_XLM_PRICE_USD,
  FRONTEND_DIR,
  INDEXER_DIR,
  React,
  getClosedLocalUrl,
  invokeBffGet,
  readFileText,
  renderFrontendHtml,
  startIndexerHarness,
} from "../src/harness/index.ts";
import {
  PRESET_MARKETS,
  getMarketDefinition,
  type MarketSummaryMetrics,
} from "@/lib/markets";
import { parseMarketPosition } from "@/hooks/useMultiMarketPortfolio";
import {
  convertToApyDataPoints,
  convertToChartDataPoints,
  fetchMarketChartData,
  type MarketChartPoint,
} from "@/lib/indexerAnalytics";
import type { LiveMarketSnapshot, LiveUserPortfolio } from "@/lib/stellar";
import { WalletProvider } from "@/context/WalletProvider";
import { deriveMetricsFromSnapshot } from "@/context/MarketContext";
import { LandingView } from "@/components/landing/LandingView";
import { SwapCard } from "@/components/trading/SwapCard";
import { AnalyticsCard } from "@/components/trading/AnalyticsCard";
import { InteractiveYieldChart, type ChartDataPoint } from "@/components/token/InteractiveYieldChart";
import { resolveHttpPort } from "../../indexer/index.ts";

const TEST_SECRET = "e2e-test-secret-32bytes-hex-0001";
const TEST_USER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const GREENFIELD_USER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const STROOP_USER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
const STALE_XLM_POOL_ID = "CCHCYSCFHXHUR2YA45AR6G4BYLLKZRZNVXLKSRFN7U5M2ZGJFYOL4PDL";

describe("Tier 2: Offchain Config, Indexer & Frontend R2 Boundaries", () => {
  describe("F6: Auth, Secret Isolation & BFF Boundary Hardening", () => {
    it("T2-F6.1: direct indexer rejects missing, empty, length-mismatched, and wrong-byte secrets with 401", async () => {
      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        const cases: Array<Record<string, string>> = [
          {},
          { "x-indexer-secret": "" },
          { "x-indexer-secret": "short" },
          { "x-indexer-secret": `${TEST_SECRET}-extra` },
          { "x-indexer-secret": "e2e-test-secret-32bytes-hex-0002" },
        ];

        for (const headers of cases) {
          // Use globalThis.fetch directly so idx.fetch does not auto-inject x-indexer-secret
          const res = await globalThis.fetch(`${idx.baseUrl}/health`, { headers });
          expect(res.status).toBe(401);
          const body = (await res.json()) as { error?: string };
          expect(body).toEqual({ error: "Unauthorized" });
        }
      } finally {
        await idx.stop();
      }
    });

    it("T2-F6.2: BFF propagates 401 on secret mismatch without leaking either secret", async () => {
      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        const res = await invokeBffGet({
          url: "/api/indexer/health",
          indexerInternalUrl: idx.baseUrl,
          indexerApiSecret: "wrong-secret",
        });
        expect(res.status).toBe(401);
        const raw = await res.text();
        expect(raw).not.toContain("wrong-secret");
        expect(raw).not.toContain("e2e-test-secret");
      } finally {
        await idx.stop();
      }
    });

    it("T2-F6.3: BFF returns sanitized 502 with no-store when upstream port is closed", async () => {
      const closedUrl = await getClosedLocalUrl();
      const closedPort = new URL(closedUrl).port;

      const res = await invokeBffGet({
        url: "/api/indexer/stats",
        indexerInternalUrl: closedUrl,
        indexerApiSecret: "any",
      });
      expect(res.status).toBe(502);
      expect(res.headers.get("cache-control")).toBe("no-store");

      const raw = await res.text();
      expect(raw).not.toContain("127.0.0.1");
      expect(raw).not.toContain(closedPort);
      expect(JSON.parse(raw)).toEqual({
        success: false,
        status: "offline",
        error: "Indexer upstream unavailable",
      });
    });

    it("T2-F6.4: BFF rejects path traversal and non-whitelisted paths with 404 before contacting upstream", async () => {
      const closedUrl = await getClosedLocalUrl();
      const invalidPaths: string[][] = [
        ["admin"],
        ["..%2Fetc%2Fpasswd"],
        ["health", "..", "stats"],
        [],
      ];

      for (const path of invalidPaths) {
        const res = await invokeBffGet({
          path,
          indexerInternalUrl: closedUrl,
          indexerApiSecret: "any",
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { success: boolean; error: string };
        expect(body).toEqual({ success: false, error: "Not Found" });
      }
    });

    it("T2-F6.5: env.ts strips evil trycloudflare.com override back to /api/indexer", () => {
      const envSpawn = {
        ...process.env,
        NEXT_PUBLIC_INDEXER_API_URL: "https://evil-tunnel.trycloudflare.com",
      };
      const proc = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import { ENV } from "./src/lib/env.ts"; console.log(JSON.stringify({ indexerApiUrl: ENV.indexerApiUrl }));',
        ],
        {
          cwd: FRONTEND_DIR,
          env: envSpawn,
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      expect(proc.exitCode).toBe(0);
      const out = new TextDecoder().decode(proc.stdout).trim();
      const parsed = JSON.parse(out) as { indexerApiUrl: string };
      expect(parsed.indexerApiUrl).toBe("/api/indexer");
    });
  });

  describe("F7: Market Resolution, Maturity Boundary, Port Env & XLM Stroop Math", () => {
    it("T2-F7.1: indexer rejects legacy stale XLM pool ID CCHCYSC... with HTTP 400", async () => {
      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        const res = await idx.fetch(`/charts?market=${STALE_XLM_POOL_ID}`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(false);
      } finally {
        await idx.stop();
      }
    });

    it("T2-F7.2: market resolution handles case-insensitive and whitespace-padded slugs", async () => {
      expect(getMarketDefinition("  USDC-MATURED  ")?.id).toBe("usdc-matured");
      expect(getMarketDefinition("  XLM-90D  ")?.id).toBe("xlm-90d");

      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        const res = await idx.fetch("/charts?market=%20XLM-90D%20&interval=1d");
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          success: boolean;
          market: string;
          interval: string;
        };
        expect(body.success).toBe(true);
        expect(body.market).toBe("xlm-90d");
        expect(body.interval).toBe("1D");
      } finally {
        await idx.stop();
      }
    });

    it("T2-F7.3: usdc-matured post-maturity boundary math yields ptPrice 1.0, ytPrice 0.0, impliedApy 0", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      expect(nowSec).toBeGreaterThanOrEqual(CANONICAL_USDC_MATURED.maturity);

      const idx = await startIndexerHarness({
        secret: TEST_SECRET,
        seed(storage) {
          storage.recordMintPy({
            marketId: "usdc-matured",
            caller: TEST_USER,
            receiver: TEST_USER,
            syIn: 100_0000000n,
            pyOut: 100_0000000n,
            timestamp: nowSec - 60,
          });
        },
      });
      try {
        const chartRes = await idx.fetch("/charts?market=usdc-matured&interval=1D");
        expect(chartRes.status).toBe(200);
        const chartBody = (await chartRes.json()) as {
          success: boolean;
          count: number;
          data: Array<{ ptPrice: number; ytPrice: number; impliedApy: number }>;
        };
        expect(chartBody.success).toBe(true);
        expect(chartBody.count).toBe(24);
        for (const pt of chartBody.data) {
          expect(Number.isFinite(pt.ptPrice)).toBe(true);
          expect(Number.isFinite(pt.ytPrice)).toBe(true);
          expect(Number.isFinite(pt.impliedApy)).toBe(true);
          expect(pt.ptPrice).toBe(1.0);
          expect(pt.ytPrice).toBe(0.0);
          expect(pt.impliedApy).toBe(0);
        }

        const posRes = await idx.fetch(`/positions?user=${TEST_USER}`);
        expect(posRes.status).toBe(200);
        const posBody = (await posRes.json()) as {
          success: boolean;
          positions: Array<{
            marketId: string;
            currentPtBalance: string;
            currentYtBalance: string;
            currentPositionValueUsd: number;
          }>;
        };
        const pos = posBody.positions.find((p) => p.marketId === "usdc-matured");
        expect(pos).toBeDefined();
        expect(pos!.currentPtBalance).toBe("1000000000");
        expect(pos!.currentYtBalance).toBe("1000000000");
        expect(pos!.currentPositionValueUsd).toBeCloseTo(100, 6);
      } finally {
        await idx.stop();
      }
    });

    it("T2-F7.4: INDEXER_PORT / PORT override resolution and canonical 8765 fallback", async () => {
      expect(resolveHttpPort(undefined)).toBe(CANONICAL_INDEXER_PORT);
      expect(resolveHttpPort("0")).toBe(CANONICAL_INDEXER_PORT);
      expect(resolveHttpPort("abc")).toBe(CANONICAL_INDEXER_PORT);
      expect(resolveHttpPort("65536")).toBe(CANONICAL_INDEXER_PORT);
      expect(resolveHttpPort("49152")).toBe(49152);

      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string" && k !== "INDEXER_PORT" && k !== "PORT") {
          cleanEnv[k] = v;
        }
      }
      const defaultProc = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import { HTTP_PORT } from "./index.ts"; console.log(JSON.stringify({ HTTP_PORT }));',
        ],
        { cwd: INDEXER_DIR, env: cleanEnv, stdout: "pipe", stderr: "pipe" }
      );
      expect(defaultProc.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(defaultProc.stdout).trim())).toEqual({
        HTTP_PORT: CANONICAL_INDEXER_PORT,
      });

      const portProc = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import { HTTP_PORT } from "./index.ts"; console.log(JSON.stringify({ HTTP_PORT }));',
        ],
        {
          cwd: INDEXER_DIR,
          env: { ...cleanEnv, PORT: "49153" },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(portProc.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(portProc.stdout).trim())).toEqual({
        HTTP_PORT: 49153,
      });

      const routeSrc = readFileText("frontend/src/app/api/indexer/[...path]/route.ts");
      expect(routeSrc).toContain("http://127.0.0.1:8765");

      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        expect(idx.port).not.toBe(CANONICAL_INDEXER_PORT);
        const res = await idx.fetch("/health");
        expect(res.status).toBe(200);
      } finally {
        await idx.stop();
      }
    });

    it("T2-F7.5: zero-amount and 1-stroop XLM positions compute finite non-NaN USD values at 0.12", async () => {
      const xlmMarket = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
      const parityMetric: MarketSummaryMetrics = {
        marketId: "xlm-90d",
        status: "ACTIVE",
        daysToMaturity: 80,
        impliedApyPct: 0,
        blendRate: 1.0,
        ptPriceInSy: 1.0,
        tvlSy: 0n,
        tvlUsd: 0,
        ptReserve: 0n,
        syReserve: 0n,
        isMatured: false,
        isLoading: false,
      };

      const makePort = (ptBalance: bigint): LiveUserPortfolio => ({
        address: STROOP_USER,
        accountExists: true,
        xlmBalance: "0",
        usdcBalance: "0",
        usdcTrustlineExists: false,
        syBalance: 0n,
        ptBalance,
        ytBalance: 0n,
        lpBalance: 0n,
        lastIndex: 1_000_000_000n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      });

      const zeroParsed = parseMarketPosition(xlmMarket, makePort(0n), parityMetric);
      expect(zeroParsed.totalValueUsd).toBe(0);
      expect(Number.isFinite(zeroParsed.totalValueUsd)).toBe(true);

      const stroopParsed = parseMarketPosition(xlmMarket, makePort(1n), parityMetric);
      expect(Number.isFinite(stroopParsed.totalValueUsd)).toBe(true);
      expect(stroopParsed.totalValueUsd).toBeGreaterThan(0);
      expect(stroopParsed.totalValueUsd).toBeCloseTo(1e-7 * CANONICAL_XLM_PRICE_USD, 12);

      const nowSec = Math.floor(Date.now() / 1000);
      const idx = await startIndexerHarness({
        secret: TEST_SECRET,
        seed(storage) {
          storage.recordMintPy({
            marketId: "xlm-90d",
            caller: STROOP_USER,
            receiver: STROOP_USER,
            syIn: 1n,
            pyOut: 1n,
            timestamp: nowSec - 60,
            spotPtPrice: 1.0,
          });
        },
      });
      try {
        const emptyRes = await idx.fetch(`/positions?user=${GREENFIELD_USER}`);
        expect(emptyRes.status).toBe(200);
        const emptyBody = (await emptyRes.json()) as {
          count: number;
          summary: { totalCurrentValueUsd: number };
        };
        expect(emptyBody.count).toBe(0);
        expect(emptyBody.summary.totalCurrentValueUsd).toBe(0);

        const stroopRes = await idx.fetch(`/positions?user=${STROOP_USER}`);
        expect(stroopRes.status).toBe(200);
        const stroopBody = (await stroopRes.json()) as {
          positions: Array<{
            marketId: string;
            currentPtBalance: string;
            costBasisUsd: number;
            currentPositionValueUsd: number;
          }>;
        };
        const pos = stroopBody.positions.find((p) => p.marketId === "xlm-90d");
        expect(pos).toBeDefined();
        expect(pos!.currentPtBalance).toBe("1");
        expect(Number.isFinite(pos!.costBasisUsd)).toBe(true);
        expect(Number.isFinite(pos!.currentPositionValueUsd)).toBe(true);
      } finally {
        await idx.stop();
      }
    });
  });

  describe("F8: Zero-Liquidity, Empty-State & Single-Point Boundaries", () => {
    it("T2-F8.1: zero-liquidity on-chain snapshot preserves 0n reserves and $0 TVL without baseline injection", () => {
      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const nowSec = Math.floor(Date.now() / 1000);
      const zeroLiquiditySnap: LiveMarketSnapshot = {
        state: {
          total_pt_reserve: 0n,
          total_sy_reserve: 0n,
          total_lp_supply: 0n,
          scalar_root: 8_000_000_000_000_000_000n,
          initial_anchor: 1_000_000_000_000_000_000n,
          annual_fee_rate: 50_000_000_000_000_000n,
          protocol_fee_bps: 2000n,
          fee_recipient: TEST_USER,
          maturity: BigInt(usdc90d.maturity),
          maturity_index: 0n,
          is_settled: false,
        },
        latestLedger: 123456,
        nowSeconds: nowSec,
        daysToMaturity: 90,
        isMatured: false,
        blendExchangeRate: 1_000_000_000n,
        ammExchangeRateWad: 1_000_000_000_000_000_000n,
        ptPriceInSy: 0.98,
        ytPriceInSy: 0.02,
        impliedFixedApyPct: 0,
        ptTotalSupply: 0n,
        ytTotalSupply: 0n,
        syTotalSupply: 0n,
        ptProportionPct: 50,
      };

      const derived = deriveMetricsFromSnapshot(usdc90d, zeroLiquiditySnap);
      expect(derived.ptReserve).toBe(0n);
      expect(derived.syReserve).toBe(0n);
      expect(derived.tvlSy).toBe(0n);
      expect(derived.tvlUsd).toBe(0);
    });

    it("T2-F8.2: LandingView and SwapCard render honest '--' without hardcoded 8.75%, 0.0214 SY, 8.45%, or 50x when snapshot is null", () => {
      const landingHtml = renderFrontendHtml(
        React.createElement(LandingView, {
          snapshot: null,
          onEnterDesk: () => {},
        })
      );
      expect(landingHtml).toContain("--");
      expect(landingHtml).not.toContain("8.75%");
      expect(landingHtml).not.toContain("0.0214 SY");

      const swapHtml = renderFrontendHtml(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(SwapCard, {
            snapshot: null,
            portfolio: null,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        )
      );
      expect(swapHtml).toContain("--");
      expect(swapHtml).not.toContain("8.45%");
      expect(swapHtml).not.toContain("50x");
    });

    it("T2-F8.3: AnalyticsCard with empty apyHistory or null analytics never fabricates 5.42% sparklines", () => {
      const zeroHtml = renderFrontendHtml(
        React.createElement(AnalyticsCard, {
          analytics: {
            impliedApyPct: 0,
            volume24hUsdc: 0n,
            totalVolumeUsdc: 0n,
            totalTvlUsdc: 0n,
            totalSwapsCount: 0,
            totalTransactionsCount: 0,
            apyHistory: [],
            lastIndexedLedger: 0,
          },
          loading: false,
        })
      );
      expect(zeroHtml).not.toContain("5.42");
      expect(zeroHtml).toContain("Accumulating ledger events...");
      expect(zeroHtml).toContain("0.00%");
      expect(zeroHtml).toContain("$0.00");

      const nullHtml = renderFrontendHtml(
        React.createElement(AnalyticsCard, {
          analytics: null,
          loading: false,
        })
      );
      expect(nullHtml).not.toContain("5.42");
      expect(nullHtml).toContain("--");
    });

    it("T2-F8.4: chart converters and InteractiveYieldChart handle 0-point and 1-point boundaries with zero NaN or Infinity", () => {
      expect(convertToChartDataPoints([])).toEqual([]);
      expect(convertToApyDataPoints([])).toEqual([]);

      const nowSec = Math.floor(Date.now() / 1000);
      const singleRaw: MarketChartPoint = {
        timestamp: nowSec - 60,
        impliedApyPct: 7.25,
        impliedApy: 7.25,
        underlyingApyPct: 4.85,
        underlyingApy: 4.85,
        ptPrice: 0.9825,
        ytPrice: 0.0175,
        volumeUsd: 100,
        tvlUsd: 5000,
      };

      const singleChartPts = convertToChartDataPoints([singleRaw]);
      const singleApyPts = convertToApyDataPoints([singleRaw]);
      expect(singleChartPts.length).toBe(1);
      expect(singleApyPts.length).toBe(1);
      expect(Number.isFinite(singleChartPts[0]!.impliedApy)).toBe(true);
      expect(Number.isFinite(singleApyPts[0]!.apyPct)).toBe(true);

      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      for (const mode of ["yield", "price"] as const) {
        for (const data of [[] as ChartDataPoint[], singleChartPts]) {
          const html = renderFrontendHtml(
            React.createElement(InteractiveYieldChart, {
              market: usdc90d,
              data,
              initialMode: mode,
              snapshot: null,
              analytics: null,
              loading: false,
            })
          );
          expect(html).not.toContain("NaN");
          expect(html).not.toContain("Infinity");
        }
      }
    });

    it("T2-F8.5: fetchMarketChartData returns empty non-synthetic schema when indexer is offline", async () => {
      const closedUrl = await getClosedLocalUrl();
      const res = await fetchMarketChartData({
        market: "usdc-90d",
        indexerApiUrl: closedUrl,
        timeoutMs: 2000,
      });

      expect(res.success).toBe(true);
      expect(res.market).toBe("usdc-90d");
      expect(res.count).toBe(0);
      expect(res.data).toEqual([]);
      expect(res.summary.tvl).toBe(0);
      expect(res.summary.volume24h).toBe(0);
    });
  });
});
