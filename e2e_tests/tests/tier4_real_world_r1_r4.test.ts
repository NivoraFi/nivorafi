// e2e_tests/tests/tier4_real_world_r1_r4.test.ts
// Tier 4: Real-World Multi-Step End-to-End Application Scenarios (7 comprehensive full-lifecycle scenarios)

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Address,
  Keypair,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  CANONICAL_INDEXER_PORT,
  CANONICAL_USDC_MATURED,
  CANONICAL_XLM_90D,
  CANONICAL_XLM_PRICE_USD,
  DEPLOYED_CONTRACTS_PATH,
  EXPECTED_MCP_RESOURCES,
  EXPECTED_MCP_TOOLS,
  React,
  SorobanRunnerSession,
  act,
  callBffGetRaw,
  connectAgentMcpStdio,
  decodeUnsignedInvokeContractXdr,
  getClosedLocalUrl,
  inspectScValArgs,
  mountFrontendDom,
  readFileText,
  runFrontendBuildOnce,
  runTscCheck,
  scanNextStaticForSecrets,
  scanR5OutOfScopeSymbols,
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
  calculateHaircut,
  getExchangeRate,
  MIN_FEE_RATE,
  MAX_FEE_RATE,
  SECONDS_PER_YEAR,
} from "../src/math-oracle.ts";
import { ENV } from "@/lib/env";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import {
  PRESET_MARKETS,
  type MarketDefinition,
  type MarketSummaryMetrics,
} from "@/lib/markets";
import { buildActionArgs, type LiveUserPortfolio } from "@/lib/stellar";
import {
  convertToChartDataPoints,
  fetchMarketChartData,
  fetchUserPositionData,
} from "@/lib/indexerAnalytics";
import {
  mapIndexedPositionsToPortfolios,
  probeIndexerPositionsFast,
} from "@/lib/hybridPortfolio";
import { WalletProvider } from "@/context/WalletProvider";
import { MarketProvider } from "@/context/MarketContext";
import { ToastProvider } from "@/context/ToastContext";
import { LandingView } from "@/components/landing/LandingView";
import { PoolsPageClient, type PoolsPageClientProps } from "@/app/pools/PoolsPageClient";
import { SwapCard } from "@/components/trading/SwapCard";
import { AnalyticsCard } from "@/components/trading/AnalyticsCard";
import { InteractiveYieldChart } from "@/components/token/InteractiveYieldChart";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { MARKETS } from "../../indexer/index.ts";
import { createStellarPendleMcpServer } from "../../agent/src/mcp-server.ts";
import type { StellarPendleAgentClient } from "../../agent/src/client.ts";
import type { DeploymentManifest, SwapDirection } from "../../agent/src/types.ts";
import { buildRegisteredMarkets } from "../../scripts/register_markets.ts";

const T0 = 1_700_000_000;
const DAY = 86_400;
const SCALAR_9 = 1_000_000_000n;
const SCALAR_ROOT = 20n * WAD;
const POS_ANCHOR = (105n * WAD) / 100n;
const DEFAULT_ANNUAL_FEE_RATE = 50_000_000_000_000_000n;
const DEFAULT_PROTOCOL_FEE_BPS = 2_000n;

const TEST_SECRET = "e2e-tier4-secret-32bytes-hex-0001";
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

function calcTauWad(now: bigint, maturity: bigint): bigint {
  if (maturity <= now) return 0n;
  return ((maturity - now) * WAD) / SECONDS_PER_YEAR;
}

function calcFeeRate(tauWad: bigint): bigint {
  if (tauWad <= 0n) return MIN_FEE_RATE;
  const dyn = wadMul(DEFAULT_ANNUAL_FEE_RATE, tauWad);
  if (dyn < MIN_FEE_RATE) return MIN_FEE_RATE;
  if (dyn > MAX_FEE_RATE) return MAX_FEE_RATE;
  return dyn;
}

function oracleSwapPtForSy(
  ptIn: bigint,
  ptRes: bigint,
  syRes: bigint,
  now: bigint,
  maturity: bigint
): { netOut: bigint; fee: bigint; protoFee: bigint } {
  const tau = calcTauWad(now, maturity);
  const feeRate = calcFeeRate(tau);
  const eTrade = getExchangeRate(ptRes + ptIn, syRes, tau, SCALAR_ROOT, POS_ANCHOR);
  const gross = wadDiv(ptIn, eTrade);
  const fee = wadMul(gross, feeRate);
  return { netOut: gross - fee, fee, protoFee: (fee * DEFAULT_PROTOCOL_FEE_BPS) / 10_000n };
}

function oracleSwapSyForPt(
  syIn: bigint,
  ptRes: bigint,
  syRes: bigint,
  now: bigint,
  maturity: bigint
): { netOut: bigint; fee: bigint; protoFee: bigint } {
  const tau = calcTauWad(now, maturity);
  const feeRate = calcFeeRate(tau);
  const eTrade = getExchangeRate(ptRes, syRes + syIn, tau, SCALAR_ROOT, POS_ANCHOR);
  const gross = wadMul(syIn, eTrade);
  const fee = wadMul(gross, feeRate);
  return { netOut: gross - fee, fee, protoFee: (fee * DEFAULT_PROTOCOL_FEE_BPS) / 10_000n };
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
    const ptSupply = BigInt(await mustInvoke<string>(session, pt, "total_supply"));
    expect((ptPrincipalBig * bRate) / SCALAR_9 + tolerance).toBeGreaterThanOrEqual(ptSupply);
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

function encodeMarketStateScVal(state: MarketState): xdr.ScVal {
  // Lexicographically sorted ScMapEntry keys matching contracts/common/src/storage_keys.rs
  const entries = [
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("annual_fee_rate"),
      val: nativeToScVal(BigInt(state.annual_fee_rate), { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("fee_recipient"),
      val: Address.fromString(state.fee_recipient).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("initial_anchor"),
      val: nativeToScVal(BigInt(state.initial_anchor), { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("is_settled"),
      val: xdr.ScVal.scvBool(Boolean(state.is_settled)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("maturity"),
      val: nativeToScVal(BigInt(state.maturity), { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("maturity_index"),
      val: nativeToScVal(BigInt(state.maturity_index), { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("protocol_fee_bps"),
      val: nativeToScVal(BigInt(state.protocol_fee_bps), { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("scalar_root"),
      val: nativeToScVal(BigInt(state.scalar_root), { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("total_lp_supply"),
      val: nativeToScVal(BigInt(state.total_lp_supply), { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("total_pt_reserve"),
      val: nativeToScVal(BigInt(state.total_pt_reserve), { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("total_sy_reserve"),
      val: nativeToScVal(BigInt(state.total_sy_reserve), { type: "i128" }),
    }),
  ];
  return xdr.ScVal.scvMap(entries);
}

describe("Tier 4: Real-World Multi-Step End-to-End Application Scenarios", () => {
  let session: SorobanRunnerSession;

  beforeAll(async () => {
    session = await SorobanRunnerSession.start();
  }, 180_000);

  afterAll(async () => {
    await session?.close();
  }, 30_000);

  // =========================================================================
  // Scenario 1 (F6 + F7 + F8 + F11): Production Config Audit, Cold-Start Builds & Bundle Scan
  // =========================================================================
  it(
    "Scenario 1 (F6+F7+F8+F11): Production release audit, cold-start tsc across indexer/agent/frontend, next build & static secret scan",
    async () => {
      // 1. Env & public config sanitization + SHA-256 & 5-key locks
      for (const file of ["frontend/.env.production", "frontend/.env.local"]) {
        const content = readFileText(file);
        expect(content).not.toContain(LEAKED_HEX_SECRET);
        expect(content).not.toContain("trycloudflare.com");
        expect(content).not.toContain("VERCEL_OIDC_TOKEN");
        expect(content).toContain('NEXT_PUBLIC_INDEXER_API_URL="/api/indexer"');
        expect(content).toContain('INDEXER_INTERNAL_URL="http://127.0.0.1:8765"');
        expect(content).toContain('INDEXER_API_SECRET="replace_with_32_byte_hex_secret"');
      }

      expect(ENV.indexerApiUrl).toBe("/api/indexer");
      expect("INDEXER_API_SECRET" in ENV).toBe(false);
      expect("INDEXER_INTERNAL_URL" in ENV).toBe(false);
      expect(STELLAR_PENDLE_CONFIG.indexerApiUrl).toBe("/api/indexer");

      expect((await verifyContractsConfigLock()).ok).toBe(true);
      expect((await verifyLockedSha256()).ok).toBe(true);

      // 2. Port 8765 consistency across indexer, BFF, env files, and scripts
      for (const file of [
        "indexer/index.ts",
        "frontend/src/app/api/indexer/[...path]/route.ts",
        "frontend/.env.example",
        "frontend/.env.production",
        "frontend/.env.local",
        "scripts/verify_charts.ts",
        "scripts/stress_indexer.ts",
      ]) {
        const text = readFileText(file);
        expect(text).toContain(String(CANONICAL_INDEXER_PORT));
        expect(text).not.toContain("3001");
      }

      // 3. xlm-90d, usdc-matured, XLM 0.12 & sUSDC parity across manifest, frontend, indexer & scripts
      const deployed = JSON.parse(readFileSync(DEPLOYED_CONTRACTS_PATH, "utf8")) as {
        markets: Array<{
          id: string;
          factoryId: number;
          maturity: number;
          contracts: { pool: string; sy: string; pt: string; yt: string };
        }>;
      };
      const depXlm = deployed.markets.find((m) => m.id === "xlm-90d");
      const feXlm = PRESET_MARKETS.find((m) => m.id === "xlm-90d");
      const idxXlm = MARKETS["xlm-90d"];
      const scriptXlm = buildRegisteredMarkets().find((m) => m.id === "xlm-90d");
      expect(depXlm?.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
      expect(feXlm?.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
      expect(idxXlm?.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
      expect(idxXlm?.assetPriceUsd).toBe(CANONICAL_XLM_PRICE_USD);
      expect(scriptXlm?.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
      expect(scriptXlm?.contracts.pool).toBe(CANONICAL_XLM_90D.poolId);

      const scriptMat = buildRegisteredMarkets().find((m) => m.id === "usdc-matured");
      expect(scriptMat?.factoryId).toBe(CANONICAL_USDC_MATURED.factoryId);
      expect(scriptMat?.contracts.pool).toBe(CANONICAL_USDC_MATURED.poolId);

      const feSusdc = PRESET_MARKETS.find(
        (m) => m.sySymbol === "sy-sUSDC" || /susdc|slender/i.test(m.id)
      );
      expect(feSusdc).toBeDefined();

      // 4. Cold-start typechecks across indexer, agent, and frontend
      for (const target of ["indexer", "agent", "frontend"] as const) {
        const tscRes = await runTscCheck(target);
        expect(tscRes.ok).toBe(true);
        expect(tscRes.errors).toEqual([]);
      }

      // 5. Real production Next.js build + static chunk zero-secret scan + R5 scan
      const buildRes = await runFrontendBuildOnce();
      expect(buildRes.ok).toBe(true);
      expect(buildRes.exitCode).toBe(0);

      const secretScan = await scanNextStaticForSecrets();
      expect(secretScan.filesScanned).toBeGreaterThan(0);
      expect(secretScan.matches).toEqual([]);
      expect(scanR5OutOfScopeSymbols().ok).toBe(true);
    },
    180_000
  );

  // =========================================================================
  // Scenario 2 (F1 + F2 + F3 + F4 + F5): Full Blend Multi-Market Soroban Lifecycle
  // =========================================================================
  it(
    "Scenario 2 (F1+F2+F3+F4+F5): Full Blend multi-market Soroban lifecycle (auth, dynamic metadata, 4-way swaps, MaturityIndex pinning, rollover & bad-debt haircut)",
    async () => {
      // 1. Setup & Governance (F1)
      const { admin, factory } = await setupFactory(session, T0);
      const attacker = await session.genAddress("attacker");
      const creator1 = await session.genAddress("creator1");
      const lp = await session.genAddress("lp");
      const user1 = await session.genAddress("user1");
      const user2 = await session.genAccount("user2_xlm", "1000000000000");
      const observer = await session.genAddress("observer");
      const feeRec1 = await session.genAddress("fee_rec_1");
      const feeRec2 = await session.genAddress("fee_rec_2");
      const feeRec3 = await session.genAddress("fee_rec_3");

      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);

      const { asset: usdc, blend: blendUsdc } = await setupBlendAndAsset(session, admin, "USDC");
      const { asset: xlmSac, blend: blendXlm } = await setupBlendAndAsset(
        session,
        admin,
        "native"
      );

      // Unauthorized attacker rejected cleanly before mutating SyByAsset
      expectContractError(
        await session.invoke(factory, "create_market", [
          aAddr(attacker),
          aAddr(usdc),
          aAddr(blendUsdc),
          aU64(T0 + 30 * DAY),
          aI128(SCALAR_ROOT),
          aI128(POS_ANCHOR),
        ]),
        3,
        "Unauthorized"
      );
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(usdc)])
      ).toBeNull();

      // 2. Multi-Market Deployment & Dynamic Metadata (F1 + F2)
      const usdc30 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(usdc),
        aAddr(blendUsdc),
        aU64(T0 + 30 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      const usdc90 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(usdc),
        aAddr(blendUsdc),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      const xlm90 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(xlmSac),
        aAddr(blendXlm),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);

      expect(usdc30.sy).toBe(usdc90.sy);
      expect(xlm90.sy).not.toBe(usdc30.sy);
      expect(await mustInvoke<string>(session, usdc30.sy, "symbol")).toBe("sy-bUSDC");
      expect(await mustInvoke<string>(session, usdc30.pt, "symbol")).toBe("PT-USDC-30D");
      expect(await mustInvoke<string>(session, usdc90.pt, "symbol")).toBe("PT-USDC-90D");
      expect(await mustInvoke<string>(session, usdc30.pool, "symbol")).toBe("LP-USDC");
      expect(await mustInvoke<string>(session, xlm90.sy, "symbol")).toBe("sy-bXLM");
      expect(await mustInvoke<string>(session, xlm90.pt, "symbol")).toBe("PT-XLM-90D");
      expect(await mustInvoke<string>(session, xlm90.yt, "symbol")).toBe("YT-XLM-90D");
      expect(await mustInvoke<string>(session, xlm90.pool, "symbol")).toBe("LP-XLM");

      await mustInvoke(session, usdc30.pool, "set_fee_recipient", [aAddr(admin), aAddr(feeRec1)]);
      await mustInvoke(session, usdc90.pool, "set_fee_recipient", [aAddr(admin), aAddr(feeRec2)]);
      await mustInvoke(session, xlm90.pool, "set_fee_recipient", [aAddr(admin), aAddr(feeRec3)]);

      // 3. Seed Pools, Mint PY & Execute 4-Way Swaps (F3 + F5)
      // Seed usdc30 (120B PT / 100B SY) & usdc90 (350B PT / 200B SY so PT > asset_res even at 1.5 b_rate)
      await session.sacMint(usdc, lp, 770_000_000_000n);
      await mustInvoke(session, usdc30.sy, "deposit", [
        aAddr(lp),
        aAddr(lp),
        aI128(770_000_000_000n),
      ]);
      await mustInvoke(session, usdc30.pool, "mint_py", [
        aAddr(lp),
        aAddr(lp),
        aI128(120_000_000_000n),
        aU64(Number(usdc30.maturity)),
      ]);
      await mustInvoke(session, usdc30.pool, "add_liquidity", [
        aAddr(lp),
        aAddr(lp),
        aI128(120_000_000_000n),
        aI128(100_000_000_000n),
        aI128(1),
      ]);
      await mustInvoke(session, usdc90.pool, "mint_py", [
        aAddr(lp),
        aAddr(lp),
        aI128(350_000_000_000n),
        aU64(Number(usdc90.maturity)),
      ]);
      await mustInvoke(session, usdc90.pool, "add_liquidity", [
        aAddr(lp),
        aAddr(lp),
        aI128(350_000_000_000n),
        aI128(200_000_000_000n),
        aI128(1),
      ]);

      // Seed xlm90 (100B PT / 100B SY) using native XLM account funder
      const xlmFunder = await session.genAccount("xlm_funder", "1000000000000");
      await mustInvoke(session, xlmSac, "transfer", [
        aAddr(xlmFunder),
        aAddr(lp),
        aI128(200_000_000_000n),
      ]);
      await mustInvoke(session, xlm90.sy, "deposit", [
        aAddr(lp),
        aAddr(lp),
        aI128(200_000_000_000n),
      ]);
      await mustInvoke(session, xlm90.pool, "mint_py", [
        aAddr(lp),
        aAddr(lp),
        aI128(100_000_000_000n),
        aU64(Number(xlm90.maturity)),
      ]);
      const xlmLpShares = BigInt(
        await mustInvoke<string>(session, xlm90.pool, "add_liquidity", [
          aAddr(lp),
          aAddr(lp),
          aI128(100_000_000_000n),
          aI128(100_000_000_000n),
          aI128(1),
        ])
      );

      // user1 deposits USDC, tests deadline T0 - 1 -> #10, then mints 40B PY on usdc30
      await session.sacMint(usdc, user1, 80_000_000_000n);
      await mustInvoke(session, usdc30.sy, "deposit", [
        aAddr(user1),
        aAddr(user1),
        aI128(80_000_000_000n),
      ]);
      expectContractError(
        await session.invoke(usdc30.pool, "mint_py", [
          aAddr(user1),
          aAddr(user1),
          aI128(40_000_000_000n),
          aU64(T0 - 1),
        ]),
        10,
        "DeadlineExpired"
      );
      await mustInvoke(session, usdc30.pool, "mint_py", [
        aAddr(user1),
        aAddr(user1),
        aI128(40_000_000_000n),
        aU64(T0),
      ]);

      // Execute all 4 swap directions on usdc30 with fee & reserve conservation checks
      const nowBig = BigInt(T0);
      const u30MatBig = BigInt(usdc30.maturity);
      {
        const [ptR, syR] = (
          await mustInvoke<[string, string]>(session, usdc30.pool, "get_reserves")
        ).map(BigInt) as [bigint, bigint];
        const o1 = oracleSwapPtForSy(2_000_000_000n, ptR, syR, nowBig, u30MatBig);
        const [out1] = await mustInvoke<[string, string]>(
          session,
          usdc30.pool,
          "swap_exact_pt_for_sy",
          [aAddr(user1), aAddr(user1), aI128(2_000_000_000n), aI128(1), aU64(T0)]
        );
        expect(BigInt(out1)).toBe(o1.netOut);
        await assertReserveConservation(session, usdc30.sy, usdc30.pool, usdc30.pt);
      }
      {
        const [ptR, syR] = (
          await mustInvoke<[string, string]>(session, usdc30.pool, "get_reserves")
        ).map(BigInt) as [bigint, bigint];
        const o2 = oracleSwapSyForPt(2_000_000_000n, ptR, syR, nowBig, u30MatBig);
        const [out2] = await mustInvoke<[string, string]>(
          session,
          usdc30.pool,
          "swap_exact_sy_for_pt",
          [aAddr(user1), aAddr(user1), aI128(2_000_000_000n), aI128(1), aU64(T0)]
        );
        expect(BigInt(out2)).toBe(o2.netOut);
        await assertReserveConservation(session, usdc30.sy, usdc30.pool, usdc30.pt);
      }
      const [ytSwappedOut] = await mustInvoke<[string, string]>(
        session,
        usdc30.pool,
        "swap_exact_sy_for_yt",
        [aAddr(user1), aAddr(user1), aI128(200_000_000n), aI128(1), aU64(T0)]
      );
      await assertReserveConservation(session, usdc30.sy, usdc30.pool, usdc30.pt);
      await mustInvoke(session, usdc30.pool, "swap_exact_yt_for_sy", [
        aAddr(user1),
        aAddr(user1),
        aI128(BigInt(ytSwappedOut) / 2n),
        aI128(1),
        aU64(T0),
      ]);
      await assertReserveConservation(session, usdc30.sy, usdc30.pool, usdc30.pt);
      expect(
        BigInt(await mustInvoke<string>(session, usdc30.sy, "balance", [aAddr(feeRec1)]))
      ).toBeGreaterThan(0n);
      expect(
        BigInt(await mustInvoke<string>(session, usdc30.pt, "balance", [aAddr(feeRec1)]))
      ).toBeGreaterThan(0n);

      // 4. Yield Accrual, Post-Maturity MaturityIndex Pinning & Rollover (F4 + F5)
      await mustInvoke(session, blendUsdc, "set_b_rate", [aI128(1_200_000_000n)]);
      const tPost30 = Number(usdc30.maturity) + 100;
      await session.setLedger({ timestamp: tPost30 });

      // Trigger yt_token's private update_checkpoint at b_rate = 1.2 before spiking to 1.5
      await mustInvoke(session, usdc30.yt, "transfer", [
        aAddr(user1),
        aAddr(observer),
        aI128(1_000n),
      ]);
      await mustInvoke(session, blendUsdc, "set_b_rate", [aI128(1_500_000_000n)]);

      expect(await mustInvoke<string>(session, usdc30.pool, "settle_maturity")).toBe(
        "1200000000"
      );

      const u1YieldClaimed = BigInt(
        await mustInvoke<string>(session, usdc30.pool, "claim_yield", [
          aAddr(user1),
          aAddr(user1),
        ])
      );
      const u1YtBal = BigInt(
        await mustInvoke<string>(session, usdc30.yt, "balance", [aAddr(user1)])
      );
      const maxYieldSy = ((u1YtBal + 1_000n) * 200_000_000n) / 1_500_000_000n;
      expect(u1YieldClaimed).toBeGreaterThan(0n);
      expect(u1YieldClaimed).toBeLessThanOrEqual(maxYieldSy + 2n);

      // Redeem 10B PT post-maturity
      const redeemed10 = BigInt(
        await mustInvoke<string>(session, usdc30.pool, "redeem_pt_post_maturity", [
          aAddr(user1),
          aAddr(user1),
          aI128(10_000_000_000n),
        ])
      );
      expect(redeemed10).toBeGreaterThan(0n);

      // Rollover 5B PT -> usdc90 PT and 5B PT -> usdc90 PY (with deadline guard check first)
      expectContractError(
        await session.invoke(factory, "rollover_to_pt", [
          aAddr(user1),
          aAddr(user1),
          aAddr(usdc30.pool),
          aAddr(usdc90.pool),
          aI128(5_000_000_000n),
          aI128(1),
          aU64(tPost30 - 1),
        ]),
        10,
        "DeadlineExpired"
      );
      const [, rollPtOut] = await mustInvoke<[string, string]>(session, factory, "rollover_to_pt", [
        aAddr(user1),
        aAddr(user1),
        aAddr(usdc30.pool),
        aAddr(usdc90.pool),
        aI128(5_000_000_000n),
        aI128(1),
        aU64(tPost30 + 60),
      ]);
      expect(BigInt(rollPtOut)).toBeGreaterThan(0n);

      const [, rollPyOut] = await mustInvoke<[string, string]>(session, factory, "rollover_to_py", [
        aAddr(user1),
        aAddr(user1),
        aAddr(usdc30.pool),
        aAddr(usdc90.pool),
        aI128(5_000_000_000n),
        aI128(1),
        aU64(tPost30 + 60),
      ]);
      expect(BigInt(rollPyOut)).toBeGreaterThan(0n);
      await assertFactoryZeroDust(session, factory, [
        usdc30.sy,
        usdc30.pt,
        usdc90.pt,
        usdc90.yt,
      ]);

      // 5. Bad-Debt Haircut & 100% LP Protection on xlm90 (F4)
      await mustInvoke(session, xlmSac, "transfer", [
        aAddr(xlmFunder),
        aAddr(user2),
        aI128(100_000_000_000n),
      ]);
      await mustInvoke(session, xlm90.sy, "deposit", [
        aAddr(user2),
        aAddr(user2),
        aI128(100_000_000_000n),
      ]);
      await mustInvoke(session, xlm90.pool, "mint_py", [
        aAddr(user2),
        aAddr(user2),
        aI128(100_000_000_000n),
        aU64(tPost30 + 60),
      ]);

      // Simulate 20% bad debt on xlm90 PT principal (200B -> 160B available_for_pt)
      await session.burnAsHolder(xlm90.sy, xlm90.pool, "40000000000");

      await session.setLedger({ timestamp: Number(xlm90.maturity) + 10 });
      const u2HaircutOut = BigInt(
        await mustInvoke<string>(session, xlm90.pool, "redeem_pt_post_maturity", [
          aAddr(user2),
          aAddr(user2),
          aI128(100_000_000_000n),
        ])
      );
      const expectedHaircut = calculateHaircut(160_000_000_000n, 200_000_000_000n);
      expect(expectedHaircut).toBe(800_000_000_000_000_000n); // 0.8 WAD
      expect(u2HaircutOut).toBe(wadMul(100_000_000_000n, expectedHaircut)); // 80B

      // LP removes 100% liquidity -> TotalSyReserve protected 100%
      const [lpXlmPt, lpXlmSy] = await mustInvoke<[string, string]>(
        session,
        xlm90.pool,
        "remove_liquidity",
        [aAddr(lp), aAddr(lp), aI128(xlmLpShares), aI128(1), aI128(1)]
      );
      expect(BigInt(lpXlmPt)).toBeGreaterThan(99_999_000_000n);
      expect(BigInt(lpXlmSy)).toBeGreaterThan(99_999_000_000n);
    },
    60_000
  );

  // =========================================================================
  // Scenario 3 (F2 + F3 + F5 + F9 + F10): Full Slender (sUSDC) Diversification Lifecycle
  // =========================================================================
  it(
    "Scenario 3 (F2+F3+F5+F9+F10): Full Slender (sUSDC) diversification lifecycle with multi-SY registration, accrual, Zap-In & dust-free exit",
    async () => {
      // 1. Live F1/F2 Blend USDC setup first
      const { admin, factory } = await setupFactory(session, T0);
      const creator1 = await session.genAddress("creator1");
      const lp = await session.genAddress("lp");
      const user1 = await session.genAddress("user1");
      const user2 = await session.genAddress("user2");
      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);
      const { asset: usdc, blend } = await setupBlendAndAsset(session, admin, "USDC");
      const mBlend = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(usdc),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);
      expect(await mustInvoke<string>(session, mBlend.sy, "symbol")).toBe("sy-bUSDC");

      // 2. Deploy Slender (sUSDC) adapter & 60D market, verify metadata, register_market, seed pool
      const { slender, sySlender } = await deploySlenderAndWrapper(session, admin, usdc);
      expect(await mustInvoke<string>(session, sySlender, "symbol")).toBe("sy-sUSDC");
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

      await session.sacMint(usdc, lp, 440_000_000_000n);
      await mustInvoke(session, sySlender, "deposit", [
        aAddr(lp),
        aAddr(lp),
        aI128(440_000_000_000n),
      ]);
      await mustInvoke(session, slPool, "mint_py", [
        aAddr(lp),
        aAddr(lp),
        aI128(240_000_000_000n),
        aU64(slMat),
      ]);
      await mustInvoke(session, slPool, "add_liquidity", [
        aAddr(lp),
        aAddr(lp),
        aI128(240_000_000_000n),
        aI128(200_000_000_000n),
        aI128(1),
      ]);

      // 3. Accrue Slender rate 1.0 -> 1.05
      await setSlenderRate(session, slender, 1_050_000_000n);
      await session.sacMint(usdc, slender, 22_000_000_000n);
      expect(await mustInvoke<string>(session, sySlender, "exchange_rate")).toBe("1050000000");

      // 4. user1 & user2 test expired Zap-In (#10) then valid Zap-In PT/YT/LP
      await session.sacMint(usdc, user1, 200_000_000n);
      await session.sacMint(usdc, user2, 100_000_000n);

      expectContractError(
        await session.invoke(factory, "zap_in_pt", [
          aAddr(user1),
          aAddr(user1),
          aAddr(slPool),
          aI128(100_000_000n),
          aI128(1),
          aU64(T0 - 1),
        ]),
        10,
        "DeadlineExpired"
      );

      await mustInvoke(session, factory, "zap_in_pt", [
        aAddr(user1),
        aAddr(user1),
        aAddr(slPool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      await mustInvoke(session, factory, "zap_in_yt", [
        aAddr(user1),
        aAddr(user1),
        aAddr(slPool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      await mustInvoke(session, factory, "zap_in_lp", [
        aAddr(user2),
        aAddr(user2),
        aAddr(slPool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      await assertFactoryZeroDust(session, factory, [usdc, sySlender, slPt, slYt, slPool]);

      // 5. Swaps, rate accrual 1.05 -> 1.15, settlement, claim & redeem back to USDC
      const u1Pt = BigInt(await mustInvoke<string>(session, slPt, "balance", [aAddr(user1)]));
      await mustInvoke(session, slPool, "swap_exact_pt_for_sy", [
        aAddr(user1),
        aAddr(user1),
        aI128(u1Pt / 2n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      await assertReserveConservation(session, sySlender, slPool, slPt, 2n, 1_050_000_000n);

      await setSlenderRate(session, slender, 1_150_000_000n);
      await session.sacMint(usdc, slender, 45_000_000_000n);
      await session.setLedger({ timestamp: slMat + 10 });
      expect(await mustInvoke<string>(session, slPool, "settle_maturity")).toBe("1150000000");

      await mustInvoke(session, slPool, "claim_yield", [aAddr(user1), aAddr(user1)]);
      const remPt = BigInt(await mustInvoke<string>(session, slPt, "balance", [aAddr(user1)]));
      await mustInvoke(session, slPool, "redeem_pt_post_maturity", [
        aAddr(user1),
        aAddr(user1),
        aI128(remPt),
      ]);
      const u1SyBal = BigInt(
        await mustInvoke<string>(session, sySlender, "balance", [aAddr(user1)])
      );
      expect(u1SyBal).toBeGreaterThan(0n);
      const usdcOut = BigInt(
        await mustInvoke<string>(session, sySlender, "redeem", [
          aAddr(user1),
          aAddr(user1),
          aI128(u1SyBal),
        ])
      );
      expect(usdcOut).toBeGreaterThan(0n);
      expect(await mustInvoke<string>(session, sySlender, "balance", [aAddr(user1)])).toBe("0");
    },
    60_000
  );

  // =========================================================================
  // Scenario 4 (F6 + F7 + F8 + F11): Full-Stack Indexer -> BFF -> Frontend Hydration
  // =========================================================================
  it("Scenario 4 (F6+F7+F8+F11): Full-stack Indexer -> BFF -> Frontend hydration across usdc-90d, xlm-90d ($0.12), usdc-matured & sUSDC", async () => {
    const sUsdc = PRESET_MARKETS.find(
      (m) => m.sySymbol === "sy-sUSDC" || /susdc|slender/i.test(m.id)
    );
    expect(sUsdc).toBeDefined();

    const nowSec = Math.floor(Date.now() / 1000);
    const idx = await startIndexerHarness({
      secret: TEST_SECRET,
      seed(storage) {
        storage.recordMintPy({
          marketId: "usdc-90d",
          caller: TEST_USER,
          receiver: TEST_USER,
          syIn: 100_0000000n,
          pyOut: 100_0000000n,
          timestamp: nowSec - 1800,
          spotPtPrice: 0.98,
        });
        storage.recordSwap({
          marketId: "usdc-90d",
          caller: TEST_USER,
          receiver: TEST_USER,
          direction: 1,
          amountIn: 50_0000000n,
          amountOut: 51_0000000n,
          fee: 500000n,
          reservesSy: 4000_0000000n,
          reservesPt: 4100_0000000n,
          timestamp: nowSec - 900,
        });
        storage.recordMintPy({
          marketId: "xlm-90d",
          caller: TEST_USER,
          receiver: TEST_USER,
          syIn: 1000_0000000n,
          pyOut: 1000_0000000n,
          timestamp: nowSec - 1500,
          spotPtPrice: 0.9735,
        });
        storage.recordMintPy({
          marketId: "usdc-matured",
          caller: TEST_USER,
          receiver: TEST_USER,
          syIn: 200_0000000n,
          pyOut: 200_0000000n,
          timestamp: nowSec - 1200,
        });
        storage.recordMintPy({
          marketId: sUsdc!.id,
          caller: TEST_USER,
          receiver: TEST_USER,
          syIn: 300_0000000n,
          pyOut: 300_0000000n,
          timestamp: nowSec - 600,
          spotPtPrice: 0.985,
        });
      },
    });

    try {
      const { posRes, probeRes, xlmChart, maturedChart, usdcChart, susdcChart } =
        await withRealBffBridge(
          { indexerInternalUrl: idx.baseUrl, indexerApiSecret: idx.secret },
          async (bffBaseUrl) => {
            const [pRes, prRes, xChart, mChart, uChart, sChart] = await Promise.all([
              fetchUserPositionData({ userAddress: TEST_USER, indexerApiUrl: bffBaseUrl }),
              probeIndexerPositionsFast({ userAddress: TEST_USER, indexerApiUrl: bffBaseUrl }),
              fetchMarketChartData({
                market: "xlm-90d",
                interval: "1D",
                indexerApiUrl: bffBaseUrl,
              }),
              fetchMarketChartData({
                market: "usdc-matured",
                interval: "1D",
                indexerApiUrl: bffBaseUrl,
              }),
              fetchMarketChartData({
                market: "usdc-90d",
                interval: "1D",
                indexerApiUrl: bffBaseUrl,
              }),
              fetchMarketChartData({
                market: sUsdc!.id,
                interval: "1D",
                indexerApiUrl: bffBaseUrl,
              }),
            ]);
            return {
              posRes: pRes,
              probeRes: prRes,
              xlmChart: xChart,
              maturedChart: mChart,
              usdcChart: uChart,
              susdcChart: sChart,
            };
          }
        );

      expect(probeRes.reachable).toBe(true);
      expect(posRes.positions.length).toBe(4);
      const xlmPos = posRes.positions.find((p) => p.marketId === "xlm-90d");
      expect(xlmPos?.costBasisUsd).toBeCloseTo(120, 4);
      expect(posRes.summary.totalCostBasisUsd).toBeGreaterThan(700);

      for (const chart of [usdcChart, xlmChart, maturedChart, susdcChart]) {
        expect(chart.count).toBe(24);
        expect(chart.data.length).toBe(24);
      }
      for (const pt of maturedChart.data) {
        expect(pt.ptPrice).toBe(1);
        expect(pt.ytPrice).toBe(0);
        expect(pt.impliedApy).toBe(0);
      }

      // Sequential UI hydration: InteractiveYieldChart on live xlm-90d chart data
      const xlm90d = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
      const xlmPoints = convertToChartDataPoints(xlmChart.data);
      const chartMount = await mountFrontendDom(
        React.createElement(InteractiveYieldChart, {
          market: xlm90d,
          data: xlmPoints,
          snapshot: null,
          analytics: null,
          loading: false,
        })
      );
      try {
        const html = chartMount.container.innerHTML;
        expect(html).toContain("<path");
        expect(html).not.toContain("NaN");
        expect(html).not.toContain("Infinity");
      } finally {
        await chartMount.unmount();
      }

      // Sequential UI hydration: PortfolioView with mapped positions
      const mappedPortfolios = mapIndexedPositionsToPortfolios(
        TEST_USER,
        posRes.positions,
        PRESET_MARKETS
      );
      const portfolioMount = await mountFrontendDom(
        React.createElement(
          WithSeededWallet,
          { address: TEST_USER },
          React.createElement(
            MarketProvider,
            null,
            React.createElement(PortfolioView, { userPortfolios: mappedPortfolios })
          )
        )
      );
      try {
        await act(async () => {
          await Bun.sleep(25);
        });
        const text = portfolioMount.container.textContent ?? "";
        expect(text).toContain("Market Positions Breakdown");
        expect(text).toContain(xlm90d.name);
        expect(text).toContain("Matured");
        expect(text).toContain(sUsdc!.name);
        expect(text).toContain("Action Required: Matured Positions Detected");
        expect(text).toContain("Rollover Now");
        expect(text).toContain("Net Worth");
        expect(text).not.toContain("NaN");
        expect(text).not.toMatch(/Net Worth\s*\$0\.00/);
        const nwMatch = text.match(/Net Worth\s*\$([\d,]+\.\d{2})/);
        expect(nwMatch).not.toBeNull();
        expect(Number(nwMatch![1]!.replace(/,/g, ""))).toBeGreaterThan(600);
      } finally {
        portfolioMount.window.localStorage.removeItem("stellar_pendle_wallet_session");
        await portfolioMount.unmount();
      }
    } finally {
      await idx.stop();
    }
  }, 60_000);

  // =========================================================================
  // Scenario 5 (F6 + F8): Zero-Liquidity & Indexer Outage Honest Degradation Journey
  // =========================================================================
  it("Scenario 5 (F6+F8): Zero-liquidity & indexer outage honest degradation across BFF, LandingView, PoolsPageClient, SwapCard, AnalyticsCard & InteractiveYieldChart", async () => {
    const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
    const closedUrl = await getClosedLocalUrl();
    const closedPort = new URL(closedUrl).port;

    // 1. Real indexer outage -> BFF 502 + graceful empty client schemas
    await withRealBffBridge(
      { indexerInternalUrl: closedUrl, indexerApiSecret: TEST_SECRET },
      async (bffBaseUrl) => {
        const health502 = await callBffGetRaw({ url: "/api/indexer/health" });
        expect(health502.status).toBe(502);
        expect(health502.headers.get("cache-control")).toBe("no-store");
        const healthTxt = await health502.text();
        expect(healthTxt).not.toContain("127.0.0.1");
        expect(healthTxt).not.toContain(closedPort);
        expect(healthTxt).not.toContain(TEST_SECRET);

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
        expect(cRes.data).toEqual([]);
        expect(cRes.summary.tvl).toBe(0);
        expect(pRes.positions).toEqual([]);
        expect(pRes.summary.totalCurrentValueUsd).toBe(0);
      }
    );

    // 2. Online indexer with 0 events returns empty array (zero synthetic buckets)
    const emptyIdx = await startIndexerHarness({ secret: TEST_SECRET });
    try {
      await withRealBffBridge(
        { indexerInternalUrl: emptyIdx.baseUrl, indexerApiSecret: emptyIdx.secret },
        async (bffBaseUrl) => {
          const emptyChart = await fetchMarketChartData({
            market: "usdc-90d",
            interval: "1W",
            indexerApiUrl: bffBaseUrl,
          });
          expect(emptyChart.count).toBe(0);
          expect(emptyChart.data).toEqual([]);
        }
      );
    } finally {
      await emptyIdx.stop();
    }

    // 3. Sequential UI honest degradation checks
    // Step A: LandingView
    const landingMount = await mountFrontendDom(
      React.createElement(
        WalletProvider,
        null,
        React.createElement(
          MarketProvider,
          null,
          React.createElement(LandingView, { snapshot: null, onEnterDesk: () => {} })
        )
      )
    );
    try {
      const text = landingMount.container.textContent ?? "";
      expect(text).toContain("--");
      expect(text).not.toContain("8.75%");
      expect(text).not.toContain("0.0214 SY");
    } finally {
      await landingMount.unmount();
    }

    // Step B: PoolsPageClient with zero-liquidity marketMetricsOverride
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
      expect(text).not.toContain("$7,269");
      expect(text).not.toContain("$4,008");
    } finally {
      await poolsMount.unmount();
    }

    // Step C: SwapCard with snapshot === null (honestly fails pre-M2-residual fix on SwapCard.tsx:258,283)
    const swapMount = await mountFrontendDom(
      React.createElement(
        WithSeededWallet,
        { address: TEST_USER },
        React.createElement(MarketProvider, {
          initialMarketId: "usdc-90d",
          children: React.createElement(SwapCard, {
            snapshot: null,
            portfolio: null,
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
      const text = swapMount.container.textContent ?? "";
      expect(text).toContain("--");
      expect(text).not.toContain("8.45%");
      expect(text).not.toContain("50x");
    } finally {
      swapMount.window.localStorage.removeItem("stellar_pendle_wallet_session");
      await swapMount.unmount();
    }

    // Step D: AnalyticsCard with analytics === null
    const analyticsMount = await mountFrontendDom(
      React.createElement(AnalyticsCard, { analytics: null, loading: false })
    );
    try {
      const text = analyticsMount.container.textContent ?? "";
      expect(text).toContain("--");
      expect(text).toContain("Accumulating ledger events...");
      expect(text).not.toContain("5.42");
    } finally {
      await analyticsMount.unmount();
    }

    // Step E: InteractiveYieldChart with empty data
    const emptyChartMount = await mountFrontendDom(
      React.createElement(InteractiveYieldChart, {
        market: usdc90d,
        data: [],
        snapshot: null,
        analytics: null,
        loading: false,
      })
    );
    try {
      const text = emptyChartMount.container.textContent ?? "";
      const html = emptyChartMount.container.innerHTML;
      expect(text).toContain("No indexed swap events yet");
      expect(text).toContain("--");
      expect(text).not.toContain("8.45%");
      expect(text).not.toContain("5.40%");
      expect(html).not.toContain('stroke-linecap="round"');
    } finally {
      await emptyChartMount.unmount();
    }
  }, 60_000);

  // =========================================================================
  // Scenario 6 (F5 + F9 + F10 + F11): Cross-Layer XDR Execution Parity
  // =========================================================================
  it("Scenario 6 (F5+F9+F10+F11): Frontend stellar.ts buildActionArgs -> Soroban market_factory & yield_pool WASM execution across Blend & Slender", async () => {
    const { admin, factory } = await setupFactory(session, T0);
    const lp = await session.genAddress("lp");
    const traderC = await session.genAddress("trader_c");
    const { asset: usdc, blend } = await setupBlendAndAsset(session, admin, "USDC");

    // 1. Deploy & seed Blend USDC 90D market
    const blendMat = T0 + 90 * DAY;
    const mBlend = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
      aAddr(admin),
      aAddr(usdc),
      aAddr(blend),
      aU64(blendMat),
      aI128(SCALAR_ROOT),
      aI128(POS_ANCHOR),
    ]);
    await session.sacMint(usdc, lp, 220_000_000_000n);
    await mustInvoke(session, mBlend.sy, "deposit", [
      aAddr(lp),
      aAddr(lp),
      aI128(220_000_000_000n),
    ]);
    await mustInvoke(session, mBlend.pool, "mint_py", [
      aAddr(lp),
      aAddr(lp),
      aI128(120_000_000_000n),
      aU64(blendMat),
    ]);
    await mustInvoke(session, mBlend.pool, "add_liquidity", [
      aAddr(lp),
      aAddr(lp),
      aI128(120_000_000_000n),
      aI128(100_000_000_000n),
      aI128(1),
    ]);

    // 2. Deploy, register & seed Slender (sy-sUSDC) 60D market
    const { slender, sySlender } = await deploySlenderAndWrapper(session, admin, usdc);
    void slender;
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

    // Fund traderC with 100M SY for direct pool calls + 300M USDC for Zap-Ins
    await session.sacMint(usdc, traderC, 400_000_000n);
    await mustInvoke(session, mBlend.sy, "deposit", [
      aAddr(traderC),
      aAddr(traderC),
      aI128(100_000_000n),
    ]);

    const blendDef = makeSessionMarketDef({
      id: "usdc-90d",
      assetCode: "USDC",
      sacId: usdc,
      poolId: mBlend.pool,
      syId: mBlend.sy,
      ptId: mBlend.pt,
      ytId: mBlend.yt,
      blendPoolId: blend,
      maturity: blendMat,
      sySymbol: "sy-bUSDC",
    });
    const slenderDef = makeSessionMarketDef({
      id: "susdc-60d",
      assetCode: "USDC",
      sacId: usdc,
      poolId: slPool,
      syId: sySlender,
      ptId: slPt,
      ytId: slYt,
      blendPoolId: slender,
      maturity: slMat,
      sySymbol: "sy-sUSDC",
    });
    const validDeadline = BigInt(T0 + 600);

    // 3. Frontend buildActionArgs -> yield_pool.wasm (mint_py, swap_exact_sy_for_pt valid + 0n #10)
    const mintEnc = buildActionArgsCompat(
      { type: "mint_py", caller: traderC, amount: 50_000_000n, deadline: validDeadline },
      blendDef,
      validDeadline
    );
    expect(mintEnc.args.length).toBe(4);
    expect(inspectScValArgs(mintEnc.args)[3]!.xdrType).toBe("scvU64");
    await mustInvoke(session, mBlend.pool, mintEnc.method, scValsToTypedArgs(mintEnc.args));
    expect(await mustInvoke<string>(session, mBlend.pt, "balance", [aAddr(traderC)])).toBe(
      "50000000"
    );
    expect(await mustInvoke<string>(session, mBlend.yt, "balance", [aAddr(traderC)])).toBe(
      "50000000"
    );

    const swapEnc = buildActionArgsCompat(
      {
        type: "swap",
        caller: traderC,
        method: "swap_exact_sy_for_pt",
        amountIn: 25_000_000n,
        minOut: 1n,
        deadline: validDeadline,
      },
      blendDef,
      validDeadline
    );
    expect(swapEnc.args.length).toBe(5);
    expect(inspectScValArgs(swapEnc.args)[4]!.xdrType).toBe("scvU64");
    await mustInvoke(session, mBlend.pool, swapEnc.method, scValsToTypedArgs(swapEnc.args));
    expect(
      BigInt(await mustInvoke<string>(session, mBlend.pt, "balance", [aAddr(traderC)]))
    ).toBeGreaterThan(50_000_000n);

    const expiredSwapEnc = buildActionArgsCompat(
      {
        type: "swap",
        caller: traderC,
        method: "swap_exact_sy_for_pt",
        amountIn: 25_000_000n,
        minOut: 1n,
        deadline: 0n,
      },
      blendDef,
      0n
    );
    expect(expiredSwapEnc.args.length).toBe(5);
    expectContractError(
      await session.invoke(
        mBlend.pool,
        expiredSwapEnc.method,
        scValsToTypedArgs(expiredSwapEnc.args)
      ),
      10,
      "DeadlineExpired"
    );

    // 4. Frontend buildActionArgs -> market_factory.wasm Zap-Ins (Blend PT, Slender YT, Blend LP)
    const zapPlans: Array<{
      method: "zap_in_pt" | "zap_in_yt" | "zap_in_lp";
      def: MarketDefinition;
    }> = [
      { method: "zap_in_pt", def: blendDef },
      { method: "zap_in_yt", def: slenderDef },
      { method: "zap_in_lp", def: blendDef },
    ];
    for (const plan of zapPlans) {
      const zapEnc = buildActionArgsCompat(
        {
          type: plan.method,
          caller: traderC,
          receiver: traderC,
          pool: plan.def.contracts.poolId,
          poolId: plan.def.contracts.poolId,
          underlyingAmount: 100_000_000n,
          amount: 100_000_000n,
          amountIn: 100_000_000n,
          minOut: 1n,
          minPtOut: 1n,
          minYtOut: 1n,
          minLpOut: 1n,
          deadline: validDeadline,
        },
        plan.def,
        validDeadline
      );
      expect(zapEnc).toBeDefined();
      expect(zapEnc.args.length).toBe(6);
      expect(inspectScValArgs(zapEnc.args).map((a) => a.xdrType)).toEqual([
        "scvAddress",
        "scvAddress",
        "scvAddress",
        "scvI128",
        "scvI128",
        "scvU64",
      ]);
      await mustInvoke(session, factory, zapEnc.method, scValsToTypedArgs(zapEnc.args));
    }

    expect(
      BigInt(await mustInvoke<string>(session, slYt, "balance", [aAddr(traderC)]))
    ).toBeGreaterThan(0n);
    expect(
      BigInt(await mustInvoke<string>(session, mBlend.pool, "balance", [aAddr(traderC)]))
    ).toBeGreaterThan(0n);
    await assertFactoryZeroDust(session, factory, [
      usdc,
      mBlend.sy,
      mBlend.pt,
      mBlend.yt,
      mBlend.pool,
      sySlender,
      slPt,
      slYt,
      slPool,
    ]);
  }, 60_000);

  // =========================================================================
  // Scenario 7 (F5 + F11 + R5): Autonomous AI Agent MCP Workflow
  // =========================================================================
  it(
    "Scenario 7 (F5+F11+R5): Autonomous AI Agent MCP workflow wired to live WASM MarketState, executing XDRs with deadline & R5 scope guards",
    async () => {
      // 1. Verify Stdio MCP exposes strictly 8 tools and 2 resources
      const stdio = await connectAgentMcpStdio({ manifestPath: DEPLOYED_CONTRACTS_PATH });
      try {
        expect(await stdio.listToolNames()).toEqual([...EXPECTED_MCP_TOOLS]);
        expect(await stdio.listResourceUris()).toEqual([...EXPECTED_MCP_RESOURCES]);
      } finally {
        await stdio.close();
      }

      // 2. Wall-clock synced Soroban WASM market + userG funded with SY via sy.deposit(lpC, userG, amt)
      const nowWall = Math.floor(Date.now() / 1000);
      const maturityWall = nowWall + 90 * DAY;
      const { admin, factory } = await setupFactory(session, nowWall);
      const lpC = await session.genAddress("lp_c");
      const userG = await session.genAccount("agent_g");
      const { asset: usdc, blend } = await setupBlendAndAsset(session, admin, "USDC");
      const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(usdc),
        aAddr(blend),
        aU64(maturityWall),
        aI128(SCALAR_ROOT),
        aI128(POS_ANCHOR),
      ]);

      await session.sacMint(usdc, lpC, 320_000_000_000n);
      await mustInvoke(session, meta.sy, "deposit", [
        aAddr(lpC),
        aAddr(lpC),
        aI128(220_000_000_000n),
      ]);
      await mustInvoke(session, meta.pool, "mint_py", [
        aAddr(lpC),
        aAddr(lpC),
        aI128(120_000_000_000n),
        aU64(maturityWall),
      ]);
      await mustInvoke(session, meta.pool, "add_liquidity", [
        aAddr(lpC),
        aAddr(lpC),
        aI128(120_000_000_000n),
        aI128(100_000_000_000n),
        aI128(1),
      ]);
      // Credit userG with 100,000,000,000 SY directly without classic Stellar USDC trustline
      await mustInvoke(session, meta.sy, "deposit", [
        aAddr(lpC),
        aAddr(userG),
        aI128(100_000_000_000n),
      ]);

      const baseManifest = JSON.parse(
        readFileSync(DEPLOYED_CONTRACTS_PATH, "utf8")
      ) as DeploymentManifest;
      const tmpDir = mkdtempSync(join(tmpdir(), "nivora-t4-agent-"));
      const tmpManifestPath = join(tmpDir, "deployed_contracts.json");
      const liveManifest: DeploymentManifest = {
        ...baseManifest,
        contracts: {
          ...baseManifest.contracts,
          mock_blend: { ...baseManifest.contracts.mock_blend, contractId: blend },
          sy_blend_wrapper: { ...baseManifest.contracts.sy_blend_wrapper, contractId: meta.sy },
          pt_token: { ...baseManifest.contracts.pt_token, contractId: meta.pt },
          yt_token: { ...baseManifest.contracts.yt_token, contractId: meta.yt },
          yield_pool: { ...baseManifest.contracts.yield_pool, contractId: meta.pool },
        },
        market: {
          ...baseManifest.market,
          maturity: maturityWall,
          maturityIso: new Date(maturityWall * 1000).toISOString(),
        },
      };
      writeFileSync(tmpManifestPath, JSON.stringify(liveManifest, null, 2), "utf8");

      // 3. Local Soroban JSON-RPC shim serving live WASM reads (get_market_state, exchange_rate, get_exchange_rate, total_supply)
      const rpcServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const body = (await req.json()) as {
            id: number | string;
            method: string;
            params?: { keys?: string[]; transaction?: string };
          };
          if (body.method === "getLedgerEntries") {
            const keyXdr = body.params?.keys?.[0] ?? "";
            const accountEntry = new xdr.AccountEntry({
              accountId: Keypair.fromPublicKey(userG).xdrPublicKey(),
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
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                entries: [
                  {
                    key: keyXdr,
                    xdr: xdr.LedgerEntryData.account(accountEntry).toXDR("base64"),
                    lastModifiedLedgerSeq: 100,
                  },
                ],
                latestLedger: 100,
              },
            });
          }
          if (body.method === "getLatestLedger") {
            const header = new xdr.LedgerHeader({
              ledgerVersion: 28,
              previousLedgerHash: Buffer.alloc(32),
              scpValue: new xdr.StellarValue({
                txSetHash: Buffer.alloc(32),
                closeTime: xdr.Uint64.fromString(String(nowWall)),
                upgrades: [],
                ext: xdr.StellarValueExt.stellarValueBasic(),
              }),
              txSetResultHash: Buffer.alloc(32),
              bucketListHash: Buffer.alloc(32),
              ledgerSeq: 100,
              totalCoins: xdr.Int64.fromString("1000000000000000000"),
              feePool: xdr.Int64.fromString("0"),
              inflationSeq: 0,
              idPool: xdr.Uint64.fromString("0"),
              baseFee: 100,
              baseReserve: 5000000,
              maxTxSetSize: 100,
              skipList: [
                Buffer.alloc(32),
                Buffer.alloc(32),
                Buffer.alloc(32),
                Buffer.alloc(32),
              ],
              ext: xdr.LedgerHeaderExt.v0(),
            });
            const closeMeta = xdr.LedgerCloseMeta.v0(
              new xdr.LedgerCloseMetaV0({
                ledgerHeader: new xdr.LedgerHeaderHistoryEntry({
                  hash: Buffer.alloc(32),
                  header,
                  ext: xdr.LedgerHeaderHistoryEntryExt.v0(),
                }),
                txSet: new xdr.TransactionSet({
                  previousLedgerHash: Buffer.alloc(32),
                  txs: [],
                }),
                txProcessing: [],
                upgradesProcessing: [],
                scpInfo: [],
              })
            );
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                id: "hash",
                sequence: 100,
                protocolVersion: 28,
                headerXdr: header.toXDR("base64"),
                metadataXdr: closeMeta.toXDR("base64"),
              },
            });
          }
          if (body.method === "simulateTransaction") {
            let retvalScVal: xdr.ScVal = xdr.ScVal.scvVoid();
            const txXdr = body.params?.transaction;
            if (typeof txXdr === "string") {
              const parsed = TransactionBuilder.fromXdr(
                txXdr,
                liveManifest.networkPassphrase
              );
              if (parsed instanceof Transaction) {
                const op = parsed.operations[0];
                if (
                  op?.type === "invokeHostFunction" &&
                  op.func.type === "hostFunctionTypeInvokeContract"
                ) {
                  const cid = Address.fromScAddress(op.func.value.contractAddress).toString();
                  const fn = op.func.value.functionName.toString();
                  if (fn === "get_market_state") {
                    const st = await mustInvoke<MarketState>(session, cid, "get_market_state");
                    retvalScVal = encodeMarketStateScVal(st);
                  } else if (
                    fn === "exchange_rate" ||
                    fn === "get_exchange_rate" ||
                    fn === "total_supply"
                  ) {
                    const valStr = await mustInvoke<string>(session, cid, fn);
                    retvalScVal = nativeToScVal(BigInt(valStr), { type: "i128" });
                  }
                }
              }
            }
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                id: "sim-t4-agent",
                latestLedger: 100,
                minResourceFee: "50000",
                transactionData: new SorobanDataBuilder().build().toXDR("base64"),
                results: [{ auth: [], xdr: retvalScVal.toXDR("base64") }],
                events: [],
              },
            });
          }
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: `Unsupported method: ${body.method}` },
          });
        },
      });

      const { mcpServer, client } = createStellarPendleMcpServer(tmpManifestPath);
      (client as unknown as { rpcServer: rpc.Server }).rpcServer = new rpc.Server(
        `http://127.0.0.1:${rpcServer.port}`,
        { allowHttp: true }
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: "t4-scenario7-mcp-client", version: "0.1.0" },
        { capabilities: {} }
      );
      await Promise.all([
        mcpServer.connect(serverTransport),
        mcpClient.connect(clientTransport),
      ]);

      const callToolJson = async <T>(
        name: string,
        args: Record<string, unknown> = {}
      ): Promise<T> => {
        const res = await mcpClient.callTool({ name, arguments: args });
        if ("isError" in res && res.isError) {
          const msg =
            "content" in res && Array.isArray(res.content) && res.content[0]?.type === "text"
              ? String(res.content[0].text)
              : JSON.stringify(res);
          throw new Error(`MCP tool ${name} failed: ${msg}`);
        }
        const content = (res as { content?: Array<{ type: string; text?: string }> }).content;
        return JSON.parse(content?.[0]?.text ?? "{}") as T;
      };

      try {
        // 4. Live MCP tool chain -> decode XDR -> execute against yield_pool WASM
        const stateSnap = await callToolJson<{
          ptReserve: string;
          syReserve: string;
          isMatured: boolean;
        }>("get_market_state");
        expect(stateSnap.ptReserve).toBe("120000000000");
        expect(stateSnap.syReserve).toBe("100000000000");
        expect(stateSnap.isMatured).toBe(false);

        const quote = await callToolJson<{
          estimatedOut: string;
          minOutWithSlippage: string;
        }>("quote_yield_strategy", {
          direction: "sy_for_pt",
          humanAmountIn: "10",
          slippageBps: 50,
        });
        expect(BigInt(quote.estimatedOut)).toBeGreaterThan(0n);
        expect(BigInt(quote.minOutWithSlippage)).toBeGreaterThan(0n);

        const mintRes = await callToolJson<{ unsignedXdr: string }>("build_mint_py_xdr", {
          sourceAddress: userG,
          humanAmountSy: "10",
        });
        const decodedMint = decodeUnsignedInvokeContractXdr(
          mintRes.unsignedXdr,
          liveManifest.networkPassphrase
        );
        expect(decodedMint.functionName).toBe("mint_py");
        expect(decodedMint.args.length).toBe(4);
        expect(decodedMint.args[3]!.xdrType).toBe("scvU64");
        expect((decodedMint.args[3]!.native as bigint) > BigInt(nowWall)).toBe(true);

        await mustInvoke(
          session,
          decodedMint.contractId,
          decodedMint.functionName,
          scValsToTypedArgs(decodedMint.args.map((a) => a.raw))
        );
        expect(await mustInvoke<string>(session, meta.pt, "balance", [aAddr(userG)])).toBe(
          "100000000"
        );
        expect(await mustInvoke<string>(session, meta.yt, "balance", [aAddr(userG)])).toBe(
          "100000000"
        );

        const swapRes = await callToolJson<{
          quote: { minOutWithSlippage: string };
          transaction: { unsignedXdr: string };
        }>("build_swap_xdr", {
          sourceAddress: userG,
          direction: "sy_for_pt",
          humanAmountIn: "5",
          slippageBps: 50,
        });
        const decodedSwap = decodeUnsignedInvokeContractXdr(
          swapRes.transaction.unsignedXdr,
          liveManifest.networkPassphrase
        );
        expect(decodedSwap.functionName).toBe("swap_exact_sy_for_pt");
        expect(decodedSwap.args.length).toBe(5);
        expect(decodedSwap.args[4]!.xdrType).toBe("scvU64");

        await mustInvoke(
          session,
          decodedSwap.contractId,
          decodedSwap.functionName,
          scValsToTypedArgs(decodedSwap.args.map((a) => a.raw))
        );
        const ptAfterSwap = BigInt(
          await mustInvoke<string>(session, meta.pt, "balance", [aAddr(userG)])
        );
        expect(ptAfterSwap - 100_000_000n).toBeGreaterThanOrEqual(
          BigInt(swapRes.quote.minOutWithSlippage)
        );

        // Explicit 0n deadline via AgentClient reverts #10 DeadlineExpired inside yield_pool.wasm
        const expiredSwap = await (
          client.buildSwapTx as unknown as BuildSwapCompat
        ).call(client, userG, "sy_for_pt", 50_000_000n, 1n, userG, 0n);
        const decExpired = decodeUnsignedInvokeContractXdr(
          expiredSwap.unsignedXdr,
          liveManifest.networkPassphrase
        );
        expect(decExpired.args.length).toBe(5);
        expect(decExpired.args[4]!.native).toBe(0n);
        expectContractError(
          await session.invoke(
            decExpired.contractId,
            decExpired.functionName,
            scValsToTypedArgs(decExpired.args.map((a) => a.raw))
          ),
          10,
          "DeadlineExpired"
        );

        // 5. R5 Scope Enforcement
        expect(scanR5OutOfScopeSymbols().ok).toBe(true);
        await expect(callToolJson("place_limit_order", {})).rejects.toThrow();
      } finally {
        await Promise.all([mcpClient.close(), mcpServer.close()]);
        rpcServer.stop(true);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    60_000
  );
});
