// e2e_tests/src/math-oracle.ts
// Mathematical reference oracle for Stellar Pendle protocol (256-bit WAD fixed-point & AMM math)

export const WAD = 1_000_000_000_000_000_000n; // 10^18
export const HALF_WAD = 500_000_000_000_000_000n;
export const SCALAR_9 = 1_000_000_000n; // 10^9
export const LN_2 = 693_147_180_559_945_309n;
export const MAX_EXP_INPUT = 46_440_000_000_000_000_000n; // 46.44 WAD
export const SECONDS_PER_YEAR = 31_536_000n;
export const MIN_MARKET_PROPORTION = 40_000_000_000_000_000n;  // 0.04 WAD (4%)
export const MAX_MARKET_PROPORTION = 960_000_000_000_000_000n; // 0.96 WAD (96%)
export const MIN_FEE_RATE = 200_000_000_000_000n;     // 2 bps
export const MAX_FEE_RATE = 10_000_000_000_000_000n;   // 100 bps
export const DEFAULT_ANNUAL_FEE_RATE = 50_000_000_000_000_000n; // 5%
export const DEFAULT_PROTOCOL_FEE_BPS = 2_000n; // 20%
export const DEFAULT_SCALAR_ROOT = 20n * WAD;

export const I128_MAX = 170141183460469231731687303715884105727n;
export const I128_MIN = -170141183460469231731687303715884105728n;

export const DAY_IN_LEDGERS = 17_280;
export const MIN_BUMP_THRESHOLD = 30 * DAY_IN_LEDGERS; // 518,400
export const MAX_NETWORK_TTL = 180 * DAY_IN_LEDGERS;   // 3,110,400
export const DEFAULT_BUMP_TO = 120 * DAY_IN_LEDGERS;   // 2,073,600
export const BUFFER_LEDGERS = 30 * DAY_IN_LEDGERS;     // 518,400

export enum MathError {
  Overflow = "MathError::Overflow",
  Underflow = "MathError::Underflow",
  DivisionByZero = "MathError::DivisionByZero",
  NegativeLogarithmInput = "MathError::NegativeLogarithmInput",
  NegativeYieldNotSupported = "ContractError::NegativeYieldNotSupported",
}

export function wadMul(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  const prod = a * b;
  const res = prod / WAD;
  if (res > I128_MAX || res < I128_MIN) {
    throw new Error(MathError.Overflow);
  }
  return res;
}

export function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) {
    throw new Error(MathError.DivisionByZero);
  }
  if (a === 0n) return 0n;
  const num = a * WAD;
  const res = num / b;
  if (res > I128_MAX || res < I128_MIN) {
    throw new Error(MathError.Overflow);
  }
  return res;
}

export function wadDivCeil(a: bigint, b: bigint): bigint {
  if (b === 0n) {
    throw new Error(MathError.DivisionByZero);
  }
  if (a === 0n) return 0n;
  const sign = (a < 0n) !== (b < 0n);
  const ua = a < 0n ? -a : a;
  const ub = b < 0n ? -b : b;
  const num = ua * WAD;
  const q = num / ub;
  const rem = num % ub;
  if (sign) {
    if (q > I128_MAX) {
      throw new Error(MathError.Overflow);
    }
    return q === 0n ? 0n : -q;
  }
  const res = rem > 0n ? q + 1n : q;
  if (res > I128_MAX) {
    throw new Error(MathError.Overflow);
  }
  return res;
}

export function lnWad(x: bigint): bigint {
  if (x <= 0n) {
    throw new Error(MathError.NegativeLogarithmInput);
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
  const kTerm = k * LN_2;
  return kTerm + lnM;
}

export function expWad(x: bigint): bigint {
  if (x === 0n) return WAD;
  if (x < -41n * WAD) return 0n;
  if (x > MAX_EXP_INPUT) {
    throw new Error(MathError.Overflow);
  }

  let q = x / LN_2;
  let r = x % LN_2;
  if (r < 0n) {
    r += LN_2;
    q -= 1n;
  }

  const r2 = wadMul(r, r);
  const r3 = wadMul(r2, r);
  const r4 = wadMul(r3, r);
  const r5 = wadMul(r4, r);
  const r6 = wadMul(r5, r);
  const r7 = wadMul(r6, r);

  const term2 = r2 / 2n;
  const term3 = r3 / 6n;
  const term4 = r4 / 24n;
  const term5 = r5 / 120n;
  const term6 = r6 / 720n;
  const term7 = r7 / 5040n;

  const expR = WAD + r + term2 + term3 + term4 + term5 + term6 + term7;
  return q >= 0n ? (expR << q) : (expR >> (-q));
}

export function getExchangeRate(
  totalPt: bigint,
  totalSy: bigint,
  tauWad: bigint,
  scalarRoot: bigint,
  rateAnchor: bigint
): bigint {
  if (totalPt <= 0n || totalSy <= 0n) {
    throw new Error(MathError.NegativeLogarithmInput);
  }
  if (tauWad === 0n) {
    return WAD; // Deterministic convergence to 1.0 at maturity (zero impermanent loss)
  }
  if (scalarRoot === 0n) {
    throw new Error(MathError.DivisionByZero);
  }

  const ratio = wadDiv(totalPt, totalSy);
  const lnRatio = lnWad(ratio);
  const timeFactor = wadDiv(tauWad, scalarRoot);
  const scaledLn = wadMul(timeFactor, lnRatio);
  const e = rateAnchor + scaledLn;

  if (e < WAD) {
    throw new Error(MathError.NegativeYieldNotSupported);
  }
  return e;
}

export function calculateBumpTo(currentTimestamp: bigint, maturityTimestamp: bigint): number {
  if (maturityTimestamp <= currentTimestamp) {
    return DEFAULT_BUMP_TO;
  }
  const remainingSeconds = maturityTimestamp - currentTimestamp;
  const remainingLedgers = Number(remainingSeconds / 5n);
  const target = remainingLedgers + BUFFER_LEDGERS;
  return Math.min(Math.max(target, DEFAULT_BUMP_TO), MAX_NETWORK_TTL);
}

export function calculateBumpThreshold(bumpTo: number): number {
  return Math.max(Math.floor(bumpTo / 4), MIN_BUMP_THRESHOLD);
}

export function calculateHaircut(vaultBalance: bigint, totalPtSupply: bigint): bigint {
  if (totalPtSupply <= 0n) {
    throw new Error(MathError.DivisionByZero);
  }
  const ratio = wadDiv(vaultBalance, totalPtSupply);
  return ratio < WAD ? ratio : WAD;
}

export function calcTauWad(now: bigint, maturity: bigint): bigint {
  if (maturity <= now) return 0n;
  return ((maturity - now) * WAD) / SECONDS_PER_YEAR;
}

export function calcFeeRate(
  tauWad: bigint,
  annualFeeRate: bigint = DEFAULT_ANNUAL_FEE_RATE
): bigint {
  if (tauWad <= 0n) return MIN_FEE_RATE;
  const dyn = wadMul(annualFeeRate, tauWad);
  if (dyn < MIN_FEE_RATE) return MIN_FEE_RATE;
  if (dyn > MAX_FEE_RATE) return MAX_FEE_RATE;
  return dyn;
}

export function syToAsset(pyIndex: bigint, syAmount: bigint): bigint {
  return (syAmount * pyIndex) / SCALAR_9;
}

export function assetToSy(pyIndex: bigint, assetAmount: bigint): bigint {
  return (assetAmount * SCALAR_9) / pyIndex;
}

export function calculateProRataShare(
  amount: bigint,
  available: bigint,
  totalSupply: bigint
): bigint {
  if (totalSupply <= 0n) {
    throw new Error(MathError.DivisionByZero);
  }
  if (available <= 0n || amount <= 0n) {
    return 0n;
  }
  if (amount >= totalSupply) {
    return available;
  }
  return (amount * available) / totalSupply;
}

export function oracleSwapPtForSy(
  ptIn: bigint,
  ptRes: bigint,
  syRes: bigint,
  now: bigint,
  maturity: bigint,
  anchor: bigint = WAD,
  pyIndex: bigint = SCALAR_9,
  scalarRoot: bigint = DEFAULT_SCALAR_ROOT,
  annualFeeRate: bigint = DEFAULT_ANNUAL_FEE_RATE,
  protocolFeeBps: bigint = DEFAULT_PROTOCOL_FEE_BPS
): { netOut: bigint; fee: bigint; protoFee: bigint } {
  const tau = calcTauWad(now, maturity);
  const feeRate = calcFeeRate(tau, annualFeeRate);
  const assetRes = syToAsset(pyIndex, syRes);
  const eTrade = getExchangeRate(ptRes + ptIn, assetRes, tau, scalarRoot, anchor);
  const grossAsset = wadDiv(ptIn, eTrade);
  const feeAsset = wadMul(grossAsset, feeRate);
  const netAssetOut = grossAsset - feeAsset;
  const netOut = assetToSy(pyIndex, netAssetOut);
  const fee = assetToSy(pyIndex, feeAsset);
  const protoFee = (fee * protocolFeeBps) / 10_000n;
  return { netOut, fee, protoFee };
}

export function oracleSwapSyForPt(
  syIn: bigint,
  ptRes: bigint,
  syRes: bigint,
  now: bigint,
  maturity: bigint,
  anchor: bigint = WAD,
  pyIndex: bigint = SCALAR_9,
  scalarRoot: bigint = DEFAULT_SCALAR_ROOT,
  annualFeeRate: bigint = DEFAULT_ANNUAL_FEE_RATE,
  protocolFeeBps: bigint = DEFAULT_PROTOCOL_FEE_BPS
): { netOut: bigint; fee: bigint; protoFee: bigint } {
  const tau = calcTauWad(now, maturity);
  const feeRate = calcFeeRate(tau, annualFeeRate);
  const assetRes = syToAsset(pyIndex, syRes);
  const assetIn = syToAsset(pyIndex, syIn);
  const eTrade = getExchangeRate(ptRes, assetRes + assetIn, tau, scalarRoot, anchor);
  const gross = wadMul(assetIn, eTrade);
  const fee = wadMul(gross, feeRate);
  const protoFee = (fee * protocolFeeBps) / 10_000n;
  return { netOut: gross - fee, fee, protoFee };
}

export function oracleSwapSyForYt(
  syIn: bigint,
  ptRes: bigint,
  syRes: bigint,
  now: bigint,
  maturity: bigint,
  anchor: bigint = WAD,
  pyIndex: bigint = SCALAR_9,
  scalarRoot: bigint = DEFAULT_SCALAR_ROOT,
  annualFeeRate: bigint = DEFAULT_ANNUAL_FEE_RATE,
  protocolFeeBps: bigint = DEFAULT_PROTOCOL_FEE_BPS
): { ytOut: bigint; fee: bigint; protoFee: bigint } {
  const tau = calcTauWad(now, maturity);
  const feeRate = calcFeeRate(tau, annualFeeRate);
  const assetRes = syToAsset(pyIndex, syRes);
  const assetIn = syToAsset(pyIndex, syIn);
  const e0 = getExchangeRate(ptRes, assetRes, tau, scalarRoot, anchor);
  const unitYield0 = WAD - wadDiv(WAD, e0);
  const unitCost0 = unitYield0 + wadMul(unitYield0, feeRate);
  const n0 = wadDiv(assetIn, unitCost0);
  const maxNSy = syToAsset(pyIndex, syRes + syIn);
  let hi = n0 < maxNSy ? n0 : maxNSy;
  let lo = 0n;
  let bestE = e0;

  for (let i = 0; i < 48; i++) {
    if (lo >= hi) break;
    const mid = lo + (hi - lo + 1n) / 2n;
    const grossEst = wadDiv(mid, e0);
    if (grossEst >= assetRes) {
      hi = mid - 1n;
      continue;
    }
    let eMid: bigint;
    try {
      eMid = getExchangeRate(ptRes + mid, assetRes - grossEst, tau, scalarRoot, anchor);
    } catch {
      hi = mid - 1n;
      continue;
    }
    const unitYield = WAD - wadDiv(WAD, eMid);
    const unitCost = unitYield + wadMul(unitYield, feeRate);
    const cost = wadMul(mid, unitCost);
    if (cost <= assetIn) {
      lo = mid;
      bestE = eMid;
    } else {
      hi = mid - 1n;
    }
  }

  const n = lo;
  const e1 = bestE;
  const grossAssetSold = wadDiv(n, e1);
  const yieldCost = n - grossAssetSold;
  const feeAsset = wadMul(yieldCost, feeRate);
  const fee = assetToSy(pyIndex, feeAsset);
  const protoFee = (fee * protocolFeeBps) / 10_000n;
  return { ytOut: n, fee, protoFee };
}

export function oracleSwapYtForSy(
  ytIn: bigint,
  ptRes: bigint,
  syRes: bigint,
  now: bigint,
  maturity: bigint,
  anchor: bigint = WAD,
  pyIndex: bigint = SCALAR_9,
  scalarRoot: bigint = DEFAULT_SCALAR_ROOT,
  annualFeeRate: bigint = DEFAULT_ANNUAL_FEE_RATE,
  protocolFeeBps: bigint = DEFAULT_PROTOCOL_FEE_BPS
): { netOut: bigint; fee: bigint; protoFee: bigint } {
  const tau = calcTauWad(now, maturity);
  const feeRate = calcFeeRate(tau, annualFeeRate);
  const assetRes = syToAsset(pyIndex, syRes);
  const newPtRes = ptRes - ytIn;
  const e0 = getExchangeRate(newPtRes, assetRes, tau, scalarRoot, anchor);
  const grossEst0 = wadDiv(ytIn, e0);
  const e1 = getExchangeRate(newPtRes, assetRes + grossEst0, tau, scalarRoot, anchor);
  const grossEst1 = wadDiv(ytIn, e1);
  const eTrade = getExchangeRate(newPtRes, assetRes + grossEst1, tau, scalarRoot, anchor);
  const grossAssetBuy = wadDivCeil(ytIn, eTrade);
  const grossYield = ytIn - grossAssetBuy;
  const feeAsset = wadMul(grossYield, feeRate);
  const netAssetOut = grossYield - feeAsset;
  const netOut = assetToSy(pyIndex, netAssetOut);
  const fee = assetToSy(pyIndex, feeAsset);
  const protoFee = (fee * protocolFeeBps) / 10_000n;
  return { netOut, fee, protoFee };
}
