// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

import { PRESET_MARKETS, getMarketDefinition, MarketDefinition } from "@/lib/markets";
import TradePage, {
  generateStaticParams as tradeGenerateStaticParams,
  generateMetadata as tradeGenerateMetadata,
} from "@/app/trade/[market]/page";
import MarketDetailPage, {
  generateStaticParams as marketsGenerateStaticParams,
  generateMetadata as marketsGenerateMetadata,
} from "@/app/markets/[id]/page";
import NotFound from "@/app/not-found";
import { TradePageClient } from "@/components/trade/TradePageClient";
import { MarketProvider, useMarket } from "@/context/MarketContext";
import { WalletProvider } from "@/context/WalletProvider";

const FRONTEND_ROOT = join(__dirname, "../../..");

describe("Empirical Challenger M1: Dynamic Routing, Normalization & Security Boundary Matrix", () => {
  // =========================================================================
  // Dimension 1: Static Parameter Generation Coverage
  // =========================================================================
  describe("1. Static Params Generation & Bijective Market Mapping", () => {
    it("tradeGenerateStaticParams() generates exact array of all 4 preset markets", async () => {
      const params = await tradeGenerateStaticParams();
      expect(Array.isArray(params)).toBe(true);
      expect(params.length).toBe(4);

      const generatedSlugs = params.map((p) => p.market);
      const expectedSlugs = PRESET_MARKETS.map((m) => m.id);

      expect(new Set(generatedSlugs).size).toBe(4);
      expect(generatedSlugs.sort()).toEqual(expectedSlugs.sort());
    });

    it("marketsGenerateStaticParams() generates exact array of all 4 preset markets", async () => {
      const params = await marketsGenerateStaticParams();
      expect(Array.isArray(params)).toBe(true);
      expect(params.length).toBe(4);

      const generatedSlugs = params.map((p) => p.id);
      const expectedSlugs = PRESET_MARKETS.map((m) => m.id);

      expect(new Set(generatedSlugs).size).toBe(4);
      expect(generatedSlugs.sort()).toEqual(expectedSlugs.sort());
    });

    it("verifies every generated static slug resolves to a valid, unique MarketDefinition", async () => {
      const tradeParams = await tradeGenerateStaticParams();
      for (const { market } of tradeParams) {
        const def = getMarketDefinition(market);
        expect(def).toBeDefined();
        expect(def?.id).toBe(market);
        expect(def?.asset).toBeDefined();
        expect(def?.contracts.poolId).toBeDefined();
        expect(def?.maturity).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // Dimension 2: Parameter Normalization & Robustness
  // =========================================================================
  describe("2. Route Parameter Normalization & Edge Cases", () => {
    it("handles uppercase and mixed-case market slugs cleanly", () => {
      expect(getMarketDefinition("USDC-90D")?.id).toBe("usdc-90d");
      expect(getMarketDefinition("UsDc-30d")?.id).toBe("usdc-30d");
      expect(getMarketDefinition("XLM-90D")?.id).toBe("xlm-90d");
      expect(getMarketDefinition("USDC-MATURED")?.id).toBe("usdc-matured");
    });

    it("handles surrounding whitespace, leading tabs, and trailing newlines", () => {
      expect(getMarketDefinition("  usdc-90d  ")?.id).toBe("usdc-90d");
      expect(getMarketDefinition("\tusdc-30d\n")?.id).toBe("usdc-30d");
      expect(getMarketDefinition("\r\n  xlm-90d \t\n")?.id).toBe("xlm-90d");
      expect(getMarketDefinition(" usdc-matured ")?.id).toBe("usdc-matured");
    });

    it("strictly rejects internal whitespace or corrupted variations", () => {
      expect(getMarketDefinition("usdc -90d")).toBeUndefined();
      expect(getMarketDefinition("usdc- 90d")).toBeUndefined();
      expect(getMarketDefinition("usdc 90d")).toBeUndefined();
      expect(getMarketDefinition("usdc-90d ")).toBeDefined(); // trailing is trimmed
      expect(getMarketDefinition("usdc-90d-extra")).toBeUndefined();
      expect(getMarketDefinition("usdc")).toBeUndefined();
      expect(getMarketDefinition("90d")).toBeUndefined();
    });

    it("returns undefined for empty, whitespace-only, or non-string inputs without throwing", () => {
      expect(getMarketDefinition("")).toBeUndefined();
      expect(getMarketDefinition("   ")).toBeUndefined();
      expect(getMarketDefinition("\t\n\r")).toBeUndefined();
      // @ts-expect-error test non-string types at runtime
      expect(getMarketDefinition(null)).toBeUndefined();
      // @ts-expect-error test non-string types at runtime
      expect(getMarketDefinition(undefined)).toBeUndefined();
      // @ts-expect-error test non-string types at runtime
      expect(getMarketDefinition(12345)).toBeUndefined();
      // @ts-expect-error test non-string types at runtime
      expect(getMarketDefinition({})).toBeUndefined();
      // @ts-expect-error test non-string types at runtime
      expect(getMarketDefinition([])).toBeUndefined();
      // @ts-expect-error test non-string types at runtime
      expect(getMarketDefinition(true)).toBeUndefined();
    });
  });

  // =========================================================================
  // Dimension 3: Adversarial Security & 404 Injection Defense
  // =========================================================================
  describe("3. Adversarial Security Injection & 404 Guard Verification", () => {
    const adversarialPayloads = [
      "unknown-token",
      "non-existent-market-slug",
      "../../../../etc/passwd",
      "..\\..\\windows\\system32\\calc.exe",
      "/trade/usdc-90d",
      "<script>alert('xss')</script>",
      "<img src=x onerror=alert(1)>",
      "' OR '1'='1",
      "'; DROP TABLE markets; --",
      "usdc-90d' AND 1=1--",
      "usdc-90d\0.html",
      "%00",
      "NaN",
      "Infinity",
      "-Infinity",
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "valueOf",
      "a".repeat(1000),
      "uѕdc-90d", // Cyrillic homoglyph
      "ｕｓｄｃ-90d", // Fullwidth
      "usdc\u200B-90d", // Zero-width space
    ];

    for (const payload of adversarialPayloads) {
      it(`resolves adversarial payload '${payload.slice(0, 30)}' to undefined`, () => {
        const result = getMarketDefinition(payload);
        expect(result).toBeUndefined();
      });

      it(`tradeGenerateMetadata returns 404 metadata for adversarial payload '${payload.slice(0, 30)}'`, async () => {
        const meta = await tradeGenerateMetadata({
          params: Promise.resolve({ market: payload }),
        });
        expect(meta.title).toBe("Market Not Found | NivoraFi");
        expect(meta.description).toContain("does not exist on this NivoraFi node");
      });

      it(`marketsGenerateMetadata returns 404 metadata for adversarial payload '${payload.slice(0, 30)}'`, async () => {
        const meta = await marketsGenerateMetadata({
          params: Promise.resolve({ id: payload }),
        });
        expect(meta.title).toBe("Market Not Found | NivoraFi");
        expect(meta.description).toContain("does not exist on this NivoraFi node");
      });

      it(`TradePage triggers notFound() for adversarial payload '${payload.slice(0, 30)}'`, async () => {
        try {
          await TradePage({
            params: Promise.resolve({ market: payload }),
          });
          expect(false).toBe(true); // Should not reach here
        } catch (err: any) {
          // Next.js notFound() throws a NEXT_HTTP_ERROR_FALLBACK;404 or NEXT_NOT_FOUND error
          expect(err.digest || err.message).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND|NEXT_REDIRECT/);
        }
      });

      it(`MarketDetailPage triggers notFound() for adversarial payload '${payload.slice(0, 30)}'`, async () => {
        try {
          await MarketDetailPage({
            params: Promise.resolve({ id: payload }),
          });
          expect(false).toBe(true); // Should not reach here
        } catch (err: any) {
          // Next.js notFound() throws a NEXT_HTTP_ERROR_FALLBACK;404 or NEXT_NOT_FOUND error
          expect(err.digest || err.message).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND|NEXT_REDIRECT/);
        }
      });
    }

    it("NotFound component renders clean 404 UI without emojis and conforms to design rules", () => {
      const html = renderToString(React.createElement(NotFound));
      expect(html).toContain("404 - Ledger Entry Not Found");
      expect(html).toContain("The requested page or contract path does not exist on this NivoraFi node.");
      expect(html).toContain("Back to Markets");
      expect(html).toContain('href="/"');
      expect(html).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u); // Zero emojis
      expect(html).not.toMatch(/#[0-9a-fA-F]{6}/); // Zero raw hex codes
    });
  });

  // =========================================================================
  // Dimension 4: Direct URL Resolution & Metadata Integrity for All Preset Markets
  // =========================================================================
  describe("4. Direct URL Resolution & Metadata Integrity Across Preset Markets", () => {
    for (const market of PRESET_MARKETS) {
      it(`tradeGenerateMetadata generates valid metadata for '${market.id}'`, async () => {
        const meta = await tradeGenerateMetadata({
          params: Promise.resolve({ market: market.id }),
        });
        expect(meta.title).toContain(market.name);
        expect(meta.title).toContain(market.ptSymbol);
        expect(meta.title).toContain("NivoraFi");
        expect(meta.description).toContain(market.ptSymbol);
        expect(meta.description).toContain(market.ytSymbol);
        expect(meta.openGraph?.title).toContain(market.name);
        expect(meta.openGraph?.description).toContain(market.tenor);
        expect(meta.openGraph?.description).toContain(market.asset.code);
      });

      it(`marketsGenerateMetadata generates valid metadata for '${market.id}'`, async () => {
        const meta = await marketsGenerateMetadata({
          params: Promise.resolve({ id: market.id }),
        });
        expect(meta.title).toContain(market.name);
        expect(meta.title).toContain("Market Profile");
        expect(meta.title).toContain("NivoraFi");
        expect(meta.description).toContain(market.name);
        expect(meta.openGraph?.title).toContain(market.name);
        expect(meta.openGraph?.description).toContain(market.tenor);
        expect(meta.openGraph?.description).toContain(market.asset.code);
      });

      it(`TradePage returns TradePageClient with resolved market '${market.id}' and initialTab`, async () => {
        const pageElement = await TradePage({
          params: Promise.resolve({ market: market.id }),
          searchParams: Promise.resolve({ tab: "mint" }),
        });
        expect(React.isValidElement(pageElement)).toBe(true);
        expect(pageElement.props.market.id).toBe(market.id);
        expect(pageElement.props.initialTab).toBe("mint");
      });

      it(`MarketDetailPage returns TradePageClient with resolved market '${market.id}'`, async () => {
        const pageElement = await MarketDetailPage({
          params: Promise.resolve({ id: market.id }),
        });
        expect(React.isValidElement(pageElement)).toBe(true);
        expect(pageElement.props.market.id).toBe(market.id);
        expect(pageElement.props.initialTab).toBe("swap");
      });
    }
  });

  // =========================================================================
  // Dimension 5: Component SSR Safety & Context Elevation Invariants
  // =========================================================================
  describe("5. Component SSR Safety & Market Context Elevation", () => {
    it("TradePageClient renders via SSR without router invariant crashes for each preset market", () => {
      for (const market of PRESET_MARKETS) {
        const html = renderToString(
          React.createElement(
            WalletProvider,
            null,
            React.createElement(
              MarketProvider,
              { initialMarketId: market.id } as any,
              React.createElement(TradePageClient, { market, initialTab: "swap" })
            )
          )
        );

        expect(html).toContain(market.ptSymbol);
        expect(html).toContain(market.asset.code);
        expect(html).toContain(market.tenor);
        expect(html).toContain("Swap");
        expect(html).toContain("Mint");
        expect(html).toContain("Redeem");
        expect(html).toContain("Pool");
      }
    });

    it("verifies MarketProvider pass-through when nested in existing context", () => {
      function TestConsumer() {
        const { activeMarketId } = useMarket();
        return React.createElement("div", { id: "test-id" }, activeMarketId);
      }

      // Outer provider sets usdc-30d, inner provider without initialMarketId should pass-through
      const html = renderToString(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
            { initialMarketId: "usdc-30d" } as any,
            React.createElement(
              MarketProvider,
              null,
              React.createElement(TestConsumer)
            )
          )
        )
      );

      expect(html).toContain("usdc-30d");
    });
  });

  // =========================================================================
  // Dimension 6: Protected Files Immutability Checksum Verification
  // =========================================================================
  describe("6. Protected Files Immutability", () => {
    it("verifies src/lib/indexer.ts has not been modified (exact SHA256)", () => {
      const filePath = join(FRONTEND_ROOT, "src/lib/indexer.ts");
      const content = readFileSync(filePath);
      const sha256 = createHash("sha256").update(content).digest("hex");
      expect(sha256).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
    });

    it("verifies src/hooks/useEventIndexer.ts has not been modified (exact SHA256)", () => {
      const filePath = join(FRONTEND_ROOT, "src/hooks/useEventIndexer.ts");
      const content = readFileSync(filePath);
      const sha256 = createHash("sha256").update(content).digest("hex");
      expect(sha256).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
    });
  });
});
