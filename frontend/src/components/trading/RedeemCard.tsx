"use client";

import React, { useMemo, useState } from "react";
import {
  ArrowRight,
  Coins,
  Lock,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useWallet } from "@/context/WalletProvider";
import { useMarket } from "@/context/MarketContext";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import {
  formatUnits,
  formatUnitsExact,
  validateAmountInput,
} from "@/lib/math";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  buildActionArgs,
  resolveScopedBusyAction,
} from "@/lib/stellar";
import { deriveMarketStatus } from "@/lib/markets";
import { TokenIcon } from "@/components/ui/TokenIcon";

type PostMaturityPayout = "sy" | "btoken";

interface RedeemCardProps {
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
  onSwitchToRollover?: () => void;
}

export function RedeemCard({
  snapshot,
  portfolio,
  busyAction,
  busyActions,
  onExecuteAction,
  onSwitchToRollover,
}: RedeemCardProps) {
  const { address, mode, connectWallet, walletNetworkMismatch, switchNetwork } =
    useWallet();
  const { activeMarket } = useMarket();

  const redeemBusy = resolveScopedBusyAction(
    busyActions,
    busyAction,
    activeMarket.contracts.poolId,
    ["redeem_py", "redeem_pt_post_maturity", "redeem_pt_to_btoken"]
  );

  const claimBusy = resolveScopedBusyAction(
    busyActions,
    busyAction,
    activeMarket.contracts.poolId,
    ["claim_yield"]
  );

  // Redemption state
  const [redeemInput, setRedeemInput] = useState<string>("0.5");
  const [payoutMode, setPayoutMode] = useState<PostMaturityPayout>("sy");

  const isGuest = mode !== "wallet" || !address;
  const simActor = address ?? STELLAR_PENDLE_CONFIG.deployer;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const isMatured =
    snapshot?.isMatured ??
    deriveMarketStatus(activeMarket.maturity, nowSeconds) === "MATURED";

  // Pre-Maturity max is min(PT, YT); Post-Maturity max is PT
  const maxRedeemBalance = useMemo(() => {
    if (!portfolio) return 0n;
    if (isMatured) {
      return portfolio.ptBalance;
    }
    return portfolio.ptBalance < portfolio.ytBalance
      ? portfolio.ptBalance
      : portfolio.ytBalance;
  }, [portfolio, isMatured]);

  const redeemValidation = useMemo(
    () => validateAmountInput(redeemInput, 7, maxRedeemBalance),
    [redeemInput, maxRedeemBalance]
  );
  const parsedRedeemAmount = redeemValidation.amount;

  // Handlers
  const handleClaimYield = async (simulateOnly = false) => {
    const caller = simulateOnly ? simActor : address;
    if (!caller) return;
    await onExecuteAction({
      ...buildActionArgs({ type: "claim_yield", caller }, activeMarket),
      simulateOnly,
    });
  };

  const handleRedeem = async (simulateOnly = false) => {
    if (!parsedRedeemAmount) return;
    const caller = simulateOnly ? simActor : address;
    if (!caller) return;

    if (!isMatured) {
      // Pre-maturity: early merge of PT + YT to SY
      await onExecuteAction({
        ...buildActionArgs(
          {
            type: "redeem_py",
            caller,
            amount: parsedRedeemAmount,
          },
          activeMarket
        ),
        simulateOnly,
      });
    } else {
      // Post-maturity: 1:1 PT redemption
      const actionType =
        payoutMode === "sy" ? "redeem_pt_post_maturity" : "redeem_pt_to_btoken";
      await onExecuteAction({
        ...buildActionArgs(
          {
            type: actionType,
            caller,
            ptAmount: parsedRedeemAmount,
          },
          activeMarket
        ),
        simulateOnly,
      });
    }
  };

  return (
    <div className="space-y-4">
      {/* Portfolio Token Balances Grid */}
      <div className="glass-card rounded-xl border border-glass-rim bg-surface-muted/40 p-3 backdrop-blur-sm">
        <div className="text-xs font-semibold text-ink-secondary mb-2 flex items-center justify-between">
          <span>Your Portfolio Balances</span>
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            <TokenIcon symbol={activeMarket.asset.code} size="xs" />
            <span>{activeMarket.asset.code} Market</span>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            {
              label: "XLM Gas",
              val: portfolio ? Number(portfolio.xlmBalance).toFixed(2) : "--",
            },
            {
              label: activeMarket.asset.code,
              val: portfolio ? Number(portfolio.usdcBalance).toFixed(2) : "--",
            },
            {
              label: activeMarket.sySymbol,
              val: portfolio ? formatUnits(portfolio.syBalance) : "--",
            },
            {
              label: activeMarket.ptSymbol,
              val: portfolio ? formatUnits(portfolio.ptBalance) : "--",
            },
            {
              label: activeMarket.ytSymbol,
              val: portfolio ? formatUnits(portfolio.ytBalance) : "--",
            },
            {
              label: activeMarket.lpSymbol,
              val: portfolio ? formatUnits(portfolio.lpBalance) : "--",
            },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-lg bg-surface/70 border border-glass-rim-subtle p-2 text-xs"
            >
              <div className="flex items-center gap-1.5 text-ink-muted text-xs truncate">
                <TokenIcon symbol={item.label} underlying={activeMarket.asset.code} size="xs" />
                <span className="truncate">{item.label}</span>
              </div>
              <div
                className="tabular-mono font-bold text-ink mt-0.5 truncate"
                title={item.val}
              >
                {item.val}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Contextual Rollover Callout Banner */}
      {isMatured && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/20 p-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shadow-sm">
          <div className="flex items-start gap-2.5">
            <div className="rounded-lg bg-accent/20 p-2 text-accent shrink-0 mt-0.5 sm:mt-0">
              <RefreshCw className="h-4 w-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-ink">
                This position is matured!
              </div>
              <p className="text-xs text-ink-secondary mt-0.5">
                Rollover into a new active maturity with 1 click.
              </p>
            </div>
          </div>
          {onSwitchToRollover && (
            <button
              type="button"
              onClick={onSwitchToRollover}
              className="btn-accent inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold shrink-0 cursor-pointer active:scale-[0.98]"
            >
              <span>Rollover Position</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {/* REDEEM POSITION */}
      <div
        aria-label="Redeem Position"
        className="glass-card double-bezel-recessed rounded-xl p-3.5 space-y-3 border-glass-rim-subtle"
      >
          {/* Header Banner */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <Lock className="h-4 w-4 text-accent" />
              <span>
                {isMatured ? "1:1 Maturity Settlement" : "Pre-Maturity Early Merge"}
              </span>
            </div>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold border ${
                isMatured
                  ? "bg-warn-soft border-warn/30 text-warn"
                  : "bg-positive-soft border-positive/30 text-positive"
              }`}
            >
              <Sparkles className="h-3 w-3" />
              <span>{isMatured ? "Pool Matured" : "Active Pool"}</span>
            </span>
          </div>

          <p className="text-xs text-ink-secondary leading-relaxed">
            {isMatured
              ? "Redeem matured PT 1:1 for underlying SY shares."
              : "Merge equal amounts of PT and YT back into SY before maturity."}
          </p>

          {/* Post-Maturity Payout Choice Toggle */}
          {isMatured && (
            <div className="rounded-lg bg-surface/80 border border-hairline p-2 space-y-1.5">
              <div className="text-xs font-medium text-ink-muted">Payout Asset</div>
              <div className="grid grid-cols-2 gap-1 text-xs">
                <button
                  type="button"
                  onClick={() => setPayoutMode("sy")}
                  className={`rounded-md py-1 font-semibold transition ${
                    payoutMode === "sy"
                      ? "bg-accent text-accent-ink"
                      : "text-ink-secondary hover:text-ink bg-surface-muted"
                  }`}
                >
                  SY Vault Shares
                </button>
                <button
                  type="button"
                  onClick={() => setPayoutMode("btoken")}
                  className={`rounded-md py-1 font-semibold transition ${
                    payoutMode === "btoken"
                      ? "bg-accent text-accent-ink"
                      : "text-ink-secondary hover:text-ink bg-surface-muted"
                  }`}
                >
                  Direct bToken
                </button>
              </div>
            </div>
          )}

          {/* Amount Input */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <input
                type="text"
                inputMode="decimal"
                value={redeemInput}
                onChange={(e) => setRedeemInput(e.target.value)}
                placeholder="0.5"
                className={`tabular-mono w-full bg-surface rounded-lg px-3 py-1.5 text-sm font-bold text-ink outline-none border transition ${
                  redeemValidation.error
                    ? "border-danger text-danger focus:border-danger"
                    : "border-hairline focus:border-accent"
                }`}
              />
              {portfolio && (
                <button
                  type="button"
                  onClick={() =>
                    setRedeemInput(formatUnitsExact(maxRedeemBalance))
                  }
                  className="rounded bg-surface-hover px-2 py-1 text-xs font-bold text-accent transition hover:bg-accent hover:text-accent-ink shrink-0"
                >
                  {isMatured ? "MAX PT" : "MAX (PT+YT)"}
                </button>
              )}
            </div>
            {redeemValidation.error && (
              <div className="text-xs font-medium text-danger flex items-center gap-1.5">
                <span>•</span>
                <span>{redeemValidation.error}</span>
              </div>
            )}
          </div>

          {/* Pre-Maturity Swap Reminder */}
          {!isMatured && (
            <div className="text-xs text-ink-muted leading-relaxed rounded-lg bg-surface/50 p-2 border border-hairline/60">
              Holding only PT? Use the Swap tab to trade PT for SY at prevailing market discount.
            </div>
          )}

          {/* Settlement Conversion Note */}
          {isMatured && (
            <div className="tabular-mono text-xs text-positive font-semibold flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-positive" />
              <span>Exact 1:1 Par Value Settlement (0% Protocol Haircut)</span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end pt-1">
            {walletNetworkMismatch ? (
              <button
                type="button"
                onClick={() => void switchNetwork()}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-warn bg-warn-soft text-warn hover:bg-warn hover:text-white transition cursor-pointer"
              >
                Switch to Testnet
              </button>
            ) : isGuest ? (
              <button
                type="button"
                onClick={connectWallet}
                className="btn-accent rounded-lg px-4 py-1.5 text-xs font-semibold"
              >
                Connect Wallet
              </button>
            ) : (
              <button
                type="button"
                disabled={
                  redeemBusy !== null ||
                  !redeemValidation.valid ||
                  !parsedRedeemAmount
                }
                onClick={() => void handleRedeem(false)}
                className="btn-accent rounded-lg px-4 py-1.5 text-xs font-semibold disabled:opacity-50"
              >
                {redeemBusy
                  ? redeemBusy
                  : !redeemValidation.valid &&
                    redeemValidation.error === "Insufficient balance"
                  ? "Insufficient Balance"
                  : isMatured
                  ? "Redeem PT 1:1"
                  : "Merge PT + YT"}
              </button>
            )}
          </div>
        </div>

      {/* Yield Harvesting Box (Preserved) */}
      <div className="glass-card double-bezel-recessed rounded-xl p-3.5 space-y-3 border-glass-rim-subtle">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Coins className="h-4 w-4 text-accent" />
            <span>Variable Yield Harvesting</span>
          </div>
          <span className="tabular-mono rounded-full bg-positive-soft border border-positive/30 px-2.5 py-0.5 text-xs font-semibold text-positive">
            +{portfolio ? formatUnits(portfolio.estimatedPendingYieldSy ?? 0n) : "0"} SY
          </span>
        </div>

        <p className="text-xs text-ink-secondary leading-relaxed">
          Harvest accumulated Blend lending interest accrued on your active YT holdings.
        </p>

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            disabled={claimBusy !== null}
            onClick={() => void handleClaimYield(true)}
            className="text-xs font-mono text-ink-muted hover:text-accent transition disabled:opacity-50"
          >
            [&gt;_ Simulate Claim]
          </button>

          {walletNetworkMismatch ? (
            <button
              type="button"
              onClick={() => void switchNetwork()}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-warn bg-warn-soft text-warn hover:bg-warn hover:text-white transition cursor-pointer"
            >
              Switch to Testnet
            </button>
          ) : isGuest ? (
            <button
              type="button"
              onClick={connectWallet}
              className="btn-accent rounded-lg px-4 py-1.5 text-xs font-semibold"
            >
              Connect Wallet
            </button>
          ) : (
            <button
              type="button"
              disabled={claimBusy !== null}
              onClick={() => void handleClaimYield(false)}
              className="btn-accent rounded-lg px-4 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {claimBusy ?? "Claim Yield"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
