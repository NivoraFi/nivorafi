// e2e_tests/tests/tier2_slender_zap_bounds.test.ts
// Tier 2: Genuine Soroban WASM E2E Boundary & Adversarial Tests for R3 Slender (F9) & R4 Zap-In (F10) (10 tests)

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  SorobanRunnerSession,
  type TypedArg,
  type SorobanResponse,
} from "../src/harness/soroban-harness.ts";
import { WAD } from "../src/math-oracle.ts";

const T0 = 1_700_000_000;
const DAY = 86_400;
const SCALAR_9 = 1_000_000_000n;
const SCALAR_ROOT = 20n * WAD;
const INITIAL_ANCHOR = (120n * WAD) / 100n; // 1.20 WAD so low-proportion check hits #14 before #18

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

const aAddr = (value: string): TypedArg => ({ type: "address", value });
const aI128 = (value: bigint | number | string): TypedArg => ({
  type: "i128",
  value: String(value),
});
const aU64 = (value: bigint | number | string): TypedArg => ({
  type: "u64",
  value: String(value),
});
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

function isArityMismatchError(error?: SorobanResponse["error"]): boolean {
  return (
    (error?.kind === "InvokeError" && error?.sc_error_code === "UnexpectedSize") ||
    error?.kind === "InvalidArg"
  );
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
      throw new Error(`mock_slender.s_token returned invalid address: ${String(sTokProbe.data)}`);
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

async function setupSeededFactoryMarket(session: SorobanRunnerSession) {
  await session.reset({
    timestamp: T0,
    sequence: 100,
    auth_mode: "mock_all",
    budget_mode: "unlimited",
  });
  const admin = await session.genAddress("admin");
  const guardian = await session.genAddress("guardian");
  const lp = await session.genAddress("lp");
  const u1 = await session.genAddress("u1");

  const ptHash = await session.uploadWasm("pt_token.wasm");
  const ytHash = await session.uploadWasm("yt_token.wasm");
  const poolHash = await session.uploadWasm("yield_pool.wasm");
  const syHash = await session.uploadWasm("sy_blend_wrapper.wasm");

  const factory = await session.deployWasm("market_factory.wasm");
  await mustInvoke(session, factory, "initialize", [
    aAddr(admin),
    aAddr(guardian),
    aBytes32(ptHash),
    aBytes32(ytHash),
    aBytes32(poolHash),
    aBytes32(syHash),
  ]);

  const usdc = await session.createSac("USDC", { admin });
  const blend = await session.deployWasm("mock_blend.wasm");
  await mustInvoke(session, blend, "initialize", [
    aAddr(admin),
    aAddr(usdc),
    aI128(SCALAR_9),
  ]);

  const maturity = T0 + 90 * DAY;
  const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
    aAddr(admin),
    aAddr(usdc),
    aAddr(blend),
    aU64(maturity),
    aI128(SCALAR_ROOT),
    aI128(INITIAL_ANCHOR),
  ]);

  await session.sacMint(usdc, lp, 220_000_000_000n);
  await mustInvoke(session, meta.sy, "deposit", [
    aAddr(lp),
    aAddr(lp),
    aI128(220_000_000_000n),
  ]);
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

  return { admin, guardian, lp, u1, factory, usdc, blend, meta, maturity };
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

describe("Tier 2: R3 Slender (F9) & R4 Zap-In (F10) Boundary & Adversarial Suite", () => {
  let session: SorobanRunnerSession;

  beforeAll(async () => {
    session = await SorobanRunnerSession.start();
  }, 120_000);

  afterAll(async () => {
    await session?.close();
  });

  // =========================================================================
  // F9 Boundaries (5 tests)
  // =========================================================================
  describe("F9: Slender SY Adapter & Mock Boundaries", () => {
    test("F9-T2-1: zero and negative deposit/redeem/redeem_to_btoken revert #4 ZeroAmount", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const u1 = await session.genAddress("u1");
      const usdc = await session.createSac("USDC", { admin });
      const { sySlender } = await deploySlenderAndWrapper(session, admin, usdc);

      for (const [fn, amt] of [
        ["deposit", 0],
        ["deposit", -10],
        ["redeem", 0],
        ["redeem", -10],
        ["redeem_to_btoken", 0],
      ] as const) {
        const res = await session.invoke(sySlender, fn, [
          aAddr(u1),
          aAddr(u1),
          aI128(amt),
        ]);
        expectContractError(res, 4, "ZeroAmount");
      }
      expect(await mustInvoke<string>(session, sySlender, "total_shares")).toBe("0");
    });

    test("F9-T2-2: redeem exceeding shares (#5) and illiquid mock_slender roll back atomically", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const u1 = await session.genAddress("u1");
      const usdc = await session.createSac("USDC", { admin });
      const { slender, sySlender } = await deploySlenderAndWrapper(session, admin, usdc);

      await session.sacMint(usdc, u1, 100_000_000n);
      await mustInvoke(session, sySlender, "deposit", [
        aAddr(u1),
        aAddr(u1),
        aI128(100_000_000n),
      ]);

      expectContractError(
        await session.invoke(sySlender, "redeem", [
          aAddr(u1),
          aAddr(u1),
          aI128(100_000_001n),
        ]),
        5,
        "InsufficientBalance"
      );

      // Bump rate 1.0 -> 1.5 WITHOUT minting extra USDC liquidity to mock_slender
      await setSlenderRate(session, slender, 1_500_000_000n);
      const illiquidRes = await session.invoke(sySlender, "redeem", [
        aAddr(u1),
        aAddr(u1),
        aI128(100_000_000n),
      ]);
      expect(illiquidRes.ok).toBe(false);
      expect(["ContractError", "InvokeError"]).toContain(illiquidRes.error?.kind ?? "");
      expect(await mustInvoke<string>(session, sySlender, "balance", [aAddr(u1)])).toBe(
        "100000000"
      );
      expect(await mustInvoke<string>(session, sySlender, "total_shares")).toBe("100000000");
    });

    test("F9-T2-3: double initialize on mock_slender and sy_slender_wrapper reverts #2 AlreadyInitialized", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const attacker = await session.genAddress("attacker");
      const usdc = await session.createSac("USDC", { admin });
      const { slender, sToken, sySlender } = await deploySlenderAndWrapper(
        session,
        admin,
        usdc
      );

      let syReinit = await session.invoke(sySlender, "initialize", [
        aAddr(attacker),
        aAddr(usdc),
        aAddr(slender),
        aAddr(sToken),
      ]);
      if (!syReinit.ok && isArityMismatchError(syReinit.error)) {
        syReinit = await session.invoke(sySlender, "initialize", [
          aAddr(attacker),
          aAddr(usdc),
          aAddr(slender),
        ]);
      }
      expectContractError(syReinit, 2, "AlreadyInitialized");

      let slReinit = await session.invoke(slender, "initialize", [
        aAddr(attacker),
        aAddr(usdc),
        aI128(SCALAR_9),
      ]);
      if (!slReinit.ok && isArityMismatchError(slReinit.error)) {
        slReinit = await session.invoke(slender, "initialize", [
          aAddr(attacker),
          aAddr(usdc),
        ]);
      }
      expectContractError(slReinit, 2, "AlreadyInitialized");
      expect(await mustInvoke<string>(session, sySlender, "get_admin")).toBe(admin);
    });

    test("F9-T2-4: pause blocks mutations (#23 ContractPaused) while reads succeed and unpause restores deposit", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const guardian = await session.genAddress("guardian");
      const u1 = await session.genAddress("u1");
      const u2 = await session.genAddress("u2");
      const usdc = await session.createSac("USDC", { admin });
      const { sySlender } = await deploySlenderAndWrapper(session, admin, usdc);

      await session.sacMint(usdc, u1, 200_000_000n);
      await mustInvoke(session, sySlender, "deposit", [
        aAddr(u1),
        aAddr(u1),
        aI128(100_000_000n),
      ]);
      await mustInvoke(session, sySlender, "set_guardian", [
        aAddr(admin),
        aAddr(guardian),
      ]);
      await mustInvoke(session, sySlender, "pause", [aAddr(guardian)]);

      for (const [fn, args] of [
        ["deposit", [aAddr(u1), aAddr(u1), aI128(50_000_000n)]],
        ["redeem", [aAddr(u1), aAddr(u1), aI128(50_000_000n)]],
        ["redeem_to_btoken", [aAddr(u1), aAddr(u1), aI128(50_000_000n)]],
        ["transfer", [aAddr(u1), aAddr(u2), aI128(10_000_000n)]],
        ["burn", [aAddr(u1), aI128(10_000_000n)]],
      ] as const) {
        expectContractError(
          await session.invoke(sySlender, fn, [...args]),
          23,
          "ContractPaused"
        );
      }

      expect(await mustInvoke<string>(session, sySlender, "exchange_rate")).toBe(
        String(SCALAR_9)
      );
      expect(await mustInvoke<string>(session, sySlender, "balance", [aAddr(u1)])).toBe(
        "100000000"
      );
      expect(await mustInvoke<string>(session, sySlender, "symbol")).toBe("sy-sUSDC");
      expect(await mustInvoke<string>(session, sySlender, "asset")).toBe(usdc);

      await mustInvoke(session, sySlender, "unpause", [aAddr(admin)]);
      await mustInvoke(session, sySlender, "deposit", [
        aAddr(u1),
        aAddr(u1),
        aI128(50_000_000n),
      ]);
      expect(await mustInvoke<string>(session, sySlender, "balance", [aAddr(u1)])).toBe(
        "150000000"
      );
    });

    test("F9-T2-5: micro-deposit rounding to 0 shares reverts #4 and unauthorized set_sy_for_asset reverts #3", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const guardian = await session.genAddress("guardian");
      const attacker = await session.genAddress("attacker");
      const u1 = await session.genAddress("u1");
      const usdc = await session.createSac("USDC", { admin });
      const { slender, sySlender } = await deploySlenderAndWrapper(session, admin, usdc);

      await setSlenderRate(session, slender, 2_000_000_000n);
      await session.sacMint(usdc, u1, 100n);
      // (1 * 1e9) / 2e9 = 0 -> ZeroAmount (#4)
      expectContractError(
        await session.invoke(sySlender, "deposit", [aAddr(u1), aAddr(u1), aI128(1)]),
        4,
        "ZeroAmount"
      );

      const ptHash = await session.uploadWasm("pt_token.wasm");
      const ytHash = await session.uploadWasm("yt_token.wasm");
      const poolHash = await session.uploadWasm("yield_pool.wasm");
      const syHash = await session.uploadWasm("sy_blend_wrapper.wasm");
      const factory = await session.deployWasm("market_factory.wasm");
      await mustInvoke(session, factory, "initialize", [
        aAddr(admin),
        aAddr(guardian),
        aBytes32(ptHash),
        aBytes32(ytHash),
        aBytes32(poolHash),
        aBytes32(syHash),
      ]);

      expectContractError(
        await session.invoke(factory, "set_sy_for_asset", [
          aAddr(attacker),
          aAddr(usdc),
          aAddr(sySlender),
        ]),
        3,
        "Unauthorized"
      );
    });
  });

  // =========================================================================
  // F10 Boundaries (5 tests)
  // =========================================================================
  describe("F10: Zap-In Router Boundaries & Strict Sub-Invocation Auth", () => {
    test("F10-T2-1: zap_in_pt/yt/lp revert atomically #9 SlippageExceeded when min_out exceeds actual", async () => {
      const { u1, factory, usdc, meta } = await setupSeededFactoryMarket(session);
      const amt = 100_000_000n;
      await session.sacMint(usdc, u1, amt);
      const resBefore = await mustInvoke<[string, string]>(session, meta.pool, "get_reserves");

      for (const fn of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        const res = await session.invoke(factory, fn, [
          aAddr(u1),
          aAddr(u1),
          aAddr(meta.pool),
          aI128(amt),
          aI128(10_000_000_000_000n),
          aU64(T0 + 60),
        ]);
        expectContractError(res, 9, "SlippageExceeded");
      }

      expect(await mustInvoke<string>(session, usdc, "balance", [aAddr(u1)])).toBe(String(amt));
      expect(await mustInvoke<[string, string]>(session, meta.pool, "get_reserves")).toEqual(
        resBefore
      );
      await assertFactoryZeroDust(session, factory, [
        usdc,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);
    });

    test("F10-T2-2: zap_in_pt/yt/lp revert #10 at deadline = now - 1 and succeed inclusively at deadline = now", async () => {
      const { u1, factory, usdc, meta } = await setupSeededFactoryMarket(session);
      const amt = 100_000_000n;
      await session.sacMint(usdc, u1, amt * 3n);

      for (const fn of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(u1),
            aAddr(u1),
            aAddr(meta.pool),
            aI128(amt),
            aI128(1),
            aU64(T0 - 1),
          ]),
          10,
          "DeadlineExpired"
        );
      }

      for (const fn of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        const res = await session.invoke(factory, fn, [
          aAddr(u1),
          aAddr(u1),
          aAddr(meta.pool),
          aI128(amt),
          aI128(1),
          aU64(T0),
        ]);
        expect(res.ok).toBe(true);
      }
      await assertFactoryZeroDust(session, factory, [
        usdc,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);
    });

    test("F10-T2-3: zap_in_* invalid inputs (#4), unknown pool (#26), matured pool (#7), paused factory (#23)", async () => {
      const { admin, guardian, u1, factory, usdc, meta, maturity } =
        await setupSeededFactoryMarket(session);
      const unknownPool = await session.genAddress("unknown_pool");
      await session.sacMint(usdc, u1, 100_000_000n);

      for (const fn of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(u1),
            aAddr(u1),
            aAddr(meta.pool),
            aI128(0),
            aI128(1),
            aU64(T0 + 60),
          ]),
          4,
          "ZeroAmount"
        );
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(u1),
            aAddr(u1),
            aAddr(meta.pool),
            aI128(-50),
            aI128(1),
            aU64(T0 + 60),
          ]),
          4,
          "ZeroAmount"
        );
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(u1),
            aAddr(u1),
            aAddr(meta.pool),
            aI128(100_000_000n),
            aI128(-1),
            aU64(T0 + 60),
          ]),
          4,
          "ZeroAmount"
        );
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(u1),
            aAddr(u1),
            aAddr(unknownPool),
            aI128(100_000_000n),
            aI128(1),
            aU64(T0 + 60),
          ]),
          26,
          "MarketNotFound"
        );
      }

      // Pause factory -> #23 ContractPaused
      await mustInvoke(session, factory, "pause", [aAddr(guardian)]);
      for (const fn of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(u1),
            aAddr(u1),
            aAddr(meta.pool),
            aI128(100_000_000n),
            aI128(1),
            aU64(T0 + 60),
          ]),
          23,
          "ContractPaused"
        );
      }

      // Unpause and advance to maturity -> #7 MarketAlreadyMatured
      await mustInvoke(session, factory, "unpause", [aAddr(admin)]);
      await session.setLedger({ timestamp: maturity });
      for (const fn of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        expectContractError(
          await session.invoke(factory, fn, [
            aAddr(u1),
            aAddr(u1),
            aAddr(meta.pool),
            aI128(100_000_000n),
            aI128(1),
            aU64(maturity + 60),
          ]),
          7,
          "MarketAlreadyMatured"
        );
      }
      expect(await mustInvoke<string>(session, usdc, "balance", [aAddr(u1)])).toBe(
        "100000000"
      );
    });

    test("F10-T2-4: strict signer auth (with authorize_as_current_contract) passes while unsigned auth:'none' fails AuthError", async () => {
      const { u1, factory, usdc, meta } = await setupSeededFactoryMarket(session);
      const amt = 100_000_000n;
      await session.sacMint(usdc, u1, amt * 3n);

      for (const fn of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
        const args: TypedArg[] = [
          aAddr(u1),
          aAddr(u1),
          aAddr(meta.pool),
          aI128(amt),
          aI128(1),
          aU64(T0 + 60),
        ];

        // 1. Unsigned invocation must fail with AuthError
        const noAuthRes = await session.invoke(factory, fn, args, { auth: "none" });
        expect(noAuthRes.ok).toBe(false);
        expect(noAuthRes.error?.kind).toBe("AuthError");

        // 2. Strict root signer + asset transfer sub_invoke only (factory must supply authorize_as_current_contract)
        const signedRes = await session.invoke(factory, fn, args, {
          auth: {
            signers: [
              {
                address: u1,
                invoke: {
                  contract: factory,
                  fn_name: fn,
                  args,
                  sub_invokes: [
                    {
                      contract: usdc,
                      fn_name: "transfer",
                      args: [aAddr(u1), aAddr(factory), aI128(amt)],
                    },
                  ],
                },
              },
            ],
          },
        });
        expect(signedRes.ok).toBe(true);
      }

      await assertFactoryZeroDust(session, factory, [
        usdc,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);
    });

    test("F10-T2-5: out-of-bounds zap_in_pt reverts #14 ProportionOutOfBounds and 5 sequential zaps leave 0 factory dust", async () => {
      const { u1, factory, usdc, meta } = await setupSeededFactoryMarket(session);
      await session.sacMint(usdc, u1, 500_000_000_000n);

      // Push PT/(PT+SY) below 0.04 WAD on 120B PT / 100B SY pool (95B SY swap -> ~6B PT / 195B SY < 4%)
      const oobRes = await session.invoke(factory, "zap_in_pt", [
        aAddr(u1),
        aAddr(u1),
        aAddr(meta.pool),
        aI128(95_000_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      expectContractError(oobRes, 14, "ProportionOutOfBounds");
      await assertFactoryZeroDust(session, factory, [
        usdc,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);

      // 5 sequential zaps across PT / YT / LP
      for (const fn of [
        "zap_in_pt",
        "zap_in_yt",
        "zap_in_lp",
        "zap_in_pt",
        "zap_in_lp",
      ] as const) {
        const res = await session.invoke(factory, fn, [
          aAddr(u1),
          aAddr(u1),
          aAddr(meta.pool),
          aI128(50_000_000n),
          aI128(1),
          aU64(T0 + 60),
        ]);
        expect(res.ok).toBe(true);
        await assertFactoryZeroDust(session, factory, [
          usdc,
          meta.sy,
          meta.pt,
          meta.yt,
          meta.pool,
        ]);
      }
    });
  });
});
