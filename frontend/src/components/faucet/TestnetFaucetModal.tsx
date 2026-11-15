"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Droplets,
  ExternalLink,
  Layers,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import { useTxToast } from "@/hooks/useTxToast";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import { shortenAddress } from "@/lib/math";
import {
  buildActionArgs,
  prepareChangeTrustUsdcTx,
  prepareContractCallTx,
  prepareSwapXlmForUsdcSdexTx,
  requestFriendbotFunding,
  submitSignedHorizonTx,
  submitSignedSorobanTx,
} from "@/lib/stellar";

export type FaucetStepId = 1 | 2 | 3 | 4 | 5;

export interface TestnetFaucetModalProps {
  isOpen: boolean;
  onClose: () => void;
  // State overrides for testing or fine-grained caller control
  address?: string | null;
  accountExists?: boolean | null;
  xlmBalance?: string | null;
  usdcBalance?: string | null;
  usdcTrustlineExists?: boolean | null;
  syBalance?: bigint | null;
  ptBalance?: bigint | null;
  ytBalance?: bigint | null;
  busyStep?: "friendbot" | "trustline" | "sdex" | "deposit" | "mint" | string | null;
  walletNetworkMismatch?: boolean;
  onFundXlm?: () => void | Promise<void>;
  onAddUsdcTrustline?: () => void | Promise<void>;
  onSwapXlmForUsdc?: () => void | Promise<void>;
  onDepositSy?: (amount: bigint) => void | Promise<void>;
  onMintPy?: (amount: bigint) => void | Promise<void>;
  defaultMarketId?: string;
  initialStep?: FaucetStepId;
}

/**
 * Format balance number with comma separators and fixed decimal precision.
 * Enforces en-US localization so 10000.00 to 10,000.00.
 */
function formatBalance(
  val: string | bigint | number | null | undefined,
  decimals = 7,
  fractionDigits = 2
): string {
  if (val === null || val === undefined) return "0.00";
  if (typeof val === "bigint") {
    const num = Number(val) / 10 ** decimals;
    return num.toLocaleString("en-US", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  }
  const n = typeof val === "number" ? val : parseFloat(val);
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function TestnetFaucetModal({
  isOpen,
  onClose,
  address,
  accountExists,
  xlmBalance,
  usdcBalance,
  usdcTrustlineExists,
  syBalance,
  ptBalance,
  ytBalance,
  busyStep,
  walletNetworkMismatch,
  onFundXlm,
  onAddUsdcTrustline,
  onSwapXlmForUsdc,
  onDepositSy,
  onMintPy,
}: TestnetFaucetModalProps) {
  // Safe hook ingestion (falls back cleanly if rendered in isolation)
  const wallet = useWallet();
  const marketCtx = useMarket();
  const txToast = useTxToast();

  const [internalBusyStep, setInternalBusyStep] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Resolved effective values
  const effectiveAddress = address !== undefined ? address : wallet.address;
  const effectiveAccountExists =
    accountExists !== undefined
      ? accountExists
      : marketCtx.activePortfolio?.accountExists ?? false;
  const effectiveXlmBalance =
    xlmBalance !== undefined
      ? xlmBalance
      : marketCtx.activePortfolio?.xlmBalance ?? "0";
  const effectiveUsdcBalance =
    usdcBalance !== undefined
      ? usdcBalance
      : marketCtx.activePortfolio?.usdcBalance ?? "0";
  const effectiveUsdcTrustlineExists =
    usdcTrustlineExists !== undefined
      ? usdcTrustlineExists
      : marketCtx.activePortfolio?.usdcTrustlineExists ?? false;
  const effectiveSyBalance =
    syBalance !== undefined
      ? syBalance
      : marketCtx.activePortfolio?.syBalance ?? 0n;
  const effectivePtBalance =
    ptBalance !== undefined
      ? ptBalance
      : marketCtx.activePortfolio?.ptBalance ?? 0n;
  const effectiveYtBalance =
    ytBalance !== undefined
      ? ytBalance
      : marketCtx.activePortfolio?.ytBalance ?? 0n;
  const effectiveNetworkMismatch =
    walletNetworkMismatch !== undefined
      ? walletNetworkMismatch
      : wallet.walletNetworkMismatch;

  const currentBusyStep = busyStep !== undefined ? busyStep : internalBusyStep;

  // Step Completion Logic
  const isStep1Done =
    Boolean(effectiveAccountExists) && parseFloat(effectiveXlmBalance || "0") > 1;
  const isStep2Done = Boolean(effectiveUsdcTrustlineExists);
  const isStep3Done = parseFloat(effectiveUsdcBalance || "0") > 0;
  const isStep4Done = (effectiveSyBalance ?? 0n) > 0n;
  const isStep5Done =
    (effectivePtBalance ?? 0n) > 0n && (effectiveYtBalance ?? 0n) > 0n;

  // Body scroll lock & Escape listener
  useEffect(() => {
    if (!isOpen) return;
    if (typeof document === "undefined") return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Copy address helper
  const handleCopyAddress = useCallback(() => {
    if (!effectiveAddress) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(effectiveAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [effectiveAddress]);

  // Balance refresh helper
  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      if (marketCtx?.refreshActiveMarket) {
        await marketCtx.refreshActiveMarket();
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [marketCtx]);

  // Step 1: Fund XLM Gas via Friendbot
  const handleStep1 = useCallback(async () => {
    if (onFundXlm) {
      await onFundXlm();
      return;
    }
    if (!effectiveAddress) return;
    setInternalBusyStep("friendbot");
    const toastId = txToast.notifyTxPending(
      "Friendbot XLM",
      "Requesting 10,000 testnet XLM..."
    );
    try {
      await requestFriendbotFunding(effectiveAddress);
      txToast.notifyTxSuccess(
        toastId,
        "",
        "Friendbot XLM",
        "10,000 Testnet XLM credited to wallet."
      );
      if (marketCtx?.refreshActiveMarket) {
        await marketCtx.refreshActiveMarket();
      }
    } catch (err) {
      txToast.notifyTxError(toastId, err, undefined, "Friendbot XLM");
    } finally {
      setInternalBusyStep(null);
    }
  }, [onFundXlm, effectiveAddress, txToast, marketCtx]);

  // Step 2: Add USDC Trustline
  const handleStep2 = useCallback(async () => {
    if (onAddUsdcTrustline) {
      await onAddUsdcTrustline();
      return;
    }
    if (!effectiveAddress) return;
    setInternalBusyStep("trustline");
    const toastId = txToast.notifyTxPending(
      "USDC Trustline",
      "Signing USDC trustline on Horizon..."
    );
    try {
      const unsignedXdr = await prepareChangeTrustUsdcTx(effectiveAddress);
      const signedXdr = await wallet.signTransactionXdr(unsignedXdr);
      const res = await submitSignedHorizonTx(signedXdr);
      txToast.notifyTxSuccess(
        toastId,
        res.hash,
        "USDC Trustline",
        "USDC trustline established on Testnet."
      );
      if (marketCtx?.refreshActiveMarket) {
        await marketCtx.refreshActiveMarket();
      }
    } catch (err) {
      txToast.notifyTxError(toastId, err, (err as any)?.txHash, "USDC Trustline");
    } finally {
      setInternalBusyStep(null);
    }
  }, [onAddUsdcTrustline, effectiveAddress, txToast, wallet, marketCtx]);

  // Step 3: Swap XLM for USDC via SDEX
  const handleStep3SdexSwap = useCallback(async () => {
    if (onSwapXlmForUsdc) {
      await onSwapXlmForUsdc();
      return;
    }
    if (!effectiveAddress) return;
    setInternalBusyStep("sdex");
    const toastId = txToast.notifyTxPending(
      "Swap XLM for USDC",
      "Signing 100 XLM SDEX swap on Horizon..."
    );
    try {
      const unsignedXdr = await prepareSwapXlmForUsdcSdexTx(effectiveAddress, "100", "1");
      const signedXdr = await wallet.signTransactionXdr(unsignedXdr);
      const res = await submitSignedHorizonTx(signedXdr);
      txToast.notifyTxSuccess(
        toastId,
        res.hash,
        "Swap XLM for USDC",
        "Swapped 100 XLM for Circle Testnet USDC via SDEX."
      );
      if (marketCtx?.refreshActiveMarket) {
        await marketCtx.refreshActiveMarket();
      }
    } catch (err) {
      txToast.notifyTxError(toastId, err, (err as any)?.txHash, "Swap XLM for USDC");
    } finally {
      setInternalBusyStep(null);
    }
  }, [onSwapXlmForUsdc, effectiveAddress, txToast, wallet, marketCtx]);

  // Step 4: Wrap USDC to sy-bUSDC
  const handleStep4 = useCallback(async () => {
    const depositAmount = 10_0000000n; // 10 USDC
    if (onDepositSy) {
      await onDepositSy(depositAmount);
      return;
    }
    if (!effectiveAddress) return;
    setInternalBusyStep("deposit");
    const toastId = txToast.notifyTxPending(
      "Deposit USDC to SY",
      "Awaiting wallet signature..."
    );
    try {
      const actionArgs = buildActionArgs(
        {
          type: "deposit_sy",
          caller: effectiveAddress,
          amount: depositAmount,
        },
        marketCtx?.activeMarket
      );
      const prepared = await prepareContractCallTx({
        sourceAddress: effectiveAddress,
        contractId: actionArgs.contractId,
        method: actionArgs.method,
        args: actionArgs.args,
        label: actionArgs.label,
      });
      const signedXdr = await wallet.signTransactionXdr(prepared.unsignedXdr);
      const submitted = await submitSignedSorobanTx(signedXdr, (txHash) => {
        txToast.notifyTxConfirming(
          toastId,
          txHash,
          "Deposit USDC to SY",
          "Confirming transaction on Testnet..."
        );
      });
      txToast.notifyTxSuccess(
        toastId,
        submitted.hash,
        "Deposit USDC to SY",
        "Received sy-bUSDC shares on Testnet."
      );
      if (marketCtx?.refreshActiveMarket) {
        await marketCtx.refreshActiveMarket();
      }
    } catch (err) {
      txToast.notifyTxError(toastId, err, (err as any)?.txHash, "Deposit USDC to SY");
    } finally {
      setInternalBusyStep(null);
    }
  }, [onDepositSy, effectiveAddress, txToast, marketCtx, wallet]);

  // Step 5: Mint PT + YT from Yield Pool
  const handleStep5 = useCallback(async () => {
    const mintAmount = 5_0000000n; // 5 sy-bUSDC
    if (onMintPy) {
      await onMintPy(mintAmount);
      return;
    }
    if (!effectiveAddress) return;
    setInternalBusyStep("mint");
    const toastId = txToast.notifyTxPending(
      "Mint PT & YT",
      "Awaiting wallet signature..."
    );
    try {
      const actionArgs = buildActionArgs(
        {
          type: "mint_py",
          caller: effectiveAddress,
          amount: mintAmount,
        },
        marketCtx?.activeMarket
      );
      const prepared = await prepareContractCallTx({
        sourceAddress: effectiveAddress,
        contractId: actionArgs.contractId,
        method: actionArgs.method,
        args: actionArgs.args,
        label: actionArgs.label,
      });
      const signedXdr = await wallet.signTransactionXdr(prepared.unsignedXdr);
      const submitted = await submitSignedSorobanTx(signedXdr, (txHash) => {
        txToast.notifyTxConfirming(
          toastId,
          txHash,
          "Mint PT & YT",
          "Confirming transaction on Testnet..."
        );
      });
      txToast.notifyTxSuccess(
        toastId,
        submitted.hash,
        "Mint PT & YT",
        "Minted equal PT and YT tokens on Testnet."
      );
      if (marketCtx?.refreshActiveMarket) {
        await marketCtx.refreshActiveMarket();
      }
    } catch (err) {
      txToast.notifyTxError(toastId, err, (err as any)?.txHash, "Mint PT & YT");
    } finally {
      setInternalBusyStep(null);
    }
  }, [onMintPy, effectiveAddress, txToast, marketCtx, wallet]);

  if (!isOpen) {
    return null;
  }

  const circleFaucetUrl =
    STELLAR_PENDLE_CONFIG?.circleFaucetUrl || "https://faucet.circle.com";

  const modalContent = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="faucet-modal-title"
      aria-describedby="faucet-modal-desc"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-canvas/80 backdrop-blur-md animate-fade-in motion-reduce:animate-none"
      onClick={(e?: React.MouseEvent) => {
        if (!e || e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="glass-panel-elevated double-bezel max-w-2xl w-full rounded-2xl border border-glass-rim shadow-glass-elevated overflow-hidden flex flex-col max-h-screen"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header Strip */}
        <div className="flex items-center justify-between border-b border-glass-rim px-5 py-4 bg-surface-muted/40 shrink-0 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft/50 border border-accent/30 text-accent">
              <Droplets className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="faucet-modal-title"
                className="text-base font-bold text-ink"
              >
                Testnet Asset Faucet
              </h2>
              <p
                id="faucet-modal-desc"
                className="text-xs text-ink-muted mt-0.5"
              >
                Complete 5 steps to fund, wrap, and mint mock Stellar testnet assets.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleManualRefresh()}
              disabled={isRefreshing}
              className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-surface-hover border border-transparent hover:border-hairline transition cursor-pointer disabled:opacity-50 active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              title="Refresh balances"
              aria-label="Refresh balances"
            >
              <RefreshCw
                className={`h-4 w-4 ${isRefreshing ? "animate-spin text-accent" : ""}`}
              />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close faucet modal"
              className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-surface-hover border border-transparent hover:border-hairline transition cursor-pointer active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {/* Disconnected Wallet Prompt */}
          {!effectiveAddress && (
            <div className="rounded-xl border border-accent/40 bg-accent-soft/20 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent-soft border border-accent/30 text-accent">
                  <ShieldAlert className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-ink">
                    Connect Wallet
                  </h3>
                  <p className="text-xs text-ink-muted mt-0.5">
                    Connect your Stellar wallet to get testnet assets
                  </p>
                </div>
              </div>
              {wallet?.connectWallet && (
                <button
                  type="button"
                  onClick={() => void wallet.connectWallet()}
                  className="btn-accent px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
                >
                  Connect Wallet
                </button>
              )}
            </div>
          )}

          {/* Network Mismatch Banner */}
          {effectiveNetworkMismatch && (
            <div className="rounded-xl border border-warn/40 bg-warn-soft p-3.5 flex items-center justify-between gap-3 text-warn shadow-sm">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <div>
                  <span className="text-xs font-semibold">Network Mismatch</span>
                  <p className="text-xs text-ink-secondary mt-0.5">
                    Please switch your wallet to Stellar Testnet to use the faucet.
                  </p>
                </div>
              </div>
              {wallet?.switchNetwork && (
                <button
                  type="button"
                  onClick={() => void wallet.switchNetwork()}
                  className="px-2.5 py-1 rounded-lg border border-warn/50 bg-surface text-xs font-medium text-warn hover:bg-surface-hover transition cursor-pointer shrink-0"
                >
                  Switch Network
                </button>
              )}
            </div>
          )}

          {/* Live Asset Balances Strip */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-semibold text-ink-secondary px-1">
              <span>Live Testnet Balances</span>
              {effectiveAddress && (
                <span className="tabular-mono font-mono text-ink-secondary lowercase">
                  {shortenAddress(effectiveAddress, 4, 4)}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {/* XLM */}
              <div className="glass-card double-bezel-recessed rounded-xl p-2.5 bg-surface-muted/30 border border-glass-rim-subtle">
                <div className="text-xs text-ink-muted flex items-center justify-between">
                  <span>XLM</span>
                  <TokenIcon symbol="XLM" size="xs" />
                </div>
                <div className="tabular-mono font-mono text-xs font-semibold text-ink mt-1 truncate">
                  {formatBalance(effectiveXlmBalance, 7, 2)}
                </div>
              </div>

              {/* USDC */}
              <div className="glass-card double-bezel-recessed rounded-xl p-2.5 bg-surface-muted/30 border border-glass-rim-subtle">
                <div className="text-xs text-ink-muted flex items-center justify-between">
                  <span>USDC</span>
                  <TokenIcon symbol="USDC" size="xs" />
                </div>
                <div className="tabular-mono font-mono text-xs font-semibold text-ink mt-1 truncate">
                  {formatBalance(effectiveUsdcBalance, 7, 2)}
                </div>
              </div>

              {/* sy-bUSDC */}
              <div className="glass-card double-bezel-recessed rounded-xl p-2.5 bg-surface-muted/30 border border-glass-rim-subtle">
                <div className="text-xs text-ink-muted flex items-center justify-between">
                  <span>sy-bUSDC</span>
                  <TokenIcon symbol="BLEND" size="xs" />
                </div>
                <div className="tabular-mono font-mono text-xs font-semibold text-ink mt-1 truncate">
                  {formatBalance(effectiveSyBalance, 7, 2)}
                </div>
              </div>

              {/* PT-bUSDC */}
              <div className="glass-card double-bezel-recessed rounded-xl p-2.5 bg-surface-muted/30 border border-glass-rim-subtle">
                <div className="text-xs text-ink-muted flex items-center justify-between">
                  <span>PT-bUSDC</span>
                  <TokenIcon symbol="USDC" size="xs" />
                </div>
                <div className="tabular-mono font-mono text-xs font-semibold text-positive mt-1 truncate">
                  {formatBalance(effectivePtBalance, 7, 2)}
                </div>
              </div>

              {/* YT-bUSDC */}
              <div className="glass-card double-bezel-recessed rounded-xl p-2.5 bg-surface-muted/30 border border-glass-rim-subtle col-span-2 sm:col-span-1">
                <div className="text-xs text-ink-muted flex items-center justify-between">
                  <span>YT-bUSDC</span>
                  <TokenIcon symbol="USDC" size="xs" />
                </div>
                <div className="tabular-mono font-mono text-xs font-semibold text-accent mt-1 truncate">
                  {formatBalance(effectiveYtBalance, 7, 2)}
                </div>
              </div>
            </div>
          </div>

          {/* 5-Step Pipeline Steps */}
          <div className="space-y-3">
            {/* Step 1: Fund XLM Gas */}
            <div
              className={`rounded-2xl border p-4 transition ${
                isStep1Done
                  ? "border-hairline bg-surface-muted/20"
                  : "border-accent/40 bg-accent-soft/10 shadow-sm"
              }`}
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-xl shrink-0 mt-0.5 ${
                      isStep1Done
                        ? "bg-positive-soft text-positive border border-positive/30"
                        : "bg-surface-muted text-ink-secondary border border-hairline"
                    }`}
                  >
                    {isStep1Done ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <span className="tabular-mono font-mono text-xs font-bold">1</span>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-bold text-ink">Fund XLM Gas</h4>
                      {isStep1Done && (
                        <span className="text-xs font-semibold text-positive bg-positive-soft px-1.5 py-0.5 rounded-full">
                          Completed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5 max-w-md">
                      Request 10,000 Testnet XLM from Stellar Friendbot for ledger reserve and transaction fees.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleStep1()}
                  disabled={
                    !effectiveAddress ||
                    currentBusyStep !== null ||
                    effectiveNetworkMismatch
                  }
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                    isStep1Done
                      ? "border border-hairline bg-surface-muted text-ink-secondary hover:bg-surface-hover"
                      : "btn-accent"
                  }`}
                >
                  {currentBusyStep === "friendbot" ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Funding XLM...</span>
                    </>
                  ) : isStep1Done ? (
                    <>
                      <Droplets className="h-3.5 w-3.5 text-accent" />
                      <span>Fund 10,000 XLM</span>
                    </>
                  ) : (
                    <>
                      <Droplets className="h-3.5 w-3.5" />
                      <span>Fund 10,000 XLM</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Step 2: Add USDC Trustline */}
            <div
              className={`rounded-2xl border p-4 transition ${
                isStep2Done
                  ? "border-hairline bg-surface-muted/20"
                  : isStep1Done
                  ? "border-accent/40 bg-accent-soft/10 shadow-sm"
                  : "border-hairline/60 bg-surface-muted/10 opacity-75"
              }`}
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-xl shrink-0 mt-0.5 ${
                      isStep2Done
                        ? "bg-positive-soft text-positive border border-positive/30"
                        : "bg-surface-muted text-ink-secondary border border-hairline"
                    }`}
                  >
                    {isStep2Done ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <span className="tabular-mono font-mono text-xs font-bold">2</span>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-bold text-ink">Add USDC Trustline</h4>
                      {isStep2Done && (
                        <span className="text-xs font-semibold text-positive bg-positive-soft px-1.5 py-0.5 rounded-full">
                          Completed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5 max-w-md">
                      Sign a changeTrust operation to enable your wallet to hold and transfer Circle Testnet USDC.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleStep2()}
                  disabled={
                    !effectiveAddress ||
                    currentBusyStep !== null ||
                    effectiveNetworkMismatch ||
                    !isStep1Done
                  }
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                    isStep2Done
                      ? "border border-hairline bg-surface-muted text-ink-secondary hover:bg-surface-hover"
                      : "btn-accent"
                  }`}
                >
                  {currentBusyStep === "trustline" ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Adding Trustline...</span>
                    </>
                  ) : isStep2Done ? (
                    <>
                      <ShieldCheck className="h-3.5 w-3.5 text-positive" />
                      <span>Trustline Active</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>Add USDC Trustline</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Step 3: Get Testnet USDC */}
            <div
              className={`rounded-2xl border p-4 transition ${
                isStep3Done
                  ? "border-hairline bg-surface-muted/20"
                  : isStep2Done
                  ? "border-accent/40 bg-accent-soft/10 shadow-sm"
                  : "border-hairline/60 bg-surface-muted/10 opacity-75"
              }`}
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-xl shrink-0 mt-0.5 ${
                      isStep3Done
                        ? "bg-positive-soft text-positive border border-positive/30"
                        : "bg-surface-muted text-ink-secondary border border-hairline"
                    }`}
                  >
                    {isStep3Done ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <span className="tabular-mono font-mono text-xs font-bold">3</span>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-bold text-ink">Get Testnet USDC</h4>
                      {isStep3Done && (
                        <span className="text-xs font-semibold text-positive bg-positive-soft px-1.5 py-0.5 rounded-full">
                          Completed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5 max-w-md">
                      Swap 100 Testnet XLM instantly via Stellar SDEX or claim from the Circle web faucet.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleStep3SdexSwap()}
                    disabled={
                      !effectiveAddress ||
                      currentBusyStep !== null ||
                      Boolean(effectiveNetworkMismatch) ||
                      !isStep2Done
                    }
                    className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                      isStep3Done
                        ? "border border-hairline bg-surface-muted text-ink-secondary hover:bg-surface-hover"
                        : "btn-accent"
                    }`}
                  >
                    {currentBusyStep === "sdex" ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Swapping XLM...</span>
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>Swap 100 XLM</span>
                      </>
                    )}
                  </button>
                  {effectiveAddress && (
                    <button
                      type="button"
                      onClick={handleCopyAddress}
                      className="inline-flex items-center gap-1 rounded-xl border border-hairline bg-surface-muted px-2.5 py-2 text-xs font-medium text-ink hover:bg-surface-hover transition cursor-pointer active:scale-95"
                      title="Copy wallet address"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-positive" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5 text-ink-muted" />
                          <span>Copy Address</span>
                        </>
                      )}
                    </button>
                  )}
                  <a
                    href={circleFaucetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface-muted text-ink-secondary hover:bg-surface-hover px-2.5 py-2 text-xs font-medium transition shrink-0 cursor-pointer active:scale-95"
                  >
                    <span>Circle Faucet</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            </div>

            {/* Step 4: Wrap USDC to sy-bUSDC */}
            <div
              className={`rounded-2xl border p-4 transition ${
                isStep4Done
                  ? "border-hairline bg-surface-muted/20"
                  : isStep3Done
                  ? "border-accent/40 bg-accent-soft/10 shadow-sm"
                  : "border-hairline/60 bg-surface-muted/10 opacity-75"
              }`}
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-xl shrink-0 mt-0.5 ${
                      isStep4Done
                        ? "bg-positive-soft text-positive border border-positive/30"
                        : "bg-surface-muted text-ink-secondary border border-hairline"
                    }`}
                  >
                    {isStep4Done ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <span className="tabular-mono font-mono text-xs font-bold">4</span>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-bold text-ink">Wrap USDC to sy-bUSDC</h4>
                      {isStep4Done && (
                        <span className="text-xs font-semibold text-positive bg-positive-soft px-1.5 py-0.5 rounded-full">
                          Completed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5 max-w-md">
                      Deposit 10 USDC into Blend yield wrapper to obtain standardized yield-bearing token shares.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleStep4()}
                  disabled={
                    !effectiveAddress ||
                    currentBusyStep !== null ||
                    effectiveNetworkMismatch ||
                    !isStep2Done
                  }
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                    isStep4Done
                      ? "border border-hairline bg-surface-muted text-ink-secondary hover:bg-surface-hover"
                      : "btn-accent"
                  }`}
                >
                  {currentBusyStep === "deposit" ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Depositing...</span>
                    </>
                  ) : (
                    <>
                      <Layers className="h-3.5 w-3.5" />
                      <span>Deposit 10 USDC</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Step 5: Mint PT & YT Tokens */}
            <div
              className={`rounded-2xl border p-4 transition ${
                isStep5Done
                  ? "border-hairline bg-surface-muted/20"
                  : isStep4Done
                  ? "border-accent/40 bg-accent-soft/10 shadow-sm"
                  : "border-hairline/60 bg-surface-muted/10 opacity-75"
              }`}
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-xl shrink-0 mt-0.5 ${
                      isStep5Done
                        ? "bg-positive-soft text-positive border border-positive/30"
                        : "bg-surface-muted text-ink-secondary border border-hairline"
                    }`}
                  >
                    {isStep5Done ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <span className="tabular-mono font-mono text-xs font-bold">5</span>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-bold text-ink">Mint PT &amp; YT Tokens</h4>
                      {isStep5Done && (
                        <span className="text-xs font-semibold text-positive bg-positive-soft px-1.5 py-0.5 rounded-full">
                          Completed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5 max-w-md">
                      Split 5 sy-bUSDC shares in the Yield Pool into equal 5 PT and 5 YT yield-bearing assets.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleStep5()}
                  disabled={
                    !effectiveAddress ||
                    currentBusyStep !== null ||
                    effectiveNetworkMismatch ||
                    !isStep4Done
                  }
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                    isStep5Done
                      ? "border border-hairline bg-surface-muted text-ink-secondary hover:bg-surface-hover"
                      : "btn-accent"
                  }`}
                >
                  {currentBusyStep === "mint" ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Minting...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Mint PT &amp; YT</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-glass-rim px-5 py-3 bg-surface-muted/30 text-xs text-ink-muted shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-positive" />
            <span>Stellar Testnet Active</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-xl border border-hairline bg-surface hover:bg-surface-hover text-ink transition cursor-pointer font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );

  // Dual-mode SSR Portal: safe in SSR and in Browser DOM
  return typeof document !== "undefined" && document.body
    ? createPortal(modalContent, document.body)
    : modalContent;
}
