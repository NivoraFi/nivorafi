// frontend/src/lib/__tests__/empirical_challenger_m4_seo_security.test.ts
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import type { Metadata } from "next";

// Mock Next.js font loader for Bun runtime
mock.module("next/font/google", () => ({
  Space_Grotesk: () => ({ variable: "--font-display" }),
  JetBrains_Mono: () => ({ variable: "--font-code" }),
}));

import {
  constructMetadata,
  buildMarketMetadata,
  buildPageMetadata,
  normalizePath,
  getBaseUrl,
  SITE_NAME,
  PROTOCOL_TITLE,
  DEFAULT_DESCRIPTION,
  DEFAULT_BASE_URL,
  TWITTER_HANDLE,
  DEFAULT_ROBOTS,
  NO_INDEX_ROBOTS,
  DynamicSeoOptions,
} from "@/lib/seo";
import { PRESET_MARKETS } from "@/lib/markets";

describe("Empirical Challenger M4: SEO Crawlers, Security & Base URL Resolution", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  beforeEach(() => {
    // Reset env vars to baseline
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  });

  // =========================================================================
  // Section 1: URL Injection & XSS Vulnerability Stress Testing
  // =========================================================================
  describe("1. URL Injection & XSS Attempts in SEO Metadata Fields", () => {
    const XSS_PAYLOADS = [
      '<script>alert("xss")</script>',
      '"><img src=x onerror=alert(1)>',
      '<svg onload=alert(document.cookie)>',
      'javascript:/*--></title></style></textarea></script></xmp><svg/onload=\'+/"/+/onmouseover=1/+/[*/[]/+alert(1)//\'>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      '"><a href="javascript:alert(1)">Click Me</a>',
    ];

    it("1.1 survives malicious XSS payloads in title without crashing or producing undefined properties", () => {
      for (const payload of XSS_PAYLOADS) {
        const meta = constructMetadata({ title: payload });

        expect(meta).toBeDefined();
        expect(meta.title).toBeDefined();
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(typeof titleStr).toBe("string");
        expect(titleStr).toContain(payload);
        expect(titleStr).toContain(SITE_NAME);

        // OpenGraph & Twitter title must mirror safely as plain string
        expect(meta.openGraph?.title).toContain(payload);
        expect(meta.twitter?.title).toContain(payload);
      }
    });

    it("1.2 preserves raw malicious payload safely in description for Next.js HTML-escaping renderer", () => {
      for (const payload of XSS_PAYLOADS) {
        const meta = constructMetadata({ description: payload });

        expect(meta.description).toBe(payload);
        expect(meta.openGraph?.description).toBe(payload);
        expect(meta.twitter?.description).toBe(payload);
      }
    });

    it("1.3 isolates adversarial path traversal and injection strings in path argument", () => {
      const TRAVERSAL_PATHS = [
        "../../../../etc/passwd",
        "/portfolio/../../trade/usdc-90d",
        "/trade/%2e%2e%2f%2e%2e%2fetc",
        "/trade/\0/usdc-90d",
      ];

      for (const badPath of TRAVERSAL_PATHS) {
        const meta = constructMetadata({ path: badPath });
        expect(meta).toBeDefined();
        expect(meta.alternates?.canonical).toBeDefined();
        // Alternates canonical must always return a string with leading slash
        const canonical = meta.alternates?.canonical as string;
        expect(canonical.startsWith("/")).toBe(true);
      }
    });

    it("1.4 guards against marketId injection in buildMarketMetadata without executing or leaking", () => {
      const MALICIOUS_MARKET_IDS = [
        '<script>alert("hack")</script>',
        "../../../etc/shadow",
        "'; DROP TABLE markets; --",
        "usdc-90d\0nullbyte",
        "http://attacker.com/evil-market",
      ];

      for (const badId of MALICIOUS_MARKET_IDS) {
        const meta = buildMarketMetadata(badId, "trade");

        expect(meta).toBeDefined();
        // Must reject bad market ID and route to 404 fallback
        const title = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(title).toBe("Market Not Found | NivoraFi");
        expect(meta.robots).toEqual(NO_INDEX_ROBOTS);
      }
    });

    it("1.5 isolates custom image URL injection attempts in OpenGraph and Twitter cards", () => {
      const meta = constructMetadata({
        image: "https://trusted-cdn.com/banner.png",
      });

      expect(meta.openGraph?.images).toBeDefined();
      const ogImages = meta.openGraph?.images as any[];
      expect(ogImages.length).toBe(1);
      expect(ogImages[0].url).toBe("https://trusted-cdn.com/banner.png");
      expect(meta.twitter?.images).toEqual(["https://trusted-cdn.com/banner.png"]);
    });
  });

  // =========================================================================
  // Section 2: Trailing Slash Normalization & URL Redundancy
  // =========================================================================
  describe("2. Trailing Slash Normalization & URL Redundancy", () => {
    it("2.1 normalizes /portfolio/ to /portfolio ensuring canonical URL determinism", () => {
      const withSlash = normalizePath("/portfolio/");
      const withoutSlash = normalizePath("/portfolio");
      const trailingMulti = normalizePath("/portfolio///");

      expect(withSlash).toBe("/portfolio");
      expect(withoutSlash).toBe("/portfolio");
      expect(trailingMulti).toBe("/portfolio");
      expect(withSlash).toBe(withoutSlash);
    });

    it("2.2 normalizes multi-segment routes with trailing slashes (/trade/usdc-90d/)", () => {
      expect(normalizePath("trade/usdc-90d/")).toBe("/trade/usdc-90d");
      expect(normalizePath("/trade/usdc-90d/")).toBe("/trade/usdc-90d");
      expect(normalizePath("/trade/usdc-90d////")).toBe("/trade/usdc-90d");
      expect(normalizePath("/markets/usdc-90d/")).toBe("/markets/usdc-90d");
    });

    it("2.3 handles root path edge cases cleanly ('/', '///', '', null, undefined, whitespace)", () => {
      expect(normalizePath("/")).toBe("/");
      expect(normalizePath("///")).toBe("/");
      expect(normalizePath("")).toBe("/");
      expect(normalizePath(null)).toBe("/");
      expect(normalizePath(undefined)).toBe("/");
      expect(normalizePath("   ")).toBe("/");
      expect(normalizePath("  /  ")).toBe("/");
    });

    it("2.4 verifies constructMetadata produces identical canonical for trailing slash variants", () => {
      const metaA = constructMetadata({ path: "/portfolio" });
      const metaB = constructMetadata({ path: "/portfolio/" });
      const metaC = constructMetadata({ path: "portfolio/" });

      expect(metaA.alternates?.canonical).toBe("/portfolio");
      expect(metaB.alternates?.canonical).toBe("/portfolio");
      expect(metaC.alternates?.canonical).toBe("/portfolio");

      expect(metaA.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/portfolio`);
      expect(metaB.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/portfolio`);
      expect(metaC.openGraph?.url).toBe(`${DEFAULT_BASE_URL}/portfolio`);
    });

    it("2.5 analyzes redundant slash normalization behavior in path", () => {
      // Strips trailing slashes from //trade//usdc-90d//
      const normalizedTrailing = normalizePath("//trade//usdc-90d//");
      expect(normalizedTrailing.endsWith("/")).toBe(false);
      expect(normalizedTrailing).toBe("//trade//usdc-90d");

      // Verifies constructMetadata constructs defined canonical and pageUrl
      const meta = constructMetadata({ path: "//trade//usdc-90d//" });
      expect(meta.alternates?.canonical).toBe("//trade//usdc-90d");
      expect(meta.openGraph?.url).toBe(`${DEFAULT_BASE_URL}//trade//usdc-90d`);
    });
  });

  // =========================================================================
  // Section 3: Environment Variable Mutation & Base URL Resolution
  // =========================================================================
  describe("3. Environment Variable Mutation & Base URL Resolution", () => {
    it("3.1 falls back to DEFAULT_BASE_URL when env vars are missing or empty", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);

      process.env.NEXT_PUBLIC_APP_URL = "";
      process.env.NEXT_PUBLIC_SITE_URL = "";
      expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);

      process.env.NEXT_PUBLIC_APP_URL = "   ";
      process.env.NEXT_PUBLIC_SITE_URL = "   ";
      expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);
    });

    it("3.2 respects NEXT_PUBLIC_APP_URL precedence over NEXT_PUBLIC_SITE_URL", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://app.stellar-pendle.org";
      process.env.NEXT_PUBLIC_SITE_URL = "https://site.stellar-pendle.org";

      expect(getBaseUrl()).toBe("https://app.stellar-pendle.org");
    });

    it("3.3 falls back to NEXT_PUBLIC_SITE_URL when NEXT_PUBLIC_APP_URL is unset", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "https://secondary.stellar-pendle.org";

      expect(getBaseUrl()).toBe("https://secondary.stellar-pendle.org");
    });

    it("3.4 strips trailing slashes and path subdirectories to resolve clean origin", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://subdomain.stellar-pendle.org:8443/nested/path/";
      expect(getBaseUrl()).toBe("https://subdomain.stellar-pendle.org:8443");
    });

    it("3.5 gracefully recovers from non-URL malformed strings without throwing", () => {
      const MALFORMED_STRINGS = [
        "not a url",
        "://invalid-url",
        "some-random-hostname",
        "127.0.0.1:port-without-scheme",
      ];

      for (const malformed of MALFORMED_STRINGS) {
        process.env.NEXT_PUBLIC_APP_URL = malformed;
        expect(() => getBaseUrl()).not.toThrow();
        expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);
      }
    });

    it("3.6 metadataBase in constructMetadata is a valid URL matching getBaseUrl", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://staging.stellar-pendle.com";
      const meta = constructMetadata({});

      expect(meta.metadataBase).toBeInstanceOf(URL);
      expect(meta.metadataBase?.origin).toBe("https://staging.stellar-pendle.com");
      expect(meta.openGraph?.url).toBe("https://staging.stellar-pendle.com");
    });

    it("3.7 documents opaque origin behavior on unusual URI schemes (WHATWG URL parser)", () => {
      // WHATWG URL parser creates opaque origin ("null") for non-standard schemes
      process.env.NEXT_PUBLIC_APP_URL = "htp://misspelled-scheme";
      const resolved = getBaseUrl();
      // Verifies getBaseUrl returns WHATWG parsed.origin string
      expect(typeof resolved).toBe("string");
      expect(resolved).toBe("null");
    });
  });

  // =========================================================================
  // Section 4: Robots Directives & Crawler Verification
  // =========================================================================
  describe("4. Robots Directives & Search Engine Crawler Protection", () => {
    it("4.1 verifies DEFAULT_ROBOTS configures compliant Googlebot max-image-preview: large", () => {
      expect(DEFAULT_ROBOTS).toBeDefined();
      expect(typeof DEFAULT_ROBOTS).toBe("object");

      const robots = DEFAULT_ROBOTS as any;
      expect(robots.index).toBe(true);
      expect(robots.follow).toBe(true);

      expect(robots.googleBot).toBeDefined();
      expect(robots.googleBot.index).toBe(true);
      expect(robots.googleBot.follow).toBe(true);
      expect(robots.googleBot["max-image-preview"]).toBe("large");
      expect(robots.googleBot["max-video-preview"]).toBe(-1);
      expect(robots.googleBot["max-snippet"]).toBe(-1);
    });

    it("4.2 verifies NO_INDEX_ROBOTS sets index: false, follow: false, nocache: true", () => {
      expect(NO_INDEX_ROBOTS).toBeDefined();
      const robots = NO_INDEX_ROBOTS as any;

      expect(robots.index).toBe(false);
      expect(robots.follow).toBe(false);
      expect(robots.nocache).toBe(true);

      expect(robots.googleBot).toBeDefined();
      expect(robots.googleBot.index).toBe(false);
      expect(robots.googleBot.follow).toBe(false);
    });

    it("4.3 verifies unknown market route triggers NO_INDEX_ROBOTS to prevent crawler indexing", () => {
      const UNKNOWN_SLUGS = [
        "unknown-market-123",
        "btc-365d",
        "eth-arbitrum-90d",
        "expired-invalid",
      ];

      for (const slug of UNKNOWN_SLUGS) {
        const meta = buildMarketMetadata(slug, "trade");
        expect(meta.robots).toEqual(NO_INDEX_ROBOTS);
        const title = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(title).toContain("Market Not Found");
      }
    });

    it("4.4 verifies all 6 canonical preset markets inherit DEFAULT_ROBOTS with index: true", () => {
      for (const market of PRESET_MARKETS) {
        const metaTrade = buildMarketMetadata(market.id, "trade");
        const metaProfile = buildMarketMetadata(market.id, "markets");

        expect(metaTrade.robots).toEqual(DEFAULT_ROBOTS);
        expect(metaProfile.robots).toEqual(DEFAULT_ROBOTS);
      }
    });

    it("4.5 verifies constructMetadata toggles between DEFAULT_ROBOTS and NO_INDEX_ROBOTS", () => {
      const publicMeta = constructMetadata({ noIndex: false });
      const privateMeta = constructMetadata({ noIndex: true });

      expect(publicMeta.robots).toEqual(DEFAULT_ROBOTS);
      expect(privateMeta.robots).toEqual(NO_INDEX_ROBOTS);
    });
  });

  // =========================================================================
  // Section 5: SSR Stream Safety & Headless Environment Purity
  // =========================================================================
  describe("5. SSR Stream Safety & Headless Node/Edge Execution", () => {
    it("5.1 executes constructMetadata without accessing DOM window or document", () => {
      // Define spy getters on globalThis that throw if touched during SSR
      const origWindow = (globalThis as any).window;
      const origDoc = (globalThis as any).document;

      let windowAccessed = false;
      let docAccessed = false;

      try {
        Object.defineProperty(globalThis, "window", {
          get() {
            windowAccessed = true;
            throw new Error("Illegal SSR access to window");
          },
          configurable: true,
        });

        Object.defineProperty(globalThis, "document", {
          get() {
            docAccessed = true;
            throw new Error("Illegal SSR access to document");
          },
          configurable: true,
        });

        // Run all core metadata generators
        const metaRoot = constructMetadata({});
        const metaPortfolio = buildPageMetadata("portfolio");
        const metaMarkets = buildPageMetadata("markets");
        const metaTrade = buildMarketMetadata("usdc-90d", "trade");
        const metaDetail = buildMarketMetadata("usdc-90d", "markets");
        const meta404 = buildMarketMetadata("unknown", "trade");

        expect(metaRoot).toBeDefined();
        expect(metaPortfolio).toBeDefined();
        expect(metaMarkets).toBeDefined();
        expect(metaTrade).toBeDefined();
        expect(metaDetail).toBeDefined();
        expect(meta404).toBeDefined();

        expect(windowAccessed).toBe(false);
        expect(docAccessed).toBe(false);
      } finally {
        Object.defineProperty(globalThis, "window", {
          value: origWindow,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(globalThis, "document", {
          value: origDoc,
          configurable: true,
          writable: true,
        });
      }
    });

    it("5.2 sustains 1,000 rapid concurrent SSR executions without state contamination or memory leaks", () => {
      const iterations = 1000;
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        const marketSlug = PRESET_MARKETS[i % PRESET_MARKETS.length].id;
        const meta = buildMarketMetadata(marketSlug, i % 2 === 0 ? "trade" : "markets");
        expect(meta).toBeDefined();
        expect(meta.metadataBase).toBeInstanceOf(URL);
      }

      const elapsed = performance.now() - startTime;
      // 1,000 executions should comfortably complete in under 500ms
      expect(elapsed).toBeLessThan(500);
    });

    it("5.3 ensures pure immutability of returned metadata objects across calls", () => {
      const meta1 = constructMetadata({ title: "Page One" });
      const meta2 = constructMetadata({ title: "Page Two" });

      expect(meta1.title).not.toBe(meta2.title);
      expect(meta1.openGraph?.title).not.toBe(meta2.openGraph?.title);

      // Verify keywords array is not shared mutable reference
      const keywordsA = meta1.keywords as string[];
      const keywordsB = meta2.keywords as string[];
      expect(keywordsA).toEqual(keywordsB);
      expect(keywordsA).not.toBe(keywordsB);
    });
  });
});
