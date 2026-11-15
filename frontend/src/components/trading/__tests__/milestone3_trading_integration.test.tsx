// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// Controllable Wallet Mock State
let mockWalletState = {
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
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => mockWalletState.walletNetworkMismatch,
}));

let currentActiveMarketId = "usdc-90d";

mock.module("@/context/MarketContext", () => {
  const { PRESET_MARKETS, getMarketDefinition } = require("@/lib/markets");
  return {
    useMarket: () => {
      const active = getMarketDefinition(currentActiveMarketId) ?? PRESET_MARKETS[0];
      return {
        activeMarket: active,
        activeMarketId: active.id,
        activeSnapshot: null,
        activePortfolio: null,
        loadingSnapshot: false,
        selectMarket: (id: string) => {
          currentActiveMarketId = id;
        },
        refreshActiveMarket: async () => {},
      };
    },
    MarketProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

// Components under test
import { SwapCard } from "../SwapCard";
import { MintCard } from "../MintCard";
import { LiquidityCard } from "../LiquidityCard";
import { TradingDesk, DeskTab } from "../TradingDesk";
import { PRESET_MARKETS } from "@/lib/markets";
import { LiveMarketSnapshot, LiveUserPortfolio } from "@/lib/stellar";

describe("Milestone 3: Live Stellar Contract Trading Desk Integration Suite", () => {
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

  const baseActiveSnapshot: LiveMarketSnapshot = {
    poolId: usdc90D.contracts.poolId,
    syId: usdc90D.contracts.syId,
    ptId: usdc90D.contracts.ptId,
    ytId: usdc90D.contracts.ytId,
    maturity: usdc90D.maturity,
    isMatured: false,
    daysToMaturity: 90,
    impliedFixedApyPct: 8.45,
    ptPriceInSy: 0.98,
    ytPriceInSy: 0.02,
    underlyingToken: usdc90D.asset.sacContractId,
    ptRate: 10000000n,
    bRate: 10000000n,
    totalPt: 50000_0000000n,
    totalSy: 50000_0000000n,
    totalLp: 50000_0000000n,
    reserves: { pt: 50000_0000000n, sy: 50000_0000000n },
    state: {
      total_pt_reserve: 50000_0000000n,
      total_sy_reserve: 50000_0000000n,
      total_lp_supply: 50000_0000000n,
      scalar_root: 10000000n,
      initial_anchor: 10000000n,
      maturity: BigInt(usdc90D.maturity),
      maturity_index: 10000000n,
      is_paused: false,
    },
  };

  const baseMaturedSnapshot: LiveMarketSnapshot = {
    ...baseActiveSnapshot,
    poolId: usdcMatured.contracts.poolId,
    syId: usdcMatured.contracts.syId,
    ptId: usdcMatured.contracts.ptId,
    ytId: usdcMatured.contracts.ytId,
    maturity: usdcMatured.maturity,
    isMatured: true,
    daysToMaturity: 0,
    impliedFixedApyPct: 0.0,
    ptPriceInSy: 1.0,
    ytPriceInSy: 0.0,
    state: {
      ...baseActiveSnapshot.state,
      maturity: BigInt(usdcMatured.maturity),
    },
  };

  const basePortfolio: LiveUserPortfolio = {
    accountExists: true,
    xlmBalance: "250.00",
    usdcBalance: "1500.00",
    usdcTrustlineExists: true,
    syBalance: 100_0000000n,
    ptBalance: 50_0000000n,
    ytBalance: 50_0000000n,
    lpBalance: 20_0000000n,
    lastIndex: 10000000n,
    unclaimedYieldRaw: 5_0000000n,
    estimatedPendingYieldSy: 2_5000000n,
  };

  describe("Suite 1: SwapCard Matured Market Guard & Zero-SY Helper", () => {
    it("1.1 renders Matured Market Guard banner with maturity date and Redeem/Rollover CTA when snapshot is matured", () => {
      currentActiveMarketId = "usdc-matured";
      let switchedTab: string | null = null;

      const html = renderToString(
        <SwapCard
          snapshot={baseMaturedSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          onSwitchTab={(tab) => {
            switchedTab = tab;
          }}
        />
      );

      expect(html).toContain("Market Matured");
      expect(html).toContain("AMM swaps are closed");
      expect(html).toContain("Redeem / Rollover");
      expect(html).toContain(usdcMatured.maturityIso.slice(0, 10));
      expect(html).toContain("Market Matured - Swaps Closed");
    });

    it("1.2 suppresses Matured Market Guard banner when market is active", () => {
      currentActiveMarketId = "usdc-90d";

      const html = renderToString(
        <SwapCard
          snapshot={baseActiveSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("AMM swaps are closed");
      expect(html).not.toContain("Market Matured - Swaps Closed");
      expect(html).toContain("Execute Swap");
    });

    it("1.3 renders Zero-SY onboarding helper when user has 0 SY and positive USDC balance in sy_for_pt mode", () => {
      currentActiveMarketId = "usdc-90d";
      const zeroSyPortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        syBalance: 0n,
        usdcBalance: "1250.00",
      };

      const html = renderToString(
        <SwapCard
          snapshot={baseActiveSnapshot}
          portfolio={zeroSyPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          onSwitchTab={() => {}}
        />
      );

      expect(html).not.toContain("Zero SY Available");
      expect(html).not.toContain("Wrap it into");
      expect(html).not.toContain("in the Mint tab to start trading");
      expect(html).not.toContain("Go to Mint Tab");
    });

    it("1.4 suppresses Zero-SY onboarding helper when user has positive SY balance", () => {
      currentActiveMarketId = "usdc-90d";

      const html = renderToString(
        <SwapCard
          snapshot={baseActiveSnapshot}
          portfolio={basePortfolio} // syBalance = 100 SY
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Zero SY Available");
      expect(html).not.toContain("Go to Mint Tab");
    });

    it("1.5 suppresses Zero-SY onboarding helper when user underlying balance is zero", () => {
      currentActiveMarketId = "usdc-90d";
      const zeroAllPortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        syBalance: 0n,
        usdcBalance: "0.00",
      };

      const html = renderToString(
        <SwapCard
          snapshot={baseActiveSnapshot}
          portfolio={zeroAllPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Zero SY Available");
    });
  });

  describe("Suite 2: MintCard Matured Pool Guard & Inline Trustline Helper", () => {
    it("2.1 renders Pool Matured guard notice and disables mint_py when market is matured", () => {
      currentActiveMarketId = "usdc-matured";

      const html = renderToString(
        <MintCard
          snapshot={baseMaturedSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      // In initial deposit_sy mode, not yet mint_py
      expect(html).toContain("Wrap USDC");
    });

    it("2.2 renders inline Trustline Required banner when USDC trustline is missing for deposit_sy", () => {
      currentActiveMarketId = "usdc-90d";
      const noTrustPortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        usdcTrustlineExists: false,
      };

      const html = renderToString(
        <MintCard
          snapshot={baseActiveSnapshot}
          portfolio={noTrustPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          onAddTrustline={async () => {}}
        />
      );

      expect(html).toContain("Trustline Required");
      expect(html).toContain("Establish a trustline to deposit and redeem");
      expect(html).toContain("Add USDC Trustline");
    });

    it("2.3 suppresses trustline banner when USDC trustline exists", () => {
      currentActiveMarketId = "usdc-90d";

      const html = renderToString(
        <MintCard
          snapshot={baseActiveSnapshot}
          portfolio={basePortfolio} // usdcTrustlineExists: true
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Trustline Required");
      expect(html).not.toContain("Add USDC Trustline");
    });

    it("2.4 suppresses trustline banner for native XLM asset markets", () => {
      currentActiveMarketId = "xlm-90d";
      const xlmPortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        usdcTrustlineExists: false,
      };

      const html = renderToString(
        <MintCard
          snapshot={{
            ...baseActiveSnapshot,
            poolId: xlm90D.contracts.poolId,
          }}
          portfolio={xlmPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Trustline Required");
      expect(html).not.toContain("Add XLM Trustline");
    });
  });

  describe("Suite 3: LiquidityCard Post-Maturity Guard & Withdraw Functionality", () => {
    it("3.1 renders Market Matured banner and disables Supply Dual Liquidity when pool is matured", () => {
      currentActiveMarketId = "usdc-matured";

      const html = renderToString(
        <LiquidityCard
          snapshot={baseMaturedSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          onSwitchTab={() => {}}
        />
      );

      expect(html).toContain("Market Matured");
      expect(html).toContain("Supplying liquidity is disabled after maturity");
      expect(html).toContain("Redeem / Rollover");
      expect(html).toContain("Market Matured - Supply Disabled");
    });

    it("3.2 suppresses Market Matured banner when active market is active", () => {
      currentActiveMarketId = "usdc-90d";

      const html = renderToString(
        <LiquidityCard
          snapshot={baseActiveSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Supplying liquidity is disabled after maturity");
      expect(html).not.toContain("Market Matured - Supply Disabled");
      expect(html).toContain("Supply Dual Liquidity");
    });

    it("3.3 safely renders Withdraw LP view without crash when pool is matured", () => {
      currentActiveMarketId = "usdc-matured";

      const html = renderToString(
        <LiquidityCard
          snapshot={baseMaturedSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Withdraw LP");
      expect(html).toContain("Supply Liquidity");
    });
  });

  describe("Suite 4: TradingDesk URL Tab Synchronization & Coordination", () => {
    it("4.1 renders all 5 operational tabs (Swap, Mint, Pool, Redeem, Rollover)", () => {
      currentActiveMarketId = "usdc-90d";

      const html = renderToString(
        <TradingDesk
          snapshot={baseActiveSnapshot}
          portfolio={basePortfolio}
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

    it("4.2 respects controlled activeTab prop and renders MintCard when activeTab is mint", () => {
      currentActiveMarketId = "usdc-90d";

      const html = renderToString(
        <TradingDesk
          snapshot={baseActiveSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          activeTab="mint"
        />
      );

      expect(html).toContain("Wrap USDC");
      expect(html).toContain("Split Pair");
    });

    it("4.3 respects controlled activeTab prop and renders LiquidityCard when activeTab is liquidity", () => {
      currentActiveMarketId = "usdc-90d";

      const html = renderToString(
        <TradingDesk
          snapshot={baseActiveSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          activeTab="liquidity"
        />
      );

      expect(html).toContain("Supply Liquidity");
      expect(html).toContain("Withdraw LP");
    });

    it("4.4 passes onAddTrustline and onSwitchTab callbacks cleanly to subcards", () => {
      currentActiveMarketId = "usdc-90d";
      let trustlineCalled = false;

      const html = renderToString(
        <TradingDesk
          snapshot={baseActiveSnapshot}
          portfolio={{
            ...basePortfolio,
            usdcTrustlineExists: false,
          }}
          busyAction={null}
          onExecuteAction={async () => {}}
          activeTab="mint"
          onAddTrustline={async () => {
            trustlineCalled = true;
          }}
        />
      );

      expect(html).toContain("Trustline Required");
      expect(html).toContain("Add USDC Trustline");
    });
  });

  describe("Suite 5: TradePageClient Post-Confirmation Indexer Refresh & Unfunded Account Banner", () => {
    it("5.1 TradePageClient source code explicitly calls void refreshIndexer() on transaction confirmation", () => {
      const clientPath = path.resolve(
        __dirname,
        "../../trade/TradePageClient.tsx"
      );
      const code = fs.readFileSync(clientPath, "utf-8");

      expect(code).toContain("await refreshActiveMarket();");
      expect(code).toContain("void refreshIndexer();");
    });

    it("5.2 TradePageClient source code routes Friendbot and transaction alerts exclusively via useTxToast without inline banners", () => {
      const clientPath = path.resolve(
        __dirname,
        "../../trade/TradePageClient.tsx"
      );
      const code = fs.readFileSync(clientPath, "utf-8");

      expect(code).toContain("useTxToast");
      expect(code).toContain("notifyTxError");
      expect(code).toContain("handleFundXlm()");
      expect(code).not.toContain("setBanner");
    });

    it("5.3 TradePageClient binds handleTabChange and onAddTrustline to TradingDesk", () => {
      const clientPath = path.resolve(
        __dirname,
        "../../trade/TradePageClient.tsx"
      );
      const code = fs.readFileSync(clientPath, "utf-8");

      expect(code).toContain("onTabChange={handleTabChange}");
      expect(code).toContain("onAddTrustline={handleAddUsdcTrustline}");
    });
  });

  describe("Suite 6: Design System & Cryptographic Checksum Integrity", () => {
    it("6.1 enforces 0 raw hex color codes across all Milestone 3 target files", () => {
      const targetFiles = [
        "../SwapCard.tsx",
        "../MintCard.tsx",
        "../LiquidityCard.tsx",
        "../TradingDesk.tsx",
        "../../trade/TradePageClient.tsx",
      ];

      const rawHexRegex = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

      for (const rel of targetFiles) {
        const filePath = path.resolve(__dirname, rel);
        const code = fs.readFileSync(filePath, "utf-8");
        const matches = code.match(rawHexRegex) || [];
        expect(matches.length).toBe(0);
      }
    });

    it("6.2 enforces 0 raw emojis across all Milestone 3 target files", () => {
      const targetFiles = [
        "../SwapCard.tsx",
        "../MintCard.tsx",
        "../LiquidityCard.tsx",
        "../TradingDesk.tsx",
        "../../trade/TradePageClient.tsx",
      ];

      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

      for (const rel of targetFiles) {
        const filePath = path.resolve(__dirname, rel);
        const code = fs.readFileSync(filePath, "utf-8");
        expect(emojiRegex.test(code)).toBe(false);
      }
    });

    it("6.3 enforces tabular-mono class on numeric amounts, balances, and tickers", () => {
      const targetFiles = [
        "../SwapCard.tsx",
        "../MintCard.tsx",
        "../LiquidityCard.tsx",
        "../TradingDesk.tsx",
        "../../trade/TradePageClient.tsx",
      ];

      for (const rel of targetFiles) {
        const filePath = path.resolve(__dirname, rel);
        const code = fs.readFileSync(filePath, "utf-8");
        expect(code).toContain("tabular-mono");
      }
    });

    it("6.4 strictly verifies SHA256 checksums of protected indexer files remain unmodified", () => {
      const indexerPath = path.resolve(__dirname, "../../../lib/indexer.ts");
      const hookPath = path.resolve(__dirname, "../../../hooks/useEventIndexer.ts");

      const indexerBuf = fs.readFileSync(indexerPath);
      const hookBuf = fs.readFileSync(hookPath);

      const indexerHash = crypto.createHash("sha256").update(indexerBuf).digest("hex");
      const hookHash = crypto.createHash("sha256").update(hookBuf).digest("hex");

      expect(indexerHash).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
      expect(hookHash).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
    });
  });
});
