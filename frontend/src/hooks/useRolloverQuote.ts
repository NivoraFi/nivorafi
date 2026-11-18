"use client";

import { useMemo, useState, useEffect } from "react";
import { MarketDefinition, deriveMarketStatus } from "@/lib/markets";
import { LiveMarketSnapshot, fetchMarketSnapshot, ProtocolAction } from "@/lib/stellar";
import { applySlippage, quoteSwapLocal, validateAmountInput } from "@/lib/math";
import { useMarket } from "@/context/MarketContext";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";

export type RolloverMode = "roll_to_pt" | "roll_to_py";

export type RolloverValidationStatus =
  | "IDLE"
  | "READY"
  | "INVALID_INPUT"
  | "SOURCE_NOT_MATURED"
  | "TARGET_ALREADY_MATURED"
  | "CROSS_ASSET_DISALLOWED"
  | "IDENTICAL_POOLS"
  | "INSUFFICIENT_BALANCE";

export interface UseRolloverQuoteParams {
  sourceMarket: MarketDefinition | null;
  targetMarket: MarketDefinition | null;
  ptAmountInput?: string;
  ptAmount?: string;
  sourcePtBalance?: bigint;
  mode: RolloverMode;
  slippageBps?: number;
}

export interface RolloverQuoteResult {
  isValid: boolean;
  status: RolloverValidationStatus;
  quoteStatus: RolloverValidationStatus;
  errorMessage: string | null;
  error: string | null;
  warnings: string[];
  isMatured: boolean;
  parsedAmount: bigint;
  sourcePtBurned: bigint;
  interimSySettled: bigint;
  estimatedTargetPt: bigint;
  expectedTargetAmount: bigint;
  estimatedTargetYt: bigint;
  minTargetOut: bigint;
  minReceived: bigint;
  fixedBonusPt: bigint;
  discountMultiplier: number;
  exchangeRate: number;
  isAmmSwap: boolean;
  loadingTargetSnapshot: boolean;
  loading: boolean;
  buildAction: (caller: string, receiver?: string) => ProtocolAction;
}

export function useRolloverQuote({
  sourceMarket,
  targetMarket,
  ptAmountInput,
  ptAmount: ptAmountAlias,
  sourcePtBalance,
  mode,
  slippageBps = 50, // Default 0.5% (50 bps)
}: UseRolloverQuoteParams): RolloverQuoteResult {
  const { marketMetrics } = useMarket();
  const [targetSnapshot, setTargetSnapshot] = useState<LiveMarketSnapshot | null>(null);
  const [loadingTargetSnapshot, setLoadingTargetSnapshot] = useState<boolean>(false);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const effectiveAmountInput = ptAmountAlias ?? ptAmountInput ?? "0";

  // Lazy-load target market snapshot for live AMM state if mode === "roll_to_pt"
  useEffect(() => {
    let cancelled = false;
    if (mode === "roll_to_pt" && targetMarket && targetMarket.isRegisteredOnChain) {
      setLoadingTargetSnapshot(true);
      fetchMarketSnapshot(targetMarket)
        .then((snap) => {
          if (!cancelled) setTargetSnapshot(snap);
        })
        .catch(() => {
          if (!cancelled) setTargetSnapshot(null);
        })
        .finally(() => {
          if (!cancelled) setLoadingTargetSnapshot(false);
        });
    } else {
      setTargetSnapshot(null);
      setLoadingTargetSnapshot(false);
    }
    return () => {
      cancelled = true;
    };
  }, [targetMarket?.id, mode]);

  return useMemo(() => {
    const fallbackAction = (caller: string, receiver?: string): ProtocolAction => ({
      type: "rollover_to_pt",
      caller,
      receiver: receiver ?? caller,
      sourcePool: sourceMarket?.contracts.poolId ?? "",
      targetPool: targetMarket?.contracts.poolId ?? "",
      ptAmount: 0n,
      minTargetPt: 0n,
      factoryContractId: STELLAR_PENDLE_CONFIG.market_factory.contractId,
    });

    const isSourceMatured = sourceMarket
      ? deriveMarketStatus(sourceMarket.maturity, nowSeconds) === "MATURED"
      : false;

    if (!sourceMarket || !targetMarket) {
      return {
        isValid: false,
        status: "IDLE",
        quoteStatus: "IDLE",
        errorMessage: "Select both source and target markets.",
        error: "Select both source and target markets.",
        warnings: [],
        isMatured: false,
        parsedAmount: 0n,
        sourcePtBurned: 0n,
        interimSySettled: 0n,
        estimatedTargetPt: 0n,
        expectedTargetAmount: 0n,
        estimatedTargetYt: 0n,
        minTargetOut: 0n,
        minReceived: 0n,
        fixedBonusPt: 0n,
        discountMultiplier: 1.0,
        exchangeRate: 1.0,
        isAmmSwap: false,
        loadingTargetSnapshot: false,
        loading: false,
        buildAction: fallbackAction,
      };
    }

    // 1. Pre-Flight Contract Check: Source must be matured
    if (!isSourceMatured) {
      return {
        isValid: false,
        status: "SOURCE_NOT_MATURED",
        quoteStatus: "SOURCE_NOT_MATURED",
        errorMessage: "Source market has not yet matured. Wait for maturity or use Early Merge.",
        error: "Source market has not yet matured. Wait for maturity or use Early Merge.",
        warnings: [],
        isMatured: false,
        parsedAmount: 0n,
        sourcePtBurned: 0n,
        interimSySettled: 0n,
        estimatedTargetPt: 0n,
        expectedTargetAmount: 0n,
        estimatedTargetYt: 0n,
        minTargetOut: 0n,
        minReceived: 0n,
        fixedBonusPt: 0n,
        discountMultiplier: 1.0,
        exchangeRate: 1.0,
        isAmmSwap: false,
        loadingTargetSnapshot,
        loading: loadingTargetSnapshot,
        buildAction: fallbackAction,
      };
    }

    // 2. Pre-Flight Contract Check: Target must be active
    const isTargetActive = deriveMarketStatus(targetMarket.maturity, nowSeconds) === "ACTIVE";
    if (!isTargetActive) {
      return {
        isValid: false,
        status: "TARGET_ALREADY_MATURED",
        quoteStatus: "TARGET_ALREADY_MATURED",
        errorMessage: "Target market has already matured. Choose an active market.",
        error: "Target market has already matured. Choose an active market.",
        warnings: [],
        isMatured: true,
        parsedAmount: 0n,
        sourcePtBurned: 0n,
        interimSySettled: 0n,
        estimatedTargetPt: 0n,
        expectedTargetAmount: 0n,
        estimatedTargetYt: 0n,
        minTargetOut: 0n,
        minReceived: 0n,
        fixedBonusPt: 0n,
        discountMultiplier: 1.0,
        exchangeRate: 1.0,
        isAmmSwap: false,
        loadingTargetSnapshot,
        loading: loadingTargetSnapshot,
        buildAction: fallbackAction,
      };
    }

    // 3. Pre-Flight Contract Check: Underlying asset parity
    if (sourceMarket.asset.code !== targetMarket.asset.code) {
      return {
        isValid: false,
        status: "CROSS_ASSET_DISALLOWED",
        quoteStatus: "CROSS_ASSET_DISALLOWED",
        errorMessage: `Cannot roll over from ${sourceMarket.asset.code} to ${targetMarket.asset.code}. Asset must match.`,
        error: `Cannot roll over from ${sourceMarket.asset.code} to ${targetMarket.asset.code}. Asset must match.`,
        warnings: [],
        isMatured: isSourceMatured,
        parsedAmount: 0n,
        sourcePtBurned: 0n,
        interimSySettled: 0n,
        estimatedTargetPt: 0n,
        expectedTargetAmount: 0n,
        estimatedTargetYt: 0n,
        minTargetOut: 0n,
        minReceived: 0n,
        fixedBonusPt: 0n,
        discountMultiplier: 1.0,
        exchangeRate: 1.0,
        isAmmSwap: false,
        loadingTargetSnapshot,
        loading: loadingTargetSnapshot,
        buildAction: fallbackAction,
      };
    }

    // 4. Pre-Flight Contract Check: Pool distinctness
    if (sourceMarket.contracts.poolId === targetMarket.contracts.poolId) {
      return {
        isValid: false,
        status: "IDENTICAL_POOLS",
        quoteStatus: "IDENTICAL_POOLS",
        errorMessage: "Source and target pools cannot be identical.",
        error: "Source and target pools cannot be identical.",
        warnings: [],
        isMatured: isSourceMatured,
        parsedAmount: 0n,
        sourcePtBurned: 0n,
        interimSySettled: 0n,
        estimatedTargetPt: 0n,
        expectedTargetAmount: 0n,
        estimatedTargetYt: 0n,
        minTargetOut: 0n,
        minReceived: 0n,
        fixedBonusPt: 0n,
        discountMultiplier: 1.0,
        exchangeRate: 1.0,
        isAmmSwap: false,
        loadingTargetSnapshot,
        loading: loadingTargetSnapshot,
        buildAction: fallbackAction,
      };
    }

    // 5. Amount validation against user PT balance
    const validation = validateAmountInput(
      effectiveAmountInput,
      7,
      sourcePtBalance !== undefined ? sourcePtBalance : undefined
    );
    if (!validation.valid || !validation.amount || validation.amount <= 0n) {
      const errStatus: RolloverValidationStatus =
        validation.error === "Insufficient balance" ? "INSUFFICIENT_BALANCE" : "INVALID_INPUT";
      const errMessage = validation.error ?? "Enter a valid amount.";
      return {
        isValid: false,
        status: errStatus,
        quoteStatus: errStatus,
        errorMessage: errMessage,
        error: errMessage,
        warnings: [],
        isMatured: isSourceMatured,
        parsedAmount: 0n,
        sourcePtBurned: 0n,
        interimSySettled: 0n,
        estimatedTargetPt: 0n,
        expectedTargetAmount: 0n,
        estimatedTargetYt: 0n,
        minTargetOut: 0n,
        minReceived: 0n,
        fixedBonusPt: 0n,
        discountMultiplier: 1.0,
        exchangeRate: 1.0,
        isAmmSwap: false,
        loadingTargetSnapshot,
        loading: loadingTargetSnapshot,
        buildAction: fallbackAction,
      };
    }

    const ptAmount = validation.amount;
    const syInterim = ptAmount; // 1:1 post-maturity redemption under solvency

    const warnings: string[] = [];
    if (slippageBps > 100) {
      warnings.push(`High slippage tolerance: ${(slippageBps / 100).toFixed(1)}%`);
    }

    if (mode === "roll_to_py") {
      // Mode B: 1:1 Mint into target PT + YT
      const minNewShares = applySlippage(syInterim, slippageBps);
      return {
        isValid: true,
        status: "READY",
        quoteStatus: "READY",
        errorMessage: null,
        error: null,
        warnings,
        isMatured: true,
        parsedAmount: ptAmount,
        sourcePtBurned: ptAmount,
        interimSySettled: syInterim,
        estimatedTargetPt: syInterim,
        expectedTargetAmount: syInterim,
        estimatedTargetYt: syInterim,
        minTargetOut: minNewShares,
        minReceived: minNewShares,
        fixedBonusPt: 0n,
        discountMultiplier: 1.0,
        exchangeRate: 1.0,
        isAmmSwap: false,
        loadingTargetSnapshot: false,
        loading: false,
        buildAction: (caller: string, receiver?: string): ProtocolAction => ({
          type: "rollover_to_py",
          caller,
          receiver: receiver ?? caller,
          sourcePool: sourceMarket.contracts.poolId,
          targetPool: targetMarket.contracts.poolId,
          ptAmount,
          minNewShares,
          factoryContractId: STELLAR_PENDLE_CONFIG.market_factory.contractId,
        }),
      };
    }

    // Mode A: Swap interim SY for target PT via AMM
    let estimatedTargetPt = 0n;
    let minTargetOut = 0n;
    let discountMultiplier = 1.04;

    // Try live AMM quote if target snapshot is available
    if (targetSnapshot?.state) {
      try {
        const q = quoteSwapLocal(
          targetSnapshot.state,
          "sy_for_pt",
          syInterim,
          BigInt(nowSeconds),
          slippageBps,
          targetSnapshot.pyIndex
        );
        estimatedTargetPt = q.estimatedOut;
        minTargetOut = q.minOutWithSlippage;
        discountMultiplier =
          Number(syInterim) > 0 ? Number(estimatedTargetPt) / Number(syInterim) : 1.04;
      } catch {
        // Fallback to discount model on math overflow or error
      }
    }

    // Fallback: Discount model from marketMetrics
    if (estimatedTargetPt === 0n) {
      const metrics = marketMetrics[targetMarket.id];
      discountMultiplier =
        metrics?.ptPriceInSy && metrics.ptPriceInSy > 0 ? 1 / metrics.ptPriceInSy : 1.04;
      estimatedTargetPt = BigInt(Math.floor(Number(syInterim) * discountMultiplier));
      minTargetOut = applySlippage(estimatedTargetPt, slippageBps);
      if (!targetSnapshot?.state) {
        warnings.push("Using benchmark discount pricing (target AMM state loading).");
      }
    }

    const fixedBonusPt = estimatedTargetPt > ptAmount ? estimatedTargetPt - ptAmount : 0n;

    return {
      isValid: true,
      status: "READY",
      quoteStatus: "READY",
      errorMessage: null,
      error: null,
      warnings,
      isMatured: true,
      parsedAmount: ptAmount,
      sourcePtBurned: ptAmount,
      interimSySettled: syInterim,
      estimatedTargetPt,
      expectedTargetAmount: estimatedTargetPt,
      estimatedTargetYt: 0n,
      minTargetOut,
      minReceived: minTargetOut,
      fixedBonusPt,
      discountMultiplier,
      exchangeRate: discountMultiplier,
      isAmmSwap: true,
      loadingTargetSnapshot,
      loading: loadingTargetSnapshot,
      buildAction: (caller: string, receiver?: string): ProtocolAction => ({
        type: "rollover_to_pt",
        caller,
        receiver: receiver ?? caller,
        sourcePool: sourceMarket.contracts.poolId,
        targetPool: targetMarket.contracts.poolId,
        ptAmount,
        minTargetPt: minTargetOut,
        factoryContractId: STELLAR_PENDLE_CONFIG.market_factory.contractId,
      }),
    };
  }, [
    sourceMarket,
    targetMarket,
    effectiveAmountInput,
    sourcePtBalance,
    mode,
    slippageBps,
    nowSeconds,
    targetSnapshot,
    marketMetrics,
    loadingTargetSnapshot,
  ]);
}
