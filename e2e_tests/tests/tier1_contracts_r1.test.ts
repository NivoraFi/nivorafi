// e2e_tests/tests/tier1_contracts_r1.test.ts
// Tier 1: Genuine Soroban WASM E2E Happy-Path Tests for R1 (F1-F5: 25 tests)

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  SorobanRunnerSession,
  type TypedArg,
  type SorobanEventRecord,
} from "../src/harness/soroban-harness.ts";
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

const T0 = 1_700_000_000;
const DAY = 86_400;
const SCALAR_9 = 1_000_000_000n;
const SCALAR_ROOT = 20n * WAD;
const INITIAL_ANCHOR = WAD;
const DEFAULT_ANNUAL_FEE_RATE = 50_000_000_000_000_000n; // 5%
const DEFAULT_PROTOCOL_FEE_BPS = 2_000n; // 20%

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
const aBytes32 = (value: string): TypedArg => ({ type: "bytes_n32", value });

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

  return { admin, guardian, factory, ptHash, ytHash, poolHash, syHash };
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

async function setupDirectPool(
  session: SorobanRunnerSession,
  days = 90,
  timestamp = T0
) {
  await session.reset({
    timestamp,
    sequence: 100,
    auth_mode: "mock_all",
    budget_mode: "unlimited",
  });
  const admin = await session.genAddress("admin");
  const feeRecipient = await session.genAddress("fee_recipient");
  const lp = await session.genAddress("lp");
  const user1 = await session.genAddress("user1");
  const user2 = await session.genAddress("user2");

  const usdc = await session.createSac("USDC", { admin, name: "usdc" });
  const blend = await session.deployWasm("mock_blend.wasm", { var_name: "blend" });
  await mustInvoke(session, blend, "initialize", [
    aAddr(admin),
    aAddr(usdc),
    aI128(SCALAR_9),
  ]);

  const sy = await session.deployWasm("sy_blend_wrapper.wasm", { var_name: "sy" });
  await mustInvoke(session, sy, "initialize", [
    aAddr(admin),
    aAddr(usdc),
    aAddr(blend),
  ]);

  const pt = await session.deployWasm("pt_token.wasm", { var_name: "pt" });
  const yt = await session.deployWasm("yt_token.wasm", { var_name: "yt" });
  const pool = await session.deployWasm("yield_pool.wasm", { var_name: "pool" });

  const maturity = timestamp + days * DAY;
  await mustInvoke(session, pt, "initialize", [
    aAddr(admin),
    aAddr(pool),
    { type: "string", value: `PT USDC ${days}D` },
    { type: "string", value: `PT-USDC-${days}D` },
    aU32(7),
    aU64(maturity),
  ]);
  await mustInvoke(session, yt, "initialize", [
    aAddr(admin),
    aAddr(pool),
    aAddr(sy),
    { type: "string", value: `YT USDC ${days}D` },
    { type: "string", value: `YT-USDC-${days}D` },
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
    aI128(INITIAL_ANCHOR),
  ]);
  await mustInvoke(session, pool, "set_fee_recipient", [
    aAddr(admin),
    aAddr(feeRecipient),
  ]);

  return {
    admin,
    feeRecipient,
    lp,
    user1,
    user2,
    usdc,
    blend,
    sy,
    pt,
    yt,
    pool,
    maturity,
  };
}

async function seedPool(
  session: SorobanRunnerSession,
  ctx: Awaited<ReturnType<typeof setupDirectPool>>,
  ptAmount = 120_000_000_000n,
  syAmount = 100_000_000_000n
) {
  const totalDeposit = ptAmount + syAmount;
  await session.sacMint(ctx.usdc, ctx.lp, totalDeposit);
  await mustInvoke(session, ctx.sy, "deposit", [
    aAddr(ctx.lp),
    aAddr(ctx.lp),
    aI128(totalDeposit),
  ]);
  await mustInvoke(session, ctx.pool, "mint_py", [
    aAddr(ctx.lp),
    aAddr(ctx.lp),
    aI128(ptAmount),
    aU64(ctx.maturity),
  ]);
  const lpShares = await mustInvoke<string>(session, ctx.pool, "add_liquidity", [
    aAddr(ctx.lp),
    aAddr(ctx.lp),
    aI128(ptAmount),
    aI128(syAmount),
    aI128(1),
  ]);
  return BigInt(lpShares);
}

async function assertReserveConservation(
  session: SorobanRunnerSession,
  sy: string,
  pool: string,
  pt?: string,
  tolerance = 2n
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
    expect(ptPrincipalBig).toBeGreaterThanOrEqual(ptTotalSupply);
  }
  return { state, ptPrincipal: ptPrincipalBig, ytYield: ytYieldBig, poolSyBal };
}

describe("Tier 1: R1 Contracts E2E Suite (F1-F5)", () => {
  let session: SorobanRunnerSession;

  beforeAll(async () => {
    session = await SorobanRunnerSession.start();
  }, 120_000);

  afterAll(async () => {
    await session?.close();
  });

  // =========================================================================
  // F1: market_factory::create_market Auth / Whitelist (5 tests)
  // =========================================================================
  describe("F1: market_factory::create_market Auth & Whitelist", () => {
    test("F1-T1-1: admin creates market, sets SyByAsset, indexes by id/pool/asset+maturity, emits MarketCreatedEvent", async () => {
      const { admin, factory } = await setupFactory(session);
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");
      const maturity = T0 + 90 * DAY;

      const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(maturity),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      const events = await session.getEvents(factory);
      const createdEv = events.find(
        (ev: SorobanEventRecord) => ev.topics[0] === "market_created_event"
      );
      expect(createdEv).toBeDefined();
      expect(createdEv!.topics[1]).toBe(0);
      expect(createdEv!.topics[2]).toBe(meta.pool);
      expect(createdEv!.topics[3]).toBe(asset);

      expect(meta.id).toBe(0);
      expect(meta.is_active).toBe(true);
      expect(meta.asset).toBe(asset);
      expect(meta.maturity).toBe(String(maturity));

      const syForAsset = await mustInvoke<string | null>(
        session,
        factory,
        "get_sy_for_asset",
        [aAddr(asset)]
      );
      expect(syForAsset).toBe(meta.sy);

      const byId = await mustInvoke<MarketMetadata>(session, factory, "get_market", [aU32(0)]);
      const byPool = await mustInvoke<MarketMetadata | null>(
        session,
        factory,
        "get_market_by_pool",
        [aAddr(meta.pool)]
      );
      const byKey = await mustInvoke<MarketMetadata | null>(
        session,
        factory,
        "get_market_by_asset_maturity",
        [aAddr(asset), aU64(maturity)]
      );
      expect(byId).toEqual(meta);
      expect(byPool).toEqual(meta);
      expect(byKey).toEqual(meta);
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(1);
    });

    test("F1-T1-2: whitelisted creator creates market while deployed contracts remain owned by factory admin", async () => {
      const { admin, factory } = await setupFactory(session);
      const creator1 = await session.genAddress("creator1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");
      const maturity = T0 + 90 * DAY;

      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);
      const events = await session.getEvents(factory);
      const wlEv = events.find(
        (ev) => ev.topics[0] === "creator_whitelist_updated_event"
      );
      expect(wlEv).toBeDefined();
      expect(wlEv!.topics[1]).toBe(admin);
      expect(wlEv!.topics[2]).toBe(creator1);

      expect(
        await mustInvoke<boolean>(session, factory, "is_whitelisted_creator", [
          aAddr(creator1),
        ])
      ).toBe(true);

      const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(asset),
        aAddr(blend),
        aU64(maturity),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(1);

      expect(await mustInvoke<string>(session, meta.sy, "get_admin")).toBe(admin);
      expect(await mustInvoke<string>(session, meta.pt, "get_admin")).toBe(admin);
      expect(await mustInvoke<string>(session, meta.yt, "get_admin")).toBe(admin);
      expect(await mustInvoke<string>(session, meta.pool, "get_admin")).toBe(admin);
    });

    test("F1-T1-3: creating second maturity for same asset reuses canonical SyByAsset", async () => {
      const { admin, factory } = await setupFactory(session);
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      const m0 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      const m1 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 30 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(2);
      expect(m1.sy).toBe(m0.sy);
      expect(m1.pool).not.toBe(m0.pool);
      expect(m1.id).toBe(1);
    });

    test("F1-T1-4: granting then revoking creator whitelist preserves unconditional admin privilege", async () => {
      const { admin, factory } = await setupFactory(session);
      const creator1 = await session.genAddress("creator1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);
      expect(
        await mustInvoke<boolean>(session, factory, "is_whitelisted_creator", [
          aAddr(creator1),
        ])
      ).toBe(true);

      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(false),
      ]);
      expect(
        await mustInvoke<boolean>(session, factory, "is_whitelisted_creator", [
          aAddr(creator1),
        ])
      ).toBe(false);

      const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      expect(meta.id).toBe(0);
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(1);
    });

    test("F1-T1-5: whitelisted creator creates XLM market and admin creates USDC market with distinct SYs", async () => {
      const { admin, factory } = await setupFactory(session);
      const creator1 = await session.genAddress("creator1");
      const usdcCtx = await setupBlendAndAsset(session, admin, "USDC");
      const xlmCtx = await setupBlendAndAsset(session, admin, "XLM");

      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);

      const mXlm = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(xlmCtx.asset),
        aAddr(xlmCtx.blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      const mUsdc = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(usdcCtx.asset),
        aAddr(usdcCtx.blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(2);
      const list = await mustInvoke<MarketMetadata[]>(session, factory, "list_markets", [
        aU32(0),
        aU32(10),
      ]);
      expect(list).toHaveLength(2);
      expect(mXlm.sy).not.toBe(mUsdc.sy);
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [
          aAddr(xlmCtx.asset),
        ])
      ).toBe(mXlm.sy);
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [
          aAddr(usdcCtx.asset),
        ])
      ).toBe(mUsdc.sy);
    });
  });

  // =========================================================================
  // F2: Dynamic Token Metadata (5 tests)
  // =========================================================================
  describe("F2: Dynamic Token Metadata", () => {
    test("F2-T1-1: sy_blend_wrapper initialized with USDC SAC derives sy-bUSDC metadata", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");
      const sy = await session.deployWasm("sy_blend_wrapper.wasm");
      await mustInvoke(session, sy, "initialize", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
      ]);

      expect(await mustInvoke<string>(session, sy, "symbol")).toBe("sy-bUSDC");
      expect(await mustInvoke<string>(session, sy, "name")).toBe(
        "Standardized Yield Blend USDC"
      );
      expect(await mustInvoke<number>(session, sy, "decimals")).toBe(7);
    });

    test("F2-T1-2: sy_blend_wrapper initialized with XLM SAC derives sy-bXLM metadata", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "XLM");
      const xlmDec = await mustInvoke<number>(session, asset, "decimals");
      const sy = await session.deployWasm("sy_blend_wrapper.wasm");
      await mustInvoke(session, sy, "initialize", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
      ]);

      expect(await mustInvoke<string>(session, sy, "symbol")).toBe("sy-bXLM");
      expect(await mustInvoke<string>(session, sy, "name")).toBe(
        "Standardized Yield Blend XLM"
      );
      expect(await mustInvoke<number>(session, sy, "decimals")).toBe(xlmDec);
    });

    test("F2-T1-3: market_factory::create_market generates dynamic USDC PT/YT/LP metadata", async () => {
      const { admin, factory } = await setupFactory(session);
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");
      const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      expect(await mustInvoke<string>(session, meta.pt, "name")).toBe("PT USDC 90D");
      expect(await mustInvoke<string>(session, meta.pt, "symbol")).toBe("PT-USDC-90D");
      expect(await mustInvoke<number>(session, meta.pt, "decimals")).toBe(7);

      expect(await mustInvoke<string>(session, meta.yt, "name")).toBe("YT USDC 90D");
      expect(await mustInvoke<string>(session, meta.yt, "symbol")).toBe("YT-USDC-90D");
      expect(await mustInvoke<number>(session, meta.yt, "decimals")).toBe(7);

      expect(await mustInvoke<string>(session, meta.pool, "name")).toBe(
        "NivoraFi LP USDC"
      );
      expect(await mustInvoke<string>(session, meta.pool, "symbol")).toBe("LP-USDC");
      expect(await mustInvoke<number>(session, meta.pool, "decimals")).toBe(7);
    });

    test("F2-T1-4: market_factory::create_market generates dynamic XLM PT/YT/LP metadata distinct from USDC", async () => {
      const { admin, factory } = await setupFactory(session);
      const usdcCtx = await setupBlendAndAsset(session, admin, "USDC");
      const xlmCtx = await setupBlendAndAsset(session, admin, "XLM");

      const mUsdc = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(usdcCtx.asset),
        aAddr(usdcCtx.blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      const mXlm = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(xlmCtx.asset),
        aAddr(xlmCtx.blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      expect(await mustInvoke<string>(session, mXlm.pt, "symbol")).toBe("PT-XLM-90D");
      expect(await mustInvoke<string>(session, mXlm.pt, "name")).toBe("PT XLM 90D");
      expect(await mustInvoke<string>(session, mXlm.yt, "symbol")).toBe("YT-XLM-90D");
      expect(await mustInvoke<string>(session, mXlm.yt, "name")).toBe("YT XLM 90D");
      expect(await mustInvoke<string>(session, mXlm.pool, "symbol")).toBe("LP-XLM");
      expect(await mustInvoke<string>(session, mXlm.pool, "name")).toBe("NivoraFi LP XLM");
      expect(await mustInvoke<number>(session, mXlm.pool, "decimals")).toBe(
        await mustInvoke<number>(session, xlmCtx.asset, "decimals")
      );
      expect(await mustInvoke<string>(session, mXlm.pt, "symbol")).not.toBe(
        await mustInvoke<string>(session, mUsdc.pt, "symbol")
      );
    });

    test("F2-T1-5: USDC 30D and 90D markets expose distinct tenor-aware PT and YT metadata", async () => {
      const { admin, factory } = await setupFactory(session);
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      const m30 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 30 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      const m90 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      expect(await mustInvoke<string>(session, m30.pt, "symbol")).toBe("PT-USDC-30D");
      expect(await mustInvoke<string>(session, m30.yt, "symbol")).toBe("YT-USDC-30D");
      expect(await mustInvoke<string>(session, m90.pt, "symbol")).toBe("PT-USDC-90D");
      expect(await mustInvoke<string>(session, m90.yt, "symbol")).toBe("YT-USDC-90D");
      expect(await mustInvoke<number>(session, m30.pt, "decimals")).toBe(7);
      expect(await mustInvoke<number>(session, m90.yt, "decimals")).toBe(7);
    });
  });

  // =========================================================================
  // F3: yield_pool Swap Fee & Reserve Conservation (5 tests)
  // =========================================================================
  describe("F3: yield_pool Swap Fee & Reserve Conservation", () => {
    test("F3-T1-1: swap_exact_pt_for_sy matches oracle, routes SY protocol fee, and conserves reserves", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);

      const ptIn = 5_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user2, 20_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(20_000_000_000n),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(20_000_000_000n),
        aU64(ctx.maturity),
      ]);

      const expected = oracleSwapPtForSy(
        ptIn,
        120_000_000_000n,
        100_000_000_000n,
        BigInt(T0),
        BigInt(ctx.maturity)
      );

      const [syOutStr, feeStr] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_pt_for_sy",
        [aAddr(ctx.user2), aAddr(ctx.user2), aI128(ptIn), aI128(1), aU64(ctx.maturity)]
      );

      const syOut = BigInt(syOutStr);
      const fee = BigInt(feeStr);
      expect(syOut).toBe(expected.netOut);
      expect(fee).toBe(expected.fee);
      expect(
        BigInt(await mustInvoke<string>(session, ctx.sy, "balance", [aAddr(ctx.feeRecipient)]))
      ).toBe(expected.protoFee);

      await assertReserveConservation(session, ctx.sy, ctx.pool, ctx.pt);
    });

    test("F3-T1-2: swap_exact_sy_for_pt matches oracle, routes PT protocol fee, and conserves reserves", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);

      const syIn = 2_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user2, syIn);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(syIn),
      ]);

      const expected = oracleSwapSyForPt(
        syIn,
        120_000_000_000n,
        100_000_000_000n,
        BigInt(T0),
        BigInt(ctx.maturity)
      );

      const [ptOutStr, feeStr] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_sy_for_pt",
        [aAddr(ctx.user2), aAddr(ctx.user2), aI128(syIn), aI128(1), aU64(ctx.maturity)]
      );

      expect(BigInt(ptOutStr)).toBe(expected.netOut);
      expect(BigInt(feeStr)).toBe(expected.fee);
      expect(
        BigInt(await mustInvoke<string>(session, ctx.pt, "balance", [aAddr(ctx.feeRecipient)]))
      ).toBe(expected.protoFee);

      const { state } = await assertReserveConservation(session, ctx.sy, ctx.pool, ctx.pt);
      expect(
        await mustInvoke<string>(session, ctx.pt, "balance", [aAddr(ctx.pool)])
      ).toBe(state.total_pt_reserve);
    });

    test("F3-T1-3: swap_exact_sy_for_yt returns (yt_out, fee) matching oracle, SwapEvent.fee (not sy_in), feeRecipient delta, and updates pool PT", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);

      const syIn = 500_000_000n;
      await session.sacMint(ctx.usdc, ctx.user2, syIn);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(syIn),
      ]);

      const ptBeforePool = BigInt(
        await mustInvoke<string>(session, ctx.pt, "balance", [aAddr(ctx.pool)])
      );
      const feeBefore = BigInt(
        await mustInvoke<string>(session, ctx.sy, "balance", [aAddr(ctx.feeRecipient)])
      );

      const expected = oracleSwapSyForYt(
        syIn,
        120_000_000_000n,
        100_000_000_000n,
        BigInt(T0),
        BigInt(ctx.maturity)
      );

      const [ytOutStr, feeStr] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_sy_for_yt",
        [aAddr(ctx.user2), aAddr(ctx.user2), aI128(syIn), aI128(1), aU64(ctx.maturity)]
      );

      const events = await session.getEvents(ctx.pool);
      const swapEv = [...events]
        .reverse()
        .find((ev) => ev.topics[0] === "swap_event");
      expect(swapEv).toBeDefined();
      const evData = swapEv!.data as { direction: number; fee: string; amount_out: string };
      expect(evData.direction).toBe(2);
      expect(evData.amount_out).toBe(ytOutStr);
      expect(evData.fee).toBe(feeStr);

      const ytOut = BigInt(ytOutStr);
      const fee = BigInt(feeStr);
      expect(ytOut).toBe(expected.ytOut);
      expect(fee).toBe(expected.fee);
      expect(fee).not.toBe(syIn);

      const feeAfter = BigInt(
        await mustInvoke<string>(session, ctx.sy, "balance", [aAddr(ctx.feeRecipient)])
      );
      expect(feeAfter - feeBefore).toBe(expected.protoFee);
      expect(feeAfter - feeBefore).toBe((fee * 2000n) / 10_000n);

      expect(await mustInvoke<string>(session, ctx.yt, "balance", [aAddr(ctx.user2)])).toBe(
        ytOutStr
      );

      const ptAfterPool = BigInt(
        await mustInvoke<string>(session, ctx.pt, "balance", [aAddr(ctx.pool)])
      );
      expect(ptAfterPool - ptBeforePool).toBe(ytOut);

      await assertReserveConservation(session, ctx.sy, ctx.pool, ctx.pt);
    });

    test("F3-T1-4: swap_exact_yt_for_sy matches oracle, burns user YT and pool PT, pays exact fee_recipient share, and conserves reserves", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);

      const syIn = 500_000_000n;
      await session.sacMint(ctx.usdc, ctx.user2, syIn);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(syIn),
      ]);
      const [ytMintedStr] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_sy_for_yt",
        [aAddr(ctx.user2), aAddr(ctx.user2), aI128(syIn), aI128(1), aU64(ctx.maturity)]
      );

      const ytIn = BigInt(ytMintedStr) / 2n;
      const stateBefore = await mustInvoke<MarketState>(session, ctx.pool, "get_market_state");
      const expected = oracleSwapYtForSy(
        ytIn,
        BigInt(stateBefore.total_pt_reserve),
        BigInt(stateBefore.total_sy_reserve),
        BigInt(T0),
        BigInt(ctx.maturity)
      );

      const feeBefore = BigInt(
        await mustInvoke<string>(session, ctx.sy, "balance", [aAddr(ctx.feeRecipient)])
      );
      const ptPoolBefore = BigInt(
        await mustInvoke<string>(session, ctx.pt, "balance", [aAddr(ctx.pool)])
      );
      const ytSupplyBefore = BigInt(await mustInvoke<string>(session, ctx.yt, "total_supply"));

      const [syOutStr, feeStr] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_yt_for_sy",
        [aAddr(ctx.user2), aAddr(ctx.user2), aI128(ytIn), aI128(1), aU64(ctx.maturity)]
      );

      const syOut = BigInt(syOutStr);
      const fee = BigInt(feeStr);
      expect(syOut).toBe(expected.netOut);
      expect(fee).toBe(expected.fee);

      const feeAfter = BigInt(
        await mustInvoke<string>(session, ctx.sy, "balance", [aAddr(ctx.feeRecipient)])
      );
      expect(feeAfter - feeBefore).toBe(expected.protoFee);
      expect(feeAfter - feeBefore).toBe((fee * 2000n) / 10_000n);

      expect(
        ptPoolBefore - BigInt(await mustInvoke<string>(session, ctx.pt, "balance", [aAddr(ctx.pool)]))
      ).toBe(ytIn);
      expect(ytSupplyBefore - BigInt(await mustInvoke<string>(session, ctx.yt, "total_supply"))).toBe(
        ytIn
      );

      await assertReserveConservation(session, ctx.sy, ctx.pool, ctx.pt);
    });

    test("F3-T1-5: all 4 swaps followed by 100% LP remove_liquidity returns (pt_out, sy_out) with zero PT principal erosion", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const lpBal = await seedPool(session, ctx, 300_000_000_000n, 200_000_000_000n);

      await session.sacMint(ctx.usdc, ctx.user2, 100_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(100_000_000_000n),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(40_000_000_000n),
        aU64(ctx.maturity),
      ]);

      await mustInvoke(session, ctx.pool, "swap_exact_pt_for_sy", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(10_000_000_000n),
        aI128(1),
        aU64(ctx.maturity),
      ]);
      await mustInvoke(session, ctx.pool, "swap_exact_sy_for_pt", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(10_000_000_000n),
        aI128(1),
        aU64(ctx.maturity),
      ]);
      await mustInvoke(session, ctx.pool, "swap_exact_sy_for_yt", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(500_000_000n),
        aI128(1),
        aU64(ctx.maturity),
      ]);
      await mustInvoke(session, ctx.pool, "swap_exact_yt_for_sy", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(1_000_000_000n),
        aI128(1),
        aU64(ctx.maturity),
      ]);

      // remove_liquidity returns (pt_out, sy_out) — PT at [0], SY at [1]
      const [ptOutStr, syOutStr] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "remove_liquidity",
        [aAddr(ctx.lp), aAddr(ctx.lp), aI128(lpBal), aI128(1), aI128(1)]
      );
      expect(BigInt(ptOutStr)).toBeGreaterThan(200_000_000_000n);
      expect(BigInt(syOutStr)).toBeGreaterThan(100_000_000_000n);

      const { ptPrincipal, ytYield, poolSyBal } = await assertReserveConservation(
        session,
        ctx.sy,
        ctx.pool,
        ctx.pt
      );
      expect(poolSyBal).toBeGreaterThanOrEqual(ptPrincipal + ytYield);
    });
  });

  // =========================================================================
  // F4: MaturityIndex Sync & PT/YT Reserve Separation (5 tests)
  // =========================================================================
  describe("F4: MaturityIndex Sync & PT/YT Reserve Separation", () => {
    test("F4-T1-1: pre-maturity claim_yield pays accrued YT yield while preserving PtPrincipalReserve 1:1", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const amt = 100_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user1, amt);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
        aU64(ctx.maturity),
      ]);

      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_100_000_000n)]);
      const claimed = BigInt(
        await mustInvoke<string>(session, ctx.pool, "claim_yield", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
        ])
      );
      // 1000 * (1.1 - 1.0) / 1.1 = 90.90909090
      const expectedSy = (amt * 100_000_000n) / 1_100_000_000n;
      expect(claimed >= expectedSy - 2n && claimed <= expectedSy + 2n).toBe(true);

      const [ptPrincipal, ytYield] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "get_py_reserves"
      );
      expect(BigInt(ytYield)).toBe(0n);
      expect(BigInt(ptPrincipal)).toBe(amt - claimed);
      expect(BigInt(ptPrincipal)).toBeGreaterThanOrEqual((amt * SCALAR_9) / 1_100_000_000n - 2n);
    });

    test("F4-T1-2: first post-maturity YT transfer pins MaturityIndex and syncs yield_pool::settle_maturity", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const amt = 100_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user1, amt);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
        aU64(ctx.maturity),
      ]);

      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_100_000_000n)]);
      await session.setLedger({ timestamp: ctx.maturity + 100 });
      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_300_000_000n)]);

      // Trigger yt_token internal update_checkpoint via transfer
      await mustInvoke(session, ctx.yt, "transfer", [
        aAddr(ctx.user1),
        aAddr(ctx.user2),
        aI128(1_000_000n),
      ]);

      // Rate spikes further to 1.50 before pool.settle_maturity is called
      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_500_000_000n)]);
      const settledIndex = await mustInvoke<string>(session, ctx.pool, "settle_maturity");
      expect(settledIndex).toBe("1300000000");

      const state = await mustInvoke<MarketState>(session, ctx.pool, "get_market_state");
      expect(state.is_settled).toBe(true);
      expect(state.maturity_index).toBe("1300000000");

      const claimed = BigInt(
        await mustInvoke<string>(session, ctx.pool, "claim_yield", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
        ])
      );
      const maxAt13 = (amt * 300_000_000n) / 1_300_000_000n;
      expect(claimed).toBeLessThanOrEqual(maxAt13 + 2n);
      expect(claimed).toBeGreaterThan(0n);
    });

    test("F4-T1-3: pool.settle_maturity pins yt_token index so subsequent rate rises yield 0 extra claim", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const amt = 100_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user1, amt);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
        aU64(ctx.maturity),
      ]);

      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_100_000_000n)]);
      await session.setLedger({ timestamp: ctx.maturity + 10 });
      const idx = await mustInvoke<string>(session, ctx.pool, "settle_maturity");
      expect(idx).toBe("1100000000");

      await session.setLedger({ timestamp: ctx.maturity + 500 });
      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_400_000_000n)]);

      const claimed1 = BigInt(
        await mustInvoke<string>(session, ctx.pool, "claim_yield", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
        ])
      );
      // Underlying yield is capped at MaturityIndex=1.1 (10B underlying), converted to SY at current_rate=1.4
      const expectedSyAt14 = (amt * 100_000_000n) / 1_400_000_000n;
      expect(claimed1 >= expectedSyAt14 - 2n && claimed1 <= expectedSyAt14 + 2n).toBe(true);

      const claimed2 = BigInt(
        await mustInvoke<string>(session, ctx.pool, "claim_yield", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
        ])
      );
      expect(claimed2).toBe(0n);
    });

    test("F4-T1-4: LP, PT holder, and YT holder withdraw exact segregated post-maturity entitlements", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const lpBal = await seedPool(session, ctx, 200_000_000_000n, 200_000_000_000n);

      const amt1 = 100_000_000_000n;
      const amt2 = 150_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user1, amt1);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt1),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt1),
        aU64(ctx.maturity),
      ]);

      await session.sacMint(ctx.usdc, ctx.user2, amt2);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(amt2),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(amt2),
        aU64(ctx.maturity),
      ]);

      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_200_000_000n)]);
      await session.setLedger({ timestamp: ctx.maturity + 100 });

      const ptOut2 = BigInt(
        await mustInvoke<string>(session, ctx.pool, "redeem_pt_post_maturity", [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(amt2),
        ])
      );
      expect(calculateHaircut(375_000_000_000n, 450_000_000_000n)).toBe(833_333_333_333_333_333n);
      expect(ptOut2).toBe(calculateProRataShare(amt2, 375_000_000_000n, 450_000_000_000n));

      const ytOut1 = BigInt(
        await mustInvoke<string>(session, ctx.pool, "claim_yield", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
        ])
      );
      expect(ytOut1).toBe((amt1 * 200_000_000n) / 1_200_000_000n);

      const [lpPtOut, lpSyOut] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "remove_liquidity",
        [aAddr(ctx.lp), aAddr(ctx.lp), aI128(lpBal), aI128(1), aI128(1)]
      );
      expect(BigInt(lpPtOut)).toBeGreaterThan(199_000_000_000n);
      expect(BigInt(lpSyOut)).toBeGreaterThan(199_000_000_000n);
    });

    test("F4-T1-5: 20% bad-debt SY burn enforces proportional 0.8 WAD haircut across sequential PT redemptions", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const amt1 = 70_000_000_000n;
      const amt2 = 30_000_000_000n;

      for (const [u, amt] of [
        [ctx.user1, amt1],
        [ctx.user2, amt2],
      ] as const) {
        await session.sacMint(ctx.usdc, u, amt);
        await mustInvoke(session, ctx.sy, "deposit", [
          aAddr(u),
          aAddr(u),
          aI128(amt),
        ]);
        await mustInvoke(session, ctx.pool, "mint_py", [
          aAddr(u),
          aAddr(u),
          aI128(amt),
          aU64(ctx.maturity),
        ]);
      }

      const burnRes = await session.burnAsHolder(ctx.sy, ctx.pool, "20000000000");
      expect(burnRes.ok).toBe(true);

      await session.setLedger({ timestamp: ctx.maturity + 10 });
      const haircut = calculateHaircut(80_000_000_000n, 100_000_000_000n);
      expect(haircut).toBe(800_000_000_000_000_000n);

      const out1 = BigInt(
        await mustInvoke<string>(session, ctx.pool, "redeem_pt_post_maturity", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
          aI128(amt1),
        ])
      );
      const out2 = BigInt(
        await mustInvoke<string>(session, ctx.pool, "redeem_pt_post_maturity", [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(amt2),
        ])
      );

      expect(out1).toBe(wadMul(amt1, haircut)); // 56_000_000_000
      expect(out2).toBe(wadMul(amt2, haircut)); // 24_000_000_000
    });
  });

  // =========================================================================
  // F5: DeadlineExpired Protection (5 tests)
  // =========================================================================
  describe("F5: DeadlineExpired Protection (Happy Paths)", () => {
    test("F5-T1-1: pool.mint_py succeeds with valid future deadline", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const amt = 10_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user1, amt);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
      ]);

      const [ptOut, ytOut] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "mint_py",
        [aAddr(ctx.user1), aAddr(ctx.user1), aI128(amt), aU64(T0 + 60)]
      );
      expect(ptOut).toBe(String(amt));
      expect(ytOut).toBe(String(amt));
    });

    test("F5-T1-2: swap_exact_pt_for_sy and swap_exact_sy_for_pt succeed with valid future deadline", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);

      await session.sacMint(ctx.usdc, ctx.user1, 20_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(20_000_000_000n),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(10_000_000_000n),
        aU64(T0 + 60),
      ]);

      const [syOut, fee1] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_pt_for_sy",
        [aAddr(ctx.user1), aAddr(ctx.user1), aI128(2_000_000_000n), aI128(1), aU64(T0 + 60)]
      );
      const [ptOut, fee2] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_sy_for_pt",
        [aAddr(ctx.user1), aAddr(ctx.user1), aI128(2_000_000_000n), aI128(1), aU64(T0 + 60)]
      );
      expect(BigInt(syOut)).toBeGreaterThan(0n);
      expect(BigInt(fee1)).toBeGreaterThan(0n);
      expect(BigInt(ptOut)).toBeGreaterThan(0n);
      expect(BigInt(fee2)).toBeGreaterThan(0n);
    });

    test("F5-T1-3: swap_exact_sy_for_yt and swap_exact_yt_for_sy succeed with valid future deadline", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);

      await session.sacMint(ctx.usdc, ctx.user1, 1_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(1_000_000_000n),
      ]);

      const [ytOut, fee1] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_sy_for_yt",
        [aAddr(ctx.user1), aAddr(ctx.user1), aI128(500_000_000n), aI128(1), aU64(T0 + 60)]
      );
      expect(BigInt(ytOut)).toBeGreaterThan(0n);
      expect(BigInt(fee1)).toBeGreaterThan(0n);

      const [syOut, fee2] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_yt_for_sy",
        [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
          aI128(BigInt(ytOut) / 2n),
          aI128(1),
          aU64(T0 + 60),
        ]
      );
      expect(BigInt(syOut)).toBeGreaterThan(0n);
      expect(BigInt(fee2)).toBeGreaterThan(0n);
    });

    test("F5-T1-4: factory.rollover_to_pt succeeds with valid future deadline and zero factory dust", async () => {
      const { admin, factory } = await setupFactory(session, T0);
      const lp = await session.genAddress("lp");
      const user1 = await session.genAddress("user1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      const srcMeta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 30 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      const dstMeta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128((105n * WAD) / 100n),
      ]);

      // Seed destination pool with liquidity
      await session.sacMint(asset, lp, 300_000_000_000n);
      await mustInvoke(session, dstMeta.sy, "deposit", [
        aAddr(lp),
        aAddr(lp),
        aI128(300_000_000_000n),
      ]);
      await mustInvoke(session, dstMeta.pool, "mint_py", [
        aAddr(lp),
        aAddr(lp),
        aI128(150_000_000_000n),
        aU64(T0 + 90 * DAY),
      ]);
      await mustInvoke(session, dstMeta.pool, "add_liquidity", [
        aAddr(lp),
        aAddr(lp),
        aI128(120_000_000_000n),
        aI128(100_000_000_000n),
        aI128(1),
      ]);

      // User1 mints PY in source market (5B so target pool stays PT >= SY after swap)
      const ptAmt = 5_000_000_000n;
      await session.sacMint(asset, user1, ptAmt);
      await mustInvoke(session, srcMeta.sy, "deposit", [
        aAddr(user1),
        aAddr(user1),
        aI128(ptAmt),
      ]);
      await mustInvoke(session, srcMeta.pool, "mint_py", [
        aAddr(user1),
        aAddr(user1),
        aI128(ptAmt),
        aU64(T0 + 30 * DAY),
      ]);

      // Mature source market while target remains active
      const now = T0 + 31 * DAY;
      await session.setLedger({ timestamp: now });

      const [syPayout, targetPt] = await mustInvoke<[string, string]>(
        session,
        factory,
        "rollover_to_pt",
        [
          aAddr(user1),
          aAddr(user1),
          aAddr(srcMeta.pool),
          aAddr(dstMeta.pool),
          aI128(ptAmt),
          aI128(1),
          aU64(now + 60),
        ]
      );

      expect(BigInt(syPayout)).toBe(ptAmt);
      expect(BigInt(targetPt)).toBeGreaterThanOrEqual(ptAmt);
      expect(await mustInvoke<string>(session, srcMeta.pt, "balance", [aAddr(user1)])).toBe("0");
      expect(await mustInvoke<string>(session, dstMeta.pt, "balance", [aAddr(user1)])).toBe(
        targetPt
      );
      expect(await mustInvoke<string>(session, srcMeta.sy, "balance", [aAddr(factory)])).toBe("0");
      expect(await mustInvoke<string>(session, dstMeta.pt, "balance", [aAddr(factory)])).toBe("0");
    });

    test("F5-T1-5: factory.rollover_to_py succeeds with valid future deadline and zero factory dust", async () => {
      const { admin, factory } = await setupFactory(session, T0);
      const user1 = await session.genAddress("user1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      const srcMeta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 30 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      const dstMeta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128((105n * WAD) / 100n),
      ]);

      const ptAmt = 10_000_000_000n;
      await session.sacMint(asset, user1, ptAmt);
      await mustInvoke(session, srcMeta.sy, "deposit", [
        aAddr(user1),
        aAddr(user1),
        aI128(ptAmt),
      ]);
      await mustInvoke(session, srcMeta.pool, "mint_py", [
        aAddr(user1),
        aAddr(user1),
        aI128(ptAmt),
        aU64(T0 + 30 * DAY),
      ]);

      const now = T0 + 31 * DAY;
      await session.setLedger({ timestamp: now });

      const [syPayout, pyMinted] = await mustInvoke<[string, string]>(
        session,
        factory,
        "rollover_to_py",
        [
          aAddr(user1),
          aAddr(user1),
          aAddr(srcMeta.pool),
          aAddr(dstMeta.pool),
          aI128(ptAmt),
          aI128(1),
          aU64(now + 60),
        ]
      );

      expect(syPayout).toBe(String(ptAmt));
      expect(pyMinted).toBe(String(ptAmt));
      expect(await mustInvoke<string>(session, srcMeta.pt, "balance", [aAddr(user1)])).toBe("0");
      expect(await mustInvoke<string>(session, dstMeta.pt, "balance", [aAddr(user1)])).toBe(
        pyMinted
      );
      expect(await mustInvoke<string>(session, dstMeta.yt, "balance", [aAddr(user1)])).toBe(
        pyMinted
      );
      expect(await mustInvoke<string>(session, srcMeta.sy, "balance", [aAddr(factory)])).toBe("0");
    });
  });
});
