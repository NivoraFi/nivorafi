import { ProtocolEvent, SwapEventParsed } from "./indexer";
import { formatUnits, SECONDS_PER_YEAR } from "./math";

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export interface ImpliedApyPoint {
  timestamp: number;
  ledger: number;
  impliedApyPct: number;
  ptPriceInSy: number;
  txHash: string;
}

export interface SwapApyExtraction {
  ptPriceInSy: number;
  impliedApyPct: number;
  tauYears: number;
  volumeSy: bigint;
}

export interface VolumeMetrics {
  totalVolumeStroops: bigint;
  volume24hStroops: bigint;
  volumePrev24hStroops: bigint;
  change24hPct: number;
  totalSwapCount: number;
  totalMintCount: number;
  uniqueTradersCount: number;
}

export interface TvlDataPoint {
  ledger: number;
  timestamp: number;
  protocolTvlStroops: bigint;
  ammTvlStroops: bigint;
}

export type ActivityActionType =
  | "SWAP_PT_FOR_SY"
  | "SWAP_SY_FOR_PT"
  | "SWAP_SY_FOR_YT"
  | "SWAP_YT_FOR_SY"
  | "MINT_PY"
  | "REDEEM_PY"
  | "REDEEM_PT"
  | "DEPOSIT_SY"
  | "REDEEM_SY"
  | "ADD_LIQUIDITY"
  | "REMOVE_LIQUIDITY"
  | "CLAIM_YIELD"
  | "ROLLOVER";

export interface UserActivityItem {
  id: string;
  txHash: string;
  ledger: number;
  timestamp: number;
  timestampIso: string;
  relativeTime: string;
  actionType: ActivityActionType;
  badge: {
    label: string;
    variant: "cyan" | "emerald" | "amber" | "indigo" | "purple" | "rose";
  };
  marketLabel: string;
  inDescription: string;
  outDescription: string;
  rateDescription: string;
  explorerUrl: string;
}

export interface SparklinePoint {
  timestamp: number;
  value: number;
}

// ============================================================================
// 2. Implied APY Derivation Engine
// ============================================================================

const SECONDS_IN_YEAR = Number(SECONDS_PER_YEAR); // 31,536,000

/**
 * Extracts the marginal PT spot price in terms of SY, time to maturity (tau),
 * and annualized implied APY from a single swap transaction.
 */
export function extractSwapApy(
  direction: number, // 0=PT->SY, 1=SY->PT, 2=SY->YT, 3=YT->SY
  amountIn: bigint,
  amountOut: bigint,
  fee: bigint,
  eventTimestamp: number,
  maturityTimestamp: number
): SwapApyExtraction {
  if (amountIn <= 0n || amountOut <= 0n) {
    return { ptPriceInSy: 1.0, impliedApyPct: 0.0, tauYears: 0, volumeSy: 0n };
  }

  const remainingSeconds = Math.max(0, maturityTimestamp - eventTimestamp);
  const tauYears = remainingSeconds / SECONDS_IN_YEAR;

  let ptPriceInSy = 1.0;
  let volumeSy = 0n;

  if (direction === 0) {
    // PT -> SY: amountIn is PT in, amountOut is net SY out, fee is SY fee
    const grossSy = amountOut + fee;
    ptPriceInSy = Number(grossSy) / Number(amountIn);
    volumeSy = grossSy;
  } else if (direction === 1) {
    // SY -> PT: amountIn is SY in, amountOut is net PT out, fee is PT fee
    const grossPt = amountOut + fee;
    ptPriceInSy = Number(amountIn) / Number(grossPt);
    volumeSy = amountIn;
  } else if (direction === 2) {
    // SY -> YT (Flash Buy YT): amountIn is SY in, amountOut is YT out
    // Since 1 SY splits into 1 PT + 1 YT: P_PT = 1 - P_YT
    const ytPrice = Number(amountIn) / Number(amountOut);
    ptPriceInSy = Math.max(0.0001, 1.0 - ytPrice);
    volumeSy = amountIn;
  } else if (direction === 3) {
    // YT -> SY (Flash Sell YT): amountIn is YT in, amountOut is net SY out, fee is SY fee
    const grossSy = amountOut + fee;
    const ytPrice = Number(grossSy) / Number(amountIn);
    ptPriceInSy = Math.max(0.0001, 1.0 - ytPrice);
    volumeSy = grossSy;
  }

  // Calculate APY with boundary protections
  let impliedApyPct = 0;
  if (tauYears > 0 && ptPriceInSy > 0 && ptPriceInSy < 1.0) {
    if (tauYears < 3600 / SECONDS_IN_YEAR) {
      // Near maturity (< 1 hour): switch to simple linear APR to avoid exponent blow-up
      impliedApyPct = ((1.0 - ptPriceInSy) / (ptPriceInSy * tauYears)) * 100;
    } else {
      // Compounded APY: ( (1 / P_PT)^(1 / tau) - 1 ) * 100
      impliedApyPct = (Math.pow(1.0 / ptPriceInSy, 1 / tauYears) - 1) * 100;
    }
    // Hard ceiling clamp at 500% to protect visualization from aberrant dust trades
    impliedApyPct = Math.min(500.0, Math.max(0.0, impliedApyPct));
  }

  return { ptPriceInSy, impliedApyPct, tauYears, volumeSy };
}

/**
 * Derives a chronological time series of Implied APY points from indexed events.
 */
export function deriveImpliedApyHistory(
  events: ProtocolEvent[],
  maturityTimestamp: number
): ImpliedApyPoint[] {
  const points: ImpliedApyPoint[] = [];

  for (const evt of events) {
    if (evt.type !== "swap") continue;
    const swap = evt as SwapEventParsed;
    if (swap.amountIn === 0n || swap.amountOut === 0n) continue;

    const { ptPriceInSy, impliedApyPct, tauYears } = extractSwapApy(
      swap.direction,
      swap.amountIn,
      swap.amountOut,
      swap.fee,
      swap.timestamp,
      maturityTimestamp
    );

    if (tauYears > 0 && impliedApyPct > 0) {
      points.push({
        timestamp: swap.timestamp,
        ledger: swap.ledger,
        impliedApyPct: Number(impliedApyPct.toFixed(2)),
        ptPriceInSy: Number(ptPriceInSy.toFixed(4)),
        txHash: swap.txHash,
      });
    }
  }

  return points.sort((a, b) => a.timestamp - b.timestamp);
}

// ============================================================================
// 3. Volume Aggregation Engine
// ============================================================================

/**
 * Calculates rolling 24h volume, previous 24h volume, 24h delta %, and total cumulative volume.
 * All volumes are in base units (stroops, 7 decimals).
 */
export function deriveVolumeMetrics(
  events: ProtocolEvent[],
  currentTimestamp: number = Math.floor(Date.now() / 1000)
): VolumeMetrics {
  const WINDOW_24H = 86400;
  const start24h = currentTimestamp - WINDOW_24H;
  const startPrev24h = currentTimestamp - 2 * WINDOW_24H;

  let totalVolume = 0n;
  let volume24h = 0n;
  let volumePrev24h = 0n;
  let totalSwapCount = 0;
  let totalMintCount = 0;
  const uniqueTraders = new Set<string>();

  for (const ev of events) {
    let evVolume = 0n;

    if (ev.type === "swap") {
      const swap = ev as SwapEventParsed;
      totalSwapCount++;
      if (swap.caller) uniqueTraders.add(swap.caller.toLowerCase());

      if (swap.direction === 0 || swap.direction === 3) {
        evVolume = swap.amountOut + swap.fee;
      } else {
        evVolume = swap.amountIn;
      }
    } else if (ev.type === "mint_py") {
      totalMintCount++;
      if (ev.caller) uniqueTraders.add(ev.caller.toLowerCase());
      evVolume = ev.syIn;
    }

    totalVolume += evVolume;

    if (ev.timestamp >= start24h && ev.timestamp <= currentTimestamp) {
      volume24h += evVolume;
    } else if (ev.timestamp >= startPrev24h && ev.timestamp < start24h) {
      volumePrev24h += evVolume;
    }
  }

  let change24hPct = 0;
  if (volumePrev24h === 0n) {
    change24hPct = volume24h > 0n ? 100 : 0;
  } else {
    const diff = Number(volume24h - volumePrev24h);
    change24hPct = Number(((diff / Number(volumePrev24h)) * 100).toFixed(2));
  }

  return {
    totalVolumeStroops: totalVolume,
    volume24hStroops: volume24h,
    volumePrev24hStroops: volumePrev24h,
    change24hPct,
    totalSwapCount,
    totalMintCount,
    uniqueTradersCount: uniqueTraders.size,
  };
}

export const aggregateVolume = deriveVolumeMetrics;

// ============================================================================
// 4. TVL Calculation Engine
// ============================================================================

/**
 * Computes canonical Protocol TVL (vault collateral) and AMM Market TVL (pool depth)
 * chronologically across historical deposit, redeem, liquidity, and swap events.
 */
export function deriveTvlMetrics(
  events: ProtocolEvent[],
  blendExchangeRateWad: bigint = 1_000_000_000_000_000_000n
): TvlDataPoint[] {
  const sorted = [...events].sort((a, b) => a.ledger - b.ledger || a.timestamp - b.timestamp);

  let cumulativeSyShares = 0n;
  let currentSyReserve = 0n;
  let currentPtReserve = 0n;
  let lastPtPrice = 1.0;

  const points: TvlDataPoint[] = [];

  for (const ev of sorted) {
    let stateChanged = false;

    if (ev.type === "deposit") {
      cumulativeSyShares += ev.sharesMinted;
      stateChanged = true;
    } else if (ev.type === "redeem") {
      cumulativeSyShares = cumulativeSyShares > ev.sharesBurned
        ? cumulativeSyShares - ev.sharesBurned
        : 0n;
      stateChanged = true;
    } else if (ev.type === "liquidity") {
      if (ev.isAdd) {
        currentPtReserve += ev.ptAmount;
        currentSyReserve += ev.syAmount;
      } else {
        currentPtReserve = currentPtReserve > ev.ptAmount ? currentPtReserve - ev.ptAmount : 0n;
        currentSyReserve = currentSyReserve > ev.syAmount ? currentSyReserve - ev.syAmount : 0n;
      }
      stateChanged = true;
    } else if (ev.type === "swap") {
      if (ev.direction === 0) {
        // PT in, SY out
        currentPtReserve += ev.amountIn;
        currentSyReserve = currentSyReserve > ev.amountOut ? currentSyReserve - ev.amountOut : 0n;
        if (ev.amountIn > 0n) {
          lastPtPrice = Number(ev.amountOut + ev.fee) / Number(ev.amountIn);
        }
      } else if (ev.direction === 1) {
        // SY in, PT out
        currentSyReserve += ev.amountIn;
        currentPtReserve = currentPtReserve > ev.amountOut ? currentPtReserve - ev.amountOut : 0n;
        if (ev.amountOut + ev.fee > 0n) {
          lastPtPrice = Number(ev.amountIn) / Number(ev.amountOut + ev.fee);
        }
      }
      stateChanged = true;
    }

    if (stateChanged) {
      // Canonical Protocol TVL = cumulative vault shares scaled by Blend exchange rate (WAD)
      const protocolTvl = (cumulativeSyShares * blendExchangeRateWad) / 1_000_000_000_000_000_000n;
      // AMM TVL = SY reserve + (PT reserve * PT spot price in SY)
      const ptValueInSy = BigInt(Math.max(0, Math.floor(Number(currentPtReserve) * lastPtPrice)));
      const ammTvl = currentSyReserve + ptValueInSy;

      points.push({
        ledger: ev.ledger,
        timestamp: ev.timestamp,
        protocolTvlStroops: protocolTvl,
        ammTvlStroops: ammTvl,
      });
    }
  }

  return points;
}

export const computeHistoricalTvl = deriveTvlMetrics;

// ============================================================================
// 5. User Transaction History Formatting
// ============================================================================

export function deriveUserTransactionHistory(
  events: ProtocolEvent[],
  userAddress: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  explorerBaseUrl: string = "https://stellar.expert/explorer/testnet"
): UserActivityItem[] {
  if (!userAddress || !userAddress.trim()) return [];
  const normUser = userAddress.trim().toLowerCase();

  const userEvents = events.filter((e) => {
    const callerMatch = e.caller ? e.caller.trim().toLowerCase() === normUser : false;
    const receiverMatch = e.receiver ? e.receiver.trim().toLowerCase() === normUser : false;
    const userMatch = "user" in e && (e as { user?: string }).user
      ? (e as { user: string }).user.trim().toLowerCase() === normUser
      : false;
    return callerMatch || receiverMatch || userMatch;
  });

  return userEvents
    .sort((a, b) => b.ledger - a.ledger || b.timestamp - a.timestamp)
    .map((ev) => {
      let actionType: ActivityActionType = "SWAP_SY_FOR_PT";
      let badgeLabel = "Swap";
      let badgeVariant: UserActivityItem["badge"]["variant"] = "cyan";
      let inDesc = "—";
      let outDesc = "—";
      let rateDesc = "—";

      switch (ev.type) {
        case "swap": {
          const dir = ev.direction;
          const inAmt = ev.amountIn;
          const outAmt = ev.amountOut;
          const fee = ev.fee;

          if (dir === 0) {
            actionType = "SWAP_PT_FOR_SY";
            badgeLabel = "Sell PT";
            badgeVariant = "amber";
            inDesc = `${formatUnits(inAmt, 7, 4)} PT`;
            outDesc = `${formatUnits(outAmt, 7, 4)} SY`;
            const rate = inAmt > 0n ? Number(outAmt + fee) / Number(inAmt) : 0;
            rateDesc = `@ ${rate.toFixed(4)} SY/PT`;
          } else if (dir === 1) {
            actionType = "SWAP_SY_FOR_PT";
            badgeLabel = "Buy PT";
            badgeVariant = "cyan";
            inDesc = `${formatUnits(inAmt, 7, 4)} SY`;
            outDesc = `${formatUnits(outAmt, 7, 4)} PT`;
            const grossPt = outAmt + fee;
            const rate = grossPt > 0n ? Number(inAmt) / Number(grossPt) : 0;
            rateDesc = `@ ${rate.toFixed(4)} SY/PT`;
          } else if (dir === 2) {
            actionType = "SWAP_SY_FOR_YT";
            badgeLabel = "Buy YT";
            badgeVariant = "purple";
            inDesc = `${formatUnits(inAmt, 7, 4)} SY`;
            outDesc = `${formatUnits(outAmt, 7, 4)} YT`;
            const rate = outAmt > 0n ? Number(inAmt) / Number(outAmt) : 0;
            rateDesc = `@ ${rate.toFixed(4)} SY/YT`;
          } else {
            actionType = "SWAP_YT_FOR_SY";
            badgeLabel = "Sell YT";
            badgeVariant = "rose";
            inDesc = `${formatUnits(inAmt, 7, 4)} YT`;
            outDesc = `${formatUnits(outAmt, 7, 4)} SY`;
            const rate = inAmt > 0n ? Number(outAmt + fee) / Number(inAmt) : 0;
            rateDesc = `@ ${rate.toFixed(4)} SY/YT`;
          }
          break;
        }

        case "mint_py": {
          actionType = "MINT_PY";
          badgeLabel = "Mint PT+YT";
          badgeVariant = "emerald";
          inDesc = `${formatUnits(ev.syIn, 7, 4)} SY`;
          outDesc = `${formatUnits(ev.pyOut, 7, 4)} PT + YT`;
          rateDesc = "1:1 Yield Strip";
          break;
        }

        case "redeem_py": {
          actionType = "REDEEM_PY";
          badgeLabel = "Redeem PY";
          badgeVariant = "indigo";
          inDesc = `${formatUnits(ev.pyBurned, 7, 4)} PT+YT`;
          outDesc = `${formatUnits(ev.syOut, 7, 4)} SY`;
          rateDesc = "1:1 Recombine";
          break;
        }

        case "redeem_pt": {
          actionType = "REDEEM_PT";
          badgeLabel = "Settle PT";
          badgeVariant = "emerald";
          inDesc = `${formatUnits(ev.ptBurned, 7, 4)} PT`;
          outDesc = `${formatUnits(ev.payout, 7, 4)} SY`;
          rateDesc = "1:1 Maturity Settlement";
          break;
        }

        case "deposit": {
          actionType = "DEPOSIT_SY";
          badgeLabel = "Deposit";
          badgeVariant = "emerald";
          inDesc = `${formatUnits(ev.underlyingAmount, 7, 4)} USDC`;
          outDesc = `${formatUnits(ev.sharesMinted, 7, 4)} sy-bUSDC`;
          rateDesc = "Blend Wrapper Inflow";
          break;
        }

        case "redeem": {
          actionType = "REDEEM_SY";
          badgeLabel = "Withdraw";
          badgeVariant = "rose";
          inDesc = `${formatUnits(ev.sharesBurned, 7, 4)} sy-bUSDC`;
          outDesc = `${formatUnits(ev.assetsOut, 7, 4)} USDC`;
          rateDesc = "Blend Wrapper Outflow";
          break;
        }

        case "liquidity": {
          actionType = ev.isAdd ? "ADD_LIQUIDITY" : "REMOVE_LIQUIDITY";
          badgeLabel = ev.isAdd ? "+ Liquidity" : "- Liquidity";
          badgeVariant = ev.isAdd ? "emerald" : "amber";
          inDesc = ev.isAdd
            ? `${formatUnits(ev.ptAmount, 7, 2)} PT + ${formatUnits(ev.syAmount, 7, 2)} SY`
            : `${formatUnits(ev.lpAmount, 7, 4)} LP`;
          outDesc = ev.isAdd
            ? `${formatUnits(ev.lpAmount, 7, 4)} LP`
            : `${formatUnits(ev.ptAmount, 7, 2)} PT + ${formatUnits(ev.syAmount, 7, 2)} SY`;
          rateDesc = "Yield Space Pool";
          break;
        }

        case "rollover": {
          actionType = "ROLLOVER";
          badgeLabel = "Rollover";
          badgeVariant = "indigo";
          inDesc = `${formatUnits(ev.ptBurned, 7, 4)} Old PT`;
          outDesc = `${formatUnits(ev.targetPtMinted, 7, 4)} New PT`;
          rateDesc = "Atomic Maturity Rollover";
          break;
        }

        case "rollover_py": {
          actionType = "ROLLOVER";
          badgeLabel = "Rollover PY";
          badgeVariant = "indigo";
          inDesc = `${formatUnits(ev.ptBurned, 7, 4)} Old PT`;
          outDesc = `${formatUnits(ev.pyMinted, 7, 4)} New PY`;
          rateDesc = "Atomic Rollover to PY";
          break;
        }

        case "yield_claimed": {
          actionType = "CLAIM_YIELD";
          badgeLabel = "Yield";
          badgeVariant = "emerald";
          inDesc = "YT Claim";
          outDesc = `${formatUnits(ev.yieldOut, 7, 4)} SY`;
          rateDesc = "Yield Distribution";
          break;
        }

        default: {
          break;
        }
      }

      const elapsed = Math.max(0, nowSeconds - ev.timestamp);
      let relativeTime = "Just now";
      if (elapsed >= 86400) relativeTime = `${Math.floor(elapsed / 86400)}d ago`;
      else if (elapsed >= 3600) relativeTime = `${Math.floor(elapsed / 3600)}h ago`;
      else if (elapsed >= 60) relativeTime = `${Math.floor(elapsed / 60)}m ago`;

      return {
        id: ev.id,
        txHash: ev.txHash,
        ledger: ev.ledger,
        timestamp: ev.timestamp,
        timestampIso: ev.ledgerClosedAt || new Date(ev.timestamp * 1000).toISOString(),
        relativeTime,
        actionType,
        badge: { label: badgeLabel, variant: badgeVariant },
        marketLabel: "bUSDC-90D",
        inDescription: inDesc,
        outDescription: outDesc,
        rateDescription: rateDesc,
        explorerUrl: `${explorerBaseUrl}/tx/${ev.txHash}`,
      };
    });
}

export const formatUserActivity = deriveUserTransactionHistory;

// ============================================================================
// 6. Sparkline Time Series Generator
// ============================================================================

/**
 * Generates an array of volume-weighted or interpolated APY sparkline points
 * across discrete time buckets.
 */
export function generateApySparkline(
  events: ProtocolEvent[],
  maturityTimestamp: number,
  bucketCount: number = 24,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SparklinePoint[] {
  const windowSeconds = 86400; // 24-hour default horizon
  const startTime = nowSeconds - windowSeconds;
  const bucketSize = windowSeconds / bucketCount;

  // Extract all valid swap points
  const apyPoints = deriveImpliedApyHistory(events, maturityTimestamp);
  if (apyPoints.length === 0) {
    return [];
  }

  const buckets: SparklinePoint[] = [];
  let lastKnownApy = apyPoints[0].impliedApyPct;

  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = startTime + i * bucketSize;
    const bucketEnd = bucketStart + bucketSize;

    const inBucket = apyPoints.filter(
      (p) => p.timestamp >= bucketStart && p.timestamp < bucketEnd
    );

    if (inBucket.length > 0) {
      const sum = inBucket.reduce((acc, p) => acc + p.impliedApyPct, 0);
      lastKnownApy = Number((sum / inBucket.length).toFixed(2));
    }

    buckets.push({
      timestamp: Math.floor(bucketEnd),
      value: lastKnownApy,
    });
  }

  return buckets;
}
