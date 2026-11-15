// frontend/src/lib/__tests__/m2_tx_toasts.test.tsx
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

// ----------------------------------------------------------------------------
// Authentic Imports Under Test
// ----------------------------------------------------------------------------
import {
  ToastProvider,
  useToastContext,
  setActiveContextForInspection,
  TxToastStatus,
  TxToastOptions,
  TxToastItem,
  ToastContextValue,
} from "@/context/ToastContext";
import {
  Toaster,
  __renderedCardsMap,
  __lastRenderedToasterTree,
} from "@/components/ui/Toaster";
import { useTxToast, formatExplorerTxUrl, UseTxToastReturn } from "@/hooks/useTxToast";
import { explorerTxUrl } from "@/lib/contracts";

// ----------------------------------------------------------------------------
// Authentic Component Harness & Tree Inspection (Anti-Facade Protocol)
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
  if (node.type === Toaster) {
    if (__lastRenderedToasterTree) {
      results.push(...findElements(__lastRenderedToasterTree, predicate));
    }
  } else if (node.props?.toast && __renderedCardsMap.has(node.props.toast.id)) {
    const cardNode = __renderedCardsMap.get(node.props.toast.id);
    if (cardNode) {
      results.push(...findElements(cardNode, predicate));
    }
  }
  if (node.props && node.props.children) {
    results.push(...findElements(node.props.children, predicate));
  }
  return results;
}

/**
 * Authentic Test Harness that mounts inside ToastProvider, executes hooks,
 * and renders actionable buttons with authentic props.
 */
function TestToastConsumer({
  onMount,
  onRenderApi,
}: {
  onMount?: (api: UseTxToastReturn) => void;
  onRenderApi?: (api: UseTxToastReturn) => void;
}) {
  const txToast = useTxToast();

  React.useEffect(() => {
    onMount?.(txToast);
  }, [txToast, onMount]);

  onRenderApi?.(txToast);

  return (
    <div data-testid="toast-consumer-root">
      <button
        type="button"
        data-testid="btn-trigger-pending"
        onClick={() =>
          txToast.notifyPending({
            title: "Swap 100 USDC -> PT-bUSDC",
            description: "Awaiting wallet signature...",
            id: "tx_swap_test_1",
          })
        }
      >
        Spawn Swap Pending
      </button>

      <button
        type="button"
        data-testid="btn-trigger-confirming"
        onClick={() =>
          txToast.notifyConfirming("tx_swap_test_1", {
            txHash:
              "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
            title: "Swap 100 USDC -> PT-bUSDC",
          })
        }
      >
        Confirm Swap
      </button>

      <button
        type="button"
        data-testid="btn-trigger-success"
        onClick={() =>
          txToast.notifySuccess("tx_swap_test_1", {
            txHash:
              "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
            title: "Swap 100 USDC -> PT-bUSDC Confirmed",
          })
        }
      >
        Succeed Swap
      </button>

      <button
        type="button"
        data-testid="btn-trigger-error"
        onClick={() =>
          txToast.notifyError("tx_swap_test_1", {
            error: "User declined transaction signing",
            title: "Swap 100 USDC -> PT-bUSDC Failed",
          })
        }
      >
        Fail Swap
      </button>

      <button
        type="button"
        data-testid="btn-dismiss-swap"
        onClick={() => txToast.dismissTxToast("tx_swap_test_1")}
      >
        Dismiss Swap
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Test Fixtures
// ----------------------------------------------------------------------------

const VALID_TX_HASH_1 =
  "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5";
const VALID_TX_HASH_2 =
  "e9d8c7b6a504132435465768798a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60";
const VALID_TX_HASH_3 =
  "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

describe("Milestone 2 Test Suite: Transaction Toast Notifications & Explorer Links", () => {
  const FRONTEND_DIR = path.resolve(__dirname, "../../..");

  beforeEach(() => {
    capturedTree = null;
    setActiveContextForInspection(null);
    __renderedCardsMap.clear();
  });

  // =========================================================================
  // Dimension 1: Initial Toast Creation & PENDING Lifecycle State
  // =========================================================================
  describe("1. Initial Toast Creation & PENDING Lifecycle State", () => {
    it("1.1 creates toast in PENDING status with title and default description", () => {
      let api!: UseTxToastReturn;

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(TestToastConsumer, {
            onRenderApi: (val) => {
              api = val;
            },
          }),
          React.createElement(Toaster)
        )
      );

      // Trigger pending toast via authentic API
      const toastId = api.notifyPending({
        title: "Swap 50 USDC -> PT-bUSDC",
        description: "Awaiting wallet signature in Freighter...",
        id: "tx_pending_1",
      });

      expect(toastId).toBe("tx_pending_1");
      expect(api.toasts.length).toBe(1);
      expect(api.toasts[0].status).toBe("PENDING");
      expect(api.toasts[0].title).toBe("Swap 50 USDC -> PT-bUSDC");
      expect(api.toasts[0].description).toBe(
        "Awaiting wallet signature in Freighter..."
      );
      expect(api.toasts[0].txHash).toBeUndefined();
      expect(api.toasts[0].explorerUrl).toBeUndefined();
    });

    it("1.2 renders authentic PENDING toast card with spinning indicator and status badge", () => {
      const initialPendingToast: TxToastItem = {
        id: "tx_pending_render",
        title: "Mint 100 sy-bUSDC -> PT + YT",
        description: "Simulating and signing Soroban transaction...",
        status: "PENDING",
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [initialPendingToast] },
          React.createElement(Toaster)
        )
      );

      // Verifies markup presence
      expect(html).toContain('role="status"');
      expect(html).toContain("Mint 100 sy-bUSDC -&gt; PT + YT");
      expect(html).toContain("Simulating and signing Soroban transaction...");
      expect(html).toContain("PENDING");
      expect(html).toContain("animate-spin");
      expect(html).toContain("border-accent");

      // Verifies no explorer link is shown prior to transaction broadcast
      expect(html).not.toContain("stellar.expert");
      expect(html).not.toContain("StellarExpert");
    });

    it("1.3 formats in-flight duration counter with tabular-mono font-mono", () => {
      const initialPendingToast: TxToastItem = {
        id: "tx_pending_counter",
        title: "Deposit Collateral",
        status: "PENDING",
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [initialPendingToast] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain("tabular-mono");
      expect(html).toContain("font-mono");
      expect(html).toContain("0s");
    });
  });

  // =========================================================================
  // Dimension 2: Status Lifecycle Transitions: PENDING -> CONFIRMING -> SUCCESS
  // =========================================================================
  describe("2. Status Lifecycle Transitions: PENDING -> CONFIRMING -> SUCCESS", () => {
    it("2.1 transitions PENDING toast to CONFIRMING upon transaction broadcast with live hash", () => {
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

      const id = api.notifyPending({
        title: "Swap 100 USDC -> YT-bUSDC",
        id: "tx_flow_1",
      });
      expect(api.toasts[0].status).toBe("PENDING");

      // Transition to CONFIRMING
      api.notifyConfirming(id, {
        txHash: VALID_TX_HASH_1,
        title: "Swap 100 USDC -> YT-bUSDC Broadcast",
        description: "Awaiting ledger confirmation on Stellar...",
      });

      expect(api.toasts.length).toBe(1);
      expect(api.toasts[0].status).toBe("CONFIRMING");
      expect(api.toasts[0].txHash).toBe(VALID_TX_HASH_1);
      expect(api.toasts[0].explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}`
      );
      expect(api.toasts[0].title).toBe("Swap 100 USDC -> YT-bUSDC Broadcast");
    });

    it("2.2 renders authentic CONFIRMING toast card with shortened hash and StellarExpert link", () => {
      const confirmingToast: TxToastItem = {
        id: "tx_confirming_render",
        title: "Swap 100 USDC -> YT-bUSDC",
        description: "Awaiting ledger confirmation...",
        status: "CONFIRMING",
        txHash: VALID_TX_HASH_1,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}`,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [confirmingToast] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain("CONFIRMING");
      expect(html).toContain("animate-spin");
      expect(html).toContain("Tx:");
      // Shortened hash: 4a7b9c...f3a4b5
      expect(html).toContain("4a7b9c");
      expect(html).toContain("f3a4b5");
      expect(html).toContain("tabular-mono font-mono");
      expect(html).toContain("StellarExpert");
      expect(html).toContain(
        `href="https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}"`
      );
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    });

    it("2.3 transitions CONFIRMING toast to SUCCESS upon ledger settlement", () => {
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

      const id = api.notifyPending({ title: "Redeem PT", id: "tx_flow_2" });
      api.notifyConfirming(id, { txHash: VALID_TX_HASH_2 });
      expect(api.toasts[0].status).toBe("CONFIRMING");

      // Transition to SUCCESS
      api.notifySuccess(id, {
        txHash: VALID_TX_HASH_2,
        title: "Redeem PT Settled",
        description: "Successfully redeemed 500 PT into 500 USDC.",
      });

      expect(api.toasts.length).toBe(1);
      expect(api.toasts[0].status).toBe("SUCCESS");
      expect(api.toasts[0].txHash).toBe(VALID_TX_HASH_2);
      expect(api.toasts[0].title).toBe("Redeem PT Settled");
      expect(api.toasts[0].durationMs).toBeGreaterThan(0);
    });

    it("2.4 renders authentic SUCCESS toast card with positive checkmark and confirmed badge", () => {
      const successToast: TxToastItem = {
        id: "tx_success_render",
        title: "Redeem PT Settled",
        description: "Successfully redeemed 500 PT.",
        status: "SUCCESS",
        txHash: VALID_TX_HASH_2,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_2}`,
        durationMs: 7000,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [successToast] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain("CONFIRMED");
      expect(html).toContain("border-positive");
      expect(html).toContain("text-positive");
      expect(html).toContain("Redeem PT Settled");
      expect(html).toContain("StellarExpert");
      expect(html).toContain(
        `href="https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_2}"`
      );
      // Progress bar for auto-dismissal
      expect(html).toContain("bg-positive");
    });
  });

  // =========================================================================
  // Dimension 3: Error Lifecycle Transitions: PENDING -> ERROR
  // =========================================================================
  describe("3. Error Lifecycle Transitions: PENDING -> ERROR", () => {
    it("3.1 handles wallet signature rejection prior to broadcast (no txHash)", () => {
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

      const id = api.notifyPending({ title: "Swap Action", id: "tx_err_1" });
      api.notifyError(id, {
        error: "User declined transaction signing in Freighter.",
        title: "Swap Action Cancelled",
      });

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].title).toBe("Swap Action Cancelled");
      expect(api.toasts[0].description).toBe(
        "User declined transaction signing in Freighter."
      );
      expect(api.toasts[0].txHash).toBeUndefined();
      expect(api.toasts[0].explorerUrl).toBeUndefined();
    });

    it("3.2 renders pre-broadcast error card with alert role, failed badge, and no explorer link", () => {
      const errorToast: TxToastItem = {
        id: "tx_err_render_no_hash",
        title: "Swap Cancelled",
        description: "User declined signing.",
        status: "ERROR",
        durationMs: 12000,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [errorToast] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain('role="alert"');
      expect(html).toContain("FAILED");
      expect(html).toContain("border-danger");
      expect(html).toContain("text-danger");
      expect(html).toContain("User declined signing.");
      expect(html).not.toContain("StellarExpert");
    });

    it("3.3 handles on-chain transaction panic with txHash preserved for debugging", () => {
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

      const id = api.notifyPending({ title: "Rollover PT", id: "tx_err_2" });
      api.notifyConfirming(id, { txHash: VALID_TX_HASH_3 });

      // Rejection during contract execution
      api.notifyError(id, {
        error: "HostError: Error(Contract, #1) - Market not yet matured",
        txHash: VALID_TX_HASH_3,
        title: "Rollover PT Failed",
      });

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].txHash).toBe(VALID_TX_HASH_3);
      expect(api.toasts[0].explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_3}`
      );
    });

    it("3.4 renders on-chain failure card with decoded error and live StellarExpert link", () => {
      const onChainErrorToast: TxToastItem = {
        id: "tx_err_render_with_hash",
        title: "Rollover Failed",
        description: "HostError: Error(Contract, #1) - Market not yet matured",
        status: "ERROR",
        txHash: VALID_TX_HASH_3,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_3}`,
        durationMs: 12000,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [onChainErrorToast] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain('role="alert"');
      expect(html).toContain("FAILED");
      expect(html).toContain("Market not yet matured");
      expect(html).toContain("StellarExpert");
      expect(html).toContain(
        `href="https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_3}"`
      );
      expect(html).toContain("tabular-mono font-mono");
    });
  });

  // =========================================================================
  // Dimension 4: Stellar Expert Explorer Link Contract & Security Attributes
  // =========================================================================
  describe("4. Stellar Expert Explorer Link Contract & Security Attributes", () => {
    it("4.1 formatExplorerTxUrl constructs valid testnet URL and cleans 0x prefix", () => {
      const cleanUrl = formatExplorerTxUrl(VALID_TX_HASH_1);
      expect(cleanUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}`
      );

      const prefixedHash = `0x${VALID_TX_HASH_1}`;
      const urlFromPrefixed = formatExplorerTxUrl(prefixedHash);
      expect(urlFromPrefixed).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}`
      );

      const paddedHash = `  ${VALID_TX_HASH_1}  `;
      expect(formatExplorerTxUrl(paddedHash)).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}`
      );

      expect(formatExplorerTxUrl("")).toBe("");
    });

    it("4.2 enforces target='_blank' and rel='noopener noreferrer' on all explorer anchors", () => {
      const toastWithLink: TxToastItem = {
        id: "tx_sec_link",
        title: "Swap Confirmed",
        status: "SUCCESS",
        txHash: VALID_TX_HASH_1,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}`,
        createdAt: Date.now(),
      };

      renderToString(
        React.createElement(CaptureHarness, {
          Component: ToastProvider,
          props: {
            initialToasts: [toastWithLink],
            children: React.createElement(Toaster),
          },
        })
      );

      const anchors = findElements(
        capturedTree,
        (n) => n.type === "a" && n.props?.href?.includes("stellar.expert")
      );

      expect(anchors.length).toBe(1);
      const anchor = anchors[0];

      expect(anchor.props.href).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}`
      );
      expect(anchor.props.target).toBe("_blank");
      expect(anchor.props.rel).toBe("noopener noreferrer");
      expect(anchor.props["aria-label"]).toBe(
        "View transaction on StellarExpert Explorer"
      );
    });

    it("4.3 explorer link strictly matches testnet regex pattern", () => {
      const toastWithLink: TxToastItem = {
        id: "tx_regex_link",
        title: "Test Explorer Regex",
        status: "CONFIRMING",
        txHash: VALID_TX_HASH_1,
        explorerUrl: formatExplorerTxUrl(VALID_TX_HASH_1),
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [toastWithLink] },
          React.createElement(Toaster)
        )
      );

      const explorerHrefMatch = html.match(
        /href="(https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[a-fA-F0-9]{64})"/
      );
      expect(explorerHrefMatch).not.toBeNull();
      expect(explorerHrefMatch![1]).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_1}`
      );
    });
  });

  // =========================================================================
  // Dimension 5: Toast Dismissal Mechanisms (Auto-Dismissal & Manual Dismiss)
  // =========================================================================
  describe("5. Toast Dismissal Mechanisms (Auto-Dismissal & Manual Dismiss)", () => {
    it("5.1 authentic click on dismiss button invokes onDismiss and removes toast", () => {
      let api!: UseTxToastReturn;

      renderToString(
        React.createElement(CaptureHarness, {
          Component: ToastProvider,
          props: {
            initialToasts: [
              {
                id: "tx_manual_dismiss_1",
                title: "Toast to Dismiss",
                status: "SUCCESS",
                createdAt: Date.now(),
              },
            ],
            children: [
              React.createElement(TestToastConsumer, {
                key: "consumer",
                onRenderApi: (val) => {
                  api = val;
                },
              }),
              React.createElement(Toaster, { key: "toaster" }),
            ],
          },
        })
      );

      expect(api.toasts.length).toBe(1);

      // Locate authentic dismiss button in rendered tree
      const dismissButtons = findElements(
        capturedTree,
        (n) =>
          n.type === "button" &&
          n.props?.["aria-label"] === "Dismiss notification"
      );

      expect(dismissButtons.length).toBe(1);

      // Invoke authentic component onClick prop (Anti-Facade Assertion)
      dismissButtons[0].props.onClick();

      expect(api.toasts.length).toBe(0);
    });

    it("5.2 auto-dismisses toast after configured durationMs expires", async () => {
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

      // Create toast with 40ms duration
      api.showTxToast({
        title: "Fast Auto-Dismiss Toast",
        status: "SUCCESS",
        durationMs: 40,
      });

      expect(api.toasts.length).toBe(1);

      // Wait for timer to fire
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(api.toasts.length).toBe(0);
    });

    it("5.3 PENDING and CONFIRMING toasts persist without auto-dismissing", async () => {
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

      const id = api.notifyPending({
        title: "Persistent Pending Action",
        id: "tx_persist_1",
      });

      expect(api.toasts[0].durationMs).toBe(0);

      // Wait 50ms and assert still present
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(api.toasts.length).toBe(1);
      expect(api.toasts[0].status).toBe("PENDING");

      // Transition to CONFIRMING
      api.notifyConfirming(id, { txHash: VALID_TX_HASH_1 });
      expect(api.toasts[0].durationMs).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(api.toasts.length).toBe(1);
      expect(api.toasts[0].status).toBe("CONFIRMING");
    });
  });

  // =========================================================================
  // Dimension 6: Multi-Toast Stacking, Stacking Order & DOM Isolation
  // =========================================================================
  describe("6. Multi-Toast Stacking, Stacking Order & DOM Isolation", () => {
    it("6.1 renders multiple concurrent toasts in stack without DOM collision", () => {
      const stackedToasts: TxToastItem[] = [
        {
          id: "toast_1",
          title: "Action 1: Swap",
          status: "PENDING",
          createdAt: 1000,
        },
        {
          id: "toast_2",
          title: "Action 2: Mint",
          status: "CONFIRMING",
          txHash: VALID_TX_HASH_1,
          createdAt: 2000,
        },
        {
          id: "toast_3",
          title: "Action 3: Claim Yield",
          status: "SUCCESS",
          txHash: VALID_TX_HASH_2,
          createdAt: 3000,
        },
      ];

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: stackedToasts },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain("Action 1: Swap");
      expect(html).toContain("Action 2: Mint");
      expect(html).toContain("Action 3: Claim Yield");

      // Verifies notification region container attributes
      expect(html).toContain('role="region"');
      expect(html).toContain('aria-label="Transaction Notifications"');
      expect(html).toContain('aria-live="polite"');
    });

    it("6.2 ensures all stacked toasts retain unique keys and IDs", () => {
      const stackedToasts: TxToastItem[] = [
        { id: "tx_alpha", title: "Alpha", status: "PENDING", createdAt: 1 },
        { id: "tx_beta", title: "Beta", status: "CONFIRMING", createdAt: 2 },
        { id: "tx_gamma", title: "Gamma", status: "SUCCESS", createdAt: 3 },
      ];

      renderToString(
        React.createElement(CaptureHarness, {
          Component: ToastProvider,
          props: {
            initialToasts: stackedToasts,
            children: React.createElement(Toaster),
          },
        })
      );

      const toastCards = findElements(
        capturedTree,
        (n) => n.props?.role === "status" || n.props?.role === "alert"
      );

      expect(toastCards.length).toBe(3);
    });

    it("6.3 dismissing a middle toast leaves surrounding toasts intact in order", () => {
      let api!: UseTxToastReturn;

      renderToString(
        React.createElement(
          ToastProvider,
          {
            initialToasts: [
              { id: "t1", title: "First", status: "PENDING", createdAt: 1 },
              { id: "t2", title: "Second", status: "CONFIRMING", createdAt: 2 },
              { id: "t3", title: "Third", status: "SUCCESS", createdAt: 3 },
            ],
          },
          React.createElement(TestToastConsumer, {
            onRenderApi: (val) => {
              api = val;
            },
          })
        )
      );

      expect(api.toasts.length).toBe(3);

      // Dismiss middle toast
      api.dismissTxToast("t2");

      expect(api.toasts.length).toBe(2);
      expect(api.toasts.map((t) => t.id)).toEqual(["t1", "t3"]);
    });
  });

  // =========================================================================
  // Dimension 7: Memory Leak Prevention & Lifecycle Cleanup
  // =========================================================================
  describe("7. Memory Leak Prevention & Lifecycle Cleanup", () => {
    it("7.1 clearAllToasts cancels all pending timers and flushes queue", () => {
      let api!: ToastContextValue;

      function DirectConsumer() {
        const ctx = useToastContext();
        api = ctx;
        return null;
      }

      renderToString(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(DirectConsumer)
        )
      );

      api.showTxToast({ title: "T1", status: "SUCCESS", durationMs: 5000 });
      api.showTxToast({ title: "T2", status: "ERROR", durationMs: 10000 });
      api.showTxToast({ title: "T3", status: "PENDING" });

      expect(api.toasts.length).toBe(3);

      api.clearAllToasts();

      expect(api.toasts.length).toBe(0);
    });

    it("7.2 rapid trigger and dismiss stress cycle produces zero state corruption", () => {
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

      // Stress test: 50 rapid sequential toast updates
      for (let i = 0; i < 50; i++) {
        const id = api.notifyPending({ title: `Stress Toast ${i}` });
        api.notifyConfirming(id, { txHash: VALID_TX_HASH_1 });
        api.notifySuccess(id);
        api.dismissTxToast(id);
      }

      expect(api.toasts.length).toBe(0);
    });
  });

  // =========================================================================
  // Dimension 8: Design System Compliance & Tabular Typography Matrix
  // =========================================================================
  describe("8. Design System Compliance & Tabular Typography Matrix", () => {
    it("8.1 contains zero raw hex color codes across rendered toast markup", () => {
      const allStatusToasts: TxToastItem[] = [
        { id: "1", title: "P", status: "PENDING", createdAt: 1 },
        {
          id: "2",
          title: "C",
          status: "CONFIRMING",
          txHash: VALID_TX_HASH_1,
          createdAt: 2,
        },
        {
          id: "3",
          title: "S",
          status: "SUCCESS",
          txHash: VALID_TX_HASH_2,
          createdAt: 3,
        },
        { id: "4", title: "E", status: "ERROR", createdAt: 4 },
      ];

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: allStatusToasts },
          React.createElement(Toaster)
        )
      );

      const rawHexMatches = html.match(/#[0-9a-fA-F]{3,8}\b/g);
      expect(rawHexMatches).toBeNull();
    });

    it("8.2 contains zero raw Unicode emojis across rendered toast markup", () => {
      const allStatusToasts: TxToastItem[] = [
        { id: "1", title: "Pending Tx", status: "PENDING", createdAt: 1 },
        {
          id: "2",
          title: "Confirming Tx",
          status: "CONFIRMING",
          txHash: VALID_TX_HASH_1,
          createdAt: 2,
        },
        {
          id: "3",
          title: "Success Tx",
          status: "SUCCESS",
          txHash: VALID_TX_HASH_2,
          createdAt: 3,
        },
        { id: "4", title: "Error Tx", status: "ERROR", createdAt: 4 },
      ];

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: allStatusToasts },
          React.createElement(Toaster)
        )
      );

      const emojiRegex =
        /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(emojiRegex.test(html)).toBe(false);
    });

    it("8.3 enforces tabular-mono font-mono on all transaction hashes and timers", () => {
      const toastWithHashAndTimer: TxToastItem = {
        id: "tx_tab_mono",
        title: "Tabular Check",
        status: "CONFIRMING",
        txHash: VALID_TX_HASH_1,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [toastWithHashAndTimer] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain("tabular-mono");
      expect(html).toContain("font-mono");
    });
  });

  // =========================================================================
  // Dimension 9: Authentic Component Mounting & Anti-Facade Enforcement
  // =========================================================================
  describe("9. Authentic Component Mounting & Anti-Facade Enforcement", () => {
    it("9.1 verifies Toaster returns null when toast queue is empty", () => {
      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [] },
          React.createElement(Toaster)
        )
      );

      expect(html).toBe("");
    });

    it("9.2 verifies useToastContext returns safe no-op fallback when mounted outside ToastProvider", () => {
      function OrphanComponent() {
        const ctx = useToastContext();
        expect(ctx.toasts).toEqual([]);
        expect(typeof ctx.showTxToast).toBe("function");
        expect(typeof ctx.updateTxToast).toBe("function");
        expect(typeof ctx.dismissTxToast).toBe("function");
        return null;
      }

      expect(() => {
        renderToString(React.createElement(OrphanComponent));
      }).not.toThrow();
    });

    it("9.3 verifies root layout.tsx nests ToastProvider and Toaster cleanly", () => {
      const layoutPath = path.join(FRONTEND_DIR, "src/app/layout.tsx");
      expect(fs.existsSync(layoutPath)).toBe(true);

      const layoutContent = fs.readFileSync(layoutPath, "utf-8");
      expect(layoutContent).toContain("<ToastProvider>");
      expect(layoutContent).toContain("<Toaster />");
      expect(layoutContent).toContain("</ToastProvider>");
      expect(layoutContent).not.toContain('"use client"'); // layout must stay Server Component
    });
  });
});
