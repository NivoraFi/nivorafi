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

export function quoteSwapLocal(
  state: MarketStateRaw,
  direction: SwapDirection,
  amountIn: bigint,
  nowSeconds: bigint,
  slippageBps = 50
): SwapQuote {
  const tauWad = calculateTauWad(nowSeconds, state.maturity);
  if (tauWad <= 0n) throw new Error("Market already matured");
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
    tradeRateWad = getExchangeRateWad(newPt, syRes, tauWad, state.scalar_root, state.initial_anchor);
    const grossSy = wadDiv(amountIn, tradeRateWad);
    feeAmount = wadMul(grossSy, feeRate);
    estimatedOut = grossSy - feeAmount;
    if (estimatedOut >= syRes) throw new Error("Exceeds SY pool reserve");
    const protoFee = (feeAmount * state.protocol_fee_bps) / 10_000n;
    newSy = syRes - estimatedOut - protoFee;
    checkMarketProportion(newPt, newSy);
  } else if (direction === "sy_for_pt") {
    newSy = syRes + amountIn;
    tradeRateWad = getExchangeRateWad(ptRes, newSy, tauWad, state.scalar_root, state.initial_anchor);
    const grossPt = wadMul(amountIn, tradeRateWad);
    feeAmount = wadMul(grossPt, feeRate);
    estimatedOut = grossPt - feeAmount;
    if (estimatedOut >= ptRes) throw new Error("Exceeds PT pool reserve");
    newPt = ptRes - estimatedOut;
    checkMarketProportion(newPt, newSy);
  } else if (direction === "sy_for_yt") {
    const e0 = getExchangeRateWad(ptRes, syRes, tauWad, state.scalar_root, state.initial_anchor);
    if (e0 <= WAD) throw new Error("Implied yield too low for YT flash buy");
    const unitYield0 = WAD - wadDiv(WAD, e0);
    const unitCost0 = unitYield0 + wadMul(unitYield0, feeRate);
    if (unitCost0 <= 0n) throw new Error("Zero YT unit cost");
    let n = wadDiv(amountIn, unitCost0);
    const e1 = getExchangeRateWad(ptRes + n, syRes, tauWad, state.scalar_root, state.initial_anchor);
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
    if (newSy <= 0n) throw new Error("Exceeds SY pool liquidity");
    checkMarketProportion(newPt, newSy);
  } else {
    if (ptRes < amountIn) throw new Error("Exceeds PT pool reserve for flash unwind");
    newPt = ptRes - amountIn;
    tradeRateWad = getExchangeRateWad(newPt, syRes, tauWad, state.scalar_root, state.initial_anchor);
    const grossSyBuy = wadDiv(amountIn, tradeRateWad);
    if (amountIn <= grossSyBuy) throw new Error("Negative implied yield on YT sell");
    const grossYield = amountIn - grossSyBuy;
    feeAmount = wadMul(grossYield, feeRate);
    estimatedOut = grossYield - feeAmount;
    newSy = syRes + grossSyBuy;
    checkMarketProportion(newPt, newSy);
  }

  const rateAfter = getExchangeRateWad(newPt, newSy, tauWad, state.scalar_root, state.initial_anchor);

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
