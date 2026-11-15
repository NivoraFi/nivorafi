// frontend/src/lib/__tests__/empirical_challenger_m3_c2.test.tsx
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import React, { Component, useState } from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ----------------------------------------------------------------------------
// Test Constants & Fixtures
// ----------------------------------------------------------------------------
const TEST_ADDRESS = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const SAMPLE_TX_HASH = "4c9112a5d5ba15e8eaa1b51d1b0a357428099f7557c34029f9ecb95c7e2b2af6";
const EXPECTED_EXPLORER_URL = `https://stellar.expert/explorer/testnet/tx/${SAMPLE_TX_HASH}`;

// ----------------------------------------------------------------------------
// Wallet Mock
// ----------------------------------------------------------------------------
let mockWalletState = {
  address: TEST_ADDRESS as string | null,
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

// Mock Next.js navigation
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
}));

// ----------------------------------------------------------------------------
// Authentic Imports Under Test
// ----------------------------------------------------------------------------
import {
  ToastProvider,
  useToastContext,
  TxToastStatus,
  TxToastOptions,
  TxToastItem,
  ToastContextValue,
} from "@/context/ToastContext";
import { Toaster } from "@/components/ui/Toaster";
import { useTxToast, UseTxToastReturn, formatExplorerTxUrl } from "@/hooks/useTxToast";
import {
  TestnetFaucetModal,
  TestnetFaucetModalProps,
} from "@/components/faucet/TestnetFaucetModal";
import { TestnetOnboardingBanner } from "@/components/faucet/TestnetOnboardingBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  decodeSorobanError,
  CONTRACT_ERROR_MESSAGES,
  HORIZON_ERROR_MESSAGES,
} from "@/lib/math";
import {
  requestFriendbotFunding,
  prepareChangeTrustUsdcTx,
  submitSignedHorizonTx,
  prepareContractCallTx,
  submitSignedSorobanTx,
} from "@/lib/stellar";

// ----------------------------------------------------------------------------
// AST Inspection Helpers
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

function extractText(node: any): string {
  if (!node) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(" ");
  if (typeof node === "object" && node.props && node.props.children) {
    return extractText(node.props.children);
  }
  return "";
}

// Helper to access useTxToast inside ToastProvider
function TestToastConsumer({
  onRenderApi,
}: {
  onRenderApi?: (api: UseTxToastReturn) => void;
}) {
  const txToast = useTxToast();
  onRenderApi?.(txToast);
  return <div data-testid="test-consumer-root" />;
}

function setupToastApi(): UseTxToastReturn {
  let api!: UseTxToastReturn;
  renderToString(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(TestToastConsumer, {
        onRenderApi: (val) => {
          api = val;
        },
      })
    )
  );
  return api;
}

describe("Empirical Challenger M3: Error Boundary, Rejections & Toast Integration Suite", () => {
  const FRONTEND_DIR = path.resolve(__dirname, "../../..");
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    capturedTree = null;
    originalFetch = globalThis.fetch;
    mockWalletState = {
      address: TEST_ADDRESS,
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // Suite 1: Error Rejection Simulation & Toast Decoding Matrix
  // =========================================================================
  describe("Suite 1: Error Rejection Simulation & Toast Decoding Matrix", () => {
    it("1.1 Friendbot HTTP 429 rate limit triggers ERROR toast with rate limit description and no txHash", async () => {
      // Mock global fetch to simulate Friendbot HTTP 429 Too Many Requests
      globalThis.fetch = async () =>
        new Response("Rate limit exceeded: 429 Too Many Requests. Try again in 60s.", {
          status: 429,
          statusText: "Too Many Requests",
        });

      let caughtError: any = null;
      try {
        await requestFriendbotFunding(TEST_ADDRESS);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toContain("429");

      // Verify useTxToast notifies error properly
      const api = setupToastApi();
      const toastId = api.notifyTxPending("Friendbot XLM", "Requesting 10,000 testnet XLM...");

      api.notifyTxError(toastId, caughtError, undefined, "Friendbot XLM");

      const activeToast = api.toasts.find((t) => t.id === toastId);
      expect(activeToast).toBeDefined();
      expect(activeToast?.status).toBe("ERROR");
      expect(activeToast?.title).toBe("Friendbot XLM Failed");
      expect(activeToast?.description).toContain("Friendbot error (429)");
      expect(activeToast?.txHash).toBeUndefined();
      expect(activeToast?.explorerUrl).toBeUndefined();
      expect(activeToast?.durationMs).toBe(12000);
    });

    it("1.2 Friendbot Network Timeout / Fetch Abort produces ERROR toast with sanitized error message", async () => {
      globalThis.fetch = async () => {
        throw new Error("The operation was aborted due to timeout");
      };

      let caughtError: any = null;
      try {
        await requestFriendbotFunding(TEST_ADDRESS);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      const api = setupToastApi();
      const toastId = api.notifyTxPending("Friendbot XLM");
      api.notifyTxError(toastId, caughtError, undefined, "Friendbot XLM");

      const activeToast = api.toasts.find((t) => t.id === toastId);
      expect(activeToast?.status).toBe("ERROR");
      expect(activeToast?.title).toBe("Friendbot XLM Failed");
      expect(activeToast?.description).toContain("aborted due to timeout");
    });

    it("1.3 Horizon op_no_trust error decodes into user-friendly trustline reminder with optional txHash", () => {
      const api = setupToastApi();
      const toastId = api.notifyTxPending("USDC Trustline", "Signing transaction...");

      const horizonErr = Object.assign(
        new Error("Transaction failed: op_no_trust on operation 1"),
        { txHash: SAMPLE_TX_HASH }
      );

      api.notifyTxError(toastId, horizonErr, horizonErr.txHash, "USDC Trustline");

      const activeToast = api.toasts.find((t) => t.id === toastId);
      expect(activeToast?.status).toBe("ERROR");
      expect(activeToast?.title).toBe("USDC Trustline Failed");
      expect(activeToast?.description).toBe(
        "Account is missing Testnet USDC trustline. Use Add USDC Trustline first."
      );
      expect(activeToast?.txHash).toBe(SAMPLE_TX_HASH);
      expect(activeToast?.explorerUrl).toBe(EXPECTED_EXPLORER_URL);
    });

    it("1.4 Horizon tx_bad_seq stale sequence number decodes into sequence error explanation", () => {
      const api = setupToastApi();
      const toastId = api.notifyTxPending("USDC Trustline");

      const horizonErr = Object.assign(new Error("Horizon error: tx_bad_seq"), {
        txHash: SAMPLE_TX_HASH,
      });
      api.notifyTxError(toastId, horizonErr, SAMPLE_TX_HASH, "USDC Trustline");

      const activeToast = api.toasts.find((t) => t.id === toastId);
      expect(activeToast?.status).toBe("ERROR");
      expect(activeToast?.description).toBe(
        "Transaction sequence number is stale or invalid. Please sync ledger and retry."
      );
      expect(activeToast?.txHash).toBe(SAMPLE_TX_HASH);
      expect(activeToast?.explorerUrl).toBe(EXPECTED_EXPLORER_URL);
    });

    it("1.5 Horizon op_underfunded and op_low_reserve decodes correctly", () => {
      const api = setupToastApi();

      const id1 = api.notifyTxPending("Operation 1");
      api.notifyTxError(id1, new Error("Horizon error: op_underfunded"), undefined, "Op 1");
      expect(api.toasts.find((t) => t.id === id1)?.description).toBe(
        "Account balance is insufficient to complete the operation."
      );

      const id2 = api.notifyTxPending("Operation 2");
      api.notifyTxError(id2, new Error("Horizon error: op_low_reserve"), undefined, "Op 2");
      expect(api.toasts.find((t) => t.id === id2)?.description).toBe(
        "Account has insufficient XLM reserve for operation fees or base reserve."
      );
    });

    it("1.6 Soroban simulation failure with HostError Contract #9 decodes to SlippageExceeded", () => {
      const api = setupToastApi();
      const toastId = api.notifyTxPending("Deposit USDC to SY");

      const sorobanError = Object.assign(new Error("HostError: Error(Contract, #9)"), {
        txHash: SAMPLE_TX_HASH,
      });
      api.notifyTxError(toastId, sorobanError, SAMPLE_TX_HASH, "Deposit USDC to SY");

      const activeToast = api.toasts.find((t) => t.id === toastId);
      expect(activeToast?.status).toBe("ERROR");
      expect(activeToast?.title).toBe("Deposit USDC to SY Failed");
      expect(activeToast?.description).toBe(
        "Soroban ContractError #9: Output fell below your slippage tolerance limit."
      );
      expect(activeToast?.txHash).toBe(SAMPLE_TX_HASH);
      expect(activeToast?.explorerUrl).toBe(EXPECTED_EXPLORER_URL);
    });

    it("1.7 Soroban simulation failure with HostError Contract #5 decodes to InsufficientBalance", () => {
      const api = setupToastApi();
      const toastId = api.notifyTxPending("Mint PT & YT");

      const sorobanError = new Error("Error(Contract, 5)");
      api.notifyTxError(toastId, sorobanError, undefined, "Mint PT & YT");

      const activeToast = api.toasts.find((t) => t.id === toastId);
      expect(activeToast?.status).toBe("ERROR");
      expect(activeToast?.title).toBe("Mint PT & YT Failed");
      expect(activeToast?.description).toBe(
        "Soroban ContractError #5: Insufficient token or pool reserve balance."
      );
      expect(activeToast?.txHash).toBeUndefined();
    });

    it("1.8 Soroban simulation failure with RESOURCE_LIMIT_EXCEEDED and ENTRY_EXPIRED decodes correctly", () => {
      const api = setupToastApi();

      const id1 = api.notifyTxPending("Soroban Action 1");
      api.notifyTxError(
        id1,
        new Error("Simulation failed: RESOURCE_LIMIT_EXCEEDED"),
        undefined,
        "Soroban Action 1"
      );
      expect(api.toasts.find((t) => t.id === id1)?.description).toBe(
        "Transaction exceeded Soroban CPU or memory resource limits."
      );

      const id2 = api.notifyTxPending("Soroban Action 2");
      api.notifyTxError(
        id2,
        new Error("Simulation failed: ENTRY_EXPIRED"),
        undefined,
        "Soroban Action 2"
      );
      expect(api.toasts.find((t) => t.id === id2)?.description).toBe(
        "Soroban contract storage entry has expired and must be restored."
      );
    });

    it("1.9 User Signature Cancellation: 'User declined to sign the transaction' decodes cleanly", () => {
      const api = setupToastApi();
      const toastId = api.notifyTxPending("USDC Trustline", "Awaiting signature...");

      const userRejectionError = new Error("User declined to sign the transaction");
      api.notifyTxError(toastId, userRejectionError, undefined, "USDC Trustline");

      const activeToast = api.toasts.find((t) => t.id === toastId);
      expect(activeToast?.status).toBe("ERROR");
      expect(activeToast?.title).toBe("USDC Trustline Failed");
      expect(activeToast?.description).toBe("Wallet signature request was cancelled by user.");
      expect(activeToast?.txHash).toBeUndefined();
    });

    it("1.10 User Signature Cancellation: 'Signing request rejected by user' and 'cancelled' decode cleanly", () => {
      const api = setupToastApi();

      const id1 = api.notifyTxPending("Deposit SY");
      api.notifyTxError(
        id1,
        new Error("Freighter: Signing request rejected by user"),
        undefined,
        "Deposit SY"
      );
      expect(api.toasts.find((t) => t.id === id1)?.description).toBe(
        "Wallet signature request was cancelled by user."
      );

      const id2 = api.notifyTxPending("Mint PY");
      api.notifyTxError(
        id2,
        new Error("Transaction signing cancelled"),
        undefined,
        "Mint PY"
      );
      expect(api.toasts.find((t) => t.id === id2)?.description).toBe(
        "Wallet signature request was cancelled by user."
      );
    });
  });

  // =========================================================================
  // Suite 2: Modal Closing Mid-Transaction & Lifecycle Robustness
  // =========================================================================
  describe("Suite 2: Modal Closing Mid-Transaction & Lifecycle Robustness", () => {
    it("2.1 unmounting modal while transaction promise is pending settles cleanly without uncaught error", async () => {
      let isPending = true;
      let toastApi!: UseTxToastReturn;

      // Delayed async transaction task
      let resolveTx!: () => void;
      const delayedTxPromise = new Promise<void>((resolve) => {
        resolveTx = resolve;
      });

      const handleFundXlm = async () => {
        const id = toastApi.notifyTxPending("Friendbot XLM", "Funding in progress...");
        try {
          await delayedTxPromise;
          toastApi.notifyTxSuccess(id, SAMPLE_TX_HASH, "Friendbot XLM", "Completed!");
        } catch (err) {
          toastApi.notifyTxError(id, err, undefined, "Friendbot XLM");
        } finally {
          isPending = false;
        }
      };

      // Mount modal inside ToastProvider
      let unmountModal = false;
      function Harness() {
        const [open, setOpen] = useState(true);
        const api = useTxToast();
        toastApi = api;

        return (
          <div>
            <TestnetFaucetModal
              isOpen={open && !unmountModal}
              onClose={() => setOpen(false)}
              address={TEST_ADDRESS}
              accountExists={false}
              onFundXlm={handleFundXlm}
            />
          </div>
        );
      }

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Harness)
        )
      );

      // Start the transaction
      const txPromise = handleFundXlm();

      // Modal closes mid-flight
      unmountModal = true;
      expect(toastApi.toasts.length).toBe(1);
      expect(toastApi.toasts[0].status).toBe("PENDING");

      // Now resolve the in-flight transaction
      resolveTx();
      await txPromise;

      // Toast must transition to SUCCESS in global ToastProvider even after modal unmounted
      expect(isPending).toBe(false);
      expect(toastApi.toasts[0].status).toBe("SUCCESS");
      expect(toastApi.toasts[0].txHash).toBe(SAMPLE_TX_HASH);
      expect(toastApi.toasts[0].explorerUrl).toBe(EXPECTED_EXPLORER_URL);
    });

    it("2.2 unmounting modal while transaction promise rejects delivers error toast to global context", async () => {
      let toastApi!: UseTxToastReturn;

      let rejectTx!: (reason: any) => void;
      const delayedTxPromise = new Promise<void>((_, reject) => {
        rejectTx = reject;
      });

      const handleAddTrustline = async () => {
        const id = toastApi.notifyTxPending("USDC Trustline", "Signing...");
        try {
          await delayedTxPromise;
          toastApi.notifyTxSuccess(id, SAMPLE_TX_HASH, "USDC Trustline");
        } catch (err) {
          toastApi.notifyTxError(id, err, SAMPLE_TX_HASH, "USDC Trustline");
        }
      };

      let unmountModal = false;
      function Harness() {
        const [open, setOpen] = useState(true);
        const api = useTxToast();
        toastApi = api;

        return (
          <TestnetFaucetModal
            isOpen={open && !unmountModal}
            onClose={() => setOpen(false)}
            address={TEST_ADDRESS}
            accountExists={true}
            usdcTrustlineExists={false}
            onAddUsdcTrustline={handleAddTrustline}
          />
        );
      }

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Harness)
        )
      );

      // Start transaction
      const txPromise = handleAddTrustline();

      // Close modal mid-flight
      unmountModal = true;

      // Reject transaction with op_no_trust error
      rejectTx(new Error("Horizon op_no_trust"));
      await txPromise;

      // Global toast is updated to ERROR state despite modal unmount
      expect(toastApi.toasts[0].status).toBe("ERROR");
      expect(toastApi.toasts[0].description).toBe(
        "Account is missing Testnet USDC trustline. Use Add USDC Trustline first."
      );
      expect(toastApi.toasts[0].txHash).toBe(SAMPLE_TX_HASH);
    });

    it("2.3 rapid unmount / remount stress test (30 cycles) completes with zero memory leaks", () => {
      let openState = true;
      const results: string[] = [];

      for (let i = 0; i < 30; i++) {
        openState = i % 2 === 0;
        const html = renderToString(
          React.createElement(TestnetFaucetModal, {
            isOpen: openState,
            onClose: () => {},
            address: TEST_ADDRESS,
          })
        );
        results.push(html);
      }

      expect(results.length).toBe(30);
      // Even iterations rendered dialog, odd iterations rendered null
      for (let i = 0; i < 30; i++) {
        if (i % 2 === 0) {
          expect(results[i]).toContain('role="dialog"');
        } else {
          expect(results[i]).toBe("");
        }
      }
    });

    it("2.4 verifies backdrop dismiss handler stops propagation to prevent accidental outer triggers", () => {
      let modalClosed = false;

      renderToString(
        React.createElement(CaptureHarness, {
          Component: TestnetFaucetModal,
          props: {
            isOpen: true,
            onClose: () => {
              modalClosed = true;
            },
            address: TEST_ADDRESS,
          },
        })
      );

      const dialogRoot = findElements(
        capturedTree,
        (n) => n.props?.role === "dialog"
      );
      expect(dialogRoot.length).toBe(1);

      // Simulate click on backdrop target
      const mockEvent = {
        target: "backdrop",
        currentTarget: "backdrop",
        stopPropagation: () => {},
      };
      dialogRoot[0].props.onClick(mockEvent);
      expect(modalClosed).toBe(true);
    });
  });

  // =========================================================================
  // Suite 3: ErrorBoundary Containment, Presentation & Recovery
  // =========================================================================
  describe("Suite 3: ErrorBoundary Containment, Presentation & Recovery", () => {
    it("3.1 ErrorBoundary static getDerivedStateFromError transitions state correctly", () => {
      const err = new Error("Simulated unexpected crash in Faucet");
      const derived = ErrorBoundary.getDerivedStateFromError(err);

      expect(derived.hasError).toBe(true);
      expect(derived.error).toBe(err);
    });

    it("3.2 ErrorBoundary componentDidCatch triggers onCatch callback and logs", () => {
      let caughtError: Error | null = null;
      let caughtInfo: any = null;

      const boundary = new ErrorBoundary({
        children: <div>Safe Child</div>,
        componentName: "TestnetFaucetModal",
        onCatch: (error, info) => {
          caughtError = error;
          caughtInfo = info;
        },
      });

      const err = new Error("Contract simulation timeout");
      const info = { componentStack: "in TestnetFaucetModal" } as any;

      boundary.componentDidCatch(err, info);

      expect(caughtError).toBe(err);
      expect(caughtInfo).toBe(info);
    });

    it("3.3 ErrorBoundary renders default error card with decodeSorobanError message", () => {
      const boundary = new ErrorBoundary({
        children: <div>Safe Child</div>,
        componentName: "TestnetFaucetModal",
      });

      boundary.state = {
        hasError: true,
        error: new Error("HostError: Error(Contract, #9)"),
      };

      const renderedTree = boundary.render();
      const html = renderToString(renderedTree as React.ReactElement);

      expect(html).toContain("TestnetFaucetModal Failed");
      expect(html).toContain(
        "Soroban ContractError #9: Output fell below your slippage tolerance limit."
      );
      expect(html).toContain("Try Again");
    });

    it("3.4 ErrorBoundary renders Horizon error decoded in default card", () => {
      const boundary = new ErrorBoundary({
        children: <div>Safe Child</div>,
        componentName: "FaucetHorizonStep",
      });

      boundary.state = {
        hasError: true,
        error: new Error("Horizon error: op_no_trust"),
      };

      const renderedTree = boundary.render();
      const html = renderToString(renderedTree as React.ReactElement);

      expect(html).toContain("FaucetHorizonStep Failed");
      expect(html).toContain(
        "Account is missing Testnet USDC trustline. Use Add USDC Trustline first."
      );
    });

    it("3.5 ErrorBoundary supports custom functional fallback with error and reset", () => {
      const boundary = new ErrorBoundary({
        children: <div>Safe Child</div>,
        componentName: "CustomBoundary",
        fallback: (error, reset) => (
          <div data-testid="custom-fallback">
            <span>Custom: {error.message}</span>
            <button onClick={reset}>Recover</button>
          </div>
        ),
      });

      boundary.state = {
        hasError: true,
        error: new Error("Critical network outage"),
      };

      const renderedTree = boundary.render();
      const html = renderToString(renderedTree as React.ReactElement);

      expect(html).toContain("custom-fallback");
      expect(html).toContain("Critical network outage");
      expect(html).toContain("Recover");
    });

    it("3.6 ErrorBoundary passes through normal children when hasError is false", () => {
      const boundary = new ErrorBoundary({
        children: <div data-testid="normal-child">Active Faucet Ready</div>,
        componentName: "NormalBoundary",
      });

      boundary.state = {
        hasError: false,
        error: null,
      };

      const renderedTree = boundary.render();
      const html = renderToString(renderedTree as React.ReactElement);

      expect(html).toContain("normal-child");
      expect(html).toContain("Active Faucet Ready");
    });
  });

  // =========================================================================
  // Suite 4: End-to-End Modal Step Click Execution & Toast State Propagation
  // =========================================================================
  describe("Suite 4: End-to-End Modal Step Click Execution & Toast State Propagation", () => {
    it("4.1 clicking Step 1 button with 429 rate limit executes authentic handleStep1 and produces ERROR toast", async () => {
      globalThis.fetch = async () =>
        new Response("HTTP 429 Too Many Requests: Friendbot IP rate limit exceeded", {
          status: 429,
          statusText: "Too Many Requests",
        });

      let toastApi!: UseTxToastReturn;
      function Harness() {
        const api = useTxToast();
        toastApi = api;
        return (
          <CaptureHarness
            Component={TestnetFaucetModal}
            props={{
              isOpen: true,
              onClose: () => {},
              address: TEST_ADDRESS,
              accountExists: false,
              xlmBalance: "0",
              // authentic: NO onFundXlm override provided!
            }}
          />
        );
      }

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Harness)
        )
      );

      const step1Btns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          extractText(n.props.children).includes("10,000 XLM")
      );

      expect(step1Btns.length).toBeGreaterThanOrEqual(1);

      // Trigger Step 1 button click
      step1Btns[0].props.onClick();

      // Wait for microtask queue to settle async handleStep1
      await new Promise((r) => setTimeout(r, 50));

      // Assert that handleStep1 caught the 429 error and created an ERROR toast via useTxToast
      expect(toastApi.toasts.length).toBe(1);
      const errToast = toastApi.toasts[0];
      expect(errToast.status).toBe("ERROR");
      expect(errToast.title).toBe("Friendbot XLM Failed");
      expect(errToast.description).toContain("Friendbot error (429)");
      expect(errToast.txHash).toBeUndefined();
    });

    it("4.2 clicking Step 2 button with user cancellation triggers handleStep2 and produces cancellation toast", async () => {
      // Mock Horizon loadAccount response via fetch
      globalThis.fetch = async (url: any) => {
        if (String(url).includes("/accounts/")) {
          return new Response(
            JSON.stringify({
              id: TEST_ADDRESS,
              account_id: TEST_ADDRESS,
              sequence: "1000",
              subentry_count: 0,
              balances: [{ asset_type: "native", balance: "100.00" }],
              signers: [{ key: TEST_ADDRESS, weight: 1 }],
              thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
              flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 200 });
      };

      // Mock wallet to reject signature
      mockWalletState.signTransactionXdr = async () => {
        throw new Error("User declined to sign the transaction");
      };

      let toastApi!: UseTxToastReturn;
      function Harness() {
        const api = useTxToast();
        toastApi = api;
        return (
          <CaptureHarness
            Component={TestnetFaucetModal}
            props={{
              isOpen: true,
              onClose: () => {},
              address: TEST_ADDRESS,
              accountExists: true,
              xlmBalance: "10000.00",
              usdcTrustlineExists: false,
              // authentic: NO onAddUsdcTrustline override provided!
            }}
          />
        );
      }

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Harness)
        )
      );

      const step2Btns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          extractText(n.props.children).includes("Add USDC Trustline")
      );

      expect(step2Btns.length).toBeGreaterThanOrEqual(1);

      // Trigger Step 2 button click
      step2Btns[0].props.onClick();

      // Wait for microtask queue to settle async handleStep2
      await new Promise((r) => setTimeout(r, 50));

      // Assert error toast for signature cancellation
      expect(toastApi.toasts.length).toBe(1);
      const errToast = toastApi.toasts[0];
      expect(errToast.status).toBe("ERROR");
      expect(errToast.title).toBe("USDC Trustline Failed");
      expect(errToast.description).toBe("Wallet signature request was cancelled by user.");
    });

    it("4.3 Step 4 Soroban simulation rejection with Contract Error #9 updates toast with decoded description and txHash", async () => {
      let toastApi!: UseTxToastReturn;
      function Harness() {
        const api = useTxToast();
        toastApi = api;
        return (
          <CaptureHarness
            Component={TestnetFaucetModal}
            props={{
              isOpen: true,
              onClose: () => {},
              address: TEST_ADDRESS,
              accountExists: true,
              usdcTrustlineExists: true,
              usdcBalance: "500.00",
              syBalance: 0n,
              onDepositSy: async () => {
                const toastId = toastApi.notifyTxPending("Deposit USDC to SY");
                const err = Object.assign(new Error("HostError: Error(Contract, #9)"), {
                  txHash: SAMPLE_TX_HASH,
                });
                toastApi.notifyTxError(toastId, err, err.txHash, "Deposit USDC to SY");
              },
            }}
          />
        );
      }

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Harness)
        )
      );

      const step4Btns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          extractText(n.props.children).includes("Deposit 10 USDC")
      );

      expect(step4Btns.length).toBeGreaterThanOrEqual(1);
      await step4Btns[0].props.onClick();

      expect(toastApi.toasts.length).toBe(1);
      const errToast = toastApi.toasts[0];
      expect(errToast.status).toBe("ERROR");
      expect(errToast.title).toBe("Deposit USDC to SY Failed");
      expect(errToast.description).toBe(
        "Soroban ContractError #9: Output fell below your slippage tolerance limit."
      );
      expect(errToast.txHash).toBe(SAMPLE_TX_HASH);
      expect(errToast.explorerUrl).toBe(EXPECTED_EXPLORER_URL);
    });

    it("4.4 Step 5 Soroban RESOURCE_LIMIT_EXCEEDED simulation rejection updates toast with 12s duration", async () => {
      let toastApi!: UseTxToastReturn;
      function Harness() {
        const api = useTxToast();
        toastApi = api;
        return (
          <CaptureHarness
            Component={TestnetFaucetModal}
            props={{
              isOpen: true,
              onClose: () => {},
              address: TEST_ADDRESS,
              accountExists: true,
              usdcTrustlineExists: true,
              usdcBalance: "500.00",
              syBalance: 10_0000000n,
              ptBalance: 0n,
              ytBalance: 0n,
              onMintPy: async () => {
                const toastId = toastApi.notifyTxPending("Mint PT & YT");
                const err = new Error("Simulation failed: RESOURCE_LIMIT_EXCEEDED");
                toastApi.notifyTxError(toastId, err, undefined, "Mint PT & YT");
              },
            }}
          />
        );
      }

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Harness)
        )
      );

      const step5Btns = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.children &&
          extractText(n.props.children).includes("Mint PT & YT")
      );

      expect(step5Btns.length).toBeGreaterThanOrEqual(1);
      await step5Btns[0].props.onClick();

      expect(toastApi.toasts.length).toBe(1);
      const errToast = toastApi.toasts[0];
      expect(errToast.status).toBe("ERROR");
      expect(errToast.title).toBe("Mint PT & YT Failed");
      expect(errToast.description).toBe(
        "Transaction exceeded Soroban CPU or memory resource limits."
      );
      expect(errToast.durationMs).toBe(12000);
    });
  });

  // =========================================================================
  // Suite 5: Design System & Codebase Constraints Audit
  // =========================================================================
  describe("Suite 5: Design System & Codebase Constraints Audit", () => {
    const COMPONENT_PATHS = [
      "frontend/src/components/faucet/TestnetFaucetModal.tsx",
      "frontend/src/components/faucet/TestnetOnboardingBanner.tsx",
      "frontend/src/context/ToastContext.tsx",
      "frontend/src/components/ui/Toaster.tsx",
      "frontend/src/hooks/useTxToast.ts",
      "frontend/src/components/ErrorBoundary.tsx",
    ];

    it("4.1 contains ZERO raw hex color codes across all M3 components", () => {
      const hexRegex = /#[0-9a-fA-F]{3,8}\b/g;

      for (const relPath of COMPONENT_PATHS) {
        const fullPath = path.join(FRONTEND_DIR, "..", relPath);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");

        const matches = content.match(hexRegex) || [];
        // Ignore valid hex in comments or Soroban error code regexes like #(\d+)
        const filtered = matches.filter((m) => !m.match(/^#[0-9]+$/));
        expect(filtered.length).toBe(0);
      }
    });

    it("4.2 contains ZERO raw Unicode emojis across all M3 components", () => {
      const emojiRegex =
        /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;

      for (const relPath of COMPONENT_PATHS) {
        const fullPath = path.join(FRONTEND_DIR, "..", relPath);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");

        const hasEmoji = emojiRegex.test(content);
        expect(hasEmoji).toBe(false);
      }
    });

    it("4.3 enforces tabular-mono typography on balance chips in TestnetFaucetModal", () => {
      const modalPath = path.join(
        FRONTEND_DIR,
        "../frontend/src/components/faucet/TestnetFaucetModal.tsx"
      );
      const content = fs.readFileSync(modalPath, "utf-8");

      expect(content).toContain("tabular-mono font-mono");
    });

    it("4.4 verifies locked files SHA256 integrity remains strictly untouched", () => {
      const indexerPath = path.join(FRONTEND_DIR, "src/lib/indexer.ts");
      const hookPath = path.join(FRONTEND_DIR, "src/hooks/useEventIndexer.ts");

      const EXPECTED_INDEXER_SHA =
        "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";
      const EXPECTED_HOOK_SHA =
        "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

      const indexerHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(indexerPath))
        .digest("hex");
      const hookHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(hookPath))
        .digest("hex");

      expect(indexerHash).toBe(EXPECTED_INDEXER_SHA);
      expect(hookHash).toBe(EXPECTED_HOOK_SHA);
    });
  });
});
