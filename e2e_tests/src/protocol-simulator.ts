// e2e_tests/src/protocol-simulator.ts
// Opaque-box specification-accurate protocol simulator for Stellar Pendle on Soroban

import {
  WAD,
  HALF_WAD,
  SECONDS_PER_YEAR,
  MIN_MARKET_PROPORTION,
  MAX_MARKET_PROPORTION,
  MIN_FEE_RATE,
  MAX_FEE_RATE,
  wadMul,
  wadDiv,
  lnWad,
  expWad,
  getExchangeRate,
  calculateBumpTo,
  calculateBumpThreshold,
  calculateHaircut,
  DEFAULT_BUMP_TO,
  MAX_NETWORK_TTL,
  MIN_BUMP_THRESHOLD,
  MathError
} from "./math-oracle.ts";

export const B_RATE_SCALE = 1_000_000_000n; // 10^9 scaling for Blend reserve index
export const DEAD_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export enum ContractError {
  Unauthorized = "ContractError::Unauthorized",
  ZeroAmount = "ContractError::ZeroAmount",
  InsufficientBalance = "ContractError::InsufficientBalance",
  InsufficientAllowance = "ContractError::InsufficientAllowance",
  MarketAlreadyMatured = "ContractError::MarketAlreadyMatured",
  MarketNotYetMatured = "ContractError::MarketNotYetMatured",
  SlippageExceeded = "ContractError::SlippageExceeded",
  ProportionOutOfBounds = "ContractError::ProportionOutOfBounds",
  NegativeYieldNotSupported = "ContractError::NegativeYieldNotSupported",
  ReentrancyLocked = "ContractError::ReentrancyLocked",
  BlendPoolError = "ContractError::BlendPoolError",
  InsufficientPoolLiquidity = "BlendError::InsufficientPoolLiquidity",
  DivisionByZero = "MathError::DivisionByZero"
}

// -----------------------------------------------------------------------------
// 1. Mock Blend Pool & bToken Accounting
// -----------------------------------------------------------------------------
export class MockBlendPool {
  public admin: string;
  public assetAddress: string;
  public bRate: bigint; // Scaled by 10^9 (1_000_000_000n = 1.0)
  public poolCash: bigint; // Underlyings physically in Blend pool
  public totalCollateralSupplied: bigint;
  public utilization: number; // 0.0 to 1.0

  public underlyingBalances: Map<string, bigint> = new Map();
  public bTokenBalances: Map<string, bigint> = new Map();

  constructor(admin: string, assetAddress: string, initialRate: bigint = B_RATE_SCALE) {
    this.admin = admin;
    this.assetAddress = assetAddress;
    this.bRate = initialRate;
    this.poolCash = 10_000_000n * WAD;
    this.totalCollateralSupplied = 10_000_000n * WAD;
    this.utilization = 0.0;
  }

  public getBRate(): bigint {
    return this.bRate;
  }

  public setBRate(newRate: bigint) {
    if (newRate <= 0n) throw new Error(ContractError.BlendPoolError);
    this.bRate = newRate;
  }

  public setPoolCash(cash: bigint) {
    this.poolCash = cash;
  }

  public setUtilization(util: number) {
    this.utilization = util;
    if (util >= 1.0) {
      this.poolCash = 0n;
    }
  }

  public supplyCollateral(caller: string, receiver: string, amount: bigint): bigint {
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);
    const callerBal = this.underlyingBalances.get(caller) ?? 0n;
    if (callerBal < amount) throw new Error(ContractError.InsufficientBalance);

    this.underlyingBalances.set(caller, callerBal - amount);
    this.poolCash += amount;
    this.totalCollateralSupplied += amount;

    // Mint bTokens = (amount * B_RATE_SCALE) / bRate
    const bTokensToMint = (amount * B_RATE_SCALE) / this.bRate;
    const receiverBTokens = this.bTokenBalances.get(receiver) ?? 0n;
    this.bTokenBalances.set(receiver, receiverBTokens + bTokensToMint);
    return bTokensToMint;
  }

  public withdrawCollateral(caller: string, receiver: string, bTokensToBurn: bigint): bigint {
    if (bTokensToBurn <= 0n) throw new Error(ContractError.ZeroAmount);
    const callerBTokens = this.bTokenBalances.get(caller) ?? 0n;
    if (callerBTokens < bTokensToBurn) throw new Error(ContractError.InsufficientBalance);

    // Underlying = (bTokensToBurn * bRate) / B_RATE_SCALE
    const underlyingOut = (bTokensToBurn * this.bRate) / B_RATE_SCALE;
    if (this.poolCash < underlyingOut) {
      throw new Error(ContractError.InsufficientPoolLiquidity);
    }

    this.bTokenBalances.set(caller, callerBTokens - bTokensToBurn);
    this.poolCash -= underlyingOut;
    this.totalCollateralSupplied -= underlyingOut;

    const receiverUnderlying = this.underlyingBalances.get(receiver) ?? 0n;
    this.underlyingBalances.set(receiver, receiverUnderlying + underlyingOut);
    return underlyingOut;
  }
}

// -----------------------------------------------------------------------------
// 2. Standardized Yield (SY) Wrapper
// -----------------------------------------------------------------------------
export class SYBlendWrapper {
  public admin: string;
  public underlyingAsset: string;
  public blendPool: MockBlendPool;
  public totalShares: bigint = 0n;
  public balances: Map<string, bigint> = new Map();
  public allowances: Map<string, Map<string, bigint>> = new Map();

  constructor(admin: string, underlyingAsset: string, blendPool: MockBlendPool) {
    this.admin = admin;
    this.underlyingAsset = underlyingAsset;
    this.blendPool = blendPool;
  }

  public balanceOf(user: string): bigint {
    return this.balances.get(user) ?? 0n;
  }

  public allowance(owner: string, spender: string): bigint {
    return this.allowances.get(owner)?.get(spender) ?? 0n;
  }

  public approve(owner: string, spender: string, amount: bigint) {
    if (!this.allowances.has(owner)) {
      this.allowances.set(owner, new Map());
    }
    this.allowances.get(owner)!.set(spender, amount);
  }

  public deposit(caller: string, receiver: string, amount: bigint): bigint {
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);
    // Supply to Blend pool on behalf of this wrapper
    const bTokensMinted = this.blendPool.supplyCollateral(caller, "SY_WRAPPER_VAULT", amount);
    // In SY, 1 SY share = 1 bToken equivalent or underlying equivalent scaled
    const sharesMinted = amount;
    this.totalShares += sharesMinted;
    this.balances.set(receiver, (this.balances.get(receiver) ?? 0n) + sharesMinted);
    return sharesMinted;
  }

  public redeem(caller: string, receiver: string, shares: bigint): bigint {
    if (shares <= 0n) throw new Error(ContractError.ZeroAmount);
    const callerBal = this.balanceOf(caller);
    if (callerBal < shares) throw new Error(ContractError.InsufficientBalance);

    this.balances.set(caller, callerBal - shares);
    this.totalShares -= shares;

    const bTokensToBurn = (shares * B_RATE_SCALE) / this.blendPool.getBRate();
    const underlyingReturned = this.blendPool.withdrawCollateral("SY_WRAPPER_VAULT", receiver, bTokensToBurn);
    return underlyingReturned;
  }

  public exchange_rate(): bigint {
    return this.blendPool.getBRate();
  }

  public asset(): string {
    return this.underlyingAsset;
  }

  public blend_pool(): string {
    return "MOCK_BLEND_POOL_CONTRACT";
  }

  public transfer(from: string, to: string, amount: bigint): boolean {
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);
    const fromBal = this.balanceOf(from);
    if (fromBal < amount) throw new Error(ContractError.InsufficientBalance);
    this.balances.set(from, fromBal - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
    return true;
  }
}

// -----------------------------------------------------------------------------
// 3. SEP-41 Tokens: PT & YT with Checkpointing
// -----------------------------------------------------------------------------
export class SEP41Token {
  public name: string;
  public symbol: string;
  public decimals: number = 7;
  public maturity: bigint;
  public marketAddress: string;
  public totalSupply: bigint = 0n;
  public balances: Map<string, bigint> = new Map();
  public allowances: Map<string, Map<string, bigint>> = new Map();

  constructor(name: string, symbol: string, maturity: bigint, marketAddress: string) {
    this.name = name;
    this.symbol = symbol;
    this.maturity = maturity;
    this.marketAddress = marketAddress;
  }

  public balanceOf(user: string): bigint {
    return this.balances.get(user) ?? 0n;
  }

  public allowance(owner: string, spender: string): bigint {
    return this.allowances.get(owner)?.get(spender) ?? 0n;
  }

  public approve(owner: string, spender: string, amount: bigint) {
    if (!this.allowances.has(owner)) {
      this.allowances.set(owner, new Map());
    }
    this.allowances.get(owner)!.set(spender, amount);
  }

  public transfer(from: string, to: string, amount: bigint): boolean {
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);
    const fromBal = this.balanceOf(from);
    if (fromBal < amount) throw new Error(ContractError.InsufficientBalance);
    this.balances.set(from, fromBal - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
    return true;
  }

  public mint(caller: string, to: string, amount: bigint) {
    if (caller !== this.marketAddress) throw new Error(ContractError.Unauthorized);
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);
    this.totalSupply += amount;
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
  }

  public burn(caller: string, from: string, amount: bigint) {
    if (caller !== this.marketAddress) throw new Error(ContractError.Unauthorized);
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);
    const fromBal = this.balanceOf(from);
    if (fromBal < amount) throw new Error(ContractError.InsufficientBalance);
    this.balances.set(from, fromBal - amount);
    this.totalSupply -= amount;
  }
}

export interface UserYieldState {
  ytBalance: bigint;
  lastIndex: bigint;
  unclaimedYield: bigint;
}

export class YTTokenWithCheckpointing extends SEP41Token {
  public yieldMarket!: YieldMarket;
  public userStates: Map<string, UserYieldState> = new Map();

  public beforeBalanceChange(user: string, newBalance: bigint, rawCurrentIndex: bigint, currentTimestamp: bigint) {
    const maturity = this.maturity;
    const isSettled = this.yieldMarket.isSettled;
    
    let effectiveIndex: bigint;
    if (isSettled) {
      effectiveIndex = this.yieldMarket.maturityIndex ?? rawCurrentIndex;
    } else if (currentTimestamp >= maturity) {
      this.yieldMarket.maturityIndex = rawCurrentIndex;
      this.yieldMarket.isSettled = true;
      effectiveIndex = rawCurrentIndex;
    } else {
      effectiveIndex = rawCurrentIndex;
    }

    let state = this.userStates.get(user);
    if (!state) {
      state = { ytBalance: 0n, lastIndex: effectiveIndex, unclaimedYield: 0n };
    }

    if (state.ytBalance > 0n && effectiveIndex > state.lastIndex && state.lastIndex > 0n) {
      const deltaIndex = effectiveIndex - state.lastIndex;
      const accrued = (state.ytBalance * deltaIndex) / state.lastIndex;
      state.unclaimedYield += accrued;
    }

    state.ytBalance = newBalance;
    state.lastIndex = effectiveIndex;
    this.userStates.set(user, state);
  }

  public override mint(caller: string, to: string, amount: bigint) {
    if (caller !== this.marketAddress) throw new Error(ContractError.Unauthorized);
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);

    const oldBal = this.balanceOf(to);
    const newBal = oldBal + amount;
    const rawIndex = this.yieldMarket.syWrapper.exchange_rate();
    this.beforeBalanceChange(to, newBal, rawIndex, this.yieldMarket.currentTimestamp);

    this.totalSupply += amount;
    this.balances.set(to, newBal);
  }

  public override burn(caller: string, from: string, amount: bigint) {
    if (caller !== this.marketAddress) throw new Error(ContractError.Unauthorized);
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);
    const fromBal = this.balanceOf(from);
    if (fromBal < amount) throw new Error(ContractError.InsufficientBalance);

    const newBal = fromBal - amount;
    const rawIndex = this.yieldMarket.syWrapper.exchange_rate();
    this.beforeBalanceChange(from, newBal, rawIndex, this.yieldMarket.currentTimestamp);

    this.balances.set(from, newBal);
    this.totalSupply -= amount;
  }

  public override transfer(from: string, to: string, amount: bigint): boolean {
    if (amount <= 0n) throw new Error(ContractError.ZeroAmount);
    const fromBal = this.balanceOf(from);
    if (fromBal < amount) throw new Error(ContractError.InsufficientBalance);

    const rawIndex = this.yieldMarket.syWrapper.exchange_rate();
    this.beforeBalanceChange(from, fromBal - amount, rawIndex, this.yieldMarket.currentTimestamp);
    this.beforeBalanceChange(to, this.balanceOf(to) + amount, rawIndex, this.yieldMarket.currentTimestamp);

    this.balances.set(from, fromBal - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
    return true;
  }
}

// -----------------------------------------------------------------------------
// 4. Yield Market & Yield AMM Core Router
// -----------------------------------------------------------------------------
export class YieldMarket {
  public admin: string;
  public syWrapper: SYBlendWrapper;
  public ptToken: SEP41Token;
  public ytToken: YTTokenWithCheckpointing;
  public maturity: bigint;
  public scalarRoot: bigint;
  public rateAnchor: bigint;
  public feeRecipient: string;

  public currentTimestamp: bigint;
  public isSettled: boolean = false;
  public maturityIndex: bigint | null = null;

  // AMM Reserves
  public totalPt: bigint = 0n;
  public totalSy: bigint = 0n;
  public totalLp: bigint = 0n;
  public lpBalances: Map<string, bigint> = new Map();

  // Storage and TTL
  public instanceTtl: number = DEFAULT_BUMP_TO;
  public temporaryStorage: Map<string, any> = new Map();

  constructor(
    admin: string,
    syWrapper: SYBlendWrapper,
    maturity: bigint,
    scalarRoot: bigint = 20n * WAD,
    rateAnchor: bigint = (105n * WAD) / 100n, // 1.05 WAD (5% fixed-rate anchor)
    startTimestamp: bigint = 1_000_000_000n
  ) {
    this.admin = admin;
    this.syWrapper = syWrapper;
    this.maturity = maturity;
    this.scalarRoot = scalarRoot;
    this.rateAnchor = rateAnchor;
    this.feeRecipient = "PROTOCOL_TREASURY_RECIPIENT";
    this.currentTimestamp = startTimestamp;

    this.ptToken = new SEP41Token("Principal Token USDC", "PT-USDC", maturity, "YIELD_MARKET_CONTRACT");
    this.ytToken = new YTTokenWithCheckpointing("Yield Token USDC", "YT-USDC", maturity, "YIELD_MARKET_CONTRACT");
    this.ytToken.yieldMarket = this;
  }

  // ---------------------------------------------------------------------------
  // TTL & Storage Management
  // ---------------------------------------------------------------------------
  public bumpInstanceTtl() {
    this.instanceTtl = calculateBumpTo(this.currentTimestamp, this.maturity);
  }

  // ---------------------------------------------------------------------------
  // Reentrancy Teardown Guard
  // ---------------------------------------------------------------------------
  public withNonReentrant<T>(fn: () => T): T {
    const guardKey = "FlashLoanGuard";
    if (this.temporaryStorage.has(guardKey)) {
      throw new Error(ContractError.ReentrancyLocked);
    }
    this.temporaryStorage.set(guardKey, true);
    try {
      return fn();
    } finally {
      this.temporaryStorage.delete(guardKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Core Entrypoints: Mint PY & Early Unwind
  // ---------------------------------------------------------------------------
  public mint_py(caller: string, receiver: string, amount: bigint): [bigint, bigint] {
    return this.withNonReentrant(() => {
      if (this.currentTimestamp >= this.maturity) {
        throw new Error(ContractError.MarketAlreadyMatured);
      }
      if (amount <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }

      // Transfer SY tokens from caller into market vault
      this.syWrapper.transfer(caller, "YIELD_MARKET_VAULT", amount);

      // Mint 1 PT and 1 YT to receiver
      this.ptToken.mint("YIELD_MARKET_CONTRACT", receiver, amount);
      this.ytToken.mint("YIELD_MARKET_CONTRACT", receiver, amount);

      this.bumpInstanceTtl();
      return [amount, amount];
    });
  }

  public redeem_py(caller: string, receiver: string, amount: bigint): bigint {
    return this.withNonReentrant(() => {
      if (this.currentTimestamp >= this.maturity) {
        throw new Error(ContractError.MarketAlreadyMatured);
      }
      if (amount <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }
      if (this.ptToken.balanceOf(caller) < amount || this.ytToken.balanceOf(caller) < amount) {
        throw new Error(ContractError.InsufficientBalance);
      }

      // Burn PT and YT simultaneously
      this.ptToken.burn("YIELD_MARKET_CONTRACT", caller, amount);
      this.ytToken.burn("YIELD_MARKET_CONTRACT", caller, amount);

      // Release SY from vault to receiver
      this.syWrapper.transfer("YIELD_MARKET_VAULT", receiver, amount);

      this.bumpInstanceTtl();
      return amount;
    });
  }

  // ---------------------------------------------------------------------------
  // Maturity Redemption & Haircut Protection
  // ---------------------------------------------------------------------------
  public redeem_pt_post_maturity(caller: string, receiver: string, ptAmount: bigint): bigint {
    return this.withNonReentrant(() => {
      if (this.currentTimestamp < this.maturity) {
        throw new Error(ContractError.MarketNotYetMatured);
      }
      if (ptAmount <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }
      if (this.ptToken.balanceOf(caller) < ptAmount) {
        throw new Error(ContractError.InsufficientBalance);
      }

      // Check solvency haircut H = min(1.0, vaultBalance / totalPtSupply)
      const vaultBalance = this.syWrapper.balanceOf("YIELD_MARKET_VAULT");
      const totalPtSupply = this.ptToken.totalSupply;
      const haircut = calculateHaircut(vaultBalance, totalPtSupply);

      const netUnderlyingOut = wadMul(ptAmount, haircut);

      this.ptToken.burn("YIELD_MARKET_CONTRACT", caller, ptAmount);
      this.syWrapper.transfer("YIELD_MARKET_VAULT", receiver, netUnderlyingOut);

      this.bumpInstanceTtl();
      return netUnderlyingOut;
    });
  }

  public redeem_pt_to_btoken(caller: string, receiver: string, ptAmount: bigint): bigint {
    return this.withNonReentrant(() => {
      if (this.currentTimestamp < this.maturity) {
        throw new Error(ContractError.MarketNotYetMatured);
      }
      if (ptAmount <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }
      if (this.ptToken.balanceOf(caller) < ptAmount) {
        throw new Error(ContractError.InsufficientBalance);
      }

      // Calculate bTokens corresponding to ptAmount
      const bRate = this.syWrapper.exchange_rate();
      const bTokensOut = (ptAmount * B_RATE_SCALE) / bRate;

      this.ptToken.burn("YIELD_MARKET_CONTRACT", caller, ptAmount);
      const callerBTokens = this.syWrapper.blendPool.bTokenBalances.get("SY_WRAPPER_VAULT") ?? 0n;
      if (callerBTokens < bTokensOut) {
        throw new Error(ContractError.InsufficientBalance);
      }
      this.syWrapper.blendPool.bTokenBalances.set("SY_WRAPPER_VAULT", callerBTokens - bTokensOut);
      const recBTokens = this.syWrapper.blendPool.bTokenBalances.get(receiver) ?? 0n;
      this.syWrapper.blendPool.bTokenBalances.set(receiver, recBTokens + bTokensOut);

      this.bumpInstanceTtl();
      return bTokensOut;
    });
  }

  // ---------------------------------------------------------------------------
  // Variable Yield Claiming
  // ---------------------------------------------------------------------------
  public claim_yield(user: string, receiver: string): bigint {
    return this.withNonReentrant(() => {
      const rawIndex = this.syWrapper.exchange_rate();
      this.ytToken.beforeBalanceChange(user, this.ytToken.balanceOf(user), rawIndex, this.currentTimestamp);

      const state = this.ytToken.userStates.get(user);
      if (!state || state.unclaimedYield <= 0n) {
        return 0n;
      }

      const yieldAmount = state.unclaimedYield;
      state.unclaimedYield = 0n;
      this.ytToken.userStates.set(user, state);

      // Transfer accrued yield to receiver
      this.syWrapper.transfer("YIELD_MARKET_VAULT", receiver, yieldAmount);

      this.bumpInstanceTtl();
      return yieldAmount;
    });
  }

  public settle_maturity(): [bigint, boolean] {
    if (this.currentTimestamp < this.maturity) {
      throw new Error(ContractError.MarketNotYetMatured);
    }
    if (this.isSettled) {
      return [this.maturityIndex!, false]; // Idempotent return without mutation
    }
    const currentRate = this.syWrapper.exchange_rate();
    this.maturityIndex = currentRate;
    this.isSettled = true;
    this.bumpInstanceTtl();
    return [currentRate, true];
  }

  // ---------------------------------------------------------------------------
  // Log-Normal AMM: Liquidity Provisioning & Swaps
  // ---------------------------------------------------------------------------
  public get_exchange_rate(): bigint {
    const timeToMaturity = this.maturity > this.currentTimestamp ? this.maturity - this.currentTimestamp : 0n;
    const tauWad = wadDiv(timeToMaturity * WAD, SECONDS_PER_YEAR * WAD);
    return getExchangeRate(this.totalPt, this.totalSy, tauWad, this.scalarRoot, this.rateAnchor);
  }

  public add_liquidity(caller: string, receiver: string, ptAmount: bigint, syAmount: bigint, minLpOut: bigint): bigint {
    return this.withNonReentrant(() => {
      if (ptAmount <= 0n || syAmount <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }
      if (this.ptToken.balanceOf(caller) < ptAmount || this.syWrapper.balanceOf(caller) < syAmount) {
        throw new Error(ContractError.InsufficientBalance);
      }

      // Check proportion ratio p = pt / (pt + sy)
      const totalDeposit = ptAmount + syAmount;
      const proportion = wadDiv(ptAmount, totalDeposit);
      if (proportion < MIN_MARKET_PROPORTION || proportion > MAX_MARKET_PROPORTION) {
        throw new Error(ContractError.ProportionOutOfBounds);
      }

      let lpSharesMinted: bigint;
      if (this.totalLp === 0n) {
        // Initial liquidity: burn 1000 dead shares to zero address
        const rawShares = this.sqrtBigInt(ptAmount * syAmount);
        const deadShares = 1000n;
        if (rawShares <= deadShares) {
          throw new Error(ContractError.ZeroAmount);
        }
        lpSharesMinted = rawShares - deadShares;
        this.lpBalances.set(DEAD_ADDRESS, deadShares);
        this.totalLp = rawShares;
      } else {
        const sharePt = (ptAmount * this.totalLp) / this.totalPt;
        const shareSy = (syAmount * this.totalLp) / this.totalSy;
        lpSharesMinted = sharePt < shareSy ? sharePt : shareSy;
        this.totalLp += lpSharesMinted;
      }

      if (lpSharesMinted < minLpOut) {
        throw new Error(ContractError.SlippageExceeded);
      }

      this.ptToken.transfer(caller, "AMM_POOL", ptAmount);
      this.syWrapper.transfer(caller, "AMM_POOL", syAmount);
      this.totalPt += ptAmount;
      this.totalSy += syAmount;

      this.lpBalances.set(receiver, (this.lpBalances.get(receiver) ?? 0n) + lpSharesMinted);
      this.bumpInstanceTtl();
      return lpSharesMinted;
    });
  }

  public remove_liquidity(caller: string, receiver: string, lpAmount: bigint, minPtOut: bigint, minSyOut: bigint): [bigint, bigint] {
    return this.withNonReentrant(() => {
      if (lpAmount <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }
      const callerLp = this.lpBalances.get(caller) ?? 0n;
      if (callerLp < lpAmount) {
        throw new Error(ContractError.InsufficientBalance);
      }

      const ptOut = (lpAmount * this.totalPt) / this.totalLp;
      const syOut = (lpAmount * this.totalSy) / this.totalLp;

      if (ptOut < minPtOut || syOut < minSyOut) {
        throw new Error(ContractError.SlippageExceeded);
      }

      this.lpBalances.set(caller, callerLp - lpAmount);
      this.totalLp -= lpAmount;
      this.totalPt -= ptOut;
      this.totalSy -= syOut;

      this.ptToken.transfer("AMM_POOL", receiver, ptOut);
      this.syWrapper.transfer("AMM_POOL", receiver, syOut);

      this.bumpInstanceTtl();
      return [ptOut, syOut];
    });
  }

  public swap_exact_pt_for_sy(caller: string, receiver: string, exactPtIn: bigint, minSyOut: bigint): [bigint, bigint] {
    return this.withNonReentrant(() => {
      if (this.currentTimestamp >= this.maturity) {
        throw new Error(ContractError.MarketAlreadyMatured);
      }
      if (exactPtIn <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }
      if (this.ptToken.balanceOf(caller) < exactPtIn) {
        throw new Error(ContractError.InsufficientBalance);
      }

      // Check proportion after swap
      const newPt = this.totalPt + exactPtIn;
      const timeToMaturity = this.maturity - this.currentTimestamp;
      const tauWad = wadDiv(timeToMaturity * WAD, SECONDS_PER_YEAR * WAD);
      const eTrade = getExchangeRate(newPt, this.totalSy, tauWad, this.scalarRoot, this.rateAnchor);

      const grossSyOut = wadDiv(exactPtIn, eTrade);
      const fee = (grossSyOut * 3n) / 1000n; // 30 bps swap fee
      const netSyOut = grossSyOut - fee;

      if (netSyOut < minSyOut) {
        throw new Error(ContractError.SlippageExceeded);
      }
      if (netSyOut >= this.totalSy) {
        throw new Error(ContractError.InsufficientBalance);
      }

      const newSy = this.totalSy - netSyOut;
      const newProportion = wadDiv(newPt, newPt + newSy);
      if (newProportion < MIN_MARKET_PROPORTION || newProportion > MAX_MARKET_PROPORTION) {
        throw new Error(ContractError.ProportionOutOfBounds);
      }

      this.ptToken.transfer(caller, "AMM_POOL", exactPtIn);
      this.syWrapper.transfer("AMM_POOL", receiver, netSyOut);
      this.syWrapper.transfer("AMM_POOL", this.feeRecipient, fee);

      this.totalPt = newPt;
      this.totalSy = newSy - fee;

      this.bumpInstanceTtl();
      return [netSyOut, fee];
    });
  }

  public swap_exact_sy_for_pt(caller: string, receiver: string, exactSyIn: bigint, minPtOut: bigint): [bigint, bigint] {
    return this.withNonReentrant(() => {
      if (this.currentTimestamp >= this.maturity) {
        throw new Error(ContractError.MarketAlreadyMatured);
      }
      if (exactSyIn <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }
      if (this.syWrapper.balanceOf(caller) < exactSyIn) {
        throw new Error(ContractError.InsufficientBalance);
      }

      const newSy = this.totalSy + exactSyIn;
      const timeToMaturity = this.maturity - this.currentTimestamp;
      const tauWad = wadDiv(timeToMaturity * WAD, SECONDS_PER_YEAR * WAD);
      const eTrade = getExchangeRate(this.totalPt, newSy, tauWad, this.scalarRoot, this.rateAnchor);

      const grossPtOut = wadMul(exactSyIn, eTrade);
      const fee = (grossPtOut * 3n) / 1000n;
      const netPtOut = grossPtOut - fee;

      if (netPtOut < minPtOut) {
        throw new Error(ContractError.SlippageExceeded);
      }
      if (netPtOut >= this.totalPt) {
        throw new Error(ContractError.InsufficientBalance);
      }

      const newPt = this.totalPt - netPtOut;
      const newProportion = wadDiv(newPt, newPt + newSy);
      if (newProportion < MIN_MARKET_PROPORTION || newProportion > MAX_MARKET_PROPORTION) {
        throw new Error(ContractError.ProportionOutOfBounds);
      }

      this.syWrapper.transfer(caller, "AMM_POOL", exactSyIn);
      this.ptToken.transfer("AMM_POOL", receiver, netPtOut);

      this.totalPt = newPt;
      this.totalSy = newSy;

      this.bumpInstanceTtl();
      return [netPtOut, fee];
    });
  }

  // Single-Pool Flash Swaps for YT
  public swap_exact_sy_for_yt(caller: string, receiver: string, exactSyIn: bigint, minYtOut: bigint): [bigint, bigint] {
    return this.withNonReentrant(() => {
      if (this.currentTimestamp >= this.maturity) {
        throw new Error(ContractError.MarketAlreadyMatured);
      }
      if (exactSyIn <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }

      // In single pool flash swap buying YT:
      // Flash mint N PT + N YT
      // Sell N PT to AMM for Delta y_pool
      // Trader supplies Delta y_net = N - Delta y_pool = exactSyIn
      // For simulation, let's solve N = exactSyIn / (1 - 1/E)
      const e = this.get_exchange_rate();
      const pYt = wadDiv(e - WAD, e);
      if (pYt <= 0n) throw new Error(ContractError.NegativeYieldNotSupported);
      const ytAmount = wadDiv(exactSyIn, pYt);

      if (ytAmount < minYtOut) {
        throw new Error(ContractError.SlippageExceeded);
      }

      // Collect exactSyIn from caller into AMM pool reserves
      this.syWrapper.transfer(caller, "AMM_POOL", exactSyIn);
      this.totalSy += exactSyIn;
      // Mint ytAmount to receiver
      this.ytToken.mint("YIELD_MARKET_CONTRACT", receiver, ytAmount);

      this.bumpInstanceTtl();
      return [ytAmount, exactSyIn];
    });
  }

  public swap_exact_yt_for_sy(caller: string, receiver: string, exactYtIn: bigint, minSyOut: bigint): [bigint, bigint] {
    return this.withNonReentrant(() => {
      if (this.currentTimestamp >= this.maturity) {
        throw new Error(ContractError.MarketAlreadyMatured);
      }
      if (exactYtIn <= 0n) {
        throw new Error(ContractError.ZeroAmount);
      }
      if (this.ytToken.balanceOf(caller) < exactYtIn) {
        throw new Error(ContractError.InsufficientBalance);
      }

      const e = this.get_exchange_rate();
      const pYt = wadDiv(e - WAD, e);
      if (pYt <= 0n) throw new Error(ContractError.NegativeYieldNotSupported);
      const grossSyOut = wadMul(exactYtIn, pYt);
      const fee = (grossSyOut * 3n) / 1000n;
      const netSyOut = grossSyOut - fee;

      if (netSyOut < minSyOut) {
        throw new Error(ContractError.SlippageExceeded);
      }
      if (netSyOut >= this.totalSy) {
        throw new Error(ContractError.InsufficientBalance);
      }

      // Burn YT from caller
      this.ytToken.burn("YIELD_MARKET_CONTRACT", caller, exactYtIn);
      // Transfer SY out from AMM pool reserves to receiver
      this.syWrapper.transfer("AMM_POOL", receiver, netSyOut);
      this.syWrapper.transfer("AMM_POOL", this.feeRecipient, fee);
      this.totalSy -= (netSyOut + fee);

      this.bumpInstanceTtl();
      return [netSyOut, fee];
    });
  }

  private sqrtBigInt(value: bigint): bigint {
    if (value < 0n) throw new Error("negative sqrt");
    if (value < 2n) return value;
    let x0 = value / 2n;
    let x1 = (x0 + value / x0) / 2n;
    while (x1 < x0) {
      x0 = x1;
      x1 = (x0 + value / x0) / 2n;
    }
    return x0;
  }
}
