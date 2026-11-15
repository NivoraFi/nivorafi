"use client";

import { useCallback } from "react";
import {
  useToastContext,
  TxToastOptions,
  TxToastItem,
  ToastContextValue,
} from "@/context/ToastContext";
import { explorerTxUrl } from "@/lib/contracts";
import { decodeSorobanError } from "@/lib/math";

/**
 * Cleanly formats a Stellar Expert testnet transaction explorer URL.
 * Handles hash trimming and removes optional 0x prefix if present.
 */
export function formatExplorerTxUrl(txHash: string): string {
  if (!txHash) return "";
  const cleaned = txHash.trim().replace(/^0x/, "");
  return explorerTxUrl(cleaned);
}

export type NotifyPendingArg =
  | string
  | { title: string; description?: string; id?: string };

export type NotifyConfirmingArg =
  | string
  | { txHash: string; title?: string; description?: string };

export type NotifySuccessArg =
  | string
  | { txHash?: string; title?: string; description?: string; durationMs?: number };

export interface UseTxToastReturn {
  toasts: TxToastItem[];
  showTxToast: (options: TxToastOptions) => string;
  updateTxToast: (id: string, updates: Partial<TxToastOptions>) => void;
  dismissTxToast: (id: string) => void;
  showToast?: (options: TxToastOptions) => string;
  updateToast?: (id: string, updates: Partial<TxToastOptions>) => void;
  dismissToast?: (id: string) => void;
  formatExplorerTxUrl: (txHash: string) => string;
  notifyPending: (
    paramsOrTitle: NotifyPendingArg,
    description?: string
  ) => string;
  notifyTxPending: (
    paramsOrTitle: NotifyPendingArg,
    description?: string
  ) => string;
  notifyConfirming: (
    id: string,
    txHashOrParams: NotifyConfirmingArg,
    maybeLabel?: string,
    maybeDesc?: string
  ) => void;
  notifyTxConfirming: (
    id: string,
    txHashOrParams: NotifyConfirmingArg,
    maybeLabel?: string,
    maybeDesc?: string
  ) => void;
  notifySuccess: (
    id: string,
    txHashOrParams?: NotifySuccessArg,
    maybeLabel?: string,
    maybeDesc?: string
  ) => void;
  notifyTxSuccess: (
    id: string,
    txHashOrParams?: NotifySuccessArg,
    maybeLabel?: string,
    maybeDesc?: string
  ) => void;
  notifyError: (
    id: string,
    errorOrParams?: unknown,
    maybeTxHash?: string,
    maybeLabel?: string
  ) => void;
  notifyTxError: (
    id: string,
    errorOrParams?: unknown,
    maybeTxHash?: string,
    maybeLabel?: string
  ) => void;
}

const NOOP_TOAST_CONTEXT: ToastContextValue = {
  toasts: [],
  showTxToast: () => "",
  updateTxToast: () => {},
  dismissTxToast: () => {},
  clearAllToasts: () => {},
};

export function useTxToast(): UseTxToastReturn {
  let ctx: ToastContextValue;
  try {
    ctx = useToastContext();
  } catch {
    ctx = NOOP_TOAST_CONTEXT;
  }
  const { showTxToast, updateTxToast, dismissTxToast } = ctx;

  const notifyPending = useCallback(
    (
      paramsOrTitle: NotifyPendingArg,
      description?: string
    ): string => {
      if (typeof paramsOrTitle === "string") {
        return showTxToast({
          title: paramsOrTitle,
          description: description || "Awaiting wallet signature...",
          status: "PENDING",
        });
      }
      return showTxToast({
        id: paramsOrTitle.id,
        title: paramsOrTitle.title,
        description: paramsOrTitle.description || "Awaiting wallet signature...",
        status: "PENDING",
      });
    },
    [showTxToast]
  );

  const notifyConfirming = useCallback(
    (
      id: string,
      txHashOrParams: NotifyConfirmingArg,
      maybeLabel?: string,
      maybeDesc?: string
    ) => {
      let txHash: string;
      let title: string | undefined;
      let description: string | undefined;

      if (typeof txHashOrParams === "string") {
        txHash = txHashOrParams;
        title = maybeLabel;
        description = maybeDesc || "Transaction broadcast. Awaiting ledger confirmation...";
      } else {
        txHash = txHashOrParams.txHash;
        title = txHashOrParams.title;
        description = txHashOrParams.description || "Awaiting ledger confirmation on Stellar...";
      }

      const explorerUrl = formatExplorerTxUrl(txHash);
      updateTxToast(id, {
        status: "CONFIRMING",
        txHash,
        explorerUrl,
        ...(title ? { title } : {}),
        description,
      });
    },
    [updateTxToast]
  );

  const notifySuccess = useCallback(
    (
      id: string,
      txHashOrParams?: NotifySuccessArg,
      maybeLabel?: string,
      maybeDesc?: string
    ) => {
      let txHash: string | undefined;
      let title: string | undefined;
      let description: string | undefined;
      let durationMs: number | undefined;

      if (typeof txHashOrParams === "string") {
        txHash = txHashOrParams;
        title = maybeLabel ? `${maybeLabel} Confirmed` : "Transaction Confirmed";
        description = maybeDesc || "Confirmed on Stellar Testnet.";
      } else if (txHashOrParams && typeof txHashOrParams === "object") {
        txHash = txHashOrParams.txHash;
        title = txHashOrParams.title;
        description = txHashOrParams.description || "Transaction settled on Stellar Testnet.";
        durationMs = txHashOrParams.durationMs;
      } else {
        description = "Transaction settled on Stellar Testnet.";
      }

      const explorerUrl = txHash ? formatExplorerTxUrl(txHash) : undefined;
      updateTxToast(id, {
        status: "SUCCESS",
        txHash,
        explorerUrl,
        ...(title ? { title } : {}),
        description,
        durationMs: durationMs ?? 7000,
      });
    },
    [updateTxToast]
  );

  const notifyError = useCallback(
    (
      id: string,
      errorOrParams?: unknown,
      maybeTxHash?: string,
      maybeLabel?: string
    ) => {
      let rawError: unknown;
      let txHash: string | undefined;
      let title: string | undefined;
      let durationMs: number | undefined;

      if (
        errorOrParams &&
        typeof errorOrParams === "object" &&
        !("message" in errorOrParams) &&
        ("error" in errorOrParams || "title" in errorOrParams || "txHash" in errorOrParams)
      ) {
        const p = errorOrParams as {
          error?: unknown;
          txHash?: string;
          title?: string;
          durationMs?: number;
        };
        rawError = p.error;
        txHash = p.txHash;
        title = p.title;
        durationMs = p.durationMs;
      } else {
        rawError = errorOrParams;
        txHash = maybeTxHash || (rawError as any)?.txHash || undefined;
        title = maybeLabel ? `${maybeLabel} Failed` : "Transaction Failed";
      }

      const errorMsg =
        typeof rawError === "string"
          ? rawError
          : rawError
          ? decodeSorobanError(rawError)
          : "Transaction was aborted or rejected.";

      const resolvedHash = txHash || (rawError as any)?.txHash || undefined;
      const explorerUrl = resolvedHash ? formatExplorerTxUrl(resolvedHash) : undefined;

      updateTxToast(id, {
        status: "ERROR",
        txHash: resolvedHash,
        explorerUrl,
        title: title || "Transaction Failed",
        description: errorMsg,
        durationMs: durationMs ?? 12000,
      });
    },
    [updateTxToast]
  );

  return {
    get toasts() {
      return ctx.toasts;
    },
    showTxToast,
    updateTxToast,
    dismissTxToast,
    showToast: showTxToast,
    updateToast: updateTxToast,
    dismissToast: dismissTxToast,
    formatExplorerTxUrl,
    notifyPending,
    notifyTxPending: notifyPending,
    notifyConfirming,
    notifyTxConfirming: notifyConfirming,
    notifySuccess,
    notifyTxSuccess: notifySuccess,
    notifyError,
    notifyTxError: notifyError,
  };
}
