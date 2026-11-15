// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

// Mock WalletProvider for predictable testing
let currentMockWallet = {
  address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27" as string | null,
  mode: "wallet" as "disconnected" | "wallet" | "watch",
  walletId: "freighter" as string | null,
  walletNetworkMismatch: false,
  kitReady: true,
  connecting: false,
  connectWallet: async () => {},
  connectWatchAddress: (_pk: string) => {},
  disconnect: async () => {},
  signTransactionXdr: async (xdr: string) => xdr,
  switchNetwork: async () => {},
};

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => currentMockWallet,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => currentMockWallet.walletNetworkMismatch,
}));

// Mock Next.js router
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
  }),
  usePathname: () => "/trade/usdc-90d",
  useSearchParams: () => new URLSearchParams(),
}));

import { TokenProfileHeader } from "../TokenProfileHeader";
import { YieldBreakdownCards } from "../YieldBreakdownCards";
import {
  InteractiveYieldChart,
  ChartDataPoint,
} from "../InteractiveYieldChart";
import {
  TokenActivityFeed,
  formatProtocolEvent,
  formatRelativeTime,
  isEventForMarket,
} from "../TokenActivityFeed";
import { TradePageClient } from "@/components/trade/TradePageClient";
import { MarketProvider } from "@/context/MarketContext";
import { PRESET_MARKETS } from "@/lib/markets";
import { LiveMarketSnapshot, LiveUserPortfolio } from "@/lib/stellar";
import { ProtocolEvent, SwapEventParsed, MintPyEventParsed, DepositEventParsed, RedeemPtEventParsed, LiquidityEventParsed, RolloverEventParsed } from "@/lib/indexer";

describe("Milestone 2 Component Test Suite: Dedicated Token Page UI Architecture", () => {
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

  const activeSnapshot: LiveMarketSnapshot = {
    state: {
      total_pt_reserve: 85_000_0000000n,
      total_sy_reserve: 42_000_0000000n,
      total_lp_supply: 60_000_0000000n,
      scalar_root: 1_0000000n,
      initial_anchor: 1_0000000n,
      annual_fee_rate: 100000n,
      protocol_fee_bps: 30n,
      fee_recipient: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      maturity: BigInt(usdc90D.maturity),
      maturity_index: 1_0000000n,
      is_settled: false,
    },
    latestLedger: 123456,
    nowSeconds: Math.floor(Date.now() / 1000),
    daysToMaturity: 88.5,
    isMatured: false,
    blendExchangeRate: 10000000n,
    ammExchangeRateWad: 1000000000000000000n,
    ptPriceInSy: 0.9812,
    ytPriceInSy: 0.0188,
    impliedFixedApyPct: 8.45,
    ptTotalSupply: 85_000_0000000n,
    ytTotalSupply: 85_000_0000000n,
    syTotalSupply: 42_000_0000000n,
    ptProportionPct: 66.9,
  };

  const maturedSnapshot: LiveMarketSnapshot = {
    ...activeSnapshot,
    state: {
      ...activeSnapshot.state,
      maturity: BigInt(usdcMatured.maturity),
      is_settled: true,
    },
    daysToMaturity: 0,
    isMatured: true,
    ptPriceInSy: 1.0,
    ytPriceInSy: 0.0,
    impliedFixedApyPct: 0.0,
  };

  const wrapWithContext = (element: React.ReactElement, marketId = "usdc-90d") => {
    return renderToString(
      React.createElement(MarketProvider, { initialMarketId: marketId, children: element })
    );
  };

  // ==========================================================================
  // 1. TokenProfileHeader Tests
  // ==========================================================================
  describe("TokenProfileHeader", () => {
    it("renders active market identity, protocol name, ISO maturity date, and time left", () => {
      const html = renderToString(
        React.createElement(TokenProfileHeader, {
          market: usdc90D,
          snapshot: activeSnapshot,
        })
      );

      // Asset metadata
      expect(html).toContain(usdc90D.name);
      expect(html).toContain(usdc90D.asset.code);
      expect(html).toContain(usdc90D.tenor);
      expect(html).toContain(usdc90D.ptSymbol);
      expect(html).toContain(usdc90D.ytSymbol);
      expect(html).toContain("Blend Protocol");
      expect(html).toContain(usdc90D.maturityIso.slice(0, 10));
      expect(html).toContain("left");
      expect(html).toContain("Active");
      expect(html).toContain("tabular-mono");
    });

    it("renders matured state properly when market has matured", () => {
      const html = renderToString(
        React.createElement(TokenProfileHeader, {
          market: usdcMatured,
          snapshot: maturedSnapshot,
        })
      );

      expect(html).toContain("Matured");
      expect(html).toContain("Settled at Maturity");
      expect(html).not.toContain("animate-pulse");
    });

    it("gracefully renders with null snapshot using market fallback", () => {
      expect(() => {
        const html = renderToString(
          React.createElement(TokenProfileHeader, {
            market: usdc90D,
            snapshot: null,
          })
        );
        expect(html).toContain(usdc90D.name);
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // 2. YieldBreakdownCards Tests
  // ==========================================================================
  describe("YieldBreakdownCards", () => {
    it("renders all 6 Bento cards with accurate Yield Space metrics and tabular-mono figures", () => {
      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdc90D,
          snapshot: activeSnapshot,
        })
      );

      // Card titles
      expect(html).toContain("Implied APY");
      expect(html).toContain("Underlying APY");
      expect(html).toContain("Fixed APY");
      expect(html).toContain("Long Yield Leverage");
      expect(html).toContain("Maturity");
      expect(html).toContain("Pool TVL");

      // Card values
      expect(html).toContain("8.45%");
      expect(html).toContain("4.85%");
      expect(html).toContain("88.5d");
      expect(html).toContain("tabular-mono");
    });

    it("displays '--' leverage and 0.00% fixed APY for matured markets", () => {
      const html = renderToString(
        React.createElement(YieldBreakdownCards, {
          market: usdcMatured,
          snapshot: maturedSnapshot,
        })
      );

      expect(html).toContain("--");
      expect(html).toContain("0.00%");
      expect(html).toContain("Matured");
    });

    it("safely renders in loading state with null snapshot", () => {
      expect(() => {
        const html = renderToString(
          React.createElement(YieldBreakdownCards, {
            market: usdc90D,
            snapshot: null,
            loading: true,
          })
        );
        expect(html).toContain("Implied APY");
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // 3. InteractiveYieldChart Tests
  // ==========================================================================
  describe("InteractiveYieldChart", () => {
    it("renders SVG chart with mode switcher and timeframe selector tabs", () => {
      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          snapshot: activeSnapshot,
        })
      );

      // Mode switcher tabs
      expect(html).toContain("Yield APY");
      expect(html).toContain("Token Price");

      // Timeframe selector tabs
      expect(html).toContain("1D");
      expect(html).toContain("1W");
      expect(html).toContain("1M");
      expect(html).toContain("ALL");

      // SVG elements
      expect(html).toContain("<svg");
      expect(html).toContain("linearGradient");
      expect(html).toContain("tabular-mono");
    });

    it("renders token price mode when initialMode is 'price'", () => {
      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          snapshot: activeSnapshot,
          initialMode: "price",
        })
      );

      expect(html).toContain("PT Price");
      expect(html).toContain("YT Price");
      expect(html).toContain("Discount");
    });

    it("renders custom data points series cleanly without crash", () => {
      const customData: ChartDataPoint[] = [
        {
          timestamp: 1700000000,
          impliedApy: 7.5,
          underlyingApy: 4.5,
          ptPrice: 0.975,
          ytPrice: 0.025,
        },
        {
          timestamp: 1700086400,
          impliedApy: 8.2,
          underlyingApy: 4.8,
          ptPrice: 0.98,
          ytPrice: 0.02,
        },
      ];

      const html = renderToString(
        React.createElement(InteractiveYieldChart, {
          market: usdc90D,
          data: customData,
        })
      );

      expect(html).toContain("8.20%");
      expect(html).toContain("<svg");
    });

    it("safely renders in empty/loading state without data", () => {
      expect(() => {
        const html = renderToString(
          React.createElement(InteractiveYieldChart, {
            market: usdc90D,
            snapshot: null,
            loading: true,
          })
        );
        expect(html).toContain("<svg");
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // 4. TokenActivityFeed Tests
  // ==========================================================================
  describe("TokenActivityFeed", () => {
    const mockSwapEvent: SwapEventParsed = {
      id: "ev_swap_1",
      txHash: "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678",
      ledger: 1000234,
      ledgerClosedAt: "2026-11-10T12:00:00Z",
      timestamp: Math.floor(Date.now() / 1000) - 120, // 2m ago
      type: "swap",
      topicSymbol: "swap",
      contractId: usdc90D.contracts.poolId,
      caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      amountIn: 100_0000000n,
      amountOut: 98_1200000n,
      direction: 1, // SY_FOR_PT
      directionLabel: "SY_FOR_PT",
      fee: 300000n,
    };

    const mockMintEvent: MintPyEventParsed = {
      id: "ev_mint_1",
      txHash: "b2c3d4e5f67890123456789012345678901234567890123456789012345678a1",
      ledger: 1000235,
      ledgerClosedAt: "2026-11-10T12:00:00Z",
      timestamp: Math.floor(Date.now() / 1000) - 300,
      type: "mint_py",
      topicSymbol: "mint_py",
      contractId: usdc90D.contracts.syId,
      caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      syIn: 50_0000000n,
      pyOut: 50_0000000n,
    };

    const mockOtherMarketEvent: SwapEventParsed = {
      ...mockSwapEvent,
      id: "ev_other_1",
      contractId: xlm90D.contracts.poolId, // Different market
    };

    describe("isEventForMarket filter function", () => {
      it("returns true for event with matching poolId contractId", () => {
        expect(isEventForMarket(mockSwapEvent, usdc90D)).toBe(true);
      });

      it("returns true for event with matching syId contractId", () => {
        expect(isEventForMarket(mockMintEvent, usdc90D)).toBe(true);
      });

      it("returns false for event from another market's contract", () => {
        expect(isEventForMarket(mockOtherMarketEvent, usdc90D)).toBe(false);
      });

      it("handles pool_id in event properties case-insensitively", () => {
        const genericEv = {
          ...mockSwapEvent,
          contractId: "CBAD...",
          pool_id: usdc90D.contracts.poolId.toUpperCase(),
        } as unknown as ProtocolEvent;
        expect(isEventForMarket(genericEv, usdc90D)).toBe(true);
      });
    });

    describe("formatProtocolEvent and formatRelativeTime", () => {
      it("formats swap event into structured activity item", () => {
        const item = formatProtocolEvent(mockSwapEvent, usdc90D);
        expect(item.category).toBe("swap");
        expect(item.description).toContain("Swapped");
        expect(item.amountSummary).toContain("PT");
        expect(item.explorerUrl).toContain("stellar.expert");
      });

      it("formats relative time correctly", () => {
        const now = Math.floor(Date.now() / 1000);
        expect(formatRelativeTime(now - 10)).toBe("Just now");
        expect(formatRelativeTime(now - 120)).toBe("2m ago");
        expect(formatRelativeTime(now - 7200)).toBe("2h ago");
        expect(formatRelativeTime(now - 172800)).toBe("2d ago");
      });
    });

    describe("Component Rendering", () => {
      it("renders verbatim fallback text when no events match the market", () => {
        const html = renderToString(
          React.createElement(TokenActivityFeed, {
            market: usdc90D,
            rawEvents: [],
          })
        );

        expect(html).toContain("No recent transactions on Stellar Testnet for this asset");
        expect(html).toContain("Live Soroban RPC indexer is monitoring");
      });

      it("renders event list with badges, shortened actor addresses, and explorer links", () => {
        const rawHtml = renderToString(
          React.createElement(TokenActivityFeed, {
            market: usdc90D,
            rawEvents: [mockSwapEvent, mockMintEvent],
          })
        );
        const html = rawHtml.replace(/<!-- -->/g, "");

        expect(html).toContain("Market Activity");
        expect(html).toContain("Swap");
        expect(html).toContain("Mint");
        expect(html).toContain("Ledger");
        expect(html).toContain("1000234");
        expect(html).toContain("tabular-mono");
        expect(html).toContain("stellar.expert");
      });
    });
  });

  // ==========================================================================
  // 5. TradePageClient Integration & SSR String Rendering
  // ==========================================================================
  describe("TradePageClient Integration", () => {
    it("renders TradePageClient across all 6 preset markets without router crash", () => {
      for (const market of PRESET_MARKETS) {
        expect(() => {
          const html = wrapWithContext(
            React.createElement(TradePageClient, {
              market,
              initialTab: "swap",
            }),
            market.id
          );

          expect(html.length).toBeGreaterThan(1000);
          expect(html).toContain(market.name);
          expect(html).toContain(market.asset.code);
          expect(html).toContain(market.tenor);
          expect(html).toContain("Implied APY");
          expect(html).toContain("Trade Fixed Yield");
        }).not.toThrow();
      }
    });

    it("renders TradePageClient across all 5 trading tabs", () => {
      const tabs = ["swap", "mint", "redeem", "liquidity", "rollover"];
      for (const tab of tabs) {
        expect(() => {
          const html = wrapWithContext(
            React.createElement(TradePageClient, {
              market: usdc90D,
              initialTab: tab,
            })
          );
          expect(html).toContain(usdc90D.name);
        }).not.toThrow();
      }
    });
  });

  // ==========================================================================
  // 6. Design System Conformance Scan
  // ==========================================================================
  describe("Design System Conformance Scan", () => {
    const tokenDir = path.resolve(__dirname, "..");
    const tradeDir = path.resolve(__dirname, "../../trade");
    const targetFiles = [
      path.join(tokenDir, "TokenProfileHeader.tsx"),
      path.join(tokenDir, "YieldBreakdownCards.tsx"),
      path.join(tokenDir, "InteractiveYieldChart.tsx"),
      path.join(tokenDir, "TokenActivityFeed.tsx"),
      path.join(tradeDir, "TradePageClient.tsx"),
    ];

    it("strictly verifies zero raw hex color codes across all Milestone 2 components", () => {
      const hexPattern = /#([0-9a-fA-F]{3,8})\b/g;
      const violations: string[] = [];

      for (const filePath of targetFiles) {
        const code = fs.readFileSync(filePath, "utf-8");
        const matches = code.match(hexPattern);
        if (matches) {
          violations.push(`${path.basename(filePath)}: ${matches.join(", ")}`);
        }
      }

      expect(violations).toEqual([]);
    });

    it("strictly verifies zero raw Unicode emojis across all Milestone 2 components", () => {
      const emojiPattern = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const violations: string[] = [];

      for (const filePath of targetFiles) {
        const lines = fs.readFileSync(filePath, "utf-8").split("\n");
        lines.forEach((line, index) => {
          if (emojiPattern.test(line)) {
            violations.push(`${path.basename(filePath)}:${index + 1}: ${line.trim()}`);
          }
        });
      }

      expect(violations).toEqual([]);
    });

    it("verifies mandatory tabular-mono class is applied in each component file", () => {
      for (const filePath of targetFiles) {
        const code = fs.readFileSync(filePath, "utf-8");
        expect(code.includes("tabular-mono")).toBe(true);
      }
    });
  });
});
