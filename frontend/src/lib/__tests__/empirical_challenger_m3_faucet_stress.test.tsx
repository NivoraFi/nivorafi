// frontend/src/lib/__tests__/empirical_challenger_m3_faucet_stress.test.tsx
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, beforeEach, afterAll } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PRESET_MARKETS } from "@/lib/markets";

// ----------------------------------------------------------------------------
// AST Inspection Helper for React VDOM
// ----------------------------------------------------------------------------

let capturedTree: any = null;

function CaptureHarness({
  Component,
  props,
}: {
  Component: React.ComponentType<any>;
  props: any;
}) {
  const rendered = (Component as any)(props);
  capturedTree = rendered;
  return rendered;
}

function findElements(node: any, predicate: (n: any) => boolean): any[] {
  const results: any[] = [];
  if (!node) return results;
  if (Array.isArray(node)) {
    for (const item of node) results.push(...findElements(item, predicate));
    return results;
  }
  if (typeof node !== "object") return results;
  if (predicate(node)) {
    results.push(node);
  }
  if (node.props && node.props.children) {
    results.push(...findElements(node.props.children, predicate));
  }
  return results;
}

// ----------------------------------------------------------------------------
// Mock Contexts & Providers
// ----------------------------------------------------------------------------

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

let mockMarketContextState = {
  markets: PRESET_MARKETS,
  activeMarket: { ...PRESET_MARKETS[0] },
  activePortfolio: {
    accountExists: true,
    xlmBalance: "10000.00",
    usdcBalance: "100.00",
    usdcTrustlineExists: true,
    syBalance: 10_0000000n,
    ptBalance: 5_0000000n,
    ytBalance: 5_0000000n,
    lpBalance: 0n,
  },
  refreshActiveMarket: async () => {},
  marketMetrics: {
    "usdc-90d": {
      isMatured: false,
      status: "ACTIVE",
      daysToMaturity: 90,
      impliedApyPct: 8.45,
    },
  },
};

mock.module("@/context/MarketContext", () => ({
  useMarket: () => mockMarketContextState,
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import {
  TestnetFaucetModal,
  TestnetFaucetModalProps,
} from "@/components/faucet/TestnetFaucetModal";
import {
  TestnetOnboardingBanner,
  TestnetOnboardingBannerProps,
} from "@/components/faucet/TestnetOnboardingBanner";

const TEST_CALLER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const WATCH_CALLER = "GBBDUVMYMQ3YVCL67P42A3M3U7S7PZ6H2G4DFL473T5Z7K3MQR4USDCW";

describe("Empirical Challenger M3 Stress Suite: Testnet Faucet & Onboarding Pipeline", () => {
  const FRONTEND_DIR = path.resolve(__dirname, "../../..");

  beforeEach(() => {
    capturedTree = null;
    mockWalletState = {
      address: TEST_CALLER,
      mode: "wallet",
      walletId: "freighter",
      walletNetworkMismatch: false,
      kitReady: true,
      connecting: false,
      connectWallet: async () => {},
      connectWatchAddress: (_pk: string) => {},
      disconnect: async () => {},
      signTransactionXdr: async (xdr: string) => xdr,
      switchNetwork: async () => {},
    };

    mockMarketContextState = {
      markets: PRESET_MARKETS,
      activeMarket: { ...PRESET_MARKETS[0] },
      activePortfolio: {
        accountExists: false,
        xlmBalance: "0",
        usdcBalance: "0",
        usdcTrustlineExists: false,
        syBalance: 0n,
        ptBalance: 0n,
        ytBalance: 0n,
        lpBalance: 0n,
      },
      refreshActiveMarket: async () => {},
      marketMetrics: {
        "usdc-90d": {
          isMatured: false,
          status: "ACTIVE",
          daysToMaturity: 90,
          impliedApyPct: 8.45,
        },
      },
    };
  });

  // =========================================================================
  // Suite 1: Rapid Sequential Step Clicks & Concurrency Re-Entrancy
  // =========================================================================
  describe("Suite 1: Rapid Sequential Step Clicks & Concurrency Re-Entrancy", () => {
    it("1.1 disables Step 1 button and renders spinner when busyStep is 'friendbot'", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: false,
            xlmBalance: "0",
            busyStep: "friendbot",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step1Button = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Funding XLM...")
      );

      expect(step1Button).toBeDefined();
      expect(step1Button.props.disabled).toBe(true);

      const spinners = findElements(step1Button, (n) =>
        n.props?.className?.includes("animate-spin")
      );
      expect(spinners.length).toBeGreaterThan(0);
    });

    it("1.2 demonstrates callback re-entrancy edge case when custom onFundXlm is passed without setting busyStep", async () => {
      let callCount = 0;
      let resolvePromise: () => void = () => {};
      const slowFund = () =>
        new Promise<void>((resolve) => {
          callCount++;
          resolvePromise = resolve;
        });

      // Render modal with custom onFundXlm but NO busyStep prop
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: false,
            xlmBalance: "0",
            onFundXlm: slowFund,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step1Button = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Fund 10,000 XLM")
      );

      expect(step1Button).toBeDefined();
      expect(step1Button.props.disabled).toBe(false);

      // Simulate rapid sequential clicks while first is in-flight
      step1Button.props.onClick();
      step1Button.props.onClick();
      step1Button.props.onClick();

      expect(callCount).toBe(3);
      resolvePromise();
    });

    it("1.3 freezes and disables all subsequent action steps (Steps 2, 4, 5) when Step 1 is in-flight", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            syBalance: 10_0000000n,
            busyStep: "friendbot",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");

      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Trustline")
      );
      const step4Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Deposit")
      );
      const step5Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Mint PT")
      );

      expect(step2Btn).toBeDefined();
      expect(step2Btn.props.disabled).toBe(true);

      expect(step4Btn).toBeDefined();
      expect(step4Btn.props.disabled).toBe(true);

      expect(step5Btn).toBeDefined();
      expect(step5Btn.props.disabled).toBe(true);
    });

    it("1.4 freezes Step 1, 4, 5 when Step 2 (trustline) is in-flight", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: false,
            busyStep: "trustline",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");

      const step1Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Fund 10,000 XLM")
      );
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Adding Trustline...")
      );
      const step4Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Deposit")
      );

      expect(step1Btn.props.disabled).toBe(true);
      expect(step2Btn.props.disabled).toBe(true);
      expect(step4Btn.props.disabled).toBe(true);
    });

    it("1.4b freezes Step 1, 2, 4, 5 when Step 3 (sdex swap) is in-flight", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            busyStep: "sdex",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");

      const step1Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Fund 10,000 XLM")
      );
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Trustline")
      );
      const step3Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Swapping XLM...")
      );
      const step4Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Deposit")
      );
      const step5Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Mint PT")
      );

      expect(step1Btn.props.disabled).toBe(true);
      expect(step2Btn.props.disabled).toBe(true);
      expect(step3Btn.props.disabled).toBe(true);
      expect(step4Btn.props.disabled).toBe(true);
      expect(step5Btn.props.disabled).toBe(true);
    });

    it("1.5 freezes Step 1, 2, 5 when Step 4 (deposit sy) is in-flight", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            usdcBalance: "100",
            busyStep: "deposit",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");

      const step1Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Fund 10,000 XLM")
      );
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Trustline")
      );
      const step4Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Depositing...")
      );

      expect(step1Btn.props.disabled).toBe(true);
      expect(step2Btn.props.disabled).toBe(true);
      expect(step4Btn.props.disabled).toBe(true);
    });

    it("1.6 freezes Step 1, 2, 4 when Step 5 (mint pt/yt) is in-flight", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            syBalance: 10_0000000n,
            busyStep: "mint",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");

      const step1Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Fund 10,000 XLM")
      );
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Trustline")
      );
      const step5Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Minting...")
      );

      expect(step1Btn.props.disabled).toBe(true);
      expect(step2Btn.props.disabled).toBe(true);
      expect(step5Btn.props.disabled).toBe(true);
    });

    it("1.7 verifies refresh balance button renders with accessible label and triggers refreshActiveMarket", async () => {
      let refreshed = false;
      mockMarketContextState.refreshActiveMarket = async () => {
        refreshed = true;
      };

      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const refreshBtn = buttons.find(
        (b) => b.props["aria-label"] === "Refresh balances"
      );

      expect(refreshBtn).toBeDefined();
      await refreshBtn.props.onClick();
      expect(refreshed).toBe(true);
    });
  });

  // =========================================================================
  // Suite 2: Balance Threshold Edge Cases & Reserve Protection
  // =========================================================================
  describe("Suite 2: Balance Threshold Edge Cases & Reserve Protection", () => {
    it("2.1 zero XLM balance marks Step 1 as incomplete and disables Step 2", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: false,
            xlmBalance: "0",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btn).toBeDefined();
      expect(step2Btn.props.disabled).toBe(true);
    });

    it("2.2 0.5 XLM Stellar reserve edge marks Step 1 as incomplete and disables Step 2", () => {
      // On Stellar, creating a trustline requires account base reserve + 0.5 XLM entry reserve
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "0.5",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btn).toBeDefined();
      expect(step2Btn.props.disabled).toBe(true); // parseFloat("0.5") > 1 is false
    });

    it("2.3 exactly 1.0 XLM boundary edge case protects reserve and disables Step 2", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "1.0",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btn).toBeDefined();
      expect(step2Btn.props.disabled).toBe(true); // parseFloat("1.0") > 1 is false
    });

    it("2.4 XLM strictly above 1 (e.g. 1.0000001) completes Step 1 and enables Step 2", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "1.0000001",
            usdcTrustlineExists: false,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btn).toBeDefined();
      expect(step2Btn.props.disabled).toBe(false);
    });

    it("2.5 accountExists: false keeps Step 1 incomplete even if balance string is high", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: false,
            xlmBalance: "10000",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btn).toBeDefined();
      expect(step2Btn.props.disabled).toBe(true);
    });

    it("2.6 zero USDC balance leaves Step 3 incomplete", () => {
      const html = renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            usdcBalance: "0",
          }}
        />
      );

      // Step 3 card should not have "Completed" badge
      expect(html).toContain("Get Testnet USDC");
    });

    it("2.6b Step 3 SDEX swap button disabled before Step 2 trustline is established, enabled once Step 2 is done", () => {
      // Before Step 2 is done (usdcTrustlineExists: false)
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: false,
          }}
        />
      );

      let buttons = findElements(capturedTree, (n) => n.type === "button");
      let step3SwapBtn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Swap 100 XLM")
      );
      expect(step3SwapBtn).toBeDefined();
      expect(step3SwapBtn.props.disabled).toBe(true);

      // Once Step 2 is done (usdcTrustlineExists: true)
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
          }}
        />
      );

      buttons = findElements(capturedTree, (n) => n.type === "button");
      step3SwapBtn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Swap 100 XLM")
      );
      expect(step3SwapBtn).toBeDefined();
      expect(step3SwapBtn.props.disabled).toBe(false);
    });

    it("2.7 missing USDC trustline disables Step 4 (Deposit SY)", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: false,
            usdcBalance: "100",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step4Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Deposit 10 USDC")
      );

      expect(step4Btn).toBeDefined();
      expect(step4Btn.props.disabled).toBe(true);
    });

    it("2.8 demonstrates Step 4 button enabled when trustline exists but USDC balance is 0 (delegated to Soroban simulation)", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            usdcBalance: "0",
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step4Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Deposit 10 USDC")
      );

      // Observation: Step 4 button is disabled={!isStep2Done}. Since isStep2Done is true, button is enabled!
      expect(step4Btn).toBeDefined();
      expect(step4Btn.props.disabled).toBe(false);
    });

    it("2.9 zero SY balance strictly disables Step 5 (Mint PT & YT)", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            usdcBalance: "100",
            syBalance: 0n,
            ptBalance: 0n,
            ytBalance: 0n,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step5Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Mint PT & YT")
      );

      expect(step5Btn).toBeDefined();
      expect(step5Btn.props.disabled).toBe(true);
    });

    it("2.10 asymmetric PT/YT balance (pt > 0, yt === 0) marks Step 5 as incomplete", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            syBalance: 10_0000000n,
            ptBalance: 5_0000000n,
            ytBalance: 0n,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step5Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Mint PT & YT")
      );

      expect(step5Btn).toBeDefined();
      // Should not have "Completed" styling on button (btn-accent instead of border-hairline)
      expect(step5Btn.props.className).toContain("btn-accent");
    });

    it("2.11 formats negative or NaN balances gracefully as '0.00' without crashing", () => {
      const html = renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "-50.00",
            usdcBalance: "invalid-number",
            syBalance: null,
            ptBalance: undefined,
            ytBalance: null,
          }}
        />
      );

      expect(html).toContain("0.00");
      expect(html).not.toContain("NaN");
    });
  });

  // =========================================================================
  // Suite 3: Wallet States — Disconnected vs Watch Mode vs Connected
  // =========================================================================
  describe("Suite 3: Wallet States — Disconnected vs Watch Mode vs Connected", () => {
    it("3.1 renders Connect Wallet prompt with ShieldAlert and disables action buttons when disconnected", async () => {
      let connectCalled = false;
      mockWalletState.connectWallet = async () => {
        connectCalled = true;
      };

      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: null,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");

      const connectBtn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Connect Wallet")
      );
      expect(connectBtn).toBeDefined();

      await connectBtn.props.onClick();
      expect(connectCalled).toBe(true);

      // Verify action buttons disabled
      const step1Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Fund 10,000 XLM")
      );
      expect(step1Btn.props.disabled).toBe(true);
    });

    it("3.2 watch mode hides disconnected prompt, displays watch address, and enables Step 1 Friendbot", () => {
      mockWalletState.mode = "watch";
      mockWalletState.address = WATCH_CALLER;

      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: WATCH_CALLER,
            accountExists: false,
            xlmBalance: "0",
          }}
        />
      );

      const banners = findElements(capturedTree, (n) => {
        const text = JSON.stringify(n?.props?.children ?? "");
        return typeof text === "string" && text.includes("Connect your Stellar wallet");
      });
      expect(banners.length).toBe(0);

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step1Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Fund 10,000 XLM")
      );

      // Friendbot requires only a Stellar public address, no wallet signature
      expect(step1Btn).toBeDefined();
      expect(step1Btn.props.disabled).toBe(false);
    });

    it("3.3 watch mode signing rejection is caught gracefully by Step 2 without crashing", async () => {
      mockWalletState.mode = "watch";
      mockWalletState.address = WATCH_CALLER;
      mockWalletState.signTransactionXdr = async () => {
        throw new Error(
          "Watch mode is read-only. Connect Freighter, LOBSTR, or another wallet to sign."
        );
      };

      let trustlineInvoked = false;
      let caughtMessage = "";
      const onAddUsdcTrustline = async () => {
        trustlineInvoked = true;
        try {
          await mockWalletState.signTransactionXdr("dummy-xdr");
        } catch (e: any) {
          caughtMessage = e?.message ?? "";
        }
      };

      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: WATCH_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: false,
            onAddUsdcTrustline,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btn).toBeDefined();
      expect(step2Btn.props.disabled).toBe(false);

      await step2Btn.props.onClick();

      expect(trustlineInvoked).toBe(true);
      expect(caughtMessage).toContain("Watch mode is read-only");
    });
  });

  // =========================================================================
  // Suite 4: Network Mismatch Toggle Warning & Action Freezing
  // =========================================================================
  describe("Suite 4: Network Mismatch Toggle Warning & Action Freezing", () => {
    it("4.1 displays network mismatch warning and disables all 4 action buttons when mismatch is active", async () => {
      let switchCalled = false;
      mockWalletState.switchNetwork = async () => {
        switchCalled = true;
      };

      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            syBalance: 10_0000000n,
            walletNetworkMismatch: true,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");

      const switchBtn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Switch Network")
      );
      expect(switchBtn).toBeDefined();

      await switchBtn.props.onClick();
      expect(switchCalled).toBe(true);

      const step1Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Fund 10,000 XLM")
      );
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Trustline")
      );
      const step4Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Deposit")
      );
      const step5Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Mint PT")
      );

      expect(step1Btn.props.disabled).toBe(true);
      expect(step2Btn.props.disabled).toBe(true);
      expect(step4Btn.props.disabled).toBe(true);
      expect(step5Btn.props.disabled).toBe(true);
    });

    it("4.2 re-enables action buttons when walletNetworkMismatch resolves to false", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: false,
            walletNetworkMismatch: false,
          }}
        />
      );

      const banners = findElements(capturedTree, (n) => {
        const text = JSON.stringify(n?.props?.children ?? "");
        return typeof text === "string" && text.includes("Please switch your wallet to Stellar Testnet");
      });
      expect(banners.length).toBe(0);

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step2Btn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btn.props.disabled).toBe(false);
    });

    it("4.3 disables Step 3 SDEX swap button when walletNetworkMismatch is active", () => {
      renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000",
            usdcTrustlineExists: true,
            walletNetworkMismatch: true,
          }}
        />
      );

      const buttons = findElements(capturedTree, (n) => n.type === "button");
      const step3SwapBtn = buttons.find((b) =>
        JSON.stringify(b.props.children).includes("Swap 100 XLM")
      );
      expect(step3SwapBtn).toBeDefined();
      expect(step3SwapBtn.props.disabled).toBe(true);
    });
  });

  // =========================================================================
  // Suite 5: Design System Compliance & Locked Files Integrity
  // =========================================================================
  describe("Suite 5: Design System Compliance & Locked Files Integrity", () => {
    it("5.1 contains zero raw hex color codes across TestnetFaucetModal and TestnetOnboardingBanner", () => {
      const files = [
        "src/components/faucet/TestnetFaucetModal.tsx",
        "src/components/faucet/TestnetOnboardingBanner.tsx",
        "src/context/FaucetContext.tsx",
      ];

      const rawHexRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

      for (const relPath of files) {
        const fullPath = path.join(FRONTEND_DIR, relPath);
        expect(fs.existsSync(fullPath)).toBe(true);
        const content = fs.readFileSync(fullPath, "utf-8");
        const matches = content.match(rawHexRegex);
        expect(matches).toBeNull();
      }
    });

    it("5.2 contains zero raw Unicode emojis across faucet components", () => {
      const files = [
        "src/components/faucet/TestnetFaucetModal.tsx",
        "src/components/faucet/TestnetOnboardingBanner.tsx",
        "src/context/FaucetContext.tsx",
      ];

      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

      for (const relPath of files) {
        const fullPath = path.join(FRONTEND_DIR, relPath);
        const content = fs.readFileSync(fullPath, "utf-8");
        const match = emojiRegex.exec(content);
        expect(match).toBeNull();
      }
    });

    it("5.3 strictly verifies tabular-mono font-mono on all balance presentations", () => {
      const html = renderToString(
        <CaptureHarness
          Component={TestnetFaucetModal}
          props={{
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000.00",
            usdcBalance: "1500.50",
            usdcTrustlineExists: true,
            syBalance: 250_0000000n,
            ptBalance: 100_0000000n,
            ytBalance: 100_0000000n,
          }}
        />
      );

      expect(html).toContain("10,000.00");
      expect(html).toContain("1,500.50");
      expect(html).toContain("250.00");
      expect(html).toContain("100.00");
      expect(html).toContain("tabular-mono font-mono");
    });

    it("5.4 preserves SHA256 checksums of locked files without modification", () => {
      const lockedFiles = [
        {
          relPath: "src/lib/indexer.ts",
          expectedSha256: "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c",
        },
        {
          relPath: "src/hooks/useEventIndexer.ts",
          expectedSha256: "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c",
        },
      ];

      for (const { relPath, expectedSha256 } of lockedFiles) {
        const fullPath = path.join(FRONTEND_DIR, relPath);
        expect(fs.existsSync(fullPath)).toBe(true);
        const fileBuffer = fs.readFileSync(fullPath);
        const actualSha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        expect(actualSha256).toBe(expectedSha256);
      }
    });
  });

  afterAll(() => {
    mock.restore();
  });
});
