export const WAD = 1_000_000_000_000_000_000n;
export const SCALAR_9 = 1_000_000_000n;
export const STROOPS_FACTOR = 10_000_000n;
export const LN_2 = 693_147_180_559_945_309n;
export const SECONDS_PER_YEAR = 31_536_000n;
export const MIN_MARKET_PROPORTION = 40_000_000_000_000_000n;
export const MAX_MARKET_PROPORTION = 960_000_000_000_000_000n;
export const MIN_FEE_RATE = 200_000_000_000_000n;
export const MAX_FEE_RATE = 10_000_000_000_000_000n;
export const I128_MAX = 170141183460469231731687303715884105727n;
export const I128_MIN = -170141183460469231731687303715884105728n;

export type SwapDirection = "pt_for_sy" | "sy_for_pt" | "sy_for_yt" | "yt_for_sy";

export interface MarketStateRaw {
  total_pt_reserve: bigint;
  total_sy_reserve: bigint;
  total_lp_supply: bigint;
  scalar_root: bigint;
  initial_anchor: bigint;
  annual_fee_rate: bigint;
  protocol_fee_bps: bigint;
  fee_recipient: string;
  maturity: bigint;
  maturity_index: bigint;
  is_settled: boolean;
}

export interface SwapQuote {
  direction: SwapDirection;
  amountIn: bigint;
  estimatedOut: bigint;
  minOutWithSlippage: bigint;
  feeAmount: bigint;
  effectiveExchangeRate: number;
  impliedApyAfterPct: number;
}

export const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1: "Contract is not initialized yet.",
  2: "Contract is already initialized.",
  3: "Signer is not authorized for this contract action.",
  4: "Amount must be strictly greater than zero.",
  5: "Insufficient token or pool reserve balance.",
  6: "Insufficient token allowance for transfer.",
  7: "Market has already reached maturity.",
  8: "Market has not reached maturity yet.",
  9: "Output fell below your slippage tolerance limit.",
  10: "Transaction deadline has expired.",
  11: "Invalid maturity timestamp supplied.",
  12: "Underlying Blend pool returned an invalid exchange rate.",
  13: "Fixed-point arithmetic overflow occurred.",
  14: "Trade pushes AMM reserve ratio beyond allowed 4%-96% bounds.",
  15: "Source and receiver addresses must differ where required.",
  16: "Market is already settled at maturity.",
  17: "Reentrancy guard rejected nested contract call.",
  18: "Negative implied yield is not supported by AMM curve.",
  19: "Invalid logarithm domain input in AMM pricing.",
  20: "Division by zero in fixed-point math.",
  21: "Target and source market assets must match for rollover.",
  22: "Invalid interest or fee rate parameter.",
  23: "Contract is currently paused by emergency guardian.",
  24: "No pending admin proposal to accept.",
  25: "Market for this asset and maturity already exists.",
  26: "Market not found in factory registry.",
  27: "Invalid market initialization parameters.",
  28: "Atomic rollover operation failed.",
  29: "Contract is not paused.",
  30: "Proposed admin address is invalid.",
  31: "Invalid WASM byte code hash.",
};

export const HORIZON_ERROR_MESSAGES: Record<string, string> = {
  tx_bad_seq: "Transaction sequence number is stale or invalid. Please sync ledger and retry.",
  tx_bad_auth: "Transaction authorization failed (bad signature or unauthorized signer).",
  tx_insufficient_fee: "Transaction fee is lower than the network minimum.",
  tx_insufficient_balance: "Account has insufficient native XLM balance for fees.",
  tx_too_early: "Transaction submitted before its valid time window.",
  tx_too_late: "Transaction expired before ledger inclusion.",
  tx_missing_operation: "Transaction envelope contains no operations.",
  tx_bad_auth_extra: "Transaction contains unused extra signatures.",
  tx_internal_error: "Stellar Core internal error. Please retry.",
  op_underfunded: "Account balance is insufficient to complete the operation.",
  op_low_reserve: "Account has insufficient XLM reserve for operation fees or base reserve.",
  op_no_trust: "Account is missing Testnet USDC trustline. Use Add USDC Trustline first.",
  op_no_trustline: "Account is missing Testnet USDC trustline. Use Add USDC Trustline first.",
  op_already_exists: "Trustline or entry already exists on this account.",
  op_no_destination: "Destination account does not exist on Stellar.",
  op_line_full: "Destination trustline limit would be exceeded.",
  op_bad_auth: "Operation signer authorization failed.",
  op_no_source_account: "Operation source account does not exist.",
  op_not_supported: "Operation not supported on this asset or account.",
  RESOURCE_LIMIT_EXCEEDED: "Transaction exceeded Soroban CPU or memory resource limits.",
  ENTRY_EXPIRED: "Soroban contract storage entry has expired and must be restored.",
  FEE_TOO_LOW: "Transaction fee bid is too low for current network congestion.",
};

export function decodeSorobanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  
  // 1. Contract error codes 1..20
  const codeMatch = raw.match(/Error\(Contract,\s*#?(\d+)\)|ContractError.*?#?(\d+)|HostError.*?#?(\d+)/i);
  if (codeMatch) {
    const codeNum = Number(codeMatch[1] ?? codeMatch[2] ?? codeMatch[3]);
    if (CONTRACT_ERROR_MESSAGES[codeNum]) {
      return `Soroban ContractError #${codeNum}: ${CONTRACT_ERROR_MESSAGES[codeNum]}`;
    }
    return `Soroban ContractError #${codeNum}: Unknown contract error code.`;
  }

  // 2. Horizon / Stellar Core result codes
  for (const [codeKey, description] of Object.entries(HORIZON_ERROR_MESSAGES)) {
    if (raw.includes(codeKey)) {
      return description;
    }
  }

  // 3. User cancellation
  if (raw.includes("User declined") || raw.includes("rejected") || raw.includes("cancelled")) {
    return "Wallet signature request was cancelled by user.";
  }

  // 4. Fallback sanitization
  return raw.length > 220 ? `${raw.slice(0, 220)}...` : raw;
}

export function wadMul(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  const res = (a * b) / WAD;
  if (res > I128_MAX || res < I128_MIN) throw new Error("Fixed-point overflow");
  return res;
}

export function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("Division by zero");
  if (a === 0n) return 0n;
  const res = (a * WAD) / b;
  if (res > I128_MAX || res < I128_MIN) throw new Error("Fixed-point overflow");
  return res;
}

export function wadDivCeil(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("Division by zero");
  if (a === 0n) return 0n;
  const sign = (a < 0n) !== (b < 0n);
  const ua = a < 0n ? -a : a;
  const ub = b < 0n ? -b : b;
  const num = ua * WAD;
  const q = num / ub;
  const rem = num % ub;
  if (sign) {
    if (q > I128_MAX) throw new Error("Fixed-point overflow");
    return q === 0n ? 0n : -q;
  }
  const res = rem > 0n ? q + 1n : q;
  if (res > I128_MAX) throw new Error("Fixed-point overflow");
  return res;
}

export function lnWad(x: bigint): bigint {
  if (x <= 0n) throw new Error("Negative logarithm input");
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

  const z = wadDiv(m - WAD, m + WAD);
  const z2 = wadMul(z, z);
  const term3 = z2 / 3n;
  const z4 = wadMul(z2, z2);
  const term5 = z4 / 5n;
  const z6 = wadMul(z4, z2);
  const term7 = z6 / 7n;

  const poly = WAD + term3 + term5 + term7;
  return k * LN_2 + 2n * wadMul(z, poly);
}

export function calculateTauWad(nowSeconds: bigint, maturitySeconds: bigint): bigint {
  if (maturitySeconds <= nowSeconds) return 0n;
  return ((maturitySeconds - nowSeconds) * WAD) / SECONDS_PER_YEAR;
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
    throw new Error("AMM reserves would drop to zero");
  }
  const p = wadDiv(ptReserve, ptReserve + syReserve);
  if (p < MIN_MARKET_PROPORTION || p > MAX_MARKET_PROPORTION) {
    throw new Error("Trade exceeds AMM 4%-96% reserve safety bounds");
  }
}

export function getExchangeRateWad(
  totalPt: bigint,
  totalSy: bigint,
  tauWad: bigint,
  scalarRoot: bigint,
  rateAnchor: bigint
): bigint {
  if (totalPt <= 0n || totalSy <= 0n) throw new Error("Reserves must be positive");
  if (tauWad === 0n) return rateAnchor > WAD ? rateAnchor : WAD;
  if (scalarRoot === 0n) throw new Error("Scalar root cannot be zero");
  const ratio = wadDiv(totalPt, totalSy);
  const lnRatio = lnWad(ratio);
  const timeFactor = wadDiv(tauWad, scalarRoot);
  const e = rateAnchor + wadMul(timeFactor, lnRatio);
  if (e < WAD) throw new Error("Negative implied yield not supported");
  return e;
}

export function calculateImpliedApyPct(eWad: bigint, tauWad: bigint): number {
  if (tauWad <= 0n || eWad <= WAD) return 0;
  const eFloat = Number(eWad) / 1e18;
  const tauYears = Number(tauWad) / 1e18;
  if (eFloat <= 1 || tauYears <= 0) return 0;
  return (Math.pow(eFloat, 1 / tauYears) - 1) * 100;
}

export function formatUnits(raw: bigint | string | number, decimals = 7, maxFrac = 4): string {
  const val = typeof raw === "bigint" ? raw : BigInt(raw);
  const neg = val < 0n;
  const abs = neg ? -val : val;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const out = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${out}` : out;
}

export function formatUnitsExact(raw: bigint | string | number, decimals = 7): string {
  return formatUnits(raw, decimals, decimals);
}

export interface AmountValidationResult {
  valid: boolean;
  amount?: bigint;
  error?: string;
}

export function validateAmountInput(
  human: string,
  decimals = 7,
  balance?: bigint | string | null
): AmountValidationResult {
  const trimmed = human.trim();
  if (!trimmed) {
    return { valid: false, error: "Amount is required" };
  }
  if (trimmed.startsWith("-")) {
    return { valid: false, error: "Amount cannot be negative" };
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { valid: false, error: "Please enter a valid numeric amount" };
  }
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) {
    return {
      valid: false,
      error: `Precision cannot exceed ${decimals} decimal places`,
    };
  }
  const padded = fracPart.padEnd(decimals, "0");
  try {
    const val = BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(padded || "0");
    if (val <= 0n) {
      return { valid: false, error: "Amount must be strictly greater than zero" };
    }
    if (balance !== undefined && balance !== null) {
      let balBigInt: bigint | null = null;
      if (typeof balance === "bigint") {
        balBigInt = balance;
      } else {
        const numStr = String(balance).trim();
        if (/^\d+(\.\d+)?$/.test(numStr)) {
          const [wholePart, fracPart = ""] = numStr.split(".");
          const padded = fracPart.slice(0, decimals).padEnd(decimals, "0");
          try {
            balBigInt = BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(padded || "0");
          } catch {
            balBigInt = null;
          }
        }
      }
      if (balBigInt !== null && val > balBigInt) {
        return {
          valid: false,
          amount: val,
          error: "Insufficient balance",
        };
      }
    }
    return { valid: true, amount: val };
  } catch {
    return { valid: false, error: "Invalid amount representation" };
  }
}

export function parseUnitsSafe(human: string, decimals = 7): bigint | null {
  const res = validateAmountInput(human, decimals);
  return res.valid && res.amount ? res.amount : null;
}

export interface SlippageValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
  isHigh?: boolean;
}

export function validateSlippage(slippageBps: number): SlippageValidationResult {
  if (typeof slippageBps !== "number" || isNaN(slippageBps)) {
    return { valid: false, error: "Slippage must be a valid number" };
  }
  if (slippageBps < 1 || slippageBps > 1000) {
    return {
      valid: false,
      error: "Slippage tolerance must be between 0.01% (1 bps) and 10.0% (1000 bps)",
    };
  }
  if (slippageBps > 500) {
    return {
      valid: true,
      isHigh: true,
      warning: "High slippage tolerance (>5%). Your transaction may be frontrun.",
    };
  }
  return { valid: true };
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  const minOut = (amount * BigInt(10_000 - slippageBps)) / 10_000n;
  return minOut > 0n ? minOut : 1n;
}

export function shortenAddress(addr: string, head = 6, tail = 5): string {
  if (!addr || addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

export function syToAsset(pyIndex: bigint, syAmount: bigint): bigint {
  if (pyIndex <= 0n) throw new Error("Invalid PyIndex rate");
  if (syAmount === 0n) return 0n;
  return (syAmount * pyIndex) / SCALAR_9;
}

export function assetToSy(pyIndex: bigint, assetAmount: bigint): bigint {
  if (pyIndex <= 0n) throw new Error("Invalid PyIndex rate");
  if (assetAmount === 0n) return 0n;
  return (assetAmount * SCALAR_9) / pyIndex;
}

export function assetToSyCeil(pyIndex: bigint, assetAmount: bigint): bigint {
  if (pyIndex <= 0n) throw new Error("Invalid PyIndex rate");
  if (assetAmount === 0n) return 0n;
  return (assetAmount * SCALAR_9 + (pyIndex - 1n)) / pyIndex;
}

export interface BadDebtClampContext {
  availableForPtSy: bigint;
  ptTotalSupply: bigint;
}

function calculateProRataShare(amount: bigint, available: bigint, totalSupply: bigint): bigint {
  if (totalSupply <= 0n) throw new Error("Division by zero");
  if (available <= 0n || amount <= 0n) return 0n;
  if (amount >= totalSupply) return available;
  return (amount * available) / totalSupply;
}

export function quoteSwapLocal(
  state: MarketStateRaw,
  direction: SwapDirection,
  amountIn: bigint,
  nowSeconds: bigint,
  slippageBps = 50,
  pyIndex: bigint = SCALAR_9,
  badDebtContext?: BadDebtClampContext
): SwapQuote {
  const tauWad = calculateTauWad(nowSeconds, state.maturity);
  if (tauWad <= 0n) throw new Error("Market already matured");
  if (pyIndex < 0n) throw new Error("Invalid PyIndex rate");
  const safePyIndex = pyIndex === 0n ? SCALAR_9 : pyIndex;
  const feeRate = calculateFeeRate(tauWad, state.annual_fee_rate);
  const ptRes = state.total_pt_reserve;
  const syRes = state.total_sy_reserve;
  const assetRes = syToAsset(safePyIndex, syRes);

  let estimatedOut = 0n;
  let feeAmount = 0n;
  let newPt = ptRes;
  let newSy = syRes;
  let tradeRateWad = WAD;

  if (direction === "pt_for_sy") {
    newPt = ptRes + amountIn;
    tradeRateWad = getExchangeRateWad(newPt, assetRes, tauWad, state.scalar_root, state.initial_anchor);
    const grossAsset = wadDiv(amountIn, tradeRateWad);
    const feeAsset = wadMul(grossAsset, feeRate);
    const netAssetOut = grossAsset - feeAsset;
    estimatedOut = assetToSy(safePyIndex, netAssetOut);
    if (estimatedOut <= 0n) throw new Error("Output amount too small after PyIndex scaling");
    feeAmount = assetToSy(safePyIndex, feeAsset);
    if (estimatedOut >= syRes) throw new Error("Exceeds SY pool reserve");
    const protoFee = (feeAmount * state.protocol_fee_bps) / 10_000n;
    newSy = syRes - estimatedOut - protoFee;
    const finalAssetRes = syToAsset(safePyIndex, newSy);
    checkMarketProportion(newPt, finalAssetRes);
    if (newPt < assetRes - netAssetOut || newPt < finalAssetRes) {
      throw new Error("Negative implied yield not supported");
    }
  } else if (direction === "sy_for_pt") {
    const assetIn = syToAsset(safePyIndex, amountIn);
    if (assetIn <= 0n) throw new Error("Amount too small after PyIndex scaling");
    const newAssetRes = assetRes + assetIn;
    tradeRateWad = getExchangeRateWad(ptRes, newAssetRes, tauWad, state.scalar_root, state.initial_anchor);
    const grossPt = wadMul(assetIn, tradeRateWad);
    feeAmount = wadMul(grossPt, feeRate);
    estimatedOut = grossPt - feeAmount;
    if (estimatedOut <= 0n) throw new Error("Output amount too small after PyIndex scaling");
    if (estimatedOut >= ptRes) throw new Error("Exceeds PT pool reserve");
    const protoFee = (feeAmount * state.protocol_fee_bps) / 10_000n;
    newPt = ptRes - estimatedOut - protoFee;
    newSy = syRes + amountIn;
    const finalAssetRes = syToAsset(safePyIndex, newSy);
    checkMarketProportion(newPt, finalAssetRes);
    if (newPt < finalAssetRes) {
      throw new Error("Negative implied yield not supported");
    }
  } else if (direction === "sy_for_yt") {
    const assetIn = syToAsset(safePyIndex, amountIn);
    if (assetIn <= 0n) throw new Error("Amount too small after PyIndex scaling");
    const e0 = getExchangeRateWad(ptRes, assetRes, tauWad, state.scalar_root, state.initial_anchor);
    if (e0 <= WAD) throw new Error("Implied yield too low for YT flash buy");
    const unitYield0 = WAD - wadDiv(WAD, e0);
    const unitCost0 = unitYield0 + wadMul(unitYield0, feeRate);
    if (unitCost0 <= 0n) throw new Error("Zero YT unit cost");

    const n0 = wadDiv(assetIn, unitCost0);
    const maxNSy = syToAsset(safePyIndex, syRes + amountIn);
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
      try {
        const eMid = getExchangeRateWad(
          ptRes + mid,
          assetRes - grossEst,
          tauWad,
          state.scalar_root,
          state.initial_anchor
        );
        const unitYield = WAD - wadDiv(WAD, eMid);
        const unitCost = unitYield + wadMul(unitYield, feeRate);
        const cost = wadMul(mid, unitCost);
        if (cost <= assetIn) {
          lo = mid;
          bestE = eMid;
        } else {
          hi = mid - 1n;
        }
      } catch {
        hi = mid - 1n;
      }
    }

    const n = lo;
    if (n <= 0n) throw new Error("Exceeds SY pool liquidity");
    tradeRateWad = bestE;
    const grossAssetSold = wadDiv(n, bestE);
    const yieldCost = n - grossAssetSold;
    const feeAsset = wadMul(yieldCost, feeRate);
    feeAmount = assetToSy(safePyIndex, feeAsset);
    const protoFeeSy = (feeAmount * state.protocol_fee_bps) / 10_000n;
    const pyBackingSy = assetToSyCeil(safePyIndex, n);
    estimatedOut = n;
    newPt = ptRes + n;
    newSy = syRes + amountIn - protoFeeSy - pyBackingSy;
    if (newSy <= 0n) throw new Error("Exceeds SY pool liquidity");
    const finalAssetRes = syToAsset(safePyIndex, newSy);
    checkMarketProportion(newPt, finalAssetRes);
    if (newPt < finalAssetRes) {
      throw new Error("Negative implied yield not supported");
    }
  } else {
    if (ptRes < amountIn) throw new Error("Exceeds PT pool reserve for flash unwind");
    newPt = ptRes - amountIn;
    const e0 = getExchangeRateWad(newPt, assetRes, tauWad, state.scalar_root, state.initial_anchor);
    const estAsset1 = assetRes + wadDiv(amountIn, e0);
    const e1 = getExchangeRateWad(newPt, estAsset1, tauWad, state.scalar_root, state.initial_anchor);
    const estAsset2 = assetRes + wadDiv(amountIn, e1);
    tradeRateWad = getExchangeRateWad(newPt, estAsset2, tauWad, state.scalar_root, state.initial_anchor);
    const grossAssetBuy = wadDivCeil(amountIn, tradeRateWad);
    if (amountIn <= grossAssetBuy) throw new Error("Negative implied yield on YT sell");
    const grossYield = amountIn - grossAssetBuy;
    const feeAsset = wadMul(grossYield, feeRate);
    const netAssetOut = grossYield - feeAsset;
    estimatedOut = assetToSy(safePyIndex, netAssetOut);
    if (estimatedOut <= 0n) throw new Error("Output amount too small after PyIndex scaling");
    feeAmount = assetToSy(safePyIndex, feeAsset);
    const protoFeeSy = (feeAmount * state.protocol_fee_bps) / 10_000n;
    const fullFreedSy = assetToSy(safePyIndex, amountIn);
    const freedPtSy = badDebtContext
      ? (() => {
          const proRata = calculateProRataShare(
            amountIn,
            badDebtContext.availableForPtSy,
            badDebtContext.ptTotalSupply
          );
          return fullFreedSy < proRata ? fullFreedSy : proRata;
        })()
      : fullFreedSy;
    if (freedPtSy < estimatedOut + protoFeeSy) {
      throw new Error("Insufficient PT backing for YT unwind");
    }
    newSy = syRes + freedPtSy - estimatedOut - protoFeeSy;
    const finalAssetRes = syToAsset(safePyIndex, newSy);
    checkMarketProportion(newPt, finalAssetRes);
    if (newPt < finalAssetRes) {
      throw new Error("Negative implied yield not supported");
    }
  }

  const rateAfter = getExchangeRateWad(
    newPt,
    syToAsset(safePyIndex, newSy),
    tauWad,
    state.scalar_root,
    state.initial_anchor
  );

  return {
    direction,
    amountIn,
    estimatedOut,
    minOutWithSlippage: applySlippage(estimatedOut, slippageBps),
    feeAmount,
    effectiveExchangeRate: Number(tradeRateWad) / 1e18,
    impliedApyAfterPct: calculateImpliedApyPct(rateAfter, tauWad),
  };
}

export interface ZapInLpEstimate {
  ok: boolean;
  estLpOut: bigint;
  minLpOut: bigint;
  syForSwap: bigint;
  isEmptyBootstrap: boolean;
  isOversizedError?: boolean;
  reason?: string;
}

function bigIntSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

export function estimateZapInLp(
  state: MarketStateRaw,
  syAmount: bigint,
  nowSeconds: bigint,
  slippageBps = 50,
  pyIndex: bigint = SCALAR_9
): ZapInLpEstimate {
  if (syAmount <= 0n) {
    return {
      ok: false,
      estLpOut: 0n,
      minLpOut: 0n,
      syForSwap: 0n,
      isEmptyBootstrap: false,
      reason: "Amount must be strictly greater than zero",
    };
  }
  const tauWad = calculateTauWad(nowSeconds, state.maturity);
  if (tauWad <= 0n) {
    return {
      ok: false,
      estLpOut: 0n,
      minLpOut: 0n,
      syForSwap: 0n,
      isEmptyBootstrap: false,
      reason: "Market already matured",
    };
  }

  if (pyIndex < 0n) {
    return {
      ok: false,
      estLpOut: 0n,
      minLpOut: 0n,
      syForSwap: 0n,
      isEmptyBootstrap: false,
      reason: "Invalid PyIndex rate",
    };
  }
  const safePyIndex = pyIndex === 0n ? SCALAR_9 : pyIndex;
  const ptRes = state.total_pt_reserve;
  const syRes = state.total_sy_reserve;
  const totalLp = state.total_lp_supply;

  if (totalLp === 0n && ptRes === 0n && syRes === 0n) {
    const syForLp = syAmount / 2n;
    const syForPy = syAmount - syForLp;
    const ptMinted = syToAsset(safePyIndex, syForPy);
    const rawLp = bigIntSqrt(ptMinted * syForLp);
    const estLpOut = rawLp > 1000n ? rawLp - 1000n : 0n;
    return {
      ok: estLpOut > 0n,
      estLpOut,
      minLpOut: estLpOut > 0n ? applySlippage(estLpOut, slippageBps) : 1n,
      syForSwap: 0n,
      isEmptyBootstrap: true,
      reason: estLpOut > 0n ? undefined : "Initial LP liquidity too small",
    };
  }

  if (totalLp <= 0n || ptRes <= 0n || syRes <= 0n) {
    return {
      ok: false,
      estLpOut: 0n,
      minLpOut: 0n,
      syForSwap: 0n,
      isEmptyBootstrap: false,
      reason: "Pool reserves are inconsistent for single-tx LP zap",
    };
  }

  const assetRes = syToAsset(safePyIndex, syRes);
  let e0: bigint;
  try {
    e0 = getExchangeRateWad(ptRes, assetRes, tauWad, state.scalar_root, state.initial_anchor);
  } catch (err) {
    return {
      ok: false,
      estLpOut: 0n,
      minLpOut: 0n,
      syForSwap: 0n,
      isEmptyBootstrap: false,
      reason: err instanceof Error ? err.message : "Invalid AMM pool state",
    };
  }

  const assetSumCeil = ((syRes + syAmount) * safePyIndex + (SCALAR_9 - 1n)) / SCALAR_9;
  const kSySumCeil = (assetSumCeil * e0 + (WAD - 1n)) / WAD;
  const denom = ptRes + kSySumCeil;
  const xMax = denom > 0n ? (syAmount * ptRes) / denom : 0n;
  const margin = xMax >= 2n ? (xMax / 200n > 1n ? xMax / 200n : 1n) : 0n;
  const syForSwap = xMax > margin ? xMax - margin : 0n;

  if (syForSwap <= 0n || syForSwap >= syAmount) {
    return {
      ok: false,
      estLpOut: 0n,
      minLpOut: 0n,
      syForSwap: 0n,
      isEmptyBootstrap: false,
      reason: "Zap amount too small to split for LP swap",
    };
  }

  try {
    const swapQuote = quoteSwapLocal(state, "sy_for_pt", syForSwap, nowSeconds, slippageBps, safePyIndex);
    const feeRate = calculateFeeRate(tauWad, state.annual_fee_rate);
    const assetIn = syToAsset(safePyIndex, syForSwap);
    const tradeRate = getExchangeRateWad(ptRes, assetRes + assetIn, tauWad, state.scalar_root, state.initial_anchor);
    const grossPt = wadMul(assetIn, tradeRate);
    const fee = wadMul(grossPt, feeRate);
    const protoFee = (fee * state.protocol_fee_bps) / 10_000n;
    const ptBought = swapQuote.estimatedOut;
    const ptResPost = ptRes - ptBought - protoFee;
    const syResPost = syRes + syForSwap;

    if (ptResPost <= 0n || syResPost <= 0n) {
      return {
        ok: false,
        estLpOut: 0n,
        minLpOut: 0n,
        syForSwap,
        isEmptyBootstrap: false,
        isOversizedError: true,
        reason: "LP zap exceeds safe pool liquidity bounds",
      };
    }

    const syRem = syAmount - syForSwap;
    const syNeeded = (ptBought * syResPost + (ptResPost - 1n)) / ptResPost;
    const ptToAdd = syNeeded <= syRem ? ptBought : (syRem * ptResPost) / syResPost;
    const syToAdd = syNeeded <= syRem ? syNeeded : syRem;

    const lpFromPt = (ptToAdd * totalLp) / ptResPost;
    const lpFromSy = (syToAdd * totalLp) / syResPost;
    const estLpOut = lpFromPt < lpFromSy ? lpFromPt : lpFromSy;

    return {
      ok: estLpOut > 0n,
      estLpOut,
      minLpOut: estLpOut > 0n ? applySlippage(estLpOut, slippageBps) : 1n,
      syForSwap,
      isEmptyBootstrap: false,
      reason: estLpOut > 0n ? undefined : "Zap amount produces zero LP shares",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "LP zap exceeds pool AMM bounds";
    const isOversized =
      msg.includes("Negative implied yield") ||
      msg.includes("4%-96%") ||
      msg.includes("Exceeds PT pool reserve");
    return {
      ok: false,
      estLpOut: 0n,
      minLpOut: 0n,
      syForSwap,
      isEmptyBootstrap: false,
      isOversizedError: isOversized,
      reason: isOversized
        ? "LP zap exceeds pool AMM depth (would push implied yield negative). Reduce amount or supply dual-sided liquidity."
        : msg,
    };
  }
}
