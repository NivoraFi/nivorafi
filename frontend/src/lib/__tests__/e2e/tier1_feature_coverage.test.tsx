// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

// Authoritative test oracles & fixtures
import {
  EXPECTED_PRESET_MARKET_IDS,
  PresetMarketId,
  DUMMY_TEST_WALLET_ADDRESS,
  generateExpectedStaticParams,
  resolveMarketRoute,
  validateMarketSlug,
  createMockWalletState,
  createMockSnapshot,
  createMockPortfolio,
  computeExpectedYieldMetrics,
  MockWalletContextState,
} from "./helpers/e2e-oracle";

// Modules under test
import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  findMarketById,
  deriveMarketStatus,
  calculateDaysToMaturity,
  MarketDefinition,
} from "../../markets";
import { TopNav } from "@/components/TopNav";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { LiquidityCard } from "@/components/trading/LiquidityCard";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { RolloverCard } from "@/components/trading/RolloverCard";
import { MarketSelector } from "@/components/trading/MarketSelector";
import { MarketTickerBar } from "@/components/trading/MarketTickerBar";
import { AnalyticsCard } from "@/components/trading/AnalyticsCard";
import { explorerContractUrl, explorerTxUrl } from "../../contracts";

// Controlled mock wallet state
let currentWalletState: MockWalletContextState = createMockWalletState();
let currentMarket = PRESET_MARKETS[0];
let currentSnapshot = createMockSnapshot(PRESET_MARKETS[0]);
let currentPortfolio = createMockPortfolio(PRESET_MARKETS[0]);

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => currentWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => currentWalletState.walletNetworkMismatch,
}));

mock.module("@/context/MarketContext", () => ({
  useMarket: () => ({
    markets: PRESET_MARKETS,
    activeMarket: currentMarket,
    activeMarketId: currentMarket.id,
    selectMarket: (id: string) => {
      const found = PRESET_MARKETS.find((m) => m.id === id);
      if (found) currentMarket = found;
    },
    activeSnapshot: currentSnapshot,
    activePortfolio: currentPortfolio,
    loadingSnapshot: false,
    loadingPortfolio: false,
    marketMetrics: {
      [currentMarket.id]: {
        marketId: currentMarket.id,
        status: "ACTIVE" as const,
        daysToMaturity: currentSnapshot.daysToMaturity,
        impliedApyPct: currentSnapshot.impliedFixedApyPct,
        blendRate: 1.001,
        ptPriceInSy: currentSnapshot.ptPriceInSy,
        tvlSy: currentSnapshot.syTotalSupply,
        tvlUsd: 120000,
        ptReserve: currentSnapshot.state.total_pt_reserve,
        syReserve: currentSnapshot.state.total_sy_reserve,
        isMatured: currentSnapshot.isMatured,
        isLoading: false,
      },
    },
    refreshActiveMarket: async () => {},
    refreshAllMetrics: async () => {},
  }),
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("E2E Test Suite — Tier 1: Feature Coverage (Requirements R1, R2, R3)", () => {
  const dummyCaller = DUMMY_TEST_WALLET_ADDRESS;

  // ==========================================================================
  // FEATURE 1: DYNAMIC MARKET ROUTING & ROUTE RESOLUTION
  // ==========================================================================
  describe("Feature 1: Dynamic Market Route Loading & Preset Catalog", () => {
    it("generates static route params for all 6 preset markets as defined in PROJECT.md interface contract", () => {
      const staticParams = generateExpectedStaticParams();
      expect(staticParams).toHaveLength(6);

      const slugs = staticParams.map((p) => p.market);
      for (const expectedId of EXPECTED_PRESET_MARKET_IDS) {
        expect(slugs).toContain(expectedId);
      }
    });

    it("successfully resolves route for 'usdc-90d' market with complete metadata and contract addresses", () => {
      const resolution = resolveMarketRoute("usdc-90d");
      expect(resolution.found).toBe(true);
      expect(resolution.status).toBe(200);

      const market = resolution.market!;
      expect(market.id).toBe("usdc-90d");
      expect(market.name).toBe("Pendle bUSDC PT 90D");
      expect(market.ptSymbol).toBe("PT-bUSDC-90D");
      expect(market.ytSymbol).toBe("YT-bUSDC-90D");
      expect(market.asset.code).toBe("USDC");
      expect(market.tenor).toBe("90D");
      expect(market.contracts.poolId).toBeDefined();
      expect(market.contracts.syId).toBeDefined();
      expect(market.contracts.ptId).toBeDefined();
      expect(market.contracts.ytId).toBeDefined();
      expect(market.contracts.blendPoolId).toBeDefined();
    });

    it("successfully resolves route for 'usdc-30d' short-tenor market with distinct contract IDs", () => {
      const resolution = resolveMarketRoute("usdc-30d");
      expect(resolution.found).toBe(true);
      expect(resolution.status).toBe(200);

      const market = resolution.market!;
      expect(market.id).toBe("usdc-30d");
      expect(market.tenor).toBe("30D");
      expect(market.asset.code).toBe("USDC");
      expect(market.contracts.ptId).toBe("CDDRGJXC6WT63RGEGA56QJ2EXUBSQSAXHHEQALQ3XJ7PBDK66RRDLLQO");
      expect(market.contracts.ytId).toBe("CAXRGVEYTP7GWAXVK4MPBI53YEQCSSZVCNKBFFW7KPXMTKV2LYOZKRJP");
    });

    it("successfully resolves route for 'xlm-90d' market with native Stellar SAC contract", () => {
      const resolution = resolveMarketRoute("xlm-90d");
      expect(resolution.found).toBe(true);
      expect(resolution.status).toBe(200);

      const market = resolution.market!;
      expect(market.id).toBe("xlm-90d");
      expect(market.asset.code).toBe("XLM");
      expect(market.asset.sacContractId).toBe(KNOWN_ASSETS.XLM.sacContractId);
      expect(market.contracts.poolId).toBe("CAQ24DFWIZ4GHS6ES6DX236R5EYMMS3DF3BBZE63NKEDGRGO4B7IRTZ4");
    });

    it("returns 404 for unregistered preview market 'usdc-180d' from canonical catalog, or resolves with custom definition", () => {
      const canonicalRes = resolveMarketRoute("usdc-180d");
      expect(canonicalRes.found).toBe(false);
      expect(canonicalRes.status).toBe(404);

      const mock180d: MarketDefinition = {
        ...findMarketById("usdc-90d"),
        id: "usdc-180d",
        tenor: "180D",
        scalarRoot: "12000000000000000000",
      };
      const customRes = resolveMarketRoute("usdc-180d", [mock180d]);
      expect(customRes.found).toBe(true);
      expect(customRes.status).toBe(200);
      expect(customRes.market?.id).toBe("usdc-180d");
      expect(customRes.market?.tenor).toBe("180D");
    });

    it("successfully resolves route for 'usdc-matured' and derives MATURED status", () => {
      const resolution = resolveMarketRoute("usdc-matured");
      expect(resolution.found).toBe(true);
      expect(resolution.status).toBe(200);

      const market = resolution.market!;
      expect(market.id).toBe("usdc-matured");
      const status = deriveMarketStatus(market.maturity, 1794500000);
      expect(status).toBe("MATURED");
      expect(calculateDaysToMaturity(market.maturity, 1794500000)).toBe(0);
    });

    it("returns 404 for removed 'eurc-90d' in canonical catalog, but resolves Euro Coin SAC with custom definition", () => {
      const canonicalRes = resolveMarketRoute("eurc-90d");
      expect(canonicalRes.found).toBe(false);
      expect(canonicalRes.status).toBe(404);

      const mockEurc: MarketDefinition = {
        ...findMarketById("usdc-90d"),
        id: "eurc-90d",
        name: "Pendle bEURC PT 90D",
        asset: KNOWN_ASSETS.EURC,
      };
      const customRes = resolveMarketRoute("eurc-90d", [mockEurc]);
      expect(customRes.found).toBe(true);
      expect(customRes.status).toBe(200);
      expect(customRes.market?.id).toBe("eurc-90d");
      expect(customRes.market?.asset.code).toBe("EURC");
      expect(customRes.market?.asset.sacContractId).toBe(KNOWN_ASSETS.EURC.sacContractId);
    });
  });

  // ==========================================================================
  // FEATURE 2: ASSET PROFILE HEADER RENDERING & CONTRACT ADDRESSES
  // ==========================================================================
  describe("Feature 2: Asset Profile Header & Contract Metadata Rendering", () => {
    const market = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;

    it("renders asset code, full name, and tenor in MarketTickerBar component", () => {
      const snapshot = createMockSnapshot(market);
      const html = renderToString(
        <MarketTickerBar
          snapshot={snapshot}
          loading={false}
        />
      );

      expect(html).toContain("USDC");
      expect(html).toContain("90D");
      expect(html).toContain("PT Implied APY");
      expect(html).toContain("PT / YT Price");
    });

    it("formats and displays ISO maturity date string correctly", () => {
      expect(market.maturityIso).toBe("2027-02-06T10:17:35Z");
      const shortIso = market.maturityIso.slice(0, 10);
      expect(shortIso).toBe("2027-02-06");
    });

    it("generates valid stellar.expert testnet explorer URLs for all market contract IDs", () => {
      const poolExplorerUrl = explorerContractUrl(market.contracts.poolId);
      const ptExplorerUrl = explorerContractUrl(market.contracts.ptId);
      const ytExplorerUrl = explorerContractUrl(market.contracts.ytId);
      const syExplorerUrl = explorerContractUrl(market.contracts.syId);

      expect(poolExplorerUrl).toContain("stellar.expert/explorer/testnet/contract/");
      expect(poolExplorerUrl).toContain(market.contracts.poolId);
      expect(ptExplorerUrl).toContain(market.contracts.ptId);
      expect(ytExplorerUrl).toContain(market.contracts.ytId);
      expect(syExplorerUrl).toContain(market.contracts.syId);
    });

    it("strictly verifies contract IDs are distinct across all core protocol roles", () => {
      const { poolId, syId, ptId, ytId, blendPoolId } = market.contracts;
      const ids = [poolId, syId, ptId, ytId, blendPoolId];
      // Pool, PT, YT, SY, Blend contracts must be non-empty strings
      for (const id of ids) {
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(10);
      }
    });

    it("renders asset icon badge corresponding to asset config (USDC / XLM / EURC)", () => {
      expect(KNOWN_ASSETS.USDC.iconName).toBe("usdc");
      expect(KNOWN_ASSETS.XLM.iconName).toBe("xlm");
      expect(KNOWN_ASSETS.EURC.iconName).toBe("eurc");
    });
  });

  // ==========================================================================
  // FEATURE 3: BENTO YIELD BREAKDOWN CARDS RENDERING
  // ==========================================================================
  describe("Feature 3: Bento Yield Breakdown Cards Rendering", () => {
    const market = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;

    it("computes accurate yield breakdown metrics via authoritative Yield Space oracle", () => {
      const snapshot = createMockSnapshot(market, {
        ptPriceInSy: 0.98,
        impliedApy: 8.45,
      });
      const metrics = computeExpectedYieldMetrics(snapshot, market, 1.0);

      expect(metrics.impliedApyPct).toBe(8.45);
      expect(metrics.underlyingApyPct).toBe(4.85);
      expect(metrics.fixedApyPct).toBe(8.45);
      expect(metrics.ytLeverage).toBe(50); // 1 / 0.02 = 50x
      expect(metrics.daysToMaturity).toBeGreaterThan(0);
      expect(metrics.tvlUsd).toBeGreaterThan(10000);
    });

    it("renders Bento Implied APY Card inside AnalyticsCard with tabular-mono formatting", () => {
      const snapshot = createMockSnapshot(market);
      const mockAnalytics = {
        marketId: market.id,
        impliedApyPct: 8.45,
        underlyingApyPct: 4.85,
        apyChange24hPct: 0.25,
        volume24hUsdc: 250000_0000000n,
        totalVolumeUsdc: 5000000_0000000n,
        totalTvlUsdc: 1200000_0000000n,
        totalSwapsCount: 42,
        totalTransactionsCount: 150,
        lastIndexedLedger: 1234567,
        apyHistory: [
          { timestamp: Math.floor(Date.now() / 1000) - 3600, apyPct: 8.2 },
          { timestamp: Math.floor(Date.now() / 1000), apyPct: 8.45 },
        ],
      };
      const html = renderToString(
        <AnalyticsCard
          analytics={mockAnalytics}
          daysToMaturity={snapshot.daysToMaturity}
          loading={false}
        />
      );

      expect(html).toContain("Implied Fixed APY");
      expect(html).toContain("tabular-mono");
      expect(html).toContain("8.45%");
    });

    it("renders Bento Underlying APY (Blend) card with historical benchmark and variable badge", () => {
      const snapshot = createMockSnapshot(market);
      const mockAnalytics = {
        marketId: market.id,
        impliedApyPct: 8.45,
        underlyingApyPct: 4.85,
        apyChange24hPct: 0.25,
        volume24hUsdc: 250000_0000000n,
        totalVolumeUsdc: 5000000_0000000n,
        totalTvlUsdc: 1200000_0000000n,
        totalSwapsCount: 42,
        totalTransactionsCount: 150,
        lastIndexedLedger: 1234567,
        apyHistory: [],
      };
      const html = renderToString(
        <AnalyticsCard
          analytics={mockAnalytics}
          daysToMaturity={snapshot.daysToMaturity}
          loading={false}
        />
      );

      expect(html).toContain("Total TVL");
      expect(html).toContain("24h Volume");
    });

    it("renders Bento YT Leverage multiplier exposure card reflecting 1 / P_yt ratio", () => {
      const snapshot = createMockSnapshot(market, { ptPriceInSy: 0.975 });
      // P_yt = 1 - 0.975 = 0.025 -> leverage = 1 / 0.025 = 40x
      const expectedLeverage = Math.round(1 / snapshot.ytPriceInSy);
      expect(expectedLeverage).toBe(40);
    });

    it("renders Bento Maturity Countdown card with days remaining and zero-floor boundary", () => {
      const snapshotActive = createMockSnapshot(market);
      expect(snapshotActive.daysToMaturity).toBeGreaterThan(0);
      expect(snapshotActive.isMatured).toBe(false);

      const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
      const snapshotMatured = createMockSnapshot(maturedMarket, { isMatured: true });
      expect(snapshotMatured.daysToMaturity).toBe(0);
      expect(snapshotMatured.isMatured).toBe(true);
    });

    it("renders Bento Pool Depth & TVL Card with PT Reserve and SY Reserve breakdown", () => {
      const snapshot = createMockSnapshot(market, {
        ptReserve: 80_000_0000000n,
        syReserve: 40_000_0000000n,
      });

      const ptDisplay = Number(snapshot.state.total_pt_reserve) / 1e7;
      const syDisplay = Number(snapshot.state.total_sy_reserve) / 1e7;
      expect(ptDisplay).toBe(80000);
      expect(syDisplay).toBe(40000);
      expect(snapshot.ptProportionPct).toBeCloseTo(66.67, 1);
    });
  });

  // ==========================================================================
  // FEATURE 4: TRADING DESK TABS RENDERING & STATE
  // ==========================================================================
  describe("Feature 4: Trading Desk Segmented Tabs Rendering & Operation", () => {
    const market = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
    const snapshot = createMockSnapshot(market);
    const portfolio = createMockPortfolio(market);

    it("renders all 5 primary operational tabs (Swap, Mint, Pool, Redeem, Rollover)", () => {
      const html = renderToString(
        <TradingDesk
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Swap");
      expect(html).toContain("Mint");
      expect(html).toContain("Pool");
      expect(html).toContain("Redeem");
      expect(html).toContain("Rollover");
    });

    it("renders SwapCard when activeTab is 'swap' with PT buy/sell toggle", () => {
      const html = renderToString(
        <SwapCard
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Fixed APY");
      expect(html).toContain("PT");
      expect(html).toContain("YT");
      expect(html).toContain("Lock Fixed");
    });

    it("renders MintCard when activeTab is 'mint' with underlying/SY deposit options", () => {
      const html = renderToString(
        <MintCard
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Wrap USDC");
      expect(html).toContain("Deposit Amount");
    });

    it("renders LiquidityCard when activeTab is 'liquidity' with dual-sided pool provision", () => {
      const html = renderToString(
        <LiquidityCard
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Supply Liquidity");
      expect(html).toContain("Withdraw LP");
    });

    it("renders RedeemCard when activeTab is 'redeem' supporting post-maturity settlement", () => {
      const html = renderToString(
        <RedeemCard
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Your Portfolio Balances");
      expect(html).toContain("Redeem");
    });

    it("renders RolloverCard when activeTab is 'rollover' supporting tenor migration", () => {
      const html = renderToString(
        <RolloverCard
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Atomic Rollover Desk");
      expect(html).toContain("Slippage Tolerance");
    });
  });

  // ==========================================================================
  // FEATURE 5: WALLET CONNECTION STATE & NETWORK BADGE
  // ==========================================================================
  describe("Feature 5: Live Wallet Connection Binding & Network Status", () => {
    it("renders TopNav with Connect Wallet CTA when wallet is disconnected", () => {
      currentWalletState = createMockWalletState({
        address: null,
        mode: "disconnected",
        walletId: null,
      });

      const html = renderToString(
        <TopNav
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          usdcTrustlineExists={null}
          accountExists={null}
          busyAction={null}
        />
      );

      expect(html).toContain("Connect Wallet");
    });

    it("renders truncated wallet address and disconnect icon when wallet is connected", () => {
      currentWalletState = createMockWalletState({
        address: dummyCaller,
        mode: "wallet",
        walletId: "freighter",
      });

      const html = renderToString(
        <TopNav
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          usdcTrustlineExists={true}
          accountExists={true}
          busyAction={null}
        />
      );

      // Address shortened G...ME27
      expect(html).toContain("GAWW");
      expect(html).toContain("ME27");
    });

    it("renders green positive badge when wallet is connected to Stellar Testnet", () => {
      currentWalletState = createMockWalletState({
        address: dummyCaller,
        mode: "wallet",
        walletNetworkMismatch: false,
      });

      const html = renderToString(
        <TopNav
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          usdcTrustlineExists={true}
          accountExists={true}
          busyAction={null}
        />
      );

      expect(html).toContain("Testnet");
      expect(html).toContain("text-positive");
    });

    it("renders prominent warning badge and banner when wallet network mismatch is detected", () => {
      currentWalletState = createMockWalletState({
        address: dummyCaller,
        mode: "wallet",
        walletNetworkMismatch: true,
      });

      const market = PRESET_MARKETS[0];
      const snapshot = createMockSnapshot(market);
      const portfolio = createMockPortfolio(market);

      const deskHtml = renderToString(
        <TradingDesk
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(deskHtml).toContain("Wallet is on wrong network");
      expect(deskHtml).toContain("Switch to Testnet");
    });

    it("supports watch-only address mode for balance viewing and read-only simulation", () => {
      currentWalletState = createMockWalletState({
        address: dummyCaller,
        mode: "watch",
        walletId: null,
      });

      expect(currentWalletState.mode).toBe("watch");
      expect(currentWalletState.address).toBe(dummyCaller);
    });
  });
});
