import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  NotFoundError,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { STELLAR_PENDLE_CONFIG } from "./contracts";
import { getBlendFallbackRate } from "./blend";
import { MarketDefinition } from "./markets";
import {
  MarketStateRaw,
  SCALAR_9,
  calculateImpliedApyPct,
  calculateTauWad,
  decodeSorobanError,
} from "./math";

export interface LiveMarketSnapshot {
  state: MarketStateRaw;
  latestLedger: number;
  nowSeconds: number;
  daysToMaturity: number;
  isMatured: boolean;
  blendExchangeRate: bigint;
  pyIndex?: bigint;
  ammExchangeRateWad: bigint;
  ptPriceInSy: number;
  ytPriceInSy: number;
  impliedFixedApyPct: number;
  ptTotalSupply: bigint;
  ytTotalSupply: bigint;
  syTotalSupply: bigint;
  ptProportionPct: number;
}

export interface LiveUserPortfolio {
  address: string;
  accountExists: boolean;
  xlmBalance: string;
  usdcBalance: string;
  usdcTrustlineExists: boolean;
  syBalance: bigint;
  ptBalance: bigint;
  ytBalance: bigint;
  lpBalance: bigint;
  lastIndex: bigint;
  unclaimedYieldRaw: bigint;
  estimatedPendingYieldSy: bigint;
}

export type WireStage = "SIMULATE" | "SIGN" | "SUBMIT" | "CONFIRMING" | "CONFIRMED" | "ERROR" | "FAUCET";

export interface WireLogEntry {
  id: string;
  timestamp: string;
  stage: WireStage;
  method: string;
  contractId: string;
  message: string;
  minResourceFee?: string;
  ledger?: number;
  unsignedXdr?: string;
  txHash?: string;
  simulatedReturn?: string | null;
}

export interface PreparedContractTx {
  label: string;
  contractId: string;
  method: string;
  unsignedXdr: string;
  minResourceFeeStroops: string;
  latestLedger: number;
  stateChangeCount: number;
  simulatedReturn: string | null;
}

const READ_DUMMY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

let cachedRpc: rpc.Server | null = null;
let cachedHorizon: Horizon.Server | null = null;

const inFlightConfirmations = new Map<string, Promise<unknown>>();

export function getRpcServer(): rpc.Server {
  if (!cachedRpc) {
    cachedRpc = new rpc.Server(STELLAR_PENDLE_CONFIG.rpcUrl);
  }
  return cachedRpc;
}

export function getHorizonServer(): Horizon.Server {
  if (!cachedHorizon) {
    cachedHorizon = new Horizon.Server(STELLAR_PENDLE_CONFIG.horizonUrl);
  }
  return cachedHorizon;
}

function asBigInt(val: unknown): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number") return BigInt(Math.trunc(val));
  if (typeof val === "string") return BigInt(val);
  return 0n;
}

function stringifySimulated(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return JSON.stringify(val, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

function composeSignals(a?: AbortSignal | null, b?: AbortSignal | null): AbortSignal | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([a, b]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
  } else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

function makeAbortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

const NATIVE_BOOTSTRAP_FETCH: typeof fetch | null =
  typeof globalThis.fetch === "function" && globalThis.fetch.name !== "bound fetch"
    ? globalThis.fetch
    : (globalThis as unknown as { Bun?: { fetch?: typeof fetch } }).Bun?.fetch ?? null;

function callWithAbortSignal<T>(signal: AbortSignal | undefined, invoke: () => Promise<T>): Promise<T> {
  if (!signal) return invoke();
  if (signal.aborted) {
    return Promise.reject(makeAbortError());
  }
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== "function") {
    return invoke();
  }
  const isUnstubbedHappyDomFetch =
    typeof (globalThis as { happyDOM?: unknown }).happyDOM !== "undefined" &&
    origFetch.name === "bound fetch" &&
    NATIVE_BOOTSTRAP_FETCH !== null;
  const targetFetch = isUnstubbedHappyDomFetch ? NATIVE_BOOTSTRAP_FETCH! : origFetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const mergedSignal = composeSignals(signal, init?.signal);
    return targetFetch(input, { ...init, signal: mergedSignal });
  }) as typeof fetch;
  try {
    return invoke();
  } finally {
    globalThis.fetch = origFetch;
  }
}

async function simulateRead<T = unknown>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  sourceAddress = STELLAR_PENDLE_CONFIG.deployer,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw makeAbortError();
  }
  const rpcServer = getRpcServer();
  const account = new Account(sourceAddress || READ_DUMMY_SOURCE, "0");
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_PENDLE_CONFIG.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await callWithAbortSignal(signal, () => rpcServer.simulateTransaction(tx));
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const errText = "error" in sim ? String(sim.error) : "Soroban simulation failed";
    throw new Error(decodeSorobanError(errText));
  }
  if (!sim.result?.retval) {
    return undefined as T;
  }
  return scValToNative(sim.result.retval) as T;
}

export async function fetchMarketSnapshot(
  targetMarket?: MarketDefinition,
  options?: { signal?: AbortSignal }
): Promise<LiveMarketSnapshot> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw makeAbortError();
  }
  const poolId = targetMarket?.contracts.poolId ?? STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId;
  const syId = targetMarket?.contracts.syId ?? STELLAR_PENDLE_CONFIG.contracts.sy_blend_wrapper.contractId;
  const ptId = targetMarket?.contracts.ptId ?? STELLAR_PENDLE_CONFIG.contracts.pt_token.contractId;
  const ytId = targetMarket?.contracts.ytId ?? STELLAR_PENDLE_CONFIG.contracts.yt_token.contractId;
  const rpcServer = getRpcServer();

  const [rawState, blendRateRaw, ammRateRaw, ptSupplyRaw, ytSupplyRaw, sySupplyRaw, pyIndexRaw, ledger] =
    await Promise.all([
      simulateRead<Record<string, unknown>>(poolId, "get_market_state", [], undefined, signal),
      simulateRead<unknown>(syId, "exchange_rate", [], undefined, signal).catch((err) => {
        if (signal?.aborted) throw err;
        return getBlendFallbackRate(targetMarket?.asset.code);
      }),
      simulateRead<unknown>(poolId, "get_exchange_rate", [], undefined, signal).catch(() => 0n),
      simulateRead<unknown>(ptId, "total_supply", [], undefined, signal).catch(() => 0n),
      simulateRead<unknown>(ytId, "total_supply", [], undefined, signal).catch(() => 0n),
      simulateRead<unknown>(syId, "total_supply", [], undefined, signal).catch(() => 0n),
      simulateRead<unknown>(ytId, "get_py_index", [], undefined, signal).catch(() => 0n),
      callWithAbortSignal(signal, () => rpcServer.getLatestLedger()),
    ]);

  const state: MarketStateRaw = {
    total_pt_reserve: asBigInt(rawState.total_pt_reserve),
    total_sy_reserve: asBigInt(rawState.total_sy_reserve),
    total_lp_supply: asBigInt(rawState.total_lp_supply),
    scalar_root: asBigInt(rawState.scalar_root),
    initial_anchor: asBigInt(rawState.initial_anchor),
    annual_fee_rate: asBigInt(rawState.annual_fee_rate),
    protocol_fee_bps: asBigInt(rawState.protocol_fee_bps),
    fee_recipient: String(rawState.fee_recipient ?? STELLAR_PENDLE_CONFIG.deployer),
    maturity: asBigInt(rawState.maturity),
    maturity_index: asBigInt(rawState.maturity_index),
    is_settled: Boolean(rawState.is_settled),
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const nowBig = BigInt(nowSeconds);
  const ammRateWad = asBigInt(ammRateRaw);
  const tauWad = calculateTauWad(nowBig, state.maturity);
  const eFloat = Number(ammRateWad) / 1e18;
  const ptPriceInSy = eFloat > 0 ? 1 / eFloat : 0;
  const ytPriceInSy = eFloat > 0 ? Math.max(0, 1 - ptPriceInSy) : 0;
  const remainingSec = state.maturity > nowBig ? Number(state.maturity - nowBig) : 0;

  const totalPool = Number(state.total_pt_reserve + state.total_sy_reserve);
  const ptProportionPct =
    totalPool > 0 ? (Number(state.total_pt_reserve) / totalPool) * 100 : 50;

  const blendRateBig = asBigInt(blendRateRaw);
  const safeBlendExchangeRate =
    blendRateBig > 0n
      ? blendRateBig
      : getBlendFallbackRate(targetMarket?.asset.code);

  const rawPyIndex = asBigInt(pyIndexRaw);
  const pyIndex =
    rawPyIndex > 0n
      ? rawPyIndex
      : safeBlendExchangeRate > SCALAR_9
      ? safeBlendExchangeRate
      : SCALAR_9;

  return {
    state,
    latestLedger: ledger.sequence,
    nowSeconds,
    daysToMaturity: Math.max(0, remainingSec / 86400),
    isMatured: nowBig >= state.maturity,
    blendExchangeRate: safeBlendExchangeRate,
    pyIndex,
    ammExchangeRateWad: ammRateWad,
    ptPriceInSy,
    ytPriceInSy,
    impliedFixedApyPct: ammRateWad > 0n ? calculateImpliedApyPct(ammRateWad, tauWad) : 0,
    ptTotalSupply: asBigInt(ptSupplyRaw),
    ytTotalSupply: asBigInt(ytSupplyRaw),
    syTotalSupply: asBigInt(sySupplyRaw),
    ptProportionPct,
  };
}

export async function fetchUserPortfolio(
  address: string,
  targetMarket?: MarketDefinition,
  options?: { signal?: AbortSignal }
): Promise<LiveUserPortfolio> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw makeAbortError();
  }
  const poolId = targetMarket?.contracts.poolId ?? STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId;
  const syId = targetMarket?.contracts.syId ?? STELLAR_PENDLE_CONFIG.contracts.sy_blend_wrapper.contractId;
  const ptId = targetMarket?.contracts.ptId ?? STELLAR_PENDLE_CONFIG.contracts.pt_token.contractId;
  const ytId = targetMarket?.contracts.ytId ?? STELLAR_PENDLE_CONFIG.contracts.yt_token.contractId;
  const horizon = getHorizonServer();
  const addrScVal = Address.fromString(address).toScVal();

  let accountExists = false;
  let xlmBalance = "0";
  let usdcBalance = "0";
  let usdcTrustlineExists = false;

  const assetCode = targetMarket?.asset.code ?? STELLAR_PENDLE_CONFIG.market.underlyingAsset.code;
  const assetIssuer = targetMarket?.asset.issuer ?? STELLAR_PENDLE_CONFIG.market.underlyingAsset.issuer;

  const loadHorizonAccount = async () => {
    try {
      const acct = await callWithAbortSignal(signal, () => horizon.loadAccount(address));
      accountExists = true;
      const xlm = acct.balances.find((b) => b.asset_type === "native");
      if (xlm) xlmBalance = xlm.balance;

      if (assetCode === "XLM") {
        usdcBalance = xlmBalance;
        usdcTrustlineExists = true;
      } else {
        const foundToken = acct.balances.find(
          (b) =>
            b.asset_type !== "native" &&
            "asset_code" in b &&
            b.asset_code === assetCode &&
            (!assetIssuer || b.asset_issuer === assetIssuer)
        );
        if (foundToken) {
          usdcBalance = foundToken.balance;
          usdcTrustlineExists = true;
        }
      }
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
    }
  };

  const [, syBal, ptBal, ytBal, lpBal, yieldStateRaw, bRateRaw, pyIndexRaw] = await Promise.all([
    loadHorizonAccount(),
    simulateRead<unknown>(syId, "balance", [addrScVal], undefined, signal).catch(() => 0n),
    simulateRead<unknown>(ptId, "balance", [addrScVal], undefined, signal).catch(() => 0n),
    simulateRead<unknown>(ytId, "balance", [addrScVal], undefined, signal).catch(() => 0n),
    simulateRead<unknown>(poolId, "balance", [addrScVal], undefined, signal).catch(() => 0n),
    simulateRead<Record<string, unknown>>(ytId, "get_user_yield_state", [addrScVal], undefined, signal).catch(
      () => ({ yt_balance: 0n, last_index: 0n, unclaimed_yield: 0n })
    ),
    simulateRead<unknown>(syId, "exchange_rate", [], undefined, signal).catch(() =>
      getBlendFallbackRate(targetMarket?.asset.code)
    ),
    simulateRead<unknown>(ytId, "get_py_index", [], undefined, signal).catch(() => 0n),
  ]);

  const ytBalanceState = asBigInt(yieldStateRaw?.yt_balance ?? 0);
  const lastIndex = asBigInt(yieldStateRaw?.last_index ?? 0);
  const unclaimedYieldRaw = asBigInt(yieldStateRaw?.unclaimed_yield ?? 0);
  const bRate = asBigInt(bRateRaw);
  const pyIndex = asBigInt(pyIndexRaw);
  const effectiveAccrualIndex = pyIndex > 0n ? pyIndex : bRate;

  let accruedRaw = unclaimedYieldRaw;
  if (lastIndex > 0n && effectiveAccrualIndex > lastIndex && ytBalanceState > 0n) {
    accruedRaw += (ytBalanceState * (effectiveAccrualIndex - lastIndex)) / lastIndex;
  }
  const estimatedPendingYieldSy = bRate > 0n ? (accruedRaw * SCALAR_9) / bRate : 0n;

  return {
    address,
    accountExists,
    xlmBalance,
    usdcBalance,
    usdcTrustlineExists,
    syBalance: asBigInt(syBal),
    ptBalance: asBigInt(ptBal),
    ytBalance: asBigInt(ytBal),
    lpBalance: asBigInt(lpBal),
    lastIndex,
    unclaimedYieldRaw,
    estimatedPendingYieldSy,
  };
}

export async function prepareContractCallTx(params: {
  sourceAddress: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  label: string;
}): Promise<PreparedContractTx> {
  const pendingConfirmation = inFlightConfirmations.get(params.sourceAddress);
  if (pendingConfirmation) {
    await pendingConfirmation.catch(() => undefined);
  }

  const rpcServer = getRpcServer();
  const contract = new Contract(params.contractId);
  const op = contract.call(params.method, ...params.args);
  const simTx = new TransactionBuilder(new Account(params.sourceAddress, "0"), {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_PENDLE_CONFIG.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const [account, sim] = await Promise.all([
    rpcServer.getAccount(params.sourceAddress).catch(() => {
      throw new Error("Account is unfunded on Testnet. Click Friendbot XLM first.");
    }),
    rpcServer.simulateTransaction(simTx),
  ]);

  if (!rpc.Api.isSimulationSuccess(sim)) {
    const errText = "error" in sim ? String(sim.error) : "Soroban simulation rejected";
    throw new Error(decodeSorobanError(errText));
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_PENDLE_CONFIG.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const prepared = rpc.assembleTransaction(tx, sim).build();
  const retval = sim.result?.retval ? scValToNative(sim.result.retval) : null;

  return {
    label: params.label,
    contractId: params.contractId,
    method: params.method,
    unsignedXdr: prepared.toXDR(),
    minResourceFeeStroops: sim.minResourceFee ?? "0",
    latestLedger: sim.latestLedger,
    stateChangeCount: sim.stateChanges?.length ?? 0,
    simulatedReturn: stringifySimulated(retval),
  };
}

export async function prepareChangeTrustUsdcTx(sourceAddress: string): Promise<string> {
  const horizon = getHorizonServer();
  const account = await horizon.loadAccount(sourceAddress);
  const asset = new Asset(
    STELLAR_PENDLE_CONFIG.market.underlyingAsset.code,
    STELLAR_PENDLE_CONFIG.market.underlyingAsset.issuer
  );

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_PENDLE_CONFIG.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(180)
    .build();

  return tx.toXDR();
}

export async function prepareSwapXlmForUsdcSdexTx(
  sourceAddress: string,
  xlmSendAmount = "100",
  minUsdcDest = "1"
): Promise<string> {
  const horizon = getHorizonServer();
  const account = await horizon.loadAccount(sourceAddress);
  const usdcAsset = new Asset(
    STELLAR_PENDLE_CONFIG.market.underlyingAsset.code,
    STELLAR_PENDLE_CONFIG.market.underlyingAsset.issuer
  );

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_PENDLE_CONFIG.networkPassphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: xlmSendAmount,
        destination: sourceAddress,
        destAsset: usdcAsset,
        destMin: minUsdcDest,
        path: [],
      })
    )
    .setTimeout(180)
    .build();

  return tx.toXDR();
}

export interface SubmittedSorobanTxResult {
  hash: string;
  status: string;
  returnValue: string | null;
}

export function extractSorobanDiagnosticError(
  polled: rpc.Api.GetFailedTransactionResponse
): string {
  // 1. Try diagnostic events for ContractError or abort message
  if (polled.diagnosticEventsXdr && polled.diagnosticEventsXdr.length > 0) {
    for (let i = polled.diagnosticEventsXdr.length - 1; i >= 0; i--) {
      try {
        const diag = polled.diagnosticEventsXdr[i] as any;
        const event = typeof diag?.event === "function" ? diag.event() : diag?.event;
        const bodyObj = typeof event?.body === "function" ? event.body() : event?.body;
        const v0 = typeof bodyObj?.v0 === "function" ? bodyObj.v0() : bodyObj?.v0;
        const dataVal = typeof v0?.data === "function" ? v0.data() : v0?.data;
        let dataStr = "";
        try {
          dataStr = stringifySimulated(scValToNative(dataVal)) ?? "";
        } catch {
          dataStr = String(dataVal ?? "");
        }
        const rawTopics = typeof v0?.topics === "function" ? v0.topics() : v0?.topics;
        const topicsList = Array.isArray(rawTopics) ? rawTopics : [];
        const topics = topicsList.map((t: any) => {
          try {
            return stringifySimulated(scValToNative(t)) ?? "";
          } catch {
            return "";
          }
        });
        const combined = `${topics.join(" ")} ${dataStr}`.trim();
        const codeMatch = combined.match(/Error\(Contract,\s*#?(\d+)\)|ContractError.*?(\d+)/i);
        if (codeMatch) {
          const code = codeMatch[1] ?? codeMatch[2];
          return `Error(Contract, #${code})`;
        }
        if (combined.toLowerCase().includes("error") || combined.toLowerCase().includes("failed")) {
          return combined;
        }
      } catch {
        // continue
      }
    }
  }

  // 2. Try resultXdr inspection
  try {
    const rx = polled.resultXdr as any;
    if (rx) {
      const res = typeof rx.result === "function" ? rx.result() : rx.result;
      const sw = typeof res?.switch === "function" ? res.switch() : res?.switch;
      const code = sw?.name ?? sw;
      if (code) {
        return `Transaction result: ${String(code)}`;
      }
    }
  } catch {
    // ignore
  }

  return "Transaction failed during Soroban execution";
}

export async function submitSignedHorizonTx(signedXdr: string): Promise<{ hash: string }> {
  const horizon = getHorizonServer();
  const tx = TransactionBuilder.fromXDR(
    signedXdr,
    STELLAR_PENDLE_CONFIG.networkPassphrase
  ) as Transaction;
  try {
    const res = await horizon.submitTransaction(tx);
    return { hash: res.hash };
  } catch (err: unknown) {
    const anyErr = err as {
      response?: {
        data?: {
          detail?: string;
          extras?: {
            result_codes?: {
              transaction?: string;
              operations?: string[];
            };
          };
        };
      };
      message?: string;
    };
    const extras = anyErr?.response?.data?.extras;
    const resultCodes = extras?.result_codes;
    if (resultCodes) {
      const ops = Array.isArray(resultCodes.operations) ? resultCodes.operations.join(", ") : "";
      const txCode = resultCodes.transaction || "";
      const detail = anyErr?.response?.data?.detail;
      const parts = [
        `Horizon submission failed: ${txCode}`,
        ops ? `operation codes: [${ops}]` : null,
        detail ? `detail: ${detail}` : null,
      ]
        .filter(Boolean)
        .join(" - ");
      throw new Error(parts);
    }
    throw err;
  }
}

async function pollSorobanTransactionWithTimeout(
  rpcServer: rpc.Server,
  hash: string,
  maxAttempts = 30,
  perRequestTimeoutMs = 4000,
  pollIntervalMs = 1200
): Promise<rpc.Api.GetTransactionResponse> {
  let lastResult: rpc.Api.GetTransactionResponse | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await Promise.race([
        rpcServer.getTransaction(hash),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`RPC getTransaction timed out after ${perRequestTimeoutMs}ms`)),
            perRequestTimeoutMs
          )
        ),
      ]);
      lastResult = res;
      if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        return res;
      }
    } catch {
      // Single RPC poll timeout or transient network error; retry on next tick.
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  if (lastResult && lastResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return lastResult;
  }
  throw new Error("Transaction confirmation timed out while polling Soroban RPC");
}

export async function submitSignedSorobanTx(
  signedXdr: string,
  onSubmitted?: (txHash: string) => void
): Promise<SubmittedSorobanTxResult> {
  const rpcServer = getRpcServer();
  const tx = TransactionBuilder.fromXDR(
    signedXdr,
    STELLAR_PENDLE_CONFIG.networkPassphrase
  ) as Transaction;

  const sendRes = await rpcServer.sendTransaction(tx);
  if (sendRes.status === "ERROR") {
    throw new Error(`Soroban RPC rejected transaction: ${String(sendRes.errorResult)}`);
  }

  // Immediately notify caller with the live txHash so UI can enter CONFIRMING state
  if (onSubmitted && sendRes.hash) {
    try {
      onSubmitted(sendRes.hash);
    } catch (cbErr) {
      console.warn("onSubmitted callback threw:", cbErr);
    }
  }

  const sourceAccount = tx.source;
  const pollPromise = pollSorobanTransactionWithTimeout(rpcServer, sendRes.hash);

  const prev = inFlightConfirmations.get(sourceAccount);
  const tracked = (prev ? prev.catch(() => undefined).then(() => pollPromise) : pollPromise).finally(() => {
    if (inFlightConfirmations.get(sourceAccount) === tracked) {
      inFlightConfirmations.delete(sourceAccount);
    }
  });
  inFlightConfirmations.set(sourceAccount, tracked);

  let polled: rpc.Api.GetTransactionResponse;
  try {
    polled = await pollPromise;
  } catch (pollErr: any) {
    const explorerUrl = `${STELLAR_PENDLE_CONFIG.explorerBaseUrl}/tx/${sendRes.hash}`;
    if (pollErr && typeof pollErr === "object") {
      pollErr.txHash = sendRes.hash;
      pollErr.explorerUrl = explorerUrl;
    }
    throw pollErr;
  }

  if (polled.status === rpc.Api.GetTransactionStatus.FAILED) {
    const diagInfo = extractSorobanDiagnosticError(
      polled as rpc.Api.GetFailedTransactionResponse
    );
    const explorerUrl = `${STELLAR_PENDLE_CONFIG.explorerBaseUrl}/tx/${sendRes.hash}`;
    const err = new Error(
      `Soroban transaction failed [tx: ${sendRes.hash}]: ${diagInfo}. Explorer: ${explorerUrl}`
    ) as Error & { txHash: string; explorerUrl: string };
    err.txHash = sendRes.hash;
    err.explorerUrl = explorerUrl;
    throw err;
  }

  let returnValue: string | null = null;
  if (
    polled.status === rpc.Api.GetTransactionStatus.SUCCESS &&
    polled.returnValue
  ) {
    returnValue = stringifySimulated(scValToNative(polled.returnValue));
  }

  return {
    hash: sendRes.hash,
    status: polled.status,
    returnValue,
  };
}

export async function requestFriendbotFunding(address: string): Promise<void> {
  const res = await fetch(
    `${STELLAR_PENDLE_CONFIG.friendbotUrl}?addr=${encodeURIComponent(address)}`
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Friendbot error (${res.status}): ${body.slice(0, 120)}`);
  }
}

export type ProtocolAction =
  | { type: "deposit_sy"; caller: string; amount: bigint }
  | { type: "redeem_sy"; caller: string; shares: bigint }
  | { type: "mint_py"; caller: string; amount: bigint; receiver?: string; deadline?: bigint | number }
  | { type: "redeem_py"; caller: string; amount: bigint }
  | { type: "swap"; caller: string; method: string; amountIn: bigint; minOut: bigint; receiver?: string; deadline?: bigint | number }
  | { type: "add_liquidity"; caller: string; ptAmount: bigint; syAmount: bigint; minLpOut: bigint }
  | { type: "remove_liquidity"; caller: string; lpAmount: bigint; minPt: bigint; minSy: bigint }
  | { type: "claim_yield"; caller: string }
  | { type: "redeem_pt_post_maturity"; caller: string; ptAmount: bigint }
  | { type: "redeem_pt_to_btoken"; caller: string; ptAmount: bigint }
  | {
      type: "rollover_to_pt";
      caller: string;
      receiver: string;
      sourcePool: string;
      targetPool: string;
      ptAmount: bigint;
      minTargetPt: bigint;
      deadline?: bigint | number;
      factoryContractId?: string;
    }
  | {
      type: "rollover_to_py";
      caller: string;
      receiver: string;
      sourcePool: string;
      targetPool: string;
      ptAmount: bigint;
      minNewShares: bigint;
      deadline?: bigint | number;
      factoryContractId?: string;
    }
  | {
      type: "zap_in_pt" | "zap_in_yt" | "zap_in_lp";
      caller: string;
      receiver?: string;
      pool?: string;
      poolId?: string;
      underlyingAmount?: bigint;
      amount?: bigint;
      amountIn?: bigint;
      minOut?: bigint;
      minPtOut?: bigint;
      minYtOut?: bigint;
      minLpOut?: bigint;
      deadline?: bigint | number;
      factoryContractId?: string;
    };

export function buildActionArgs(
  action: ProtocolAction,
  targetMarket?: MarketDefinition,
  deadline?: bigint | number
): { contractId: string; method: string; args: xdr.ScVal[]; label: string } {
  const syWrapperId =
    targetMarket?.contracts.syId ?? STELLAR_PENDLE_CONFIG.contracts.sy_blend_wrapper.contractId;
  const yieldPoolId =
    targetMarket?.contracts.poolId ?? STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId;
  const factoryId =
    process.env.NEXT_PUBLIC_MARKET_FACTORY_CONTRACT_ID ||
    STELLAR_PENDLE_CONFIG.market_factory.contractId;

  const addr = (s: string) => Address.fromString(s).toScVal();
  const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });
  const u64 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u64" });
  const resolveDeadline = (actionDeadline?: bigint | number): bigint => {
    const picked = actionDeadline ?? deadline;
    return picked !== undefined ? BigInt(picked) : BigInt(Math.floor(Date.now() / 1000) + 600);
  };

  switch (action.type) {
    case "deposit_sy":
      if (action.amount <= 0n) {
        throw new Error("deposit_sy amount must be strictly greater than zero");
      }
      return {
        contractId: syWrapperId,
        method: "deposit",
        args: [addr(action.caller), addr(action.caller), i128(action.amount)],
        label: `Deposit ${targetMarket?.asset.code ?? "USDC"} into ${targetMarket?.sySymbol ?? "sy-bUSDC"}`,
      };
    case "redeem_sy":
      if (action.shares <= 0n) {
        throw new Error("redeem_sy shares must be strictly greater than zero");
      }
      return {
        contractId: syWrapperId,
        method: "redeem",
        args: [addr(action.caller), addr(action.caller), i128(action.shares)],
        label: `Redeem ${targetMarket?.sySymbol ?? "sy-bUSDC"} to ${targetMarket?.asset.code ?? "USDC"}`,
      };
    case "mint_py":
      if (action.amount <= 0n) {
        throw new Error("mint_py amount must be strictly greater than zero");
      }
      return {
        contractId: yieldPoolId,
        method: "mint_py",
        args: [
          addr(action.caller),
          addr(action.receiver ?? action.caller),
          i128(action.amount),
          u64(resolveDeadline(action.deadline)),
        ],
        label: "Mint PT + YT from SY",
      };
    case "redeem_py":
      if (action.amount <= 0n) {
        throw new Error("redeem_py amount must be strictly greater than zero");
      }
      return {
        contractId: yieldPoolId,
        method: "redeem_py",
        args: [addr(action.caller), addr(action.caller), i128(action.amount)],
        label: "Merge PT + YT back to SY",
      };
    case "swap": {
      if (action.amountIn <= 0n) {
        throw new Error("swap amountIn must be strictly greater than zero");
      }
      if (action.minOut < 0n) {
        throw new Error("swap minOut cannot be negative");
      }
      let swapLabel = "Swap";
      switch (action.method) {
        case "swap_sy_for_pt":
        case "swap_exact_sy_for_pt":
          swapLabel = "Swap SY for PT";
          break;
        case "swap_pt_for_sy":
        case "swap_exact_pt_for_sy":
          swapLabel = "Swap PT for SY";
          break;
        case "swap_sy_for_yt":
        case "swap_exact_sy_for_yt":
          swapLabel = "Swap SY for YT";
          break;
        case "swap_yt_for_sy":
        case "swap_exact_yt_for_sy":
          swapLabel = "Swap YT for SY";
          break;
        default:
          swapLabel = "Swap";
          break;
      }
      return {
        contractId: yieldPoolId,
        method: action.method,
        args: [
          addr(action.caller),
          addr(action.receiver ?? action.caller),
          i128(action.amountIn),
          i128(action.minOut),
          u64(resolveDeadline(action.deadline)),
        ],
        label: swapLabel,
      };
    }
    case "add_liquidity":
      if (action.ptAmount <= 0n || action.syAmount <= 0n) {
        throw new Error("add_liquidity ptAmount and syAmount must be strictly greater than zero");
      }
      if (action.minLpOut < 0n) {
        throw new Error("add_liquidity minLpOut cannot be negative");
      }
      return {
        contractId: yieldPoolId,
        method: "add_liquidity",
        args: [
          addr(action.caller),
          addr(action.caller),
          i128(action.ptAmount),
          i128(action.syAmount),
          i128(action.minLpOut),
        ],
        label: "Add PT + SY Liquidity",
      };
    case "remove_liquidity":
      if (action.lpAmount <= 0n) {
        throw new Error("remove_liquidity lpAmount must be strictly greater than zero");
      }
      if (action.minPt < 0n || action.minSy < 0n) {
        throw new Error("remove_liquidity minPt and minSy cannot be negative");
      }
      return {
        contractId: yieldPoolId,
        method: "remove_liquidity",
        args: [
          addr(action.caller),
          addr(action.caller),
          i128(action.lpAmount),
          i128(action.minPt),
          i128(action.minSy),
        ],
        label: "Remove Pool Liquidity",
      };
    case "claim_yield":
      return {
        contractId: yieldPoolId,
        method: "claim_yield",
        args: [addr(action.caller), addr(action.caller)],
        label: "Claim Accrued YT Yield",
      };
    case "redeem_pt_post_maturity":
      if (action.ptAmount <= 0n) {
        throw new Error("redeem_pt_post_maturity ptAmount must be strictly greater than zero");
      }
      return {
        contractId: yieldPoolId,
        method: "redeem_pt_post_maturity",
        args: [addr(action.caller), addr(action.caller), i128(action.ptAmount)],
        label: "Redeem PT Post-Maturity",
      };
    case "redeem_pt_to_btoken":
      if (action.ptAmount <= 0n) {
        throw new Error("redeem_pt_to_btoken ptAmount must be strictly greater than zero");
      }
      return {
        contractId: yieldPoolId,
        method: "redeem_pt_to_btoken",
        args: [addr(action.caller), addr(action.caller), i128(action.ptAmount)],
        label: `Emergency Redeem PT to b${targetMarket?.asset.code ?? "USDC"}`,
      };
    case "rollover_to_pt":
      if (action.ptAmount <= 0n) {
        throw new Error("rollover_to_pt ptAmount must be strictly greater than zero");
      }
      if (action.minTargetPt < 0n) {
        throw new Error("rollover_to_pt minTargetPt cannot be negative");
      }
      return {
        contractId: action.factoryContractId ?? factoryId,
        method: "rollover_to_pt",
        args: [
          addr(action.caller),
          addr(action.receiver),
          addr(action.sourcePool),
          addr(action.targetPool),
          i128(action.ptAmount),
          i128(action.minTargetPt),
          u64(resolveDeadline(action.deadline)),
        ],
        label: "Atomic Rollover to Target PT",
      };
    case "rollover_to_py":
      if (action.ptAmount <= 0n) {
        throw new Error("rollover_to_py ptAmount must be strictly greater than zero");
      }
      if (action.minNewShares < 0n) {
        throw new Error("rollover_to_py minNewShares cannot be negative");
      }
      return {
        contractId: action.factoryContractId ?? factoryId,
        method: "rollover_to_py",
        args: [
          addr(action.caller),
          addr(action.receiver),
          addr(action.sourcePool),
          addr(action.targetPool),
          i128(action.ptAmount),
          i128(action.minNewShares),
          u64(resolveDeadline(action.deadline)),
        ],
        label: "Atomic Rollover to Target LP (PT+YT)",
      };
    case "zap_in_pt":
    case "zap_in_yt":
    case "zap_in_lp": {
      const resolvedPool = action.pool ?? action.poolId ?? targetMarket?.contracts.poolId ?? "";
      const receiverAddr = action.receiver ?? action.caller;
      const underlyingAmt = action.underlyingAmount ?? action.amount ?? action.amountIn ?? 0n;
      if (underlyingAmt <= 0n) {
        throw new Error("Zap-In underlyingAmount must be strictly greater than zero");
      }
      const minOutAmt =
        action.minOut ?? action.minPtOut ?? action.minYtOut ?? action.minLpOut ?? 0n;
      if (minOutAmt < 0n) {
        throw new Error("Zap-In minOut cannot be negative");
      }
      const assetCode = targetMarket?.asset.code ?? "USDC";
      const zapLabel =
        action.type === "zap_in_pt"
          ? `Zap ${assetCode} into PT`
          : action.type === "zap_in_yt"
          ? `Zap ${assetCode} into YT`
          : `Zap ${assetCode} into LP`;
      return {
        contractId: action.factoryContractId ?? factoryId,
        method: action.type,
        args: [
          addr(action.caller),
          addr(receiverAddr),
          addr(resolvedPool),
          i128(underlyingAmt),
          i128(minOutAmt),
          u64(resolveDeadline(action.deadline)),
        ],
        label: zapLabel,
      };
    }
  }
}

export function getFriendlyActionName(method: string): string {
  switch (method) {
    case "swap_sy_for_pt":
    case "swap_pt_for_sy":
    case "swap_sy_for_yt":
    case "swap_yt_for_sy":
    case "swap_exact_sy_for_pt":
    case "swap_exact_pt_for_sy":
    case "swap_exact_sy_for_yt":
    case "swap_exact_yt_for_sy":
      return "Swap";
    case "zap_in_pt":
      return "Zap In PT";
    case "zap_in_yt":
      return "Zap In YT";
    case "zap_in_lp":
      return "Zap In LP";
    case "deposit":
      return "Wrap";
    case "redeem":
      return "Unwrap";
    case "mint_py":
      return "Mint";
    case "add_liquidity":
      return "Add Liquidity";
    case "remove_liquidity":
      return "Remove Liquidity";
    case "redeem_py":
    case "redeem_pt_post_maturity":
    case "redeem_pt_to_btoken":
      return "Redeem";
    case "claim_yield":
      return "Claim Yield";
    case "rollover_to_pt":
    case "rollover_to_py":
      return "Rollover";
    default:
      return method
        .replace(/_/g, " ")
        .trim()
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
}

export function resolveScopedBusyAction(
  busyActions: Record<string, string> | undefined,
  legacyBusyAction: string | null | undefined,
  contractId: string,
  methods: readonly string[]
): string | null {
  if (busyActions) {
    for (const method of methods) {
      const match = busyActions[`${contractId}:${method}`];
      if (match) return match;
    }
    return null;
  }
  return legacyBusyAction ?? null;
}
