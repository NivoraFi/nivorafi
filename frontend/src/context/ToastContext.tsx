"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { explorerTxUrl } from "@/lib/contracts";

export type TxToastStatus = "PENDING" | "CONFIRMING" | "SUCCESS" | "ERROR";

export interface TxToastOptions {
  id?: string;
  title: string;
  description?: string;
  status: TxToastStatus;
  txHash?: string;
  explorerUrl?: string;
  durationMs?: number;
}

export interface TxToastItem extends TxToastOptions {
  id: string;
  createdAt: number;
}

export interface ToastContextValue {
  toasts: TxToastItem[];
  showTxToast: (options: TxToastOptions) => string;
  updateTxToast: (id: string, updates: Partial<TxToastOptions>) => void;
  dismissTxToast: (id: string) => void;
  clearAllToasts: () => void;
  showToast?: (options: TxToastOptions) => string;
  updateToast?: (id: string, updates: Partial<TxToastOptions>) => void;
  dismissToast?: (id: string) => void;
}

export const NOOP_TOAST_CONTEXT: ToastContextValue = {
  toasts: [],
  showTxToast: () => "",
  updateTxToast: () => {},
  dismissTxToast: () => {},
  clearAllToasts: () => {},
  showToast: () => "",
  updateToast: () => {},
  dismissToast: () => {},
};

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_SUCCESS_DURATION_MS = 7000;
const DEFAULT_ERROR_DURATION_MS = 12000;

let activeContextForInspection: ToastContextValue | null = null;

export function setActiveContextForInspection(ctx: ToastContextValue | null) {
  activeContextForInspection = ctx;
}

export interface ToastProviderProps {
  children?: React.ReactNode;
  initialToasts?: TxToastItem[];
}

export function ToastProvider({
  children,
  initialToasts = [],
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<TxToastItem[]>(initialToasts);
  const toastsRef = useRef<TxToastItem[]>(initialToasts);

  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearToastTimer = useCallback((id: string) => {
    const existing = timersRef.current.get(id);
    if (existing) {
      clearTimeout(existing);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissTxToast = useCallback(
    (id: string) => {
      clearToastTimer(id);
      const next = toastsRef.current.filter((t) => t.id !== id);
      toastsRef.current = next;
      setToasts(next);
    },
    [clearToastTimer]
  );

  const scheduleDismiss = useCallback(
    (id: string, durationMs: number) => {
      clearToastTimer(id);
      if (durationMs > 0) {
        const timer = setTimeout(() => {
          dismissTxToast(id);
        }, durationMs);
        timersRef.current.set(id, timer);
      }
    },
    [clearToastTimer, dismissTxToast]
  );

  const showTxToast = useCallback(
    (options: TxToastOptions): string => {
      const id =
        options.id ||
        (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

      const resolvedExplorerUrl =
        options.explorerUrl || (options.txHash ? explorerTxUrl(options.txHash) : undefined);

      let effectiveDuration = options.durationMs;
      if (effectiveDuration === undefined) {
        if (options.status === "SUCCESS") {
          effectiveDuration = DEFAULT_SUCCESS_DURATION_MS;
        } else if (options.status === "ERROR") {
          effectiveDuration = DEFAULT_ERROR_DURATION_MS;
        } else {
          effectiveDuration = 0;
        }
      }

      const newItem: TxToastItem = {
        ...options,
        id,
        explorerUrl: resolvedExplorerUrl,
        durationMs: effectiveDuration,
        createdAt: Date.now(),
      };

      const exists = toastsRef.current.some((t) => t.id === id);
      const next = exists
        ? toastsRef.current.map((t) => (t.id === id ? newItem : t))
        : [...toastsRef.current, newItem];
      toastsRef.current = next;
      setToasts(next);

      if (effectiveDuration > 0) {
        scheduleDismiss(id, effectiveDuration);
      } else {
        clearToastTimer(id);
      }

      return id;
    },
    [clearToastTimer, scheduleDismiss]
  );

  const updateTxToast = useCallback(
    (id: string, updates: Partial<TxToastOptions>) => {
      const next = toastsRef.current.map((t) => {
        if (t.id !== id) return t;

        const updatedTxHash = updates.txHash !== undefined ? updates.txHash : t.txHash;
        const resolvedExplorerUrl =
          updates.explorerUrl !== undefined
            ? updates.explorerUrl
            : updatedTxHash
            ? explorerTxUrl(updatedTxHash)
            : t.explorerUrl;

        const newStatus = updates.status !== undefined ? updates.status : t.status;
        let effectiveDuration = updates.durationMs !== undefined ? updates.durationMs : t.durationMs;

        if (updates.durationMs === undefined && updates.status !== undefined && updates.status !== t.status) {
          if (newStatus === "SUCCESS") {
            effectiveDuration = DEFAULT_SUCCESS_DURATION_MS;
          } else if (newStatus === "ERROR") {
            effectiveDuration = DEFAULT_ERROR_DURATION_MS;
          } else if (newStatus === "PENDING" || newStatus === "CONFIRMING") {
            effectiveDuration = 0;
          }
        }

        if (effectiveDuration && effectiveDuration > 0) {
          scheduleDismiss(id, effectiveDuration);
        } else if (newStatus === "PENDING" || newStatus === "CONFIRMING") {
          clearToastTimer(id);
        }

        return {
          ...t,
          ...updates,
          txHash: updatedTxHash,
          explorerUrl: resolvedExplorerUrl,
          status: newStatus,
          durationMs: effectiveDuration,
        };
      });

      toastsRef.current = next;
      setToasts(next);
    },
    [clearToastTimer, scheduleDismiss]
  );

  const clearAllToasts = useCallback(() => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current.clear();
    toastsRef.current = [];
    setToasts([]);
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      get toasts() {
        return toastsRef.current;
      },
      showTxToast,
      updateTxToast,
      dismissTxToast,
      clearAllToasts,
      showToast: showTxToast,
      updateToast: updateTxToast,
      dismissToast: dismissTxToast,
    }),
    [showTxToast, updateTxToast, dismissTxToast, clearAllToasts]
  );

  activeContextForInspection = value;

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return NOOP_TOAST_CONTEXT;
  }
  return ctx;
}

export const useToast = useToastContext;
