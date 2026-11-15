// frontend/src/lib/__tests__/empirical_challenger_m4_c1.test.ts
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Metadata } from "next";

// Mock Next.js font loader for Bun runtime
mock.module("next/font/google", () => ({
  Space_Grotesk: () => ({ variable: "--font-display" }),
  JetBrains_Mono: () => ({ variable: "--font-code" }),
}));

// Imports Under Test
import {
  constructMetadata,
  buildMarketMetadata,
  buildPageMetadata,
  formatMarketSeoTitle,
  normalizePath,
  getBaseUrl,
  SITE_NAME,
  PROTOCOL_TITLE,
  DEFAULT_DESCRIPTION,
  DEFAULT_BASE_URL,
  TWITTER_HANDLE,
  SITE_CONFIG,
  DEFAULT_ICONS,
  DEFAULT_ROBOTS,
  NO_INDEX_ROBOTS,
} from "@/lib/seo";

import {
  PRESET_MARKETS,
  getMarketDefinition,
  deriveMarketStatus,
  calculateDaysToMaturity,
  type MarketDefinition,
} from "@/lib/markets";

import {
  generateMetadata as generateTradeMetadata,
  generateStaticParams as tradeGenerateStaticParams,
} from "@/app/trade/[market]/page";

import {
  generateMetadata as generateMarketDetailMetadata,
  generateStaticParams as marketsGenerateStaticParams,
} from "@/app/markets/[id]/page";

describe("Empirical Challenger M4.1: Market Routing & Tenor Metadata Challenge Suite", () => {
  const FRONTEND_DIR = path.resolve(__dirname, "../../..");

  // =========================================================================
  // Suite 1: Canonical Markets Metadata Matrix
  // =========================================================================
  describe("Suite 1: Canonical Markets Metadata Matrix (PRESET_MARKETS)", () => {
    const canonicalIds = [
      "usdc-90d",
      "usdc-30d",
      "xlm-90d",
      "usdc-matured",
    ] as const;

    it("1.1 verifies PRESET_MARKETS contains exactly the 4 required canonical markets", () => {
      expect(PRESET_MARKETS.length).toBe(4);
      const ids = PRESET_MARKETS.map((m) => m.id);
      for (const requiredId of canonicalIds) {
        expect(ids).toContain(requiredId);
      }
    });

    it("1.2 verifies buildMarketMetadata generates compliant metadata for each canonical market in trade mode", () => {
      for (const marketId of canonicalIds) {
        const market = getMarketDefinition(marketId);
        expect(market).toBeDefined();
        if (!market) continue;

        const meta = buildMarketMetadata(marketId, "trade");

        expect(meta).toBeDefined();
        expect(meta.metadataBase).toBeInstanceOf(URL);
        expect(meta.metadataBase?.toString()).toBe(`${DEFAULT_BASE_URL}/`);

        // Title checks
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(titleStr).toBeDefined();
        expect(titleStr).toContain(market.name);
        expect(titleStr).toContain(market.ptSymbol);
        expect(titleStr).toContain(SITE_NAME);

        // Description checks
        expect(meta.description).toBeDefined();
        expect(meta.description).toContain(market.asset.code);
        expect(meta.description).toContain(market.tenor);
        expect(meta.description).toContain(market.ptSymbol);

        // Canonical URL
        expect(meta.alternates?.canonical).toBe(`/trade/${market.id}`);

        // Robots
        expect((meta.robots as any)?.index).toBe(true);
        expect((meta.robots as any)?.follow).toBe(true);

        // OpenGraph
        const og = meta.openGraph;
        expect(og).toBeDefined();
        expect(og?.type).toBe("website");
        expect(og?.locale).toBe("en_US");
        expect(og?.siteName).toBe(SITE_NAME);
        expect(og?.url).toBe(`${DEFAULT_BASE_URL}/trade/${market.id}`);
        expect(og?.title).toBe(`${market.name} | Fixed Yield Desk`);
        expect(og?.description).toContain(market.tenor);
        expect(og?.description).toContain(market.asset.code);
        expect(Array.isArray(og?.images)).toBe(true);
        expect((og?.images as any[])[0].url).toBe("/og-image.png");
        expect((og?.images as any[])[0].alt).toBe(`${market.name} Fixed Yield`);

        // Twitter Card
        const twitter = meta.twitter;
        expect(twitter).toBeDefined();
        expect(twitter?.card).toBe("summary_large_image");
        expect(twitter?.creator).toBe(TWITTER_HANDLE);
        expect(twitter?.site).toBe(TWITTER_HANDLE);
        expect(twitter?.title).toContain(market.tenor);
        expect(twitter?.title).toContain(SITE_NAME);
      }
    });

    it("1.3 verifies buildMarketMetadata produces identical output when passed MarketDefinition object vs string ID", () => {
      for (const market of PRESET_MARKETS) {
        const fromString = buildMarketMetadata(market.id, "trade");
        const fromObject = buildMarketMetadata(market, "trade");

        expect(fromString.title).toBe(fromObject.title);
        expect(fromString.description).toBe(fromObject.description);
        expect(fromString.alternates?.canonical).toBe(fromObject.alternates?.canonical);
        expect(fromString.openGraph?.title).toBe(fromObject.openGraph?.title);
        expect(fromString.openGraph?.url).toBe(fromObject.openGraph?.url);
        expect(fromString.twitter?.title).toBe(fromObject.twitter?.title);
      }
    });
  });

  // =========================================================================
  // Suite 2: Matured Market Metadata & Tenor Edge Cases
  // =========================================================================
  describe("Suite 2: Matured Market Metadata & Tenor Edge Cases", () => {
    it("2.1 verifies usdc-matured is recognized as MATURED and daysToMaturity is 0", () => {
      const maturedMarket = getMarketDefinition("usdc-matured");
      expect(maturedMarket).toBeDefined();
      if (!maturedMarket) return;

      expect(maturedMarket.maturity).toBe(1794455723);
      const status = deriveMarketStatus(maturedMarket.maturity);
      expect(status).toBe("MATURED");

      const days = calculateDaysToMaturity(maturedMarket.maturity);
      expect(days).toBe(0);
    });

    it("2.2 verifies matured market metadata explicitly states 'Matured' in title and OpenGraph without breaking", () => {
      const meta = buildMarketMetadata("usdc-matured", "trade");

      const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
      expect(titleStr).toBeDefined();
      expect(titleStr).toContain("Matured");
      expect(titleStr).toContain("PT-bUSDC-MAT");
      expect(titleStr).toBe("Pendle bUSDC PT (Matured) (PT-bUSDC-MAT) | NivoraFi");

      // OpenGraph title includes Matured
      expect(meta.openGraph?.title).toContain("Matured");
      expect(meta.openGraph?.title).toBe("Pendle bUSDC PT (Matured) | Fixed Yield Desk");

      // OpenGraph image alt includes Matured
      const ogImages = meta.openGraph?.images as any[];
      expect(ogImages[0].alt).toContain("Matured");

      // No NaN, undefined, or broken strings
      expect(titleStr).not.toContain("undefined");
      expect(titleStr).not.toContain("NaN");
      expect(meta.description).not.toContain("undefined");
      expect(meta.description).not.toContain("NaN");
    });

    it("2.3 verifies matured market metadata in /markets mode explicitly includes ISO maturity date", () => {
      const meta = buildMarketMetadata("usdc-matured", "markets");

      const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
      expect(titleStr).toContain("Matured");
      expect(titleStr).toBe("Pendle bUSDC PT (Matured) | Market Profile | NivoraFi");

      expect(meta.description).toContain("2026-11-12T03:55:23Z");
      expect(meta.openGraph?.description).toContain("2026-11-12T03:55:23Z");
    });

    it("2.4 stress-tests synthetic post-maturity market with extreme past timestamp and custom tenor", () => {
      const syntheticMatured: MarketDefinition = {
        ...PRESET_MARKETS[0],
        id: "synthetic-matured-zero",
        name: "Synthetic Settled Market",
        ptSymbol: "PT-SETTLED",
        tenor: "CUSTOM",
        maturity: 0, // Unix epoch
        maturityIso: "1970-01-01T00:00:00Z",
      };

      const meta = buildMarketMetadata(syntheticMatured, "trade");
      expect(meta).toBeDefined();
      const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
      expect(titleStr).toContain("Synthetic Settled Market");
      expect(titleStr).toContain("PT-SETTLED");
      expect(meta.alternates?.canonical).toBe("/trade/synthetic-matured-zero");
      expect(meta.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/trade/synthetic-matured-zero`);
    });
  });

  // =========================================================================
  // Suite 3: Non-Canonical & Arbitrary Market Slugs (Security & 404 Guard)
  // =========================================================================
  describe("Suite 3: Non-Canonical & Arbitrary Market Slugs", () => {
    const arbitrarySlugs = [
      "btc-365d",
      "eth-7d",
      "sol-90d",
      "unknown-xyz",
      "random-token-1234",
      "usdc-9999d",
      "non-existent-market",
    ];

    it("3.1 returns safe noindex/nofollow 404 fallback for arbitrary unlisted market slugs", () => {
      for (const slug of arbitrarySlugs) {
        const meta = buildMarketMetadata(slug, "trade");

        expect(meta).toBeDefined();
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(titleStr).toBe("Market Not Found | NivoraFi");
        expect(meta.description).toBe("The requested yield market does not exist on this NivoraFi node.");

        // Must enforce noindex/nofollow to avoid poisoning search indexes
        expect((meta.robots as any)?.index).toBe(false);
        expect((meta.robots as any)?.follow).toBe(false);
        expect((meta.robots as any)?.nocache).toBe(true);
      }
    });

    it("3.2 handles empty string, pure whitespace, and tabs without throwing or crashing", () => {
      const emptyLikeSlugs = ["", " ", "   ", "\t", "\n", "\r\n", "   \t  "];

      for (const emptySlug of emptyLikeSlugs) {
        const meta = buildMarketMetadata(emptySlug, "trade");

        expect(meta).toBeDefined();
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(titleStr).toBe("Market Not Found | NivoraFi");
        expect((meta.robots as any)?.index).toBe(false);
      }
    });

    it("3.3 handles null and undefined inputs gracefully with fallback metadata", () => {
      const metaNull = buildMarketMetadata(null as any, "trade");
      expect(metaNull).toBeDefined();
      expect(metaNull.title).toBe("Market Not Found | NivoraFi");

      const metaUndefined = buildMarketMetadata(undefined, "trade");
      expect(metaUndefined).toBeDefined();
      expect(metaUndefined.title).toBe("Market Not Found | NivoraFi");
    });

    it("3.4 safely handles path traversal and code injection attacks in market slugs", () => {
      const adversarialSlugs = [
        "../../../etc/passwd",
        "<script>alert('xss')</script>",
        "usdc-90d'; DROP TABLE markets;--",
        "{{constructor.constructor('alert(1)')()}}",
        "https://evil.com/phishing",
      ];

      for (const slug of adversarialSlugs) {
        const meta = buildMarketMetadata(slug, "trade");
        expect(meta).toBeDefined();
        // None of these should resolve to a valid market
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(titleStr).toBe("Market Not Found | NivoraFi");
        expect((meta.robots as any)?.index).toBe(false);
      }
    });
  });

  // =========================================================================
  // Suite 4: Case-Insensitivity & Parameter Normalization
  // =========================================================================
  describe("Suite 4: Case-Insensitivity & Normalization Matrix", () => {
    it("4.1 resolves uppercase and mixed-case market slugs identically to canonical lowercase", () => {
      const testCases = [
        { raw: "USDC-90D", canonical: "usdc-90d" },
        { raw: "Xlm-90d", canonical: "xlm-90d" },
        { raw: "XLM-90D", canonical: "xlm-90d" },
        { raw: "uSDC-30d", canonical: "usdc-30d" },
        { raw: "USDC-30D", canonical: "usdc-30d" },
        { raw: "USDC-MATURED", canonical: "usdc-matured" },
        { raw: "Usdc-Matured", canonical: "usdc-matured" },
      ];

      for (const { raw, canonical } of testCases) {
        const def = getMarketDefinition(raw);
        expect(def).toBeDefined();
        expect(def?.id).toBe(canonical);

        const metaRaw = buildMarketMetadata(raw, "trade");
        const metaCanonical = buildMarketMetadata(canonical, "trade");

        expect(metaRaw.title).toBe(metaCanonical.title);
        expect(metaRaw.description).toBe(metaCanonical.description);
        expect(metaRaw.openGraph?.title).toBe(metaCanonical.openGraph?.title);

        // Canonical URL must ALWAYS point to lowercase canonical path, never uppercase
        expect(metaRaw.alternates?.canonical).toBe(`/trade/${canonical}`);
        expect(metaRaw.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/trade/${canonical}`);
      }
    });

    it("4.2 handles surrounding whitespace and newlines in market slugs cleanly", () => {
      const whitespaceSlugs = [
        { input: "  usdc-90d  ", canonical: "usdc-90d" },
        { input: "\tusdc-30d\t", canonical: "usdc-30d" },
        { input: " \n xlm-90d \n ", canonical: "xlm-90d" },
      ];

      for (const { input, canonical } of whitespaceSlugs) {
        const def = getMarketDefinition(input);
        expect(def).toBeDefined();
        expect(def?.id).toBe(canonical);

        const meta = buildMarketMetadata(input, "trade");
        expect(meta.alternates?.canonical).toBe(`/trade/${canonical}`);
      }
    });
  });

  // =========================================================================
  // Suite 5: Route Prefix Switching & Mode Matrix
  // =========================================================================
  describe("Suite 5: Route Prefix Switching & Mode Matrix", () => {
    it("5.1 switches canonical path and OpenGraph URL correctly between /trade and /markets", () => {
      const marketId = "usdc-90d";

      const tradeMeta = buildMarketMetadata(marketId, "trade");
      expect(tradeMeta.alternates?.canonical).toBe("/trade/usdc-90d");
      expect(tradeMeta.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/trade/usdc-90d`);
      expect(tradeMeta.openGraph?.title).toBe("Pendle bUSDC PT 90D | Fixed Yield Desk");

      const marketsMeta = buildMarketMetadata(marketId, "markets");
      expect(marketsMeta.alternates?.canonical).toBe("/markets/usdc-90d");
      expect(marketsMeta.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/markets/usdc-90d`);
      expect(marketsMeta.openGraph?.title).toBe("Pendle bUSDC PT 90D | Market Profile");
    });

    it("5.2 differentiates titles and descriptions between trade mode and profile mode", () => {
      const tradeMeta = buildMarketMetadata("xlm-90d", "trade");
      const profileMeta = buildMarketMetadata("xlm-90d", "markets");

      const tradeTitle = typeof tradeMeta.title === "string" ? tradeMeta.title : (tradeMeta.title as any)?.default;
      const profileTitle = typeof profileMeta.title === "string" ? profileMeta.title : (profileMeta.title as any)?.default;

      expect(tradeTitle).toContain("PT-bXLM-90D");
      expect(profileTitle).toContain("Market Profile");
      expect(tradeTitle).not.toBe(profileTitle);

      expect(tradeMeta.description).toContain("Trade discounted Principal Tokens");
      expect(profileMeta.description).toContain("Detailed market parameters, yield curves");
    });

    it("5.3 supports options object configuration with routePrefix and custom path override", () => {
      const customMeta = buildMarketMetadata("usdc-90d", {
        routePrefix: "markets",
        path: "/custom-desk/usdc-90d",
        customImage: "/banners/usdc.png",
      });

      expect(customMeta.alternates?.canonical).toBe("/custom-desk/usdc-90d");
      expect(customMeta.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/custom-desk/usdc-90d`);
      const ogImages = customMeta.openGraph?.images as any[];
      expect(ogImages[0].url).toBe("/banners/usdc.png");
    });

    it("5.4 verifies formatMarketSeoTitle short vs full formats", () => {
      const market = PRESET_MARKETS[0]; // usdc-90d
      const fullTitle = formatMarketSeoTitle(market, "full", "trade");
      const shortTitle = formatMarketSeoTitle(market, "short", "trade");
      const profileTitle = formatMarketSeoTitle(market, "full", "markets");

      expect(fullTitle).toBe("Pendle bUSDC PT 90D (PT-bUSDC-90D) | NivoraFi");
      expect(shortTitle).toBe("Trade bUSDC 90D | NivoraFi");
      expect(profileTitle).toBe("Pendle bUSDC PT 90D | Market Profile | NivoraFi");
    });
  });

  // =========================================================================
  // Suite 6: Next.js 15 Async Route Lifecycle & Static Params Bijectivity
  // =========================================================================
  describe("Suite 6: Next.js 15 Async Route Lifecycle & Static Params Bijectivity", () => {
    it("6.1 verifies tradeGenerateStaticParams produces exact bijective mapping to all 4 canonical markets", async () => {
      const staticParams = await tradeGenerateStaticParams();
      expect(staticParams.length).toBe(4);
      const slugs = staticParams.map((p) => p.market);

      for (const m of PRESET_MARKETS) {
        expect(slugs).toContain(m.id);
      }
    });

    it("6.2 verifies marketsGenerateStaticParams produces exact bijective mapping to all 4 canonical markets", async () => {
      const staticParams = await marketsGenerateStaticParams();
      expect(staticParams.length).toBe(4);
      const ids = staticParams.map((p) => p.id);

      for (const m of PRESET_MARKETS) {
        expect(ids).toContain(m.id);
      }
    });

    it("6.3 verifies generateTradeMetadata resolves Promise params across all static slugs", async () => {
      const staticParams = await tradeGenerateStaticParams();

      for (const { market } of staticParams) {
        const meta = await generateTradeMetadata({
          params: Promise.resolve({ market }),
        });

        expect(meta).toBeDefined();
        expect(meta.alternates?.canonical).toBe(`/trade/${market}`);
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(titleStr).toContain(SITE_NAME);
      }
    });

    it("6.4 verifies generateMarketDetailMetadata resolves Promise params across all static ids", async () => {
      const staticParams = await marketsGenerateStaticParams();

      for (const { id } of staticParams) {
        const meta = await generateMarketDetailMetadata({
          params: Promise.resolve({ id }),
        });

        expect(meta).toBeDefined();
        expect(meta.alternates?.canonical).toBe(`/markets/${id}`);
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(titleStr).toContain("Market Profile");
      }
    });

    it("6.5 verifies generateTradeMetadata and generateMarketDetailMetadata handle non-canonical slugs asynchronously without rejection", async () => {
      const badSlugs = ["btc-365d", "unknown", ""];

      for (const slug of badSlugs) {
        const tradeMeta = await generateTradeMetadata({
          params: Promise.resolve({ market: slug }),
        });
        expect(tradeMeta.title).toBe("Market Not Found | NivoraFi");

        const marketMeta = await generateMarketDetailMetadata({
          params: Promise.resolve({ id: slug }),
        });
        expect(marketMeta.title).toBe("Market Not Found | NivoraFi");
      }
    });
  });

  // =========================================================================
  // Suite 7: Design System Compliance & Checksum Integrity Matrix
  // =========================================================================
  describe("Suite 7: Design System Compliance & Checksum Integrity Matrix", () => {
    it("7.1 verifies zero raw hex colors across src/lib/seo.ts and this test file", () => {
      const testFiles = [
        path.join(FRONTEND_DIR, "src/lib/seo.ts"),
        path.join(FRONTEND_DIR, "src/lib/__tests__/empirical_challenger_m4_c1.test.ts"),
      ];

      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;

      for (const file of testFiles) {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

          const matches = line.match(rawHexRegex);
          expect({
            file: path.basename(file),
            line: i + 1,
            matches: matches || [],
          }).toEqual({
            file: path.basename(file),
            line: i + 1,
            matches: [],
          });
        }
      }
    });

    it("7.2 verifies zero raw Unicode emojis across src/lib/seo.ts and this test file", () => {
      const testFiles = [
        path.join(FRONTEND_DIR, "src/lib/seo.ts"),
        path.join(FRONTEND_DIR, "src/lib/__tests__/empirical_challenger_m4_c1.test.ts"),
      ];

      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

      for (const file of testFiles) {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

          const hasEmoji = emojiRegex.test(line);
          expect({
            file: path.basename(file),
            line: i + 1,
            hasEmoji,
          }).toEqual({
            file: path.basename(file),
            line: i + 1,
            hasEmoji: false,
          });
        }
      }
    });

    it("7.3 verifies locked files SHA256 checksums remain identical to baseline", () => {
      const indexerPath = path.join(FRONTEND_DIR, "src/lib/indexer.ts");
      const hookPath = path.join(FRONTEND_DIR, "src/hooks/useEventIndexer.ts");

      const indexerContent = fs.readFileSync(indexerPath, "utf-8");
      const hookContent = fs.readFileSync(hookPath, "utf-8");

      const indexerHash = crypto.createHash("sha256").update(indexerContent).digest("hex");
      const hookHash = crypto.createHash("sha256").update(hookContent).digest("hex");

      expect(indexerHash).toBe(
        "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c"
      );
      expect(hookHash).toBe(
        "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c"
      );
    });
  });
});
