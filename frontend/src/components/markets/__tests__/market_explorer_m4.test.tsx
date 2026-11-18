import React from "react";
import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import {
  PRESET_MARKETS,
  filterAndSortMarkets,
  getMarketCategory,
  KNOWN_ASSETS,
  MarketDefinition,
  AssetCategory,
  MarketSortKey,
} from "@/lib/markets";
import { MarketExplorerTable } from "../MarketExplorerTable";
import { TopNav, defaultTopNavProps } from "@/components/TopNav";
import { NetworkBadge } from "@/components/navigation/NetworkBadge";
import { WalletButton } from "@/components/navigation/WalletButton";
import { MobileNavDrawer } from "@/components/navigation/MobileNavDrawer";
import { MarketsPageClient } from "@/app/markets/MarketsPageClient";
import MarketsPage, { metadata as marketsMetadata } from "@/app/markets/page";
import { MarketProvider } from "@/context/MarketContext";
import { WalletProvider } from "@/context/WalletProvider";

const INDEXER_TS_HASH = "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";
const USE_EVENT_INDEXER_HASH = "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

function renderWithProviders(ui: React.ReactElement): string {
  return renderToString(
    <WalletProvider>
      <MarketProvider>{ui}</MarketProvider>
    </WalletProvider>
  );
}

describe("Milestone 4: Pendle V2 Market Explorer & Global Navigation Suite", () => {
  // 1. Bit-for-bit Checksum Invariant of Protected Indexer Files
  describe("Suite 1: Protected Files SHA256 Checksum Integrity", () => {
    it("1.1 strictly verifies src/lib/indexer.ts has intact checksum", () => {
      const filePath = path.resolve(__dirname, "../../../lib/indexer.ts");
      const content = fs.readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe(INDEXER_TS_HASH);
    });

    it("1.2 strictly verifies src/hooks/useEventIndexer.ts has intact checksum", () => {
      const filePath = path.resolve(__dirname, "../../../hooks/useEventIndexer.ts");
      const content = fs.readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe(USE_EVENT_INDEXER_HASH);
    });
  });

  // 2. Market Classification & Deep Filtering Logic
  describe("Suite 2: Market Classification & Deep Contract Search", () => {
    it("2.1 classifies USDC and EURC as Stables, XLM as Crypto", () => {
      const usdcMarket = PRESET_MARKETS.find((m) => m.asset.code === "USDC")!;
      const eurcMarket: MarketDefinition = {
        ...usdcMarket,
        id: "eurc-90d",
        name: "EURC 90-Day Yield",
        asset: KNOWN_ASSETS.EURC,
      };
      const xlmMarket = PRESET_MARKETS.find((m) => m.asset.code === "XLM")!;

      expect(getMarketCategory(usdcMarket)).toBe("Stables");
      expect(getMarketCategory(eurcMarket)).toBe("Stables");
      expect(getMarketCategory(xlmMarket)).toBe("Crypto");
    });

    it("2.2 filters correctly across category chips", () => {
      const all = filterAndSortMarkets(PRESET_MARKETS, "All");
      expect(all.length).toBe(PRESET_MARKETS.length);

      const stables = filterAndSortMarkets(PRESET_MARKETS, "Stables");
      expect(stables.length).toBeGreaterThan(0);
      expect(stables.every((m) => m.asset.code === "USDC" || m.asset.code === "EURC")).toBe(true);

      const crypto = filterAndSortMarkets(PRESET_MARKETS, "Crypto");
      expect(crypto.length).toBeGreaterThan(0);
      expect(crypto.every((m) => m.asset.code === "XLM")).toBe(true);

      const lst = filterAndSortMarkets(PRESET_MARKETS, "Liquid Staking");
      expect(lst.length).toBe(0);
    });

    it("2.3 performs deep search across symbols, tenors, and contract addresses", () => {
      // By token symbol
      const resSymbol = filterAndSortMarkets(PRESET_MARKETS, "All", "PT-bUSDC-90D");
      expect(resSymbol.length).toBe(1);
      expect(resSymbol[0].id).toBe("usdc-90d");

      // By tenor
      const resTenor = filterAndSortMarkets(PRESET_MARKETS, "All", "30D");
      expect(resTenor.length).toBe(1);
      expect(resTenor[0].id).toBe("usdc-30d");

      // By contract address: unique poolId on usdc-30d
      const usdc30d = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
      const resPool = filterAndSortMarkets(PRESET_MARKETS, "All", usdc30d.contracts.poolId);
      expect(resPool.length).toBe(1);
      expect(resPool[0].id).toBe("usdc-30d");

      // By contract address: ptId
      const resPt = filterAndSortMarkets(PRESET_MARKETS, "All", usdc30d.contracts.ptId);
      expect(resPt.length).toBe(1);
      expect(resPt[0].id).toBe("usdc-30d");

      // By contract address: syId
      const resSy = filterAndSortMarkets(PRESET_MARKETS, "All", usdc30d.contracts.syId);
      expect(resSy.length).toBeGreaterThanOrEqual(1);
      expect(resSy.some((m) => m.id === "usdc-30d")).toBe(true);

      // By contract address: sacContractId
      if (usdc30d.asset.sacContractId) {
        const resSac = filterAndSortMarkets(PRESET_MARKETS, "All", usdc30d.asset.sacContractId);
        expect(resSac.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // 3. 4-Column Bidirectional Sorting Rigor
  describe("Suite 3: 4-Column Bidirectional Sorting Invariants", () => {
    const mockMetrics: Record<string, any> = {
      "usdc-90d": { impliedApyPct: 8.45, tvlUsd: 25000 },
      "usdc-30d": { impliedApyPct: 6.20, tvlUsd: 15000 },
      "xlm-90d": { impliedApyPct: 12.50, tvlUsd: 40000 },
      "usdc-180d": { impliedApyPct: 10.15, tvlUsd: 35000 },
      "usdc-matured": { impliedApyPct: 0.00, tvlUsd: 5000 },
      "usdc-slender-90d": { impliedApyPct: 9.10, tvlUsd: 30000 },
      "eurc-90d": { impliedApyPct: 7.80, tvlUsd: 20000 },
    };

    it("3.1 sorts bidirectional by impliedApy", () => {
      const desc = filterAndSortMarkets(PRESET_MARKETS, "All", "", "impliedApy", "desc", mockMetrics);
      expect(desc[0].id).toBe("xlm-90d"); // 12.50%
      expect(desc[desc.length - 1].id).toBe("usdc-matured"); // 0.00%

      const asc = filterAndSortMarkets(PRESET_MARKETS, "All", "", "impliedApy", "asc", mockMetrics);
      expect(asc[0].id).toBe("usdc-matured");
      expect(asc[asc.length - 1].id).toBe("xlm-90d");
    });

    it("3.2 sorts bidirectional by tvl", () => {
      const desc = filterAndSortMarkets(PRESET_MARKETS, "All", "", "tvl", "desc", mockMetrics);
      expect(desc[0].id).toBe("xlm-90d"); // 40,000
      expect(desc[desc.length - 1].id).toBe("usdc-matured"); // 5,000

      const asc = filterAndSortMarkets(PRESET_MARKETS, "All", "", "tvl", "asc", mockMetrics);
      expect(asc[0].id).toBe("usdc-matured");
      expect(asc[asc.length - 1].id).toBe("xlm-90d");
    });

    it("3.3 sorts bidirectional by maturity", () => {
      const desc = filterAndSortMarkets(PRESET_MARKETS, "All", "", "maturity", "desc");
      expect(desc[0].maturity).toBeGreaterThan(desc[desc.length - 1].maturity);

      const asc = filterAndSortMarkets(PRESET_MARKETS, "All", "", "maturity", "asc");
      expect(asc[0].maturity).toBeLessThan(asc[asc.length - 1].maturity);
    });

    it("3.4 sorts by underlyingApy safely without throwing", () => {
      const sorted = filterAndSortMarkets(PRESET_MARKETS, "All", "", "underlyingApy", "desc", mockMetrics);
      expect(sorted.length).toBe(PRESET_MARKETS.length);
    });
  });

  // 4. MarketExplorerTable Component SSR & Layout
  describe("Suite 4: MarketExplorerTable 8-Column Layout & SSR Integrity", () => {
    it("4.1 renders all 8 columns in table header", () => {
      const html = renderWithProviders(<MarketExplorerTable />);

      // Column 1
      expect(html).toContain("Market Asset &amp; Tenor");
      // Column 2
      expect(html).toContain("Maturity &amp; Countdown");
      // Column 3
      expect(html).toContain("Underlying APY");
      // Column 4
      expect(html).toContain("Implied APY");
      // Column 5
      expect(html).toContain("Fixed APY (PT)");
      // Column 6
      expect(html).toContain("Long Yield (YT)");
      // Column 7
      expect(html).toContain("Liquidity / TVL");
      // Column 8
      expect(html).toContain("Action");
    });

    it("4.2 renders tabular-mono on all quantitative metrics and dates", () => {
      const html = renderWithProviders(<MarketExplorerTable />);

      // Strictly asserts tabular-mono typography
      expect(html).toContain("tabular-mono");
      expect(html).toContain("font-mono");
      // ISO date format YYYY-MM-DD
      expect(html).toMatch(/\d{4}-\d{2}-\d{2}/);
      // Fixed and Long yield pills
      expect(html).toContain("Fixed");
      expect(html).toContain("Exposure");
      // Trade CTA
      expect(html).toContain("Trade");
    });

    it("4.3 links each row to /trade/[marketId]", () => {
      const html = renderWithProviders(<MarketExplorerTable />);

      for (const m of PRESET_MARKETS) {
        expect(html).toContain(`/trade/${m.id}`);
      }
    });

    it("4.4 safely renders outside providers without throwing", () => {
      expect(() => {
        renderToString(<MarketExplorerTable />);
      }).not.toThrow();
    });
  });

  // 5. Dedicated Route /markets SSR & Metadata
  describe("Suite 5: Dedicated Route /markets & MarketsPageClient", () => {
    it("5.1 exports accurate SEO metadata for /markets", () => {
      expect(marketsMetadata.title).toBe("Active Yield Markets | NivoraFi");
      expect(typeof marketsMetadata.description).toBe("string");
      expect(marketsMetadata.openGraph?.title).toBe("Active Yield Markets | NivoraFi");
    });

    it("5.2 renders MarketsPage and MarketsPageClient with metric strip and explorer table", () => {
      const html = renderWithProviders(<MarketsPage />);

      expect(html).toContain("Active Yield Markets");
      expect(html).toContain("Live AMM Liquidity");
      expect(html).toContain("Protocol TVL");
      expect(html).toContain("Peak Implied APY");
      expect(html).toContain("Active Pools");
      expect(html).toContain("Market Asset &amp; Tenor");
    });
  });

  // 6. Top Navigation Modularization & Pendle V2 Alignment
  describe("Suite 6: TopNav Modularization (NetworkBadge, WalletButton, MobileNavDrawer)", () => {
    it("6.1 renders NetworkBadge under matched state with exact tokens", () => {
      const html = renderToString(
        <NetworkBadge walletNetworkMismatch={false} onSwitchNetwork={() => {}} />
      );

      expect(html).toContain('role="status"');
      expect(html).toContain('aria-label="Network status: Stellar Testnet"');
      expect(html).toContain('title="Connected to Stellar Testnet"');
      expect(html).toContain("border-positive/20");
      expect(html).toContain("bg-positive-soft");
      expect(html).toContain("text-positive");
      expect(html).toContain("animate-ping");
      expect(html).toContain("Testnet");
    });

    it("6.2 renders NetworkBadge under mismatched state with warning tokens", () => {
      const html = renderToString(
        <NetworkBadge walletNetworkMismatch={true} onSwitchNetwork={() => {}} />
      );

      expect(html).toContain('role="status"');
      expect(html).toContain('aria-label="Network warning: Connected wallet is not on Stellar Testnet"');
      expect(html).toContain('title="Wallet network mismatch! Click to switch to Stellar Testnet"');
      expect(html).toContain("border-warn/30");
      expect(html).toContain("bg-warn-soft");
      expect(html).toContain("text-warn");
      expect(html).toContain("Mismatch");
    });

    it("6.3 renders WalletButton disconnected and connected states", () => {
      const disconnectedHtml = renderToString(
        <WalletButton address={null} connecting={false} onConnect={() => {}} onDisconnect={() => {}} />
      );
      expect(disconnectedHtml).toContain("Connect Wallet");
      expect(disconnectedHtml).toContain("btn-accent");

      const connectedHtml = renderToString(
        <WalletButton
          address="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
          connecting={false}
          onConnect={() => {}}
          onDisconnect={() => {}}
        />
      );
      expect(connectedHtml).toContain("tabular-mono");
      expect(connectedHtml).toContain("Disconnect Wallet");
    });

    it("6.4 renders TopNav with Pools tab and Faucet trigger", () => {
      const html = renderWithProviders(
        <TopNav
          viewMode="landing"
          onToggleView={() => {}}
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          usdcTrustlineExists={true}
          accountExists={true}
          busyAction={null}
          onOpenFaucet={() => {}}
        />
      );

      expect(html).toContain("Pools");
      expect(html).toContain("Faucet");
      expect(html).not.toContain(">Markets<");
      expect(html).toContain("Trade Desk");
      expect(html).toContain("Portfolio");
    });

    it("6.5 renders MobileNavDrawer when open with full navigation links", () => {
      const html = renderToString(
        <WalletProvider>
          <MarketProvider>
            <MobileNavDrawer
              isOpen={true}
              onClose={() => {}}
              viewMode="landing"
              onToggleView={() => {}}
              onOpenFaucet={() => {}}
              address="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
              connecting={false}
              onConnect={() => {}}
              onDisconnect={() => {}}
              walletNetworkMismatch={false}
              onSwitchNetwork={() => {}}
            />
          </MarketProvider>
        </WalletProvider>
      );

      expect(html).not.toContain(">Markets<");
      expect(html).toContain("Trade");
      expect(html).toContain("Pools");
      expect(html).toContain("Portfolio");
      expect(html).toContain("Testnet Faucet");
      expect(html).toContain("Circle USDC Faucet");
      expect(html).toContain("Stellar Expert Explorer");
    });
  });

  // 7. Design System Invariant Scan
  describe("Suite 7: Design System Zero-Raw-Hex & Zero-Emoji Conformance", () => {
    const COMPONENT_PATHS = [
      "../../../components/markets/MarketExplorerTable.tsx",
      "../../../components/navigation/NetworkBadge.tsx",
      "../../../components/navigation/WalletButton.tsx",
      "../../../components/navigation/MobileNavDrawer.tsx",
      "../../../components/TopNav.tsx",
      "../../../app/markets/page.tsx",
      "../../../app/markets/MarketsPageClient.tsx",
    ];

    it("7.1 verifies zero raw hex color literals across all Milestone 4 components", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;

      for (const relPath of COMPONENT_PATHS) {
        const fullPath = path.resolve(__dirname, relPath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf-8");
          const matches = content.match(rawHexRegex);
          expect(matches).toBeNull();
        }
      }
    });

    it("7.2 verifies zero raw Unicode emojis across all Milestone 4 components", () => {
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;

      for (const relPath of COMPONENT_PATHS) {
        const fullPath = path.resolve(__dirname, relPath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf-8");
          const hasEmoji = emojiRegex.test(content);
          expect(hasEmoji).toBe(false);
        }
      }
    });
  });
});
