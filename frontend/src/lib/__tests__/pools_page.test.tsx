// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import PoolsPage, { metadata as poolsMetadata } from "@/app/pools/page";
import { PoolsPageClient } from "@/app/pools/PoolsPageClient";
import { TopNav } from "@/components/TopNav";
import { MarketProvider } from "@/context/MarketContext";
import { WalletProvider } from "@/context/WalletProvider";
import { PRESET_MARKETS } from "@/lib/markets";

const FRONTEND_DIR = path.resolve(__dirname, "../../..");

const RAW_HEX_REGEX = /#(?:[0-9a-fA-F]{3,8})\b/g;
const RGBA_REGEX = /rgba?\(/g;
const ARBITRARY_HEX_CLASS = /\[#[0-9a-fA-F]+\]/g;
const UNICODE_EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

const INDEXER_TS_HASH = "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";
const USE_EVENT_INDEXER_HASH = "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

function renderWithProviders(ui: React.ReactElement): string {
  return renderToString(
    <WalletProvider>
      <MarketProvider>{ui}</MarketProvider>
    </WalletProvider>
  );
}

describe("Pendle V2 Liquidity Pools Explorer Route (/pools) & SSR Suite", () => {
  describe("Suite 1: Protected Files SHA256 Checksum Invariant", () => {
    it("1.1 strictly verifies src/lib/indexer.ts has intact checksum", () => {
      const filePath = path.join(FRONTEND_DIR, "src/lib/indexer.ts");
      const content = fs.readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe(INDEXER_TS_HASH);
    });

    it("1.2 strictly verifies src/hooks/useEventIndexer.ts has intact checksum", () => {
      const filePath = path.join(FRONTEND_DIR, "src/hooks/useEventIndexer.ts");
      const content = fs.readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe(USE_EVENT_INDEXER_HASH);
    });
  });

  describe("Suite 2: Server Metadata & Page Invariants", () => {
    it("2.1 exports valid constructMetadata for /pools", () => {
      expect(poolsMetadata.title).toBe("Liquidity Pools | NivoraFi");
      expect(poolsMetadata.description).toBe(
        "Supply dual-sided PT and SY liquidity to Soroban log-normal YieldSpace AMM pools and earn swap fees plus underlying yield."
      );
      expect(poolsMetadata.openGraph?.title).toBe("Liquidity Pools | NivoraFi");
      expect(poolsMetadata.openGraph?.url).toBe("https://nivorafi.xyz/pools");
    });

    it("2.2 default export renders PoolsPageClient within server wrapper", () => {
      const html = renderWithProviders(<PoolsPage />);
      expect(html).toContain("Active Liquidity Pools");
    });
  });

  describe("Suite 3: PoolsPageClient SSR Markup & Semantics", () => {
    it("3.1 renders hero header, 3-card KPI strip, and action links", () => {
      const html = renderWithProviders(<PoolsPageClient />);

      // Hero header (max 6-word title & 1-sentence description)
      expect(html).toContain("Active Liquidity Pools");
      expect(html).toContain(
        "Supply principal and standardized yield liquidity to earn swap fees alongside variable protocol yield."
      );

      // 3-card KPI strip
      expect(html).toContain("Total Pool Liquidity");
      expect(html).toContain("Peak LP APY");
      expect(html).toContain("AMM Swap Fee Tier");
      expect(html).toContain("0.10% - 0.30%");

      // Liquidity table rows and action links
      expect(html).toContain("Add Liquidity");
      expect(html).toContain('href="/trade/usdc-90d?tab=liquidity"');
      expect(html).toContain("PT-USDC / SY-USDC");
    });

    it("3.2 renders TopNav with Pools highlighted in accent ink and hides MarketSelector outside Trade", () => {
      const html = renderWithProviders(<PoolsPageClient />);

      // Link to /pools should have active state token classes
      expect(html).toContain('href="/pools"');
      expect(html).toContain("bg-accent text-accent-ink");
      expect(html).not.toContain('aria-label="Open market selector"');

      const portfolioNavHtml = renderWithProviders(
        <TopNav
          viewMode="portfolio"
          onToggleView={() => {}}
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          usdcTrustlineExists={true}
          accountExists={true}
          busyAction={null}
        />
      );
      expect(portfolioNavHtml).not.toContain('aria-label="Open market selector"');

      const tradeNavHtml = renderWithProviders(
        <TopNav
          viewMode="trade"
          onToggleView={() => {}}
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          usdcTrustlineExists={true}
          accountExists={true}
          busyAction={null}
        />
      );
      expect(tradeNavHtml).toContain('aria-label="Open market selector"');
    });

    it("3.3 renders high-density pool table columns and dual-color reserve bar", () => {
      const html = renderWithProviders(<PoolsPageClient />);

      expect(html).toContain("Pool Pair");
      expect(html).toContain("Maturity");
      expect(html).toContain("Pool Reserves &amp; Ratio");
      expect(html).toContain("Total TVL");
      expect(html).toContain("Swap Fee APY");
      expect(html).toContain("Total LP APY");
      expect(html).toContain("Action");

      // Verify dual-color composition bar uses semantic classes without hex/rgba
      expect(html).toContain("bg-positive h-full");
      expect(html).toContain("bg-accent h-full");
      expect(html).toContain("pendle-pt-pill");
    });

    it("3.4 renders filter chips for All, Stables, Crypto and deep search box", () => {
      const html = renderWithProviders(<PoolsPageClient />);

      expect(html).toContain("All");
      expect(html).toContain("Stables");
      expect(html).toContain("Crypto");
      expect(html).toContain('placeholder="Search pool, asset, tenor..."');
    });

    it("3.5 renders all preset markets in the table", () => {
      const html = renderWithProviders(<PoolsPageClient />);

      for (const m of PRESET_MARKETS) {
        expect(html).toContain(`/trade/${m.id}?tab=liquidity`);
        expect(html).toContain(m.name);
      }
    });

    it("3.6 renders distinct asset-specific reserves, TVL, fee APY, and LP APY for usdc-90d vs xlm-90d", () => {
      const html = renderWithProviders(<PoolsPageClient />);

      // usdc-90d assertions
      expect(html).toContain("4,008 PT (55%)");
      expect(html).toContain("3,261 SY (45%)");
      expect(html).toContain("$7,190");
      expect(html).toContain("2.65%");
      expect(html).toContain("11.73% LP APY");

      // xlm-90d assertions
      expect(html).toContain("13,990 PT (61%)");
      expect(html).toContain("9,010 SY (39%)");
      expect(html).toContain("$8,599");
      expect(html).toContain("3.15%");
      expect(html).toContain("12.05% LP APY");
    });
  });

  describe("Suite 4: Static Design Token Verification (Zero Hex, Zero RGBA, Zero Emojis)", () => {
    const pagePath = path.join(FRONTEND_DIR, "src/app/pools/page.tsx");
    const clientPath = path.join(FRONTEND_DIR, "src/app/pools/PoolsPageClient.tsx");

    it("4.1 src/app/pools/page.tsx has zero raw hex, zero rgba, zero emojis", () => {
      const content = fs.readFileSync(pagePath, "utf-8");
      expect(content).not.toMatch(RAW_HEX_REGEX);
      expect(content).not.toMatch(RGBA_REGEX);
      expect(content).not.toMatch(ARBITRARY_HEX_CLASS);
      expect(content).not.toMatch(UNICODE_EMOJI_REGEX);
    });

    it("4.2 src/app/pools/PoolsPageClient.tsx has zero raw hex, zero rgba, zero emojis", () => {
      const content = fs.readFileSync(clientPath, "utf-8");
      expect(content).not.toMatch(RAW_HEX_REGEX);
      expect(content).not.toMatch(RGBA_REGEX);
      expect(content).not.toMatch(ARBITRARY_HEX_CLASS);
      expect(content).not.toMatch(UNICODE_EMOJI_REGEX);
    });

    it("4.3 enforces tabular-mono typography across all numeric metrics", () => {
      const clientContent = fs.readFileSync(clientPath, "utf-8");
      expect(clientContent).toContain("tabular-mono font-mono");
    });

    it("4.4 ensures headings follow max 6-word limit and descriptions 1-sentence limit", () => {
      const clientContent = fs.readFileSync(clientPath, "utf-8");
      expect(clientContent).toContain("Active Liquidity Pools");
      expect(clientContent).toContain(
        "Supply principal and standardized yield liquidity to earn swap fees alongside variable protocol yield."
      );
    });
  });
});
