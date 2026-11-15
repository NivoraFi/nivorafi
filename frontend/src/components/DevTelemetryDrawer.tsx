"use client";

import React, { useEffect, useState } from "react";
import {
  Bot,
  Check,
  Coins,
  Copy,
  Droplets,
  ExternalLink,
  Network,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  STELLAR_PENDLE_CONFIG,
  explorerContractUrl,
  explorerTxUrl,
} from "@/lib/contracts";
import { shortenAddress } from "@/lib/math";
import { WireLogEntry } from "@/lib/stellar";
import { WireInspectorConsole } from "./WireInspectorConsole";
import { ErrorBoundary } from "./ErrorBoundary";

export type DrawerTab = "console" | "contracts" | "proofs" | "mcp" | "tools";

export interface DevTelemetryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  logs: WireLogEntry[];
  onClearLogs: () => void;
  initialTab?: DrawerTab;
  onFundXlm?: () => Promise<void> | void;
  onAddUsdcTrustline?: () => Promise<void> | void;
  busyAction?: string | null;
}

export function DevTelemetryDrawer({
  isOpen,
  onClose,
  logs,
  onClearLogs,
  initialTab = "console",
  onFundXlm,
  onAddUsdcTrustline,
  busyAction,
}: DevTelemetryDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>(initialTab);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Sync initialTab when provided or drawer opens
  useEffect(() => {
    if (isOpen && initialTab) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  const copyToClipboard = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const contractEntries = Object.entries(STELLAR_PENDLE_CONFIG.contracts);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-50 bg-canvas/70 backdrop-blur-sm transition-opacity duration-300 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-out Sheet */}
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-console/95 backdrop-blur-2xl border-l border-console-hairline text-console-text shadow-glass-elevated transition-transform duration-300 ease-in-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-label="Soroban Developer Hub"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-console-hairline bg-console-surface px-5 py-3.5 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-console border border-console-hairline text-console-accent">
              <Terminal className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold tracking-tight text-console-text">
                  Soroban Developer Hub
                </h2>
                <span className="tabular-mono rounded-full bg-console border border-console-hairline px-2 py-0.5 text-xs font-semibold text-console-accent">
                  Testnet
                </span>
              </div>
              <p className="text-xs text-console-muted">
                Live telemetry, contract registry, and protocol proofs.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {activeTab === "console" && logs.length > 0 && (
              <button
                type="button"
                onClick={onClearLogs}
                className="inline-flex items-center gap-1 rounded-lg border border-console-hairline bg-console px-2.5 py-1 text-xs text-console-muted hover:text-console-text hover:border-console-accent transition"
                title="Clear Logs"
              >
                <Trash2 className="h-3 w-3" />
                <span>Clear</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-console-hairline bg-console p-1.5 text-console-muted hover:text-console-text hover:border-console-accent transition"
              title="Close Drawer (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <nav className="flex items-center gap-1 border-b border-console-hairline bg-console-surface/60 px-4 py-2 shrink-0 overflow-x-auto">
          {[
            { id: "console" as const, label: "Console", icon: <Terminal className="h-3.5 w-3.5" />, badge: logs.length },
            { id: "contracts" as const, label: "Contracts", icon: <Network className="h-3.5 w-3.5" />, badge: contractEntries.length },
            { id: "proofs" as const, label: "Proofs", icon: <Zap className="h-3.5 w-3.5" />, badge: STELLAR_PENDLE_CONFIG.verifiedTransactions.length },
            { id: "mcp" as const, label: "AI Agent", icon: <Bot className="h-3.5 w-3.5" /> },
            { id: "tools" as const, label: "Tools", icon: <Droplets className="h-3.5 w-3.5" /> },
          ].map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition shrink-0 ${
                  isActive
                    ? "bg-console border border-console-hairline text-console-accent font-semibold"
                    : "text-console-muted hover:text-console-text hover:bg-console-surface"
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span className="tabular-mono rounded-full bg-console-surface px-1.5 py-0.2 text-xs font-bold text-console-accent">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Tab Content Stage */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* TAB 1: CONSOLE */}
          {activeTab === "console" && (
            <div className="h-full">
              <ErrorBoundary componentName="WireInspectorConsole">
                <WireInspectorConsole logs={logs} onClear={onClearLogs} hideHeader />
              </ErrorBoundary>
            </div>
          )}

          {/* TAB 2: CONTRACT REGISTRY */}
          {activeTab === "contracts" && (
            <div className="p-4 space-y-3">
              <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 text-xs text-console-muted">
                5 verified smart contracts deployed and initialized on Soroban Testnet.
              </div>

              {contractEntries.map(([key, info]) => (
                <div
                  key={key}
                  className="rounded-xl border border-console-hairline bg-console-surface p-3.5 space-y-2 text-xs transition hover:border-console-accent/40"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-console-text">{info.label}</span>
                    <a
                      href={explorerContractUrl(info.contractId)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-console-accent hover:underline"
                    >
                      <span>Explorer</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>

                  <div className="space-y-1 pt-1 border-t border-console-hairline">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-console-muted">Contract ID:</span>
                      <div className="flex items-center gap-1">
                        <span className="tabular-mono text-console-text">
                          {shortenAddress(info.contractId, 8, 8)}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(`cid-${key}`, info.contractId)}
                          className="text-console-muted hover:text-console-accent"
                          title="Copy Contract ID"
                        >
                          {copiedKey === `cid-${key}` ? (
                            <Check className="h-3 w-3 text-console-accent" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-console-muted">WASM Hash:</span>
                      <div className="flex items-center gap-1">
                        <span className="tabular-mono text-console-muted">
                          {shortenAddress(info.wasmHash, 6, 6)}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(`wasm-${key}`, info.wasmHash)}
                          className="text-console-muted hover:text-console-accent"
                          title="Copy WASM Hash"
                        >
                          {copiedKey === `wasm-${key}` ? (
                            <Check className="h-3 w-3 text-console-accent" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-console-muted">Deploy Tx:</span>
                      <a
                        href={explorerTxUrl(info.deployTx)}
                        target="_blank"
                        rel="noreferrer"
                        className="tabular-mono text-xs text-console-accent hover:underline flex items-center gap-0.5"
                      >
                        <span>{shortenAddress(info.deployTx, 6, 6)}</span>
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* TAB 3: VERIFIED PROOFS */}
          {activeTab === "proofs" && (
            <div className="p-4 space-y-3">
              <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 text-xs text-console-muted">
                10 verified protocol execution proofs recorded live on Stellar Testnet.
              </div>

              {STELLAR_PENDLE_CONFIG.verifiedTransactions.map((tx, idx) => (
                <div
                  key={tx.txHash}
                  className="rounded-xl border border-console-hairline bg-console-surface p-3 text-xs space-y-1.5 transition hover:border-console-accent/40"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-console-text">
                      #{idx + 1} {tx.label}
                    </span>
                    <a
                      href={explorerTxUrl(tx.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-console-accent hover:underline"
                    >
                      <span>Proof</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <p className="text-console-muted">{tx.summary}</p>
                  <div className="tabular-mono text-xs text-console-muted truncate pt-1 border-t border-console-hairline">
                    Hash: {tx.txHash}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* TAB 4: AI AGENT MCP STACK */}
          {activeTab === "mcp" && (
            <div className="p-4 space-y-3">
              <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 text-xs text-console-muted">
                Autonomous AI agent endpoints for programmatic yield discovery, quoting, and signing.
              </div>

              <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-console-text">stellar-pendle-mcp</span>
                  <span className="tabular-mono text-xs text-console-accent font-semibold">
                    Native MCP Server
                  </span>
                </div>
                <p className="text-console-muted">
                  8 native tool definitions: quote swaps, inspect AMM state, simulate deposit/mint, construct transaction XDR envelopes.
                </p>
                <div className="rounded-lg bg-console border border-console-hairline p-2 tabular-mono text-xs text-console-text">
                  bun run agent/src/mcp-server.ts
                </div>
              </div>

              <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-console-text">Stellar Raven MCP</span>
                  <span className="tabular-mono text-xs text-positive font-semibold">Live Remote</span>
                </div>
                <p className="text-console-muted">
                  Live MCP protocol for querying ledger state, transaction envelopes, and contract events.
                </p>
                <div className="rounded-lg bg-console border border-console-hairline p-2 tabular-mono text-xs text-console-text">
                  https://raven.stellar.buzz/mcp
                </div>
              </div>

              <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-console-text">OpenZeppelin x402 Channels</span>
                  <span className="tabular-mono text-xs text-console-accent font-semibold">Facilitator</span>
                </div>
                <p className="text-console-muted">
                  Agentic HTTP 402 payment channels and fee sponsorship on Stellar Testnet.
                </p>
                <div className="rounded-lg bg-console border border-console-hairline p-2 tabular-mono text-xs text-console-text">
                  https://channels.openzeppelin.com/testnet
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: TESTNET TOOLS */}
          {activeTab === "tools" && (
            <div className="p-4 space-y-3">
              <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 text-xs text-console-muted">
                Testnet utility routines to fund gas and setup USDC trustlines.
              </div>

              {onFundXlm && (
                <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-semibold text-console-text">
                      <Droplets className="h-4 w-4 text-warn" />
                      <span>Friendbot XLM Faucet</span>
                    </div>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => void onFundXlm()}
                      className="rounded-lg border border-warn bg-warn-soft px-3 py-1 text-xs font-semibold text-warn hover:opacity-90 disabled:opacity-50"
                    >
                      Fund 10,000 XLM
                    </button>
                  </div>
                  <p className="text-console-muted">
                    Requests Friendbot on Stellar Testnet to credit 10,000 native XLM for transaction fees.
                  </p>
                </div>
              )}

              {onAddUsdcTrustline && (
                <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-semibold text-console-text">
                      <ShieldCheck className="h-4 w-4 text-positive" />
                      <span>USDC Trustline Setup</span>
                    </div>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => void onAddUsdcTrustline()}
                      className="rounded-lg border border-positive bg-positive-soft px-3 py-1 text-xs font-semibold text-positive hover:opacity-90 disabled:opacity-50"
                    >
                      Add Trustline
                    </button>
                  </div>
                  <p className="text-console-muted">
                    Creates an active trustline for Circle Testnet USDC issued on Stellar.
                  </p>
                </div>
              )}

              <div className="rounded-xl border border-console-hairline bg-console-surface p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-semibold text-console-text">
                    <Coins className="h-4 w-4 text-console-accent" />
                    <span>Circle USDC Faucet</span>
                  </div>
                  <a
                    href={STELLAR_PENDLE_CONFIG.circleFaucetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-console-hairline bg-console px-3 py-1 text-xs font-semibold text-console-accent hover:border-console-accent"
                  >
                    <span>Claim USDC</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <p className="text-console-muted">
                  Official Circle faucet to claim Testnet USDC for fixed-yield deposits.
                </p>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
