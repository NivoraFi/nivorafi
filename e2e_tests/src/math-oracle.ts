// e2e_tests/src/math-oracle.ts
// Mathematical reference oracle for Stellar Pendle protocol (256-bit WAD fixed-point & AMM math)

export const WAD = 1_000_000_000_000_000_000n; // 10^18
export const HALF_WAD = 500_000_000_000_000_000n;
export const LN_2 = 693_147_180_559_945_309n;
export const MAX_EXP_INPUT = 46_440_000_000_000_000_000n; // 46.44 WAD
export const SECONDS_PER_YEAR = 31_536_000n;
export const MIN_MARKET_PROPORTION = 40_000_000_000_000_000n;  // 0.04 WAD (4%)
export const MAX_MARKET_PROPORTION = 960_000_000_000_000_000n; // 0.96 WAD (96%)
export const MIN_FEE_RATE = 200_000_000_000_000n;     // 2 bps
export const MAX_FEE_RATE = 10_000_000_000_000_000n;   // 100 bps

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
