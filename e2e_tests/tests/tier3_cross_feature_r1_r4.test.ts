// e2e_tests/tests/tier3_cross_feature_r1_r4.test.ts
// Tier 3: Cross-Feature Pairwise Interaction E2E Suite (16 tests: 6 ContractxContract, 5 Offchain/UI, 5 Cross-Layer XDR/MCP/Scripts/WAL)

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import {
  CANONICAL_INDEXER_PORT,
  CANONICAL_USDC_MATURED,
  CANONICAL_XLM_90D,
  CANONICAL_XLM_PRICE_USD,
  DEPLOYED_CONTRACTS_PATH,
  EXPECTED_MCP_RESOURCES,
  EXPECTED_MCP_TOOLS,
  REPO_ROOT,
  React,
  SorobanRunnerSession,
  act,
  callBffGetRaw,
  computeFileSha256,
  connectAgentMcpInMemory,
  connectAgentMcpStdio,
  decodeUnsignedInvokeContractXdr,
  getClosedLocalUrl,
  inspectScValArgs,
  invokeBffGet,
  mountFrontendDom,
  readFileText,
  renderFrontendHtml,
  scanR5OutOfScopeSymbols,
  scanSourceForIdentifiers,
  startIndexerHarness,
  verifyContractsConfigLock,
  verifyLockedSha256,
  withBffEnv,
  type SorobanResponse,
  type TypedArg,
} from "../src/harness/index.ts";
import {
  WAD,
  wadMul,
  wadDiv,
  wadDivCeil,
  getExchangeRate,
  calculateHaircut,
  MIN_FEE_RATE,
  MAX_FEE_RATE,
  SECONDS_PER_YEAR,
  calcTauWad,
  calcFeeRate,
  syToAsset,
  assetToSy,
  calculateProRataShare,
  oracleSwapPtForSy,
  oracleSwapSyForPt,
  oracleSwapSyForYt,
  oracleSwapYtForSy,
} from "../src/math-oracle.ts";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import {
  PRESET_MARKETS,
  type MarketDefinition,
  type MarketSummaryMetrics,
} from "@/lib/markets";
import {
  buildActionArgs,
  type LiveMarketSnapshot,
  type LiveUserPortfolio,
} from "@/lib/stellar";
import { parseMarketPosition } from "@/hooks/useMultiMarketPortfolio";
import {
  convertToChartDataPoints,
  fetchMarketChartData,
  fetchUserPositionData,
} from "@/lib/indexerAnalytics";
import { WalletProvider } from "@/context/WalletProvider";
import { MarketProvider } from "@/context/MarketContext";
import { ToastProvider } from "@/context/ToastContext";
import { InteractiveYieldChart } from "@/components/token/InteractiveYieldChart";
import { YieldBreakdownCards } from "@/components/token/YieldBreakdownCards";
import { SwapCard } from "@/components/trading/SwapCard";
import { MarketsPageClient } from "@/app/markets/MarketsPageClient";
import { PoolsPageClient, type PoolsPageClientProps } from "@/app/pools/PoolsPageClient";
import { MarketExplorerTable } from "@/components/markets/MarketExplorerTable";
import { CONTRACT_CATALOG, MARKETS, resolveHttpPort } from "../../indexer/index.ts";
import { StellarPendleAgentClient } from "../../agent/src/client.ts";
import type { DeploymentManifest, SwapDirection } from "../../agent/src/types.ts";
import { buildRegisteredMarkets } from "../../scripts/register_markets.ts";

const T0 = 1_700_000_000;
const DAY = 86_400;
const SCALAR_9 = 1_000_000_000n;
const SCALAR_ROOT = 20n * WAD;
const INITIAL_ANCHOR = WAD;
const POS_ANCHOR = (105n * WAD) / 100n; // 1.05 WAD positive implied yield
const DEFAULT_ANNUAL_FEE_RATE = 50_000_000_000_000_000n;
const DEFAULT_PROTOCOL_FEE_BPS = 2_000n;

const TEST_SECRET = "e2e-tier3-secret-32bytes-hex-0001";
const TEST_USER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const LEAKED_HEX_SECRET =
  "c62f0b839f5d4c81c7d5e75ef60a2d7bb65de9980eb01661195fd45df2a7b4fe";

interface MarketMetadata {
  id: number;
  asset: string;
  maturity: string;
  sy: string;
  pt: string;
  yt: string;
  pool: string;
  scalar_root: string;
  initial_anchor: string;
  created_at: string;
  is_active: boolean;
}

interface MarketState {
  total_pt_reserve: string;
  total_sy_reserve: string;
  total_lp_supply: string;
  scalar_root: string;
  initial_anchor: string;
  annual_fee_rate: string;
  protocol_fee_bps: string;
  fee_recipient: string;
  maturity: string;
  maturity_index: string;
  is_settled: boolean;
}

type BuildActionArgsCompat = (
  action: Record<string, unknown>,
  targetMarket?: MarketDefinition,
  deadline?: bigint
) => ReturnType<typeof buildActionArgs>;
const buildActionArgsCompat = buildActionArgs as unknown as BuildActionArgsCompat;

type BuildMintPyCompat = (
  sourceAddress: string,
  syAmountStroops: bigint,
  receiver?: string,
  deadline?: bigint
) => ReturnType<StellarPendleAgentClient["buildMintPyTx"]>;

type BuildSwapCompat = (
  sourceAddress: string,
  direction: SwapDirection,
  amountInStroops: bigint,
  minOutStroops: bigint,
  receiver?: string,
  deadline?: bigint
) => ReturnType<StellarPendleAgentClient["buildSwapTx"]>;

const aAddr = (value: string): TypedArg => ({ type: "address", value });
const aI128 = (value: bigint | number | string): TypedArg => ({
  type: "i128",
  value: String(value),
});
const aU64 = (value: bigint | number | string): TypedArg => ({
  type: "u64",
  value: String(value),
});
const aU32 = (value: number): TypedArg => ({ type: "u32", value });
const aBool = (value: boolean): TypedArg => ({ type: "bool", value });
const aStr = (value: string): TypedArg => ({ type: "string", value });
const aBytes32 = (value: string): TypedArg => ({ type: "bytes_n32", value });

function scValsToTypedArgs(args: readonly xdr.ScVal[]): TypedArg[] {
  return args.map((sc) => ({
    type: "scval_xdr_hex",
    value: sc.toXDR("hex"),
  }));
}

async function mustInvoke<T = unknown>(
  session: SorobanRunnerSession,
  contract: string,
  method: string,
  args: TypedArg[] = []
): Promise<T> {
  const res = await session.invoke<T>(contract, method, args);
  if (!res.ok) {
    throw new Error(
      `Invoke ${method} failed (${res.error?.kind} #${res.error?.code} ${res.error?.name ?? ""}): ${res.error?.message}`
    );
  }
  return res.data as T;
}

function expectContractError(
  res: SorobanResponse<unknown>,
  code: number,
  name?: string
) {
  expect(res.ok).toBe(false);
  expect(res.error?.kind).toBe("ContractError");
  expect(res.error?.code).toBe(code);
  if (name) {
    expect(res.error?.name).toBe(name);
  }
}

function isArityMismatchError(error?: SorobanResponse["error"]): boolean {
  return (
    (error?.kind === "InvokeError" && error?.sc_error_code === "UnexpectedSize") ||
    error?.kind === "InvalidArg"
  );
}

async function assertReserveConservation(
  session: SorobanRunnerSession,
  sy: string,
  pool: string,
  pt?: string,
  tolerance = 2n,
  bRate = SCALAR_9
) {
  const state = await mustInvoke<MarketState>(session, pool, "get_market_state");
  const [ptPrincipal, ytYield] = await mustInvoke<[string, string]>(
    session,
    pool,
    "get_py_reserves"
  );
  const poolSyBal = BigInt(await mustInvoke<string>(session, sy, "balance", [aAddr(pool)]));
  const ptPrincipalBig = BigInt(ptPrincipal);
  const ytYieldBig = BigInt(ytYield);
  const expected = BigInt(state.total_sy_reserve) + ptPrincipalBig + ytYieldBig;
  expect(poolSyBal).toBeGreaterThanOrEqual(expected);
  expect(poolSyBal - expected).toBeLessThanOrEqual(tolerance);
  if (pt) {
    const ptTotalSupply = BigInt(await mustInvoke<string>(session, pt, "total_supply"));
    expect((ptPrincipalBig * bRate) / SCALAR_9 + tolerance).toBeGreaterThanOrEqual(
      ptTotalSupply
    );
  }
  return { state, ptPrincipal: ptPrincipalBig, ytYield: ytYieldBig, poolSyBal };
}

async function assertFactoryZeroDust(
  session: SorobanRunnerSession,
  factory: string,
  tokens: string[]
) {
  for (const token of tokens) {
    expect(await mustInvoke<string>(session, token, "balance", [aAddr(factory)])).toBe("0");
  }
}

async function setupFactory(session: SorobanRunnerSession, timestamp = T0) {
  await session.reset({
    timestamp,
    sequence: 100,
    auth_mode: "mock_all",
    budget_mode: "unlimited",
  });
  const admin = await session.genAddress("admin");
  const guardian = await session.genAddress("guardian");
  const ptHash = await session.uploadWasm("pt_token.wasm", "pt_hash");
  const ytHash = await session.uploadWasm("yt_token.wasm", "yt_hash");
  const poolHash = await session.uploadWasm("yield_pool.wasm", "pool_hash");
  const syHash = await session.uploadWasm("sy_blend_wrapper.wasm", "sy_hash");

  const factory = await session.deployWasm("market_factory.wasm", { var_name: "factory" });
  await mustInvoke(session, factory, "initialize", [
    aAddr(admin),
    aAddr(guardian),
    aBytes32(ptHash),
    aBytes32(ytHash),
    aBytes32(poolHash),
    aBytes32(syHash),
  ]);

  return { admin, guardian, factory };
}

async function setupBlendAndAsset(
  session: SorobanRunnerSession,
  admin: string,
  symbol: string
) {
  const asset = await session.createSac(symbol, symbol === "native" ? undefined : { admin });
  const blend = await session.deployWasm("mock_blend.wasm");
  await mustInvoke(session, blend, "initialize", [
    aAddr(admin),
    aAddr(asset),
    aI128(SCALAR_9),
  ]);
  return { asset, blend };
}

async function deploySlenderAndWrapper(
  session: SorobanRunnerSession,
  admin: string,
  usdc: string
) {
  const slender = await session.deployWasm("mock_slender.wasm", { var_name: "slender" });
  let initRes = await session.invoke(slender, "initialize", [
    aAddr(admin),
    aAddr(usdc),
    aI128(SCALAR_9),
  ]);
  if (!initRes.ok && isArityMismatchError(initRes.error)) {
    initRes = await session.invoke(slender, "initialize", [aAddr(admin), aAddr(usdc)]);
  }
  if (!initRes.ok) {
    throw new Error(
      `mock_slender.initialize failed (${initRes.error?.kind} #${initRes.error?.code}): ${initRes.error?.message}`
    );
  }

  let sToken = slender;
  const sTokProbe = await session.invoke<string>(slender, "s_token");
  if (sTokProbe.ok) {
    if (typeof sTokProbe.data !== "string" || sTokProbe.data.length === 0) {
      throw new Error(`mock_slender.s_token returned invalid address`);
    }
    sToken = sTokProbe.data;
  } else if (sTokProbe.error?.kind !== "MissingMethod") {
    throw new Error(
      `mock_slender.s_token failed (${sTokProbe.error?.kind} #${sTokProbe.error?.code}): ${sTokProbe.error?.message}`
    );
  }

  const sySlender = await session.deployWasm("sy_slender_wrapper.wasm", {
    var_name: "sy_slender",
  });
  let syInitRes = await session.invoke(sySlender, "initialize", [
    aAddr(admin),
    aAddr(usdc),
    aAddr(slender),
    aAddr(sToken),
  ]);
  if (!syInitRes.ok && isArityMismatchError(syInitRes.error)) {
    syInitRes = await session.invoke(sySlender, "initialize", [
      aAddr(admin),
      aAddr(usdc),
      aAddr(slender),
    ]);
  }
  if (!syInitRes.ok) {
    throw new Error(
      `sy_slender_wrapper.initialize failed (${syInitRes.error?.kind} #${syInitRes.error?.code}): ${syInitRes.error?.message}`
    );
  }

  return { slender, sToken, sySlender };
}

async function setSlenderRate(
  session: SorobanRunnerSession,
  slender: string,
  newRate: bigint
) {
  for (const method of [
    "set_b_rate",
    "set_exchange_rate",
    "set_liquidity_index",
    "set_rate",
  ]) {
    const res = await session.invoke(slender, method, [aI128(newRate)]);
    if (res.ok) return;
    if (res.error?.kind !== "MissingMethod") {
      throw new Error(
        `mock_slender.${method} failed (${res.error?.kind} #${res.error?.code}): ${res.error?.message}`
      );
    }
  }
  throw new Error("mock_slender exposes no supported rate setter");
}

async function setupFactoryWithBlendMarket(
  session: SorobanRunnerSession,
  symbol: "USDC" | "native",
  days = 90,
  timestamp = T0
) {
  const { admin, guardian, factory } = await setupFactory(session, timestamp);
  const lp = await session.genAddress("lp");
  const feeRecipient = await session.genAddress("fee_recipient");
  const { asset, blend } = await setupBlendAndAsset(session, admin, symbol);

  const maturity = timestamp + days * DAY;
  const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
    aAddr(admin),
    aAddr(asset),
    aAddr(blend),
    aU64(maturity),
    aI128(SCALAR_ROOT),
    aI128(POS_ANCHOR),
  ]);
  await mustInvoke(session, meta.pool, "set_fee_recipient", [
    aAddr(admin),
    aAddr(feeRecipient),
  ]);

  const lpSeed = 220_000_000_000n;
  if (symbol === "native") {
    const funder = await session.genAccount("xlm_lp_funder", "1000000000000");
    await mustInvoke(session, asset, "transfer", [
      aAddr(funder),
      aAddr(lp),
      aI128(lpSeed),
    ]);
  } else {
    await session.sacMint(asset, lp, lpSeed);
  }
  await mustInvoke(session, meta.sy, "deposit", [aAddr(lp), aAddr(lp), aI128(lpSeed)]);
  await mustInvoke(session, meta.pool, "mint_py", [
    aAddr(lp),
    aAddr(lp),
    aI128(120_000_000_000n),
    aU64(maturity),
  ]);
  await mustInvoke(session, meta.pool, "add_liquidity", [
    aAddr(lp),
    aAddr(lp),
    aI128(120_000_000_000n),
    aI128(100_000_000_000n),
    aI128(1),
  ]);

  return { admin, guardian, lp, feeRecipient, factory, asset, blend, meta, maturity };
}

function makeSessionMarketDef(opts: {
  id: string;
  assetCode: "USDC" | "XLM";
  sacId: string;
  poolId: string;
  syId: string;
  ptId: string;
  ytId: string;
  blendPoolId: string;
  maturity: number;
  sySymbol: string;
}): MarketDefinition {
  return {
    id: opts.id,
    factoryId: 0,
    name: `Test ${opts.assetCode}`,
    ptSymbol: `PT-${opts.assetCode}-90D`,
    ytSymbol: `YT-${opts.assetCode}-90D`,
    sySymbol: opts.sySymbol,
    lpSymbol: `LP-${opts.assetCode}-90D`,
    asset: {
      code: opts.assetCode,
      symbol: opts.assetCode,
      name: opts.assetCode,
      decimals: 7,
      sacContractId: opts.sacId,
      iconName: opts.assetCode === "XLM" ? "xlm" : "usdc",
    },
    tenor: "90D",
    maturity: opts.maturity,
    maturityIso: new Date(opts.maturity * 1000).toISOString(),
    scalarRoot: "20000000000000000000",
    initialAnchor: "1050000000000000000",
    contracts: {
      poolId: opts.poolId,
      syId: opts.syId,
      ptId: opts.ptId,
      ytId: opts.ytId,
      blendPoolId: opts.blendPoolId,
    },
    isRegisteredOnChain: true,
    isVerifiedTestnet: true,
  };
}

async function withRealBffBridge<T>(
  config: { indexerInternalUrl: string; indexerApiSecret: string },
  fn: (bffBaseUrl: string) => Promise<T>
): Promise<T> {
  return withBffEnv(config, async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        return callBffGetRaw({
          url: `${u.pathname}${u.search}`,
          headers: req.headers,
        });
      },
    });
    try {
      return await fn(`http://127.0.0.1:${server.port}/api/indexer`);
    } finally {
      server.stop(true);
    }
  });
}

function WithSeededWallet({
  address,
  children,
}: {
  address: string;
  children?: React.ReactNode;
}) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    window.localStorage.setItem(
      "stellar_pendle_wallet_session",
      JSON.stringify({ address, mode: "wallet", walletId: "freighter" })
    );
    setReady(true);
  }, [address]);
  if (!ready) return null;
  return React.createElement(WalletProvider, null, children);
}

function makeActiveSnapshot(market: MarketDefinition): LiveMarketSnapshot {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    state: {
      total_pt_reserve: 80_000_0000000n,
      total_sy_reserve: 40_000_0000000n,
      total_lp_supply: 56_568_5424949n,
      scalar_root: 8_000_000_000_000_000_000n,
      initial_anchor: 1_000_000_000_000_000_000n,
      annual_fee_rate: 50_000_000_000_000_000n,
      protocol_fee_bps: 2000n,
      fee_recipient: TEST_USER,
      maturity: BigInt(market.maturity > nowSec ? market.maturity : nowSec + 90 * 86_400),
      maturity_index: 0n,
      is_settled: false,
    },
    latestLedger: 5_700_000,
    nowSeconds: nowSec,
    daysToMaturity: 90,
    isMatured: false,
    blendExchangeRate: 1_001_000_000n,
    ammExchangeRateWad: 1_020_000_000_000_000_000n,
    ptPriceInSy: 0.98,
    ytPriceInSy: 0.02,
    impliedFixedApyPct: 8.45,
    ptTotalSupply: 100_000_0000000n,
    ytTotalSupply: 100_000_0000000n,
    syTotalSupply: 100_000_0000000n,
    ptProportionPct: 66.67,
  };
}

function makeActivePortfolio(): LiveUserPortfolio {
  return {
    address: TEST_USER,
    accountExists: true,
    xlmBalance: "5000.0000000",
    usdcBalance: "5000.0000000",
    usdcTrustlineExists: true,
    syBalance: 100_0000000n,
    ptBalance: 100_0000000n,
    ytBalance: 100_0000000n,
    lpBalance: 50_0000000n,
    lastIndex: 1_001_000_000n,
    unclaimedYieldRaw: 0n,
    estimatedPendingYieldSy: 0n,
  };
}

function startLocalSorobanRpcServer(sourceAddress: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as {
        id: number | string;
        method: string;
        params?: { keys?: string[] };
      };
      if (body.method === "getLedgerEntries") {
        const keyXdr = body.params?.keys?.[0] ?? "";
        const accountEntry = new xdr.AccountEntry({
          accountId: Keypair.fromPublicKey(sourceAddress).xdrPublicKey(),
          balance: xdr.Int64.fromString("10000000000"),
          seqNum: xdr.Int64.fromString("1"),
          numSubEntries: 0,
          inflationDest: null,
          flags: 0,
          homeDomain: "",
          thresholds: Buffer.alloc(4),
          signers: [],
          ext: xdr.AccountEntryExt.v0(),
        });
        const ledgerEntryData = xdr.LedgerEntryData.account(accountEntry);
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            entries: [
              {
                key: keyXdr,
                xdr: ledgerEntryData.toXDR("base64"),
                lastModifiedLedgerSeq: 100,
              },
            ],
            latestLedger: 100,
          },
        });
      }
      if (body.method === "simulateTransaction") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            id: "sim-t3-1",
            latestLedger: 100,
            minResourceFee: "50000",
            transactionData: new SorobanDataBuilder().build().toXDR("base64"),
            results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
            events: [],
          },
        });
      }
      if (body.method === "getLatestLedger") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { id: "hash", sequence: 100, protocolVersion: 28 },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Unsupported method: ${body.method}` },
      });
    },
  });
}

describe("Tier 3: Cross-Feature Pairwise Interactions (F1-F11 & R5)", () => {
  let session: SorobanRunnerSession;

  beforeAll(async () => {
    session = await SorobanRunnerSession.start();
  }, 180_000);

  afterAll(async () => {
    await session?.close();
  }, 30_000);

  // =========================================================================
  // Section A: Contract x Contract Pairwise Interactions (6 tests)
  // =========================================================================
  describe("A. Soroban Contract x Contract Pairwise", () => {
    it("T3-F1+F2: whitelisted creator deploys XLM & EURC markets with dynamic metadata and SyByAsset isolation", async () => {
      const { admin, factory } = await setupFactory(session, T0);
      const attacker = await session.genAddress("attacker");
      const creator1 = await session.genAddress("creator1");
      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);

      const { asset: xlmSac, blend: blendXlm } = await setupBlendAndAsset(
        session,
        admin,
        "native"
      );
      const { asset: eurcSac, blend: blendEurc } = await setupBlendAndAsset(
        session,
        admin,
        "EURC"
      );

      // Unauthorized attack before valid creation leaves registry unpoisoned
      const attackRes = await session.invoke(factory, "create_market", [
        aAddr(attacker),
        aAddr(xlmSac),
        aAddr(blendXlm),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      expectContractError(attackRes, 3, "Unauthorized");
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(xlmSac)])
      ).toBeNull();
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(0);

      // Whitelisted creator deploys native XLM (90D) and EURC (60D)
      const mXlm = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(xlmSac),
        aAddr(blendXlm),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      const mEurc = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(eurcSac),
        aAddr(blendEurc),
        aU64(T0 + 60 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);

      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(2);
      expect(mXlm.sy).not.toBe(mEurc.sy);
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(xlmSac)])
      ).toBe(mXlm.sy);
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(eurcSac)])
      ).toBe(mEurc.sy);

      // Dynamic metadata assertions
      expect(await mustInvoke<string>(session, mXlm.sy, "symbol")).toBe("sy-bXLM");
      expect(await mustInvoke<string>(session, mXlm.sy, "name")).toBe(
        "Standardized Yield Blend XLM"
      );
      expect(await mustInvoke<number>(session, mXlm.sy, "decimals")).toBe(7);
      expect(await mustInvoke<string>(session, mXlm.pt, "symbol")).toBe("PT-XLM-90D");
      expect(await mustInvoke<string>(session, mXlm.yt, "symbol")).toBe("YT-XLM-90D");
      expect(await mustInvoke<string>(session, mXlm.pool, "symbol")).toBe("LP-XLM");

      expect(await mustInvoke<string>(session, mEurc.sy, "symbol")).toBe("sy-bEURC");
      expect(await mustInvoke<string>(session, mEurc.sy, "name")).toBe(
        "Standardized Yield Blend EURC"
      );
      expect(await mustInvoke<string>(session, mEurc.pt, "symbol")).toBe("PT-EURC-60D");
      expect(await mustInvoke<string>(session, mEurc.yt, "symbol")).toBe("YT-EURC-60D");
      expect(await mustInvoke<string>(session, mEurc.pool, "symbol")).toBe("LP-EURC");

      // Deployed children belong to factory admin (not creator1)
      for (const child of [mXlm.sy, mXlm.pt, mXlm.yt, mXlm.pool]) {
        const childAdmin = await mustInvoke<string>(session, child, "get_admin");
        expect(childAdmin).toBe(admin);
        expect(childAdmin).not.toBe(creator1);
      }

      // Second XLM market (30D) reuses mXlm.sy
      const mXlm30 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(xlmSac),
        aAddr(blendXlm),
        aU64(T0 + 30 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      expect(mXlm30.sy).toBe(mXlm.sy);
      expect(await mustInvoke<string>(session, mXlm30.pt, "symbol")).toBe("PT-XLM-30D");
    }, 30_000);

    it("T3-F3+F4: 4-way swaps + Blend accrual + yt.transfer MaturityIndex pinning + calculate_haircut + 100% LP exit", async () => {
      await session.reset({
        timestamp: T0,
        sequence: 100,
        auth_mode: "mock_all",
        budget_mode: "unlimited",
      });
      const admin = await session.genAddress("admin");
      const feeRecipient = await session.genAddress("fee_recipient");
      const lp = await session.genAddress("lp");
      const user1 = await session.genAddress("user1");
      const user2 = await session.genAddress("user2");
      const user3 = await session.genAddress("user3");

      const usdc = await session.createSac("USDC", { admin });
      const blend = await session.deployWasm("mock_blend.wasm");
      await mustInvoke(session, blend, "initialize", [
        aAddr(admin),
        aAddr(usdc),
        aI128(SCALAR_9),
      ]);
      const sy = await session.deployWasm("sy_blend_wrapper.wasm");
      await mustInvoke(session, sy, "initialize", [aAddr(admin), aAddr(usdc), aAddr(blend)]);

      const pt = await session.deployWasm("pt_token.wasm");
      const yt = await session.deployWasm("yt_token.wasm");
      const pool = await session.deployWasm("yield_pool.wasm");
      const maturity = T0 + 90 * DAY;

      await mustInvoke(session, pt, "initialize", [
        aAddr(admin),
        aAddr(pool),
        aStr("PT USDC 90D"),
        aStr("PT-USDC-90D"),
        aU32(7),
        aU64(maturity),
      ]);
      await mustInvoke(session, yt, "initialize", [
        aAddr(admin),
        aAddr(pool),
        aAddr(sy),
        aStr("YT USDC 90D"),
        aStr("YT-USDC-90D"),
        aU32(7),
        aU64(maturity),
      ]);
      await mustInvoke(session, pool, "initialize", [
        aAddr(admin),
        aAddr(sy),
        aAddr(pt),
        aAddr(yt),
        aU64(maturity),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      await mustInvoke(session, pool, "set_fee_recipient", [
        aAddr(admin),
        aAddr(feeRecipient),
      ]);

      // LP seeds 300B PT / 200B SY
      await session.sacMint(usdc, lp, 500_000_000_000n);
      await mustInvoke(session, sy, "deposit", [aAddr(lp), aAddr(lp), aI128(500_000_000_000n)]);
      await mustInvoke(session, pool, "mint_py", [
        aAddr(lp),
        aAddr(lp),
        aI128(300_000_000_000n),
        aU64(maturity),
      ]);
      const lpShares = BigInt(
        await mustInvoke<string>(session, pool, "add_liquidity", [
          aAddr(lp),
          aAddr(lp),
          aI128(300_000_000_000n),
          aI128(200_000_000_000n),
          aI128(1),
        ])
      );

      // user1 mints 100B PY; user2 mints 60B PY + keeps 40B SY
      await session.sacMint(usdc, user1, 100_000_000_000n);
      await mustInvoke(session, sy, "deposit", [
        aAddr(user1),
        aAddr(user1),
        aI128(100_000_000_000n),
      ]);
      await mustInvoke(session, pool, "mint_py", [
        aAddr(user1),
        aAddr(user1),
        aI128(100_000_000_000n),
        aU64(maturity),
      ]);

      await session.sacMint(usdc, user2, 100_000_000_000n);
      await mustInvoke(session, sy, "deposit", [
        aAddr(user2),
        aAddr(user2),
        aI128(100_000_000_000n),
      ]);
      await mustInvoke(session, pool, "mint_py", [
        aAddr(user2),
        aAddr(user2),
        aI128(60_000_000_000n),
        aU64(maturity),
      ]);

      const nowBig = BigInt(T0);
      const matBig = BigInt(maturity);

      // Swap 1: swap_exact_pt_for_sy
      {
        const [ptR, syR] = (
          await mustInvoke<[string, string]>(session, pool, "get_reserves")
        ).map(BigInt) as [bigint, bigint];
        const ptIn = 5_000_000_000n;
        const oracle = oracleSwapPtForSy(ptIn, ptR, syR, nowBig, matBig, POS_ANCHOR);
        const feeBefore = BigInt(
          await mustInvoke<string>(session, sy, "balance", [aAddr(feeRecipient)])
        );
        const [out, fee] = await mustInvoke<[string, string]>(
          session,
          pool,
          "swap_exact_pt_for_sy",
          [aAddr(user2), aAddr(user2), aI128(ptIn), aI128(1), aU64(maturity)]
        );
        expect(BigInt(out)).toBe(oracle.netOut);
        expect(BigInt(fee)).toBe(oracle.fee);
        const feeAfter = BigInt(
          await mustInvoke<string>(session, sy, "balance", [aAddr(feeRecipient)])
        );
        expect(feeAfter - feeBefore).toBe(oracle.protoFee);
        await assertReserveConservation(session, sy, pool, pt);
      }

      // Swap 2: swap_exact_sy_for_pt
      {
        const [ptR, syR] = (
          await mustInvoke<[string, string]>(session, pool, "get_reserves")
        ).map(BigInt) as [bigint, bigint];
        const syIn = 5_000_000_000n;
        const oracle = oracleSwapSyForPt(syIn, ptR, syR, nowBig, matBig, POS_ANCHOR);
        const ptFeeBefore = BigInt(
          await mustInvoke<string>(session, pt, "balance", [aAddr(feeRecipient)])
        );
        const [out, fee] = await mustInvoke<[string, string]>(
          session,
          pool,
          "swap_exact_sy_for_pt",
          [aAddr(user2), aAddr(user2), aI128(syIn), aI128(1), aU64(maturity)]
        );
        expect(BigInt(out)).toBe(oracle.netOut);
        expect(BigInt(fee)).toBe(oracle.fee);
        const ptFeeAfter = BigInt(
          await mustInvoke<string>(session, pt, "balance", [aAddr(feeRecipient)])
        );
        expect(ptFeeAfter - ptFeeBefore).toBe(oracle.protoFee);
        await assertReserveConservation(session, sy, pool, pt);
      }

      // Swap 3: swap_exact_sy_for_yt
      let ytBought = 0n;
      {
        const [ptR, syR] = (
          await mustInvoke<[string, string]>(session, pool, "get_reserves")
        ).map(BigInt) as [bigint, bigint];
        const syIn = 500_000_000n;
        const oracle = oracleSwapSyForYt(syIn, ptR, syR, nowBig, matBig, POS_ANCHOR);
        const syFeeBefore = BigInt(
          await mustInvoke<string>(session, sy, "balance", [aAddr(feeRecipient)])
        );
        const [out, fee] = await mustInvoke<[string, string]>(
          session,
          pool,
          "swap_exact_sy_for_yt",
          [aAddr(user2), aAddr(user2), aI128(syIn), aI128(1), aU64(maturity)]
        );
        ytBought = BigInt(out);
        expect(ytBought).toBe(oracle.ytOut);
        expect(BigInt(fee)).toBe(oracle.fee);
        const syFeeAfter = BigInt(
          await mustInvoke<string>(session, sy, "balance", [aAddr(feeRecipient)])
        );
        expect(syFeeAfter - syFeeBefore).toBe(oracle.protoFee);
        await assertReserveConservation(session, sy, pool, pt);
      }

      // Swap 4: swap_exact_yt_for_sy
      {
        const [ptR, syR] = (
          await mustInvoke<[string, string]>(session, pool, "get_reserves")
        ).map(BigInt) as [bigint, bigint];
        const ytIn = ytBought / 2n;
        const oracle = oracleSwapYtForSy(ytIn, ptR, syR, nowBig, matBig, POS_ANCHOR);
        const syFeeBefore = BigInt(
          await mustInvoke<string>(session, sy, "balance", [aAddr(feeRecipient)])
        );
        const [out, fee] = await mustInvoke<[string, string]>(
          session,
          pool,
          "swap_exact_yt_for_sy",
          [aAddr(user2), aAddr(user2), aI128(ytIn), aI128(1), aU64(maturity)]
        );
        expect(BigInt(out)).toBe(oracle.netOut);
        expect(BigInt(fee)).toBe(oracle.fee);
        const syFeeAfter = BigInt(
          await mustInvoke<string>(session, sy, "balance", [aAddr(feeRecipient)])
        );
        expect(syFeeAfter - syFeeBefore).toBe(oracle.protoFee);
        await assertReserveConservation(session, sy, pool, pt);
      }

      // Accrue Blend yield to 1.2, cross maturity, trigger yt.transfer checkpoint, then spike to 1.5
      await mustInvoke(session, blend, "set_b_rate", [aI128(1_200_000_000n)]);
      await session.setLedger({ timestamp: maturity + 100 });
      await mustInvoke(session, yt, "transfer", [aAddr(user1), aAddr(user3), aI128(1_000n)]);
      await mustInvoke(session, blend, "set_b_rate", [aI128(1_500_000_000n)]);

      // pool.settle_maturity adopts yt_token's pinned 1.2 index
      expect(await mustInvoke<string>(session, pool, "settle_maturity")).toBe("1200000000");

      // user1 claim_yield is capped at 1.2 (20% of 100B underlying converted at current 1.5 rate)
      const u1Yield = BigInt(
        await mustInvoke<string>(session, pool, "claim_yield", [aAddr(user1), aAddr(user1)])
      );
      const maxExpectedYieldSy = (100_000_000_000n * 200_000_000n) / 1_500_000_000n;
      expect(u1Yield).toBeGreaterThan(0n);
      expect(u1Yield).toBeLessThanOrEqual(maxExpectedYieldSy + 2n);

      // user1 and user2 redeem PT post-maturity without touching LP TotalSyReserve
      const u1Pt = BigInt(await mustInvoke<string>(session, pt, "balance", [aAddr(user1)]));
      const u2Pt = BigInt(await mustInvoke<string>(session, pt, "balance", [aAddr(user2)]));
      const u1Redeemed = BigInt(
        await mustInvoke<string>(session, pool, "redeem_pt_post_maturity", [
          aAddr(user1),
          aAddr(user1),
          aI128(u1Pt),
        ])
      );
      const u2Redeemed = BigInt(
        await mustInvoke<string>(session, pool, "redeem_pt_post_maturity", [
          aAddr(user2),
          aAddr(user2),
          aI128(u2Pt),
        ])
      );
      expect(u1Redeemed).toBeGreaterThan(0n);
      expect(u2Redeemed).toBeGreaterThan(0n);

      // LP 100% exit (remaining TotalLpSupply = MINIMUM_LIQUIDITY 1000)
      const [lpPtOut, lpSyOut] = await mustInvoke<[string, string]>(
        session,
        pool,
        "remove_liquidity",
        [aAddr(lp), aAddr(lp), aI128(lpShares), aI128(1), aI128(1)]
      );
      expect(BigInt(lpPtOut)).toBeGreaterThan(0n);
      expect(BigInt(lpSyOut)).toBeGreaterThan(0n);
      const finalState = await mustInvoke<MarketState>(session, pool, "get_market_state");
      expect(finalState.total_lp_supply).toBe("1000");
      expect(BigInt(finalState.total_sy_reserve)).toBeLessThan(10_000n);
      await assertReserveConservation(session, sy, pool, pt, 2n, 1_500_000_000n);
    }, 60_000);

    it("T3-F4+F5: pre- vs post-maturity DeadlineExpired (#10) precedence over #8 and #7 across mint, swaps, and rollover", async () => {
      const { admin, factory } = await setupFactory(session, T0);
      const lp = await session.genAddress("lp");
      const user1 = await session.genAddress("user1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      const src = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 30 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      const dst = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);

      // Seed both pools
      for (const m of [src, dst]) {
        await session.sacMint(asset, lp, 350_000_000_000n);
        await mustInvoke(session, m.sy, "deposit", [
          aAddr(lp),
          aAddr(lp),
          aI128(350_000_000_000n),
        ]);
        await mustInvoke(session, m.pool, "mint_py", [
          aAddr(lp),
          aAddr(lp),
          aI128(200_000_000_000n),
          aU64(Number(m.maturity)),
        ]);
        await mustInvoke(session, m.pool, "add_liquidity", [
          aAddr(lp),
          aAddr(lp),
          aI128(200_000_000_000n),
          aI128(150_000_000_000n),
          aI128(1),
        ]);
      }

      // Fund user1 with 20B SY + 20B PT/YT in src
      await session.sacMint(asset, user1, 40_000_000_000n);
      await mustInvoke(session, src.sy, "deposit", [
        aAddr(user1),
        aAddr(user1),
        aI128(40_000_000_000n),
      ]);
      await mustInvoke(session, src.pool, "mint_py", [
        aAddr(user1),
        aAddr(user1),
        aI128(20_000_000_000n),
        aU64(T0 + 30 * DAY),
      ]);

      // Phase 1: Pre-source maturity (now = T0 + 10*DAY)
      const tPre = T0 + 10 * DAY;
      await session.setLedger({ timestamp: tPre });
      expectContractError(
        await session.invoke(src.pool, "mint_py", [
          aAddr(user1),
          aAddr(user1),
          aI128(1_000_000_000n),
          aU64(tPre - 1),
        ]),
        10,
        "DeadlineExpired"
      );
      for (const fn of [
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_pt",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
      ] as const) {
        expectContractError(
          await session.invoke(src.pool, fn, [
            aAddr(user1),
            aAddr(user1),
            aI128(500_000_000n),
            aI128(1),
            aU64(tPre - 1),
          ]),
          10,
          "DeadlineExpired"
        );
      }

      // Rollover pre-source: expired deadline -> #10 wins over #8; valid deadline -> #8 MarketNotYetMatured
      for (const fn of ["rollover_to_pt", "rollover_to_py"] as const) {
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(user1),
            aAddr(user1),
            aAddr(src.pool),
            aAddr(dst.pool),
            aI128(5_000_000_000n),
            aI128(1),
            aU64(tPre - 1),
          ]),
          10,
          "DeadlineExpired"
        );
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(user1),
            aAddr(user1),
            aAddr(src.pool),
            aAddr(dst.pool),
            aI128(5_000_000_000n),
            aI128(1),
            aU64(tPre),
          ]),
          8,
          "MarketNotYetMatured"
        );
      }

      // Phase 2: Exact source maturity (now = src.maturity < dst.maturity)
      const tSrcMat = Number(src.maturity);
      await session.setLedger({ timestamp: tSrcMat });

      // src.pool: deadline < now -> #10 wins over #7; deadline >= now -> #7 MarketAlreadyMatured
      expectContractError(
        await session.invoke(src.pool, "mint_py", [
          aAddr(user1),
          aAddr(user1),
          aI128(1_000_000_000n),
          aU64(tSrcMat - 1),
        ]),
        10,
        "DeadlineExpired"
      );
      expectContractError(
        await session.invoke(src.pool, "mint_py", [
          aAddr(user1),
          aAddr(user1),
          aI128(1_000_000_000n),
          aU64(tSrcMat),
        ]),
        7,
        "MarketAlreadyMatured"
      );
      for (const fn of [
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_pt",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
      ] as const) {
        expectContractError(
          await session.invoke(src.pool, fn, [
            aAddr(user1),
            aAddr(user1),
            aI128(500_000_000n),
            aI128(1),
            aU64(tSrcMat - 1),
          ]),
          10,
          "DeadlineExpired"
        );
        expectContractError(
          await session.invoke(src.pool, fn, [
            aAddr(user1),
            aAddr(user1),
            aI128(500_000_000n),
            aI128(1),
            aU64(tSrcMat),
          ]),
          7,
          "MarketAlreadyMatured"
        );
      }

      // Rollover post-src & pre-dst: deadline < now -> #10; deadline == now -> succeeds with zero dust!
      expectContractError(
        await session.invoke(factory, "rollover_to_pt", [
          aAddr(user1),
          aAddr(user1),
          aAddr(src.pool),
          aAddr(dst.pool),
          aI128(5_000_000_000n),
          aI128(1),
          aU64(tSrcMat - 1),
        ]),
        10,
        "DeadlineExpired"
      );
      const [syFromPtRoll, dstPtOut] = await mustInvoke<[string, string]>(
        session,
        factory,
        "rollover_to_pt",
        [
          aAddr(user1),
          aAddr(user1),
          aAddr(src.pool),
          aAddr(dst.pool),
          aI128(5_000_000_000n),
          aI128(1),
          aU64(tSrcMat),
        ]
      );
      expect(BigInt(syFromPtRoll)).toBeGreaterThan(0n);
      expect(BigInt(dstPtOut)).toBeGreaterThan(0n);

      expectContractError(
        await session.invoke(factory, "rollover_to_py", [
          aAddr(user1),
          aAddr(user1),
          aAddr(src.pool),
          aAddr(dst.pool),
          aI128(5_000_000_000n),
          aI128(1),
          aU64(tSrcMat - 1),
        ]),
        10,
        "DeadlineExpired"
      );
      const [syFromPyRoll, dstPyOut] = await mustInvoke<[string, string]>(
        session,
        factory,
        "rollover_to_py",
        [
          aAddr(user1),
          aAddr(user1),
          aAddr(src.pool),
          aAddr(dst.pool),
          aI128(5_000_000_000n),
          aI128(1),
          aU64(tSrcMat),
        ]
      );
      expect(BigInt(syFromPyRoll)).toBeGreaterThan(0n);
      expect(BigInt(dstPyOut)).toBeGreaterThan(0n);
      await assertFactoryZeroDust(session, factory, [src.sy, src.pt, dst.pt, dst.yt]);

      // Phase 3: Post-target maturity (now = dst.maturity)
      const tDstMat = Number(dst.maturity);
      await session.setLedger({ timestamp: tDstMat });
      expectContractError(
        await session.invoke(factory, "rollover_to_pt", [
          aAddr(user1),
          aAddr(user1),
          aAddr(src.pool),
          aAddr(dst.pool),
          aI128(1_000_000_000n),
          aI128(1),
          aU64(tDstMat - 1),
        ]),
        10,
        "DeadlineExpired"
      );
      expectContractError(
        await session.invoke(factory, "rollover_to_pt", [
          aAddr(user1),
          aAddr(user1),
          aAddr(src.pool),
          aAddr(dst.pool),
          aI128(1_000_000_000n),
          aI128(1),
          aU64(tDstMat),
        ]),
        7,
        "MarketAlreadyMatured"
      );
    }, 60_000);

    it("T3-F9+F10: Slender (sy-sUSDC) + single-tx Zap-In (PT/YT/LP) with rate accrual, zero dust, and reserve conservation", async () => {
      const { admin, factory } = await setupFactory(session, T0);
      const lp = await session.genAddress("lp");
      const u1 = await session.genAddress("u1");
      const usdc = await session.createSac("USDC", { admin });

      const { slender, sySlender } = await deploySlenderAndWrapper(session, admin, usdc);
      const slMat = T0 + 90 * DAY;
      const slPt = await session.deployWasm("pt_token.wasm");
      const slYt = await session.deployWasm("yt_token.wasm");
      const slPool = await session.deployWasm("yield_pool.wasm");

      await mustInvoke(session, slPt, "initialize", [
        aAddr(admin),
        aAddr(slPool),
        aStr("PT sUSDC 90D"),
        aStr("PT-sUSDC-90D"),
        aU32(7),
        aU64(slMat),
      ]);
      await mustInvoke(session, slYt, "initialize", [
        aAddr(admin),
        aAddr(slPool),
        aAddr(sySlender),
        aStr("YT sUSDC 90D"),
        aStr("YT-sUSDC-90D"),
        aU32(7),
        aU64(slMat),
      ]);
      await mustInvoke(session, slPool, "initialize", [
        aAddr(admin),
        aAddr(sySlender),
        aAddr(slPt),
        aAddr(slYt),
        aU64(slMat),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      await mustInvoke(session, factory, "register_market", [
        aAddr(admin),
        aAddr(slPool),
        aAddr(sySlender),
        aAddr(slPt),
        aAddr(slYt),
        aAddr(usdc),
        aU64(slMat),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);

      // Seed Slender pool (120B PT / 100B SY)
      await session.sacMint(usdc, lp, 220_000_000_000n);
      await mustInvoke(session, sySlender, "deposit", [
        aAddr(lp),
        aAddr(lp),
        aI128(220_000_000_000n),
      ]);
      await mustInvoke(session, slPool, "mint_py", [
        aAddr(lp),
        aAddr(lp),
        aI128(120_000_000_000n),
        aU64(slMat),
      ]);
      await mustInvoke(session, slPool, "add_liquidity", [
        aAddr(lp),
        aAddr(lp),
        aI128(120_000_000_000n),
        aI128(100_000_000_000n),
        aI128(1),
      ]);

      // Accrue Slender rate 1.0 -> 1.05
      await setSlenderRate(session, slender, 1_050_000_000n);
      await session.sacMint(usdc, slender, 11_000_000_000n);
      expect(await mustInvoke<string>(session, sySlender, "exchange_rate")).toBe("1050000000");

      const sharesBefore = BigInt(await mustInvoke<string>(session, sySlender, "total_shares"));
      await session.sacMint(usdc, u1, 300_000_000n);

      const ptOut = BigInt(
        await mustInvoke<string>(session, factory, "zap_in_pt", [
          aAddr(u1),
          aAddr(u1),
          aAddr(slPool),
          aI128(100_000_000n),
          aI128(1),
          aU64(T0 + 60),
        ])
      );
      const ytOut = BigInt(
        await mustInvoke<string>(session, factory, "zap_in_yt", [
          aAddr(u1),
          aAddr(u1),
          aAddr(slPool),
          aI128(100_000_000n),
          aI128(1),
          aU64(T0 + 60),
        ])
      );
      const [lpOut] = await mustInvoke<[string, string]>(session, factory, "zap_in_lp", [
        aAddr(u1),
        aAddr(u1),
        aAddr(slPool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);

      expect(ptOut).toBeGreaterThan(0n);
      expect(ytOut).toBeGreaterThan(0n);
      expect(BigInt(lpOut)).toBeGreaterThan(0n);

      const sharesAfter = BigInt(await mustInvoke<string>(session, sySlender, "total_shares"));
      const expectedSingleDepositShares = (100_000_000n * SCALAR_9) / 1_050_000_000n;
      expect(sharesAfter - sharesBefore).toBe(expectedSingleDepositShares * 3n);

      await assertFactoryZeroDust(session, factory, [usdc, sySlender, slPt, slYt, slPool]);
      await assertReserveConservation(session, sySlender, slPool, slPt, 2n, 1_050_000_000n);
    }, 60_000);

    it("T3-F10+F5+F3: Zap-In deadline boundary (now-1 vs now) + subsequent PT/YT swaps + fee conservation", async () => {
      const { lp, feeRecipient, factory, asset, meta } = await setupFactoryWithBlendMarket(
        session,
        "USDC",
        90,
        T0
      );
      void lp;
      const u1 = await session.genAddress("u1");
      await session.sacMint(asset, u1, 300_000_000n);
      const reservesBefore = await mustInvoke<[string, string]>(
        session,
        meta.pool,
        "get_reserves"
      );

      // Expired deadline (T0 - 1) must revert #10 across all 3 Zap-In entrypoints
      for (const fn of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        const res = await session.invoke(factory, fn, [
          aAddr(u1),
          aAddr(u1),
          aAddr(meta.pool),
          aI128(100_000_000n),
          aI128(1),
          aU64(T0 - 1),
        ]);
        expectContractError(res, 10, "DeadlineExpired");
      }
      expect(await mustInvoke<[string, string]>(session, meta.pool, "get_reserves")).toEqual(
        reservesBefore
      );
      expect(await mustInvoke<string>(session, asset, "balance", [aAddr(u1)])).toBe(
        "300000000"
      );
      await assertFactoryZeroDust(session, factory, [
        asset,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);

      // Inclusive deadline == T0 succeeds for all 3 Zap-In entrypoints
      const zappedPt = BigInt(
        await mustInvoke<string>(session, factory, "zap_in_pt", [
          aAddr(u1),
          aAddr(u1),
          aAddr(meta.pool),
          aI128(100_000_000n),
          aI128(1),
          aU64(T0),
        ])
      );
      const zappedYt = BigInt(
        await mustInvoke<string>(session, factory, "zap_in_yt", [
          aAddr(u1),
          aAddr(u1),
          aAddr(meta.pool),
          aI128(100_000_000n),
          aI128(1),
          aU64(T0),
        ])
      );
      const [zappedLp] = await mustInvoke<[string, string]>(session, factory, "zap_in_lp", [
        aAddr(u1),
        aAddr(u1),
        aAddr(meta.pool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0),
      ]);
      expect(zappedPt).toBeGreaterThan(0n);
      expect(zappedYt).toBeGreaterThan(0n);
      expect(BigInt(zappedLp)).toBeGreaterThan(0n);
      expect(await mustInvoke<string>(session, asset, "balance", [aAddr(u1)])).toBe("0");
      await assertFactoryZeroDust(session, factory, [
        asset,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);

      // Subsequent swaps on zapped PT & YT accrue feeRecipient and conserve reserves
      const syFeeBefore = BigInt(
        await mustInvoke<string>(session, meta.sy, "balance", [aAddr(feeRecipient)])
      );
      await mustInvoke(session, meta.pool, "swap_exact_pt_for_sy", [
        aAddr(u1),
        aAddr(u1),
        aI128(zappedPt / 2n),
        aI128(1),
        aU64(T0),
      ]);
      await mustInvoke(session, meta.pool, "swap_exact_yt_for_sy", [
        aAddr(u1),
        aAddr(u1),
        aI128(zappedYt / 2n),
        aI128(1),
        aU64(T0),
      ]);
      const syFeeAfter = BigInt(
        await mustInvoke<string>(session, meta.sy, "balance", [aAddr(feeRecipient)])
      );
      expect(syFeeAfter).toBeGreaterThan(syFeeBefore);
      await assertReserveConservation(session, meta.sy, meta.pool, meta.pt);
    }, 60_000);

    it("T3-F1+F9: multi-SY USDC coexistence via whitelisted creator without SyByAsset collision", async () => {
      const { admin, factory } = await setupFactory(session, T0);
      const creator1 = await session.genAddress("creator1");
      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);
      const { asset: usdc, blend } = await setupBlendAndAsset(session, admin, "USDC");

      // Live F1: creator1 creates Blend USDC 90D market -> SyByAsset(usdc) = sy-bUSDC
      const mBlend = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(usdc),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      expect(await mustInvoke<string>(session, mBlend.sy, "symbol")).toBe("sy-bUSDC");

      // Unmerged F9: deploy Slender SY + pool
      const { sySlender } = await deploySlenderAndWrapper(session, admin, usdc);
      const slMat = T0 + 60 * DAY;
      const slPt = await session.deployWasm("pt_token.wasm");
      const slYt = await session.deployWasm("yt_token.wasm");
      const slPool = await session.deployWasm("yield_pool.wasm");
      await mustInvoke(session, slPt, "initialize", [
        aAddr(admin),
        aAddr(slPool),
        aStr("PT sUSDC 60D"),
        aStr("PT-sUSDC-60D"),
        aU32(7),
        aU64(slMat),
      ]);
      await mustInvoke(session, slYt, "initialize", [
        aAddr(admin),
        aAddr(slPool),
        aAddr(sySlender),
        aStr("YT sUSDC 60D"),
        aStr("YT-sUSDC-60D"),
        aU32(7),
        aU64(slMat),
      ]);
      await mustInvoke(session, slPool, "initialize", [
        aAddr(admin),
        aAddr(sySlender),
        aAddr(slPt),
        aAddr(slYt),
        aU64(slMat),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);

      // Whitelisted-only creator1 CANNOT call register_market or set_sy_for_asset
      expectContractError(
        await session.invoke(factory, "register_market", [
          aAddr(creator1),
          aAddr(slPool),
          aAddr(sySlender),
          aAddr(slPt),
          aAddr(slYt),
          aAddr(usdc),
          aU64(slMat),
          aI128(SCALAR_ROOT),
          aI128(POS_ANCHOR),
        ]),
        3,
        "Unauthorized"
      );
      expectContractError(
        await session.invoke(factory, "set_sy_for_asset", [
          aAddr(creator1),
          aAddr(usdc),
          aAddr(sySlender),
        ]),
        3,
        "Unauthorized"
      );

      // Admin registers Slender market; Blend SyByAsset stays preserved
      await mustInvoke(session, factory, "register_market", [
        aAddr(admin),
        aAddr(slPool),
        aAddr(sySlender),
        aAddr(slPt),
        aAddr(slYt),
        aAddr(usdc),
        aU64(slMat),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);

      const mBlend120 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(usdc),
        aAddr(blend),
        aU64(T0 + 120 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      expect(mBlend120.sy).toBe(mBlend.sy);
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(usdc)])
      ).toBe(mBlend.sy);
      const slLookup = await mustInvoke<MarketMetadata | null>(
        session,
        factory,
        "get_market_by_pool",
        [aAddr(slPool)]
      );
      expect(slLookup?.sy).toBe(sySlender);
      expect(await mustInvoke<string>(session, sySlender, "symbol")).toBe("sy-sUSDC");
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(3);
    }, 60_000);
  });

  // =========================================================================
  // Section B: Offchain x Offchain & UI Pairwise Interactions (5 tests)
  // =========================================================================
  describe("B. Offchain x Offchain & UI Pairwise", () => {
    it("T3-F6+F7: real BFF charts, timeseries & positions overwrite client secret and preserve port 8765 & $0.12 XLM parity", async () => {
      expect(resolveHttpPort(undefined)).toBe(CANONICAL_INDEXER_PORT);
      expect(readFileText("frontend/src/app/api/indexer/[...path]/route.ts")).toContain(
        "http://127.0.0.1:8765"
      );

      const nowSec = Math.floor(Date.now() / 1000);
      const idx = await startIndexerHarness({
        secret: TEST_SECRET,
        seed(storage) {
          storage.recordMintPy({
            marketId: "xlm-90d",
            caller: TEST_USER,
            receiver: TEST_USER,
            syIn: 1000_0000000n,
            pyOut: 1000_0000000n,
            timestamp: nowSec - 1800,
            spotPtPrice: 0.9735,
          });
          storage.recordSwap({
            marketId: "xlm-90d",
            caller: TEST_USER,
            receiver: TEST_USER,
            direction: 1,
            amountIn: 100_0000000n,
            amountOut: 102_5000000n,
            fee: 200000n,
            reservesSy: 1000_0000000n,
            reservesPt: 1025_0000000n,
            timestamp: nowSec - 900,
          });
        },
      });

      try {
        expect(idx.port).not.toBe(CANONICAL_INDEXER_PORT);

        // Direct unauthenticated / spoofed call to indexer must return 401
        const spoofDirect = await globalThis.fetch(`${idx.baseUrl}/health`, {
          headers: { "x-indexer-secret": "client-spoof" },
        });
        expect(spoofDirect.status).toBe(401);

        await withBffEnv(
          { indexerInternalUrl: idx.baseUrl, indexerApiSecret: idx.secret },
          async () => {
            const [chartsRes, tsRes, posRes] = await Promise.all([
              callBffGetRaw({
                url: "/api/indexer/charts?market=xlm-90d&interval=1D",
                headers: { "x-indexer-secret": "client-spoof" },
              }),
              callBffGetRaw({
                url: `/api/indexer/timeseries?market=${CANONICAL_XLM_90D.poolId}&interval=1D`,
              }),
              callBffGetRaw({
                url: `/api/indexer/positions?user=${TEST_USER}`,
              }),
            ]);

            expect(chartsRes.status).toBe(200);
            expect(chartsRes.headers.get("cache-control")).toBe(
              "public, s-maxage=3, stale-while-revalidate=10"
            );
            const chartsJson = (await chartsRes.json()) as {
              market: string;
              count: number;
              data: Array<{ ptPrice: number; impliedApy: number }>;
            };
            expect(chartsJson.market).toBe("xlm-90d");
            expect(chartsJson.count).toBe(24);
            expect(Number.isFinite(chartsJson.data[0]!.ptPrice)).toBe(true);
            expect(Number.isFinite(chartsJson.data[0]!.impliedApy)).toBe(true);

            expect(tsRes.status).toBe(200);
            expect(tsRes.headers.get("cache-control")).toBe(
              "public, s-maxage=3, stale-while-revalidate=10"
            );
            const tsJson = (await tsRes.json()) as { market: string; count: number };
            expect(tsJson.market).toBe("xlm-90d");
            expect(tsJson.count).toBe(24);

            expect(posRes.status).toBe(200);
            expect(posRes.headers.get("cache-control")).toBe("private, no-store");
            const posJson = (await posRes.json()) as {
              positions: Array<{ marketId: string; costBasisUsd: number }>;
            };
            const xlmPos = posJson.positions.find((p) => p.marketId === "xlm-90d");
            expect(xlmPos).toBeDefined();
            expect(xlmPos!.costBasisUsd).toBeGreaterThan(100);
            expect(xlmPos!.costBasisUsd).toBeCloseTo(132, -1); // ~1000-1100 XLM * $0.12
          }
        );
      } finally {
        await idx.stop();
      }
    }, 30_000);

    it("T3-F6+F8: BFF upstream 502 degrades gracefully through fetchMarketChartData/fetchUserPositionData into InteractiveYieldChart honest empty state", async () => {
      const closedUrl = await getClosedLocalUrl();
      const closedPort = new URL(closedUrl).port;
      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;

      const { chartRes, posRes } = await withRealBffBridge(
        { indexerInternalUrl: closedUrl, indexerApiSecret: TEST_SECRET },
        async (bffBaseUrl) => {
          const raw502 = await callBffGetRaw({
            url: "/api/indexer/charts?market=usdc-90d&interval=1W",
          });
          expect(raw502.status).toBe(502);
          expect(raw502.headers.get("cache-control")).toBe("no-store");
          const rawText = await raw502.text();
          expect(rawText).not.toContain("127.0.0.1");
          expect(rawText).not.toContain(closedPort);
          expect(rawText).not.toContain(TEST_SECRET);
          expect(JSON.parse(rawText)).toEqual({
            success: false,
            status: "offline",
            error: "Indexer upstream unavailable",
          });

          const [cRes, pRes] = await Promise.all([
            fetchMarketChartData({
              market: "usdc-90d",
              interval: "1W",
              indexerApiUrl: bffBaseUrl,
            }),
            fetchUserPositionData({
              userAddress: TEST_USER,
              indexerApiUrl: bffBaseUrl,
            }),
          ]);
          return { chartRes: cRes, posRes: pRes };
        }
      );

      expect(chartRes.success).toBe(true);
      expect(chartRes.count).toBe(0);
      expect(chartRes.data).toEqual([]);
      expect(chartRes.summary.tvl).toBe(0);

      expect(posRes.success).toBe(true);
      expect(posRes.count).toBe(0);
      expect(posRes.positions).toEqual([]);
      expect(posRes.summary.totalCurrentValueUsd).toBe(0);

      const chartPoints = convertToChartDataPoints(chartRes.data);
      expect(chartPoints).toEqual([]);

      const mounted = await mountFrontendDom(
        React.createElement(InteractiveYieldChart, {
          market: usdc90d,
          data: chartPoints,
          snapshot: null,
          analytics: null,
          loading: false,
        })
      );
      try {
        const html = mounted.container.innerHTML;
        const text = mounted.container.textContent ?? "";
        expect(text).toContain("No indexed swap events yet");
        expect(text).toContain("--");
        expect(text).not.toContain("8.45%");
        expect(text).not.toContain("5.40%");
        expect(text).not.toContain("NaN");
        expect(html).not.toContain('stroke-linecap="round"');
      } finally {
        await mounted.unmount();
      }
    }, 30_000);

    it("T3-F7+F8: xlm-90d $0.12 parity across indexer & parseMarketPosition + usdc-matured post-maturity into YieldBreakdownCards & SwapCard", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const xlm90d = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
      const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

      const idx = await startIndexerHarness({
        secret: TEST_SECRET,
        seed(storage) {
          storage.recordMintPy({
            marketId: "xlm-90d",
            caller: TEST_USER,
            receiver: TEST_USER,
            syIn: 500_0000000n,
            pyOut: 500_0000000n,
            timestamp: nowSec - 120,
            spotPtPrice: 0.9735,
          });
          storage.recordMintPy({
            marketId: "usdc-matured",
            caller: TEST_USER,
            receiver: TEST_USER,
            syIn: 250_0000000n,
            pyOut: 250_0000000n,
            timestamp: nowSec - 120,
          });
        },
      });

      try {
        const { posRes, maturedChart } = await withRealBffBridge(
          { indexerInternalUrl: idx.baseUrl, indexerApiSecret: idx.secret },
          async (bffBaseUrl) => {
            const [pRes, mChart] = await Promise.all([
              fetchUserPositionData({ userAddress: TEST_USER, indexerApiUrl: bffBaseUrl }),
              fetchMarketChartData({
                market: "usdc-matured",
                interval: "1D",
                indexerApiUrl: bffBaseUrl,
              }),
            ]);
            return { posRes: pRes, maturedChart: mChart };
          }
        );

        const xlmPos = posRes.positions.find((p) => p.marketId === "xlm-90d");
        expect(xlmPos).toBeDefined();
        expect(xlmPos!.costBasisUsd).toBeCloseTo(500 * CANONICAL_XLM_PRICE_USD, 5); // 60.00

        const port500Pt: LiveUserPortfolio = {
          ...makeActivePortfolio(),
          syBalance: 0n,
          ptBalance: 500_0000000n,
          ytBalance: 0n,
          lpBalance: 0n,
        };
        const xlmMetric: MarketSummaryMetrics = {
          marketId: "xlm-90d",
          status: "ACTIVE",
          daysToMaturity: 80,
          impliedApyPct: 0,
          blendRate: 1.0,
          ptPriceInSy: 1.0,
          tvlSy: 0n,
          tvlUsd: 0,
          ptReserve: 0n,
          syReserve: 0n,
          isMatured: false,
          isLoading: false,
        };
        expect(parseMarketPosition(xlm90d, port500Pt, xlmMetric).totalValueUsd).toBeCloseTo(
          60,
          5
        );

        expect(maturedChart.count).toBe(24);
        for (const pt of maturedChart.data) {
          expect(pt.ptPrice).toBe(1);
          expect(pt.ytPrice).toBe(0);
          expect(pt.impliedApy).toBe(0);
        }

        const maturedSnapshot: LiveMarketSnapshot = {
          ...makeActiveSnapshot(usdcMatured),
          state: {
            ...makeActiveSnapshot(usdcMatured).state,
            maturity: BigInt(CANONICAL_USDC_MATURED.maturity),
            is_settled: true,
          },
          daysToMaturity: 0,
          isMatured: true,
          ptPriceInSy: 1.0,
          ytPriceInSy: 0.0,
          impliedFixedApyPct: 0,
        };

        const breakdownHtml = renderFrontendHtml(
          React.createElement(YieldBreakdownCards, {
            market: usdcMatured,
            snapshot: maturedSnapshot,
            analytics: null,
            loading: false,
          })
        );
        expect(breakdownHtml).toContain("0.00%");
        expect(breakdownHtml).toContain("Matured");
        expect(breakdownHtml).toContain("Market expired");
        expect(breakdownHtml).toContain("--");
        expect(breakdownHtml).not.toContain("NaN");
        expect(breakdownHtml).not.toContain("Infinity");

        const mounted = await mountFrontendDom(
          React.createElement(
            WithSeededWallet,
            { address: TEST_USER },
            React.createElement(MarketProvider, {
              initialMarketId: "usdc-matured",
              children: React.createElement(SwapCard, {
                snapshot: maturedSnapshot,
                portfolio: makeActivePortfolio(),
                busyAction: null,
                onExecuteAction: async () => {},
              }),
            })
          )
        );
        try {
          await act(async () => {
            await Bun.sleep(25);
          });
          const text = mounted.container.textContent ?? "";
          expect(text).toContain("Market Matured");
          expect(text).toContain("Market Matured - Swaps Closed");
          expect(text).toContain("+0.00%");
          expect(text).not.toContain("NaN");
          const buttons = [...mounted.container.querySelectorAll("button")];
          const cta = buttons.find((b) =>
            (b.textContent ?? "").includes("Market Matured - Swaps Closed")
          );
          expect(cta).toBeDefined();
          expect(cta!.disabled).toBe(true);
        } finally {
          mounted.window.localStorage.removeItem("stellar_pendle_wallet_session");
          await mounted.unmount();
        }
      } finally {
        await idx.stop();
      }
    }, 60_000);

    it("T3-F7+F11: sUSDC market catalog resolution in indexer, PRESET_MARKETS, and MarketExplorerTable with SHA-256 & 5-key locks intact", async () => {
      const configLock = await verifyContractsConfigLock();
      expect(configLock.ok).toBe(true);
      expect(configLock.keys).toEqual([
        "mock_blend",
        "sy_blend_wrapper",
        "pt_token",
        "yt_token",
        "yield_pool",
      ]);
      const shaLock = await verifyLockedSha256();
      expect(shaLock.ok).toBe(true);

      const sUsdc = PRESET_MARKETS.find(
        (m) => m.sySymbol === "sy-sUSDC" || /susdc|slender/i.test(m.id)
      );
      expect(sUsdc).toBeDefined();
      expect(sUsdc!.id).not.toBe("usdc-90d");

      const indexerSusdc = MARKETS[sUsdc!.id];
      expect(indexerSusdc).toBeDefined();
      expect(indexerSusdc!.poolId).toBe(sUsdc!.contracts.poolId);
      expect(indexerSusdc!.syId).toBe(sUsdc!.contracts.syId);
      expect(indexerSusdc!.ptId).toBe(sUsdc!.contracts.ptId);
      expect(indexerSusdc!.ytId).toBe(sUsdc!.contracts.ytId);
      const catalogIds = new Set(CONTRACT_CATALOG.map((c) => c.id));
      expect(catalogIds.has(sUsdc!.contracts.poolId)).toBe(true);
      expect(catalogIds.has(sUsdc!.contracts.syId)).toBe(true);

      const idx = await startIndexerHarness({ secret: TEST_SECRET });
      try {
        await withBffEnv(
          { indexerInternalUrl: idx.baseUrl, indexerApiSecret: idx.secret },
          async () => {
            const [bySlug, byPool] = await Promise.all([
              callBffGetRaw({
                url: `/api/indexer/charts?market=${encodeURIComponent(sUsdc!.id)}&interval=1D`,
              }),
              callBffGetRaw({
                url: `/api/indexer/charts?market=${encodeURIComponent(sUsdc!.contracts.poolId)}&interval=1D`,
              }),
            ]);
            expect(bySlug.status).toBe(200);
            expect(byPool.status).toBe(200);
            expect(((await bySlug.json()) as { market: string }).market).toBe(sUsdc!.id);
            expect(((await byPool.json()) as { market: string }).market).toBe(sUsdc!.id);
          }
        );
      } finally {
        await idx.stop();
      }

      const mounted = await mountFrontendDom(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
            null,
            React.createElement(MarketExplorerTable, {})
          )
        )
      );
      try {
        const text = mounted.container.textContent ?? "";
        expect(text).toContain("PT-bUSDC-90D");
        expect(text).toContain(sUsdc!.ptSymbol);
      } finally {
        await mounted.unmount();
      }
    }, 60_000);

    it("T3-F8+F11: SwapCard honest zero-liquidity display + swap_exact_* busy key + PoolsPageClient/MarketsPageClient TopNav wiring", async () => {
      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;

      // 1. PoolsPageClient & MarketsPageClient TopNav wiring + honest $0 liquidity
      const zeroMetrics: Record<string, MarketSummaryMetrics> = {};
      for (const m of PRESET_MARKETS) {
        zeroMetrics[m.id] = {
          marketId: m.id,
          status: m.id === "usdc-matured" ? "MATURED" : "ACTIVE",
          daysToMaturity: m.id === "usdc-matured" ? 0 : 90,
          impliedApyPct: 0,
          blendRate: 1.0,
          ptPriceInSy: 1.0,
          tvlSy: 0n,
          tvlUsd: 0,
          ptReserve: 0n,
          syReserve: 0n,
          isMatured: m.id === "usdc-matured",
          isLoading: false,
        };
      }

      const poolsMount = await mountFrontendDom(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
            null,
            React.createElement(
              ToastProvider,
              null,
              React.createElement(
                PoolsPageClient as React.ComponentType<PoolsPageClientProps>,
                { marketMetricsOverride: zeroMetrics }
              )
            )
          )
        )
      );
      try {
        const text = poolsMount.container.textContent ?? "";
        expect(text).toContain("$0");
        expect(text).toContain("0 PT (0%)");
        expect(text).toContain("0 SY (0%)");
        const faucetBtn = poolsMount.container.querySelector(
          'button[title="Get Testnet Assets (Faucet)"]'
        ) as HTMLButtonElement | null;
        expect(faucetBtn).not.toBeNull();
        await act(async () => {
          faucetBtn!.click();
        });
        const dialog = poolsMount.window.document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).toContain("Testnet Asset Faucet");
      } finally {
        await poolsMount.unmount();
      }

      expect(
        scanSourceForIdentifiers("frontend/src/app/markets/MarketsPageClient.tsx", [
          "onRefresh={() => {}}",
        ])
      ).toEqual([]);
      const marketsMount = await mountFrontendDom(
        React.createElement(
          WalletProvider,
          null,
          React.createElement(
            MarketProvider,
            null,
            React.createElement(ToastProvider, null, React.createElement(MarketsPageClient))
          )
        )
      );
      try {
        const faucetBtn = marketsMount.container.querySelector(
          'button[title="Get Testnet Assets (Faucet)"]'
        ) as HTMLButtonElement | null;
        expect(faucetBtn).not.toBeNull();
        await act(async () => {
          faucetBtn!.click();
        });
        const dialog = marketsMount.window.document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).toContain("Testnet Asset Faucet");
      } finally {
        await marketsMount.unmount();
      }

      // 2. SwapCard zero-liquidity snapshot === null must show '--' (never '8.45%' or '50x')
      const swapNullMount = await mountFrontendDom(
        React.createElement(
          WithSeededWallet,
          { address: TEST_USER },
          React.createElement(MarketProvider, {
            initialMarketId: "usdc-90d",
            children: React.createElement(SwapCard, {
              snapshot: null,
              portfolio: makeActivePortfolio(),
              busyAction: null,
              onExecuteAction: async () => {},
            }),
          })
        )
      );
      try {
        await act(async () => {
          await Bun.sleep(25);
        });
        const text = swapNullMount.container.textContent ?? "";
        expect(text).toContain("--");
        expect(text).not.toContain("8.45%");
        expect(text).not.toContain("50x");
      } finally {
        swapNullMount.window.localStorage.removeItem("stellar_pendle_wallet_session");
        await swapNullMount.unmount();
      }

      // 3. SwapCard scoped swap_exact_sy_for_pt busy key lock
      const swapBusyMount = await mountFrontendDom(
        React.createElement(
          WithSeededWallet,
          { address: TEST_USER },
          React.createElement(MarketProvider, {
            initialMarketId: "usdc-90d",
            children: React.createElement(SwapCard, {
              snapshot: makeActiveSnapshot(usdc90d),
              portfolio: makeActivePortfolio(),
              busyAction: null,
              busyActions: {
                [`${usdc90d.contracts.poolId}:swap_exact_sy_for_pt`]: "Confirming Swap...",
              },
              onExecuteAction: async () => {},
            }),
          })
        )
      );
      try {
        await act(async () => {
          await Bun.sleep(25);
        });
        const pctBtn = [...swapBusyMount.container.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === "25%"
        );
        if (pctBtn) {
          await act(async () => {
            pctBtn.click();
          });
        }
        const cta = [...swapBusyMount.container.querySelectorAll("button")].find(
          (b) =>
            (b.textContent ?? "").includes("Confirming Swap...") ||
            (b.textContent ?? "").includes("Execute Swap")
        );
        expect(cta).toBeDefined();
        expect(cta!.textContent?.trim()).toBe("Confirming Swap...");
        expect(cta!.disabled).toBe(true);
      } finally {
        swapBusyMount.window.localStorage.removeItem("stellar_pendle_wallet_session");
        await swapBusyMount.unmount();
      }
    }, 60_000);
  });

  // =========================================================================
  // Section C: Cross-Layer XDR, Agent MCP, Scripts & SQLite WAL (5 tests)
  // =========================================================================
  describe("C. Cross-Layer XDR -> WASM, Agent MCP, Scripts & WAL", () => {
    it("T3-X1 (F10+F11): stellar.ts buildActionArgs Zap-In ScVal args execute against Soroban market_factory WASM (USDC & native XLM)", async () => {
      const deadline = BigInt(T0 + 600);

      for (const symbol of ["USDC", "native"] as const) {
        const { factory, asset, blend, meta, maturity } =
          await setupFactoryWithBlendMarket(session, symbol, 90, T0);
        const user =
          symbol === "native"
            ? await session.genAccount("u1_xlm", "1000000000000")
            : await session.genAddress("u1_usdc");
        if (symbol === "USDC") {
          await session.sacMint(asset, user, 300_000_000n);
        }

        const marketDef = makeSessionMarketDef({
          id: symbol === "USDC" ? "usdc-90d" : "xlm-90d",
          assetCode: symbol === "USDC" ? "USDC" : "XLM",
          sacId: asset,
          poolId: meta.pool,
          syId: meta.sy,
          ptId: meta.pt,
          ytId: meta.yt,
          blendPoolId: blend,
          maturity,
          sySymbol: symbol === "USDC" ? "sy-bUSDC" : "sy-bXLM",
        });

        for (const method of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
          const amt = 100_000_000n;
          const encoded = buildActionArgsCompat(
            {
              type: method,
              caller: user,
              receiver: user,
              pool: meta.pool,
              poolId: meta.pool,
              underlyingAmount: amt,
              amount: amt,
              amountIn: amt,
              minOut: 1n,
              minPtOut: 1n,
              minYtOut: 1n,
              minLpOut: 1n,
              deadline,
            },
            marketDef,
            deadline
          );

          expect(encoded).toBeDefined();
          expect(encoded.contractId).toBe(STELLAR_PENDLE_CONFIG.market_factory.contractId);
          expect(encoded.method).toBe(method);
          expect(encoded.args.length).toBe(6);

          const inspected = inspectScValArgs(encoded.args);
          expect(inspected.map((a) => a.xdrType)).toEqual([
            "scvAddress",
            "scvAddress",
            "scvAddress",
            "scvI128",
            "scvI128",
            "scvU64",
          ]);

          await mustInvoke(session, factory, encoded.method, scValsToTypedArgs(encoded.args));
        }

        expect(
          BigInt(await mustInvoke<string>(session, meta.pt, "balance", [aAddr(user)]))
        ).toBeGreaterThan(0n);
        expect(
          BigInt(await mustInvoke<string>(session, meta.yt, "balance", [aAddr(user)]))
        ).toBeGreaterThan(0n);
        expect(
          BigInt(await mustInvoke<string>(session, meta.pool, "balance", [aAddr(user)]))
        ).toBeGreaterThan(0n);
        await assertFactoryZeroDust(session, factory, [
          asset,
          meta.sy,
          meta.pt,
          meta.yt,
          meta.pool,
        ]);
      }
    }, 60_000);

    it("T3-X2 (F5+F11): stellar.ts & agent/src/client.ts deadline: u64 XDR ScVal args succeed when valid and revert #10 when 0n in yield_pool WASM", async () => {
      const nowWall = Math.floor(Date.now() / 1000);
      const { lp, asset, blend, meta, maturity } = await setupFactoryWithBlendMarket(
        session,
        "USDC",
        90,
        nowWall
      );
      const userG = await session.genAccount("user_g");
      await session.sacMint(asset, lp, 50_000_0000000n);
      await mustInvoke(session, meta.sy, "deposit", [
        aAddr(lp),
        aAddr(userG),
        aI128(50_000_0000000n),
      ]);

      const validDeadline = BigInt(nowWall + 600);
      const marketDef = makeSessionMarketDef({
        id: "usdc-90d",
        assetCode: "USDC",
        sacId: asset,
        poolId: meta.pool,
        syId: meta.sy,
        ptId: meta.pt,
        ytId: meta.yt,
        blendPoolId: blend,
        maturity,
        sySymbol: "sy-bUSDC",
      });

      // Frontend stellar.ts: mint_py & swap_exact_sy_for_pt (valid + 0n)
      const feMintValid = buildActionArgsCompat(
        { type: "mint_py", caller: userG, amount: 5_000_0000000n, deadline: validDeadline },
        marketDef,
        validDeadline
      );
      expect(feMintValid.args.length).toBe(4);
      expect(inspectScValArgs(feMintValid.args)[3]!.xdrType).toBe("scvU64");
      await mustInvoke(
        session,
        meta.pool,
        feMintValid.method,
        scValsToTypedArgs(feMintValid.args)
      );

      const feMintZero = buildActionArgsCompat(
        { type: "mint_py", caller: userG, amount: 5_000_0000000n, deadline: 0n },
        marketDef,
        0n
      );
      expect(feMintZero.args.length).toBe(4);
      expectContractError(
        await session.invoke(meta.pool, feMintZero.method, scValsToTypedArgs(feMintZero.args)),
        10,
        "DeadlineExpired"
      );

      const feSwapValid = buildActionArgsCompat(
        {
          type: "swap",
          caller: userG,
          method: "swap_exact_sy_for_pt",
          amountIn: 2_000_000_000n,
          minOut: 1n,
          deadline: validDeadline,
        },
        marketDef,
        validDeadline
      );
      expect(feSwapValid.args.length).toBe(5);
      expect(inspectScValArgs(feSwapValid.args)[4]!.xdrType).toBe("scvU64");
      await mustInvoke(
        session,
        meta.pool,
        feSwapValid.method,
        scValsToTypedArgs(feSwapValid.args)
      );

      const feSwapZero = buildActionArgsCompat(
        {
          type: "swap",
          caller: userG,
          method: "swap_exact_sy_for_pt",
          amountIn: 2_000_000_000n,
          minOut: 1n,
          deadline: 0n,
        },
        marketDef,
        0n
      );
      expect(feSwapZero.args.length).toBe(5);
      expectContractError(
        await session.invoke(meta.pool, feSwapZero.method, scValsToTypedArgs(feSwapZero.args)),
        10,
        "DeadlineExpired"
      );

      const feSwapOversized = buildActionArgsCompat(
        {
          type: "swap",
          caller: userG,
          method: "swap_exact_sy_for_pt",
          amountIn: 1_000_0000000n,
          minOut: 1n,
          deadline: validDeadline,
        },
        marketDef,
        validDeadline
      );
      expect(feSwapOversized.args.length).toBe(5);
      expectContractError(
        await session.invoke(
          meta.pool,
          feSwapOversized.method,
          scValsToTypedArgs(feSwapOversized.args)
        ),
        18,
        "NegativeYieldNotSupported"
      );

      // Agent SDK: buildMintPyTx & buildSwapTx (valid + 0n) -> decoded XDR -> WASM
      const manifest = JSON.parse(
        readFileSync(DEPLOYED_CONTRACTS_PATH, "utf8")
      ) as DeploymentManifest;
      manifest.contracts.yield_pool.contractId = meta.pool;
      manifest.contracts.sy_blend_wrapper.contractId = meta.sy;
      manifest.contracts.pt_token.contractId = meta.pt;
      manifest.contracts.yt_token.contractId = meta.yt;

      const rpcServer = startLocalSorobanRpcServer(userG);
      try {
        const client = new StellarPendleAgentClient({
          ...manifest,
          rpcUrl: "https://soroban-testnet.stellar.org",
        });
        (client as unknown as { rpcServer: rpc.Server }).rpcServer = new rpc.Server(
          `http://127.0.0.1:${rpcServer.port}`,
          { allowHttp: true }
        );

        const agMintValid = await (
          client.buildMintPyTx as unknown as BuildMintPyCompat
        ).call(client, userG, 2_000_0000000n, userG, validDeadline);
        const decMintValid = decodeUnsignedInvokeContractXdr(
          agMintValid.unsignedXdr,
          manifest.networkPassphrase
        );
        expect(decMintValid.args.length).toBe(4);
        await mustInvoke(
          session,
          decMintValid.contractId,
          decMintValid.functionName,
          scValsToTypedArgs(decMintValid.args.map((a) => a.raw))
        );

        const agMintZero = await (
          client.buildMintPyTx as unknown as BuildMintPyCompat
        ).call(client, userG, 2_000_0000000n, userG, 0n);
        const decMintZero = decodeUnsignedInvokeContractXdr(
          agMintZero.unsignedXdr,
          manifest.networkPassphrase
        );
        expect(decMintZero.args.length).toBe(4);
        expectContractError(
          await session.invoke(
            decMintZero.contractId,
            decMintZero.functionName,
            scValsToTypedArgs(decMintZero.args.map((a) => a.raw))
          ),
          10,
          "DeadlineExpired"
        );

        const agSwapValid = await (
          client.buildSwapTx as unknown as BuildSwapCompat
        ).call(client, userG, "sy_for_pt", 2_000_000_000n, 1n, userG, validDeadline);
        const decSwapValid = decodeUnsignedInvokeContractXdr(
          agSwapValid.unsignedXdr,
          manifest.networkPassphrase
        );
        expect(decSwapValid.args.length).toBe(5);
        await mustInvoke(
          session,
          decSwapValid.contractId,
          decSwapValid.functionName,
          scValsToTypedArgs(decSwapValid.args.map((a) => a.raw))
        );

        const agSwapZero = await (
          client.buildSwapTx as unknown as BuildSwapCompat
        ).call(client, userG, "sy_for_pt", 2_000_000_000n, 1n, userG, 0n);
        const decSwapZero = decodeUnsignedInvokeContractXdr(
          agSwapZero.unsignedXdr,
          manifest.networkPassphrase
        );
        expect(decSwapZero.args.length).toBe(5);
        expectContractError(
          await session.invoke(
            decSwapZero.contractId,
            decSwapZero.functionName,
            scValsToTypedArgs(decSwapZero.args.map((a) => a.raw))
          ),
          10,
          "DeadlineExpired"
        );
      } finally {
        rpcServer.stop(true);
      }
    }, 60_000);

    it("T3-X3 (F11+F6): scripts/register_markets.ts sandbox syncFrontendEnv preserves INDEXER_* placeholders and pairs with BFF + Indexer auth", async () => {
      const deployedShaBefore = await computeFileSha256("deployed_contracts.json");
      const envProdShaBefore = await computeFileSha256("frontend/.env.production");
      const envLocalShaBefore = await computeFileSha256("frontend/.env.local");

      const sandbox = mkdtempSync(join(tmpdir(), "nivora-t3-reg-sandbox-"));
      try {
        mkdirSync(join(sandbox, "scripts"), { recursive: true });
        mkdirSync(join(sandbox, "frontend"), { recursive: true });
        copyFileSync(
          join(REPO_ROOT, "scripts", "register_markets.ts"),
          join(sandbox, "scripts", "register_markets.ts")
        );
        copyFileSync(DEPLOYED_CONTRACTS_PATH, join(sandbox, "deployed_contracts.json"));
        copyFileSync(
          join(REPO_ROOT, "frontend", ".env.production"),
          join(sandbox, "frontend", ".env.production")
        );
        copyFileSync(
          join(REPO_ROOT, "frontend", ".env.local"),
          join(sandbox, "frontend", ".env.local")
        );

        const proc = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            'import { loadDeployedContracts, syncFrontendEnv } from "./scripts/register_markets.ts"; syncFrontendEnv(loadDeployedContracts());',
          ],
          { cwd: sandbox, env: process.env, stdout: "pipe", stderr: "pipe" }
        );
        expect(proc.exitCode).toBe(0);

        const envProd = readFileSync(join(sandbox, "frontend", ".env.production"), "utf8");
        const envLocal = readFileSync(join(sandbox, "frontend", ".env.local"), "utf8");
        for (const content of [envProd, envLocal]) {
          expect(content).toContain('NEXT_PUBLIC_INDEXER_API_URL="/api/indexer"');
          expect(content).toContain('INDEXER_INTERNAL_URL="http://127.0.0.1:8765"');
          expect(content).toContain('INDEXER_API_SECRET="replace_with_32_byte_hex_secret"');
          expect(content).not.toContain("trycloudflare.com");
          expect(content).not.toContain("3001");
          expect(content).not.toContain(LEAKED_HEX_SECRET);
        }

        const secretMatch = envProd.match(/INDEXER_API_SECRET="([^"]+)"/);
        expect(secretMatch).not.toBeNull();
        const parsedSecret = secretMatch![1]!;

        const idx = await startIndexerHarness({ secret: parsedSecret });
        try {
          const res = await invokeBffGet({
            url: "/api/indexer/health",
            indexerInternalUrl: idx.baseUrl,
            indexerApiSecret: parsedSecret,
          });
          expect(res.status).toBe(200);
          expect(((await res.json()) as { status: string }).status).toBe("healthy");
        } finally {
          await idx.stop();
        }

        const regMarkets = buildRegisteredMarkets();
        const xlm = regMarkets.find((m) => m.id === "xlm-90d");
        expect(xlm?.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
        expect(xlm?.contracts.pool).toBe(CANONICAL_XLM_90D.poolId);
        const matured = regMarkets.find((m) => m.id === "usdc-matured");
        expect(matured?.factoryId).toBe(CANONICAL_USDC_MATURED.factoryId);
        expect(matured?.contracts.pool).toBe(CANONICAL_USDC_MATURED.poolId);
        const susdc = regMarkets.find((m) => /susdc|slender/i.test(m.id) || /susdc|slender/i.test(m.name));
        expect(susdc).toBeDefined();
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }

      expect(await computeFileSha256("deployed_contracts.json")).toBe(deployedShaBefore);
      expect(await computeFileSha256("frontend/.env.production")).toBe(envProdShaBefore);
      expect(await computeFileSha256("frontend/.env.local")).toBe(envLocalShaBefore);
    }, 30_000);

    it(
      "T3-X4 (F11+R5): Agent MCP exposes strictly 8 canonical tools & 2 resources over Stdio & InMemory with zero R5 symbols and BFF 404 guards",
      async () => {
        const stdio = await connectAgentMcpStdio({ manifestPath: DEPLOYED_CONTRACTS_PATH });
        try {
          const tools = await stdio.listToolNames();
          const resources = await stdio.listResourceUris();
          expect(tools.length).toBe(8);
          expect(tools).toEqual([...EXPECTED_MCP_TOOLS]);
          expect(resources).toEqual([...EXPECTED_MCP_RESOURCES]);
          for (const t of tools) {
            expect(t).not.toMatch(/limit_order|auto_rollover|oracle|zap_in/);
          }
        } finally {
          await stdio.close();
        }

        const inMem = await connectAgentMcpInMemory(DEPLOYED_CONTRACTS_PATH);
        try {
          expect(await inMem.listToolNames()).toEqual([...EXPECTED_MCP_TOOLS]);
          expect(await inMem.listResourceUris()).toEqual([...EXPECTED_MCP_RESOURCES]);

          const depJson = JSON.parse(
            await inMem.readResourceText("stellar-pendle://deployment")
          ) as { network: string; contracts: Record<string, unknown> };
          expect(depJson.network).toBe("testnet");

          const ecoJson = JSON.parse(
            await inMem.readResourceText("stellar-pendle://stellar-agent-ecosystem")
          ) as { mpcToolsProvided: string[] };
          expect(ecoJson.mpcToolsProvided.length).toBe(8);
        } finally {
          await inMem.close();
        }

        const r5Scan = scanR5OutOfScopeSymbols();
        expect(r5Scan.ok).toBe(true);
        expect(r5Scan.matches).toEqual([]);

        for (const path of [
          ["orders"],
          ["limit-orders"],
          ["oracle"],
          ["rollover-jobs"],
          ["auto-rollover"],
        ]) {
          const res = await invokeBffGet({ path });
          expect(res.status).toBe(404);
        }
      },
      30_000
    );

    it("T3-X5 (F6+F7+WAL): 30 concurrent parallel BFF GET requests against SQLite WAL isolated indexer return HTTP 200 with zero SQLITE_BUSY", async () => {
      const indexerSrc = readFileText("indexer/index.ts");
      expect(indexerSrc).toContain("PRAGMA journal_mode = WAL");
      expect(indexerSrc).toContain("PRAGMA busy_timeout = 5000");

      const nowSec = Math.floor(Date.now() / 1000);
      const idx = await startIndexerHarness({
        secret: TEST_SECRET,
        seed(storage) {
          storage.recordMintPy({
            marketId: "xlm-90d",
            caller: TEST_USER,
            receiver: TEST_USER,
            syIn: 1000_0000000n,
            pyOut: 1000_0000000n,
            timestamp: nowSec - 600,
            spotPtPrice: 0.9735,
          });
          storage.recordSwap({
            marketId: "usdc-90d",
            caller: TEST_USER,
            receiver: TEST_USER,
            direction: 1,
            amountIn: 50_0000000n,
            amountOut: 51_0000000n,
            fee: 100000n,
            reservesSy: 4000_0000000n,
            reservesPt: 4100_0000000n,
            timestamp: nowSec - 300,
          });
        },
      });

      try {
        await withBffEnv(
          { indexerInternalUrl: idx.baseUrl, indexerApiSecret: idx.secret },
          async () => {
            const urls = [
              "/api/indexer/health",
              "/api/indexer/stats",
              "/api/indexer/charts?market=xlm-90d&interval=1D",
              `/api/indexer/positions?user=${TEST_USER}`,
              "/api/indexer/events?limit=10",
            ];
            const requests: Array<Promise<{ url: string; status: number; text: string }>> = [];
            for (let round = 0; round < 6; round++) {
              for (const url of urls) {
                requests.push(
                  callBffGetRaw({ url }).then(async (res) => ({
                    url,
                    status: res.status,
                    text: await res.text(),
                  }))
                );
              }
            }
            expect(requests.length).toBe(30);

            const responses = await Promise.all(requests);
            const chartCounts = new Set<number>();
            const xlmCostBases: number[] = [];

            for (const r of responses) {
              expect(r.status).toBe(200);
              expect(r.text).not.toContain("SQLITE_BUSY");
              const parsed = JSON.parse(r.text) as Record<string, unknown>;
              if (r.url.includes("/charts")) {
                expect(parsed.market).toBe("xlm-90d");
                chartCounts.add(Number(parsed.count));
              }
              if (r.url.includes("/positions")) {
                const positions = parsed.positions as Array<{
                  marketId: string;
                  costBasisUsd: number;
                }>;
                const xlm = positions.find((p) => p.marketId === "xlm-90d");
                expect(xlm).toBeDefined();
                xlmCostBases.push(xlm!.costBasisUsd);
              }
            }

            expect([...chartCounts]).toEqual([24]);
            expect(xlmCostBases.length).toBe(6);
            for (const cb of xlmCostBases) {
              expect(cb).toBeCloseTo(1000 * CANONICAL_XLM_PRICE_USD, 5);
            }
          }
        );
      } finally {
        await idx.stop();
      }
    }, 60_000);
  });
});
