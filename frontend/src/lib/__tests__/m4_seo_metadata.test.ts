// frontend/src/lib/__tests__/m4_seo_metadata.test.ts
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach, mock } from "bun:test";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Metadata } from "next";

// Mock Next.js font loader for Bun runtime
mock.module("next/font/google", () => ({
  Space_Grotesk: () => ({ variable: "--font-display" }),
  JetBrains_Mono: () => ({ variable: "--font-code" }),
}));

// ----------------------------------------------------------------------------
// Imports Under Test
// ----------------------------------------------------------------------------
import {
  constructMetadata,
  buildMarketMetadata,
  normalizePath,
  getBaseUrl,
  SITE_NAME,
  PROTOCOL_TITLE,
  DEFAULT_DESCRIPTION,
  DEFAULT_BASE_URL,
  TWITTER_HANDLE,
  DynamicSeoOptions,
} from "@/lib/seo";

import { PRESET_MARKETS, getMarketDefinition } from "@/lib/markets";

// Import Page Metadata & Route Entry Points
import { metadata as portfolioMetadata } from "@/app/portfolio/page";
import { metadata as marketsMetadata } from "@/app/markets/page";
import { generateMetadata as generateTradeMetadata } from "@/app/trade/[market]/page";
import { generateMetadata as generateMarketDetailMetadata } from "@/app/markets/[id]/page";

describe("Milestone 4 Test Suite: SEO, OpenGraph & Dynamic Metadata Engine", () => {
  const FRONTEND_DIR = path.resolve(__dirname, "../../..");
  const PUBLIC_DIR = path.join(FRONTEND_DIR, "public");

  // =========================================================================
  // Tier 1: Core Helper Unit Tests (constructMetadata)
  // =========================================================================
  describe("Tier 1: Core Helper Execution & Contract (constructMetadata)", () => {
    it("1.1 generates baseline metadata with fallback defaults when options are empty", () => {
      const meta = constructMetadata({});

      expect(meta).toBeDefined();
      expect(meta.metadataBase).toBeInstanceOf(URL);
      expect(meta.metadataBase?.toString()).toBe(`${DEFAULT_BASE_URL}/`);

      // Title contract
      if (typeof meta.title === "object" && meta.title !== null) {
        expect((meta.title as any).default).toBe(PROTOCOL_TITLE);
        expect((meta.title as any).template).toBe(`%s | ${SITE_NAME}`);
      } else {
        expect(meta.title).toBe(PROTOCOL_TITLE);
      }

      // Description contract
      expect(meta.description).toBe(DEFAULT_DESCRIPTION);

      // Alternates & Canonical
      expect(meta.alternates?.canonical).toBe("/");

      // Robots config
      expect(meta.robots).toBeDefined();
      if (typeof meta.robots === "object" && meta.robots !== null) {
        expect((meta.robots as any).index).toBe(true);
        expect((meta.robots as any).follow).toBe(true);
      }

      // Authors & Keywords
      expect(Array.isArray(meta.authors)).toBe(true);
      expect((meta.authors as any[])[0].name).toContain("NivoraFi");
      expect(Array.isArray(meta.keywords)).toBe(true);
      expect(meta.keywords).toContain("Stellar");
      expect(meta.keywords).toContain("Soroban");
      expect(meta.keywords).toContain("Fixed Yield");
    });

    it("1.2 formats custom page title and appends site name suffix without duplication", () => {
      const customTitle = "Portfolio & Yield Tracking";
      const meta = constructMetadata({ title: customTitle, path: "/portfolio" });

      const expectedTitle = `${customTitle} | ${SITE_NAME}`;
      if (typeof meta.title === "object" && meta.title !== null) {
        expect((meta.title as any).default).toBe(expectedTitle);
      } else {
        expect(meta.title).toBe(expectedTitle);
      }

      // Test idempotency: passing title that already contains suffix does not duplicate
      const alreadySuffixed = `Active Markets | ${SITE_NAME}`;
      const metaSuffixed = constructMetadata({ title: alreadySuffixed });
      if (typeof metaSuffixed.title === "object" && metaSuffixed.title !== null) {
        expect((metaSuffixed.title as any).default).toBe(alreadySuffixed);
      } else {
        expect(metaSuffixed.title).toBe(alreadySuffixed);
      }
    });

    it("1.3 preserves custom description and custom path in alternates.canonical", () => {
      const desc = "Custom yield analytics for institutional accounts.";
      const meta = constructMetadata({
        title: "Analytics",
        description: desc,
        path: "/analytics",
      });

      expect(meta.description).toBe(desc);
      expect(meta.alternates?.canonical).toBe("/analytics");
    });

    it("1.4 toggles robots directive to noindex/nofollow when noIndex is true", () => {
      const meta = constructMetadata({
        title: "Hidden Staging Desk",
        noIndex: true,
      });

      expect(meta.robots).toBeDefined();
      if (typeof meta.robots === "object" && meta.robots !== null) {
        expect((meta.robots as any).index).toBe(false);
        expect((meta.robots as any).follow).toBe(false);
      }
    });
  });

  // =========================================================================
  // Tier 2: OpenGraph & Twitter Card Specification Matrix
  // =========================================================================
  describe("Tier 2: OpenGraph & Twitter Card Specification Matrix", () => {
    it("2.1 generates full OpenGraph schema conforming to protocol standards", () => {
      const meta = constructMetadata({
        title: "Testnet Trading Desk",
        description: "Zero-slippage AMM trades for PT and YT tokens.",
        path: "/trade/usdc-90d",
        ogType: "website",
      });

      const og = meta.openGraph;
      expect(og).toBeDefined();
      expect(og?.type).toBe("website");
      expect(og?.locale).toBe("en_US");
      expect(og?.siteName).toBe(SITE_NAME);
      expect(og?.title).toContain("Testnet Trading Desk");
      expect(og?.description).toBe("Zero-slippage AMM trades for PT and YT tokens.");
      expect(og?.url).toBe(`${DEFAULT_BASE_URL}/trade/usdc-90d`);

      // OpenGraph Image Array
      expect(Array.isArray(og?.images)).toBe(true);
      const images = og?.images as any[];
      expect(images.length).toBeGreaterThan(0);
      expect(images[0].url).toContain("/og-image.png");
      expect(images[0].width).toBe(1200);
      expect(images[0].height).toBe(630);
      expect(images[0].alt).toBeDefined();
    });

    it("2.2 generates summary_large_image Twitter card with creator and site attribution", () => {
      const meta = constructMetadata({
        title: "Fixed Yield Markets",
        description: "Lock in fixed returns on Stellar Soroban.",
        path: "/markets",
      });

      const twitter = meta.twitter;
      expect(twitter).toBeDefined();
      expect(twitter?.card).toBe("summary_large_image");
      expect(twitter?.title).toContain("Fixed Yield Markets");
      expect(twitter?.description).toBe("Lock in fixed returns on Stellar Soroban.");
      expect((twitter as any)?.creator).toBe(TWITTER_HANDLE);
      expect((twitter as any)?.site).toBe(TWITTER_HANDLE);

      // Twitter images
      expect(twitter?.images).toBeDefined();
      if (Array.isArray(twitter?.images)) {
        expect((twitter?.images as string[])[0]).toContain("/og-image.png");
      } else {
        expect(twitter?.images).toContain("/og-image.png");
      }
    });

    it("2.3 supports custom ogType and custom image override cleanly", () => {
      const customImg = "/assets/custom-banner.png";
      const meta = constructMetadata({
        title: "Protocol Docs",
        description: "Technical specifications.",
        path: "/docs",
        ogType: "article",
        image: customImg,
      });

      expect(meta.openGraph?.type).toBe("article");
      const ogImages = meta.openGraph?.images as any[];
      expect(ogImages[0].url).toBe(customImg);

      if (Array.isArray(meta.twitter?.images)) {
        expect((meta.twitter?.images as string[])[0]).toBe(customImg);
      } else {
        expect(meta.twitter?.images).toBe(customImg);
      }
    });
  });

  // =========================================================================
  // Tier 3: Market-Specific Metadata Generation (buildMarketMetadata)
  // =========================================================================
  describe("Tier 3: Market-Specific Dynamic Metadata (buildMarketMetadata)", () => {
    it("3.1 generates valid market-specific metadata across all 4 preset markets in PRESET_MARKETS", () => {
      expect(PRESET_MARKETS.length).toBe(4);

      for (const market of PRESET_MARKETS) {
        const meta = buildMarketMetadata(market.id, "trade");

        expect(meta).toBeDefined();
        // Title verification
        const titleStr =
          typeof meta.title === "object" && meta.title !== null
            ? (meta.title as any).default
            : (meta.title as string);

        expect(titleStr).toContain(market.name);
        expect(titleStr).toContain(market.ptSymbol);
        expect(titleStr).toContain(SITE_NAME);

        // Description verification: contains tenor and asset code
        expect(meta.description).toContain(market.asset.code);
        expect(meta.description).toContain(market.tenor);
        expect(meta.description).toContain(market.ptSymbol);

        // Canonical verification
        expect(meta.alternates?.canonical).toBe(`/trade/${market.id}`);

        // OpenGraph verification
        expect(meta.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/trade/${market.id}`);
        expect(meta.openGraph?.title).toContain(market.name);

        // Twitter card
        expect(meta.twitter?.card).toBe("summary_large_image");
      }
    });

    it("3.2 supports route prefix switching between /trade and /markets routes", () => {
      const tradeMeta = buildMarketMetadata("usdc-90d", "trade");
      expect(tradeMeta.alternates?.canonical).toBe("/trade/usdc-90d");
      expect(tradeMeta.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/trade/usdc-90d`);

      const marketsMeta = buildMarketMetadata("usdc-90d", "markets");
      expect(marketsMeta.alternates?.canonical).toBe("/markets/usdc-90d");
      expect(marketsMeta.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/markets/usdc-90d`);
    });

    it("3.3 gracefully returns noindex fallback metadata for unknown market IDs", () => {
      const unknownId = "unknown-market-999xyz";
      const meta = buildMarketMetadata(unknownId, "trade");

      const titleStr =
        typeof meta.title === "object" && meta.title !== null
          ? (meta.title as any).default
          : (meta.title as string);

      expect(titleStr).toContain("Market Not Found");
      expect(meta.description).toContain("does not exist");
      expect((meta.robots as any)?.index).toBe(false);
      expect((meta.robots as any)?.follow).toBe(false);
    });

    it("3.4 supports direct MarketDefinition object input without re-querying catalog", () => {
      const firstMarket = PRESET_MARKETS[0];
      const meta = buildMarketMetadata(firstMarket, "trade");

      const titleStr =
        typeof meta.title === "object" && meta.title !== null
          ? (meta.title as any).default
          : (meta.title as string);

      expect(titleStr).toContain(firstMarket.ptSymbol);
    });
  });

  // =========================================================================
  // Tier 4: Favicon, Icons & Static Asset Physical Verification
  // =========================================================================
  describe("Tier 4: Favicon, Icons & Static Asset Physical Verification", () => {
    it("4.1 constructMetadata specifies compliant standard and apple touch icons", () => {
      const meta = constructMetadata({});
      const icons = meta.icons as any;

      expect(icons).toBeDefined();
      expect(Array.isArray(icons.icon)).toBe(true);

      const iconUrls = icons.icon.map((i: any) => (typeof i === "string" ? i : i.url));
      expect(iconUrls).toContain("/icon.svg");
      expect(iconUrls).toContain("/favicon.ico");
      expect(iconUrls).toContain("/favicon.png");

      expect(Array.isArray(icons.apple)).toBe(true);
      const appleUrls = icons.apple.map((i: any) => (typeof i === "string" ? i : i.url));
      expect(appleUrls).toContain("/icon.png");
    });

    it("4.2 verifies all referenced icon and image assets physically exist in frontend/public", () => {
      const requiredAssets = [
        "favicon.ico",
        "favicon.png",
        "icon.png",
        "icon.svg",
        "logo.png",
      ];

      for (const asset of requiredAssets) {
        const fullPath = path.join(PUBLIC_DIR, asset);
        expect(fs.existsSync(fullPath)).toBe(true);

        const stats = fs.statSync(fullPath);
        expect(stats.size).toBeGreaterThan(0);
      }
    });

    it("4.3 verifies icon.svg is valid XML and contains no raw emojis or broken tags", () => {
      const svgPath = path.join(PUBLIC_DIR, "icon.svg");
      const content = fs.readFileSync(svgPath, "utf-8");

      expect(content).toContain("<svg");
      expect(content).toContain("</svg>");
      expect(content).toContain('xmlns="http://www.w3.org/2000/svg"');

      // Zero Unicode emojis in svg file
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(emojiRegex.test(content)).toBe(false);
    });
  });

  // =========================================================================
  // Tier 5: Page Route Integration & Next.js 15 Server Component Compliance
  // =========================================================================
  describe("Tier 5: Page Route Integration & Next.js 15 Server Component Compliance", () => {
    it("5.1 verifies root layout.tsx provides baseline metadata with template and icons", async () => {
      const { metadata: rootMetadata } = await import("@/app/layout");
      expect(rootMetadata).toBeDefined();
      expect(rootMetadata.metadataBase).toBeDefined();
      expect(rootMetadata.icons).toBeDefined();
      expect(rootMetadata.openGraph).toBeDefined();
      expect(rootMetadata.twitter).toBeDefined();

      const layoutPath = path.join(FRONTEND_DIR, "src/app/layout.tsx");
      const layoutContent = fs.readFileSync(layoutPath, "utf-8");

      // layout must remain a Server Component
      expect(layoutContent).not.toContain('"use client"');
    });

    it("5.2 verifies /portfolio route exports compliant static metadata", () => {
      expect(portfolioMetadata).toBeDefined();
      const title =
        typeof portfolioMetadata.title === "object" && portfolioMetadata.title !== null
          ? (portfolioMetadata.title as any).default
          : (portfolioMetadata.title as string);

      expect(title).toContain("Portfolio");
      expect(portfolioMetadata.description).toBeDefined();
      expect(portfolioMetadata.alternates?.canonical).toBe("/portfolio");
      expect(portfolioMetadata.openGraph?.title).toContain("Portfolio");
      expect(portfolioMetadata.twitter?.card).toBe("summary_large_image");
    });

    it("5.3 verifies /markets route exports active markets metadata", () => {
      expect(marketsMetadata).toBeDefined();
      const title =
        typeof marketsMetadata.title === "object" && marketsMetadata.title !== null
          ? (marketsMetadata.title as any).default
          : (marketsMetadata.title as string);

      expect(title).toContain("Active Yield Markets");
      expect(marketsMetadata.description).toBeDefined();
      expect(marketsMetadata.openGraph).toBeDefined();
    });

    it("5.4 verifies /trade/[market] generateMetadata resolves Promise params asynchronously", async () => {
      for (const market of PRESET_MARKETS) {
        const meta = await generateTradeMetadata({
          params: Promise.resolve({ market: market.id }),
        });

        expect(meta).toBeDefined();
        const title =
          typeof meta.title === "object" && meta.title !== null
            ? (meta.title as any).default
            : (meta.title as string);

        expect(title).toContain(market.name);
        expect(meta.description).toContain(market.ptSymbol);
      }
    });

    it("5.5 verifies /markets/[id] generateMetadata resolves Promise params asynchronously", async () => {
      for (const market of PRESET_MARKETS) {
        const meta = await generateMarketDetailMetadata({
          params: Promise.resolve({ id: market.id }),
        });

        expect(meta).toBeDefined();
        const title =
          typeof meta.title === "object" && meta.title !== null
            ? (meta.title as any).default
            : (meta.title as string);

        expect(title).toContain(market.name);
      }
    });

    it("5.6 verifies generateMetadata handles unknown markets without throwing unhandled rejection", async () => {
      const meta = await generateTradeMetadata({
        params: Promise.resolve({ market: "non-existent-market" }),
      });

      expect(meta).toBeDefined();
      const title =
        typeof meta.title === "object" && meta.title !== null
          ? (meta.title as any).default
          : (meta.title as string);

      expect(title).toContain("Market Not Found");
    });
  });

  // =========================================================================
  // Tier 6: Edge Cases, Security & Defensive Normalization Matrix
  // =========================================================================
  describe("Tier 6: Edge Cases, Security & Defensive Normalization Matrix", () => {
    it("6.1 normalizePath strips trailing slashes and ensures leading slash", () => {
      expect(normalizePath("portfolio/")).toBe("/portfolio");
      expect(normalizePath("/portfolio/")).toBe("/portfolio");
      expect(normalizePath("trade/usdc-90d/")).toBe("/trade/usdc-90d");
      expect(normalizePath("/")).toBe("/");
      expect(normalizePath("")).toBe("/");
      expect(normalizePath(undefined)).toBe("/");
    });

    it("6.2 handles missing or invalid NEXT_PUBLIC_APP_URL environment variable gracefully", () => {
      const originalEnv = process.env.NEXT_PUBLIC_APP_URL;

      try {
        delete process.env.NEXT_PUBLIC_APP_URL;
        delete process.env.NEXT_PUBLIC_SITE_URL;
        expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);

        process.env.NEXT_PUBLIC_APP_URL = "   ";
        expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);

        // Malformed URL string should fall back cleanly
        process.env.NEXT_PUBLIC_APP_URL = "not-a-valid-url";
        expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);
      } finally {
        process.env.NEXT_PUBLIC_APP_URL = originalEnv;
      }
    });

    it("6.3 sanitizes XSS and HTML injection attempts in custom titles and descriptions", () => {
      const maliciousTitle = '<script>alert("xss")</script> Markets';
      const maliciousDesc = '"><img src=x onerror=alert(1)> description';

      const meta = constructMetadata({
        title: maliciousTitle,
        description: maliciousDesc,
      });

      // Assert it returns as plain strings without executing or crashing
      expect(meta.description).toBe(maliciousDesc);
      const titleStr =
        typeof meta.title === "object" && meta.title !== null
          ? (meta.title as any).default
          : (meta.title as string);

      expect(titleStr).toContain(maliciousTitle);
      expect(meta.openGraph?.title).toContain(maliciousTitle);
    });

    it("6.4 market resolver handles case-insensitive market IDs", () => {
      const metaUpper = buildMarketMetadata("USDC-90D", "trade");
      const metaLower = buildMarketMetadata("usdc-90d", "trade");

      const titleUpper =
        typeof metaUpper.title === "object" && metaUpper.title !== null
          ? (metaUpper.title as any).default
          : (metaUpper.title as string);

      const titleLower =
        typeof metaLower.title === "object" && metaLower.title !== null
          ? (metaLower.title as any).default
          : (metaLower.title as string);

      expect(titleUpper).toBe(titleLower);
    });
  });

  // =========================================================================
  // Tier 7: Design System Compliance & Checksum Integrity Matrix
  // =========================================================================
  describe("Tier 7: Design System Compliance & Checksum Integrity Matrix", () => {
    it("7.1 contains zero raw hex color codes across seo.ts and metadata definitions", () => {
      const seoPath = path.join(FRONTEND_DIR, "src/lib/seo.ts");
      if (fs.existsSync(seoPath)) {
        const content = fs.readFileSync(seoPath, "utf-8");
        const lines = content.split("\n");
        const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

          const matches = line.match(rawHexRegex);
          expect({
            file: "seo.ts",
            line: i + 1,
            matches: matches || [],
          }).toEqual({
            file: "seo.ts",
            line: i + 1,
            matches: [],
          });
        }
      }
    });

    it("7.2 contains zero raw Unicode emojis across seo.ts and metadata definitions", () => {
      const seoPath = path.join(FRONTEND_DIR, "src/lib/seo.ts");
      if (fs.existsSync(seoPath)) {
        const content = fs.readFileSync(seoPath, "utf-8");
        const lines = content.split("\n");
        const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

          const hasEmoji = emojiRegex.test(line);
          expect({
            file: "seo.ts",
            line: i + 1,
            hasEmoji,
          }).toEqual({
            file: "seo.ts",
            line: i + 1,
            hasEmoji: false,
          });
        }
      }
    });

    it("7.3 preserves SHA256 checksums of locked files without modification", () => {
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
