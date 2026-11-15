"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, CheckCircle2, XCircle, ExternalLink, X } from "lucide-react";
import { useToastContext, TxToastItem } from "@/context/ToastContext";
import { shortenAddress } from "@/lib/math";

interface ToastCardProps {
  toast: TxToastItem;
  onDismiss: (id: string) => void;
}

export const __renderedCardsMap = new Map<string, React.ReactElement>();
export let __lastRenderedToasterTree: React.ReactElement | null = null;

function ToastCard({ toast, onDismiss }: ToastCardProps) {
  const [progress, setProgress] = useState(100);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Auto-dismiss countdown calculation
  useEffect(() => {
    if (!toast.durationMs || toast.durationMs <= 0) return;
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.max(0, 100 - (elapsed / toast.durationMs!) * 100);
      setProgress(pct);
      if (pct <= 0) {
        clearInterval(interval);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [toast.durationMs]);

  // Elapsed seconds timer for in-flight transactions
  useEffect(() => {
    if (toast.status !== "PENDING" && toast.status !== "CONFIRMING") return;
    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [toast.status]);

  // Status-driven visual styling
  const isPending = toast.status === "PENDING";
  const isConfirming = toast.status === "CONFIRMING";
  const isSuccess = toast.status === "SUCCESS";
  const isError = toast.status === "ERROR";

  const borderColor = isSuccess
    ? "border-positive/40"
    : isError
    ? "border-danger/40"
    : isConfirming
    ? "border-accent/50"
    : "border-accent/30";

  const statusBadge = isSuccess ? (
    <code className="rounded px-1.5 py-0.5 text-[10px] font-sans font-semibold border border-positive/30 bg-positive-soft text-positive">
      CONFIRMED
    </code>
  ) : isError ? (
    <code className="rounded px-1.5 py-0.5 text-[10px] font-sans font-semibold border border-danger/30 bg-danger-soft text-danger">
      FAILED
    </code>
  ) : isConfirming ? (
    <code className="rounded px-1.5 py-0.5 text-[10px] font-sans font-semibold border border-accent/30 bg-accent-soft text-accent">
      CONFIRMING
    </code>
  ) : (
    <code className="rounded px-1.5 py-0.5 text-[10px] font-sans font-semibold border border-accent/20 bg-accent-soft text-accent">
      PENDING
    </code>
  );

  const cardNode = (
    <div
      role={isError ? "alert" : "status"}
      aria-atomic="true"
      className={`pointer-events-auto relative w-full overflow-hidden rounded-xl bg-surface-glass border shadow-floating backdrop-blur-xl transition-colors duration-300 ${borderColor}`}
    >
      {/* Dynamic Progress Bar */}
      {isPending || isConfirming ? (
        <div className="h-0.5 w-full bg-surface-muted/60 overflow-hidden">
          <div className="h-full w-full bg-accent animate-pulse motion-reduce:animate-none" />
        </div>
      ) : toast.durationMs && toast.durationMs > 0 ? (
        <div className="h-0.5 w-full bg-surface-muted/60 overflow-hidden">
          <div
            className={`h-full ${
              isSuccess ? "bg-positive" : "bg-danger"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}

      <div className="p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            {/* Status Icon */}
            <div className="mt-0.5 shrink-0">
              {isPending && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
              {isConfirming && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
              {isSuccess && <CheckCircle2 className="h-4 w-4 text-positive" />}
              {isError && <XCircle className="h-4 w-4 text-danger" />}
            </div>

            {/* Header, Badge & Text */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-xs font-semibold tracking-tight text-ink truncate">
                  {toast.title}
                </h4>
                {statusBadge}
                {(isPending || isConfirming) && (
                  <span className="tabular-mono font-mono text-[10px] text-ink-muted">
                    {`${elapsedSeconds}s`}
                  </span>
                )}
              </div>

              {toast.description && (
                <p className="mt-1 text-xs text-ink-secondary leading-relaxed break-words">
                  {toast.description}
                </p>
              )}
            </div>
          </div>

          {/* Dismiss Button */}
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="rounded p-1 text-ink-muted hover:text-ink hover:bg-surface-hover active:opacity-70 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 shrink-0"
            aria-label="Dismiss notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Transaction Hash & StellarExpert Link */}
        {toast.txHash && (
          <div className="mt-2.5 pt-2 border-t border-hairline flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 text-ink-muted">
              <span className="text-[11px] font-semibold">Tx:</span>
              <span className="tabular-mono font-mono text-ink-secondary">
                {shortenAddress(toast.txHash, 6, 6)}
              </span>
            </div>

            {toast.explorerUrl && (
              <a
                href={toast.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent-hover transition-colors underline-offset-2 hover:underline"
                aria-label="View transaction on StellarExpert Explorer"
              >
                <span>StellarExpert</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
  __renderedCardsMap.set(toast.id, cardNode);
  return cardNode;
}

export function Toaster() {
  const { toasts, dismissTxToast } = useToastContext();

  if (toasts.length === 0) {
    __lastRenderedToasterTree = null;
    return null;
  }

  const container = (
    <div
      role="region"
      aria-label="Transaction Notifications"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[9998] flex flex-col gap-2.5 max-w-sm w-full pointer-events-none sm:max-w-md px-3 sm:px-0"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={dismissTxToast} />
      ))}
    </div>
  );

  __lastRenderedToasterTree = container;

  return typeof document !== "undefined" && document.body
    ? createPortal(container, document.body)
    : container;
}
