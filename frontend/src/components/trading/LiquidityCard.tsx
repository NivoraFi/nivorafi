"use client";

import React, { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Layers, SlidersHorizontal } from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import {
  applySlippage,
  formatUnits,
  formatUnitsExact,
  validateAmountInput,
  validateSlippage,
} from "@/lib/math";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  buildActionArgs,
  resolveScopedBusyAction,
} from "@/lib/stellar";

type LiquidityMode = "add" | "remove";

interface LiquidityCardProps {
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

export function LiquidityCard({
  snapshot,
  portfolio,
  busyAction,
  busyActions,
  onExecuteAction,
  onOpenDevDrawer,
  onSwitchTab,
}: LiquidityCardProps) {
  const { address, mode, connectWallet, walletNetworkMismatch, switchNetwork } = useWallet();
  const { activeMarket } = useMarket();
  const [liqMode, setLiqMode] = useState<LiquidityMode>("add");

  const effectiveBusy = resolveScopedBusyAction(
    busyActions,
    busyAction,
    activeMarket.contracts.poolId,
    liqMode === "add" ? ["add_liquidity"] : ["remove_liquidity"]
  );
  const [liqPtInput, setLiqPtInput] = useState("1.0");
  const [liqSyInput, setLiqSyInput] = useState("0.34");
  const [lpBurnInput, setLpBurnInput] = useState("0.5");
  const [slippageBps, setSlippageBps] = useState(50);
  const [customSlippageStr, setCustomSlippageStr] = useState("0.50");
  const [isCustomSlippage, setIsCustomSlippage] = useState(false);
  const [showSlippage, setShowSlippage] = useState(false);

  const isGuest = mode !== "wallet" || !address;
  const simActor = address ?? STELLAR_PENDLE_CONFIG.deployer;

  const isMatured =
    (snapshot?.isMatured ?? false) ||
    (activeMarket ? Math.floor(Date.now() / 1000) >= activeMarket.maturity : false);

  const ptValidation = useMemo(
    () => validateAmountInput(liqPtInput, activeMarket.asset.decimals, portfolio?.ptBalance),
    [liqPtInput, activeMarket.asset.decimals, portfolio?.ptBalance]
  );
  const syValidation = useMemo(
    () => validateAmountInput(liqSyInput, activeMarket.asset.decimals, portfolio?.syBalance),
    [liqSyInput, activeMarket.asset.decimals, portfolio?.syBalance]
  );
  const lpValidation = useMemo(
    () => validateAmountInput(lpBurnInput, activeMarket.asset.decimals, portfolio?.lpBalance),
    [lpBurnInput, activeMarket.asset.decimals, portfolio?.lpBalance]
  );

  const ptAddAmt = ptValidation.amount;
  const syAddAmt = syValidation.amount;
  const lpRemoveAmt = lpValidation.amount;

  const slippageValidation = useMemo(() => validateSlippage(slippageBps), [slippageBps]);

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

  const liquidityEstimate = useMemo(() => {
    if (!snapshot || snapshot.state.total_lp_supply === 0n) {
      return { estLp: null, estPtOut: null, estSyOut: null };
    }
    const { total_pt_reserve, total_sy_reserve, total_lp_supply } = snapshot.state;
    const estLp =
      ptAddAmt && syAddAmt && total_pt_reserve > 0n && total_sy_reserve > 0n
        ? [
            (ptAddAmt * total_lp_supply) / total_pt_reserve,
            (syAddAmt * total_lp_supply) / total_sy_reserve,
          ].reduce((a, b) => (a < b ? a : b))
        : null;

    const estPtOut = lpRemoveAmt ? (lpRemoveAmt * total_pt_reserve) / total_lp_supply : null;
    const estSyOut = lpRemoveAmt ? (lpRemoveAmt * total_sy_reserve) / total_lp_supply : null;

    return { estLp, estPtOut, estSyOut };
  }, [snapshot, ptAddAmt, syAddAmt, lpRemoveAmt]);

  const handleAction = async (simulateOnly = false) => {
    const caller = simulateOnly ? simActor : address;
    if (!caller) return;

    if (liqMode === "add") {
      if (!ptValidation.valid || !syValidation.valid || !ptAddAmt || !syAddAmt || !slippageValidation.valid) {
        return;
      }
      const minLp = liquidityEstimate.estLp
        ? applySlippage(liquidityEstimate.estLp, slippageBps)
        : 1n;
      await onExecuteAction({
        ...buildActionArgs(
          {
            type: "add_liquidity",
            caller,
            ptAmount: ptAddAmt,
            syAmount: syAddAmt,
            minLpOut: minLp,
          },
          activeMarket
        ),
        simulateOnly,
      });
    } else {
      if (!lpValidation.valid || !lpRemoveAmt || !slippageValidation.valid) {
        return;
      }
      const minPt = liquidityEstimate.estPtOut
        ? applySlippage(liquidityEstimate.estPtOut, slippageBps)
        : 1n;
      const minSy = liquidityEstimate.estSyOut
        ? applySlippage(liquidityEstimate.estSyOut, slippageBps)
        : 1n;

      await onExecuteAction({
        ...buildActionArgs(
          {
            type: "remove_liquidity",
            caller,
            lpAmount: lpRemoveAmt,
            minPt,
            minSy,
          },
          activeMarket
        ),
        simulateOnly,
      });
    }
  };

  return (
    <div className="space-y-4">
      {/* Mode Switcher */}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-muted/60 p-1 border border-glass-rim backdrop-blur-md">
        <button
          type="button"
          onClick={() => setLiqMode("add")}
          className={`rounded-lg border py-2 text-center text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
            liqMode === "add"
              ? "bg-surface/90 text-ink shadow-glass border-glass-rim"
              : "border-transparent text-ink-secondary hover:text-ink hover:bg-surface-hover/50"
          }`}
        >
          Supply Liquidity
        </button>
        <button
          type="button"
          onClick={() => setLiqMode("remove")}
          className={`rounded-lg border py-2 text-center text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
            liqMode === "remove"
              ? "bg-surface/90 text-ink shadow-glass border-glass-rim"
              : "border-transparent text-ink-secondary hover:text-ink hover:bg-surface-hover/50"
          }`}
        >
          Withdraw LP
        </button>
      </div>

      {liqMode === "add" ? (
        <div className="space-y-3">
          {/* Matured Market Liquidity Supply Guard */}
          {isMatured && (
            <div className="rounded-xl border border-warn/30 bg-warn-soft p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warn mt-0.5" />
                <div>
                  <div className="font-semibold text-warn">Market Matured</div>
                  <div className="text-ink-secondary text-xs">
                    Supplying liquidity is disabled after maturity; please redeem or rollover your position.
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

          {/* PT Deposit Input */}
          <div
            className={`glass-card double-bezel-recessed rounded-xl p-3.5 transition ${
              ptValidation.error
                ? "border-danger/60 focus-within:border-danger"
                : "border-glass-rim-subtle focus-within:border-accent/50"
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-ink-secondary">Supply {activeMarket.ptSymbol}</span>
              {portfolio && (
                <div className="flex items-center gap-1.5 text-ink-muted">
                  <span>Bal:</span>
                  <span className="tabular-mono font-medium text-ink">
                    {formatUnits(portfolio.ptBalance)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLiqPtInput(formatUnitsExact(portfolio.ptBalance))}
                    className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-bold text-accent transition hover:bg-accent hover:text-accent-ink"
                  >
                    MAX
                  </button>
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <input
                type="text"
                inputMode="decimal"
                value={liqPtInput}
                onChange={(e) => setLiqPtInput(e.target.value)}
                placeholder="1.0"
                className="tabular-mono w-full bg-transparent text-xl font-bold text-ink outline-none"
              />
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-surface/80 px-2.5 py-1 text-xs font-bold text-ink border border-glass-rim shadow-glass">
                <TokenIcon symbol={activeMarket.ptSymbol} underlying={activeMarket.asset.code} size="xs" />
                <span>PT</span>
              </span>
            </div>
            {ptValidation.error && (
              <div className="mt-1.5 text-xs font-medium text-danger flex items-center gap-1.5">
                <span>•</span>
                <span>{ptValidation.error}</span>
              </div>
            )}
          </div>

          {/* SY Deposit Input */}
          <div
            className={`glass-card double-bezel-recessed rounded-xl p-3.5 transition ${
              syValidation.error
                ? "border-danger/60 focus-within:border-danger"
                : "border-glass-rim-subtle focus-within:border-accent/50"
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-ink-secondary">Supply {activeMarket.sySymbol}</span>
              {portfolio && (
                <div className="flex items-center gap-1.5 text-ink-muted">
                  <span>Bal:</span>
                  <span className="tabular-mono font-medium text-ink">
                    {formatUnits(portfolio.syBalance)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLiqSyInput(formatUnitsExact(portfolio.syBalance))}
                    className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-bold text-accent transition hover:bg-accent hover:text-accent-ink"
                  >
                    MAX
                  </button>
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <input
                type="text"
                inputMode="decimal"
                value={liqSyInput}
                onChange={(e) => setLiqSyInput(e.target.value)}
                placeholder="0.34"
                className="tabular-mono w-full bg-transparent text-xl font-bold text-ink outline-none"
              />
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-surface/80 px-2.5 py-1 text-xs font-bold text-ink border border-glass-rim shadow-glass">
                <TokenIcon symbol={activeMarket.sySymbol} underlying={activeMarket.asset.code} size="xs" />
                <span>SY</span>
              </span>
            </div>
            {syValidation.error && (
              <div className="mt-1.5 text-xs font-medium text-danger flex items-center gap-1.5">
                <span>•</span>
                <span>{syValidation.error}</span>
              </div>
            )}
          </div>

          {/* Estimate Out */}
          <div className="rounded-xl border border-glass-rim bg-surface-muted/40 p-3 text-xs flex items-center justify-between backdrop-blur-sm">
            <span className="text-ink-secondary">Estimated LP Shares Minted</span>
            <span className="tabular-mono font-bold text-accent">
              {liquidityEstimate.estLp ? `${formatUnits(liquidityEstimate.estLp)} LP` : "--"}
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Burn LP Input */}
          <div
            className={`glass-card double-bezel-recessed rounded-xl p-3.5 transition ${
              lpValidation.error
                ? "border-danger/60 focus-within:border-danger"
                : "border-glass-rim-subtle focus-within:border-accent/50"
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-ink-secondary">Burn LP Shares</span>
              {portfolio && (
                <div className="flex items-center gap-1.5 text-ink-muted">
                  <span>Bal:</span>
                  <span className="tabular-mono font-medium text-ink">
                    {formatUnits(portfolio.lpBalance)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLpBurnInput(formatUnitsExact(portfolio.lpBalance))}
                    className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-bold text-accent transition hover:bg-accent hover:text-accent-ink"
                  >
                    MAX
                  </button>
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <input
                type="text"
                inputMode="decimal"
                value={lpBurnInput}
                onChange={(e) => setLpBurnInput(e.target.value)}
                placeholder="0.5"
                className="tabular-mono w-full bg-transparent text-xl font-bold text-ink outline-none"
              />
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-surface/80 px-2.5 py-1 text-xs font-bold text-ink border border-glass-rim shadow-glass">
                <TokenIcon symbol={activeMarket.asset.code} size="xs" />
                <span>LP</span>
              </span>
            </div>
            {lpValidation.error && (
              <div className="mt-1.5 text-xs font-medium text-danger flex items-center gap-1.5">
                <span>•</span>
                <span>{lpValidation.error}</span>
              </div>
            )}
          </div>

          {/* Estimate Out */}
          <div className="rounded-xl border border-glass-rim bg-surface-muted/40 p-3 text-xs space-y-1.5 backdrop-blur-sm">
            <div className="flex items-center justify-between text-ink-secondary">
              <span>Estimated PT Return</span>
              <span className="tabular-mono font-semibold text-ink">
                {liquidityEstimate.estPtOut ? `${formatUnits(liquidityEstimate.estPtOut)} PT` : "--"}
              </span>
            </div>
            <div className="flex items-center justify-between text-ink-secondary">
              <span>Estimated SY Return</span>
              <span className="tabular-mono font-semibold text-ink">
                {liquidityEstimate.estSyOut ? `${formatUnits(liquidityEstimate.estSyOut)} SY` : "--"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Slippage Settings Accordion */}
      <div className="rounded-xl border border-hairline bg-surface-muted/20 overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setShowSlippage((prev) => !prev)}
          className="flex w-full items-center justify-between px-3.5 py-2 text-ink-secondary hover:text-ink transition"
        >
          <div className="flex items-center gap-1.5">
            <SlidersHorizontal className="h-3.5 w-3.5 text-accent" />
            <span>Slippage Tolerance</span>
          </div>
          <span className="tabular-mono font-semibold text-accent">
            {(slippageBps / 100).toFixed(2)}%
          </span>
        </button>

        {showSlippage && (
          <div className="border-t border-hairline px-3.5 py-2.5 space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
              <span className="text-ink-muted">Tolerance:</span>
              <div className="flex items-center gap-1 flex-wrap sm:flex-nowrap">
                {[25, 50, 100].map((bps) => (
                  <button
                    key={bps}
                    type="button"
                    onClick={() => handlePresetSlippage(bps)}
                    className={`rounded-lg px-2 py-0.5 font-mono text-xs transition ${
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
                    className={`tabular-mono w-14 rounded-lg bg-surface px-1.5 py-0.5 text-center text-xs font-mono border transition outline-none ${
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
              <div className="text-right text-xs font-medium text-danger">
                {slippageValidation.error}
              </div>
            )}
            {slippageValidation.warning && (
              <div className="text-right text-xs font-medium text-warn flex items-center justify-end gap-1">
                <AlertTriangle className="h-3 w-3 text-warn inline shrink-0" />
                <span>{slippageValidation.warning}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="space-y-2 pt-1">
        {walletNetworkMismatch ? (
          <button
            type="button"
            onClick={() => void switchNetwork()}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold border border-warn bg-warn-soft text-warn hover:bg-warn hover:text-white transition-colors cursor-pointer whitespace-nowrap active:scale-[0.99]"
          >
            <span>Switch to Stellar Testnet</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : isGuest ? (
          <button
            type="button"
            onClick={connectWallet}
            className="btn-accent flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold whitespace-nowrap active:scale-[0.99] cursor-pointer"
          >
            <span>Connect Wallet to Manage LP</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            disabled={
              effectiveBusy !== null ||
              !slippageValidation.valid ||
              (liqMode === "add"
                ? isMatured || !ptValidation.valid || !syValidation.valid || !ptAddAmt || !syAddAmt
                : !lpValidation.valid || !lpRemoveAmt)
            }
            onClick={() => void handleAction(false)}
            className="btn-accent flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold disabled:opacity-50 whitespace-nowrap active:scale-[0.99] cursor-pointer"
          >
            <Layers className="h-4 w-4" />
            <span>
              {effectiveBusy
                ? effectiveBusy
                : liqMode === "add"
                ? isMatured
                  ? "Market Matured - Supply Disabled"
                  : !ptValidation.valid && ptValidation.error === "Insufficient balance"
                  ? "Insufficient PT Balance"
                  : !syValidation.valid && syValidation.error === "Insufficient balance"
                  ? "Insufficient SY Balance"
                  : "Supply Dual Liquidity"
                : !lpValidation.valid && lpValidation.error === "Insufficient balance"
                ? "Insufficient LP Balance"
                : "Burn & Withdraw LP"}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
