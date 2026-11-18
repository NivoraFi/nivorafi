// e2e_tests/tests/tier1_config_offchain_r2.test.ts
// Tier 1: Opaque-Box Feature Coverage for F6 (Config/Secrets & BFF), F7 (Port 8765, Markets & XLM 0.12), and F8 (Synthetic Removal, TopNav Wiring & Builds)

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_DIR,
  CANONICAL_INDEXER_PORT,
  CANONICAL_USDC_MATURED,
  CANONICAL_XLM_90D,
  CANONICAL_XLM_PRICE_USD,
  DEPLOYED_CONTRACTS_PATH,
  React,
  act,
  callBffGetRaw,
  hasModuleExport,
  invokeBffGet,
  mountFrontendDom,
  readFileText,
  renderFrontendHtml,
  runFrontendBuildOnce,
  runTscCheck,
  scanNextStaticForSecrets,
  scanSourceForIdentifiers,
  startIndexerHarness,
  verifyLockedSha256,
  withBffEnv,
} from "../src/harness/index.ts";
import { ENV } from "@/lib/env";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import {
  PRESET_MARKETS,
  getAssetPriceUsd,
  type MarketSummaryMetrics,
} from "@/lib/markets";
import {
  ASSET_USD_PRICES,
  parseMarketPosition,
} from "@/hooks/useMultiMarketPortfolio";
import type { LiveUserPortfolio } from "@/lib/stellar";
import { InteractiveYieldChart, type ChartDataPoint } from "@/components/token/InteractiveYieldChart";
import { WalletProvider } from "@/context/WalletProvider";
import { MarketProvider } from "@/context/MarketContext";
import { ToastProvider } from "@/context/ToastContext";
import { MarketsPageClient } from "@/app/markets/MarketsPageClient";
import { PoolsPageClient } from "@/app/pools/PoolsPageClient";
import {
  CONTRACT_CATALOG,
  MARKETS,
  resolveHttpPort,
} from "../../indexer/index.ts";
import { buildRegisteredMarkets } from "../../scripts/register_markets.ts";

const TEST_SECRET = "e2e-test-secret-32bytes-hex-0001";
const TEST_USER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const LEAKED_HEX_SECRET =
  "c62f0b839f5d4c81c7d5e75ef60a2d7bb65de9980eb01661195fd45df2a7b4fe";

describe("Tier 1: Offchain Config, BFF, Indexer & Frontend R2 Coverage", () => {
  describe("F6: Secret & Tunnel URL Cleanup + BFF Auth", () => {
    it("T1-F6.1: frontend/.env.production and .env.local are sanitized with placeholders", () => {
      const envProd = readFileText("frontend/.env.production");
      const envLocal = readFileText("frontend/.env.local");

      for (const [name, content] of [
        [".env.production", envProd],
        [".env.local", envLocal],
      ] as const) {
        expect(content, `${name} leaked old hex secret`).not.toContain(LEAKED_HEX_SECRET);
        expect(content, `${name} contains trycloudflare.com`).not.toContain("trycloudflare.com");
        expect(content, `${name} contains VERCEL_OIDC_TOKEN`).not.toContain("VERCEL_OIDC_TOKEN");
        expect(content).toContain('NEXT_PUBLIC_INDEXER_API_URL="/api/indexer"');
        expect(content).toContain('INDEXER_INTERNAL_URL="http://127.0.0.1:8765"');
        expect(content).toContain('INDEXER_API_SECRET="replace_with_32_byte_hex_secret"');
      }
    });

    it("T1-F6.2: public ENV and STELLAR_PENDLE_CONFIG expose zero server secrets or tunnel URLs", () => {
      expect(ENV.indexerApiUrl).toBe("/api/indexer");
      expect(STELLAR_PENDLE_CONFIG.indexerApiUrl).toBe("/api/indexer");
      expect("INDEXER_API_SECRET" in ENV).toBe(false);
      expect("INDEXER_INTERNAL_URL" in ENV).toBe(false);
      expect("indexerApiSecret" in ENV).toBe(false);
      expect("indexerInternalUrl" in ENV).toBe(false);

      const serialized = JSON.stringify(ENV);
      expect(serialized).not.toContain("trycloudflare.com");
      expect(serialized).not.toContain("127.0.0.1");
      expect(serialized).not.toContain(LEAKED_HEX_SECRET);
    });

    it("T1-F6.3: BFF forwards /api/indexer/health with x-indexer-secret to live isolated indexer", async () => {
      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        const res = await invokeBffGet({
          url: "/api/indexer/health",
          indexerInternalUrl: idx.baseUrl,
          indexerApiSecret: idx.secret,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; catalogedContracts: number };
        expect(body.status).toBe("healthy");
        expect(body.catalogedContracts).toBeGreaterThan(0);
      } finally {
        await idx.stop();
      }
    });

    it("T1-F6.4: BFF sets private no-store on /positions and public SWR headers on /stats", async () => {
      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        await withBffEnv(
          {
            indexerInternalUrl: idx.baseUrl,
            indexerApiSecret: idx.secret,
          },
          async () => {
            const [posRes, statsRes] = await Promise.all([
              callBffGetRaw({
                url: `/api/indexer/positions?user=${TEST_USER}`,
              }),
              callBffGetRaw({
                url: "/api/indexer/stats",
              }),
            ]);

            expect(posRes.status).toBe(200);
            expect(posRes.headers.get("cache-control")).toBe("private, no-store");

            expect(statsRes.status).toBe(200);
            expect(statsRes.headers.get("cache-control")).toBe(
              "public, s-maxage=3, stale-while-revalidate=10"
            );
          }
        );
      } finally {
        await idx.stop();
      }
    });

    it(
      "T1-F6.5: production Next.js static client chunks leak zero server secrets or internal URLs",
      async () => {
        const build = await runFrontendBuildOnce();
        expect(build.ok).toBe(true);
        expect(build.exitCode).toBe(0);

        const scan = await scanNextStaticForSecrets();
        expect(scan.filesScanned).toBeGreaterThan(0);
        expect(scan.matches).toEqual([]);
      },
      180_000
    );
  });

  describe("F7: Port 8765, xlm-90d, usdc-matured & XLM 0.12 Sync", () => {
    it("T1-F7.1: canonical indexer port 8765 is aligned across all offchain config, BFF, and scripts", () => {
      expect(resolveHttpPort(undefined)).toBe(CANONICAL_INDEXER_PORT);

      const files = [
        "indexer/index.ts",
        "frontend/src/app/api/indexer/[...path]/route.ts",
        "frontend/.env.example",
        "frontend/.env.production",
        "frontend/.env.local",
        "scripts/verify_charts.ts",
        "scripts/stress_indexer.ts",
      ];

      for (const file of files) {
        const content = readFileText(file);
        expect(content, `${file} should reference 8765`).toContain("8765");
        expect(content, `${file} should not contain stale port 3001`).not.toContain("3001");
      }

      const routeSrc = readFileText("frontend/src/app/api/indexer/[...path]/route.ts");
      expect(routeSrc).toContain("http://127.0.0.1:8765");
    });

    it("T1-F7.2: xlm-90d canonical contract IDs and factoryId 3 match across manifest, frontend, indexer, and scripts", () => {
      const deployed = JSON.parse(readFileSync(DEPLOYED_CONTRACTS_PATH, "utf8")) as {
        markets: Array<{
          id: string;
          factoryId: number;
          maturity: number;
          contracts: {
            pool: string;
            sy: string;
            pt: string;
            yt: string;
            blendPool: string;
          };
        }>;
      };

      const deployedXlm = deployed.markets.find((m) => m.id === "xlm-90d");
      expect(deployedXlm).toBeDefined();
      expect(deployedXlm!.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
      expect(deployedXlm!.maturity).toBe(CANONICAL_XLM_90D.maturity);
      expect(deployedXlm!.contracts.pool).toBe(CANONICAL_XLM_90D.poolId);
      expect(deployedXlm!.contracts.sy).toBe(CANONICAL_XLM_90D.syId);
      expect(deployedXlm!.contracts.pt).toBe(CANONICAL_XLM_90D.ptId);
      expect(deployedXlm!.contracts.yt).toBe(CANONICAL_XLM_90D.ytId);
      expect(deployedXlm!.contracts.blendPool).toBe(CANONICAL_XLM_90D.blendPoolId);

      const frontendXlm = PRESET_MARKETS.find((m) => m.id === "xlm-90d");
      expect(frontendXlm).toBeDefined();
      expect(frontendXlm!.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
      expect(frontendXlm!.maturity).toBe(CANONICAL_XLM_90D.maturity);
      expect(frontendXlm!.contracts.poolId).toBe(CANONICAL_XLM_90D.poolId);
      expect(frontendXlm!.contracts.syId).toBe(CANONICAL_XLM_90D.syId);
      expect(frontendXlm!.contracts.ptId).toBe(CANONICAL_XLM_90D.ptId);
      expect(frontendXlm!.contracts.ytId).toBe(CANONICAL_XLM_90D.ytId);
      expect(frontendXlm!.contracts.blendPoolId).toBe(CANONICAL_XLM_90D.blendPoolId);

      const indexerXlm = MARKETS["xlm-90d"];
      expect(indexerXlm).toBeDefined();
      expect(indexerXlm!.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
      expect(indexerXlm!.maturity).toBe(CANONICAL_XLM_90D.maturity);
      expect(indexerXlm!.poolId).toBe(CANONICAL_XLM_90D.poolId);
      expect(indexerXlm!.syId).toBe(CANONICAL_XLM_90D.syId);
      expect(indexerXlm!.ptId).toBe(CANONICAL_XLM_90D.ptId);
      expect(indexerXlm!.ytId).toBe(CANONICAL_XLM_90D.ytId);
      expect(indexerXlm!.blendPoolId).toBe(CANONICAL_XLM_90D.blendPoolId);

      const catalogIds = new Set(CONTRACT_CATALOG.map((c) => c.id));
      expect(catalogIds.has(CANONICAL_XLM_90D.poolId)).toBe(true);
      expect(catalogIds.has(CANONICAL_XLM_90D.syId)).toBe(true);
      expect(catalogIds.has(CANONICAL_XLM_90D.ptId)).toBe(true);
      expect(catalogIds.has(CANONICAL_XLM_90D.ytId)).toBe(true);

      const scriptXlm = buildRegisteredMarkets().find((m) => m.id === "xlm-90d");
      expect(scriptXlm).toBeDefined();
      expect(scriptXlm!.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
      expect(scriptXlm!.maturity).toBe(CANONICAL_XLM_90D.maturity);
      expect(scriptXlm!.contracts.pool).toBe(CANONICAL_XLM_90D.poolId);
      expect(scriptXlm!.contracts.sy).toBe(CANONICAL_XLM_90D.syId);
      expect(scriptXlm!.contracts.pt).toBe(CANONICAL_XLM_90D.ptId);
      expect(scriptXlm!.contracts.yt).toBe(CANONICAL_XLM_90D.ytId);
    });

    it("T1-F7.3: usdc-matured canonical contract IDs and factoryId 4 exist across manifest, frontend, indexer, and scripts", () => {
      const deployed = JSON.parse(readFileSync(DEPLOYED_CONTRACTS_PATH, "utf8")) as {
        markets: Array<{
          id: string;
          factoryId: number;
          maturity: number;
          contracts: {
            pool: string;
            sy: string;
            pt: string;
            yt: string;
          };
        }>;
      };

      const deployedMat = deployed.markets.find((m) => m.id === "usdc-matured");
      expect(deployedMat).toBeDefined();
      expect(deployedMat!.factoryId).toBe(CANONICAL_USDC_MATURED.factoryId);
      expect(deployedMat!.maturity).toBe(CANONICAL_USDC_MATURED.maturity);
      expect(deployedMat!.contracts.pool).toBe(CANONICAL_USDC_MATURED.poolId);
      expect(deployedMat!.contracts.pt).toBe(CANONICAL_USDC_MATURED.ptId);
      expect(deployedMat!.contracts.yt).toBe(CANONICAL_USDC_MATURED.ytId);

      const frontendMat = PRESET_MARKETS.find((m) => m.id === "usdc-matured");
      expect(frontendMat).toBeDefined();
      expect(frontendMat!.factoryId).toBe(CANONICAL_USDC_MATURED.factoryId);
      expect(frontendMat!.maturity).toBe(CANONICAL_USDC_MATURED.maturity);
      expect(frontendMat!.contracts.poolId).toBe(CANONICAL_USDC_MATURED.poolId);
      expect(frontendMat!.contracts.ptId).toBe(CANONICAL_USDC_MATURED.ptId);
      expect(frontendMat!.contracts.ytId).toBe(CANONICAL_USDC_MATURED.ytId);

      const indexerMat = MARKETS["usdc-matured"];
      expect(indexerMat).toBeDefined();
      expect(indexerMat!.factoryId).toBe(CANONICAL_USDC_MATURED.factoryId);
      expect(indexerMat!.maturity).toBe(CANONICAL_USDC_MATURED.maturity);
      expect(indexerMat!.poolId).toBe(CANONICAL_USDC_MATURED.poolId);
      expect(indexerMat!.ptId).toBe(CANONICAL_USDC_MATURED.ptId);
      expect(indexerMat!.ytId).toBe(CANONICAL_USDC_MATURED.ytId);

      const catalogIds = new Set(CONTRACT_CATALOG.map((c) => c.id));
      expect(catalogIds.has(CANONICAL_USDC_MATURED.poolId)).toBe(true);
      expect(catalogIds.has(CANONICAL_USDC_MATURED.ptId)).toBe(true);
      expect(catalogIds.has(CANONICAL_USDC_MATURED.ytId)).toBe(true);

      const scriptMat = buildRegisteredMarkets().find((m) => m.id === "usdc-matured");
      expect(scriptMat).toBeDefined();
      expect(scriptMat!.factoryId).toBe(CANONICAL_USDC_MATURED.factoryId);
      expect(scriptMat!.maturity).toBe(CANONICAL_USDC_MATURED.maturity);
      expect(scriptMat!.contracts.pool).toBe(CANONICAL_USDC_MATURED.poolId);
      expect(scriptMat!.contracts.pt).toBe(CANONICAL_USDC_MATURED.ptId);
      expect(scriptMat!.contracts.yt).toBe(CANONICAL_USDC_MATURED.ytId);
    });

    it("T1-F7.4: XLM price 0.12 is unified across frontend, portfolio hook, and live indexer positions", async () => {
      expect(getAssetPriceUsd("XLM")).toBe(CANONICAL_XLM_PRICE_USD);
      expect(ASSET_USD_PRICES.XLM).toBe(CANONICAL_XLM_PRICE_USD);
      expect(MARKETS["xlm-90d"]?.assetPriceUsd).toBe(CANONICAL_XLM_PRICE_USD);

      const xlmMarket = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
      const port1000Pt: LiveUserPortfolio = {
        address: TEST_USER,
        accountExists: true,
        xlmBalance: "1000.0000000",
        usdcBalance: "0",
        usdcTrustlineExists: false,
        syBalance: 0n,
        ptBalance: 1000_0000000n,
        ytBalance: 0n,
        lpBalance: 0n,
        lastIndex: 1_000_000_000n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };
      const parityMetric: MarketSummaryMetrics = {
        marketId: "xlm-90d",
        status: "ACTIVE",
        daysToMaturity: 80,
        impliedApyPct: 0,
        blendRate: 1.0,
        ptPriceInSy: 1.0,
        tvlSy: 1000_0000000n,
        tvlUsd: 120,
        ptReserve: 500_0000000n,
        syReserve: 500_0000000n,
        isMatured: false,
        isLoading: false,
      };

      const parsed = parseMarketPosition(xlmMarket, port1000Pt, parityMetric);
      expect(parsed.totalValueUsd).toBeCloseTo(120, 6);

      const nowSec = Math.floor(Date.now() / 1000);
      const idx = await startIndexerHarness({
        secret: TEST_SECRET,
        seed(storage) {
          storage.recordMintPy({
            marketId: "xlm-90d",
            caller: TEST_USER,
            receiver: TEST_USER,
            syIn: 1000_0000000n,
            pyOut: 1000_0000000n,
            timestamp: nowSec - 60,
            spotPtPrice: 0.98,
          });
        },
      });
      try {
        const res = await idx.fetch(`/positions?user=${TEST_USER}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          success: boolean;
          positions: Array<{ marketId: string; costBasisUsd: number }>;
        };
        expect(body.success).toBe(true);
        const pos = body.positions.find((p) => p.marketId === "xlm-90d");
        expect(pos).toBeDefined();
        expect(pos!.costBasisUsd).toBeCloseTo(120, 6);
      } finally {
        await idx.stop();
      }
    });

    it("T1-F7.5: live /charts and /timeseries resolve xlm-90d and usdc-matured by slug and pool contract ID", async () => {
      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        const queries: Array<[string, string]> = [
          ["/charts?market=xlm-90d&interval=1D", "xlm-90d"],
          [`/timeseries?market=${CANONICAL_XLM_90D.poolId}&interval=1D`, "xlm-90d"],
          ["/charts?market=usdc-matured&interval=1D", "usdc-matured"],
          [`/charts?market=${CANONICAL_USDC_MATURED.poolId}&interval=1D`, "usdc-matured"],
        ];

        for (const [pathAndQuery, expectedMarket] of queries) {
          const res = await idx.fetch(pathAndQuery);
          expect(res.status).toBe(200);
          const body = (await res.json()) as { success: boolean; market: string };
          expect(body.success).toBe(true);
          expect(body.market).toBe(expectedMarket);
        }
      } finally {
        await idx.stop();
      }
    });
  });

  describe("F8: Synthetic/Fallback Data Removal, TopNav Wiring & Builds", () => {
    it("T1-F8.1: removed synthetic generators are absent from exports/source and SHA-256 locks hold", async () => {
      expect(await hasModuleExport("frontend/src/lib/indexerAnalytics.ts", "synthesizeFallbackChart")).toBe(
        false
      );
      expect(await hasModuleExport("frontend/src/context/MarketContext.tsx", "buildFallbackSnapshot")).toBe(
        false
      );

      expect(
        scanSourceForIdentifiers("frontend/src/components/trade/TradePageClient.tsx", [
          "impWave",
          "undWave",
        ])
      ).toEqual([]);
      expect(
        scanSourceForIdentifiers("frontend/src/components/trading/AnalyticsCard.tsx", ["5.42"])
      ).toEqual([]);
      expect(
        scanSourceForIdentifiers("frontend/src/lib/analytics.ts", ["5.42"])
      ).toEqual([]);
      expect(
        scanSourceForIdentifiers("frontend/src/context/MarketContext.tsx", ["buildFallbackSnapshot"])
      ).toEqual([]);

      const lockCheck = await verifyLockedSha256();
      expect(lockCheck.ok).toBe(true);
    });

    it("T1-F8.2: InteractiveYieldChart renders honest empty state without fabricated wave curves", () => {
      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const html = renderFrontendHtml(
        React.createElement(InteractiveYieldChart, {
          market: usdc90d,
          data: [],
          snapshot: null,
          analytics: null,
          loading: false,
        })
      );

      expect(html).toContain("No indexed swap events yet");
      expect(html).toContain("--");
      expect(html).not.toContain("8.45%");
      expect(html).not.toContain("5.40%");
      expect(html).not.toContain('stroke-linecap="round"');
    });

    it("T1-F8.3: InteractiveYieldChart passes flat real indexed points through with zero synthetic wave oscillation", () => {
      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const nowSec = Math.floor(Date.now() / 1000);
      const flatPoints: ChartDataPoint[] = [
        { timestamp: nowSec - 7200, impliedApy: 8.1, underlyingApy: 4.85, ptPrice: 0.9805, ytPrice: 0.0195 },
        { timestamp: nowSec - 3600, impliedApy: 8.1, underlyingApy: 4.85, ptPrice: 0.9805, ytPrice: 0.0195 },
        { timestamp: nowSec - 1800, impliedApy: 8.1, underlyingApy: 4.85, ptPrice: 0.9805, ytPrice: 0.0195 },
      ];

      const html = renderFrontendHtml(
        React.createElement(InteractiveYieldChart, {
          market: usdc90d,
          data: flatPoints,
          snapshot: null,
          analytics: null,
          loading: false,
        })
      );

      expect(html).toContain("8.10%");
      expect(html).toContain("4.85%");

      // Extract the Cyan (Implied APY) curve path and verify every Y coordinate equals the initial M Y
      const pathMatch = html.match(/<path d="(M [^"]+)" fill="none" stroke="var\(--accent-signal\)"/);
      expect(pathMatch).not.toBeNull();
      const dAttr = pathMatch![1]!;
      const mMatch = dAttr.match(/^M\s+[-0-9.]+,([-0-9.]+)/);
      expect(mMatch).not.toBeNull();
      const baseY = Number(mMatch![1]);

      const segYs = [...dAttr.matchAll(/C\s+[-0-9.]+,([-0-9.]+)\s+[-0-9.]+,([-0-9.]+)\s+[-0-9.]+,([-0-9.]+)/g)];
      expect(segYs.length).toBeGreaterThan(0);
      for (const m of segYs) {
        expect(Number(m[1])).toBeCloseTo(baseY, 3);
        expect(Number(m[2])).toBeCloseTo(baseY, 3);
        expect(Number(m[3])).toBeCloseTo(baseY, 3);
      }
    });

    it("T1-F8.4: MarketsPageClient and PoolsPageClient wire TopNav callbacks without no-op stubs", async () => {
      for (const file of [
        "frontend/src/app/markets/MarketsPageClient.tsx",
        "frontend/src/app/pools/PoolsPageClient.tsx",
      ]) {
        const forbidden = scanSourceForIdentifiers(file, [
          "onRefresh={() => {}}",
          "onFundXlm={() => {}}",
          "onAddUsdcTrustline={() => {}}",
          "usdcTrustlineExists={true}",
          "accountExists={true}",
        ]);
        expect(forbidden, `${file} contains no-op or hardcoded TopNav props`).toEqual([]);

        for (const required of [
          "refreshAllMetrics",
          "requestFriendbotFunding",
          "prepareChangeTrustUsdcTx",
          "activePortfolio.usdcTrustlineExists",
          "activePortfolio.accountExists",
        ]) {
          expect(
            scanSourceForIdentifiers(file, [required]).length,
            `${file} missing ${required}`
          ).toBeGreaterThan(0);
        }
      }

      // Sequential Happy-DOM interactive test on MarketsPageClient then PoolsPageClient
      const m1 = await mountFrontendDom(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
            null,
            React.createElement(ToastProvider, null, React.createElement(MarketsPageClient))
          )
        )
      );
      try {
        const faucetBtn = m1.container.querySelector(
          'button[title="Get Testnet Assets (Faucet)"]'
        ) as HTMLButtonElement | null;
        expect(faucetBtn).not.toBeNull();
        await act(async () => {
          faucetBtn!.click();
        });
        const dialog = m1.window.document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).toContain("Testnet Asset Faucet");
      } finally {
        await m1.unmount();
      }

      const m2 = await mountFrontendDom(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
            null,
            React.createElement(ToastProvider, null, React.createElement(PoolsPageClient))
          )
        )
      );
      try {
        const faucetBtn = m2.container.querySelector(
          'button[title="Get Testnet Assets (Faucet)"]'
        ) as HTMLButtonElement | null;
        expect(faucetBtn).not.toBeNull();
        await act(async () => {
          faucetBtn!.click();
        });
        const dialog = m2.window.document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).toContain("Testnet Asset Faucet");
      } finally {
        await m2.unmount();
      }
    });

    it(
      "T1-F8.5: indexer tsc, frontend typecheck, and frontend next build all exit 0",
      async () => {
        const indexerTsc = await runTscCheck("indexer");
        expect(indexerTsc.ok).toBe(true);
        expect(indexerTsc.errors).toEqual([]);

        const frontendTsc = await runTscCheck("frontend");
        expect(frontendTsc.ok).toBe(true);
        expect(frontendTsc.errors).toEqual([]);

        // Keep agent typecheck verified as well
        const agentTsc = await runTscCheck(AGENT_DIR);
        expect(agentTsc.ok).toBe(true);

        const buildRes = await runFrontendBuildOnce();
        expect(buildRes.ok).toBe(true);
        expect(buildRes.exitCode).toBe(0);
      },
      180_000
    );
  });
});
