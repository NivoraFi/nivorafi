// frontend/src/lib/__tests__/m3_testnet_faucet.test.tsx
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, beforeEach, afterAll } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ----------------------------------------------------------------------------
// Authentic Harness & AST Inspection Helper (Anti-Facade Protocol)
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

// Mock Next.js navigation for TopNav
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/trade/usdc-90d",
  useParams: () => ({ market: "usdc-90d" }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// Authentic Toast Imports
import {
  ToastProvider,
  useToastContext,
  TxToastItem,
  ToastContextValue,
} from "@/context/ToastContext";
import { Toaster } from "@/components/ui/Toaster";
import { useTxToast, UseTxToastReturn } from "@/hooks/useTxToast";

// Components Under Test
import { TopNav } from "@/components/TopNav";
import {
  TestnetFaucetModal,
  TestnetFaucetModalProps,
} from "@/components/faucet/TestnetFaucetModal";
import {
  TestnetOnboardingBanner,
  TestnetOnboardingBannerProps,
} from "@/components/faucet/TestnetOnboardingBanner";

// ----------------------------------------------------------------------------
// Test Fixtures & Constants
// ----------------------------------------------------------------------------

const TEST_CALLER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const VALID_TX_HASH = "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5";
const CIRCLE_FAUCET_URL = "https://faucet.circle.com";

describe("Milestone 3 Test Suite: Testnet Faucet Modal & Mock Asset Onboarding", () => {
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
  });

  // =========================================================================
  // Tier 1: Component Mount, Dialog State & Accessibility
  // =========================================================================
  describe("Tier 1: Component Mount, Dialog State & Accessibility", () => {
    it("1.1 returns null and unmounts when isOpen is false", () => {
      const html = renderToString(
        React.createElement(TestnetFaucetModal, {
          isOpen: false,
          onClose: () => {},
          address: TEST_CALLER,
        })
      );

      expect(html).toBe("");
    });

    it("1.2 renders modal dialog with valid ARIA attributes when isOpen is true", () => {
      const html = renderToString(
        React.createElement(TestnetFaucetModal, {
          isOpen: true,
          onClose: () => {},
          address: TEST_CALLER,
          accountExists: true,
          xlmBalance: "10000.00",
          usdcBalance: "500.00",
          usdcTrustlineExists: true,
          syBalance: 100_0000000n,
          ptBalance: 50_0000000n,
          ytBalance: 50_0000000n,
        })
      );

      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('aria-labelledby="faucet-modal-title"');
      expect(html).toContain('id="faucet-modal-title"');
      expect(html).toContain("Testnet Asset Faucet");
    });

    it("1.3 close button triggers onClose callback", () => {
      let closeCalled = false;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {
              closeCalled = true;
            },
            address: TEST_CALLER,
          },
        })
      );

      const closeButtons = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          (n.props?.["aria-label"] === "Close modal" ||
            n.props?.["aria-label"] === "Close faucet modal" ||
            n.props?.["aria-label"] === "Close")
      );

      expect(closeButtons.length).toBeGreaterThanOrEqual(1);
      closeButtons[0].props.onClick();
      expect(closeCalled).toBe(true);
    });

    it("1.4 backdrop click triggers onClose callback", () => {
      let closeCalled = false;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {
              closeCalled = true;
            },
            address: TEST_CALLER,
          },
        })
      );

      const backdrops = findElements(
        capturedTree,
        (n) =>
          n.props?.className &&
          n.props.className.includes("backdrop-blur") &&
          typeof n.props.onClick === "function"
      );

      expect(backdrops.length).toBeGreaterThanOrEqual(1);
      backdrops[0].props.onClick();
      expect(closeCalled).toBe(true);
    });

    it("1.5 TestnetOnboardingBanner mounts and triggers onOpenFaucet on CTA click", () => {
      let faucetOpened = false;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetOnboardingBanner,
          props: {
            onOpenFaucet: () => {
              faucetOpened = true;
            },
            accountExists: false,
          },
        })
      );

      const ctaBtn = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          (JSON.stringify(n.props.children).includes("Get Testnet Assets") ||
            JSON.stringify(n.props.children).includes("Open Faucet") ||
            JSON.stringify(n.props.children).includes("Faucet"))
      );

      expect(ctaBtn.length).toBeGreaterThanOrEqual(1);
      ctaBtn[0].props.onClick();
      expect(faucetOpened).toBe(true);
    });

    it("1.6 TestnetOnboardingBanner supports dismiss button", () => {
      let dismissed = false;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetOnboardingBanner,
          props: {
            onOpenFaucet: () => {},
            dismissible: true,
            onDismiss: () => {
              dismissed = true;
            },
          },
        })
      );

      const dismissBtns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.["aria-label"] === "Dismiss banner"
      );

      expect(dismissBtns.length).toBe(1);
      dismissBtns[0].props.onClick();
      expect(dismissed).toBe(true);
    });

    it("1.7 TopNav renders Faucet button when onOpenFaucet is provided and triggers callback", () => {
      let opened = false;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TopNav,
          props: {
            viewMode: "trade",
            onOpenFaucet: () => {
              opened = true;
            },
          },
        })
      );

      const faucetBtns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.title === "Get Testnet Assets (Faucet)"
      );

      expect(faucetBtns.length).toBe(1);
      faucetBtns[0].props.onClick();
      expect(opened).toBe(true);
    });
  });

  // =========================================================================
  // Tier 2: Step Progression & Multi-Step Flow Navigation
  // =========================================================================
  describe("Tier 2: Step Progression & Multi-Step Flow Navigation", () => {
    it("2.1 renders all 5 pipeline onboarding steps with descriptive titles", () => {
      const html = renderToString(
        React.createElement(TestnetFaucetModal, {
          isOpen: true,
          onClose: () => {},
          address: TEST_CALLER,
        })
      );

      expect(html).toContain("Fund XLM Gas");
      expect(html).toContain("Add USDC Trustline");
      expect(html).toContain("Get Testnet USDC");
      expect(html).toContain("Wrap USDC to sy-bUSDC");
      expect(html).toContain("Mint PT &amp; YT Tokens");
    });

    it("2.2 Step 1 button triggers onFundXlm callback", () => {
      let funded = false;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: false,
            onFundXlm: () => {
              funded = true;
            },
          },
        })
      );

      const step1Btns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          JSON.stringify(n.props.children).includes("10,000 XLM")
      );

      expect(step1Btns.length).toBeGreaterThanOrEqual(1);
      step1Btns[0].props.onClick();
      expect(funded).toBe(true);
    });

    it("2.3 Step 2 button triggers onAddUsdcTrustline callback", () => {
      let trustlineAdded = false;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            usdcTrustlineExists: false,
            onAddUsdcTrustline: () => {
              trustlineAdded = true;
            },
          },
        })
      );

      const step2Btns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          JSON.stringify(n.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btns.length).toBeGreaterThanOrEqual(1);
      step2Btns[0].props.onClick();
      expect(trustlineAdded).toBe(true);
    });

    it("2.4 Step 3 renders authentic external anchor for Circle Faucet", () => {
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            usdcTrustlineExists: true,
            usdcBalance: "0.00",
          },
        })
      );

      const circleAnchors = findElements(
        capturedTree,
        (n) =>
          n.type === "a" &&
          n.props?.href &&
          n.props.href.includes("faucet.circle.com")
      );

      expect(circleAnchors.length).toBeGreaterThanOrEqual(1);
      const anchor = circleAnchors[0];
      expect(anchor.props.target).toBe("_blank");
      expect(anchor.props.rel).toContain("noreferrer");
    });

    it("2.4b Step 3 1-click SDEX swap button triggers onSwapXlmForUsdc callback", () => {
      let swapTriggered = false;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000.00",
            usdcTrustlineExists: true,
            usdcBalance: "0.00",
            onSwapXlmForUsdc: () => {
              swapTriggered = true;
            },
          },
        })
      );

      const swapBtns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          JSON.stringify(n.props.children).includes("Swap 100 XLM")
      );

      expect(swapBtns.length).toBeGreaterThanOrEqual(1);
      expect(swapBtns[0].props.disabled).toBe(false);
      swapBtns[0].props.onClick();
      expect(swapTriggered).toBe(true);
    });

    it("2.4c Step 3 SDEX swap button is disabled before Step 2 trustline is done", () => {
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            xlmBalance: "10000.00",
            usdcTrustlineExists: false,
            usdcBalance: "0.00",
          },
        })
      );

      const swapBtns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          JSON.stringify(n.props.children).includes("Swap 100 XLM")
      );

      expect(swapBtns.length).toBeGreaterThanOrEqual(1);
      expect(swapBtns[0].props.disabled).toBe(true);
    });

    it("2.5 Step 4 button triggers onDepositSy callback", () => {
      let depositedAmount: bigint | null = null;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            usdcTrustlineExists: true,
            usdcBalance: "500.00",
            syBalance: 0n,
            onDepositSy: (amt: bigint) => {
              depositedAmount = amt;
            },
          },
        })
      );

      const depositBtns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          JSON.stringify(n.props.children).includes("Deposit")
      );

      expect(depositBtns.length).toBeGreaterThanOrEqual(1);
      depositBtns[0].props.onClick();
      expect(depositedAmount).toBeGreaterThan(0n);
    });

    it("2.6 Step 5 button triggers onMintPy callback", () => {
      let mintedAmount: bigint | null = null;
      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {},
            address: TEST_CALLER,
            accountExists: true,
            usdcTrustlineExists: true,
            usdcBalance: "400.00",
            syBalance: 100_0000000n,
            ptBalance: 0n,
            onMintPy: (amt: bigint) => {
              mintedAmount = amt;
            },
          },
        })
      );

      const mintBtns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          JSON.stringify(n.props.children).includes("Mint")
      );

      expect(mintBtns.length).toBeGreaterThanOrEqual(1);
      mintBtns[0].props.onClick();
      expect(mintedAmount).toBeGreaterThan(0n);
    });

    it("2.7 renders spinner and disables button when busyStep matches active action", () => {
      const html = renderToString(
        React.createElement(TestnetFaucetModal, {
          isOpen: true,
          onClose: () => {},
          address: TEST_CALLER,
          busyStep: "friendbot",
        })
      );

      expect(html).toContain("animate-spin");
      expect(html).toContain("Funding XLM...");
    });

    it("2.7b renders spinner and disables button when busyStep is 'sdex'", () => {
      const html = renderToString(
        React.createElement(TestnetFaucetModal, {
          isOpen: true,
          onClose: () => {},
          address: TEST_CALLER,
          accountExists: true,
          usdcTrustlineExists: true,
          busyStep: "sdex",
        })
      );

      expect(html).toContain("animate-spin");
      expect(html).toContain("Swapping XLM...");
    });

    it("2.8 prepares valid SDEX path payment transaction for XLM -> USDC", async () => {
      const { prepareSwapXlmForUsdcSdexTx } = await import("@/lib/stellar");
      const { TransactionBuilder } = await import("@stellar/stellar-sdk");
      const { STELLAR_PENDLE_CONFIG } = await import("@/lib/contracts");

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes("/accounts/")) {
          return new Response(
            JSON.stringify({
              id: TEST_CALLER,
              account_id: TEST_CALLER,
              sequence: "1000",
              subentry_count: 0,
              balances: [{ asset_type: "native", balance: "1000.00" }],
              signers: [{ key: TEST_CALLER, weight: 1 }],
              thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
              flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 200 });
      };

      try {
        const xdrString = await prepareSwapXlmForUsdcSdexTx(TEST_CALLER, "100", "1");
        expect(typeof xdrString).toBe("string");
        const tx = TransactionBuilder.fromXDR(xdrString, STELLAR_PENDLE_CONFIG.networkPassphrase) as any;
        expect(tx.operations.length).toBe(1);
        expect(tx.operations[0].type).toBe("pathPaymentStrictSend");
        expect(tx.operations[0].sendAsset.isNative()).toBe(true);
        expect(tx.operations[0].sendAmount).toBe("100.0000000");
        expect(tx.operations[0].destAsset.getCode()).toBe("USDC");
        expect(tx.operations[0].destAsset.getIssuer()).toBe(STELLAR_PENDLE_CONFIG.market.underlyingAsset.issuer);
        expect(tx.operations[0].destMin).toBe("1.0000000");
        expect(tx.operations[0].destination).toBe(TEST_CALLER);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // =========================================================================
  // Tier 3: Integration, Toasts & Balance Typography
  // =========================================================================
  describe("Tier 3: Integration, Toasts & Balance Typography", () => {
    it("3.1 triggers pending, confirming, and success toasts on testnet onboarding actions", () => {
      let toastApi!: UseTxToastReturn;

      function TestConsumer() {
        toastApi = useTxToast();
        return null;
      }

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(TestConsumer),
          React.createElement(Toaster)
        )
      );

      // Simulate Faucet Step 1 Friendbot Toast
      const friendbotToastId = toastApi.notifyPending({
        title: "Friendbot Funding",
        description: "Requesting 10,000 testnet XLM...",
      });
      expect(toastApi.toasts.length).toBe(1);
      expect(toastApi.toasts[0].status).toBe("PENDING");

      toastApi.notifySuccess(friendbotToastId, {
        title: "Friendbot Funded 10,000 XLM",
        description: "Account created and gas funded.",
      });
      expect(toastApi.toasts[0].status).toBe("SUCCESS");

      // Simulate Faucet Step 2 Trustline Toast with Explorer link
      const trustlineToastId = toastApi.notifyPending({
        title: "Add USDC Trustline",
      });
      toastApi.notifyConfirming(trustlineToastId, {
        txHash: VALID_TX_HASH,
        title: "Establishing USDC Trustline...",
      });
      const confirmingToast = toastApi.toasts.find((t) => t.id === trustlineToastId);
      expect(confirmingToast?.status).toBe("CONFIRMING");
      expect(confirmingToast?.explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH}`
      );

      toastApi.notifySuccess(trustlineToastId, {
        txHash: VALID_TX_HASH,
        title: "USDC Trustline Established",
      });
      const successToast = toastApi.toasts.find((t) => t.id === trustlineToastId);
      expect(successToast?.status).toBe("SUCCESS");
    });

    it("3.2 formats all live asset balances with tabular-mono font-mono", () => {
      const html = renderToString(
        React.createElement(TestnetFaucetModal, {
          isOpen: true,
          onClose: () => {},
          address: TEST_CALLER,
          accountExists: true,
          xlmBalance: "10000.00",
          usdcBalance: "1500.50",
          syBalance: 250_0000000n,
          ptBalance: 100_0000000n,
          ytBalance: 100_0000000n,
        })
      );

      expect(html).toContain("tabular-mono");
      expect(html).toContain("font-mono");
      expect(html).toContain("10,000.00");
      expect(html).toContain("1,500.50");
      expect(html).toContain("250.00");
      expect(html).toContain("100.00");
    });

    it("3.3 displays Connect Wallet prompt and disables actions when wallet is disconnected", () => {
      const html = renderToString(
        React.createElement(TestnetFaucetModal, {
          isOpen: true,
          onClose: () => {},
          address: null,
        })
      );

      expect(html).toContain("Connect Wallet");
      expect(html).toContain("Connect your Stellar wallet to get testnet assets");
    });

    it("3.4 displays network mismatch warning when connected to wrong network", () => {
      mockWalletState.walletNetworkMismatch = true;

      const html = renderToString(
        React.createElement(TestnetFaucetModal, {
          isOpen: true,
          onClose: () => {},
          address: TEST_CALLER,
          walletNetworkMismatch: true,
        })
      );

      expect(html).toContain("Network Mismatch");
      expect(html).toContain("Testnet");
    });
  });

  // =========================================================================
  // Tier 4: Design System Compliance & Checksum Integrity Matrix
  // =========================================================================
  describe("Tier 4: Design System Compliance & Checksum Integrity Matrix", () => {
    const TARGET_COMPONENT_PATHS = [
      path.join(FRONTEND_DIR, "src/components/faucet/TestnetFaucetModal.tsx"),
      path.join(FRONTEND_DIR, "src/components/faucet/TestnetOnboardingBanner.tsx"),
      path.join(FRONTEND_DIR, "src/components/TopNav.tsx"),
    ];

    it("4.1 contains zero raw hex color codes across all faucet components", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;

      for (const filePath of TARGET_COMPONENT_PATHS) {
        if (!fs.existsSync(filePath)) continue;
        const code = fs.readFileSync(filePath, "utf-8");
        const lines = code.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

          const matches = line.match(rawHexRegex);
          if (matches) {
            expect({
              file: path.basename(filePath),
              line: i + 1,
              matches,
            }).toEqual({
              file: path.basename(filePath),
              line: i + 1,
              matches: [],
            });
          }
        }
      }
    });

    it("4.2 contains zero raw Unicode emojis across all faucet components", () => {
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

      for (const filePath of TARGET_COMPONENT_PATHS) {
        if (!fs.existsSync(filePath)) continue;
        const code = fs.readFileSync(filePath, "utf-8");
        const lines = code.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

          const hasEmoji = emojiRegex.test(line);
          expect({
            file: path.basename(filePath),
            line: i + 1,
            hasEmoji,
          }).toEqual({
            file: path.basename(filePath),
            line: i + 1,
            hasEmoji: false,
          });
        }
      }
    });

    it("4.3 verifies tabular-mono font-mono on all balance presentations", () => {
      for (const filePath of TARGET_COMPONENT_PATHS) {
        if (!fs.existsSync(filePath)) continue;
        const code = fs.readFileSync(filePath, "utf-8");
        if (filePath.includes("TestnetFaucetModal")) {
          expect(code).toContain("tabular-mono");
          expect(code).toContain("font-mono");
        }
      }
    });

    it("4.4 preserves SHA256 checksums of locked files without modification", () => {
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

  afterAll(() => {
    mock.restore();
  });
});
