// e2e_tests/tests/tier2_contracts_r1_bounds.test.ts
// Tier 2: Genuine Soroban WASM E2E Boundary, Corner & Adversarial Tests for R1 (F1-F5: 25 tests)

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  SorobanRunnerSession,
  type TypedArg,
  type SorobanResponse,
} from "../src/harness/soroban-harness.ts";
import { WAD, wadMul, calculateHaircut } from "../src/math-oracle.ts";

const T0 = 1_700_000_000;
const DAY = 86_400;
const SCALAR_9 = 1_000_000_000n;
const SCALAR_ROOT = 20n * WAD;
const INITIAL_ANCHOR = WAD;
const U64_MAX = "18446744073709551615";

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
const aStr = (value: string): TypedArg => ({ type: "string", value });
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

async function setupDirectPool(
  session: SorobanRunnerSession,
  days = 90,
  timestamp = T0,
  initialAnchor = INITIAL_ANCHOR
) {
  await session.reset({
    timestamp,
    sequence: 100,
    auth_mode: "mock_all",
    budget_mode: "unlimited",
  });
  const admin = await session.genAddress("admin");
  const guardian = await session.genAddress("guardian");
  const feeRecipient = await session.genAddress("fee_recipient");
  const lp = await session.genAddress("lp");
  const user1 = await session.genAddress("user1");
  const user2 = await session.genAddress("user2");

  const usdc = await session.createSac("USDC", { admin });
  const blend = await session.deployWasm("mock_blend.wasm");
  await mustInvoke(session, blend, "initialize", [
    aAddr(admin),
    aAddr(usdc),
    aI128(SCALAR_9),
  ]);

  const sy = await session.deployWasm("sy_blend_wrapper.wasm");
  await mustInvoke(session, sy, "initialize", [
    aAddr(admin),
    aAddr(usdc),
    aAddr(blend),
  ]);

  const pt = await session.deployWasm("pt_token.wasm");
  const yt = await session.deployWasm("yt_token.wasm");
  const pool = await session.deployWasm("yield_pool.wasm");

  const maturity = timestamp + days * DAY;
  await mustInvoke(session, pt, "initialize", [
    aAddr(admin),
    aAddr(pool),
    aStr(`PT USDC ${days}D`),
    aStr(`PT-USDC-${days}D`),
    aU32(7),
    aU64(maturity),
  ]);
  await mustInvoke(session, yt, "initialize", [
    aAddr(admin),
    aAddr(pool),
    aAddr(sy),
    aStr(`YT USDC ${days}D`),
    aStr(`YT-USDC-${days}D`),
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
    aI128(initialAnchor),
  ]);
  await mustInvoke(session, pool, "set_fee_recipient", [
    aAddr(admin),
    aAddr(feeRecipient),
  ]);

  return {
    admin,
    guardian,
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

describe("Tier 2: R1 Contracts Boundary & Adversarial Suite (F1-F5)", () => {
  let session: SorobanRunnerSession;

  beforeAll(async () => {
    session = await SorobanRunnerSession.start();
  }, 120_000);

  afterAll(async () => {
    await session?.close();
  });

  // =========================================================================
  // F1 Boundaries (5 tests)
  // =========================================================================
  describe("F1: create_market Auth & Pre-Mutation Validation Boundaries", () => {
    test("F1-T2-1: non-whitelisted attacker cannot call create_market and leaves SyByAsset unlocked", async () => {
      const { admin, factory } = await setupFactory(session);
      const attacker = await session.genAddress("attacker");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      const res = await session.invoke(factory, "create_market", [
        aAddr(attacker),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      expectContractError(res, 3, "Unauthorized");

      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(asset)])
      ).toBeNull();
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(0);
    });

    test("F1-T2-2: revoked creator cannot call create_market and leaves market_count unchanged", async () => {
      const { admin, factory } = await setupFactory(session);
      const creator1 = await session.genAddress("creator1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);
      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(false),
      ]);

      const res = await session.invoke(factory, "create_market", [
        aAddr(creator1),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      expectContractError(res, 3, "Unauthorized");
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(0);
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(asset)])
      ).toBeNull();
    });

    test("F1-T2-3: non-admin attacker cannot whitelist self via set_creator_whitelist", async () => {
      const { factory } = await setupFactory(session);
      const attacker = await session.genAddress("attacker");

      const res = await session.invoke(factory, "set_creator_whitelist", [
        aAddr(attacker),
        aAddr(attacker),
        aBool(true),
      ]);
      expectContractError(res, 3, "Unauthorized");
      expect(
        await mustInvoke<boolean>(session, factory, "is_whitelisted_creator", [
          aAddr(attacker),
        ])
      ).toBe(false);
    });

    test("F1-T2-4: strict auth rejects wrong signer and unsigned create_market while scoped creator succeeds", async () => {
      const { admin, factory } = await setupFactory(session);
      const attacker = await session.genAddress("attacker");
      const creator1 = await session.genAddress("creator1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");
      const maturity = T0 + 90 * DAY;

      const argsAdmin: TypedArg[] = [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(maturity),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ];

      // 1. Unsigned invocation fails AuthError
      const noAuthRes = await session.invoke(factory, "create_market", argsAdmin, {
        auth: "none",
      });
      expect(noAuthRes.ok).toBe(false);
      expect(noAuthRes.error?.kind).toBe("AuthError");

      // 2. Invocation claiming caller=admin but signed only by attacker fails AuthError
      const wrongSignerRes = await session.invoke(factory, "create_market", argsAdmin, {
        auth: {
          signers: [
            {
              address: attacker,
              invoke: {
                contract: factory,
                fn_name: "create_market",
                args: argsAdmin,
                sub_invokes: [],
              },
            },
          ],
        },
      });
      expect(wrongSignerRes.ok).toBe(false);
      expect(wrongSignerRes.error?.kind).toBe("AuthError");
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(0);
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(asset)])
      ).toBeNull();

      // 3. Whitelisted creator with strict root-only signer (sub_invokes: []) succeeds
      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);
      const argsCreator: TypedArg[] = [
        aAddr(creator1),
        aAddr(asset),
        aAddr(blend),
        aU64(maturity),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ];
      const okRes = await session.invoke<MarketMetadata>(
        factory,
        "create_market",
        argsCreator,
        {
          auth: {
            signers: [
              {
                address: creator1,
                invoke: {
                  contract: factory,
                  fn_name: "create_market",
                  args: argsCreator,
                  sub_invokes: [],
                },
              },
            ],
          },
        }
      );
      expect(okRes.ok).toBe(true);
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(1);
    });

    test("F1-T2-5: pre-mutation validation errors (#11, #4, #15, #25, #23) prevent partial SyByAsset lock", async () => {
      const { admin, guardian, factory } = await setupFactory(session);
      const creator1 = await session.genAddress("creator1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");
      const maturity = T0 + 90 * DAY;

      await mustInvoke(session, factory, "set_creator_whitelist", [
        aAddr(admin),
        aAddr(creator1),
        aBool(true),
      ]);

      // (a) maturity <= now -> InvalidMaturity (#11)
      expectContractError(
        await session.invoke(factory, "create_market", [
          aAddr(creator1),
          aAddr(asset),
          aAddr(blend),
          aU64(T0),
          aI128(SCALAR_ROOT),
          aI128(INITIAL_ANCHOR),
        ]),
        11,
        "InvalidMaturity"
      );

      // (b) scalar_root == 0 and initial_anchor == 0 -> ZeroAmount (#4)
      expectContractError(
        await session.invoke(factory, "create_market", [
          aAddr(creator1),
          aAddr(asset),
          aAddr(blend),
          aU64(maturity),
          aI128(0),
          aI128(INITIAL_ANCHOR),
        ]),
        4,
        "ZeroAmount"
      );
      expectContractError(
        await session.invoke(factory, "create_market", [
          aAddr(creator1),
          aAddr(asset),
          aAddr(blend),
          aU64(maturity),
          aI128(SCALAR_ROOT),
          aI128(0),
        ]),
        4,
        "ZeroAmount"
      );

      // (c) blend_pool == asset -> IdenticalAddresses (#15)
      expectContractError(
        await session.invoke(factory, "create_market", [
          aAddr(creator1),
          aAddr(asset),
          aAddr(asset),
          aU64(maturity),
          aI128(SCALAR_ROOT),
          aI128(INITIAL_ANCHOR),
        ]),
        15,
        "IdenticalAddresses"
      );

      // No partial SyByAsset lock after invalid attempts
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [aAddr(asset)])
      ).toBeNull();
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(0);

      // Create valid market, then test duplicate (asset, maturity) -> MarketAlreadyExists (#25)
      await mustInvoke(session, factory, "create_market", [
        aAddr(creator1),
        aAddr(asset),
        aAddr(blend),
        aU64(maturity),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      expectContractError(
        await session.invoke(factory, "create_market", [
          aAddr(creator1),
          aAddr(asset),
          aAddr(blend),
          aU64(maturity),
          aI128(SCALAR_ROOT),
          aI128(INITIAL_ANCHOR),
        ]),
        25,
        "MarketAlreadyExists"
      );

      // (d) Pause factory -> ContractPaused (#23) on both existing and fresh unmapped asset
      await mustInvoke(session, factory, "pause", [aAddr(guardian)]);
      const countBeforePause = await mustInvoke<number>(session, factory, "market_count");
      expectContractError(
        await session.invoke(factory, "create_market", [
          aAddr(creator1),
          aAddr(asset),
          aAddr(blend),
          aU64(T0 + 30 * DAY),
          aI128(SCALAR_ROOT),
          aI128(INITIAL_ANCHOR),
        ]),
        23,
        "ContractPaused"
      );

      const eurcCtx = await setupBlendAndAsset(session, admin, "EURC");
      expectContractError(
        await session.invoke(factory, "create_market", [
          aAddr(creator1),
          aAddr(eurcCtx.asset),
          aAddr(eurcCtx.blend),
          aU64(T0 + 30 * DAY),
          aI128(SCALAR_ROOT),
          aI128(INITIAL_ANCHOR),
        ]),
        23,
        "ContractPaused"
      );
      expect(
        await mustInvoke<string | null>(session, factory, "get_sy_for_asset", [
          aAddr(eurcCtx.asset),
        ])
      ).toBeNull();
      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(
        countBeforePause
      );
    });
  });

  // =========================================================================
  // F2 Boundaries (5 tests)
  // =========================================================================
  describe("F2: Dynamic Token Metadata Edge Cases", () => {
    test("F2-T2-1: underlying SEP-41 tokens with decimals=6 and decimals=8 propagate exact decimals", async () => {
      const { admin, factory } = await setupFactory(session);

      for (const [sym, dec] of [
        ["USD6", 6],
        ["BTC8", 8],
      ] as const) {
        const token = await session.deployWasm("pt_token.wasm");
        await mustInvoke(session, token, "initialize", [
          aAddr(admin),
          aAddr(admin),
          aStr(`Mock ${sym}`),
          aStr(sym),
          aU32(dec),
          aU64(T0 + 365 * DAY),
        ]);
        const blend = await session.deployWasm("mock_blend.wasm");
        await mustInvoke(session, blend, "initialize", [
          aAddr(admin),
          aAddr(token),
          aI128(SCALAR_9),
        ]);

        const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
          aAddr(admin),
          aAddr(token),
          aAddr(blend),
          aU64(T0 + 90 * DAY),
          aI128(SCALAR_ROOT),
          aI128(INITIAL_ANCHOR),
        ]);

        expect(await mustInvoke<number>(session, meta.sy, "decimals")).toBe(dec);
        expect(await mustInvoke<number>(session, meta.pt, "decimals")).toBe(dec);
        expect(await mustInvoke<number>(session, meta.yt, "decimals")).toBe(dec);
        expect(await mustInvoke<number>(session, meta.pool, "decimals")).toBe(dec);
      }
    });

    test("F2-T2-2: native XLM SAC (symbol()='native') normalizes to XLM across SY/PT/YT/LP", async () => {
      const { admin, factory } = await setupFactory(session);
      const nativeSac = await session.createSac("native");
      expect(await mustInvoke<string>(session, nativeSac, "symbol")).toBe("native");

      const blend = await session.deployWasm("mock_blend.wasm");
      await mustInvoke(session, blend, "initialize", [
        aAddr(admin),
        aAddr(nativeSac),
        aI128(SCALAR_9),
      ]);

      const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(nativeSac),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      const sySym = await mustInvoke<string>(session, meta.sy, "symbol");
      const ptSym = await mustInvoke<string>(session, meta.pt, "symbol");
      const ytSym = await mustInvoke<string>(session, meta.yt, "symbol");
      const lpSym = await mustInvoke<string>(session, meta.pool, "symbol");

      expect(sySym).toBe("sy-bXLM");
      expect(ptSym).toBe("PT-XLM-90D");
      expect(ytSym).toBe("YT-XLM-90D");
      expect(lpSym).toBe("LP-XLM");
      for (const s of [sySym, ptSym, ytSym, lpSym]) {
        expect(s.toLowerCase()).not.toContain("native");
      }
    });

    test("F2-T2-3: long symbol (12 chars SAC and 19 chars SEP-41) initializes without panic or truncation error", async () => {
      const { admin, factory } = await setupFactory(session);

      // 12-char SAC
      const sacLong = await session.createSac("LONGASSETXYZ", { admin });
      const blend1 = await session.deployWasm("mock_blend.wasm");
      await mustInvoke(session, blend1, "initialize", [
        aAddr(admin),
        aAddr(sacLong),
        aI128(SCALAR_9),
      ]);
      const m1 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(sacLong),
        aAddr(blend1),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      expect(await mustInvoke<string>(session, m1.sy, "symbol")).toBe("sy-bLONGASSETXYZ");
      expect(await mustInvoke<string>(session, m1.pt, "symbol")).toBe("PT-LONGASSETXYZ-90D");

      // 19-char SEP-41 symbol (exceeds 16-byte internal buffer in metadata.rs, cleanly clamped)
      const sepLong = await session.deployWasm("pt_token.wasm");
      await mustInvoke(session, sepLong, "initialize", [
        aAddr(admin),
        aAddr(admin),
        aStr("Very Long Asset Name"),
        aStr("LONGASSET1234567890"),
        aU32(7),
        aU64(T0 + 365 * DAY),
      ]);
      const blend2 = await session.deployWasm("mock_blend.wasm");
      await mustInvoke(session, blend2, "initialize", [
        aAddr(admin),
        aAddr(sepLong),
        aI128(SCALAR_9),
      ]);
      const m2 = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(sepLong),
        aAddr(blend2),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      expect((await mustInvoke<string>(session, m2.sy, "symbol")).startsWith("sy-bLONGASSET")).toBe(
        true
      );
      expect((await mustInvoke<string>(session, m2.pt, "symbol")).endsWith("-90D")).toBe(true);
    });

    test("F2-T2-4: arbitrary third asset EURC derives EURC metadata, never USDC or XLM", async () => {
      const { admin, factory } = await setupFactory(session);
      const { asset, blend } = await setupBlendAndAsset(session, admin, "EURC");
      const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      const sySym = await mustInvoke<string>(session, meta.sy, "symbol");
      const ptSym = await mustInvoke<string>(session, meta.pt, "symbol");
      const ytSym = await mustInvoke<string>(session, meta.yt, "symbol");
      const lpSym = await mustInvoke<string>(session, meta.pool, "symbol");

      expect(sySym).toBe("sy-bEURC");
      expect(ptSym).toBe("PT-EURC-90D");
      expect(ytSym).toBe("YT-EURC-90D");
      expect(lpSym).toBe("LP-EURC");
      for (const s of [sySym, ptSym, ytSym, lpSym]) {
        expect(s).not.toContain("USDC");
        expect(s).not.toContain("XLM");
      }
    });

    test("F2-T2-5: metadata queries succeed while paused and double initialization reverts #2 AlreadyInitialized", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await mustInvoke(session, ctx.sy, "set_guardian", [aAddr(ctx.admin), aAddr(ctx.guardian)]);
      await mustInvoke(session, ctx.pt, "set_guardian", [aAddr(ctx.admin), aAddr(ctx.guardian)]);
      await mustInvoke(session, ctx.yt, "set_guardian", [aAddr(ctx.admin), aAddr(ctx.guardian)]);
      await mustInvoke(session, ctx.pool, "set_guardian", [aAddr(ctx.admin), aAddr(ctx.guardian)]);

      await mustInvoke(session, ctx.sy, "pause", [aAddr(ctx.guardian)]);
      await mustInvoke(session, ctx.pt, "pause", [aAddr(ctx.guardian)]);
      await mustInvoke(session, ctx.yt, "pause", [aAddr(ctx.guardian)]);
      await mustInvoke(session, ctx.pool, "pause", [aAddr(ctx.guardian)]);

      expect(await mustInvoke<string>(session, ctx.sy, "symbol")).toBe("sy-bUSDC");
      expect(await mustInvoke<string>(session, ctx.pt, "name")).toBe("PT USDC 90D");
      expect(await mustInvoke<string>(session, ctx.yt, "symbol")).toBe("YT-USDC-90D");
      expect(await mustInvoke<number>(session, ctx.pool, "decimals")).toBe(7);

      expectContractError(
        await session.invoke(ctx.sy, "initialize", [
          aAddr(ctx.admin),
          aAddr(ctx.usdc),
          aAddr(ctx.blend),
        ]),
        2,
        "AlreadyInitialized"
      );
      expectContractError(
        await session.invoke(ctx.pt, "initialize", [
          aAddr(ctx.admin),
          aAddr(ctx.pool),
          aStr("X"),
          aStr("X"),
          aU32(7),
          aU64(ctx.maturity),
        ]),
        2,
        "AlreadyInitialized"
      );
      expectContractError(
        await session.invoke(ctx.yt, "initialize", [
          aAddr(ctx.admin),
          aAddr(ctx.pool),
          aAddr(ctx.sy),
          aStr("X"),
          aStr("X"),
          aU32(7),
          aU64(ctx.maturity),
        ]),
        2,
        "AlreadyInitialized"
      );
      expectContractError(
        await session.invoke(ctx.pool, "initialize", [
          aAddr(ctx.admin),
          aAddr(ctx.sy),
          aAddr(ctx.pt),
          aAddr(ctx.yt),
          aU64(ctx.maturity),
          aI128(SCALAR_ROOT),
          aI128(INITIAL_ANCHOR),
        ]),
        2,
        "AlreadyInitialized"
      );
    });
  });

  // =========================================================================
  // F3 Boundaries (5 tests)
  // =========================================================================
  describe("F3: Swap Fee & Reserve Conservation Boundaries", () => {
    test("F3-T2-1: 20 alternating odd-amount 4-way swaps + 100% LP removal keep strict reserve conservation and PT backing", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const lpBal = await seedPool(session, ctx, 500_000_000_000n, 300_000_000_000n);

      await session.sacMint(ctx.usdc, ctx.user2, 500_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(500_000_000_000n),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(200_000_000_000n),
        aU64(ctx.maturity),
      ]);

      for (let i = 0; i < 5; i++) {
        const oddAmt = 123_456_789n + BigInt(i) * 77_777n;
        await mustInvoke(session, ctx.pool, "swap_exact_pt_for_sy", [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(oddAmt),
          aI128(1),
          aU64(ctx.maturity),
        ]);
        await assertReserveConservation(session, ctx.sy, ctx.pool, ctx.pt);

        await mustInvoke(session, ctx.pool, "swap_exact_sy_for_pt", [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(oddAmt),
          aI128(1),
          aU64(ctx.maturity),
        ]);
        await assertReserveConservation(session, ctx.sy, ctx.pool, ctx.pt);

        const [ytOut] = await mustInvoke<[string, string]>(
          session,
          ctx.pool,
          "swap_exact_sy_for_yt",
          [aAddr(ctx.user2), aAddr(ctx.user2), aI128(50_000_003n), aI128(1), aU64(ctx.maturity)]
        );
        await assertReserveConservation(session, ctx.sy, ctx.pool, ctx.pt);

        const ytSell = BigInt(ytOut) / 3n;
        await mustInvoke(session, ctx.pool, "swap_exact_yt_for_sy", [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(ytSell),
          aI128(1),
          aU64(ctx.maturity),
        ]);
        await assertReserveConservation(session, ctx.sy, ctx.pool, ctx.pt);
      }

      const [lpPtOutStr, lpSyOutStr] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "remove_liquidity",
        [aAddr(ctx.lp), aAddr(ctx.lp), aI128(lpBal), aI128(1), aI128(1)]
      );
      expect(BigInt(lpPtOutStr)).toBeGreaterThan(0n);
      expect(BigInt(lpSyOutStr)).toBeGreaterThan(0n);
      expect(await mustInvoke<string>(session, ctx.pool, "balance", [aAddr(ctx.lp)])).toBe("0");

      const { state, ptPrincipal, ytYield, poolSyBal } = await assertReserveConservation(
        session,
        ctx.sy,
        ctx.pool,
        ctx.pt
      );
      expect(state.total_lp_supply).toBe("1000"); // Only MINIMUM_LIQUIDITY dead shares remain
      expect(BigInt(state.total_sy_reserve)).toBeLessThan(10_000n);
      expect(poolSyBal).toBeGreaterThanOrEqual(ptPrincipal + ytYield);
    });

    test("F3-T2-2: all 4 swap_exact_* pass at min_out == actualOut and revert #9 SlippageExceeded at min_out == actualOut + 1", async () => {
      async function setupFundedTraderPool() {
        const ctx = await setupDirectPool(session, 90, T0);
        await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);
        await session.sacMint(ctx.usdc, ctx.user2, 50_000_000_000n);
        await mustInvoke(session, ctx.sy, "deposit", [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(50_000_000_000n),
        ]);
        await mustInvoke(session, ctx.pool, "mint_py", [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(20_000_000_000n),
          aU64(ctx.maturity),
        ]);
        return ctx;
      }

      for (const [fn, amt] of [
        ["swap_exact_pt_for_sy", 1_000_000_000n],
        ["swap_exact_sy_for_pt", 1_000_000_000n],
        ["swap_exact_sy_for_yt", 100_000_000n],
        ["swap_exact_yt_for_sy", 1_000_000_000n],
      ] as const) {
        // Probe exact output on Pool A
        const probeCtx = await setupFundedTraderPool();
        const [actualOutStr] = await mustInvoke<[string, string]>(session, probeCtx.pool, fn, [
          aAddr(probeCtx.user2),
          aAddr(probeCtx.user2),
          aI128(amt),
          aI128(1),
          aU64(probeCtx.maturity),
        ]);
        const actualOut = BigInt(actualOutStr);
        expect(actualOut).toBeGreaterThan(0n);

        // On an identical Pool B, verify actualOut + 1 reverts #9 SlippageExceeded with state unchanged,
        // and exact actualOut succeeds cleanly.
        const ctx = await setupFundedTraderPool();
        const stateBefore = await mustInvoke<MarketState>(session, ctx.pool, "get_market_state");
        const ptSupplyBefore = await mustInvoke<string>(session, ctx.pt, "total_supply");
        const ytSupplyBefore = await mustInvoke<string>(session, ctx.yt, "total_supply");

        const revertRes = await session.invoke(ctx.pool, fn, [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(amt),
          aI128(actualOut + 1n),
          aU64(ctx.maturity),
        ]);
        expectContractError(revertRes, 9, "SlippageExceeded");

        const stateAfterRevert = await mustInvoke<MarketState>(
          session,
          ctx.pool,
          "get_market_state"
        );
        expect(stateAfterRevert.total_pt_reserve).toBe(stateBefore.total_pt_reserve);
        expect(stateAfterRevert.total_sy_reserve).toBe(stateBefore.total_sy_reserve);
        expect(await mustInvoke<string>(session, ctx.pt, "total_supply")).toBe(ptSupplyBefore);
        expect(await mustInvoke<string>(session, ctx.yt, "total_supply")).toBe(ytSupplyBefore);

        const [exactOutStr] = await mustInvoke<[string, string]>(session, ctx.pool, fn, [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(amt),
          aI128(actualOut),
          aU64(ctx.maturity),
        ]);
        expect(BigInt(exactOutStr)).toBe(actualOut);
      }
    });

    test("F3-T2-3: swaps pushing PT/(PT+SY) above 0.96 or below 0.04 revert with #14 ProportionOutOfBounds", async () => {
      // High anchor (1.2 WAD) ensures get_exchange_rate >= WAD even below 0.50 ratio so check_market_proportion runs
      const ctx = await setupDirectPool(session, 90, T0, (12n * WAD) / 10n);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);

      await session.sacMint(ctx.usdc, ctx.user2, 10_000_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(10_000_000_000_000n),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(5_000_000_000_000n),
        aU64(ctx.maturity),
      ]);

      const resBefore = await mustInvoke<[string, string]>(session, ctx.pool, "get_reserves");

      // Push PT proportion > 0.96 via PT -> SY swap (114B PT into 120B PT / 100B SY -> ~234B PT / ~6.7B SY > 96%)
      const highRes = await session.invoke(ctx.pool, "swap_exact_pt_for_sy", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(114_000_000_000n),
        aI128(1),
        aU64(ctx.maturity),
      ]);
      expectContractError(highRes, 14, "ProportionOutOfBounds");

      // Push PT proportion < 0.04 via large SY -> PT swap (new_pt = 120e9 - out < 0.04 * (new_pt + new_sy))
      const lowRes = await session.invoke(ctx.pool, "swap_exact_sy_for_pt", [
        aAddr(ctx.user2),
        aAddr(ctx.user2),
        aI128(95_000_000_000n),
        aI128(1),
        aU64(ctx.maturity),
      ]);
      expectContractError(lowRes, 14, "ProportionOutOfBounds");

      expect(await mustInvoke<[string, string]>(session, ctx.pool, "get_reserves")).toEqual(
        resBefore
      );
    });

    test("F3-T2-4: all 4 swap_exact_* revert with #4 ZeroAmount on zero/negative amount_in or negative min_out", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);

      for (const fn of [
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_pt",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
      ] as const) {
        expectContractError(
          await session.invoke(ctx.pool, fn, [
            aAddr(ctx.user2),
            aAddr(ctx.user2),
            aI128(0),
            aI128(0),
            aU64(ctx.maturity),
          ]),
          4,
          "ZeroAmount"
        );
        expectContractError(
          await session.invoke(ctx.pool, fn, [
            aAddr(ctx.user2),
            aAddr(ctx.user2),
            aI128(-1),
            aI128(0),
            aU64(ctx.maturity),
          ]),
          4,
          "ZeroAmount"
        );
        expectContractError(
          await session.invoke(ctx.pool, fn, [
            aAddr(ctx.user2),
            aAddr(ctx.user2),
            aI128(100),
            aI128(-1),
            aU64(ctx.maturity),
          ]),
          4,
          "ZeroAmount"
        );
      }
    });

    test("F3-T2-5: all 4 swap_exact_* on unseeded pool (0 reserves) revert cleanly without panic", async () => {
      const ctx = await setupDirectPool(session, 90, T0);

      for (const [fn, expectedCodes] of [
        ["swap_exact_pt_for_sy", [5, 19]], // InsufficientBalance or NegativeLogarithmInput
        ["swap_exact_sy_for_pt", [5, 19]],
        ["swap_exact_sy_for_yt", [19]],
        ["swap_exact_yt_for_sy", [5, 19]],
      ] as const) {
        const res = await session.invoke(ctx.pool, fn, [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
          aI128(1_000_000n),
          aI128(1),
          aU64(ctx.maturity),
        ]);
        expect(res.ok).toBe(false);
        expect(res.error?.kind).toBe("ContractError");
        expect(expectedCodes as readonly number[]).toContain(res.error?.code as number);
      }
    });
  });

  // =========================================================================
  // F4 Boundaries (5 tests)
  // =========================================================================
  describe("F4: MaturityIndex Sync & Reserve Separation Boundaries", () => {
    test("F4-T2-1: post-maturity rate spike before settle_maturity pins index on checkpoint without draining PT principal", async () => {
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
      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(2_000_000_000n)]);

      // Trigger checkpoint via YT transfer at 2.0
      await mustInvoke(session, ctx.yt, "transfer", [
        aAddr(ctx.user1),
        aAddr(ctx.user2),
        aI128(1_000n),
      ]);

      // Rate spikes to 3.0 before pool functions are invoked
      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(3_000_000_000n)]);

      const ptOut = BigInt(
        await mustInvoke<string>(session, ctx.pool, "redeem_pt_post_maturity", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
          aI128(amt),
        ])
      );
      const state = await mustInvoke<MarketState>(session, ctx.pool, "get_market_state");
      expect(state.maturity_index).toBe("2000000000");
      // Pre-maturity YT accrued 100B underlying (1.0 -> 2.0), worth 33.333B SY at current_rate=3.0;
      // remaining 66.667B SY backs PT principal (never drained by post-maturity 2.0 -> 3.0 rise)
      const expectedAvailPt = amt - (amt * 1_000_000_000n) / 3_000_000_000n;
      const expectedPtOut = wadMul(amt, calculateHaircut(expectedAvailPt, amt));
      expect(ptOut >= expectedPtOut - 2n && ptOut <= expectedPtOut + 2n).toBe(true);

      const ytClaimed = BigInt(
        await mustInvoke<string>(session, ctx.pool, "claim_yield", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
        ])
      );
      const expectedYtSyAt3 = (amt * 1_000_000_000n) / 3_000_000_000n;
      expect(ytClaimed >= expectedYtSyAt3 - 2n && ytClaimed <= expectedYtSyAt3 + 2n).toBe(true);
    });

    test("F4-T2-2: post-maturity YT recipient receives 0 post-maturity yield while both use identical synced MaturityIndex", async () => {
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

      await session.setLedger({ timestamp: ctx.maturity + 50 });
      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_200_000_000n)]);
      await mustInvoke(session, ctx.yt, "transfer", [
        aAddr(ctx.user1),
        aAddr(ctx.user2),
        aI128(amt / 2n),
      ]);

      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_500_000_000n)]);

      const u2Claim = BigInt(
        await mustInvoke<string>(session, ctx.pool, "claim_yield", [
          aAddr(ctx.user2),
          aAddr(ctx.user2),
        ])
      );
      expect(u2Claim).toBe(0n);

      const u1Claim = BigInt(
        await mustInvoke<string>(session, ctx.pool, "claim_yield", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
        ])
      );
      const state = await mustInvoke<MarketState>(session, ctx.pool, "get_market_state");
      expect(state.maturity_index).toBe("1200000000");
      // Underlying yield capped at 1.2 (20B underlying), converted to SY at current_rate=1.5
      expect(u1Claim).toBe((amt * 200_000_000n) / 1_500_000_000n);
    });

    test("F4-T2-3: LP TotalSyReserve is isolated from PT bad-debt deficit (80% PT haircut, 100% LP intact)", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const lpBal = await seedPool(session, ctx, 100_000_000_000n, 100_000_000_000n);

      const userPt = 100_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user1, userPt);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(userPt),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(userPt),
        aU64(ctx.maturity),
      ]);

      // Burn 40B SY out of 200B PT backing (160B / 200B = 80% haircut; 100B LP SY must stay untouched)
      const burnRes = await session.burnAsHolder(ctx.sy, ctx.pool, "40000000000");
      expect(burnRes.ok).toBe(true);

      await session.setLedger({ timestamp: ctx.maturity + 10 });
      const stateBefore = await mustInvoke<MarketState>(session, ctx.pool, "get_market_state");
      expect(stateBefore.total_sy_reserve).toBe("100000000000");

      const ptRedeemed = BigInt(
        await mustInvoke<string>(session, ctx.pool, "redeem_pt_post_maturity", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
          aI128(userPt),
        ])
      );
      const expectedHaircut = calculateHaircut(160_000_000_000n, 200_000_000_000n);
      expect(expectedHaircut).toBe(800_000_000_000_000_000n);
      expect(ptRedeemed).toBe(wadMul(userPt, expectedHaircut)); // 80_000_000_000

      // Pool SY balance must still cover LP's 100B SY reserve
      const syBalAfter = BigInt(
        await mustInvoke<string>(session, ctx.sy, "balance", [aAddr(ctx.pool)])
      );
      expect(syBalAfter).toBeGreaterThanOrEqual(BigInt(stateBefore.total_sy_reserve));

      const [lpPtOut, lpSyOut] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "remove_liquidity",
        [aAddr(ctx.lp), aAddr(ctx.lp), aI128(lpBal), aI128(1), aI128(1)]
      );
      expect(BigInt(lpPtOut)).toBeGreaterThan(99_999_000_000n);
      expect(BigInt(lpSyOut)).toBeGreaterThan(99_999_000_000n);
    });

    test("F4-T2-4: settle_maturity and redeem_pt_post_maturity revert #8 MarketNotYetMatured at maturity - 1", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await session.sacMint(ctx.usdc, ctx.user1, 10_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(10_000_000_000n),
      ]);
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(10_000_000_000n),
        aU64(ctx.maturity),
      ]);

      await session.setLedger({ timestamp: ctx.maturity - 1 });
      expectContractError(
        await session.invoke(ctx.pool, "settle_maturity"),
        8,
        "MarketNotYetMatured"
      );
      expectContractError(
        await session.invoke(ctx.pool, "redeem_pt_post_maturity", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
          aI128(1_000_000_000n),
        ]),
        8,
        "MarketNotYetMatured"
      );

      const state = await mustInvoke<MarketState>(session, ctx.pool, "get_market_state");
      expect(state.is_settled).toBe(false);
      expect(state.maturity_index).toBe("0");
    });

    test("F4-T2-5: settle_maturity is idempotent across repeated calls with rising b_rate", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_150_000_000n)]);

      await session.setLedger({ timestamp: ctx.maturity + 10 });
      const idx1 = await mustInvoke<string>(session, ctx.pool, "settle_maturity");
      expect(idx1).toBe("1150000000");

      await session.setLedger({ timestamp: ctx.maturity + 1000 });
      await mustInvoke(session, ctx.blend, "set_b_rate", [aI128(1_600_000_000n)]);
      const idx2 = await mustInvoke<string>(session, ctx.pool, "settle_maturity");
      expect(idx2).toBe("1150000000");
    });
  });

  // =========================================================================
  // F5 Boundaries (5 tests)
  // =========================================================================
  describe("F5: DeadlineExpired Boundary & Expiration Tests", () => {
    async function setupRolloverScenario(now: number) {
      const { admin, factory } = await setupFactory(session, now);
      const lp = await session.genAddress("lp");
      const user1 = await session.genAddress("user1");
      const { asset, blend } = await setupBlendAndAsset(session, admin, "USDC");

      const src = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(now + 30 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);
      const dst = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(asset),
        aAddr(blend),
        aU64(now + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      await session.sacMint(asset, lp, 300_000_000_000n);
      await mustInvoke(session, dst.sy, "deposit", [
        aAddr(lp),
        aAddr(lp),
        aI128(300_000_000_000n),
      ]);
      await mustInvoke(session, dst.pool, "mint_py", [
        aAddr(lp),
        aAddr(lp),
        aI128(150_000_000_000n),
        aU64(now + 90 * DAY),
      ]);
      await mustInvoke(session, dst.pool, "add_liquidity", [
        aAddr(lp),
        aAddr(lp),
        aI128(120_000_000_000n),
        aI128(100_000_000_000n),
        aI128(1),
      ]);

      await session.sacMint(asset, user1, 100_000_000_000n);
      await mustInvoke(session, src.sy, "deposit", [
        aAddr(user1),
        aAddr(user1),
        aI128(100_000_000_000n),
      ]);
      await mustInvoke(session, src.pool, "mint_py", [
        aAddr(user1),
        aAddr(user1),
        aI128(40_000_000_000n),
        aU64(now + 30 * DAY),
      ]);

      return { factory, asset, user1, src, dst };
    }

    test("F5-T2-1: exact boundary deadline == now succeeds inclusively across all 7 functions", async () => {
      // 1-5: yield_pool functions at T0
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);
      await session.sacMint(ctx.usdc, ctx.user1, 50_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(50_000_000_000n),
      ]);

      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(10_000_000_000n),
        aU64(T0),
      ]);
      await mustInvoke(session, ctx.pool, "swap_exact_pt_for_sy", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(1_000_000_000n),
        aI128(1),
        aU64(T0),
      ]);
      await mustInvoke(session, ctx.pool, "swap_exact_sy_for_pt", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(1_000_000_000n),
        aI128(1),
        aU64(T0),
      ]);
      const [ytOut] = await mustInvoke<[string, string]>(
        session,
        ctx.pool,
        "swap_exact_sy_for_yt",
        [aAddr(ctx.user1), aAddr(ctx.user1), aI128(200_000_000n), aI128(1), aU64(T0)]
      );
      await mustInvoke(session, ctx.pool, "swap_exact_yt_for_sy", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(BigInt(ytOut) / 2n),
        aI128(1),
        aU64(T0),
      ]);

      // 6-7: market_factory rollover_to_pt & rollover_to_py at exact T_roll
      const rCtx = await setupRolloverScenario(T0);
      const tRoll = T0 + 31 * DAY;
      await session.setLedger({ timestamp: tRoll });
      await mustInvoke(session, rCtx.factory, "rollover_to_pt", [
        aAddr(rCtx.user1),
        aAddr(rCtx.user1),
        aAddr(rCtx.src.pool),
        aAddr(rCtx.dst.pool),
        aI128(5_000_000_000n),
        aI128(1),
        aU64(tRoll),
      ]);
      await mustInvoke(session, rCtx.factory, "rollover_to_py", [
        aAddr(rCtx.user1),
        aAddr(rCtx.user1),
        aAddr(rCtx.src.pool),
        aAddr(rCtx.dst.pool),
        aI128(5_000_000_000n),
        aI128(1),
        aU64(tRoll),
      ]);
    });

    test("F5-T2-2: deadline == now - 1 on mint_py reverts #10 DeadlineExpired with balances unchanged", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      const amt = 10_000_000_000n;
      await session.sacMint(ctx.usdc, ctx.user1, amt);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
      ]);

      const res = await session.invoke(ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(amt),
        aU64(T0 - 1),
      ]);
      expectContractError(res, 10, "DeadlineExpired");
      expect(await mustInvoke<string>(session, ctx.sy, "balance", [aAddr(ctx.user1)])).toBe(
        String(amt)
      );
      expect(await mustInvoke<string>(session, ctx.pt, "total_supply")).toBe("0");
      expect(await mustInvoke<string>(session, ctx.yt, "total_supply")).toBe("0");
    });

    test("F5-T2-3: deadline == now - 1 on all 4 swap_exact_* reverts #10 DeadlineExpired with reserves unchanged", async () => {
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

      const resBefore = await mustInvoke<[string, string]>(session, ctx.pool, "get_reserves");

      for (const fn of [
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_pt",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
      ] as const) {
        const res = await session.invoke(ctx.pool, fn, [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
          aI128(1_000_000_000n),
          aI128(1),
          aU64(T0 - 1),
        ]);
        expectContractError(res, 10, "DeadlineExpired");
      }

      expect(await mustInvoke<[string, string]>(session, ctx.pool, "get_reserves")).toEqual(
        resBefore
      );
    });

    test("F5-T2-4: deadline == now - 1 on rollover_to_pt and rollover_to_py reverts #10 without burning source PT", async () => {
      const rCtx = await setupRolloverScenario(T0);
      const tRoll = T0 + 31 * DAY;
      await session.setLedger({ timestamp: tRoll });
      const ptBefore = await mustInvoke<string>(session, rCtx.src.pt, "balance", [
        aAddr(rCtx.user1),
      ]);

      for (const fn of ["rollover_to_pt", "rollover_to_py"] as const) {
        const res = await session.invoke(rCtx.factory, fn, [
          aAddr(rCtx.user1),
          aAddr(rCtx.user1),
          aAddr(rCtx.src.pool),
          aAddr(rCtx.dst.pool),
          aI128(5_000_000_000n),
          aI128(1),
          aU64(tRoll - 1),
        ]);
        expectContractError(res, 10, "DeadlineExpired");
      }

      expect(
        await mustInvoke<string>(session, rCtx.src.pt, "balance", [aAddr(rCtx.user1)])
      ).toBe(ptBefore);
    });

    test("F5-T2-5: deadline == 0 reverts #10 across all 7 functions while u64::MAX succeeds", async () => {
      const ctx = await setupDirectPool(session, 90, T0);
      await seedPool(session, ctx, 120_000_000_000n, 100_000_000_000n);
      await session.sacMint(ctx.usdc, ctx.user1, 20_000_000_000n);
      await mustInvoke(session, ctx.sy, "deposit", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(20_000_000_000n),
      ]);

      expectContractError(
        await session.invoke(ctx.pool, "mint_py", [
          aAddr(ctx.user1),
          aAddr(ctx.user1),
          aI128(5_000_000_000n),
          aU64(0),
        ]),
        10,
        "DeadlineExpired"
      );

      // u64::MAX succeeds
      await mustInvoke(session, ctx.pool, "mint_py", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(5_000_000_000n),
        aU64(U64_MAX),
      ]);

      for (const fn of [
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_pt",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
      ] as const) {
        expectContractError(
          await session.invoke(ctx.pool, fn, [
            aAddr(ctx.user1),
            aAddr(ctx.user1),
            aI128(1_000_000_000n),
            aI128(1),
            aU64(0),
          ]),
          10,
          "DeadlineExpired"
        );
      }

      await mustInvoke(session, ctx.pool, "swap_exact_pt_for_sy", [
        aAddr(ctx.user1),
        aAddr(ctx.user1),
        aI128(1_000_000_000n),
        aI128(1),
        aU64(U64_MAX),
      ]);

      const rCtx = await setupRolloverScenario(T0);
      const tRoll = T0 + 31 * DAY;
      await session.setLedger({ timestamp: tRoll });
      for (const fn of ["rollover_to_pt", "rollover_to_py"] as const) {
        expectContractError(
          await session.invoke(rCtx.factory, fn, [
            aAddr(rCtx.user1),
            aAddr(rCtx.user1),
            aAddr(rCtx.src.pool),
            aAddr(rCtx.dst.pool),
            aI128(5_000_000_000n),
            aI128(1),
            aU64(0),
          ]),
          10,
          "DeadlineExpired"
        );
      }

      await mustInvoke(session, rCtx.factory, "rollover_to_pt", [
        aAddr(rCtx.user1),
        aAddr(rCtx.user1),
        aAddr(rCtx.src.pool),
        aAddr(rCtx.dst.pool),
        aI128(5_000_000_000n),
        aI128(1),
        aU64(U64_MAX),
      ]);
    });
  });
});
