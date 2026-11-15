import type { MarketStateOnChain, SwapDirection, SwapQuoteResult } from "./types.js";

export const WAD = 1_000_000_000_000_000_000n; // 10^18
export const SCALAR_9 = 1_000_000_000n; // 10^9 (Blend bRate scaling)
export const STROOPS_FACTOR = 10_000_000n; // 10^7 (Stellar 7 decimals)
export const LN_2 = 693_147_180_559_945_309n;
export const MAX_EXP_INPUT = 46_440_000_000_000_000_000n;
export const SECONDS_PER_YEAR = 31_536_000n;
export const MIN_MARKET_PROPORTION = 40_000_000_000_000_000n; // 4%
export const MAX_MARKET_PROPORTION = 960_000_000_000_000_000n; // 96%
export const MIN_FEE_RATE = 200_000_000_000_000n; // 2 bps
export const MAX_FEE_RATE = 10_000_000_000_000_000n; // 100 bps
export const I128_MAX = 170141183460469231731687303715884105727n;
export const I128_MIN = -170141183460469231731687303715884105728n;

export function wadMul(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  const res = (a * b) / WAD;
  if (res > I128_MAX || res < I128_MIN) {
    throw new Error("MathError::Overflow");
  }
  return res;
}

export function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) {
    throw new Error("MathError::DivisionByZero");
  }
  if (a === 0n) return 0n;
  const res = (a * WAD) / b;
  if (res > I128_MAX || res < I128_MIN) {
    throw new Error("MathError::Overflow");
  }
  return res;
}

export function lnWad(x: bigint): bigint {
  if (x <= 0n) {
    throw new Error("MathError::NegativeLogarithmInput");
  }
  if (x === WAD) return 0n;

  let k = 0n;
  let m = x;
  while (m >= 2n * WAD) {
    m >>= 1n;
    k += 1n;
  }
  while (m < WAD) {
    m <<= 1n;
    k -= 1n;
  }

  const num = m - WAD;
  const den = m + WAD;
  const z = wadDiv(num, den);
  const z2 = wadMul(z, z);

  const term3 = z2 / 3n;
  const z4 = wadMul(z2, z2);
  const term5 = z4 / 5n;
  const z6 = wadMul(z4, z2);
  const term7 = z6 / 7n;

  const poly = WAD + term3 + term5 + term7;
  const lnM = 2n * wadMul(z, poly);
  return k * LN_2 + lnM;
}

export function calculateTauWad(nowSeconds: bigint, maturitySeconds: bigint): bigint {
  if (maturitySeconds <= nowSeconds) return 0n;
  const remaining = maturitySeconds - nowSeconds;
  return (remaining * WAD) / SECONDS_PER_YEAR;
}

export function calculateFeeRate(tauWad: bigint, annualFeeRate: bigint): bigint {
  if (tauWad <= 0n) return MIN_FEE_RATE;
  const dynamic = wadMul(annualFeeRate, tauWad);
  if (dynamic < MIN_FEE_RATE) return MIN_FEE_RATE;
  if (dynamic > MAX_FEE_RATE) return MAX_FEE_RATE;
  return dynamic;
}

export function checkMarketProportion(ptReserve: bigint, syReserve: bigint): void {
  if (ptReserve <= 0n || syReserve <= 0n) {
    throw new Error("ContractError::ProportionOutOfBounds");
  }
  const p = wadDiv(ptReserve, ptReserve + syReserve);
  if (p < MIN_MARKET_PROPORTION || p > MAX_MARKET_PROPORTION) {
    throw new Error("ContractError::ProportionOutOfBounds");
  }
}

export function getExchangeRate(
  totalPt: bigint,
  totalSy: bigint,
  tauWad: bigint,
  scalarRoot: bigint,
  rateAnchor: bigint
): bigint {
  if (totalPt <= 0n || totalSy <= 0n) {
    throw new Error("ContractError::NegativeLogarithmInput");
  }
  if (tauWad === 0n) {
    return rateAnchor > WAD ? rateAnchor : WAD;
  }
  if (scalarRoot === 0n) {
    throw new Error("ContractError::DivisionByZero");
  }
  const ratio = wadDiv(totalPt, totalSy);
  const lnRatio = lnWad(ratio);
  const timeFactor = wadDiv(tauWad, scalarRoot);
  const scaledLn = wadMul(timeFactor, lnRatio);
  const e = rateAnchor + scaledLn;
  if (e < WAD) {
    throw new Error("ContractError::NegativeYieldNotSupported");
  }
  return e;
}

export function exchangeRateWadToNumber(eWad: bigint): number {
  return Number(eWad) / 1e18;
}

/**
 * Implied fixed APY = E^(1/tau) - 1, expressed in percent (e.g. 8.95 for 8.95%).
 */
export function calculateImpliedApyPct(eWad: bigint, tauWad: bigint): number {
  if (tauWad <= 0n || eWad <= WAD) return 0;
  const eFloat = Number(eWad) / 1e18;
  const tauYears = Number(tauWad) / 1e18;
  if (eFloat <= 1 || tauYears <= 0) return 0;
  return (Math.pow(eFloat, 1 / tauYears) - 1) * 100;
}

export function formatUnits(raw: bigint | string, decimals = 7, maxFrac = 4): string {
  const val = typeof raw === "string" ? BigInt(raw) : raw;
  const neg = val < 0n;
  const abs = neg ? -val : val;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const formatted = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${formatted}` : formatted;
}

export function parseUnits(human: string | number, decimals = 7): bigint {
  const str = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid decimal amount: "${human}"`);
  }
  const [wholePart, fracPart = ""] = str.split(".");
  if (fracPart.length > decimals) {
    throw new Error(`Too many decimal places (max ${decimals}): "${human}"`);
  }
  const paddedFrac = fracPart.padEnd(decimals, "0");
  return BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 5000) {
    throw new Error("slippageBps must be between 0 and 5000");
  }
  const minOut = (amount * BigInt(10_000 - slippageBps)) / 10_000n;
  return minOut > 0n ? minOut : 1n;
}

export function quoteSwap(
  state: MarketStateOnChain,
  direction: SwapDirection,
  amountIn: bigint,
  nowSeconds: bigint,
  slippageBps = 50
): SwapQuoteResult {
  if (amountIn <= 0n) {
    throw new Error("Amount must be positive");
  }
  const tauWad = calculateTauWad(nowSeconds, state.maturity);
  if (tauWad <= 0n) {
    throw new Error("ContractError::MarketAlreadyMatured");
  }
  const feeRate = calculateFeeRate(tauWad, state.annual_fee_rate);
  const ptRes = state.total_pt_reserve;
  const syRes = state.total_sy_reserve;

  let estimatedOut = 0n;
  let feeAmount = 0n;
  let newPt = ptRes;
  let newSy = syRes;
  let tradeRateWad = WAD;

  if (direction === "pt_for_sy") {
    newPt = ptRes + amountIn;
    tradeRateWad = getExchangeRate(newPt, syRes, tauWad, state.scalar_root, state.initial_anchor);
    const grossSy = wadDiv(amountIn, tradeRateWad);
    feeAmount = wadMul(grossSy, feeRate);
    estimatedOut = grossSy - feeAmount;
    if (estimatedOut >= syRes) throw new Error("ContractError::InsufficientBalance");
    const protoFee = (feeAmount * state.protocol_fee_bps) / 10_000n;
    newSy = syRes - estimatedOut - protoFee;
    checkMarketProportion(newPt, newSy);
  } else if (direction === "sy_for_pt") {
    newSy = syRes + amountIn;
    tradeRateWad = getExchangeRate(ptRes, newSy, tauWad, state.scalar_root, state.initial_anchor);
    const grossPt = wadMul(amountIn, tradeRateWad);
    feeAmount = wadMul(grossPt, feeRate);
    estimatedOut = grossPt - feeAmount;
    if (estimatedOut >= ptRes) throw new Error("ContractError::InsufficientBalance");
    newPt = ptRes - estimatedOut;
    checkMarketProportion(newPt, newSy);
  } else if (direction === "sy_for_yt") {
    const e0 = getExchangeRate(ptRes, syRes, tauWad, state.scalar_root, state.initial_anchor);
    if (e0 <= WAD) throw new Error("ContractError::NegativeYieldNotSupported");
    const unitYield0 = WAD - wadDiv(WAD, e0);
    const unitCost0 = unitYield0 + wadMul(unitYield0, feeRate);
    if (unitCost0 <= 0n) throw new Error("ContractError::NegativeYieldNotSupported");

    let n = wadDiv(amountIn, unitCost0);
    const e1 = getExchangeRate(ptRes + n, syRes, tauWad, state.scalar_root, state.initial_anchor);
    const unitYield1 = WAD - wadDiv(WAD, e1);
    const unitCost1 = unitYield1 + wadMul(unitYield1, feeRate);
    if (unitCost1 > 0n) {
      n = wadDiv(amountIn, unitCost1);
    }
    tradeRateWad = e1;
    const grossSySold = wadDiv(n, e1);
    const yieldCost = n - grossSySold;
    feeAmount = wadMul(yieldCost, feeRate);
    estimatedOut = n;
    newPt = ptRes + n;
    newSy = syRes - grossSySold;
    if (newSy <= 0n) throw new Error("ContractError::InsufficientBalance");
    checkMarketProportion(newPt, newSy);
  } else if (direction === "yt_for_sy") {
    if (ptRes < amountIn) throw new Error("ContractError::InsufficientBalance");
    newPt = ptRes - amountIn;
    tradeRateWad = getExchangeRate(newPt, syRes, tauWad, state.scalar_root, state.initial_anchor);
    const grossSyBuy = wadDiv(amountIn, tradeRateWad);
    if (amountIn <= grossSyBuy) throw new Error("ContractError::NegativeYieldNotSupported");
    const grossYield = amountIn - grossSyBuy;
    feeAmount = wadMul(grossYield, feeRate);
    estimatedOut = grossYield - feeAmount;
    newSy = syRes + grossSyBuy;
    checkMarketProportion(newPt, newSy);
  }

  const rateAfter = getExchangeRate(newPt, newSy, tauWad, state.scalar_root, state.initial_anchor);

  return {
    direction,
    amountIn: amountIn.toString(),
    estimatedOut: estimatedOut.toString(),
    minOutWithSlippage: applySlippage(estimatedOut, slippageBps).toString(),
    feeAmount: feeAmount.toString(),
    effectiveExchangeRate: exchangeRateWadToNumber(tradeRateWad),
    impliedApyAfterPct: calculateImpliedApyPct(rateAfter, tauWad),
    slippageBps,
  };
}
