// frontend/src/lib/__tests__/empirical_challenger_m2_c2.test.tsx
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

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
import {
  Toaster,
  __renderedCardsMap,
  __lastRenderedToasterTree,
} from "@/components/ui/Toaster";
import { useTxToast, formatExplorerTxUrl, UseTxToastReturn } from "@/hooks/useTxToast";
import { explorerTxUrl } from "@/lib/contracts";
import { decodeSorobanError, shortenAddress, CONTRACT_ERROR_MESSAGES, HORIZON_ERROR_MESSAGES } from "@/lib/math";

// ----------------------------------------------------------------------------
// Test Fixtures & Vectors
// ----------------------------------------------------------------------------
const VALID_TX_HASH_64 = "4c9112a5d5ba15e8eaa1b51d1b0a357428099f7557c34029f9ecb95c7e2b2af6";
const VALID_TX_HASH_0X = "0x4c9112a5d5ba15e8eaa1b51d1b0a357428099f7557c34029f9ecb95c7e2b2af6";
const VALID_TX_HASH_SPACED = "  4c9112a5d5ba15e8eaa1b51d1b0a357428099f7557c34029f9ecb95c7e2b2af6  ";
const EXPECTED_EXPLORER_URL = `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH_64}`;

// Helper consumer harness to execute hook API inside React context
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

describe("Empirical Challenger 2: Adversarial Error Handling & Soroban Diagnostic Link Stress Suite", () => {
  beforeEach(() => {
    __renderedCardsMap.clear();
  });

  // =========================================================================
  // Dimension 1: Soroban Contract Execution Errors & Edge Cases
  // =========================================================================
  describe("Dimension 1: Soroban Contract Execution Errors & Edge Cases", () => {
    it("1.1 decodes custom contract error code 9 (SlippageExceeded) cleanly", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Swap 100 USDC", id: "tx_slip" });

      const sorobanError = new Error("HostError: Error(Contract, #9)");
      api.notifyTxError(id, sorobanError, VALID_TX_HASH_64, "Swap Action");

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].title).toBe("Swap Action Failed");
      expect(api.toasts[0].description).toBe(
        "Soroban ContractError #9: Output fell below your slippage tolerance limit."
      );
      expect(api.toasts[0].txHash).toBe(VALID_TX_HASH_64);
      expect(api.toasts[0].explorerUrl).toBe(EXPECTED_EXPLORER_URL);
    });

    it("1.2 decodes custom contract error code 5 (InsufficientBalance) cleanly", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Deposit Collateral", id: "tx_insuf_bal" });

      const sorobanError = new Error("Error(Contract, 5)");
      api.notifyTxError(id, sorobanError, VALID_TX_HASH_64, "Deposit");

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe(
        "Soroban ContractError #5: Insufficient token or pool reserve balance."
      );
    });

    it("1.3 decodes custom contract error code 4 (ZeroAmount) cleanly", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Mint PT+YT", id: "tx_zero_amt" });

      const sorobanError = new Error("ContractError::ZeroAmount Error(Contract, #4)");
      api.notifyTxError(id, sorobanError, undefined, "Mint Action");

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe(
        "Soroban ContractError #4: Amount must be strictly greater than zero."
      );
    });

    it("1.4 decodes custom contract error code 14 (ProportionOutOfBounds) cleanly", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Swap Outsized LP", id: "tx_bounds" });

      const sorobanError = new Error("HostError: Error(Contract, #14)");
      api.notifyTxError(id, sorobanError, VALID_TX_HASH_64, "Large Swap");

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe(
        "Soroban ContractError #14: Trade pushes AMM reserve ratio beyond allowed 4%-96% bounds."
      );
    });

    it("1.5 decodes custom contract error code 17 (ReentrancyLocked) cleanly", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Reentrant Call", id: "tx_reentrant" });

      const sorobanError = new Error("Error(Contract, #17)");
      api.notifyTxError(id, sorobanError, VALID_TX_HASH_64, "Nested Swap");

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe(
        "Soroban ContractError #17: Reentrancy guard rejected nested contract call."
      );
    });

    it("1.6 decodes contract errors 7 (AlreadyMatured) and 8 (NotYetMatured)", () => {
      const api = setupToastApi();
      const id1 = api.notifyPending({ title: "Swap Past Maturity", id: "tx_mat_1" });
      api.notifyTxError(id1, new Error("Error(Contract, #7)"), VALID_TX_HASH_64);
      expect(api.toasts.find((t) => t.id === id1)?.description).toBe(
        "Soroban ContractError #7: Market has already reached maturity."
      );

      const id2 = api.notifyPending({ title: "Redeem Prior Maturity", id: "tx_mat_2" });
      api.notifyTxError(id2, new Error("Error(Contract, #8)"), VALID_TX_HASH_64);
      expect(api.toasts.find((t) => t.id === id2)?.description).toBe(
        "Soroban ContractError #8: Market has not reached maturity yet."
      );
    });

    it("1.7 decodes contract errors 20 (DivisionByZero) and 23 (ContractPaused)", () => {
      const api = setupToastApi();
      const id1 = api.notifyPending({ title: "Math Calculation", id: "tx_div_0" });
      api.notifyTxError(id1, new Error("Error(Contract, #20)"), VALID_TX_HASH_64);
      expect(api.toasts.find((t) => t.id === id1)?.description).toBe(
        "Soroban ContractError #20: Division by zero in fixed-point math."
      );

      const id2 = api.notifyPending({ title: "Emergency Paused", id: "tx_paused" });
      api.notifyTxError(id2, new Error("Error(Contract, #23)"), VALID_TX_HASH_64);
      expect(api.toasts.find((t) => t.id === id2)?.description).toBe(
        "Soroban ContractError #23: Contract is currently paused by emergency guardian."
      );
    });

    it("1.8 handles unknown contract error codes (e.g. #99, #1337) gracefully with standard fallback", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Unknown Failure", id: "tx_unknown_err" });

      const sorobanError = new Error("HostError: Error(Contract, #99)");
      api.notifyTxError(id, sorobanError, VALID_TX_HASH_64, "Exotic Op");

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe(
        "Soroban ContractError #99: Unknown contract error code."
      );
    });

    it("1.9 handles Soroban host trap panics (unreachable / panic / stack overflow)", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Host Panic", id: "tx_host_panic" });

      const trapError = new Error("Host trap: unreachable instruction executed at wasm[0]");
      api.notifyTxError(id, trapError, VALID_TX_HASH_64, "VM Exec");

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe(
        "Host trap: unreachable instruction executed at wasm[0]"
      );
    });

    it("1.10 handles Horizon / Stellar Core result codes cleanly", () => {
      const api = setupToastApi();

      const testCases = [
        {
          raw: "Transaction failed with op_underfunded",
          expected: "Account balance is insufficient to complete the operation.",
        },
        {
          raw: "Horizon error: tx_insufficient_balance",
          expected: "Account has insufficient native XLM balance for fees.",
        },
        {
          raw: "RESOURCE_LIMIT_EXCEEDED during simulation",
          expected: "Transaction exceeded Soroban CPU or memory resource limits.",
        },
        {
          raw: "Contract error: ENTRY_EXPIRED on instance storage",
          expected: "Soroban contract storage entry has expired and must be restored.",
        },
        {
          raw: "Core rejected: tx_bad_auth",
          expected: "Transaction authorization failed (bad signature or unauthorized signer).",
        },
        {
          raw: "Ledger error: tx_bad_seq",
          expected: "Transaction sequence number is stale or invalid. Please sync ledger and retry.",
        },
      ];

      testCases.forEach((tc, idx) => {
        const id = `tx_horizon_${idx}`;
        api.notifyPending({ title: `Op ${idx}`, id });
        api.notifyTxError(id, new Error(tc.raw));
        const item = api.toasts.find((t) => t.id === id);
        expect(item?.description).toBe(tc.expected);
      });
    });

    it("1.11 verifies string-based error object parameter format: notifyTxError(id, { error, txHash })", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Param Format Test", id: "tx_param_fmt" });

      api.notifyTxError(id, {
        error: new Error("HostError: Error(Contract, #9)"),
        txHash: VALID_TX_HASH_64,
        title: "Swap Slippage Hit",
      });

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].title).toBe("Swap Slippage Hit");
      expect(api.toasts[0].description).toBe(
        "Soroban ContractError #9: Output fell below your slippage tolerance limit."
      );
      expect(api.toasts[0].txHash).toBe(VALID_TX_HASH_64);
    });
  });

  // =========================================================================
  // Dimension 2: Ledger Settlement vs Diagnostic Explorer Link Integrity
  // =========================================================================
  describe("Dimension 2: Ledger Settlement vs Diagnostic Explorer Link Integrity", () => {
    it("2.1 attaches valid StellarExpert explorer link when 64-char hex hash is provided", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Swap Broadcast", id: "tx_diag_1" });

      api.notifyTxError(id, new Error("Simulation failure on ledger"), VALID_TX_HASH_64);

      expect(api.toasts[0].txHash).toBe(VALID_TX_HASH_64);
      expect(api.toasts[0].explorerUrl).toBe(EXPECTED_EXPLORER_URL);

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: api.toasts },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain(`href="${EXPECTED_EXPLORER_URL}"`);
      expect(html).toContain("StellarExpert");
    });

    it("2.2 cleans 0x prefix from hash and constructs valid testnet explorer link", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Prefixed Hash Op", id: "tx_0x" });

      api.notifyTxError(id, new Error("Contract error on-chain"), VALID_TX_HASH_0X);

      // formatExplorerTxUrl cleans the 0x prefix
      expect(api.toasts[0].explorerUrl).toBe(EXPECTED_EXPLORER_URL);
    });

    it("2.3 trims leading and trailing whitespace from txHash", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Spaced Hash Op", id: "tx_spaced" });

      api.notifyTxError(id, new Error("Spaced hash on-chain"), VALID_TX_HASH_SPACED);

      expect(api.toasts[0].explorerUrl).toBe(EXPECTED_EXPLORER_URL);
    });

    it("2.4 explorer link strictly enforces target='_blank' and rel='noopener noreferrer'", () => {
      const toastWithHash: TxToastItem = {
        id: "tx_sec_audit",
        title: "Security Link Audit",
        status: "ERROR",
        txHash: VALID_TX_HASH_64,
        explorerUrl: EXPECTED_EXPLORER_URL,
        description: "On-chain failure occurred",
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [toastWithHash] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('aria-label="View transaction on StellarExpert Explorer"');
    });

    it("2.5 explorer link strictly matches regex ^https://stellar.expert/explorer/testnet/tx/[a-fA-F0-9]{64}$", () => {
      const toastWithHash: TxToastItem = {
        id: "tx_regex_audit",
        title: "Regex Audit",
        status: "ERROR",
        txHash: VALID_TX_HASH_64,
        explorerUrl: formatExplorerTxUrl(VALID_TX_HASH_64),
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [toastWithHash] },
          React.createElement(Toaster)
        )
      );

      const match = html.match(/href="([^"]+)"/);
      expect(match).not.toBeNull();
      const href = match![1];
      const testnetTxRegex = /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[a-fA-F0-9]{64}$/;
      expect(testnetTxRegex.test(href)).toBe(true);
    });

    it("2.6 renders shortened transaction hash using shortenAddress(hash, 6, 6)", () => {
      const toastWithHash: TxToastItem = {
        id: "tx_shorten_audit",
        title: "Shorten Audit",
        status: "ERROR",
        txHash: VALID_TX_HASH_64,
        explorerUrl: EXPECTED_EXPLORER_URL,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [toastWithHash] },
          React.createElement(Toaster)
        )
      );

      const expectedShort = shortenAddress(VALID_TX_HASH_64, 6, 6);
      expect(html).toContain(expectedShort);
      expect(expectedShort).toBe("4c9112...2b2af6");
    });
  });

  // =========================================================================
  // Dimension 3: Pre-Broadcast Wallet Rejections & Signer Cancellations (Anti-Link Guarantee)
  // =========================================================================
  describe("Dimension 3: Pre-Broadcast Wallet Rejections & Signer Cancellations (Anti-Link Guarantee)", () => {
    it("3.1 user declines signing in Freighter: NO txHash and NO explorerUrl attached", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Swap Action", id: "tx_reject_freighter" });

      const declineError = new Error("User declined transaction signing in Freighter");
      api.notifyTxError(id, declineError);

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe("Wallet signature request was cancelled by user.");
      expect(api.toasts[0].txHash).toBeUndefined();
      expect(api.toasts[0].explorerUrl).toBeUndefined();
    });

    it("3.2 user cancels signing dialog: NO txHash and NO explorerUrl attached", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Mint Action", id: "tx_cancel_dialog" });

      const cancelError = new Error("User cancelled the transaction signature.");
      api.notifyTxError(id, cancelError);

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe("Wallet signature request was cancelled by user.");
      expect(api.toasts[0].txHash).toBeUndefined();
      expect(api.toasts[0].explorerUrl).toBeUndefined();
    });

    it("3.3 wallet rejection with 'rejected' keyword: decodes cleanly without explorer link", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Redeem Action", id: "tx_rejected_kw" });

      const rejectError = new Error("Transaction signature rejected by user.");
      api.notifyTxError(id, rejectError);

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].description).toBe("Wallet signature request was cancelled by user.");
      expect(api.toasts[0].txHash).toBeUndefined();
      expect(api.toasts[0].explorerUrl).toBeUndefined();
    });

    it("3.4 pre-broadcast rejection rendered HTML contains NO explorer link, NO stellar.expert, NO StellarExpert", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Pre-broadcast Cancel", id: "tx_render_pre_reject" });

      api.notifyTxError(id, new Error("User declined transaction signing"));

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: api.toasts },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain('role="alert"');
      expect(html).toContain("FAILED");
      expect(html).toContain("Wallet signature request was cancelled by user.");
      expect(html).not.toContain("stellar.expert");
      expect(html).not.toContain("StellarExpert");
      expect(html).not.toContain("href=");
      expect(html).not.toContain("Tx:");
    });

    it("3.5 edge case: txHash=undefined guarantees undefined explorerUrl", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Explicit Undefined", id: "tx_undef_hash" });

      api.notifyTxError(id, new Error("Simulation preflight failed"), undefined, "Preflight");

      expect(api.toasts[0].txHash).toBeUndefined();
      expect(api.toasts[0].explorerUrl).toBeUndefined();
    });

    it("3.6 edge case: txHash='' (empty string) guarantees undefined explorerUrl", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Empty Hash", id: "tx_empty_hash" });

      api.notifyTxError(id, new Error("Simulation preflight failed"), "", "Preflight");

      expect(api.toasts[0].txHash).toBeUndefined();
      expect(api.toasts[0].explorerUrl).toBeUndefined();

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: api.toasts },
          React.createElement(Toaster)
        )
      );
      expect(html).not.toContain("stellar.expert");
      expect(html).not.toContain("StellarExpert");
    });

    it("3.7 direct lifecycle abort: PENDING toast transitions directly to ERROR without intermediate CONFIRMING state", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Direct Abort", id: "tx_direct_abort" });
      expect(api.toasts[0].status).toBe("PENDING");

      api.notifyTxError(id, new Error("User declined transaction"));
      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].txHash).toBeUndefined();
      expect(api.toasts[0].explorerUrl).toBeUndefined();
    });
  });

  // =========================================================================
  // Dimension 4: Design System & Tabular Typography Enforcement
  // =========================================================================
  describe("Dimension 4: Design System & Tabular Typography Enforcement", () => {
    it("4.1 transaction hash display strictly enforces tabular-mono font-mono CSS classes", () => {
      const onChainToast: TxToastItem = {
        id: "tx_tab_hash_check",
        title: "Tabular Hash Check",
        status: "ERROR",
        txHash: VALID_TX_HASH_64,
        explorerUrl: EXPECTED_EXPLORER_URL,
        description: "Transaction execution reverted",
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [onChainToast] },
          React.createElement(Toaster)
        )
      );

      // Verify tabular-mono font-mono on hash display container
      expect(html).toContain('class="tabular-mono font-mono text-ink-secondary"');
      expect(html).toContain(shortenAddress(VALID_TX_HASH_64, 6, 6));
    });

    it("4.2 in-flight elapsed duration timer strictly enforces tabular-mono font-mono CSS classes", () => {
      const inFlightToast: TxToastItem = {
        id: "tx_tab_timer_check",
        title: "Pending Tx Timer",
        status: "CONFIRMING",
        txHash: VALID_TX_HASH_64,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [inFlightToast] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain('class="tabular-mono font-mono text-[10px] text-ink-muted"');
      expect(html).toContain("0s");
    });

    it("4.3 zero raw hex color codes (#[0-9a-fA-F]{3,8}) present in rendered toast markup", () => {
      const allStatusToasts: TxToastItem[] = [
        {
          id: "t_pending",
          title: "Pending Op",
          status: "PENDING",
          createdAt: Date.now(),
        },
        {
          id: "t_confirming",
          title: "Confirming Op",
          status: "CONFIRMING",
          txHash: VALID_TX_HASH_64,
          explorerUrl: EXPECTED_EXPLORER_URL,
          createdAt: Date.now(),
        },
        {
          id: "t_success",
          title: "Success Op",
          status: "SUCCESS",
          txHash: VALID_TX_HASH_64,
          explorerUrl: EXPECTED_EXPLORER_URL,
          durationMs: 7000,
          createdAt: Date.now(),
        },
        {
          id: "t_error_onchain",
          title: "On-Chain Error Op",
          status: "ERROR",
          txHash: VALID_TX_HASH_64,
          explorerUrl: EXPECTED_EXPLORER_URL,
          description: "Soroban ContractError #9: Output fell below your slippage tolerance limit.",
          durationMs: 12000,
          createdAt: Date.now(),
        },
        {
          id: "t_error_prebroadcast",
          title: "Pre-Broadcast Error Op",
          status: "ERROR",
          description: "Wallet signature request was cancelled by user.",
          durationMs: 12000,
          createdAt: Date.now(),
        },
      ];

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: allStatusToasts },
          React.createElement(Toaster)
        )
      );

      const hexRegex = /#[0-9a-fA-F]{3,8}\b/g;
      const hexMatches = html.match(hexRegex);
      expect(hexMatches).toBeNull();
    });

    it("4.4 zero raw Unicode emojis present in rendered toast markup", () => {
      const errorToast: TxToastItem = {
        id: "t_emoji_check",
        title: "Emoji Verification",
        status: "ERROR",
        description: "Soroban ContractError #9: Output fell below your slippage tolerance limit.",
        txHash: VALID_TX_HASH_64,
        explorerUrl: EXPECTED_EXPLORER_URL,
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [errorToast] },
          React.createElement(Toaster)
        )
      );

      const emojiRegex =
        /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(emojiRegex.test(html)).toBe(false);
    });

    it("4.5 error status badge uses semantic design system tokens without arbitrary styles", () => {
      const errorToast: TxToastItem = {
        id: "t_badge_check",
        title: "Semantic Token Check",
        status: "ERROR",
        createdAt: Date.now(),
      };

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: [errorToast] },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain("border-danger/30");
      expect(html).toContain("bg-danger-soft");
      expect(html).toContain("text-danger");
      expect(html).toContain("FAILED");
    });
  });

  // =========================================================================
  // Dimension 5: Hostile Inputs, Boundary Limits & Stress Harness
  // =========================================================================
  describe("Dimension 5: Hostile Inputs, Boundary Limits & Stress Harness", () => {
    it("5.1 handles extremely long error messages (>500 chars) with safe truncation", () => {
      const longMessage = "HostError: " + "A".repeat(600);
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Long Message", id: "tx_long" });

      api.notifyTxError(id, new Error(longMessage));

      // decodeSorobanError truncates to 220 chars + '...' = 223 chars
      const desc = api.toasts[0].description;
      expect(desc).toBeDefined();
      expect(desc!.length).toBeLessThanOrEqual(230);
      expect(desc!.endsWith("...")).toBe(true);
    });

    it("5.2 handles null, undefined, empty object, and non-error thrown values gracefully", () => {
      const api = setupToastApi();

      // Case 1: null error
      const id1 = api.notifyPending({ title: "Null Error", id: "tx_null" });
      api.notifyTxError(id1, null);
      expect(api.toasts.find((t) => t.id === id1)?.description).toBe(
        "Transaction was aborted or rejected."
      );

      // Case 2: undefined error
      const id2 = api.notifyPending({ title: "Undefined Error", id: "tx_undef" });
      api.notifyTxError(id2, undefined);
      expect(api.toasts.find((t) => t.id === id2)?.description).toBe(
        "Transaction was aborted or rejected."
      );

      // Case 3: Empty object {}
      const id3 = api.notifyPending({ title: "Empty Obj Error", id: "tx_empty_obj" });
      api.notifyTxError(id3, {});
      expect(api.toasts.find((t) => t.id === id3)?.description).toBeDefined();

      // Case 4: Numeric throw (e.g. throw 500)
      const id4 = api.notifyPending({ title: "Number Throw", id: "tx_num" });
      api.notifyTxError(id4, 500);
      expect(api.toasts.find((t) => t.id === id4)?.description).toBe("500");
    });

    it("5.3 rapid concurrent error stress harness (50 simultaneous failures) preserves queue integrity", () => {
      const api = setupToastApi();
      const TOTAL_ERRORS = 50;

      for (let i = 0; i < TOTAL_ERRORS; i++) {
        const id = `tx_stress_${i}`;
        api.notifyPending({ title: `Op #${i}`, id });
        const errorCode = (i % 31) + 1; // 1 to 31
        api.notifyTxError(
          id,
          new Error(`Error(Contract, #${errorCode})`),
          i % 2 === 0 ? VALID_TX_HASH_64 : undefined,
          `Action #${i}`
        );
      }

      expect(api.toasts.length).toBe(TOTAL_ERRORS);

      // Verify every item has ERROR status and correct description
      api.toasts.forEach((toast, idx) => {
        expect(toast.status).toBe("ERROR");
        const expectedCode = (idx % 31) + 1;
        expect(toast.description).toContain(`ContractError #${expectedCode}`);
        if (idx % 2 === 0) {
          expect(toast.txHash).toBe(VALID_TX_HASH_64);
          expect(toast.explorerUrl).toBe(EXPECTED_EXPLORER_URL);
        } else {
          expect(toast.txHash).toBeUndefined();
          expect(toast.explorerUrl).toBeUndefined();
        }
      });
    });

    it("5.4 dismissing failure toast cleans up DOM node and leaves remaining error toasts uncorrupted", () => {
      const api = setupToastApi();
      const id1 = api.notifyPending({ title: "Error 1", id: "t_del_1" });
      const id2 = api.notifyPending({ title: "Error 2", id: "t_del_2" });
      const id3 = api.notifyPending({ title: "Error 3", id: "t_del_3" });

      api.notifyTxError(id1, new Error("Error(Contract, #1)"));
      api.notifyTxError(id2, new Error("Error(Contract, #2)"));
      api.notifyTxError(id3, new Error("Error(Contract, #3)"));

      expect(api.toasts.length).toBe(3);

      // Dismiss middle toast
      api.dismissTxToast(id2);

      expect(api.toasts.length).toBe(2);
      expect(api.toasts.map((t) => t.id)).toEqual(["t_del_1", "t_del_3"]);
    });

    it("5.5 non-hex or malformed txHash does not crash formatting or rendering", () => {
      const api = setupToastApi();
      const id = api.notifyPending({ title: "Malformed Hash", id: "tx_malformed" });

      api.notifyTxError(id, new Error("Revert"), "not-a-valid-hex-hash");

      expect(api.toasts[0].status).toBe("ERROR");
      expect(api.toasts[0].txHash).toBe("not-a-valid-hex-hash");

      const html = renderToString(
        React.createElement(
          ToastProvider,
          { initialToasts: api.toasts },
          React.createElement(Toaster)
        )
      );

      expect(html).toContain('role="alert"');
      expect(html).toContain("StellarExpert");
    });
  });
});
