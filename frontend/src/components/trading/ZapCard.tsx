"use client";

import React, { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, ShieldCheck, SlidersHorizontal, Zap } from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import {
  SCALAR_9,
  assetToSy,
  estimateZapInLp,
  formatUnits,
  formatUnitsExact,
  parseUnitsSafe,
  quoteSwapLocal,
  validateAmountInput,
  validateSlippage,
} from "@/lib/math";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  buildActionArgs,
  prepareChangeTrustUsdcTx,
  resolveScopedBusyAction,
  submitSignedHorizonTx,
} from "@/lib/stellar";
import type { DeskTab } from "./TradingDesk";

type ZapTarget = "pt" | "yt" | "lp";

interface ZapCardProps {
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
  onAddTrustline?: () => Promise<void> | void;
  onSwitchTab?: (tab: DeskTab) => void;
}

export function ZapCard({
  snapshot,
  portfolio,
  busyAction,
  busyActions,
  onExecuteAction,
  onAddTrustline,
  onSwitchTab,
}: ZapCardProps) {
  const { address, mode, connectWallet, walletNetworkMismatch, switchNetwork, signTransactionXdr } = useWallet();
  const { activeMarket } = useMarket();

  const [zapTarget, setZapTarget] = useState<ZapTarget>("pt");
  const [inputVal, setInputVal] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [customSlippageStr, setCustomSlippageStr] = useState("0.50");
  const [isCustomSlippage, setIsCustomSlippage] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [isAddingTrustline, setIsAddingTrustline] = useState(false);

  const factoryId =
    process.env.NEXT_PUBLIC_MARKET_FACTORY_CONTRACT_ID ||
    STELLAR_PENDLE_CONFIG.market_factory.contractId;

  const targetMethod =
    zapTarget === "pt"
      ? "zap_in_pt"
      : zapTarget === "yt"
      ? "zap_in_yt"
      : "zap_in_lp";

  const effectiveBusy = resolveScopedBusyAction(
    busyActions,
    busyAction,
    factoryId,
    ["zap_in_pt", "zap_in_yt", "zap_in_lp"]
  );

  const isGuest = mode !== "wallet" || !address;
  const simActor = address ?? STELLAR_PENDLE_CONFIG.deployer;
  const hasInput = inputVal.trim().length > 0;

  const isMatured =
    (snapshot?.isMatured ?? false) ||
    (activeMarket ? Math.floor(Date.now() / 1000) >= activeMarket.maturity : false);

  const payBalance = portfolio
    ? activeMarket.asset.code === "XLM"
      ? portfolio.xlmBalance
      : portfolio.usdcBalance
    : null;

  const needsTrustline =
    !isGuest &&
    activeMarket.asset.code !== "XLM" &&
    Boolean(portfolio && portfolio.usdcTrustlineExists === false);

  const amountValidation = useMemo(
    () => validateAmountInput(inputVal, activeMarket.asset.decimals, payBalance),
    [inputVal, activeMarket.asset.decimals, payBalance]
  );

  const slippageValidation = useMemo(
    () => validateSlippage(slippageBps),
    [slippageBps]
  );

  const parsedAmount = amountValidation.amount;

  const zapPreview = useMemo(() => {
    if (!snapshot || !amountValidation.valid || !parsedAmount) {
      return {
        estOut: null as bigint | null,
        minOut: null as bigint | null,
        impliedApyAfterPct: null as number | null,
        error: null as string | null,
        isOversizedLp: false,
      };
    }
    if (!slippageValidation.valid) {
      return {
        estOut: null,
        minOut: null,
        impliedApyAfterPct: null,
        error: slippageValidation.error ?? "Invalid slippage",
        isOversizedLp: false,
      };
    }

    const nowBig = BigInt(Math.floor(Date.now() / 1000));
    const pyIndex =
      snapshot.pyIndex && snapshot.pyIndex > 0n
        ? snapshot.pyIndex
        : snapshot.blendExchangeRate > SCALAR_9
        ? snapshot.blendExchangeRate
        : SCALAR_9;

    const syEstimated = assetToSy(pyIndex, parsedAmount);
    if (syEstimated <= 0n) {
      return {
        estOut: null,
        minOut: null,
        impliedApyAfterPct: null,
        error: "Amount too small after SY conversion",
        isOversizedLp: false,
      };
    }

    if (zapTarget === "lp") {
      const lpEst = estimateZapInLp(
        snapshot.state,
        syEstimated,
        nowBig,
        slippageBps,
        pyIndex
      );
      if (!lpEst.ok) {
        return {
          estOut: null,
          minOut: null,
          impliedApyAfterPct: null,
          error: lpEst.reason ?? "LP zap out of pool bounds",
          isOversizedLp: Boolean(lpEst.isOversizedError),
        };
      }
      return {
        estOut: lpEst.estLpOut,
        minOut: lpEst.minLpOut,
        impliedApyAfterPct: snapshot.impliedFixedApyPct,
        error: null,
        isOversizedLp: false,
      };
    }

    try {
      const dir = zapTarget === "pt" ? "sy_for_pt" : "sy_for_yt";
      const q = quoteSwapLocal(
        snapshot.state,
        dir,
        syEstimated,
        nowBig,
        slippageBps,
        pyIndex
      );
      return {
        estOut: q.estimatedOut,
        minOut: q.minOutWithSlippage,
        impliedApyAfterPct: q.impliedApyAfterPct,
        error: null,
        isOversizedLp: false,
      };
    } catch (err) {
      return {
        estOut: null,
        minOut: null,
        impliedApyAfterPct: null,
        error: err instanceof Error ? err.message : "Out of pool bounds",
        isOversizedLp: false,
      };
    }
  }, [snapshot, amountValidation.valid, parsedAmount, slippageValidation, zapTarget, slippageBps]);

  const handlePercentClick = (pct: number) => {
    if (!payBalance) return;
    const raw = parseUnitsSafe(payBalance, activeMarket.asset.decimals);
    if (!raw || raw <= 0n) return;
    if (pct === 100) {
      setInputVal(formatUnitsExact(raw, activeMarket.asset.decimals));
      return;
    }
    setInputVal(formatUnitsExact((raw * BigInt(pct)) / 100n, activeMarket.asset.decimals));
  };

  const handleEstablishTrustline = async () => {
    if (onAddTrustline) {
      await onAddTrustline();
      return;
    }
    if (!address || !signTransactionXdr) return;
    setIsAddingTrustline(true);
    try {
      const unsignedXdr = await prepareChangeTrustUsdcTx(address);
      const signedXdr = await signTransactionXdr(unsignedXdr);
      await submitSignedHorizonTx(signedXdr);
    } catch (err) {
      console.error("Failed to establish trustline:", err);
    } finally {
      setIsAddingTrustline(false);
    }
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
      setSlippageBps(Math.round(parsedFloat * 100));
    } else {
      setSlippageBps(NaN);
    }
  };

  const handleAction = async (simulateOnly = false) => {
    if (!parsedAmount || !zapPreview.minOut || zapPreview.error) return;
    const caller = simulateOnly ? simActor : address;
    if (!caller) return;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    await onExecuteAction({
      ...buildActionArgs(
        {
          type: targetMethod,
          caller,
          receiver: caller,
          pool: activeMarket.contracts.poolId,
          underlyingAmount: parsedAmount,
          minOut: zapPreview.minOut,
          deadline,
        },
        activeMarket
      ),
      simulateOnly,
    });
  };

  const receiveSymbol =
    zapTarget === "pt"
      ? activeMarket.ptSymbol
      : zapTarget === "yt"
      ? activeMarket.ytSymbol
      : activeMarket.lpSymbol;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-ink-secondary px-0.5">
        <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
          <Zap className="h-3.5 w-3.5 text-accent" />
          <span>Single-Tx Zap-In</span>
        </span>
        <span className="tabular-mono text-ink-muted">
          {activeMarket.asset.code} to {zapTarget.toUpperCase()}
        </span>
      </div>

      {/* Zap Output Mode Selector */}
      <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-surface-muted/60 p-1 border border-glass-rim backdrop-blur-md">
        {[
          { id: "pt" as const, label: "Zap to PT", desc: "Fixed Yield" },
          { id: "yt" as const, label: "Zap to YT", desc: "Long Yield" },
          { id: "lp" as const, label: "Zap to LP", desc: "Pool Shares" },
        ].map((item) => {
          const isActive = zapTarget === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setZapTarget(item.id)}
              className={`min-w-0 rounded-lg border py-2 px-1 text-center font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                isActive
                  ? "bg-surface text-ink shadow-sm border-accent/40"
                  : "border-transparent text-ink-secondary hover:text-ink hover:bg-surface-hover/50"
              }`}
            >
              <div className="text-xs leading-none whitespace-nowrap">{item.label}</div>
              <div className="mt-1 text-[11px] font-medium text-accent leading-none whitespace-nowrap">
                {item.desc}
              </div>
            </button>
          );
        })}
      </div>

      {isMatured && (
        <div className="rounded-xl border border-warn/30 bg-warn-soft p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warn mt-0.5" />
            <div>
              <div className="font-semibold text-warn">Market Matured</div>
              <div className="text-ink-secondary text-xs">
                Zap-In is disabled after market maturity.
              </div>
            </div>
          </div>
          {onSwitchTab && (
            <button
              type="button"
              onClick={() => onSwitchTab("redeem")}
              className="inline-flex items-center gap-1 rounded-lg bg-warn px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition shrink-0 cursor-pointer"
            >
              <span>Redeem</span>
              <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Underlying Input Box */}
      <div
        className={`glass-card double-bezel-recessed rounded-xl p-3.5 transition ${
          hasInput && amountValidation.error
            ? "border-danger/60 focus-within:border-danger"
            : "border-glass-rim-subtle focus-within:border-accent/50"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
          <span className="font-medium text-ink-secondary">
            Pay Underlying ({activeMarket.asset.code})
          </span>
          {payBalance !== null && (
            <div className="flex items-center gap-1.5 text-ink-muted">
              <span>Bal:</span>
              <span className="tabular-mono font-medium text-ink">{payBalance}</span>
              <div className="flex items-center gap-1 ml-1">
                {[25, 50, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => handlePercentClick(pct)}
                    className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-bold tabular-mono text-accent transition hover:bg-accent hover:text-accent-ink cursor-pointer"
                  >
                    {pct === 100 ? "MAX" : `${pct}%`}
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
            <TokenIcon symbol={activeMarket.asset.code} underlying={activeMarket.asset.code} size="sm" />
            <span className="font-bold text-xs text-ink">{activeMarket.asset.code}</span>
          </div>
        </div>

        {hasInput && amountValidation.error && (
          <div className="mt-2 text-xs font-medium text-danger flex items-center gap-1.5">
            <span>{amountValidation.error}</span>
          </div>
        )}
      </div>

      {/* Estimated Output Box */}
      <div className="glass-card double-bezel-recessed rounded-xl p-3.5 border-glass-rim-subtle">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-ink-secondary">Estimated Output</span>
          <span className="tabular-mono text-ink-muted">{activeMarket.sySymbol} Route</span>
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <div className={`tabular-mono text-2xl font-bold ${zapPreview.estOut ? "text-ink" : "text-ink-muted/40"}`}>
            {zapPreview.estOut
              ? formatUnits(zapPreview.estOut, activeMarket.asset.decimals)
              : hasInput
              ? "--"
              : "0"}
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-xl bg-surface px-3 py-1.5 border border-hairline shadow-sm">
            <TokenIcon symbol={receiveSymbol} underlying={activeMarket.asset.code} size="sm" />
            <span className="tabular-mono font-bold text-xs text-ink">{receiveSymbol}</span>
          </div>
        </div>

        {zapPreview.minOut && (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-glass-rim bg-surface-muted/50 px-2.5 py-2 text-xs text-ink-secondary">
            <span>Min. Received</span>
            <span className="tabular-mono font-medium text-ink">
              {formatUnits(zapPreview.minOut, activeMarket.asset.decimals)} {receiveSymbol}
            </span>
          </div>
        )}
      </div>

      {hasInput && zapPreview.error && (
        <div className="rounded-lg border border-warn/30 bg-warn-soft p-2.5 text-xs text-warn flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{zapPreview.error}</span>
        </div>
      )}

      {needsTrustline && (
        <div className="rounded-xl border border-warn/30 bg-warn-soft p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warn mt-0.5" />
            <div>
              <div className="font-semibold text-warn">Trustline Required</div>
              <div className="text-ink-secondary text-xs">
                Add a {activeMarket.asset.code} trustline before zapping into this market.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleEstablishTrustline()}
            disabled={effectiveBusy !== null || isAddingTrustline}
            className="inline-flex items-center gap-1 rounded-lg bg-warn px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition shrink-0 cursor-pointer disabled:opacity-50"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>{isAddingTrustline ? "Establishing..." : `Add ${activeMarket.asset.code} Trustline`}</span>
          </button>
        </div>
      )}

      {/* Slippage Accordion */}
      <div className="rounded-xl border border-glass-rim bg-surface-muted/30 backdrop-blur-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setShowDetails((prev) => !prev)}
          className="flex w-full items-center justify-between px-3.5 py-2 text-xs font-medium text-ink-secondary hover:text-ink transition-colors cursor-pointer whitespace-nowrap"
        >
          <span className="inline-flex items-center gap-1.5">
            <SlidersHorizontal className="h-3 w-3 text-accent" />
            <span>Slippage Tolerance</span>
          </span>
          <span className="tabular-mono text-xs text-ink-muted">
            {(slippageBps / 100).toFixed(2)}%
          </span>
        </button>

        {showDetails && (
          <div className="border-t border-hairline px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-1.5 text-xs">
            <div className="flex items-center gap-1">
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
              <input
                type="text"
                inputMode="decimal"
                value={customSlippageStr}
                onChange={(e) => handleCustomSlippageChange(e.target.value)}
                placeholder="Custom"
                className="tabular-mono w-14 rounded-lg bg-surface px-1.5 py-0.5 text-center text-xs border border-hairline text-ink-muted outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {/* Submit CTA */}
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
            <span>Connect Wallet to Zap</span>
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
              !zapPreview.minOut ||
              Boolean(zapPreview.error)
            }
            onClick={() => void handleAction(false)}
            className="btn-accent flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <span>
              {effectiveBusy
                ? effectiveBusy
                : isMatured
                ? "Market Matured - Zap Closed"
                : zapPreview.isOversizedLp
                ? "LP Zap Exceeds Pool Depth"
                : amountValidation.error === "Insufficient balance"
                ? "Insufficient Balance"
                : `Execute Zap to ${zapTarget.toUpperCase()}`}
            </span>
            {!effectiveBusy && <ArrowRight className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
