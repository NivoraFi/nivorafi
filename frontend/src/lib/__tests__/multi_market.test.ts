// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  deriveMarketStatus,
  calculateDaysToMaturity,
  filterMarkets,
  getTopYieldMarket,
  findMarketById,
  getDefaultMarket,
  MarketDefinition,
  MarketSummaryMetrics,
} from "../markets";

describe("Milestone M5 — Feature #17: Multi-Market Catalog & Selector Test Suite", () => {
  describe("1. Multi-Market Catalog & Structural Validity", () => {
    it("contains preset markets covering 30D and 90D tenors and USDC and XLM assets", () => {
      expect(PRESET_MARKETS.length).toBe(4);

      const tenors = new Set(PRESET_MARKETS.map((m) => m.tenor));
      expect(tenors.has("30D")).toBe(true);
      expect(tenors.has("90D")).toBe(true);

      const assets = new Set(PRESET_MARKETS.map((m) => m.asset.code));
      expect(assets.has("USDC")).toBe(true);
      expect(assets.has("XLM")).toBe(true);
    });

    it("verifies canonical Testnet USDC 90D market integrity against deployed contracts", () => {
      const liveMarket = PRESET_MARKETS.find((m) => m.id === "usdc-90d");
      expect(liveMarket).toBeDefined();
      if (!liveMarket) return;

      expect(liveMarket.asset.code).toBe("USDC");
      expect(liveMarket.asset.decimals).toBe(7);
      expect(liveMarket.isVerifiedTestnet).toBe(true);
      expect(liveMarket.maturity).toBe(1801909055);
      expect(liveMarket.contracts.poolId).toBe(
        "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF"
      );
      expect(liveMarket.contracts.syId).toBe(
        "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5"
      );
      expect(liveMarket.contracts.ptId).toBe(
        "CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A"
      );
      expect(liveMarket.contracts.ytId).toBe(
        "CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73"
      );
    });

    it("includes a matured pool definition for post-maturity settlement and rollover testing", () => {
      const matured = PRESET_MARKETS.find((m) => m.id === "usdc-matured");
      expect(matured).toBeDefined();
      if (!matured) return;

      const now = Math.floor(Date.now() / 1000);
      expect(matured.maturity).toBeLessThan(now);
      expect(deriveMarketStatus(matured.maturity, now)).toBe("MATURED");
    });

    it("validates all registered assets have non-empty SAC contracts and symbol names", () => {
      for (const assetKey of ["USDC", "XLM", "EURC"] as const) {
        const asset = KNOWN_ASSETS[assetKey];
        expect(asset.code).toBe(assetKey);
        expect(asset.sacContractId.length).toBeGreaterThan(20);
        expect(asset.decimals).toBe(7);
      }
    });
  });

  describe("2. Temporal Status & Days to Maturity Invariants", () => {
    const maturity = 1800000000;

    it("derives ACTIVE status strictly when now < maturity", () => {
      expect(deriveMarketStatus(maturity, maturity - 1000)).toBe("ACTIVE");
      expect(deriveMarketStatus(maturity, maturity - 1)).toBe("ACTIVE");
    });

    it("derives MATURED status at exact maturity boundary (now == maturity)", () => {
      expect(deriveMarketStatus(maturity, maturity)).toBe("MATURED");
    });

    it("derives MATURED status when now > maturity", () => {
      expect(deriveMarketStatus(maturity, maturity + 1)).toBe("MATURED");
      expect(deriveMarketStatus(maturity, maturity + 86400 * 30)).toBe("MATURED");
    });

    it("computes accurate fractional days remaining until maturity", () => {
      const now = maturity - 86400 * 10; // 10 days before
      expect(calculateDaysToMaturity(maturity, now)).toBeCloseTo(10.0, 5);

      const halfDayBefore = maturity - 43200;
      expect(calculateDaysToMaturity(maturity, halfDayBefore)).toBeCloseTo(0.5, 5);
    });

    it("clamps days remaining strictly to 0.0 when matured", () => {
      expect(calculateDaysToMaturity(maturity, maturity)).toBe(0);
      expect(calculateDaysToMaturity(maturity, maturity + 5000)).toBe(0);
    });
  });

  describe("3. Comparative APY & Top Yield Badge Ranking", () => {
    const mockMarkets: MarketDefinition[] = [
      {
        ...PRESET_MARKETS[0],
        id: "m1",
        maturity: 1800000000,
      },
      {
        ...PRESET_MARKETS[1],
        id: "m2",
        maturity: 1800000000,
      },
      {
        ...PRESET_MARKETS[2],
        id: "m3-matured",
        maturity: 1700000000, // Matured
      },
    ];

    it("correctly identifies the active market with the highest implied APY", () => {
      const now = 1750000000;
      const metrics: Record<string, MarketSummaryMetrics> = {
        m1: {
          marketId: "m1",
          status: "ACTIVE",
          daysToMaturity: 578.7,
          impliedApyPct: 7.25,
          blendRate: 1.001,
          ptPriceInSy: 0.98,
          tvlSy: 100n,
          tvlUsd: 100,
          ptReserve: 50n,
          syReserve: 50n,
          isMatured: false,
          isLoading: false,
        },
        m2: {
          marketId: "m2",
          status: "ACTIVE",
          daysToMaturity: 578.7,
          impliedApyPct: 11.45,
          blendRate: 1.001,
          ptPriceInSy: 0.95,
          tvlSy: 100n,
          tvlUsd: 100,
          ptReserve: 50n,
          syReserve: 50n,
          isMatured: false,
          isLoading: false,
        },
        "m3-matured": {
          marketId: "m3-matured",
          status: "MATURED",
          daysToMaturity: 0,
          impliedApyPct: 99.0, // Should be ignored because market is matured
          blendRate: 1.001,
          ptPriceInSy: 1.0,
          tvlSy: 100n,
          tvlUsd: 100,
          ptReserve: 50n,
          syReserve: 50n,
          isMatured: true,
          isLoading: false,
        },
      };

      const top = getTopYieldMarket(mockMarkets, metrics, now);
      expect(top).toBeDefined();
      expect(top?.id).toBe("m2");
    });

    it("returns null or fallback safely when all markets are matured", () => {
      const maturedOnly: MarketDefinition[] = [
        { ...PRESET_MARKETS[0], id: "m-old", maturity: 1600000000 },
      ];
      const now = 1700000000;
      const top = getTopYieldMarket(maturedOnly, {}, now);
      expect(top).toBeNull();
    });
  });

  describe("4. Market Filtering Engine (Asset, Status, Search)", () => {
    it("filters markets by asset code (USDC, XLM, EURC, ALL)", () => {
      const usdcOnly = filterMarkets(PRESET_MARKETS, "USDC", "ALL");
      expect(usdcOnly.every((m) => m.asset.code === "USDC")).toBe(true);
      expect(usdcOnly.length).toBeGreaterThanOrEqual(3);

      const xlmOnly = filterMarkets(PRESET_MARKETS, "XLM", "ALL");
      expect(xlmOnly.every((m) => m.asset.code === "XLM")).toBe(true);
      expect(xlmOnly.length).toBeGreaterThanOrEqual(1);

      const all = filterMarkets(PRESET_MARKETS, "ALL", "ALL");
      expect(all.length).toBe(PRESET_MARKETS.length);
    });

    it("filters markets by temporal status (ACTIVE vs MATURED)", () => {
      const now = Math.floor(Date.now() / 1000);
      const activeOnly = filterMarkets(PRESET_MARKETS, "ALL", "ACTIVE", undefined, now);
      expect(activeOnly.every((m) => m.maturity > now)).toBe(true);

      const maturedOnly = filterMarkets(PRESET_MARKETS, "ALL", "MATURED", undefined, now);
      expect(maturedOnly.every((m) => m.maturity <= now)).toBe(true);
      expect(maturedOnly.some((m) => m.id === "usdc-matured")).toBe(true);
    });

    it("filters markets by combined asset and status intersection", () => {
      const now = Math.floor(Date.now() / 1000);
      const usdcMatured = filterMarkets(PRESET_MARKETS, "USDC", "MATURED", undefined, now);
      expect(usdcMatured.length).toBeGreaterThanOrEqual(1);
      expect(usdcMatured.every((m) => m.asset.code === "USDC" && m.maturity <= now)).toBe(true);
    });

    it("searches across market name, PT symbol, asset, and contract pool ID", () => {
      const byName = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "30D");
      expect(byName.some((m) => m.id === "usdc-30d")).toBe(true);

      const bySymbol = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "PT-bXLM");
      expect(bySymbol.some((m) => m.id === "xlm-90d")).toBe(true);

      const byPool = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "CBOADRSN");
      expect(byPool.length).toBeGreaterThan(0);
    });

    it("returns clean empty array when no market matches search query", () => {
      const none = filterMarkets(PRESET_MARKETS, "ALL", "ALL", "nonexistent-crypto-token");
      expect(none).toEqual([]);
    });
  });

  describe("5. Market Switching State & Fallback Resilience", () => {
    it("finds market by valid ID", () => {
      const m = findMarketById("usdc-30d", PRESET_MARKETS);
      expect(m.id).toBe("usdc-30d");
      expect(m.tenor).toBe("30D");
    });

    it("falls back safely to default market when given unknown ID", () => {
      const fallback = findMarketById("unknown-random-market-id", PRESET_MARKETS);
      expect(fallback).toBeDefined();
      expect(fallback.id).toBe(PRESET_MARKETS[0].id);
    });

    it("getDefaultMarket returns the verified testnet USDC 90D market", () => {
      const def = getDefaultMarket();
      expect(def.id).toBe("usdc-90d");
      expect(def.isVerifiedTestnet).toBe(true);
    });
  });
});
