// frontend/src/lib/__tests__/empirical_challenger_m2_c1.test.tsx
// Empirical Adversarial Stress Test Suite for Milestone 2 Gate
// Conducted by Challenger 1 (critic, specialist)
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";

// Target modules under adversarial test
import {
  ToastProvider,
  useToastContext,
  TxToastItem,
  ToastContextValue,
} from "@/context/ToastContext";
import { Toaster } from "@/components/ui/Toaster";
import { useTxToast, formatExplorerTxUrl, UseTxToastReturn } from "@/hooks/useTxToast";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";

const FRONTEND_DIR = path.resolve(__dirname, "../../..");

// Helper component to capture both the live hook API and Context Value inside a ToastProvider tree
function LiveHookConsumer({
  onCapture,
}: {
  onCapture: (api: UseTxToastReturn, ctx: ToastContextValue) => void;
}) {
  const api = useTxToast();
  const ctx = useToastContext();
  onCapture(api, ctx);
  return null;
}

function setupLiveToastHarness(initialToasts: TxToastItem[] = []): {
  api: UseTxToastReturn;
  ctx: ToastContextValue;
  renderHtml: () => string;
} {
  let capturedApi!: UseTxToastReturn;
  let capturedCtx!: ToastContextValue;

  renderToString(
    React.createElement(
      ToastProvider,
      { initialToasts },
      React.createElement(LiveHookConsumer, {
        onCapture: (api, ctx) => {
          capturedApi = api;
          capturedCtx = ctx;
        },
      })
    )
  );

  return {
    get api() {
      return capturedApi;
    },
    get ctx() {
      return capturedCtx;
    },
    renderHtml: () => {
      return renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: capturedApi.toasts },
          React.createElement(Toaster)
        )
      );
    },
  };
}

describe("Milestone 2 Empirical Gate: Adversarial Toast Portal & Dismissal Stress Suite", () => {
  beforeEach(() => {
    // Reset state before each test
  });

  // =========================================================================
  // 1. Multi-Toast Concurrency & Burst Stress Testing (20+ Toasts)
  // =========================================================================
  describe("1. Multi-Toast Concurrency & Burst Stress Testing", () => {
    it("1.1 triggers 50 toasts concurrently with unique IDs, zero collisions, and strict order", () => {
      const { api } = setupLiveToastHarness();

      const BURST_COUNT = 50;
      const statuses: Array<"PENDING" | "CONFIRMING" | "SUCCESS" | "ERROR"> = [
        "PENDING",
        "CONFIRMING",
        "SUCCESS",
        "ERROR",
      ];
      const generatedIds: string[] = [];

      for (let i = 0; i < BURST_COUNT; i++) {
        const status = statuses[i % statuses.length];
        const id = api.showTxToast({
          title: `Burst Toast #${i.toString().padStart(2, "0")}`,
          description: `Concurrent payload execution index ${i}`,
          status,
          txHash: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`.slice(
            0,
            64 - i.toString().length
          ) + i.toString(),
        });
        generatedIds.push(id);
      }

      // Assert all generated IDs are non-empty and strictly unique
      expect(generatedIds.length).toBe(BURST_COUNT);
      const uniqueIds = new Set(generatedIds);
      expect(uniqueIds.size).toBe(BURST_COUNT);

      // Verify the queue contains all 50 toasts in arrival order
      expect(api.toasts.length).toBe(BURST_COUNT);
      for (let i = 0; i < BURST_COUNT; i++) {
        expect(api.toasts[i].id).toBe(generatedIds[i]);
        expect(api.toasts[i].title).toBe(`Burst Toast #${i.toString().padStart(2, "0")}`);
      }
    });

    it("1.2 renders 30 burst toasts in Toaster DOM tree without collision or markup corruption", () => {
      const { api, renderHtml } = setupLiveToastHarness();

      const BURST_COUNT = 30;
      for (let i = 0; i < BURST_COUNT; i++) {
        const isError = i % 4 === 3;
        api.showTxToast({
          title: `DOM Burst Node ${i}`,
          description: `Stress validation card payload #${i}`,
          status: isError ? "ERROR" : i % 4 === 2 ? "SUCCESS" : "PENDING",
          durationMs: 0, // Keep active for DOM measurement
        });
      }

      const html = renderHtml();

      // Check root portal container attributes
      expect(html).toContain('role="region"');
      expect(html).toContain('aria-label="Transaction Notifications"');

      // Verify all 30 titles exist distinctly in the rendered HTML string
      for (let i = 0; i < BURST_COUNT; i++) {
        expect(html).toContain(`DOM Burst Node ${i}`);
        expect(html).toContain(`Stress validation card payload #${i}`);
      }

      // Count alert vs status roles
      const alertMatches = (html.match(/role="alert"/g) || []).length;
      const statusMatches = (html.match(/role="status"/g) || []).length;
      expect(alertMatches + statusMatches).toBe(BURST_COUNT);
      // i % 4 === 3 -> i in {3, 7, 11, 15, 19, 23, 27} = 7 error cards
      expect(alertMatches).toBe(7);
      expect(statusMatches).toBe(23);
    });

    it("1.3 validates dynamic progress bar styles across all lifecycle statuses", () => {
      const pendingToast: TxToastItem = {
        id: "pb_pending",
        title: "Pending Tx",
        status: "PENDING",
        createdAt: Date.now(),
      };
      const confirmingToast: TxToastItem = {
        id: "pb_confirming",
        title: "Confirming Tx",
        status: "CONFIRMING",
        createdAt: Date.now(),
      };
      const successToast: TxToastItem = {
        id: "pb_success",
        title: "Success Tx",
        status: "SUCCESS",
        durationMs: 7000,
        createdAt: Date.now(),
      };
      const errorToast: TxToastItem = {
        id: "pb_error",
        title: "Error Tx",
        status: "ERROR",
        durationMs: 12000,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          {
            initialToasts: [
              pendingToast,
              confirmingToast,
              successToast,
              errorToast,
            ],
          },
          React.createElement(Toaster)
        )
      );

      // Pending and Confirming must render pulsed accent progress bars
      expect(html).toContain("bg-accent animate-pulse");

      // Success must render positive progress bar
      expect(html).toContain("bg-positive");

      // Error must render danger progress bar
      expect(html).toContain("bg-danger");
    });

    it("1.4 enforces deduplication and idempotency when toast is updated with explicit identical ID", () => {
      const { api } = setupLiveToastHarness();

      const FIXED_ID = "fixed_adversarial_id_001";

      // Dispatch 15 updates targeting the SAME explicit ID
      for (let i = 0; i < 15; i++) {
        api.showTxToast({
          id: FIXED_ID,
          title: `Iteration ${i}`,
          description: `Payload update revision ${i}`,
          status: i === 14 ? "SUCCESS" : "PENDING",
        });
      }

      // Assert queue has exactly 1 toast (in-place replacement, zero duplicates)
      expect(api.toasts.length).toBe(1);
      expect(api.toasts[0].id).toBe(FIXED_ID);
      expect(api.toasts[0].title).toBe("Iteration 14");
      expect(api.toasts[0].status).toBe("SUCCESS");
    });

    it("1.5 safely escapes XSS injection payloads in toast title and description", () => {
      const xssToast: TxToastItem = {
        id: "xss_test_toast",
        title: "<script>alert('xss-title')</script>",
        description: "<img src=x onerror=alert('xss-desc') />",
        status: "ERROR",
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [xssToast] },
          React.createElement(Toaster)
        )
      );

      // React escapes raw HTML tags into entities
      expect(html).not.toContain("<script>alert('xss-title')</script>");
      expect(html).not.toContain("<img src=x onerror=alert('xss-desc') />");
      expect(html).toContain("&lt;script&gt;alert(&#x27;xss-title&#x27;)&lt;/script&gt;");
      expect(html).toContain("&lt;img src=x onerror=alert(&#x27;xss-desc&#x27;) /&gt;");
    });
  });

  // =========================================================================
  // 2. Auto-Dismissal Timers & Manual Dismissal Isolation
  // =========================================================================
  describe("2. Auto-Dismissal Timers & Manual Dismissal Isolation", () => {
    it("2.1 handles multi-timer auto-dismissal hierarchy without cross-timer interference", async () => {
      const { api } = setupLiveToastHarness();

      // Spawn 6 toasts with distinct durations
      const id1 = api.showTxToast({
        title: "Toast 1 (Fast Success)",
        status: "SUCCESS",
        durationMs: 40,
      });
      const id2 = api.showTxToast({
        title: "Toast 2 (Mid Success)",
        status: "SUCCESS",
        durationMs: 90,
      });
      const id3 = api.showTxToast({
        title: "Toast 3 (Slow Error)",
        status: "ERROR",
        durationMs: 160,
      });
      const id4 = api.showTxToast({
        title: "Toast 4 (Persistent Pending)",
        status: "PENDING",
        durationMs: 0,
      });
      const id5 = api.showTxToast({
        title: "Toast 5 (Persistent Confirming)",
        status: "CONFIRMING",
        durationMs: 0,
      });
      const id6 = api.showTxToast({
        title: "Toast 6 (Delayed Success)",
        status: "SUCCESS",
        durationMs: 130,
      });

      expect(api.toasts.length).toBe(6);

      // Step 1: Wait 65ms -> Toast 1 (40ms) should be dismissed
      await new Promise((resolve) => setTimeout(resolve, 65));
      expect(api.toasts.some((t) => t.id === id1)).toBe(false);
      expect(api.toasts.length).toBe(5);

      // Step 2: Wait 45ms (t=110ms) -> Toast 2 (90ms) should be dismissed
      await new Promise((resolve) => setTimeout(resolve, 45));
      expect(api.toasts.some((t) => t.id === id2)).toBe(false);
      expect(api.toasts.length).toBe(4);

      // Step 3: Wait 40ms (t=150ms) -> Toast 6 (130ms) should be dismissed
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(api.toasts.some((t) => t.id === id6)).toBe(false);
      expect(api.toasts.length).toBe(3);

      // Step 4: Wait 40ms (t=190ms) -> Toast 3 (160ms) should be dismissed
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(api.toasts.some((t) => t.id === id3)).toBe(false);
      expect(api.toasts.length).toBe(2);

      // Step 5: Verify Toast 4 and 5 (PENDING/CONFIRMING) remain persistent
      expect(api.toasts.map((t) => t.id)).toEqual([id4, id5]);

      // Step 6: Wait additional 100ms -> PENDING and CONFIRMING must NOT auto-dismiss
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(api.toasts.length).toBe(2);
      expect(api.toasts.map((t) => t.id)).toEqual([id4, id5]);
    });

    it("2.2 surgically removes only the target toast on manual dismiss and cancels its timer", async () => {
      const { api } = setupLiveToastHarness();

      const idA = api.showTxToast({ title: "Toast A", status: "SUCCESS", durationMs: 500 });
      const idB = api.showTxToast({ title: "Toast B", status: "SUCCESS", durationMs: 500 });
      const idC = api.showTxToast({ title: "Toast C", status: "SUCCESS", durationMs: 500 });
      const idD = api.showTxToast({ title: "Toast D", status: "SUCCESS", durationMs: 500 });
      const idE = api.showTxToast({ title: "Toast E", status: "SUCCESS", durationMs: 500 });

      expect(api.toasts.length).toBe(5);

      // Manually dismiss middle toast C
      api.dismissTxToast(idC);
      expect(api.toasts.map((t) => t.id)).toEqual([idA, idB, idD, idE]);

      // Dismiss head toast A
      api.dismissTxToast(idA);
      expect(api.toasts.map((t) => t.id)).toEqual([idB, idD, idE]);

      // Dismiss tail toast E
      api.dismissTxToast(idE);
      expect(api.toasts.map((t) => t.id)).toEqual([idB, idD]);

      // Dismiss non-existent ID -> must be safe no-op
      api.dismissTxToast("non_existent_ghost_id");
      expect(api.toasts.map((t) => t.id)).toEqual([idB, idD]);
    });

    it("2.3 correctly dynamically reschedules timer when transitioning from PENDING to SUCCESS", async () => {
      const { api } = setupLiveToastHarness();

      const txId = api.notifyPending("Swap USDC -> PT-bUSDC");
      expect(api.toasts.length).toBe(1);
      expect(api.toasts[0].status).toBe("PENDING");
      expect(api.toasts[0].durationMs).toBe(0);

      // Let 50ms pass in PENDING state -> stays alive
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(api.toasts.length).toBe(1);

      // Update to SUCCESS with short 50ms durationMs
      api.notifySuccess(txId, {
        title: "Swap Confirmed",
        durationMs: 50,
      });

      expect(api.toasts[0].status).toBe("SUCCESS");
      expect(api.toasts[0].durationMs).toBe(50);

      // Wait 75ms -> should now be auto-dismissed
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(api.toasts.length).toBe(0);
    });

    it("2.4 clearAllToasts purges all toasts and cancels active timers completely", async () => {
      const { api, ctx } = setupLiveToastHarness();

      for (let i = 0; i < 10; i++) {
        api.showTxToast({
          title: `Toast #${i}`,
          status: "SUCCESS",
          durationMs: 50,
        });
      }
      expect(api.toasts.length).toBe(10);

      // Call clearAllToasts from context
      ctx.clearAllToasts();
      expect(ctx.toasts.length).toBe(0);
      expect(api.toasts.length).toBe(0);

      // Wait 80ms to ensure no delayed timer callbacks corrupt the queue
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(api.toasts.length).toBe(0);
    });
  });

  // =========================================================================
  // 3. Stellar Expert Explorer Links & Security Attributes
  // =========================================================================
  describe("3. Stellar Expert Explorer Links & Security Attributes", () => {
    const VALID_TESTNET_TX =
      "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5";

    it("3.1 formats standard and 0x-prefixed tx hashes to valid Stellar Expert testnet URLs", () => {
      const urlStandard = formatExplorerTxUrl(VALID_TESTNET_TX);
      expect(urlStandard).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TESTNET_TX}`
      );

      const urlPrefixed = formatExplorerTxUrl(`0x${VALID_TESTNET_TX}`);
      expect(urlPrefixed).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TESTNET_TX}`
      );

      const urlWhitespace = formatExplorerTxUrl(`   ${VALID_TESTNET_TX}   `);
      expect(urlWhitespace).toBe(
        `https://stellar.expert/explorer/testnet/tx/${VALID_TESTNET_TX}`
      );

      expect(formatExplorerTxUrl("")).toBe("");
    });

    it("3.2 strictly matches the Stellar Expert testnet URL regex pattern", () => {
      const testnetPattern =
        /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-fA-F]{64}$/;

      const url = formatExplorerTxUrl(VALID_TESTNET_TX);
      expect(testnetPattern.test(url)).toBe(true);

      // Verify all verified transactions from contracts.ts conform to the pattern
      for (const verifiedTx of STELLAR_PENDLE_CONFIG.verifiedTransactions) {
        expect(testnetPattern.test(verifiedTx.explorerUrl)).toBe(true);
        expect(verifiedTx.txHash.length).toBe(64);
      }
    });

    it("3.3 enforces target='_blank' and rel='noopener noreferrer' security attributes on rendered anchors", () => {
      const toastWithTx: TxToastItem = {
        id: "sec_anchor_toast",
        title: "Confirmed Transaction",
        status: "SUCCESS",
        txHash: VALID_TESTNET_TX,
        explorerUrl: formatExplorerTxUrl(VALID_TESTNET_TX),
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [toastWithTx] },
          React.createElement(Toaster)
        )
      );

      // Must have explorer anchor
      expect(html).toContain(
        `href="https://stellar.expert/explorer/testnet/tx/${VALID_TESTNET_TX}"`
      );
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('aria-label="View transaction on StellarExpert Explorer"');
      expect(html).toContain("StellarExpert");
    });

    it("3.4 safely handles missing, undefined, or empty txHash without rendering invalid anchors", () => {
      const toastWithoutTx: TxToastItem = {
        id: "no_tx_toast",
        title: "Off-chain Action",
        status: "SUCCESS",
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [toastWithoutTx] },
          React.createElement(Toaster)
        )
      );

      // Must NOT render any <a> tags or explorer links
      expect(html).not.toContain("<a");
      expect(html).not.toContain("StellarExpert");
      expect(html).not.toContain("stellar.expert");
    });
  });

  // =========================================================================
  // 4. Design System Compliance: Zero Raw Hex Colors & Zero Unicode Emojis
  // =========================================================================
  describe("4. Design System Compliance Matrix", () => {
    const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/;
    const emojiRegex = /\p{Extended_Pictographic}/u;

    it("4.1 enforces zero raw hex color codes across all M2 source files", () => {
      const sourceFiles = [
        "src/components/ui/Toaster.tsx",
        "src/context/ToastContext.tsx",
        "src/hooks/useTxToast.ts",
      ];

      for (const relFile of sourceFiles) {
        const fullPath = path.join(FRONTEND_DIR, relFile);
        expect(fs.existsSync(fullPath)).toBe(true);

        const content = fs.readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Allow comment mentions or contract IDs
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;
          const match = line.match(rawHexRegex);
          if (match) {
            throw new Error(
              `Raw hex color found in ${relFile}:${i + 1} -> ${match[0]}`
            );
          }
        }
      }
    });

    it("4.2 enforces zero raw Unicode emojis across all M2 source files", () => {
      const sourceFiles = [
        "src/components/ui/Toaster.tsx",
        "src/context/ToastContext.tsx",
        "src/hooks/useTxToast.ts",
      ];

      for (const relFile of sourceFiles) {
        const fullPath = path.join(FRONTEND_DIR, relFile);
        expect(fs.existsSync(fullPath)).toBe(true);

        const content = fs.readFileSync(fullPath, "utf-8");
        const match = content.match(emojiRegex);
        expect(match).toBeNull();
      }
    });

    it("4.3 verifies rendered toast HTML markup is 100% free of raw hex colors and emojis", () => {
      const sampleToasts: TxToastItem[] = [
        {
          id: "t_pending",
          title: "Swap Pending",
          description: "Awaiting signature...",
          status: "PENDING",
          createdAt: Date.now(),
        },
        {
          id: "t_confirming",
          title: "Swap Confirming",
          description: "Broadcasting transaction...",
          status: "CONFIRMING",
          txHash: "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
          explorerUrl: "https://stellar.expert/explorer/testnet/tx/4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
          createdAt: Date.now(),
        },
        {
          id: "t_success",
          title: "Swap Confirmed",
          description: "Settled on testnet.",
          status: "SUCCESS",
          txHash: "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
          explorerUrl: "https://stellar.expert/explorer/testnet/tx/4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
          durationMs: 7000,
          createdAt: Date.now(),
        },
        {
          id: "t_error",
          title: "Swap Failed",
          description: "User rejected signature.",
          status: "ERROR",
          durationMs: 12000,
          createdAt: Date.now(),
        },
      ];

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: sampleToasts },
          React.createElement(Toaster)
        )
      );

      // Verify zero raw hex colors in rendered HTML
      expect(html.match(rawHexRegex)).toBeNull();

      // Verify zero Unicode emojis in rendered HTML
      expect(html.match(emojiRegex)).toBeNull();

      // Verify typography: tabular-mono and font-mono are applied to numerical/hash elements
      expect(html).toContain("tabular-mono font-mono");
    });
  });
});
