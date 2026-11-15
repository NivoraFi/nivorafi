// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// Mock Wallet State
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
  const { PRESET_MARKETS, getMarketDefinition, KNOWN_ASSETS } = require("@/lib/markets");
  return {
    useMarket: () => {
      let active = getMarketDefinition(currentActiveMarketId);
      if (!active && currentActiveMarketId === "eurc-90d") {
        active = {
          ...PRESET_MARKETS[0],
          id: "eurc-90d",
          name: "EURC 90-Day Yield",
          asset: KNOWN_ASSETS.EURC,
        };
      }
      active = active ?? PRESET_MARKETS[0];
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

// Components under empirical challenge
import { SwapCard } from "../SwapCard";
import { MintCard } from "../MintCard";
import { LiquidityCard } from "../LiquidityCard";
import { TradingDesk, DeskTab } from "../TradingDesk";
import { PRESET_MARKETS, KNOWN_ASSETS, MarketDefinition } from "@/lib/markets";
import { LiveMarketSnapshot, LiveUserPortfolio } from "@/lib/stellar";

describe("Empirical Challenger M3: Adversarial Stress Test Suite", () => {
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const eurc90D: MarketDefinition = {
    ...usdc90D,
    id: "eurc-90d",
    name: "EURC 90-Day Yield",
    asset: KNOWN_ASSETS.EURC,
  };

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

  describe("Suite 1: Matured Market State Guards (usdc-matured & timestamp edge cases)", () => {
    it("1.1 SwapCard: Disables execute button with 'Market Matured - Swaps Closed' and shows warning banner", () => {
      currentActiveMarketId = "usdc-matured";
      const html = renderToString(
        <SwapCard
          snapshot={baseMaturedSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          onSwitchTab={() => {}}
        />
      );

      expect(html).toContain("Market Matured");
      expect(html).toContain("AMM swaps are closed");
      expect(html).toContain("Market Matured - Swaps Closed");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?<span>Market Matured - Swaps Closed<\/span>/);
    });

    it("1.2 SwapCard: Evaluates isMatured=true via activeMarket.maturity timestamp even if snapshot.isMatured is falsely reported as false", () => {
      currentActiveMarketId = "usdc-matured";
      // Stale or buggy backend snapshot reporting isMatured: false
      const desyncedSnapshot: LiveMarketSnapshot = {
        ...baseMaturedSnapshot,
        isMatured: false,
      };

      const html = renderToString(
        <SwapCard
          snapshot={desyncedSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      // Should still trigger matured guard because usdcMatured.maturity is in the past!
      expect(html).toContain("Market Matured");
      expect(html).toContain("Market Matured - Swaps Closed");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?<span>Market Matured - Swaps Closed<\/span>/);
    });

    it("1.3 SwapCard: Evaluates isMatured=true when snapshot is null but activeMarket.maturity is past", () => {
      currentActiveMarketId = "usdc-matured";
      const html = renderToString(
        <SwapCard
          snapshot={null}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Market Matured");
      expect(html).toContain("AMM swaps are closed");
    });

    it("1.4 LiquidityCard: Disables 'Supply Liquidity' action with 'Market Matured - Supply Disabled' when matured", () => {
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
      expect(html).toContain("Market Matured - Supply Disabled");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?<span>Market Matured - Supply Disabled<\/span>/);
    });

    it("1.5 LiquidityCard: Preserves 'Withdraw LP' mode without matured lockout", () => {
      currentActiveMarketId = "usdc-matured";
      const html = renderToString(
        <LiquidityCard
          snapshot={baseMaturedSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      // The Withdraw LP tab option exists
      expect(html).toContain("Withdraw LP");
      // Withdraw mode does not render the supply-disabled message
      expect(html).not.toContain("Withdrawal Disabled");
    });

    it("1.6 MintCard: Renders 'Wrap USDC into SY' by default and does not falsely disable non-mint modes", () => {
      currentActiveMarketId = "usdc-matured";
      const html = renderToString(
        <MintCard
          snapshot={baseMaturedSnapshot}
          portfolio={basePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      // Default mode is deposit_sy, which should NOT be labeled "Market Matured - Mint Disabled"
      expect(html).not.toContain("Market Matured - Mint Disabled");
      expect(html).toContain("Wrap USDC into SY");
    });
  });

  describe("Suite 2: Zero-SY Balance & Wrap Helper Empirical Stress", () => {
    it("2.1 SwapCard: Omits Zero-SY onboarding helper box even when syBalance is 0 and underlying balance > 0", () => {
      currentActiveMarketId = "usdc-90d";
      const zeroSyPortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        syBalance: 0n,
        usdcBalance: "1500.00",
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

    it("2.2 SwapCard: Suppresses Zero-SY helper when user has non-zero SY balance (even 1 stroop)", () => {
      currentActiveMarketId = "usdc-90d";
      const dustSyPortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        syBalance: 1n, // 1 stroop
        usdcBalance: "1500.00",
      };

      const html = renderToString(
        <SwapCard
          snapshot={baseActiveSnapshot}
          portfolio={dustSyPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Zero SY Available");
      expect(html).not.toContain("Go to Mint Tab");
    });

    it("2.3 SwapCard: Suppresses Zero-SY helper when USDC balance is '0' or '0.00'", () => {
      currentActiveMarketId = "usdc-90d";
      const zeroBothPortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        syBalance: 0n,
        usdcBalance: "0.00",
      };

      const html = renderToString(
        <SwapCard
          snapshot={baseActiveSnapshot}
          portfolio={zeroBothPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Zero SY Available");
      expect(html).not.toContain("Go to Mint Tab");
    });

    it("2.4 SwapCard: Handles disconnected / guest mode cleanly", () => {
      currentActiveMarketId = "usdc-90d";
      const prevMode = mockWalletState.mode;
      const prevAddress = mockWalletState.address;
      mockWalletState.mode = "disconnected";
      mockWalletState.address = null;

      try {
        const html = renderToString(
          <SwapCard
            snapshot={baseActiveSnapshot}
            portfolio={null}
            busyAction={null}
            onExecuteAction={async () => {}}
          />
        );

        expect(html).not.toContain("Zero SY Available");
        expect(html).toContain("Connect Wallet to Swap");
      } finally {
        mockWalletState.mode = prevMode;
        mockWalletState.address = prevAddress;
      }
    });

    it("2.5 SwapCard: When connected but portfolio is null, suppresses Zero-SY helper safely", () => {
      currentActiveMarketId = "usdc-90d";
      const html = renderToString(
        <SwapCard
          snapshot={baseActiveSnapshot}
          portfolio={null}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Zero SY Available");
      expect(html).not.toContain("Go to Mint Tab");
    });
  });

  describe("Suite 3: Missing Trustline Inline Helper Stress", () => {
    it("3.1 MintCard: Renders 'Trustline Required' inline banner with 'Add USDC Trustline' for USDC market when trustline missing", () => {
      currentActiveMarketId = "usdc-90d";
      const noTrustlinePortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        usdcTrustlineExists: false,
      };

      const html = renderToString(
        <MintCard
          snapshot={baseActiveSnapshot}
          portfolio={noTrustlinePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
          onAddTrustline={async () => {}}
        />
      );

      expect(html).toContain("Trustline Required");
      expect(html).toContain("Establish a trustline to deposit and redeem");
      expect(html).toContain("Add USDC Trustline");
    });

    it("3.2 MintCard: Renders 'Add EURC Trustline' for EURC market when trustline is missing", () => {
      currentActiveMarketId = "eurc-90d";
      const noTrustlinePortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        usdcTrustlineExists: false,
      };

      const html = renderToString(
        <MintCard
          snapshot={{
            ...baseActiveSnapshot,
            poolId: eurc90D.contracts.poolId,
            syId: eurc90D.contracts.syId,
            ptId: eurc90D.contracts.ptId,
            ytId: eurc90D.contracts.ytId,
            maturity: eurc90D.maturity,
          }}
          portfolio={noTrustlinePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Trustline Required");
      expect(html).toContain("Add EURC Trustline");
    });

    it("3.3 MintCard: Suppresses trustline helper when usdcTrustlineExists is true", () => {
      currentActiveMarketId = "usdc-90d";
      const trustedPortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        usdcTrustlineExists: true,
      };

      const html = renderToString(
        <MintCard
          snapshot={baseActiveSnapshot}
          portfolio={trustedPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Trustline Required");
      expect(html).not.toContain("Add USDC Trustline");
    });

    it("3.4 MintCard: Suppresses trustline helper for native XLM asset market (xlm-90d) even if usdcTrustlineExists is false", () => {
      currentActiveMarketId = "xlm-90d";
      const noUsdcTrustlinePortfolio: LiveUserPortfolio = {
        ...basePortfolio,
        usdcTrustlineExists: false,
      };

      const html = renderToString(
        <MintCard
          snapshot={{
            ...baseActiveSnapshot,
            poolId: xlm90D.contracts.poolId,
            syId: xlm90D.contracts.syId,
            ptId: xlm90D.contracts.ptId,
            ytId: xlm90D.contracts.ytId,
            maturity: xlm90D.maturity,
          }}
          portfolio={noUsdcTrustlinePortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("Trustline Required");
      expect(html).not.toContain("Add XLM Trustline");
    });

    it("3.5 MintCard: Suppresses trustline helper when wallet is in guest / disconnected mode", () => {
      currentActiveMarketId = "usdc-90d";
      const prevMode = mockWalletState.mode;
      const prevAddress = mockWalletState.address;
      mockWalletState.mode = "disconnected";
      mockWalletState.address = null;

      try {
        const noTrustlinePortfolio: LiveUserPortfolio = {
          ...basePortfolio,
          usdcTrustlineExists: false,
        };

        const html = renderToString(
          <MintCard
            snapshot={baseActiveSnapshot}
            portfolio={noTrustlinePortfolio}
            busyAction={null}
            onExecuteAction={async () => {}}
          />
        );

        expect(html).not.toContain("Trustline Required");
        expect(html).toContain("Connect Wallet to Sign");
      } finally {
        mockWalletState.mode = prevMode;
        mockWalletState.address = prevAddress;
      }
    });
  });

  describe("Suite 4: TradingDesk Routing & TradePageClient Unfunded Account State", () => {
    it("4.1 TradingDesk: Synchronizes controlled activeTab prop and renders MintCard on mint tab", () => {
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

      expect(html).toContain("Wrap USDC into SY");
      expect(html).toContain("Deposit Amount");
    });

    it("4.2 TradingDesk: Synchronizes controlled activeTab prop and renders LiquidityCard on liquidity tab", () => {
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
      expect(html).toContain("Supply Dual Liquidity");
    });

    it("4.3 TradePageClient source code: Routes transaction & Friendbot notifications exclusively via useTxToast with zero inline banners", () => {
      const clientPath = path.resolve(process.cwd(), "src/components/trade/TradePageClient.tsx");
      const clientContent = fs.readFileSync(clientPath, "utf-8");

      expect(clientContent).toContain("useTxToast");
      expect(clientContent).toContain("notifyTxPending");
      expect(clientContent).toContain("notifyTxConfirming");
      expect(clientContent).toContain("notifyTxSuccess");
      expect(clientContent).toContain("notifyTxError");
      expect(clientContent).toContain("handleFundXlm");
      expect(clientContent).not.toContain("setBanner");
      expect(clientContent).not.toContain("confirmed on Stellar Testnet.");
    });

    it("4.4 TradePageClient source code: Explicitly triggers void refreshIndexer() on transaction confirmation block", () => {
      const clientPath = path.resolve(process.cwd(), "src/components/trade/TradePageClient.tsx");
      const clientContent = fs.readFileSync(clientPath, "utf-8");

      const confirmIdx = clientContent.indexOf("notifyTxSuccess(toastId, submitted.hash, params.label)");
      expect(confirmIdx).toBeGreaterThan(0);
      const postConfirmChunk = clientContent.slice(confirmIdx, confirmIdx + 250);
      expect(postConfirmChunk).toContain("await refreshActiveMarket();");
      expect(postConfirmChunk).toContain("void refreshIndexer();");
    });
  });

  describe("Suite 5: Automated Design System RegEx & Checksum Integrity", () => {
    const targetFiles = [
      "src/components/trading/SwapCard.tsx",
      "src/components/trading/MintCard.tsx",
      "src/components/trading/LiquidityCard.tsx",
      "src/components/trading/TradingDesk.tsx",
      "src/components/trade/TradePageClient.tsx",
    ];

    it("5.1 Enforces 0 raw hex color codes across all Milestone 3 files", () => {
      const hexRegex = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

      for (const relPath of targetFiles) {
        const fullPath = path.resolve(process.cwd(), relPath);
        const code = fs.readFileSync(fullPath, "utf-8");
        const matches = code.match(hexRegex) || [];
        expect(matches.length).toBe(0);
      }
    });

    it("5.2 Enforces 0 raw emojis across all Milestone 3 files", () => {
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

      for (const relPath of targetFiles) {
        const fullPath = path.resolve(process.cwd(), relPath);
        const code = fs.readFileSync(fullPath, "utf-8");
        const matches = code.match(emojiRegex) || [];
        expect(matches.length).toBe(0);
      }
    });

    it("5.3 Enforces presence of .tabular-mono class for numeric rendering across all Milestone 3 files", () => {
      for (const relPath of targetFiles) {
        const fullPath = path.resolve(process.cwd(), relPath);
        const code = fs.readFileSync(fullPath, "utf-8");
        expect(code).toContain("tabular-mono");
      }
    });

    it("5.4 Strictly verifies SHA256 hashes of src/lib/indexer.ts and src/hooks/useEventIndexer.ts", () => {
      const indexerPath = path.resolve(process.cwd(), "src/lib/indexer.ts");
      const hookPath = path.resolve(process.cwd(), "src/hooks/useEventIndexer.ts");

      const indexerSha = crypto.createHash("sha256").update(fs.readFileSync(indexerPath)).digest("hex");
      const hookSha = crypto.createHash("sha256").update(fs.readFileSync(hookPath)).digest("hex");

      expect(indexerSha).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
      expect(hookSha).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
    });
  });
});
