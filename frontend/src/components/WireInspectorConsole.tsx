"use client";

import React, { useState } from "react";
import { Check, Copy, ExternalLink, Terminal } from "lucide-react";
import { explorerTxUrl } from "@/lib/contracts";
import { shortenAddress } from "@/lib/math";
import { WireLogEntry } from "@/lib/stellar";

interface WireInspectorConsoleProps {
  logs: WireLogEntry[];
  onClear: () => void;
  hideHeader?: boolean;
}

export function WireInspectorConsole({
  logs,
  onClear,
  hideHeader = false,
}: WireInspectorConsoleProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function copyText(id: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <div className="flex flex-col h-full bg-console text-console-text overflow-hidden">
      {/* Console Header (optional if drawer provides tabs) */}
      {!hideHeader && (
        <div className="flex items-center justify-between border-b border-console-hairline px-4 py-3 bg-console-surface shrink-0">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-console-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-console-accent" />
            </span>
            <Terminal className="h-3.5 w-3.5 text-console-accent" />
            <h2 className="text-xs font-semibold text-console-text">
              Soroban Telemetry Console
            </h2>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border border-console-hairline bg-console px-2.5 py-1 text-xs text-console-muted transition-colors hover:text-console-text hover:border-console-accent active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-console-accent disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      )}

      {/* Log Feed */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2.5 min-h-0">
        {logs.length === 0 ? (
          <div className="rounded-xl border border-console-hairline bg-console-surface p-4 text-xs text-console-muted leading-relaxed">
            Execute any AMM swap, mint, or dry-run simulation to inspect real-time Soroban XDR telemetry.
          </div>
        ) : (
          logs.map((entry) => (
            <div
              key={entry.id}
              className="rounded-xl border border-console-hairline bg-console-surface p-3.5 text-xs transition hover:border-console-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`tabular-mono font-bold ${
                    entry.stage === "ERROR"
                      ? "text-danger"
                      : entry.stage === "CONFIRMING"
                      ? "text-accent animate-pulse motion-reduce:animate-none"
                      : entry.stage === "CONFIRMED"
                      ? "text-positive"
                      : "text-console-accent"
                  }`}
                >
                  [{entry.stage}] {entry.method}
                </span>
                <span className="tabular-mono text-xs text-console-muted">{entry.timestamp}</span>
              </div>
              <p className="mt-1.5 text-console-text leading-snug">{entry.message}</p>

              <div className="tabular-mono mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-console-muted">
                <span>Contract: {shortenAddress(entry.contractId, 5, 4)}</span>
                {entry.minResourceFee && <span>Fee: {entry.minResourceFee} stroops</span>}
                {entry.ledger && <span>Ledger: #{entry.ledger}</span>}
              </div>

              {entry.simulatedReturn && (
                <div className="tabular-mono mt-2 rounded-lg bg-console border border-console-hairline p-2 text-console-accent text-xs break-all">
                  return: {entry.simulatedReturn}
                </div>
              )}

              {entry.unsignedXdr && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-console border border-console-hairline p-2">
                  <span className="tabular-mono truncate text-xs text-console-muted">
                    XDR: {entry.unsignedXdr}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyText(entry.id, entry.unsignedXdr!)}
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-console-accent hover:underline active:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-console-accent"
                  >
                    {copiedId === entry.id ? (
                      <>
                        <Check className="h-3 w-3" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {entry.txHash && (
                <div className="mt-2 pt-2 border-t border-console-hairline flex items-center justify-between">
                  <span className="tabular-mono text-xs text-console-muted">
                    Tx: {shortenAddress(entry.txHash, 6, 6)}
                  </span>
                  <a
                    href={explorerTxUrl(entry.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-console-accent hover:underline"
                  >
                    <span>StellarExpert</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
