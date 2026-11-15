"use client";

import React, { useMemo, useState } from "react";
import { AlertTriangle, ArrowDownUp, ArrowRight, ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import {
  SwapDirection,
  formatUnits,
  formatUnitsExact,
  quoteSwapLocal,
  validateAmountInput,
  validateSlippage,
} from "@/lib/math";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  buildActionArgs,
  resolveScopedBusyAction,
} from "@/lib/stellar";

interface SwapCardProps {
  snapshot: LiveMarketSnapshot | null;
  portfolio: LiveUserPortfolio | null;
  busyAction: string | null;
  busyActions?: Record<string, string>;
  onExecuteAction: (params: {
    contractId: string;
    method: string;
    args: ReturnType<typeof buildActionArgs>["args"];
    label: string;
    simulateOnly?: boolean;
  }) => Promise<void>;
  onOpenDevDrawer?: () => void;
  onSwitchTab?: (tab: "swap" | "mint" | "liquidity" | "redeem" | "rollover") => void;
}

export function SwapCard({
  snapshot,
  portfolio,
  busyAction,
  busyActions,
  onExecuteAction,
  onSwitchTab,
}: SwapCardProps) {
  const { address, mode, connectWallet, walletNetworkMismatch, switchNetwork } = useWallet();
  const { activeMarket } = useMarket();

  const effectiveBusy = resolveScopedBusyAction(
    busyActions,
    busyAction,
    activeMarket.contracts.poolId,
    ["swap_sy_for_pt", "swap_pt_for_sy", "swap_sy_for_yt", "swap_yt_for_sy"]
  );

  const [swapDir, setSwapDir] = useState<SwapDirection>("sy_for_pt");
  const [inputVal, setInputVal] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [customSlippageStr, setCustomSlippageStr] = useState("0.50");
  const [isCustomSlippage, setIsCustomSlippage] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const hasInput = inputVal.trim().length > 0;

  const isGuest = mode !== "wallet" || !address;
  const simActor = address ?? STELLAR_PENDLE_CONFIG.deployer;

  const isPtMode = swapDir === "sy_for_pt" || swapDir === "pt_for_sy";
  const isYtMode = swapDir === "sy_for_yt" || swapDir === "yt_for_sy";

  const isMatured =
    (snapshot?.isMatured ?? false) ||
    (activeMarket ? Math.floor(Date.now() / 1000) >= activeMarket.maturity : false);
  const maturityDateStr = activeMarket?.maturityIso ? activeMarket.maturityIso.slice(0, 10) : "";

  // Determine pay token and receive token labels & balances
  const payToken = useMemo(() => {
    switch (swapDir) {
      case "pt_for_sy":
        return { symbol: "PT", name: activeMarket.ptSymbol, balance: portfolio?.ptBalance };
      case "yt_for_sy":
        return { symbol: "YT", name: activeMarket.ytSymbol, balance: portfolio?.ytBalance };
      case "sy_for_pt":
      case "sy_for_yt":
      default:
        return { symbol: "SY", name: activeMarket.sySymbol, balance: portfolio?.syBalance };
    }
  }, [swapDir, portfolio, activeMarket]);

  const receiveToken = useMemo(() => {
    switch (swapDir) {
      case "pt_for_sy":
      case "yt_for_sy":
        return { symbol: "SY", name: activeMarket.sySymbol, balance: portfolio?.syBalance };
      case "sy_for_yt":
        return { symbol: "YT", name: activeMarket.ytSymbol, balance: portfolio?.ytBalance };
      case "sy_for_pt":
      default:
        return { symbol: "PT", name: activeMarket.ptSymbol, balance: portfolio?.ptBalance };
    }
  }, [swapDir, portfolio, activeMarket]);

  // Amount & Slippage Validation
  const amountValidation = useMemo(
    () => validateAmountInput(inputVal, activeMarket.asset.decimals, payToken.balance),
    [inputVal, activeMarket.asset.decimals, payToken.balance]
  );

  const slippageValidation = useMemo(
    () => validateSlippage(slippageBps),
    [slippageBps]
  );

  // Quote preview calculation
  const swapQuotePreview = useMemo(() => {
    if (!snapshot) return { quote: null, error: null };
    if (!amountValidation.valid || !amountValidation.amount) {
      return { quote: null, error: amountValidation.error ?? "Enter a valid amount" };
    }
    if (!slippageValidation.valid) {
      return { quote: null, error: slippageValidation.error ?? "Invalid slippage" };
    }
    try {
      const q = quoteSwapLocal(
        snapshot.state,
        swapDir,
        amountValidation.amount,
        BigInt(Math.floor(Date.now() / 1000)),
        slippageBps
      );
      return { quote: q, error: null };
    } catch (err) {
      return {
        quote: null,
        error: err instanceof Error ? err.message : "Out of pool bounds",
      };
    }
  }, [snapshot, swapDir, amountValidation, slippageBps, slippageValidation]);

  const parsedAmount = amountValidation.amount;

  const flipDirection = () => {
    if (swapDir === "sy_for_pt") setSwapDir("pt_for_sy");
    else if (swapDir === "pt_for_sy") setSwapDir("sy_for_pt");
    else if (swapDir === "sy_for_yt") setSwapDir("yt_for_sy");
    else setSwapDir("sy_for_yt");
  };

  const handlePercentClick = (pct: number) => {
    if (!payToken.balance) return;
    if (pct === 100) {
      setInputVal(formatUnitsExact(payToken.balance));
      return;
    }
    const portion = (payToken.balance * BigInt(pct)) / 100n;
    setInputVal(formatUnitsExact(portion));
  };

  const handleMaxClick = () => {
    handlePercentClick(100);
  };

  const handlePresetSlippage = (bps: number) => {
    setIsCustomSlippage(false);
    setSlippageBps(bps);
    setCustomSlippageStr((bps / 100).toFixed(2));
  };

  const handleCustomSlippageChange = (valStr: string) => {
    setCustomSlippageStr(valStr);
    setIsCustomSlippage(true);
    const parsedFloat = parseFloat(valStr);
    if (!isNaN(parsedFloat)) {
      const calculatedBps = Math.round(parsedFloat * 100);
      setSlippageBps(calculatedBps);
    } else {
      setSlippageBps(NaN);
    }
  };

  const handleAction = async (simulateOnly = false) => {
    if (!parsedAmount || !swapQuotePreview.quote) return;
    const methodMap: Record<SwapDirection, string> = {
      pt_for_sy: "swap_exact_pt_for_sy",
      sy_for_pt: "swap_exact_sy_for_pt",
      sy_for_yt: "swap_exact_sy_for_yt",
      yt_for_sy: "swap_exact_yt_for_sy",
    };

    const caller = simulateOnly ? simActor : address;
    if (!caller) return;

    await onExecuteAction({
      ...buildActionArgs(
        {
          type: "swap",
          caller,
          method: methodMap[swapDir],
          amountIn: parsedAmount,
          minOut: swapQuotePreview.quote.minOutWithSlippage,
        },
        activeMarket
      ),
      simulateOnly,
    });
  };

  return (
    <div className="space-y-4">
      {/* Matured Market Guard Banner */}
      {isMatured && (
        <div className="rounded-xl border border-warn/30 bg-warn-soft p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warn mt-0.5" />
            <div>
              <div className="font-semibold text-warn">Market Matured</div>
              <div className="text-ink-secondary text-xs">
                This market reached maturity on <span className="tabular-mono font-medium">{maturityDateStr}</span>. AMM swaps are closed.
              </div>
            </div>
          </div>
          {onSwitchTab && (
            <button
              type="button"
              onClick={() => onSwitchTab("redeem")}
              className="inline-flex items-center gap-1 rounded-lg bg-warn px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition shrink-0 cursor-pointer"
            >
              <span>Redeem / Rollover</span>
              <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Compact PT / YT Mode Selector */}
      <div className="grid grid-cols-2 gap-2">
        {/* PT Mode Button */}
        <button
          type="button"
          onClick={() => setSwapDir("sy_for_pt")}
          className={`group flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-left transition-colors cursor-pointer border whitespace-nowrap ${
            isPtMode
              ? "border-positive bg-positive-soft shadow-sm"
              : "border-hairline bg-surface-muted/50 hover:bg-surface-hover/60"
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="rounded bg-positive/20 px-1.5 py-0.5 text-[11px] font-bold text-positive leading-none">
              PT
            </span>
            <span className="text-xs font-medium text-ink-secondary truncate">
              Fixed APY
            </span>
          </div>
          <span className="tabular-mono font-bold text-positive text-xs sm:text-sm">
            +{snapshot && snapshot.impliedFixedApyPct != null ? snapshot.impliedFixedApyPct.toFixed(2) : "8.45"}%
          </span>
        </button>

        {/* YT Mode Button */}
        <button
          type="button"
          onClick={() => setSwapDir("sy_for_yt")}
          className={`group flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-left transition-colors cursor-pointer border whitespace-nowrap ${
            isYtMode
              ? "border-accent bg-accent-soft shadow-sm"
              : "border-hairline bg-surface-muted/50 hover:bg-surface-hover/60"
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[11px] font-bold text-accent leading-none">
              YT
            </span>
            <span className="text-xs font-medium text-ink-secondary truncate">
              Long Yield
            </span>
          </div>
          <span className="tabular-mono font-bold text-accent text-xs sm:text-sm">
            {snapshot && snapshot.ytPriceInSy != null && snapshot.ytPriceInSy > 0
              ? `${Math.min(99, Math.round(1 / snapshot.ytPriceInSy))}x`
              : "50x"}
          </span>
        </button>
      </div>

      {/* Direction Segmented Control */}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-muted/60 p-1 border border-glass-rim sm:grid-cols-4 backdrop-blur-md">
        {[
          { id: "sy_for_pt" as const, label: "Lock Fixed", desc: "SY to PT" },
          { id: "pt_for_sy" as const, label: "Sell PT", desc: "PT to SY" },
          { id: "sy_for_yt" as const, label: "Long Yield", desc: "SY to YT" },
          { id: "yt_for_sy" as const, label: "Unwind YT", desc: "YT to SY" },
        ].map((item) => {
          const isActive = swapDir === item.id;
          const isPtAction = item.id === "sy_for_pt" || item.id === "pt_for_sy";
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSwapDir(item.id)}
              className={`min-w-0 rounded-lg border py-2 px-1 text-center font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                isActive
                  ? isPtAction
                    ? "bg-surface text-ink shadow-sm border-positive/40"
                    : "bg-surface text-ink shadow-sm border-accent/40"
                  : "border-transparent text-ink-secondary hover:text-ink hover:bg-surface-hover/50"
              }`}
            >
              <div className="text-xs leading-none whitespace-nowrap">{item.label}</div>
              <div
                className={`tabular-mono mt-1 text-xs font-medium leading-none whitespace-nowrap ${
                  isActive
                    ? isPtAction
                      ? "text-positive"
                      : "text-accent"
                    : "text-ink-muted"
                }`}
              >
                {item.desc}
              </div>
            </button>
          );
        })}
      </div>

      {/* Pay Box */}
      <div
        className={`glass-card double-bezel-recessed rounded-xl p-3.5 transition ${
          amountValidation.error
            ? "border-danger/60 focus-within:border-danger"
            : "border-glass-rim-subtle focus-within:border-accent/50"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
          <span className="font-medium text-ink-secondary">You Pay</span>
          {payToken.balance !== undefined && (
            <div className="flex items-center gap-1.5 text-ink-muted">
              <span>Bal:</span>
              <span className="tabular-mono font-medium text-ink">
                {formatUnits(payToken.balance)}
              </span>
              <div className="flex items-center gap-1 ml-1">
                {[
                  { label: "25%", pct: 25 },
                  { label: "50%", pct: 50 },
                  { label: "75%", pct: 75 },
                  { label: "MAX", pct: 100 },
                ].map((btn) => (
                  <button
                    key={btn.label}
                    type="button"
                    onClick={() => handlePercentClick(btn.pct)}
                    className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-bold tabular-mono text-accent transition hover:bg-accent hover:text-accent-ink cursor-pointer"
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <input
            type="text"
            inputMode="decimal"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            placeholder="0"
            className="tabular-mono w-full bg-transparent text-2xl font-bold text-ink outline-none placeholder:text-ink-muted/40"
          />
          <div className="flex shrink-0 items-center gap-2 rounded-xl bg-surface px-3 py-1.5 border border-hairline shadow-sm">
            <TokenIcon symbol={payToken.name} underlying={activeMarket.asset.code} size="sm" />
            <span className="font-bold text-xs text-ink">{payToken.symbol}</span>
            <span className="text-xs text-ink-muted hidden sm:inline">{payToken.name}</span>
          </div>
        </div>

        {hasInput && amountValidation.error && (
          <div className="mt-2 text-xs font-medium text-danger flex items-center gap-1.5">
            <span>•</span>
            <span>{amountValidation.error}</span>
          </div>
        )}
      </div>

      {/* Switch Direction Divider */}
      <div className="relative flex justify-center py-0.5">
        <button
          type="button"
          onClick={flipDirection}
          className="group flex h-8 w-8 items-center justify-center rounded-xl border border-glass-rim bg-surface/80 text-ink-secondary transition-colors hover:border-accent hover:text-accent hover:rotate-180 active:scale-95 motion-reduce:transform-none duration-200 shadow-glass cursor-pointer"
          title="Switch Swap Direction"
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Receive Box */}
      <div className="glass-card double-bezel-recessed rounded-xl p-3.5 border-glass-rim-subtle">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-ink-secondary">You Receive (Estimated)</span>
          {receiveToken.balance !== undefined && (
            <div className="flex items-center gap-1 text-ink-muted">
              <span>Bal:</span>
              <span className="tabular-mono font-medium text-ink">
                {formatUnits(receiveToken.balance)}
              </span>
            </div>
          )}
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <div className={`tabular-mono text-2xl font-bold ${swapQuotePreview.quote ? "text-ink" : "text-ink-muted/40"}`}>
            {swapQuotePreview.quote
              ? formatUnits(swapQuotePreview.quote.estimatedOut)
              : hasInput
              ? "--"
              : "0"}
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-xl bg-surface px-3 py-1.5 border border-hairline shadow-sm">
            <TokenIcon symbol={receiveToken.name} underlying={activeMarket.asset.code} size="sm" />
            <span className="font-bold text-xs text-ink">{receiveToken.symbol}</span>
            <span className="text-xs text-ink-muted hidden sm:inline">{receiveToken.name}</span>
          </div>
        </div>

        {/* Pendle V2 Trade Route & Yield Impact Strip */}
        {swapQuotePreview.quote && (
          <div className="mt-3 space-y-1.5 rounded-lg border border-glass-rim bg-surface-muted/50 p-2.5 text-xs backdrop-blur-sm">
            <div className="flex items-center justify-between text-ink-secondary">
              <span>Effective Rate</span>
              <span className="tabular-mono font-semibold text-accent">
                1 {payToken.symbol} ≈ {swapQuotePreview.quote.effectiveExchangeRate.toFixed(4)} {receiveToken.symbol}
              </span>
            </div>
            <div className="flex items-center justify-between text-ink-secondary">
              <span>Implied APY After</span>
              <span className="tabular-mono font-bold text-positive">
                +{swapQuotePreview.quote.impliedApyAfterPct.toFixed(2)}%
              </span>
            </div>
            <div className="flex items-center justify-between text-ink-secondary">
              <span>Min. Received</span>
              <span className="tabular-mono font-medium text-ink">
                {formatUnits(swapQuotePreview.quote.minOutWithSlippage)} {receiveToken.symbol}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Quote Error Warning */}
      {hasInput && swapQuotePreview.error && (
        <div className="rounded-lg border border-warn/30 bg-warn-soft p-2.5 text-xs text-warn">
          {swapQuotePreview.error}
        </div>
      )}

      {/* Accordion Details */}
      <div className="rounded-xl border border-glass-rim bg-surface-muted/30 backdrop-blur-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          className="flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-medium text-ink-secondary hover:text-ink transition-colors cursor-pointer whitespace-nowrap"
        >
          <div className="flex items-center gap-1.5">
            <SlidersHorizontal className="h-3 w-3 text-accent" />
            <span>Transaction Details</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="tabular-mono text-xs text-ink-muted">
              Slippage: {(slippageBps / 100).toFixed(1)}%
            </span>
            {showDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </div>
        </button>

        {showDetails && (
          <div className="space-y-3 border-t border-hairline px-3.5 py-3 text-xs">
            {/* Slippage Selector */}
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
                <span className="text-ink-secondary">Slippage Tolerance</span>
                <div className="flex items-center gap-1 flex-wrap sm:flex-nowrap">
                  {[25, 50, 100].map((bps) => (
                    <button
                      key={bps}
                      type="button"
                      onClick={() => handlePresetSlippage(bps)}
                      className={`rounded-lg px-2 py-0.5 tabular-mono text-xs transition cursor-pointer ${
                        !isCustomSlippage && slippageBps === bps
                          ? "bg-accent text-accent-ink font-bold"
                          : "bg-surface border border-hairline text-ink-secondary hover:text-ink"
                      }`}
                    >
                      {(bps / 100).toFixed(2)}%
                    </button>
                  ))}
                  <div className="relative flex items-center ml-1">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={customSlippageStr}
                      onChange={(e) => handleCustomSlippageChange(e.target.value)}
                      placeholder="Custom"
                      className={`tabular-mono w-14 rounded-lg bg-surface px-1.5 py-0.5 text-center text-xs border transition outline-none ${
                        isCustomSlippage
                          ? slippageValidation.valid
                            ? "border-accent text-accent font-bold"
                            : "border-danger text-danger font-bold"
                          : "border-hairline text-ink-muted"
                      }`}
                    />
                    <span className="text-xs text-ink-muted ml-0.5">%</span>
                  </div>
                </div>
              </div>
              {slippageValidation.error && (
                <div className="mt-1 text-right text-xs font-medium text-danger">
                  {slippageValidation.error}
                </div>
              )}
              {slippageValidation.warning && (
                <div className="mt-1 text-right text-xs font-medium text-warn flex items-center justify-end gap-1">
                  <AlertTriangle className="h-3 w-3 text-warn inline shrink-0" />
                  <span>{slippageValidation.warning}</span>
                </div>
              )}
            </div>

            {/* Min Output */}
            <div className="flex items-center justify-between">
              <span className="text-ink-secondary">Minimum Received</span>
              <span className="tabular-mono font-medium text-ink">
                {swapQuotePreview.quote
                  ? `${formatUnits(swapQuotePreview.quote.minOutWithSlippage)} ${receiveToken.symbol}`
                  : "--"}
              </span>
            </div>

            {/* Protocol Fee */}
            <div className="flex items-center justify-between">
              <span className="text-ink-secondary">Fee</span>
              <span className="tabular-mono font-medium text-ink">
                {swapQuotePreview.quote ? `${formatUnits(swapQuotePreview.quote.feeAmount)} ${receiveToken.symbol}` : "--"}
              </span>
            </div>

            {/* Implied APY after swap */}
            {swapQuotePreview.quote && (
              <div className="flex items-center justify-between border-t border-hairline pt-2">
                <span className="text-ink-secondary">Implied Fixed APY</span>
                <span className="tabular-mono font-bold text-accent">
                  +{swapQuotePreview.quote.impliedApyAfterPct.toFixed(2)}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Execution CTAs */}
      <div className="space-y-2 pt-1">
        {walletNetworkMismatch ? (
          <button
            type="button"
            onClick={() => void switchNetwork()}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold border border-warn bg-warn-soft text-warn hover:bg-warn hover:text-white transition-colors cursor-pointer whitespace-nowrap"
          >
            <span>Switch to Stellar Testnet</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : isGuest ? (
          <button
            type="button"
            onClick={connectWallet}
            className="btn-accent flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <span>Connect Wallet to Swap</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            disabled={
              effectiveBusy !== null ||
              isMatured ||
              !amountValidation.valid ||
              !slippageValidation.valid ||
              !swapQuotePreview.quote
            }
            onClick={() => void handleAction(false)}
            className={`flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap ${
              isPtMode
                ? "bg-positive text-canvas hover:opacity-90"
                : "btn-accent"
            }`}
          >
            <span>
              {effectiveBusy
                ? effectiveBusy
                : isMatured
                ? "Market Matured - Swaps Closed"
                : amountValidation.error === "Insufficient balance"
                ? "Insufficient Balance"
                : "Execute Swap"}
            </span>
            {!effectiveBusy && <ArrowRight className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
