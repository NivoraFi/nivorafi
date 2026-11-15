"use client";

import React, { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, ShieldCheck } from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import { formatUnits, formatUnitsExact, parseUnitsSafe, validateAmountInput } from "@/lib/math";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  buildActionArgs,
  prepareChangeTrustUsdcTx,
  resolveScopedBusyAction,
  submitSignedHorizonTx,
} from "@/lib/stellar";

type MintMode = "deposit_sy" | "mint_py" | "redeem_py" | "redeem_sy";

interface MintCardProps {
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
  onAddTrustline?: () => Promise<void> | void;
}

export function MintCard({
  snapshot,
  portfolio,
  busyAction,
  busyActions,
  onExecuteAction,
  onOpenDevDrawer,
  onAddTrustline,
}: MintCardProps) {
  const { address, mode, connectWallet, walletNetworkMismatch, switchNetwork, signTransactionXdr } = useWallet();
  const { activeMarket } = useMarket();
  const [mintMode, setMintMode] = useState<MintMode>("deposit_sy");
  const [inputVal, setInputVal] = useState("1.0");
  const [isAddingTrustline, setIsAddingTrustline] = useState(false);

  const { targetContractId, targetMethods } = useMemo(() => {
    switch (mintMode) {
      case "deposit_sy":
        return {
          targetContractId: activeMarket.contracts.syId,
          targetMethods: ["deposit"] as const,
        };
      case "mint_py":
        return {
          targetContractId: activeMarket.contracts.poolId,
          targetMethods: ["mint_py"] as const,
        };
      case "redeem_sy":
        return {
          targetContractId: activeMarket.contracts.syId,
          targetMethods: ["redeem"] as const,
        };
      case "redeem_py":
        return {
          targetContractId: activeMarket.contracts.poolId,
          targetMethods: ["redeem_py"] as const,
        };
    }
  }, [mintMode, activeMarket]);

  const effectiveBusy = resolveScopedBusyAction(
    busyActions,
    busyAction,
    targetContractId,
    targetMethods
  );

  const isGuest = mode !== "wallet" || !address;
  const simActor = address ?? STELLAR_PENDLE_CONFIG.deployer;

  const isMatured =
    (snapshot?.isMatured ?? false) ||
    (activeMarket ? Math.floor(Date.now() / 1000) >= activeMarket.maturity : false);

  const needsTrustline =
    !isGuest &&
    activeMarket.asset.code !== "XLM" &&
    Boolean(portfolio && portfolio.usdcTrustlineExists === false) &&
    (mintMode === "deposit_sy" || mintMode === "redeem_sy");

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

  const availableBalance = useMemo(() => {
    if (!portfolio) return null;
    switch (mintMode) {
      case "deposit_sy":
        return portfolio.usdcBalance;
      case "mint_py":
      case "redeem_sy":
        return portfolio.syBalance;
      case "redeem_py":
        return portfolio.ptBalance < portfolio.ytBalance
          ? portfolio.ptBalance
          : portfolio.ytBalance;
    }
  }, [mintMode, portfolio]);

  const currentConfig = useMemo(() => {
    const assetCode = activeMarket.asset.code;
    const sySymbol = activeMarket.sySymbol;
    const ptSymbol = activeMarket.ptSymbol;
    const ytSymbol = activeMarket.ytSymbol;

    switch (mintMode) {
      case "deposit_sy":
        return {
          assetLabel: assetCode,
          balanceStr: portfolio ? `${portfolio.usdcBalance} ${assetCode}` : "--",
          desc: `Deposits Testnet ${assetCode} into Blend Vault wrapper and mints rebasing ${sySymbol} shares.`,
          btnLabel: `Wrap ${assetCode} into SY`,
        };
      case "mint_py":
        return {
          assetLabel: sySymbol,
          balanceStr: portfolio ? `${formatUnits(portfolio.syBalance)} SY` : "--",
          desc: `Locks ${sySymbol} in YieldPool and mints equal 1:1 Principal (${ptSymbol}) and Yield Tokens (${ytSymbol}).`,
          btnLabel: "Split SY into PT + YT",
        };
      case "redeem_py":
        return {
          assetLabel: "PT + YT",
          balanceStr: portfolio && availableBalance !== null ? `${formatUnits(availableBalance)} Pairs` : "--",
          desc: `Burns equal ${ptSymbol} and ${ytSymbol} before maturity to unlock underlying ${sySymbol} immediately.`,
          btnLabel: "Merge PT + YT into SY",
        };
      case "redeem_sy":
        return {
          assetLabel: sySymbol,
          balanceStr: portfolio ? `${formatUnits(portfolio.syBalance)} SY` : "--",
          desc: `Burns ${sySymbol} shares and withdraws underlying ${assetCode} at live Blend bRate index.`,
          btnLabel: `Unwrap SY into ${assetCode}`,
        };
    }
  }, [mintMode, portfolio, availableBalance, activeMarket]);

  const amountValidation = useMemo(
    () => validateAmountInput(inputVal, activeMarket.asset.decimals, availableBalance),
    [inputVal, activeMarket.asset.decimals, availableBalance]
  );

  const parsedAmount = amountValidation.amount;

  const handleMaxClick = () => {
    if (!portfolio) return;
    if (mintMode === "deposit_sy") {
      const parsed = parseUnitsSafe(portfolio.usdcBalance, activeMarket.asset.decimals);
      setInputVal(parsed ? formatUnitsExact(parsed) : portfolio.usdcBalance);
    } else if (mintMode === "mint_py" || mintMode === "redeem_sy") {
      setInputVal(formatUnitsExact(portfolio.syBalance));
    } else {
      // redeem_py needs the minimum of PT and YT
      const minPair =
        portfolio.ptBalance < portfolio.ytBalance
          ? portfolio.ptBalance
          : portfolio.ytBalance;
      setInputVal(formatUnitsExact(minPair));
    }
  };

  const handleAction = async (simulateOnly = false) => {
    if (!parsedAmount) return;
    const caller = simulateOnly ? simActor : address;
    if (!caller) return;

    if (mintMode === "deposit_sy") {
      await onExecuteAction({
        ...buildActionArgs({ type: "deposit_sy", caller, amount: parsedAmount }, activeMarket),
        simulateOnly,
      });
    } else if (mintMode === "redeem_sy") {
      await onExecuteAction({
        ...buildActionArgs({ type: "redeem_sy", caller, shares: parsedAmount }, activeMarket),
        simulateOnly,
      });
    } else if (mintMode === "mint_py") {
      await onExecuteAction({
        ...buildActionArgs({ type: "mint_py", caller, amount: parsedAmount }, activeMarket),
        simulateOnly,
      });
    } else {
      await onExecuteAction({
        ...buildActionArgs({ type: "redeem_py", caller, amount: parsedAmount }, activeMarket),
        simulateOnly,
      });
    }
  };

  return (
    <div className="space-y-4">
      {/* Mode Selector Tabs */}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-muted/60 p-1 border border-glass-rim sm:grid-cols-4 backdrop-blur-md">
        {[
          { id: "deposit_sy" as const, label: `Wrap ${activeMarket.asset.code}`, sub: "1. Deposit" },
          { id: "mint_py" as const, label: "Split Pair", sub: "2. Mint PY" },
          { id: "redeem_py" as const, label: "Merge Pair", sub: "3. Unwind" },
          { id: "redeem_sy" as const, label: "Unwrap", sub: `4. To ${activeMarket.asset.code}` },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setMintMode(item.id)}
            className={`min-w-0 rounded-lg border py-2 px-1 text-center font-semibold whitespace-nowrap transition-colors cursor-pointer ${
              mintMode === item.id
                ? "bg-surface/90 text-ink shadow-glass border-glass-rim"
                : "border-transparent text-ink-secondary hover:text-ink hover:bg-surface-hover/50"
            }`}
          >
            <div className="text-xs leading-none whitespace-nowrap">{item.label}</div>
            <div className="mt-1 text-xs text-accent font-medium leading-none whitespace-nowrap">
              {item.sub}
            </div>
          </button>
        ))}
      </div>

      {/* Input Cockpit */}
      <div
        className={`glass-card double-bezel-recessed rounded-xl p-3.5 transition ${
          amountValidation.error
            ? "border-danger/60 focus-within:border-danger"
            : "border-glass-rim-subtle focus-within:border-accent/50"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
          <span className="font-medium text-ink-secondary">
            Deposit Amount ({currentConfig.assetLabel})
          </span>
          <div className="flex items-center gap-1.5 text-ink-muted">
            <span>Bal:</span>
            <span className="tabular-mono font-medium text-ink">
              {currentConfig.balanceStr}
            </span>
            <button
              type="button"
              onClick={handleMaxClick}
              className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-bold text-accent transition hover:bg-accent hover:text-accent-ink"
            >
              MAX
            </button>
          </div>
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <input
            type="text"
            inputMode="decimal"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            placeholder="1.0"
            className="tabular-mono w-full bg-transparent text-2xl font-bold text-ink outline-none placeholder:text-ink-muted/40"
          />
          <div className="flex shrink-0 items-center gap-1.5 rounded-xl bg-surface/80 px-3 py-1.5 border border-glass-rim shadow-glass">
            <TokenIcon symbol={currentConfig.assetLabel} underlying={activeMarket.asset.code} size="sm" />
            <span className="font-bold text-xs text-ink">{currentConfig.assetLabel}</span>
          </div>
        </div>

        {amountValidation.error && (
          <div className="mt-2 text-xs font-medium text-danger flex items-center gap-1.5">
            <span>•</span>
            <span>{amountValidation.error}</span>
          </div>
        )}
      </div>

      {/* Mode Description */}
      <div className="rounded-xl border border-glass-rim bg-surface-muted/30 p-3 text-xs text-ink-secondary leading-relaxed backdrop-blur-sm">
        {currentConfig.desc}
      </div>

      {/* Pool Matured Guard Notice */}
      {mintMode === "mint_py" && isMatured && (
        <div className="rounded-xl border border-warn/30 bg-warn-soft p-3 text-xs flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warn mt-0.5" />
          <div>
            <div className="font-semibold text-warn">Pool Matured</div>
            <div className="text-ink-secondary text-xs">
              Market reached maturity. Minting new PT and YT pairs is disabled.
            </div>
          </div>
        </div>
      )}

      {/* Inline Trustline Helper */}
      {needsTrustline && (
        <div className="rounded-xl border border-warn/30 bg-warn-soft p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warn mt-0.5" />
            <div>
              <div className="font-semibold text-warn">Trustline Required</div>
              <div className="text-ink-secondary text-xs">
                Establish a trustline to deposit and redeem {activeMarket.asset.code} on Stellar.
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
            <span>Connect Wallet to Sign</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            disabled={
              effectiveBusy !== null ||
              !amountValidation.valid ||
              !parsedAmount ||
              (mintMode === "mint_py" && isMatured)
            }
            onClick={() => void handleAction(false)}
            className="btn-accent flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold disabled:opacity-50 whitespace-nowrap active:scale-[0.99] cursor-pointer"
          >
            <span>
              {mintMode === "mint_py" && isMatured
                ? "Market Matured - Mint Disabled"
                : effectiveBusy
                ? effectiveBusy
                : !amountValidation.valid && amountValidation.error === "Insufficient balance"
                ? "Insufficient Balance"
                : currentConfig.btnLabel}
            </span>
            {!effectiveBusy && <ArrowRight className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
