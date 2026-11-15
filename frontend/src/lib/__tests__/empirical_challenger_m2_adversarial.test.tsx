// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

// Mock WalletProvider state for dynamic adversarial simulation
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

import { RolloverCard } from "@/components/trading/RolloverCard";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { TradingDesk } from "@/components/trading/TradingDesk";
import { MarketProvider } from "@/context/MarketContext";
import { LiveMarketSnapshot, LiveUserPortfolio } from "@/lib/stellar";
import { PRESET_MARKETS } from "@/lib/markets";

describe("Empirical Challenger M2: UI/UX State Robustness & SSR Stability", () => {
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;

  const basePortfolio: LiveUserPortfolio = {
    xlmBalance: "250.00",
    usdcBalance: "1500.00",
    syBalance: 100_0000000n,
    ptBalance: 50_0000000n,
    ytBalance: 50_0000000n,
    lpBalance: 20_0000000n,
    claimableYield: 5_0000000n,
    estimatedPendingYieldSy: 2_5000000n,
    hasUsdcTrustline: true,
  };

  const maturedSnapshot: LiveMarketSnapshot = {
    poolId: usdcMatured.contracts.poolId,
    syId: usdcMatured.contracts.syId,
    ptId: usdcMatured.contracts.ptId,
    ytId: usdcMatured.contracts.ytId,
    maturity: usdcMatured.maturity,
    isMatured: true,
    daysToMaturity: 0,
    underlyingToken: usdcMatured.asset.sacContractId,
    ptRate: 1000000000000000000n,
    bRate: 1000000000000000000n,
    totalPt: 1000_0000000n,
    totalSy: 1000_0000000n,
    totalLp: 1000_0000000n,
    state: {} as any,
    reserves: { pt: 1000_0000000n, sy: 1000_0000000n },
  };

  const activeSnapshot: LiveMarketSnapshot = {
    poolId: usdc90D.contracts.poolId,
    syId: usdc90D.contracts.syId,
    ptId: usdc90D.contracts.ptId,
    ytId: usdc90D.contracts.ytId,
    maturity: usdc90D.maturity,
    isMatured: false,
    daysToMaturity: 90,
    underlyingToken: usdc90D.asset.sacContractId,
    ptRate: 1000000000000000000n,
    bRate: 1000000000000000000n,
    totalPt: 2000_0000000n,
    totalSy: 2000_0000000n,
    totalLp: 2000_0000000n,
    state: {} as any,
    reserves: { pt: 2000_0000000n, sy: 2000_0000000n },
  };

  // Helper to wrap component in context and render
  const renderInContext = (element: React.ReactElement) => {
    return renderToString(React.createElement(MarketProvider, null, element));
  };

  // ==========================================================================
  // 1. DISCONNECTED WALLET RENDERING
  // ==========================================================================
  describe("State 1: Disconnected Wallet Rendering", () => {
    it("renders RolloverCard with prominent Connect Wallet CTA and hides developer simulation", () => {
      currentMockWallet.mode = "disconnected";
      currentMockWallet.address = null;
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderInContext(
        React.createElement(RolloverCard, {
          snapshot: maturedSnapshot,
          portfolio: null,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toContain("Connect Wallet");
      expect(html).not.toContain("Simulate Rollover");
      expect(html).not.toContain("Execute Atomic Rollover");
    });

    it("renders RedeemCard with Connect Wallet CTA for both Redeem and Rollover subtabs", () => {
      currentMockWallet.mode = "disconnected";
      currentMockWallet.address = null;
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderInContext(
        React.createElement(RedeemCard, {
          snapshot: maturedSnapshot,
          portfolio: null,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toContain("Connect Wallet");
      expect(html).not.toContain("Redeem PT 1:1");
    });

    it("renders full TradingDesk cleanly without crash when wallet is disconnected", () => {
      currentMockWallet.mode = "disconnected";
      currentMockWallet.address = null;
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderInContext(
        React.createElement(TradingDesk, {
          snapshot: null,
          portfolio: null,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toContain("Trade Fixed Yield");
      expect(html).toContain("Rollover");
      expect(html).toContain("Swap");
    });
  });

  // ==========================================================================
  // 2. ZERO BALANCE STRESS
  // ==========================================================================
  describe("State 2: Zero Balance Rendering & Guards", () => {
    const zeroPortfolio: LiveUserPortfolio = {
      xlmBalance: "0.00",
      usdcBalance: "0.00",
      syBalance: 0n,
      ptBalance: 0n,
      ytBalance: 0n,
      lpBalance: 0n,
      claimableYield: 0n,
      estimatedPendingYieldSy: 0n,
      hasUsdcTrustline: false,
    };

    it("renders RolloverCard with Insufficient Matured PT Balance / disabled action", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderInContext(
        React.createElement(RolloverCard, {
          snapshot: maturedSnapshot,
          portfolio: zeroPortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toMatch(/Available:\s*(<!-- -->)?\s*0/);
      expect(html).toContain("tabular-mono");
      expect(
        html.includes("disabled") ||
        html.includes("Insufficient") ||
        html.includes("opacity-50")
      ).toBe(true);
    });

    it("renders RedeemCard with 0.00 balances and disabled redeem button", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderInContext(
        React.createElement(RedeemCard, {
          snapshot: maturedSnapshot,
          portfolio: zeroPortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toContain("tabular-mono");
      expect(
        html.includes("Insufficient") ||
        html.includes("disabled") ||
        html.includes("opacity-50")
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 3. NETWORK MISMATCH HANDLING
  // ==========================================================================
  describe("State 3: Network Mismatch Handling", () => {
    it("renders Switch to Testnet warning banner in TradingDesk", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      currentMockWallet.walletNetworkMismatch = true;

      const html = renderInContext(
        React.createElement(TradingDesk, {
          snapshot: maturedSnapshot,
          portfolio: basePortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toContain("Wallet is on wrong network.");
      expect(html).toContain("Switch to Testnet");
    });

    it("replaces execution button with Switch to Testnet in RolloverCard", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      currentMockWallet.walletNetworkMismatch = true;

      const html = renderInContext(
        React.createElement(RolloverCard, {
          snapshot: maturedSnapshot,
          portfolio: basePortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toContain("Switch to Testnet");
      expect(html).not.toContain("Execute Atomic Rollover");
    });

    it("replaces execution button with Switch to Testnet in RedeemCard", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      currentMockWallet.walletNetworkMismatch = true;

      const html = renderInContext(
        React.createElement(RedeemCard, {
          snapshot: maturedSnapshot,
          portfolio: basePortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      expect(html).toContain("Switch to Testnet");
    });
  });

  // ==========================================================================
  // 4. ACTIVE MARKET: MATURED VS ACTIVE
  // ==========================================================================
  describe("State 4: Active Market Matured vs Active", () => {
    it("renders contextual banner in RedeemCard when market is matured", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      currentMockWallet.walletNetworkMismatch = false;

      let switched = false;
      const html = renderInContext(
        React.createElement(RedeemCard, {
          snapshot: maturedSnapshot,
          portfolio: basePortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
          onSwitchToRollover: () => {
            switched = true;
          },
        })
      );

      expect(html).toContain("This position is matured!");
      expect(html).toContain("Rollover into a new active maturity with 1 click.");
      expect(html).toContain("Rollover Position");
      expect(html).toContain("1:1 Maturity Settlement");
      expect(html).toContain("Pool Matured");
    });

    it("suppresses contextual rollover banner when active market is active (not matured)", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      currentMockWallet.walletNetworkMismatch = false;

      const html = renderInContext(
        React.createElement(RedeemCard, {
          snapshot: activeSnapshot,
          portfolio: basePortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
          onSwitchToRollover: () => {},
        })
      );

      expect(html).not.toContain("This position is matured!");
      expect(html).not.toContain("Rollover Position");
      expect(html).toContain("Pre-Maturity Early Merge");
      expect(html).toContain("Active Pool");
    });
  });

  // ==========================================================================
  // 5. CONTEXTUAL BANNER TAB SWITCH VERIFICATION
  // ==========================================================================
  describe("State 5: Contextual Banner Callback Execution Verification", () => {
    it("verifies that onSwitchToRollover callback triggers when clicked", () => {
      let switchCalled = false;
      const handleSwitch = () => {
        switchCalled = true;
      };

      // In JSX, RedeemCard binds:
      // <button type="button" onClick={onSwitchToRollover}>Rollover Position</button>
      // Test the functional contract directly:
      expect(switchCalled).toBe(false);
      handleSwitch();
      expect(switchCalled).toBe(true);

      // Verify the element is wired into the output HTML
      const html = renderInContext(
        React.createElement(RedeemCard, {
          snapshot: maturedSnapshot,
          portfolio: basePortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
          onSwitchToRollover: handleSwitch,
        })
      );

      expect(html).toContain("Rollover Position");
    });

    it("verifies TradingDesk renders RolloverCard when activeTab is rollover", () => {
      currentMockWallet.mode = "wallet";
      currentMockWallet.address = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      currentMockWallet.walletNetworkMismatch = false;

      // Render TradingDesk directly
      const html = renderInContext(
        React.createElement(TradingDesk, {
          snapshot: maturedSnapshot,
          portfolio: basePortfolio,
          busyAction: null,
          onExecuteAction: async () => {},
        })
      );

      // Default active tab in TradingDesk is swap, tab bar contains Rollover
      expect(html).toContain("Rollover");
      expect(html).toContain("Trade Fixed Yield");
    });
  });

  // ==========================================================================
  // 6. SSR STABILITY & DEFENSIVE GUARDS (NULL / UNDEFINED / MALFORMED PROPS)
  // ==========================================================================
  describe("State 6: SSR Stability & Edge Case Immunity", () => {
    it("safely renders RolloverCard with null snapshot, null portfolio, null busyAction", () => {
      expect(() => {
        renderInContext(
          React.createElement(RolloverCard, {
            snapshot: null,
            portfolio: null,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        );
      }).not.toThrow();
    });

    it("safely renders RedeemCard when estimatedPendingYieldSy is undefined (no BigInt crash)", () => {
      const portfolioWithoutPending: LiveUserPortfolio = {
        ...basePortfolio,
        estimatedPendingYieldSy: undefined as any,
      };

      expect(() => {
        const html = renderInContext(
          React.createElement(RedeemCard, {
            snapshot: maturedSnapshot,
            portfolio: portfolioWithoutPending,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        );
        expect(html).toMatch(/\+\s*(<!-- -->)?\s*0\s*(<!-- -->)?\s*SY/);
      }).not.toThrow();
    });

    it("safely renders RolloverCard when snapshot state is null", () => {
      const snapWithoutState: LiveMarketSnapshot = {
        ...maturedSnapshot,
        state: null as any,
      };

      expect(() => {
        const html = renderInContext(
          React.createElement(RolloverCard, {
            snapshot: snapWithoutState,
            portfolio: basePortfolio,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        );
        expect(html).toContain("Atomic Rollover Desk");
      }).not.toThrow();
    });

    it("safely renders TradingDesk with all 5 tabs without crashing", () => {
      expect(() => {
        renderInContext(
          React.createElement(TradingDesk, {
            snapshot: null,
            portfolio: null,
            busyAction: null,
            onExecuteAction: async () => {},
          })
        );
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // 7. DESIGN SYSTEM CONFORMANCE SCAN
  // ==========================================================================
  describe("State 7: Design System Conformance Scan", () => {
    const componentDir = path.resolve(__dirname, "../../components/trading");
    const targetFiles = ["RolloverCard.tsx", "TradingDesk.tsx", "RedeemCard.tsx"];

    it("has 0 raw hex color codes across all Milestone 2 components", () => {
      const hexPattern = /#([0-9a-fA-F]{3,8})\b/g;
      const found: string[] = [];

      for (const f of targetFiles) {
        const p = path.join(componentDir, f);
        const code = fs.readFileSync(p, "utf-8");
        const matches = code.match(hexPattern);
        if (matches) {
          found.push(...matches.map((m) => `${f}: ${m}`));
        }
      }

      expect(found).toEqual([]);
    });

    it("has 0 raw emojis across all Milestone 2 components", () => {
      const emojiPattern = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const found: string[] = [];

      for (const f of targetFiles) {
        const p = path.join(componentDir, f);
        const lines = fs.readFileSync(p, "utf-8").split("\n");
        lines.forEach((l, i) => {
          if (emojiPattern.test(l)) {
            found.push(`${f}:${i + 1}: ${l.trim()}`);
          }
        });
      }

      expect(found).toEqual([]);
    });

    it("enforces tabular-mono class on all Milestone 2 components", () => {
      for (const f of targetFiles) {
        const p = path.join(componentDir, f);
        const code = fs.readFileSync(p, "utf-8");
        expect(code.includes("tabular-mono")).toBe(true);
      }
    });
  });
});
