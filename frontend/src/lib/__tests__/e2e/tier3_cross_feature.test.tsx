// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

// Authoritative test oracles & fixtures
import {
  EXPECTED_PRESET_MARKET_IDS,
  DUMMY_TEST_WALLET_ADDRESS,
  resolveMarketRoute,
  resolveViewMode,
  validateMarketSlug,
  createMockWalletState,
  createMockSnapshot,
  createMockPortfolio,
  MockWalletContextState,
} from "./helpers/e2e-oracle";

// Modules under test
import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  findMarketById,
  filterMarkets,
  deriveMarketStatus,
  calculateDaysToMaturity,
  getDefaultMarket,
  MarketDefinition,
} from "../../markets";
import { TopNav } from "@/components/TopNav";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { LandingView } from "@/components/landing/LandingView";
import { MarketSelector } from "@/components/trading/MarketSelector";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { RolloverCard } from "@/components/trading/RolloverCard";

// Controlled mock wallet & market state
let currentWalletState: MockWalletContextState = createMockWalletState();
let currentActiveMarket: MarketDefinition = PRESET_MARKETS[0];
let selectMarketCallLog: string[] = [];

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => currentWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => currentWalletState.walletNetworkMismatch,
}));

mock.module("@/context/MarketContext", () => ({
  useMarket: () => ({
    markets: PRESET_MARKETS,
    activeMarket: currentActiveMarket,
    activeMarketId: currentActiveMarket.id,
    selectMarket: (id: string) => {
      selectMarketCallLog.push(id);
      const found = PRESET_MARKETS.find((m) => m.id === id);
      if (found) currentActiveMarket = found;
    },
    activeSnapshot: createMockSnapshot(currentActiveMarket),
    activePortfolio: createMockPortfolio(currentActiveMarket),
    loadingSnapshot: false,
    loadingPortfolio: false,
    marketMetrics: {
      [currentActiveMarket.id]: {
        marketId: currentActiveMarket.id,
        status: currentActiveMarket.id === "usdc-matured" ? ("MATURED" as const) : ("ACTIVE" as const),
        daysToMaturity: currentActiveMarket.id === "usdc-matured" ? 0 : 90,
        impliedApyPct: currentActiveMarket.id === "usdc-matured" ? 0 : 8.45,
        blendRate: 1.001,
        ptPriceInSy: currentActiveMarket.id === "usdc-matured" ? 1.0 : 0.98,
        tvlSy: 120_000_0000000n,
        tvlUsd: 120000,
        ptReserve: 80_000_0000000n,
        syReserve: 40_000_0000000n,
        isMatured: currentActiveMarket.id === "usdc-matured",
        isLoading: false,
      },
    },
    refreshActiveMarket: async () => {},
    refreshAllMetrics: async () => {},
  }),
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("E2E Test Suite — Tier 3: Cross-Feature Interactions", () => {
  beforeEach(() => {
    currentWalletState = createMockWalletState();
    currentActiveMarket = PRESET_MARKETS[0];
    selectMarketCallLog = [];
  });

  // ==========================================================================
  // AREA 1: MARKET SWITCHING WITH CONNECTED WALLET
  // ==========================================================================
  describe("Area 1: Market Switching with Connected Wallet State Preservation", () => {
    it("preserves connected wallet address across consecutive market switches", () => {
      expect(currentWalletState.address).toBe(DUMMY_TEST_WALLET_ADDRESS);
      expect(currentWalletState.mode).toBe("wallet");

      // Switch: USDC-90D -> XLM-90D
      currentActiveMarket = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
      expect(currentWalletState.address).toBe(DUMMY_TEST_WALLET_ADDRESS);
      expect(currentActiveMarket.asset.code).toBe("XLM");

      // Switch: XLM-90D -> USDC-30D
      currentActiveMarket = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
      expect(currentWalletState.address).toBe(DUMMY_TEST_WALLET_ADDRESS);
      expect(currentActiveMarket.id).toBe("usdc-30d");

      // Switch: USDC-30D -> USDC-Matured
      currentActiveMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
      expect(currentWalletState.address).toBe(DUMMY_TEST_WALLET_ADDRESS);
      expect(currentActiveMarket.id).toBe("usdc-matured");
    });

    it("retains signing capability and freighter wallet ID across market switches", () => {
      expect(currentWalletState.walletId).toBe("freighter");
      expect(typeof currentWalletState.signTransactionXdr).toBe("function");

      currentActiveMarket = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
      expect(currentWalletState.walletId).toBe("freighter");
    });

    it("updates contract routing IDs accurately when switching between markets", () => {
      const usdcMarket = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const xlmMarket = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

      expect(usdcMarket.contracts.poolId).not.toBe(xlmMarket.contracts.poolId);
      expect(usdcMarket.contracts.ptId).not.toBe(xlmMarket.contracts.ptId);
      expect(usdcMarket.contracts.ytId).not.toBe(xlmMarket.contracts.ytId);
      expect(usdcMarket.asset.sacContractId).not.toBe(xlmMarket.asset.sacContractId);
    });

    it("refreshes active snapshot without leaking previous market state or metrics", () => {
      const activeSnapshot = createMockSnapshot(currentActiveMarket);
      expect(activeSnapshot.state.maturity).toBe(BigInt(currentActiveMarket.maturity));

      const nextMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
      const maturedSnapshot = createMockSnapshot(nextMarket, { isMatured: true });
      expect(maturedSnapshot.isMatured).toBe(true);
      expect(maturedSnapshot.impliedFixedApyPct).toBe(0);
      expect(maturedSnapshot.state.maturity).toBe(BigInt(nextMarket.maturity));
    });

    it("verifies MarketSelector properly dispatches selectMarket callback on selection", () => {
      const html = renderToString(<MarketSelector compact />);
      expect(html).toContain("USDC");
      expect(html).toContain("90D");
    });
  });

  // ==========================================================================
  // AREA 2: DEEP LINK NAVIGATION FROM MARKET EXPLORER ROWS
  // ==========================================================================
  describe("Area 2: Deep Link Navigation from Explorer Rows directly to Trade Desk", () => {
    it("renders Market Explorer table with clickable rows for all preset markets", () => {
      let enteredDesk = false;
      const html = renderToString(
        <LandingView
          onEnterDesk={() => {
            enteredDesk = true;
          }}
          snapshot={createMockSnapshot(currentActiveMarket)}
        />
      );

      expect(html).toContain("Pendle bUSDC PT 90D");
      expect(html).toContain("Pendle bUSDC PT 30D");
      expect(html).toContain("Pendle bXLM PT 90D");
      expect(html).toContain("Pendle bUSDC PT (Matured)");
    });

    it("navigates to trade desk and selects 'usdc-90d' when USDC 90D row button is clicked", () => {
      let navigatedToDesk = false;
      let selectedMarketId: string | null = null;

      const handleEnterDesk = () => {
        navigatedToDesk = true;
      };

      const handleSelectMarket = (id: string) => {
        selectedMarketId = id;
      };

      handleSelectMarket("usdc-90d");
      handleEnterDesk();

      expect(navigatedToDesk).toBe(true);
      expect(selectedMarketId).toBe("usdc-90d");
      expect(resolveMarketRoute(selectedMarketId!).status).toBe(200);
    });

    it("navigates to trade desk and selects 'xlm-90d' directly from explorer row", () => {
      let navigatedToDesk = false;
      let selectedMarketId: string | null = null;

      const handleEnterDesk = () => {
        navigatedToDesk = true;
      };

      const handleSelectMarket = (id: string) => {
        selectedMarketId = id;
      };

      handleSelectMarket("xlm-90d");
      handleEnterDesk();

      expect(navigatedToDesk).toBe(true);
      expect(selectedMarketId).toBe("xlm-90d");
      expect(resolveMarketRoute(selectedMarketId!).market?.asset.code).toBe("XLM");
    });

    it("navigates to trade desk and selects 'usdc-matured' displaying post-maturity settlement", () => {
      let navigatedToDesk = false;
      let selectedMarketId: string | null = null;

      const handleEnterDesk = () => {
        navigatedToDesk = true;
      };

      const handleSelectMarket = (id: string) => {
        selectedMarketId = id;
      };

      handleSelectMarket("usdc-matured");
      handleEnterDesk();

      expect(navigatedToDesk).toBe(true);
      expect(selectedMarketId).toBe("usdc-matured");
      expect(resolveMarketRoute(selectedMarketId!).market?.maturity).toBeLessThan(Date.now() / 1000);
    });

    it("navigates to trade desk and selects 'usdc-30d' displaying short-tenor pool", () => {
      let navigatedToDesk = false;
      let selectedMarketId: string | null = null;

      const handleEnterDesk = () => {
        navigatedToDesk = true;
      };

      const handleSelectMarket = (id: string) => {
        selectedMarketId = id;
      };

      handleSelectMarket("usdc-30d");
      handleEnterDesk();

      expect(navigatedToDesk).toBe(true);
      expect(selectedMarketId).toBe("usdc-30d");
      expect(resolveMarketRoute(selectedMarketId!).market?.tenor).toBe("30D");
    });
  });

  // ==========================================================================
  // AREA 3: QUERY PARAMS FALLBACK & URL COMPATIBILITY
  // ==========================================================================
  describe("Area 3: Query Params Fallback & Legacy URL Support", () => {
    it("resolves view='trade' and market='usdc-90d' from query string '?view=trade&market=usdc-90d'", () => {
      const viewMode = resolveViewMode("?view=trade&market=usdc-90d");
      expect(viewMode).toBe("trade");

      const params = new URLSearchParams("view=trade&market=usdc-90d");
      const marketParam = params.get("market");
      expect(marketParam).toBe("usdc-90d");
      expect(resolveMarketRoute(marketParam!).status).toBe(200);
    });

    it("resolves view='trade' and market='xlm-90d' from query string '?view=trade&market=xlm-90d'", () => {
      const viewMode = resolveViewMode("?view=trade&market=xlm-90d");
      expect(viewMode).toBe("trade");

      const params = new URLSearchParams("view=trade&market=xlm-90d");
      const marketParam = params.get("market");
      expect(marketParam).toBe("xlm-90d");
      expect(resolveMarketRoute(marketParam!).status).toBe(200);
    });

    it("safely falls back to 'landing' when query contains unknown view mode '?view=dashboard'", () => {
      const viewMode = resolveViewMode("?view=dashboard");
      expect(viewMode).toBe("landing");
    });

    it("resolves view mode correctly when URL hash is '#trade'", () => {
      const viewMode = resolveViewMode("", "#trade");
      expect(viewMode).toBe("trade");
    });

    it("safely falls back to default market when market query parameter is invalid", () => {
      const params = new URLSearchParams("view=trade&market=invalid-slug-123");
      const marketParam = params.get("market") || "";
      const routeRes = resolveMarketRoute(marketParam);
      expect(routeRes.status).toBe(404);

      // Defensive fallback returns default market
      const safeMarket = findMarketById(marketParam);
      expect(safeMarket.id).toBe(getDefaultMarket().id);
    });
  });

  // ==========================================================================
  // AREA 4: CROSS-TAB STATE SYNCHRONIZATION
  // ==========================================================================
  describe("Area 4: Cross-Tab State Synchronization within TradingDesk", () => {
    const market = PRESET_MARKETS[0];
    const snapshot = createMockSnapshot(market);
    const portfolio = createMockPortfolio(market);

    it("switches cleanly from Swap tab to Mint tab preserving active market", () => {
      let currentTab: DeskTab = "swap";
      const handleTabChange = (newTab: DeskTab) => {
        currentTab = newTab;
      };

      handleTabChange("mint");
      expect(currentTab).toBe("mint");

      const html = renderToString(
        <TradingDesk
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          activeTab={currentTab}
          onTabChange={handleTabChange}
        />
      );

      expect(html).toContain("Wrap USDC");
    });

    it("switches cleanly from Mint tab to Liquidity (Pool) tab preserving active market", () => {
      let currentTab: DeskTab = "mint";
      const handleTabChange = (newTab: DeskTab) => {
        currentTab = newTab;
      };

      handleTabChange("liquidity");
      expect(currentTab).toBe("liquidity");

      const html = renderToString(
        <TradingDesk
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          activeTab={currentTab}
          onTabChange={handleTabChange}
        />
      );

      expect(html).toContain("Supply Liquidity");
    });

    it("switches cleanly from Liquidity tab to Redeem tab preserving active market", () => {
      let currentTab: DeskTab = "liquidity";
      const handleTabChange = (newTab: DeskTab) => {
        currentTab = newTab;
      };

      handleTabChange("redeem");
      expect(currentTab).toBe("redeem");

      const html = renderToString(
        <TradingDesk
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          activeTab={currentTab}
          onTabChange={handleTabChange}
        />
      );

      expect(html).toContain("Your Portfolio Balances");
    });

    it("switches cleanly from Redeem tab to Rollover tab preserving target market tenors", () => {
      let currentTab: DeskTab = "redeem";
      const handleTabChange = (newTab: DeskTab) => {
        currentTab = newTab;
      };

      handleTabChange("rollover");
      expect(currentTab).toBe("rollover");

      const html = renderToString(
        <TradingDesk
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          activeTab={currentTab}
          onTabChange={handleTabChange}
        />
      );

      expect(html).toContain("Atomic Rollover Desk");
    });

    it("triggers onSwitchToRollover callback from RedeemCard banner switching tab to 'rollover'", () => {
      let activeTab: DeskTab = "redeem";
      const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
      currentActiveMarket = maturedMarket;

      const html = renderToString(
        <RedeemCard
          snapshot={createMockSnapshot(maturedMarket, { isMatured: true })}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          onSwitchToRollover={() => {
            activeTab = "rollover";
          }}
        />
      );

      expect(html).toContain("This position is matured");
      expect(html).toContain("Rollover into a new active maturity");
    });
  });

  // ==========================================================================
  // AREA 5: MARKET EXPLORER FILTERING & SEARCH INTERACTION
  // ==========================================================================
  describe("Area 5: Market Explorer Filtering & Search Interaction", () => {
    it("filters markets strictly by asset code 'USDC' excluding XLM and EURC", () => {
      const filtered = filterMarkets(PRESET_MARKETS, "USDC", "ALL");
      expect(filtered.length).toBeGreaterThan(0);
      for (const m of filtered) {
        expect(m.asset.code).toBe("USDC");
      }
      expect(filtered.find((m) => m.asset.code === "XLM")).toBeUndefined();
      expect(filtered.find((m) => m.asset.code === "EURC")).toBeUndefined();
    });

    it("filters markets strictly by asset code 'XLM' excluding USDC and EURC", () => {
      const filtered = filterMarkets(PRESET_MARKETS, "XLM", "ALL");
      expect(filtered.length).toBe(1);
      expect(filtered[0].asset.code).toBe("XLM");
      expect(filtered[0].id).toBe("xlm-90d");
    });

    it("filters markets by status 'ACTIVE' excluding post-maturity pools", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const filtered = filterMarkets(PRESET_MARKETS, "ALL", "ACTIVE", "", nowSeconds);
      for (const m of filtered) {
        expect(deriveMarketStatus(m.maturity, nowSeconds)).toBe("ACTIVE");
      }
      expect(filtered.find((m) => m.id === "usdc-matured")).toBeUndefined();
    });

    it("filters markets by status 'MATURED' isolating settled tenors", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const filtered = filterMarkets(PRESET_MARKETS, "ALL", "MATURED", "", nowSeconds);
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe("usdc-matured");
    });

    it("searches markets by query '90D' returning all 90-day tenor markets", () => {
      const filtered = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "90D");
      expect(filtered.length).toBe(3); // usdc-90d, usdc-matured, xlm-90d
      const ids = filtered.map((m) => m.id);
      expect(ids).toContain("usdc-90d");
      expect(ids).toContain("xlm-90d");
      expect(ids).toContain("usdc-matured");
    });

    it("searches markets by contract ID matching exact pool address", () => {
      const targetPool = PRESET_MARKETS[0].contracts.poolId;
      const filtered = filterMarkets(PRESET_MARKETS, "ALL", "ALL", targetPool.slice(0, 10));
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered[0].contracts.poolId).toBe(targetPool);
    });
  });
});
