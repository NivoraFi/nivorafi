import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  NotFoundError,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  WAD,
  SCALAR_9,
  calculateImpliedApyPct,
  calculateTauWad,
  exchangeRateWadToNumber,
  formatUnits,
  getExchangeRate,
  quoteSwap,
} from "./math.js";
import type {
  DeploymentManifest,
  MarketSnapshot,
  MarketStateOnChain,
  PreparedTransactionResult,
  SwapDirection,
  SwapQuoteResult,
  UserPortfolio,
  UserYieldStateOnChain,
} from "./types.js";

// Valid public synthetic read-only source account for simulation queries without user auth
const READ_ONLY_DUMMY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function asBigInt(val: unknown): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number") return BigInt(Math.trunc(val));
  if (typeof val === "string") return BigInt(val);
  throw new Error(`Cannot convert ${String(val)} to bigint`);
}

function serializeSimulated(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return JSON.stringify(val, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

export class StellarPendleAgentClient {
  public readonly manifest: DeploymentManifest;
  public readonly rpcServer: rpc.Server;
  public readonly horizonServer: Horizon.Server;
  public readonly networkPassphrase: string;

  constructor(manifest: DeploymentManifest) {
    this.manifest = manifest;
    this.rpcServer = new rpc.Server(manifest.rpcUrl);
    this.horizonServer = new Horizon.Server(manifest.horizonUrl);
    this.networkPassphrase = manifest.networkPassphrase;
  }

  private async simulateRead<T = unknown>(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
    sourceAddress = this.manifest.deployer || READ_ONLY_DUMMY_SOURCE
  ): Promise<T> {
    const account = new Account(sourceAddress, "0");
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.rpcServer.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const errMsg = "error" in sim ? String(sim.error) : "Simulation failed";
      throw new Error(`Soroban read ${contractId}.${method} failed: ${errMsg}`);
    }
    if (!sim.result?.retval) {
      return undefined as T;
    }
    return scValToNative(sim.result.retval) as T;
  }

  private async buildPreparedTx(
    sourceAddress: string,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    operationLabel: string
  ): Promise<PreparedTransactionResult> {
    if (!sourceAddress.startsWith("G")) {
      throw new Error(`Invalid Stellar account address: ${sourceAddress}`);
    }
    const account = await this.rpcServer.getAccount(sourceAddress);
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(180)
      .build();

    const sim = await this.rpcServer.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const errMsg = "error" in sim ? String(sim.error) : "Unknown Soroban simulation error";
      throw new Error(`Simulation failed for ${method}: ${errMsg}`);
    }

    const prepared = rpc.assembleTransaction(tx, sim).build();
    const retval = sim.result?.retval ? scValToNative(sim.result.retval) : null;

    return {
      operation: operationLabel,
      contractId,
      method,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.manifest.rpcUrl,
      unsignedXdr: prepared.toXDR(),
      simulatedReturnValue: serializeSimulated(retval),
      minResourceFeeStroops: sim.minResourceFee ?? "0",
      sourceAccount: sourceAddress,
    };
  }

  async getRawMarketState(): Promise<MarketStateOnChain> {
    const raw = await this.simulateRead<Record<string, unknown>>(
      this.manifest.contracts.yield_pool.contractId,
      "get_market_state"
    );
    return {
      total_pt_reserve: asBigInt(raw.total_pt_reserve),
      total_sy_reserve: asBigInt(raw.total_sy_reserve),
      total_lp_supply: asBigInt(raw.total_lp_supply),
      scalar_root: asBigInt(raw.scalar_root),
      initial_anchor: asBigInt(raw.initial_anchor),
      annual_fee_rate: asBigInt(raw.annual_fee_rate),
      protocol_fee_bps: asBigInt(raw.protocol_fee_bps),
      fee_recipient: String(raw.fee_recipient),
      maturity: asBigInt(raw.maturity),
      maturity_index: asBigInt(raw.maturity_index),
      is_settled: Boolean(raw.is_settled),
    };
  }

  async getMarketSnapshot(): Promise<MarketSnapshot> {
    const { yield_pool, sy_blend_wrapper, pt_token, yt_token } = this.manifest.contracts;

    const [state, blendRateRaw, ammRateRaw, ptSupplyRaw, ytSupplyRaw, sySupplyRaw, latestLedger] =
      await Promise.all([
        this.getRawMarketState(),
        this.simulateRead<unknown>(sy_blend_wrapper.contractId, "exchange_rate"),
        this.simulateRead<unknown>(yield_pool.contractId, "get_exchange_rate"),
        this.simulateRead<unknown>(pt_token.contractId, "total_supply"),
        this.simulateRead<unknown>(yt_token.contractId, "total_supply"),
        this.simulateRead<unknown>(sy_blend_wrapper.contractId, "total_supply"),
        this.rpcServer.getLatestLedger(),
      ]);

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const ammRateWad = asBigInt(ammRateRaw);
    const tauWad = calculateTauWad(nowSec, state.maturity);
    const eFloat = exchangeRateWadToNumber(ammRateWad);
    const ptPriceInSy = eFloat > 0 ? 1 / eFloat : 1;
    const ytPriceInSy = Math.max(0, 1 - ptPriceInSy);
    const ptResNum = Number(state.total_pt_reserve);
    const syResNum = Number(state.total_sy_reserve);
    const ptProportion = ptResNum + syResNum > 0 ? ptResNum / (ptResNum + syResNum) : 0.5;
    const remainingSec = state.maturity > nowSec ? Number(state.maturity - nowSec) : 0;

    void latestLedger; // queried to ensure RPC connectivity / freshness

    return {
      contractId: yield_pool.contractId,
      network: this.manifest.network,
      nowSeconds: Number(nowSec),
      maturitySeconds: Number(state.maturity),
      daysToMaturity: Number((remainingSec / 86400).toFixed(2)),
      isMatured: nowSec >= state.maturity,
      isSettled: state.is_settled,
      ptReserve: state.total_pt_reserve.toString(),
      syReserve: state.total_sy_reserve.toString(),
      totalLpSupply: state.total_lp_supply.toString(),
      ptProportion,
      blendExchangeRate: asBigInt(blendRateRaw).toString(),
      ammExchangeRateWad: ammRateWad.toString(),
      ptPriceInSy,
      ytPriceInSy,
      impliedFixedApyPct: Number(calculateImpliedApyPct(ammRateWad, tauWad).toFixed(4)),
      ptTotalSupply: asBigInt(ptSupplyRaw).toString(),
      ytTotalSupply: asBigInt(ytSupplyRaw).toString(),
      syTotalSupply: asBigInt(sySupplyRaw).toString(),
    };
  }

  async getUserPortfolio(userAddress: string): Promise<UserPortfolio> {
    const { sy_blend_wrapper, pt_token, yt_token, yield_pool } = this.manifest.contracts;
    const addrArg = Address.fromString(userAddress).toScVal();

    let xlmBalance = "0";
    let usdcBalance = "0";
    let usdcTrustlineExists = false;

    try {
      const account = await this.horizonServer.loadAccount(userAddress);
      const native = account.balances.find((b) => b.asset_type === "native");
      if (native) xlmBalance = native.balance;

      const usdc = account.balances.find(
        (b) =>
          b.asset_type !== "native" &&
          "asset_code" in b &&
          b.asset_code === this.manifest.market.underlyingAsset.code &&
          b.asset_issuer === this.manifest.market.underlyingAsset.issuer
      );
      if (usdc) {
        usdcBalance = usdc.balance;
        usdcTrustlineExists = true;
      }
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
    }

    const [syBalRaw, ptBalRaw, ytBalRaw, lpBalRaw, yieldStateRaw, bRateRaw] = await Promise.all([
      this.simulateRead<unknown>(sy_blend_wrapper.contractId, "balance", [addrArg]),
      this.simulateRead<unknown>(pt_token.contractId, "balance", [addrArg]),
      this.simulateRead<unknown>(yt_token.contractId, "balance", [addrArg]),
      this.simulateRead<unknown>(yield_pool.contractId, "balance", [addrArg]),
      this.simulateRead<Record<string, unknown>>(yt_token.contractId, "get_user_yield_state", [
        addrArg,
      ]),
      this.simulateRead<unknown>(sy_blend_wrapper.contractId, "exchange_rate"),
    ]);

    const yieldState: UserYieldStateOnChain = {
      yt_balance: asBigInt(yieldStateRaw?.yt_balance ?? 0),
      last_index: asBigInt(yieldStateRaw?.last_index ?? 0),
      unclaimed_yield: asBigInt(yieldStateRaw?.unclaimed_yield ?? 0),
    };
    const bRate = asBigInt(bRateRaw);
    let pendingRaw = yieldState.unclaimed_yield;
    if (yieldState.last_index > 0n && bRate > yieldState.last_index && yieldState.yt_balance > 0n) {
      pendingRaw += (yieldState.yt_balance * (bRate - yieldState.last_index)) / yieldState.last_index;
    }
    const pendingSy = bRate > 0n ? (pendingRaw * SCALAR_9) / bRate : 0n;

    return {
      address: userAddress,
      xlmBalance,
      usdcBalance,
      usdcTrustlineExists,
      syBalance: asBigInt(syBalRaw).toString(),
      ptBalance: asBigInt(ptBalRaw).toString(),
      ytBalance: asBigInt(ytBalRaw).toString(),
      lpBalance: asBigInt(lpBalRaw).toString(),
      lastIndex: yieldState.last_index.toString(),
      unclaimedYieldRaw: yieldState.unclaimed_yield.toString(),
      estimatedPendingYieldSy: pendingSy.toString(),
    };
  }

  async quoteAction(
    direction: SwapDirection,
    amountInStroops: bigint,
    slippageBps = 50
  ): Promise<SwapQuoteResult> {
    const state = await this.getRawMarketState();
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return quoteSwap(state, direction, amountInStroops, nowSec, slippageBps);
  }

  buildDepositSyTx(sourceAddress: string, amountStroops: bigint, receiver = sourceAddress) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.sy_blend_wrapper.contractId,
      "deposit",
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(amountStroops, { type: "i128" }),
      ],
      "deposit_sy"
    );
  }

  buildRedeemSyTx(sourceAddress: string, sharesStroops: bigint, receiver = sourceAddress) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.sy_blend_wrapper.contractId,
      "redeem",
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(sharesStroops, { type: "i128" }),
      ],
      "redeem_sy"
    );
  }

  buildMintPyTx(sourceAddress: string, syAmountStroops: bigint, receiver = sourceAddress) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.yield_pool.contractId,
      "mint_py",
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(syAmountStroops, { type: "i128" }),
      ],
      "mint_py"
    );
  }

  buildRedeemPyTx(sourceAddress: string, pyAmountStroops: bigint, receiver = sourceAddress) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.yield_pool.contractId,
      "redeem_py",
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(pyAmountStroops, { type: "i128" }),
      ],
      "redeem_py"
    );
  }

  buildSwapTx(
    sourceAddress: string,
    direction: SwapDirection,
    amountInStroops: bigint,
    minOutStroops: bigint,
    receiver = sourceAddress
  ) {
    const methodMap: Record<SwapDirection, string> = {
      pt_for_sy: "swap_exact_pt_for_sy",
      sy_for_pt: "swap_exact_sy_for_pt",
      sy_for_yt: "swap_exact_sy_for_yt",
      yt_for_sy: "swap_exact_yt_for_sy",
    };
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.yield_pool.contractId,
      methodMap[direction],
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(amountInStroops, { type: "i128" }),
        nativeToScVal(minOutStroops, { type: "i128" }),
      ],
      direction
    );
  }

  buildAddLiquidityTx(
    sourceAddress: string,
    ptAmountStroops: bigint,
    syAmountStroops: bigint,
    minLpOutStroops = 1n,
    receiver = sourceAddress
  ) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.yield_pool.contractId,
      "add_liquidity",
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(ptAmountStroops, { type: "i128" }),
        nativeToScVal(syAmountStroops, { type: "i128" }),
        nativeToScVal(minLpOutStroops, { type: "i128" }),
      ],
      "add_liquidity"
    );
  }

  buildRemoveLiquidityTx(
    sourceAddress: string,
    lpAmountStroops: bigint,
    minPtOutStroops = 1n,
    minSyOutStroops = 1n,
    receiver = sourceAddress
  ) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.yield_pool.contractId,
      "remove_liquidity",
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(lpAmountStroops, { type: "i128" }),
        nativeToScVal(minPtOutStroops, { type: "i128" }),
        nativeToScVal(minSyOutStroops, { type: "i128" }),
      ],
      "remove_liquidity"
    );
  }

  buildClaimYieldTx(sourceAddress: string, receiver = sourceAddress) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.yield_pool.contractId,
      "claim_yield",
      [Address.fromString(sourceAddress).toScVal(), Address.fromString(receiver).toScVal()],
      "claim_yield"
    );
  }

  buildRedeemPtPostMaturityTx(
    sourceAddress: string,
    ptAmountStroops: bigint,
    receiver = sourceAddress
  ) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.yield_pool.contractId,
      "redeem_pt_post_maturity",
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(ptAmountStroops, { type: "i128" }),
      ],
      "redeem_pt_post_maturity"
    );
  }

  buildRedeemPtToBtokenTx(
    sourceAddress: string,
    ptAmountStroops: bigint,
    receiver = sourceAddress
  ) {
    return this.buildPreparedTx(
      sourceAddress,
      this.manifest.contracts.yield_pool.contractId,
      "redeem_pt_to_btoken",
      [
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(receiver).toScVal(),
        nativeToScVal(ptAmountStroops, { type: "i128" }),
      ],
      "redeem_pt_to_btoken"
    );
  }

  /**
   * Signs an unsigned XDR using an ephemeral in-memory Keypair and polls Stellar RPC
   * until confirmed. Useful for autonomous agent bots and automated scripts.
   */
  async signAndSubmitWithKeypair(unsignedXdr: string, signer: Keypair) {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase) as Transaction;
    tx.sign(signer);
    const sendRes = await this.rpcServer.sendTransaction(tx);
    if (sendRes.status === "ERROR") {
      throw new Error(`Send transaction rejected: ${String(sendRes.errorResult)}`);
    }
    const pollRes = await this.rpcServer.pollTransaction(sendRes.hash, {
      attempts: 12,
    });
    return {
      hash: sendRes.hash,
      status: pollRes.status,
      explorerUrl: `https://stellar.expert/explorer/${this.manifest.network}/tx/${sendRes.hash}`,
    };
  }
}

export * from "./math.js";
export * from "./types.js";
export * from "./contracts.js";
