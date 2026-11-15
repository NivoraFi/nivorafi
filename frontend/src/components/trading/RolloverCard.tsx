"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Layers,
  Lock,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import {
  formatUnits,
  formatUnitsExact,
} from "@/lib/math";
import { useRolloverQuote } from "@/hooks/useRolloverQuote";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  buildActionArgs,
  resolveScopedBusyAction,
} from "@/lib/stellar";
import { MarketDefinition, deriveMarketStatus, calculateDaysToMaturity } from "@/lib/markets";
import { TokenIcon } from "@/components/ui/TokenIcon";

export type RolloverStrategy = "roll_to_pt" | "roll_to_py";

export interface RolloverCardProps {
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
  className?: string;
}

export function RolloverCard({
  snapshot,
  portfolio,
  busyAction,
  busyActions,
  onExecuteAction,
  onOpenDevDrawer,
  className = "",
}: RolloverCardProps) {
  const { address, mode, connectWallet, walletNetworkMismatch, switchNetwork } = useWallet();
  const { activeMarket, markets, marketMetrics, selectMarket } = useMarket();

  const factoryContractId =
    process.env.NEXT_PUBLIC_MARKET_FACTORY_CONTRACT_ID ||
    STELLAR_PENDLE_CONFIG.market_factory.contractId;
  const effectiveBusy = resolveScopedBusyAction(
    busyActions,
    busyAction,
    factoryContractId,
    ["rollover_to_pt", "rollover_to_py"]
  );

  const isGuest = mode !== "wallet" || !address;
  const simActor = address ?? STELLAR_PENDLE_CONFIG.deployer;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Strategy Mode State
  const [strategy, setStrategy] = useState<RolloverStrategy>("roll_to_pt");

  // Source Market Selection (defaults to active market if matured, or first matured market)
  const maturedMarkets = useMemo(() => {
    return markets.filter((m) => deriveMarketStatus(m.maturity, nowSeconds) === "MATURED");
  }, [markets, nowSeconds]);

  const [selectedSourceId, setSelectedSourceId] = useState<string>(() => {
    if (deriveMarketStatus(activeMarket.maturity, nowSeconds) === "MATURED") {
      return activeMarket.id;
    }
    return maturedMarkets[0]?.id ?? activeMarket.id;
  });

  const sourceMarket = useMemo(() => {
    return markets.find((m) => m.id === selectedSourceId) ?? activeMarket;
  }, [markets, selectedSourceId, activeMarket]);

  const isSourceMatured = useMemo(() => {
    return (
      (sourceMarket.id === activeMarket.id && snapshot?.isMatured) ||
      deriveMarketStatus(sourceMarket.maturity, nowSeconds) === "MATURED"
    );
  }, [sourceMarket, activeMarket, snapshot, nowSeconds]);

  // Source available balance (PT is the matured asset)
  const sourcePtBalance = useMemo(() => {
    if (portfolio?.ptBalance !== undefined) {
      return portfolio.ptBalance;
    }
    return 0n;
  }, [portfolio]);

  // Target Markets: Same underlying asset, currently ACTIVE, distinct pool ID
  const compatibleTargetMarkets = useMemo(() => {
    return markets.filter((m) => {
      if (m.id === sourceMarket.id) return false;
      if (m.contracts.poolId === sourceMarket.contracts.poolId) return false;
      if (m.asset.code !== sourceMarket.asset.code) return false;
      return deriveMarketStatus(m.maturity, nowSeconds) === "ACTIVE";
    });
  }, [markets, sourceMarket, nowSeconds]);

  const [selectedTargetId, setSelectedTargetId] = useState<string>(() => {
    return compatibleTargetMarkets[0]?.id ?? "";
  });

  const targetMarket = useMemo(() => {
    const found = compatibleTargetMarkets.find((m) => m.id === selectedTargetId);
    return found ?? compatibleTargetMarkets[0] ?? null;
  }, [compatibleTargetMarkets, selectedTargetId]);

  // Amount & Slippage State
  const [rolloverInput, setRolloverInput] = useState<string>("1.0");
  const [slippageBps, setSlippageBps] = useState<number>(50); // 0.5% default

  // Delegated Atomic Rollover Quote Hook
  const quote = useRolloverQuote({
    ptAmount: rolloverInput,
    mode: strategy,
    slippageBps,
    sourceMarket,
    targetMarket,
    sourcePtBalance,
  });

  const isInputError =
    quote.quoteStatus === "INVALID_INPUT" ||
    quote.quoteStatus === "INSUFFICIENT_BALANCE";
  const inputErrorText = isInputError ? quote.error : null;

  // Percentage Quick Buttons Handler
  const handleQuickPercent = (percent: number) => {
    if (!sourcePtBalance || sourcePtBalance <= 0n) {
      setRolloverInput("0");
      return;
    }
    if (percent === 100) {
      setRolloverInput(formatUnitsExact(sourcePtBalance, 7));
    } else {
      const fraction = (sourcePtBalance * BigInt(percent)) / 100n;
      setRolloverInput(formatUnitsExact(fraction, 7));
    }
  };

  // Maturity Extension Calculation
  const maturityExtensionDays = useMemo(() => {
    if (!targetMarket) return 0;
    return Math.round(calculateDaysToMaturity(targetMarket.maturity, nowSeconds));
  }, [targetMarket, nowSeconds]);

  // Execution Handlers
  const handleExecuteRollover = async (simulateOnly = false) => {
    if (!quote.isValid || !targetMarket || quote.parsedAmount <= 0n) return;
    const caller = simulateOnly ? simActor : address;
    if (!caller) return;

    const action = quote.buildAction(caller, caller);
    await onExecuteAction({
      ...buildActionArgs(action, sourceMarket),
      simulateOnly,
    });
  };

  return (
    <div className={`glass-panel double-bezel rounded-2xl p-4 sm:p-5 space-y-4 shadow-glass-elevated ${className}`}>
      {/* Header Banner */}
      <div className="flex items-center justify-between border-b border-glass-rim pb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-accent-soft p-1.5 text-accent">
            <RefreshCw className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-xs sm:text-sm font-semibold tracking-tight text-ink">
              Atomic Rollover Desk
            </h3>
            <p className="text-xs text-ink-secondary">
              Roll matured principal tokens into active maturities in one transaction.
            </p>
          </div>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-accent-soft border border-accent/30 px-2.5 py-0.5 text-xs font-semibold text-accent">
          Atomic Router
        </span>
      </div>

      {/* Rollover Mode / Strategy Switcher */}
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-ink-secondary">
          Rollover Destination Strategy
        </label>
        <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-surface-muted/70 p-1 border border-glass-rim text-xs font-semibold backdrop-blur-md">
          <button
            type="button"
            onClick={() => setStrategy("roll_to_pt")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 transition cursor-pointer ${
              strategy === "roll_to_pt"
                ? "bg-accent text-accent-ink shadow-sm"
                : "text-ink-secondary hover:text-ink hover:bg-surface-hover"
            }`}
          >
            <TrendingUp className="h-3.5 w-3.5" />
            <span>Rollover to PT</span>
          </button>

          <button
            type="button"
            onClick={() => setStrategy("roll_to_py")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-2 transition cursor-pointer ${
              strategy === "roll_to_py"
                ? "bg-accent text-accent-ink shadow-sm"
                : "text-ink-secondary hover:text-ink hover:bg-surface-hover"
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            <span>Rollover to LP</span>
          </button>
        </div>
        <div className="text-xs text-ink-muted px-1">
          {strategy === "roll_to_pt"
            ? "Swap interim settlement shares into target PT at prevailing market discount."
            : "Mint equal parts target PT and YT for complete liquidity provision."}
        </div>
      </div>

      {/* Source Market Selector */}
      <div className="glass-card double-bezel-recessed rounded-xl p-3 space-y-2 border-glass-rim-subtle">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-ink-secondary">Source Matured Market</span>
          <span className="inline-flex items-center gap-1.5 tabular-mono text-ink-muted">
            <TokenIcon symbol={sourceMarket.asset.code} size="xs" />
            <span>Asset: {sourceMarket.asset.code}</span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {markets
            .filter((m) => m.asset.code === activeMarket.asset.code)
            .map((m) => {
              const isSelected = sourceMarket.id === m.id;
              const isMatured = deriveMarketStatus(m.maturity, nowSeconds) === "MATURED";
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setSelectedSourceId(m.id);
                    if (m.id !== activeMarket.id) {
                      selectMarket(m.id);
                    }
                  }}
                  className={`flex flex-col text-left rounded-lg p-2.5 border transition cursor-pointer text-xs ${
                    isSelected
                      ? "border-accent bg-accent-soft/20 text-ink shadow-sm"
                      : "border-hairline bg-surface-muted/60 text-ink-secondary hover:border-accent/40"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span className="inline-flex items-center gap-1.5 truncate">
                      <TokenIcon symbol={m.asset.code} size="xs" />
                      <span className="truncate">{m.name}</span>
                    </span>
                    <span
                      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-mono font-semibold ${
                        isMatured
                          ? "bg-warn-soft text-warn border border-warn/30"
                          : "bg-positive-soft text-positive border border-positive/30"
                      }`}
                    >
                      {isMatured ? "Matured" : "Active"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1 text-ink-muted tabular-mono">
                    <span>{m.tenor} Pool</span>
                    <span>Maturity: {(m.maturityIso || "").slice(0, 10)}</span>
                  </div>
                </button>
              );
            })}
        </div>

        {!isSourceMatured && (
          <div className="rounded-lg bg-warn-soft border border-warn/30 p-2.5 text-xs text-warn flex items-center gap-2">
            <Lock className="h-4 w-4 shrink-0" />
            <span>Selected source market is not matured yet. Rollover requires an expired market.</span>
          </div>
        )}
      </div>

      {/* Target Market Selector */}
      <div className="glass-card double-bezel-recessed rounded-xl p-3 space-y-2 border-glass-rim-subtle">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-ink-secondary">Target Active Market</span>
          <span className="tabular-mono text-positive font-semibold">
            Status: ACTIVE
          </span>
        </div>

        {compatibleTargetMarkets.length === 0 ? (
          <div className="rounded-lg bg-surface-muted/60 p-3 text-xs text-ink-muted border border-glass-rim">
            No active target markets available for asset {sourceMarket.asset.code}.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {compatibleTargetMarkets.map((m) => {
              const isTargetSelected = targetMarket?.id === m.id;
              const metrics = marketMetrics[m.id];
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedTargetId(m.id)}
                  className={`flex flex-col text-left rounded-lg p-2.5 border transition cursor-pointer text-xs ${
                    isTargetSelected
                      ? "border-accent bg-accent-soft/20 text-ink shadow-sm"
                      : "border-glass-rim-subtle bg-surface-muted/60 text-ink-secondary hover:border-accent/40"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>{m.name}</span>
                    <span className="tabular-mono text-accent font-bold">
                      {metrics ? `${metrics.impliedApyPct.toFixed(2)}% APY` : "--"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1 text-ink-muted tabular-mono">
                    <span>{m.tenor} Tenor</span>
                    <span>Matures: {(m.maturityIso || "").slice(0, 10)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Amount Input with Quick Percentage Buttons */}
      <div className="glass-card double-bezel-recessed rounded-xl p-3 space-y-2 border-glass-rim-subtle">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-ink-secondary">Rollover Amount</span>
          <span className="tabular-mono text-ink-muted">
            Available: {formatUnits(sourcePtBalance)} {sourceMarket.ptSymbol}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={rolloverInput}
            onChange={(e) => setRolloverInput(e.target.value)}
            placeholder="0.0"
            className={`tabular-mono w-full bg-surface rounded-lg px-3 py-2 text-sm font-bold text-ink outline-none border transition ${
              inputErrorText
                ? "border-danger text-danger focus:border-danger"
                : "border-hairline focus:border-accent"
            }`}
          />
          <div className="flex items-center gap-1 shrink-0">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => handleQuickPercent(pct)}
                className="tabular-mono rounded-md bg-surface-muted px-2 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink hover:bg-surface-hover border border-hairline transition cursor-pointer"
              >
                {pct === 100 ? "MAX" : `${pct}%`}
              </button>
            ))}
          </div>
        </div>

        {inputErrorText && (
          <div className="text-xs font-medium text-danger flex items-center gap-1.5">
            <span>•</span>
            <span>{inputErrorText}</span>
          </div>
        )}
      </div>

      {/* Slippage Tolerance Selector */}
      <div className="flex items-center justify-between px-1 text-xs">
        <span className="text-ink-secondary font-medium">Slippage Tolerance</span>
        <div className="flex items-center gap-1">
          {[
            { label: "0.1%", bps: 10 },
            { label: "0.5%", bps: 50 },
            { label: "1.0%", bps: 100 },
          ].map((item) => {
            const isSelected = slippageBps === item.bps;
            return (
              <button
                key={item.bps}
                type="button"
                onClick={() => setSlippageBps(item.bps)}
                className={`tabular-mono rounded-md px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
                  isSelected
                    ? "bg-accent text-accent-ink shadow-sm"
                    : "bg-surface text-ink-secondary hover:text-ink border border-hairline"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Live Execution Quote Box */}
      {quote.parsedAmount > 0n && targetMarket && (
        <div className="glass-card double-bezel-recessed rounded-xl p-3.5 space-y-2.5 text-xs border-glass-rim-subtle">
          <div className="flex items-center justify-between text-ink-secondary">
            <span>Matured PT Burned</span>
            <span className="tabular-mono font-medium text-ink">
              {formatUnits(quote.sourcePtBurned)} {sourceMarket.ptSymbol}
            </span>
          </div>

          <div className="flex items-center justify-between text-ink-secondary">
            <span className="flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-positive" />
              <span>Interim 1:1 Settlement</span>
            </span>
            <span className="tabular-mono font-medium text-positive">
              +{formatUnits(quote.interimSySettled)} {sourceMarket.sySymbol}
            </span>
          </div>

          <div className="flex items-center justify-between text-ink-secondary">
            <span>Expected Received</span>
            <span className="tabular-mono font-bold text-accent">
              {quote.loading ? (
                <span className="animate-pulse motion-reduce:animate-none text-ink-muted">Quoting AMM…</span>
              ) : strategy === "roll_to_pt" ? (
                `${formatUnits(quote.expectedTargetAmount)} ${targetMarket.ptSymbol}`
              ) : (
                `${formatUnits(quote.expectedTargetAmount)} PT + ${formatUnits(quote.estimatedTargetYt)} YT`
              )}
            </span>
          </div>

          <div className="flex items-center justify-between text-ink-secondary">
            <span>Exchange Rate</span>
            <span className="tabular-mono text-ink">
              1 {sourceMarket.ptSymbol} ≈ {quote.exchangeRate.toFixed(4)} {targetMarket.ptSymbol}
            </span>
          </div>

          <div className="flex items-center justify-between text-ink-secondary">
            <span>Maturity Extension</span>
            <span className="tabular-mono text-positive font-semibold flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-positive" />
              <span>+{maturityExtensionDays} Days</span>
            </span>
          </div>

          <div className="flex items-center justify-between text-ink-secondary pt-2 border-t border-hairline">
            <span>Minimum Received</span>
            <span className="tabular-mono font-semibold text-ink">
              {formatUnits(quote.minReceived)} ({(slippageBps / 100).toFixed(1)}% slippage)
            </span>
          </div>

          {quote.warnings && quote.warnings.length > 0 && (
            <div className="pt-2 border-t border-hairline space-y-1">
              {quote.warnings.map((w, idx) => (
                <div key={idx} className="flex items-center gap-1.5 text-warn text-xs">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Primary Action Button State Machine */}
      <div className="pt-1 space-y-2">
        {walletNetworkMismatch ? (
          <button
            type="button"
            onClick={() => void switchNetwork()}
            className="w-full rounded-lg px-4 py-2.5 text-xs font-semibold border border-warn bg-warn-soft text-warn hover:bg-warn hover:text-white transition-colors cursor-pointer flex items-center justify-center gap-2 whitespace-nowrap active:scale-[0.99]"
          >
            <AlertTriangle className="h-4 w-4" />
            <span>Switch to Testnet</span>
          </button>
        ) : isGuest ? (
          <button
            type="button"
            onClick={connectWallet}
            className="btn-accent w-full rounded-lg px-4 py-2.5 text-xs font-semibold cursor-pointer whitespace-nowrap active:scale-[0.99]"
          >
            Connect Wallet
          </button>
        ) : !isSourceMatured ? (
          <button
            type="button"
            disabled
            className="btn-accent w-full rounded-lg px-4 py-2.5 text-xs font-semibold opacity-50 cursor-not-allowed flex items-center justify-center gap-2 whitespace-nowrap"
          >
            <Lock className="h-4 w-4" />
            <span>Source Pool Not Yet Matured</span>
          </button>
        ) : compatibleTargetMarkets.length === 0 ? (
          <button
            type="button"
            disabled
            className="btn-accent w-full rounded-lg px-4 py-2.5 text-xs font-semibold opacity-50 cursor-not-allowed whitespace-nowrap"
          >
            No Active Target Markets
          </button>
        ) : (
          <button
            type="button"
            disabled={
              effectiveBusy !== null ||
              !quote.isValid ||
              !quote.parsedAmount ||
              !targetMarket ||
              quote.loading
            }
            onClick={() => void handleExecuteRollover(false)}
            className="btn-accent w-full rounded-lg px-4 py-2.5 text-xs font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap active:scale-[0.99]"
          >
            {effectiveBusy
              ? effectiveBusy
              : quote.loading
              ? "Fetching AMM Quote..."
              : quote.quoteStatus === "INSUFFICIENT_BALANCE"
              ? "Insufficient Matured PT Balance"
              : quote.quoteStatus === "SOURCE_NOT_MATURED"
              ? "Source Pool Not Yet Matured"
              : quote.quoteStatus === "TARGET_ALREADY_MATURED"
              ? "Target Pool Already Matured"
              : quote.quoteStatus === "CROSS_ASSET_DISALLOWED"
              ? "Cross-Asset Rollover Disallowed"
              : quote.quoteStatus === "IDENTICAL_POOLS"
              ? "Select Distinct Target Pool"
              : !quote.isValid && quote.error
              ? quote.error
              : strategy === "roll_to_pt"
              ? "Execute Atomic Rollover to PT"
              : "Execute Atomic Rollover to LP"}
          </button>
        )}

        {/* Institutional Dev Simulation Link */}
        {!isGuest && isSourceMatured && compatibleTargetMarkets.length > 0 && (
          <div className="flex items-center justify-end">
            <button
              type="button"
              disabled={
                effectiveBusy !== null ||
                !quote.parsedAmount ||
                !quote.isValid ||
                quote.loading
              }
              onClick={() => void handleExecuteRollover(true)}
              className="text-xs font-mono text-ink-muted hover:text-accent transition disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              [&gt;_ Simulate Rollover]
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
