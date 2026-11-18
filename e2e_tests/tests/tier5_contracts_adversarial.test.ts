// e2e_tests/tests/tier5_contracts_adversarial.test.ts
// Tier 5: White-Box Adversarial Hardening Suite for Surface A (Contracts, Math, Zap-In, Slender, Rollover, Security)

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  SorobanRunnerSession,
  type TypedArg,
  type SorobanResponse,
} from "../src/harness/soroban-harness.ts";
import {
  WAD,
  SCALAR_9,
  DEFAULT_SCALAR_ROOT,
  I128_MAX,
  wadMul,
  wadDiv,
  wadDivCeil,
  getExchangeRate,
  calcTauWad,
  calcFeeRate,
  syToAsset,
  assetToSy,
  oracleSwapPtForSy,
  oracleSwapSyForPt,
  oracleSwapSyForYt,
  oracleSwapYtForSy,
} from "../src/math-oracle.ts";

const T0 = 1_700_000_000;
const DAY = 86_400;
const SCALAR_ROOT = DEFAULT_SCALAR_ROOT;
const INITIAL_ANCHOR = (105n * WAD) / 100n;

const aAddr = (value: string): TypedArg => ({ type: "address", value });
const aI128 = (value: bigint | number | string): TypedArg => ({ type: "i128", value: String(value) });
const aU64 = (value: bigint | number | string): TypedArg => ({ type: "u64", value: String(value) });
const aU32 = (value: number): TypedArg => ({ type: "u32", value });
const aStr = (value: string): TypedArg => ({ type: "string", value });
const aBool = (value: boolean): TypedArg => ({ type: "bool", value });
const aBytes32 = (value: string): TypedArg => ({ type: "bytes_n32", value });

async function must<T = unknown>(
  s: SorobanRunnerSession,
  contract: string,
  method: string,
  args: TypedArg[] = []
): Promise<T> {
  const res = await s.invoke<T>(contract, method, args);
  if (!res.ok) {
    throw new Error(`${method} failed (${res.error?.kind} #${res.error?.code}): ${res.error?.message}`);
  }
  return res.data as T;
}

function expectContractError(res: SorobanResponse<unknown>, code: number, name?: string) {
  expect(res.ok).toBe(false);
  expect(res.error?.kind).toBe("ContractError");
  expect(res.error?.code).toBe(code);
  if (name) expect(res.error?.name).toBe(name);
}

describe("Tier 5: Surface A Contracts White-Box Adversarial Suite", () => {
  let s: SorobanRunnerSession;

  beforeAll(async () => {
    s = await SorobanRunnerSession.start();
  }, 120_000);

  afterAll(async () => {
    await s?.close();
  });

  test("T5-A1: swap_exact_yt_for_sy rejects 1-stroop rounding drain and zero-output burn", async () => {
    // Arrange
    await s.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
    const admin = await s.genAddress("admin");
    const guardian = await s.genAddress("guardian");
    const lp = await s.genAddress("lp");
    const attacker = await s.genAddress("attacker");

    const [ptH, ytH, poolH, syH] = await Promise.all([
      s.uploadWasm("pt_token.wasm"),
      s.uploadWasm("yt_token.wasm"),
      s.uploadWasm("yield_pool.wasm"),
      s.uploadWasm("sy_blend_wrapper.wasm"),
    ]);
    const factory = await s.deployWasm("market_factory.wasm");
    await must(s, factory, "initialize", [
      aAddr(admin), aAddr(guardian), aBytes32(ptH), aBytes32(ytH), aBytes32(poolH), aBytes32(syH),
    ]);
    const usdc = await s.createSac("USDC", { admin });
    const blend = await s.deployWasm("mock_blend.wasm");
    await must(s, blend, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const maturity = T0 + 90 * DAY;
    const meta = await must<{ sy: string; pt: string; yt: string; pool: string }>(s, factory, "create_market", [
      aAddr(admin), aAddr(usdc), aAddr(blend), aU64(maturity), aI128(SCALAR_ROOT), aI128(WAD),
    ]);

    await s.sacMint(usdc, lp, 220_000_000_000n);
    await must(s, meta.sy, "deposit", [aAddr(lp), aAddr(lp), aI128(220_000_000_000n)]);
    await must(s, meta.pool, "mint_py", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aU64(maturity)]);
    await must(s, meta.pool, "add_liquidity", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aI128(100_000_000_000n), aI128(1)]);

    await s.sacMint(usdc, attacker, 1_000n);
    await must(s, meta.sy, "deposit", [aAddr(attacker), aAddr(attacker), aI128(1_000n)]);
    const [ytBought] = await must<[string, string]>(s, meta.pool, "swap_exact_sy_for_yt", [
      aAddr(attacker), aAddr(attacker), aI128(10n), aI128(0), aU64(maturity),
    ]);
    expect(BigInt(ytBought)).toBeGreaterThan(0n);

    // Act & Assert: Must NOT allow 1 YT -> 1 SY rounding profit or 0 SY silent burn
    let syReceived = 0n;
    for (let i = 0; i < 20; i++) {
      const r = await s.invoke<[string, string]>(meta.pool, "swap_exact_yt_for_sy", [
        aAddr(attacker), aAddr(attacker), aI128(1n), aI128(0), aU64(maturity),
      ]);
      if (r.ok) {
        const out = BigInt(r.data![0]);
        expect(out).toBeGreaterThan(0n);
        syReceived += out;
      } else {
        expect([4, 18]).toContain(r.error?.code ?? -1);
      }
    }
    expect(syReceived).toBeLessThanOrEqual(1n);

    // Zero-output burn check at elevated b_rate = 1.15
    await must(s, blend, "set_b_rate", [aI128(1_150_000_000n)]);
    const ytBeforeElevated = BigInt(await must<string>(s, meta.yt, "balance", [aAddr(attacker)]));
    const rElevated = await s.invoke<[string, string]>(meta.pool, "swap_exact_yt_for_sy", [
      aAddr(attacker), aAddr(attacker), aI128(1n), aI128(0), aU64(maturity),
    ]);
    if (!rElevated.ok) {
      expect([4, 18]).toContain(rElevated.error?.code ?? -1);
      expect(BigInt(await must<string>(s, meta.yt, "balance", [aAddr(attacker)]))).toBe(ytBeforeElevated);
    } else {
      expect(BigInt(rElevated.data![0])).toBeGreaterThan(0n);
    }
  });

  test("T5-A2: add_liquidity rejects 0 LP share mint & remove_liquidity handles 1-stroop dust without #4", async () => {
    // Arrange
    await s.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
    const admin = await s.genAddress("admin");
    const guardian = await s.genAddress("guardian");
    const lp = await s.genAddress("lp");
    const user = await s.genAddress("user");

    const [ptH, ytH, poolH, syH] = await Promise.all([
      s.uploadWasm("pt_token.wasm"),
      s.uploadWasm("yt_token.wasm"),
      s.uploadWasm("yield_pool.wasm"),
      s.uploadWasm("sy_blend_wrapper.wasm"),
    ]);
    const factory = await s.deployWasm("market_factory.wasm");
    await must(s, factory, "initialize", [
      aAddr(admin), aAddr(guardian), aBytes32(ptH), aBytes32(ytH), aBytes32(poolH), aBytes32(syH),
    ]);
    const usdc = await s.createSac("USDC", { admin });
    const blend = await s.deployWasm("mock_blend.wasm");
    await must(s, blend, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const maturity = T0 + 90 * DAY;
    const meta = await must<{ sy: string; pt: string; yt: string; pool: string }>(s, factory, "create_market", [
      aAddr(admin), aAddr(usdc), aAddr(blend), aU64(maturity), aI128(SCALAR_ROOT), aI128(WAD),
    ]);

    await s.sacMint(usdc, lp, 220_000_000_000n);
    await must(s, meta.sy, "deposit", [aAddr(lp), aAddr(lp), aI128(220_000_000_000n)]);
    await must(s, meta.pool, "mint_py", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aU64(maturity)]);
    await must(s, meta.pool, "add_liquidity", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aI128(100_000_000_000n), aI128(1)]);

    await s.sacMint(usdc, user, 2_000n);
    await must(s, meta.sy, "deposit", [aAddr(user), aAddr(user), aI128(2_000n)]);
    await must(s, meta.pool, "mint_py", [aAddr(user), aAddr(user), aI128(500n), aU64(maturity)]);

    const userPtBefore = BigInt(await must<string>(s, meta.pt, "balance", [aAddr(user)]));
    const userSyBefore = BigInt(await must<string>(s, meta.sy, "balance", [aAddr(user)]));

    // Act & Assert: Imbalanced deposit yielding 0 LP shares must revert #4 ZeroAmount without pulling tokens
    const addRes = await s.invoke(meta.pool, "add_liquidity", [
      aAddr(user), aAddr(user), aI128(1n), aI128(500n), aI128(0),
    ]);
    expectContractError(addRes, 4, "ZeroAmount");
    expect(BigInt(await must<string>(s, meta.pt, "balance", [aAddr(user)]))).toBe(userPtBefore);
    expect(BigInt(await must<string>(s, meta.sy, "balance", [aAddr(user)]))).toBe(userSyBefore);

    // 1-stroop LP withdrawal where sy_out==0, pt_out==1 must succeed cleanly (not trap on transfer(0))
    const remRes = await s.invoke<[string, string]>(meta.pool, "remove_liquidity", [
      aAddr(lp), aAddr(lp), aI128(1n), aI128(0), aI128(0),
    ]);
    expect(remRes.ok).toBe(true);
    expect(BigInt(remRes.data![0])).toBe(1n);
    expect(BigInt(remRes.data![1])).toBe(0n);
  });

  test("T5-A3: zap_in and rollover reject receiver == factory to prevent sweep_zap_dust theft", async () => {
    // Arrange
    await s.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
    const admin = await s.genAddress("admin");
    const guardian = await s.genAddress("guardian");
    const lp = await s.genAddress("lp");
    const victim = await s.genAddress("victim");

    const [ptH, ytH, poolH, syH] = await Promise.all([
      s.uploadWasm("pt_token.wasm"),
      s.uploadWasm("yt_token.wasm"),
      s.uploadWasm("yield_pool.wasm"),
      s.uploadWasm("sy_blend_wrapper.wasm"),
    ]);
    const factory = await s.deployWasm("market_factory.wasm");
    await must(s, factory, "initialize", [
      aAddr(admin), aAddr(guardian), aBytes32(ptH), aBytes32(ytH), aBytes32(poolH), aBytes32(syH),
    ]);
    const usdc = await s.createSac("USDC", { admin });
    const blend = await s.deployWasm("mock_blend.wasm");
    await must(s, blend, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const maturity = T0 + 90 * DAY;
    const meta = await must<{ sy: string; pt: string; yt: string; pool: string }>(s, factory, "create_market", [
      aAddr(admin), aAddr(usdc), aAddr(blend), aU64(maturity), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR),
    ]);

    await s.sacMint(usdc, lp, 220_000_000_000n);
    await must(s, meta.sy, "deposit", [aAddr(lp), aAddr(lp), aI128(220_000_000_000n)]);
    await must(s, meta.pool, "mint_py", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aU64(maturity)]);
    await must(s, meta.pool, "add_liquidity", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aI128(100_000_000_000n), aI128(1)]);

    await s.sacMint(usdc, victim, 1_000_000_000n);

    // Act & Assert
    expectContractError(
      await s.invoke(factory, "zap_in_pt", [
        aAddr(victim), aAddr(factory), aAddr(meta.pool), aI128(1_000_000_000n), aI128(0), aU64(maturity),
      ]),
      15,
      "IdenticalAddresses"
    );
    expectContractError(
      await s.invoke(factory, "zap_in_yt", [
        aAddr(victim), aAddr(factory), aAddr(meta.pool), aI128(1_000_000_000n), aI128(0), aU64(maturity),
      ]),
      15,
      "IdenticalAddresses"
    );
    expectContractError(
      await s.invoke(factory, "zap_in_lp", [
        aAddr(victim), aAddr(factory), aAddr(meta.pool), aI128(1_000_000_000n), aI128(0), aU64(maturity),
      ]),
      15,
      "IdenticalAddresses"
    );
  });

  test("T5-A4: real WASM 4-way swap oracle parity and reserve conservation at py_index = 1.25 and 0.80", async () => {
    for (const [rate, ptSeed, sySeed] of [
      [1_250_000_000n, 160_000_000_000n, 100_000_000_000n],
      [800_000_000n, 120_000_000_000n, 100_000_000_000n],
    ] as const) {
      // Arrange
      await s.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
      const admin = await s.genAddress("admin");
      const feeRecip = await s.genAddress("feeRecip");
      const lp = await s.genAddress("lp");
      const user = await s.genAddress("user");
      const usdc = await s.createSac("USDC", { admin });
      const blend = await s.deployWasm("mock_blend.wasm");
      await must(s, blend, "initialize", [aAddr(admin), aAddr(usdc), aI128(rate)]);
      const sy = await s.deployWasm("sy_blend_wrapper.wasm");
      await must(s, sy, "initialize", [aAddr(admin), aAddr(usdc), aAddr(blend)]);
      const pt = await s.deployWasm("pt_token.wasm");
      const yt = await s.deployWasm("yt_token.wasm");
      const pool = await s.deployWasm("yield_pool.wasm");
      const maturity = T0 + 90 * DAY;
      await must(s, pt, "initialize", [aAddr(admin), aAddr(pool), aStr("PT"), aStr("PT"), aU32(7), aU64(maturity)]);
      await must(s, yt, "initialize", [aAddr(admin), aAddr(pool), aAddr(sy), aStr("YT"), aStr("YT"), aU32(7), aU64(maturity)]);
      await must(s, pool, "initialize", [aAddr(admin), aAddr(sy), aAddr(pt), aAddr(yt), aU64(maturity), aI128(SCALAR_ROOT), aI128(WAD)]);
      await must(s, pool, "set_fee_recipient", [aAddr(admin), aAddr(feeRecip)]);

      const ptSyNeeded = (ptSeed * SCALAR_9) / rate + 10_000_000n;
      const totalUnderlying = ((ptSyNeeded + sySeed) * rate) / SCALAR_9 + 100_000_000n;
      await s.sacMint(usdc, lp, totalUnderlying);
      await must(s, sy, "deposit", [aAddr(lp), aAddr(lp), aI128(totalUnderlying)]);
      await must(s, pool, "mint_py", [aAddr(lp), aAddr(lp), aI128(ptSyNeeded), aU64(maturity)]);
      await must(s, pool, "add_liquidity", [aAddr(lp), aAddr(lp), aI128(ptSeed), aI128(sySeed), aI128(1)]);

      await s.sacMint(usdc, user, 200_000_000_000n);
      await must(s, sy, "deposit", [aAddr(user), aAddr(user), aI128(200_000_000_000n)]);
      await must(s, pool, "mint_py", [aAddr(user), aAddr(user), aI128(20_000_000_000n), aU64(maturity)]);

      const nowBig = BigInt(T0);
      const matBig = BigInt(maturity);

      // 1. PT -> SY
      let [ptR, syR] = (await must<[string, string]>(s, pool, "get_reserves")).map(BigInt) as [bigint, bigint];
      const o1 = oracleSwapPtForSy(1_000_000_000n, ptR, syR, nowBig, matBig, WAD, rate);
      const [w1Out, w1Fee] = await must<[string, string]>(s, pool, "swap_exact_pt_for_sy", [
        aAddr(user), aAddr(user), aI128(1_000_000_000n), aI128(0), aU64(maturity),
      ]);
      expect(BigInt(w1Out)).toBe(o1.netOut);
      expect(BigInt(w1Fee)).toBe(o1.fee);

      // 2. SY -> PT
      [ptR, syR] = (await must<[string, string]>(s, pool, "get_reserves")).map(BigInt) as [bigint, bigint];
      const o2 = oracleSwapSyForPt(1_000_000_000n, ptR, syR, nowBig, matBig, WAD, rate);
      const [w2Out, w2Fee] = await must<[string, string]>(s, pool, "swap_exact_sy_for_pt", [
        aAddr(user), aAddr(user), aI128(1_000_000_000n), aI128(0), aU64(maturity),
      ]);
      expect(BigInt(w2Out)).toBe(o2.netOut);
      expect(BigInt(w2Fee)).toBe(o2.fee);

      // 3. SY -> YT
      [ptR, syR] = (await must<[string, string]>(s, pool, "get_reserves")).map(BigInt) as [bigint, bigint];
      const o3 = oracleSwapSyForYt(200_000_000n, ptR, syR, nowBig, matBig, WAD, rate);
      const [w3Out, w3Fee] = await must<[string, string]>(s, pool, "swap_exact_sy_for_yt", [
        aAddr(user), aAddr(user), aI128(200_000_000n), aI128(0), aU64(maturity),
      ]);
      expect(BigInt(w3Out)).toBe(o3.ytOut);
      expect(BigInt(w3Fee)).toBe(o3.fee);

      // 4. YT -> SY (using centralized wadDivCeil oracle!)
      [ptR, syR] = (await must<[string, string]>(s, pool, "get_reserves")).map(BigInt) as [bigint, bigint];
      const o4 = oracleSwapYtForSy(1_000_000_000n, ptR, syR, nowBig, matBig, WAD, rate);
      const [w4Out, w4Fee] = await must<[string, string]>(s, pool, "swap_exact_yt_for_sy", [
        aAddr(user), aAddr(user), aI128(1_000_000_000n), aI128(0), aU64(maturity),
      ]);
      expect(BigInt(w4Out)).toBe(o4.netOut);
      expect(BigInt(w4Fee)).toBe(o4.fee);

      const st = await must<{ total_sy_reserve: string }>(s, pool, "get_market_state");
      const [ptP, ytY] = await must<[string, string]>(s, pool, "get_py_reserves");
      const poolSy = BigInt(await must<string>(s, sy, "balance", [aAddr(pool)]));
      expect(poolSy).toBeGreaterThanOrEqual(BigInt(st.total_sy_reserve) + BigInt(ptP) + BigInt(ytY));
      expect(poolSy - (BigInt(st.total_sy_reserve) + BigInt(ptP) + BigInt(ytY))).toBeLessThanOrEqual(2n);
    }
  });

  test("T5-A5: bad-debt claim_yield preserves unclaimed_yield when available_py_sy==0, and rate-drop solvency blocks mint_py", async () => {
    // Arrange
    await s.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
    const admin = await s.genAddress("admin");
    const user1 = await s.genAddress("user1");
    const user2 = await s.genAddress("user2");
    const usdc = await s.createSac("USDC", { admin });
    const blend = await s.deployWasm("mock_blend.wasm");
    await must(s, blend, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const sy = await s.deployWasm("sy_blend_wrapper.wasm");
    await must(s, sy, "initialize", [aAddr(admin), aAddr(usdc), aAddr(blend)]);
    const pt = await s.deployWasm("pt_token.wasm");
    const yt = await s.deployWasm("yt_token.wasm");
    const pool = await s.deployWasm("yield_pool.wasm");
    const maturity = T0 + 90 * DAY;
    await must(s, pt, "initialize", [aAddr(admin), aAddr(pool), aStr("PT"), aStr("PT"), aU32(7), aU64(maturity)]);
    await must(s, yt, "initialize", [aAddr(admin), aAddr(pool), aAddr(sy), aStr("YT"), aStr("YT"), aU32(7), aU64(maturity)]);
    await must(s, pool, "initialize", [aAddr(admin), aAddr(sy), aAddr(pt), aAddr(yt), aU64(maturity), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR)]);

    await s.sacMint(usdc, user1, 10_000_000_000n);
    await must(s, sy, "deposit", [aAddr(user1), aAddr(user1), aI128(10_000_000_000n)]);
    await must(s, pool, "mint_py", [aAddr(user1), aAddr(user1), aI128(10_000_000_000n), aU64(maturity)]);

    // Rate rises 1.0 -> 1.2, checkpoint, then drops 1.2 -> 0.8
    await must(s, blend, "set_b_rate", [aI128(1_200_000_000n)]);
    await must(s, yt, "transfer", [aAddr(user1), aAddr(user1), aI128(1n)]);
    await must(s, blend, "set_b_rate", [aI128(800_000_000n)]);

    await s.sacMint(usdc, user2, 1_000_000_000n);
    await must(s, sy, "deposit", [aAddr(user2), aAddr(user2), aI128(1_000_000_000n)]);
    expectContractError(
      await s.invoke(pool, "mint_py", [aAddr(user2), aAddr(user2), aI128(1_000_000_000n), aU64(maturity)]),
      5,
      "InsufficientBalance"
    );

    // Act & Assert: Burn all SY in pool -> claim_yield must revert #5 and roll back unclaimed_yield atomically
    await s.burnAsHolder(sy, pool, 10_000_000_000n);
    const claimZero = await s.invoke(pool, "claim_yield", [aAddr(user1), aAddr(user1)]);
    expectContractError(claimZero, 5, "InsufficientBalance");

    const stAfter = await must<{ unclaimed_yield: string }>(s, yt, "get_user_yield_state", [aAddr(user1)]);
    expect(BigInt(stAfter.unclaimed_yield)).toBeGreaterThan(0n);
    const totalUnclaimed = await must<string>(s, yt, "get_total_unclaimed_yield");
    expect(BigInt(totalUnclaimed)).toBeGreaterThan(0n);
  });

  test("T5-A6: auth_mode=none, re-init guards across 8 contracts, whitelist revocation, admin rotation, and i128::MAX bounds", async () => {
    // Arrange
    await s.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
    const admin = await s.genAddress("admin");
    const admin2 = await s.genAddress("admin2");
    const guardian = await s.genAddress("guardian");
    const creator = await s.genAddress("creator");
    const attacker = await s.genAddress("attacker");

    const [ptH, ytH, poolH, syH] = await Promise.all([
      s.uploadWasm("pt_token.wasm"),
      s.uploadWasm("yt_token.wasm"),
      s.uploadWasm("yield_pool.wasm"),
      s.uploadWasm("sy_blend_wrapper.wasm"),
    ]);
    const usdc = await s.createSac("USDC", { admin });
    const blend = await s.deployWasm("mock_blend.wasm");
    await must(s, blend, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const slender = await s.deployWasm("mock_slender.wasm");
    await must(s, slender, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const sySl = await s.deployWasm("sy_slender_wrapper.wasm");
    await must(s, sySl, "initialize", [aAddr(admin), aAddr(usdc), aAddr(slender), aAddr(slender)]);
    const factory = await s.deployWasm("market_factory.wasm");
    await must(s, factory, "initialize", [
      aAddr(admin), aAddr(guardian), aBytes32(ptH), aBytes32(ytH), aBytes32(poolH), aBytes32(syH),
    ]);
    const maturity = T0 + 90 * DAY;
    const meta = await must<{ sy: string; pt: string; yt: string; pool: string }>(s, factory, "create_market", [
      aAddr(admin), aAddr(usdc), aAddr(blend), aU64(maturity), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR),
    ]);

    // All 8 contracts reject re-init with #2 AlreadyInitialized
    for (const [c, m, args] of [
      [blend, "initialize", [aAddr(attacker), aAddr(usdc), aI128(SCALAR_9)]],
      [slender, "initialize", [aAddr(attacker), aAddr(usdc), aI128(SCALAR_9)]],
      [meta.sy, "initialize", [aAddr(attacker), aAddr(usdc), aAddr(blend)]],
      [sySl, "initialize", [aAddr(attacker), aAddr(usdc), aAddr(slender), aAddr(slender)]],
      [meta.pt, "initialize", [aAddr(attacker), aAddr(meta.pool), aStr("X"), aStr("X"), aU32(7), aU64(maturity)]],
      [meta.yt, "initialize", [aAddr(attacker), aAddr(meta.pool), aAddr(meta.sy), aStr("Y"), aStr("Y"), aU32(7), aU64(maturity)]],
      [meta.pool, "initialize", [aAddr(attacker), aAddr(meta.sy), aAddr(meta.pt), aAddr(meta.yt), aU64(maturity), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR)]],
      [factory, "initialize", [aAddr(attacker), aAddr(guardian), aBytes32(ptH), aBytes32(ytH), aBytes32(poolH), aBytes32(syH)]],
    ] as [string, string, TypedArg[]][]) {
      expectContractError(await s.invoke(c, m, args), 2, "AlreadyInitialized");
    }

    // Whitelist removal & admin transfer revocation
    await must(s, factory, "set_creator_whitelist", [aAddr(admin), aAddr(creator), aBool(true)]);
    await must(s, factory, "set_creator_whitelist", [aAddr(admin), aAddr(creator), aBool(false)]);
    expectContractError(
      await s.invoke(factory, "create_market", [
        aAddr(creator), aAddr(usdc), aAddr(blend), aU64(maturity + DAY), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR),
      ]),
      3,
      "Unauthorized"
    );
    await must(s, factory, "propose_admin", [aAddr(admin), aAddr(admin2)]);
    await must(s, factory, "accept_admin", [aAddr(admin2)]);
    expectContractError(
      await s.invoke(factory, "create_market", [
        aAddr(admin), aAddr(usdc), aAddr(blend), aU64(maturity + DAY), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR),
      ]),
      3,
      "Unauthorized"
    );

    // Seed meta.pool with non-zero reserves so pt_res + I128_MAX triggers #13 MathOverflow cleanly
    await must(s, usdc, "mint", [aAddr(admin), aI128(100_000_000n)]);
    await must(s, meta.sy, "deposit", [aAddr(admin), aAddr(admin), aI128(100_000_000n)]);
    await must(s, meta.pool, "mint_py", [aAddr(admin), aAddr(admin), aI128(40_000_000n), aU64(maturity + 100)]);
    await must(s, meta.pool, "add_liquidity", [
      aAddr(admin), aAddr(admin), aI128(20_000_000n), aI128(20_000_000n), aI128(0),
    ]);

    // i128::MAX overflow & negative bounds
    expectContractError(
      await s.invoke(meta.pool, "swap_exact_pt_for_sy", [
        aAddr(attacker), aAddr(attacker), aI128(I128_MAX), aI128(0), aU64(maturity),
      ]),
      13,
      "MathOverflow"
    );
    expectContractError(
      await s.invoke(meta.pool, "mint_py", [aAddr(attacker), aAddr(attacker), aI128("-1"), aU64(maturity)]),
      4,
      "ZeroAmount"
    );

    // auth_mode: "none" must reject unsigned invocations
    await s.setAuthMode("none");
    for (const [c, m, args] of [
      [factory, "set_creator_whitelist", [aAddr(admin2), aAddr(attacker), aBool(true)]],
      [factory, "zap_in_pt", [aAddr(attacker), aAddr(attacker), aAddr(meta.pool), aI128(1000n), aI128(0), aU64(maturity)]],
      [meta.pool, "swap_exact_pt_for_sy", [aAddr(attacker), aAddr(attacker), aI128(1000n), aI128(0), aU64(maturity)]],
      [sySl, "set_slender_pool", [aAddr(admin), aAddr(blend)]],
    ] as [string, string, TypedArg[]][]) {
      const r = await s.invoke(c, m, args);
      expect(r.ok).toBe(false);
      expect(r.error?.kind).toBe("AuthError");
    }
  });

  test("T5-A7: Slender real-WASM mid-Zap organic accrual, redeem_to_btoken -> mock_slender::withdraw, SEP-41 approve ledger expiry, and 1-stroop deposit/redeem at 1.25 rate", async () => {
    // Arrange
    await s.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
    const admin = await s.genAddress("admin");
    const guardian = await s.genAddress("guardian");
    const lp = await s.genAddress("lp");
    const u1 = await s.genAddress("u1");
    const u2 = await s.genAddress("u2");

    const [ptH, ytH, poolH, syBlendH] = await Promise.all([
      s.uploadWasm("pt_token.wasm"),
      s.uploadWasm("yt_token.wasm"),
      s.uploadWasm("yield_pool.wasm"),
      s.uploadWasm("sy_blend_wrapper.wasm"),
    ]);
    const factory = await s.deployWasm("market_factory.wasm");
    await must(s, factory, "initialize", [
      aAddr(admin), aAddr(guardian), aBytes32(ptH), aBytes32(ytH), aBytes32(poolH), aBytes32(syBlendH),
    ]);

    const usdc = await s.createSac("USDC", { admin });
    const slender = await s.deployWasm("mock_slender.wasm");
    await must(s, slender, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const sySl = await s.deployWasm("sy_slender_wrapper.wasm");
    await must(s, sySl, "initialize", [aAddr(admin), aAddr(usdc), aAddr(slender), aAddr(slender)]);

    const maturity = T0 + 90 * DAY;
    const pt = await s.deployWasm("pt_token.wasm");
    const yt = await s.deployWasm("yt_token.wasm");
    const pool = await s.deployWasm("yield_pool.wasm");
    await must(s, pt, "initialize", [aAddr(admin), aAddr(pool), aStr("PT sUSDC"), aStr("PT-sUSDC-90D"), aU32(7), aU64(maturity)]);
    await must(s, yt, "initialize", [aAddr(admin), aAddr(pool), aAddr(sySl), aStr("YT sUSDC"), aStr("YT-sUSDC-90D"), aU32(7), aU64(maturity)]);
    await must(s, pool, "initialize", [aAddr(admin), aAddr(sySl), aAddr(pt), aAddr(yt), aU64(maturity), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR)]);
    await must(s, factory, "register_market", [
      aAddr(admin), aAddr(pool), aAddr(sySl), aAddr(pt), aAddr(yt), aAddr(usdc), aU64(maturity), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR),
    ]);

    await s.sacMint(usdc, lp, 220_000_000_000n);
    await must(s, sySl, "deposit", [aAddr(lp), aAddr(lp), aI128(220_000_000_000n)]);
    await must(s, pool, "mint_py", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aU64(maturity)]);
    await must(s, pool, "add_liquidity", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aI128(100_000_000_000n), aI128(1)]);

    // 1. Slender organic accrual mid-Zap: set 10% APR and advance 30 days before zap_in_pt
    await must(s, slender, "set_annual_rate", [aI128(100_000_000_000_000_000n)]); // 10% WAD
    const tAccrued = T0 + 30 * DAY;
    await s.setLedger({ timestamp: tAccrued, sequence: 150 });
    await s.sacMint(usdc, u1, 10_000_000_000n);
    const rateBeforeZap = BigInt(await must<string>(s, sySl, "exchange_rate"));
    expect(rateBeforeZap).toBeGreaterThan(SCALAR_9);

    const ptZapped = BigInt(
      await must<string>(s, factory, "zap_in_pt", [
        aAddr(u1), aAddr(u1), aAddr(pool), aI128(2_000_000_000n), aI128(1), aU64(maturity),
      ])
    );
    expect(ptZapped).toBeGreaterThan(0n);

    // 2. Deposit into sy_slender_wrapper, redeem_to_btoken -> sUSDC, then mock_slender::withdraw -> underlying USDC
    await must(s, sySl, "deposit", [aAddr(u1), aAddr(u1), aI128(1_000_000_000n)]);
    const syShares = BigInt(await must<string>(s, sySl, "balance", [aAddr(u1)]));
    expect(syShares).toBeGreaterThan(0n);

    const sTokenOut = BigInt(
      await must<string>(s, sySl, "redeem_to_btoken", [aAddr(u1), aAddr(u1), aI128(syShares)])
    );
    expect(sTokenOut).toBe(syShares);
    expect(BigInt(await must<string>(s, slender, "balance", [aAddr(u1)]))).toBe(sTokenOut);

    const usdcBeforeWithdraw = BigInt(await must<string>(s, usdc, "balance", [aAddr(u1)]));
    // Withdraw half of accrued underlying value cleanly via mock_slender::withdraw
    const withdrawAmt = 400_000_000n;
    await must(s, slender, "withdraw", [aAddr(u1), aAddr(u1), aAddr(usdc), aI128(withdrawAmt)]);
    expect(BigInt(await must<string>(s, usdc, "balance", [aAddr(u1)])) - usdcBeforeWithdraw).toBe(withdrawAmt);

    // 3. SEP-41 approve ledger-sequence expiry boundary on sy_slender_wrapper
    await must(s, sySl, "deposit", [aAddr(u1), aAddr(u1), aI128(100_000_000n)]);
    await must(s, sySl, "approve", [aAddr(u1), aAddr(u2), aI128(50_000_000n), aU32(200)]);
    await s.setLedger({ sequence: 200 });
    // At exact expiration ledger 200, transfer_from(25_000_000) succeeds
    await must(s, sySl, "transfer_from", [aAddr(u2), aAddr(u1), aAddr(u2), aI128(25_000_000n)]);
    // Advance ledger sequence past live_until_ledger (201 > 200) -> #6 InsufficientAllowance
    await s.setLedger({ sequence: 201 });
    expectContractError(
      await s.invoke(sySl, "transfer_from", [aAddr(u2), aAddr(u1), aAddr(u2), aI128(1_000_000n)]),
      6,
      "InsufficientAllowance"
    );

    // 4. 1-stroop deposit/redeem at exact 1.25 rate
    await must(s, slender, "set_liquidity_index", [aI128(1_250_000_000n)]);
    await s.sacMint(usdc, slender, 1_000_000_000n); // ensure underlying liquidity for 1.25 rate redemption
    // deposit(1) at 1.25 => floor(1 * 1e9 / 1.25e9) = 0 shares -> #4 ZeroAmount
    expectContractError(
      await s.invoke(sySl, "deposit", [aAddr(u1), aAddr(u1), aI128(1n)]),
      4,
      "ZeroAmount"
    );
    // redeem(1) at 1.25 => floor(1 * 1.25e9 / 1e9) = 1 underlying stroop
    const u2UsdcBefore = BigInt(await must<string>(s, usdc, "balance", [aAddr(u2)]));
    const redeemed1 = BigInt(
      await must<string>(s, sySl, "redeem", [aAddr(u2), aAddr(u2), aI128(1n)])
    );
    expect(redeemed1).toBe(1n);
    expect(BigInt(await must<string>(s, usdc, "balance", [aAddr(u2)])) - u2UsdcBefore).toBe(1n);
  });

  test("T5-A8: Cross-adapter Blend<->Slender rollover_to_pt/rollover_to_py and boundary guards (deadline, unmatured source, matured target, receiver==factory)", async () => {
    // Arrange
    await s.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
    const admin = await s.genAddress("admin");
    const guardian = await s.genAddress("guardian");
    const lp = await s.genAddress("lp");
    const user = await s.genAddress("user");

    const [ptH, ytH, poolH, syBlendH] = await Promise.all([
      s.uploadWasm("pt_token.wasm"),
      s.uploadWasm("yt_token.wasm"),
      s.uploadWasm("yield_pool.wasm"),
      s.uploadWasm("sy_blend_wrapper.wasm"),
    ]);
    const factory = await s.deployWasm("market_factory.wasm");
    await must(s, factory, "initialize", [
      aAddr(admin), aAddr(guardian), aBytes32(ptH), aBytes32(ytH), aBytes32(poolH), aBytes32(syBlendH),
    ]);

    const usdc = await s.createSac("USDC", { admin });
    const blend = await s.deployWasm("mock_blend.wasm");
    await must(s, blend, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const slender = await s.deployWasm("mock_slender.wasm");
    await must(s, slender, "initialize", [aAddr(admin), aAddr(usdc), aI128(SCALAR_9)]);
    const sySl = await s.deployWasm("sy_slender_wrapper.wasm");
    await must(s, sySl, "initialize", [aAddr(admin), aAddr(usdc), aAddr(slender), aAddr(slender)]);

    const matBlend = T0 + 30 * DAY;
    const matSlender = T0 + 90 * DAY;

    const mBlend = await must<{ sy: string; pt: string; yt: string; pool: string }>(s, factory, "create_market", [
      aAddr(admin), aAddr(usdc), aAddr(blend), aU64(matBlend), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR),
    ]);

    const ptSl = await s.deployWasm("pt_token.wasm");
    const ytSl = await s.deployWasm("yt_token.wasm");
    const poolSl = await s.deployWasm("yield_pool.wasm");
    await must(s, ptSl, "initialize", [aAddr(admin), aAddr(poolSl), aStr("PT sUSDC"), aStr("PT-sUSDC-90D"), aU32(7), aU64(matSlender)]);
    await must(s, ytSl, "initialize", [aAddr(admin), aAddr(poolSl), aAddr(sySl), aStr("YT sUSDC"), aStr("YT-sUSDC-90D"), aU32(7), aU64(matSlender)]);
    await must(s, poolSl, "initialize", [aAddr(admin), aAddr(sySl), aAddr(ptSl), aAddr(ytSl), aU64(matSlender), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR)]);
    await must(s, factory, "register_market", [
      aAddr(admin), aAddr(poolSl), aAddr(sySl), aAddr(ptSl), aAddr(ytSl), aAddr(usdc), aU64(matSlender), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR),
    ]);

    // Seed both pools
    await s.sacMint(usdc, lp, 500_000_000_000n);
    await must(s, mBlend.sy, "deposit", [aAddr(lp), aAddr(lp), aI128(220_000_000_000n)]);
    await must(s, mBlend.pool, "mint_py", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aU64(matBlend)]);
    await must(s, mBlend.pool, "add_liquidity", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aI128(100_000_000_000n), aI128(1)]);

    await must(s, sySl, "deposit", [aAddr(lp), aAddr(lp), aI128(220_000_000_000n)]);
    await must(s, poolSl, "mint_py", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aU64(matSlender)]);
    await must(s, poolSl, "add_liquidity", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aI128(100_000_000_000n), aI128(1)]);

    // User gets PT in both Blend and Slender pools
    await s.sacMint(usdc, user, 20_000_000_000n);
    await must(s, mBlend.sy, "deposit", [aAddr(user), aAddr(user), aI128(10_000_000_000n)]);
    await must(s, mBlend.pool, "mint_py", [aAddr(user), aAddr(user), aI128(10_000_000_000n), aU64(matBlend)]);
    await must(s, sySl, "deposit", [aAddr(user), aAddr(user), aI128(10_000_000_000n)]);
    await must(s, poolSl, "mint_py", [aAddr(user), aAddr(user), aI128(10_000_000_000n), aU64(matSlender)]);

    // Guard 1: Unmatured source pool -> #8 MarketNotYetMatured
    expectContractError(
      await s.invoke(factory, "rollover_to_pt", [
        aAddr(user), aAddr(user), aAddr(mBlend.pool), aAddr(poolSl), aI128(1_000_000_000n), aI128(0), aU64(matSlender),
      ]),
      8,
      "MarketNotYetMatured"
    );

    // Advance past matBlend (30d), keep matSlender (90d) active
    await s.setLedger({ timestamp: matBlend + 100 });

    // Guard 2: Expired deadline -> #10 DeadlineExpired
    expectContractError(
      await s.invoke(factory, "rollover_to_pt", [
        aAddr(user), aAddr(user), aAddr(mBlend.pool), aAddr(poolSl), aI128(1_000_000_000n), aI128(0), aU64(matBlend + 99),
      ]),
      10,
      "DeadlineExpired"
    );

    // Guard 3: receiver == factory -> #15 IdenticalAddresses on both rollover_to_pt & rollover_to_py
    expectContractError(
      await s.invoke(factory, "rollover_to_pt", [
        aAddr(user), aAddr(factory), aAddr(mBlend.pool), aAddr(poolSl), aI128(1_000_000_000n), aI128(0), aU64(matSlender),
      ]),
      15,
      "IdenticalAddresses"
    );
    expectContractError(
      await s.invoke(factory, "rollover_to_py", [
        aAddr(user), aAddr(factory), aAddr(mBlend.pool), aAddr(poolSl), aI128(1_000_000_000n), aI128(0), aU64(matSlender),
      ]),
      15,
      "IdenticalAddresses"
    );

    // Act 1: Blend -> Slender cross-adapter rollover_to_pt & rollover_to_py
    const ptSlBefore = BigInt(await must<string>(s, ptSl, "balance", [aAddr(user)]));
    await must(s, factory, "rollover_to_pt", [
      aAddr(user), aAddr(user), aAddr(mBlend.pool), aAddr(poolSl), aI128(2_000_000_000n), aI128(1), aU64(matSlender),
    ]);
    expect(BigInt(await must<string>(s, ptSl, "balance", [aAddr(user)]))).toBeGreaterThan(ptSlBefore);

    const ytSlBefore = BigInt(await must<string>(s, ytSl, "balance", [aAddr(user)]));
    await must(s, factory, "rollover_to_py", [
      aAddr(user), aAddr(user), aAddr(mBlend.pool), aAddr(poolSl), aI128(2_000_000_000n), aI128(1), aU64(matSlender),
    ]);
    expect(BigInt(await must<string>(s, ytSl, "balance", [aAddr(user)]))).toBeGreaterThan(ytSlBefore);

    // Deploy a longer 180d Blend market so we can test Slender -> Blend after matSlender matures
    const matBlendLong = T0 + 180 * DAY;
    const mBlendLong = await must<{ sy: string; pt: string; yt: string; pool: string }>(s, factory, "create_market", [
      aAddr(admin), aAddr(usdc), aAddr(blend), aU64(matBlendLong), aI128(SCALAR_ROOT), aI128(INITIAL_ANCHOR),
    ]);
    await s.sacMint(usdc, lp, 220_000_000_000n);
    await must(s, mBlendLong.sy, "deposit", [aAddr(lp), aAddr(lp), aI128(220_000_000_000n)]);
    await must(s, mBlendLong.pool, "mint_py", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aU64(matBlendLong)]);
    await must(s, mBlendLong.pool, "add_liquidity", [aAddr(lp), aAddr(lp), aI128(120_000_000_000n), aI128(100_000_000_000n), aI128(1)]);

    // Advance past matSlender (90d)
    await s.setLedger({ timestamp: matSlender + 100 });

    // Guard 4: Already-matured target pool (mBlend) -> #7 MarketAlreadyMatured
    expectContractError(
      await s.invoke(factory, "rollover_to_pt", [
        aAddr(user), aAddr(user), aAddr(poolSl), aAddr(mBlend.pool), aI128(1_000_000_000n), aI128(0), aU64(matBlendLong),
      ]),
      7,
      "MarketAlreadyMatured"
    );

    // Act 2: Slender -> Blend cross-adapter rollover_to_pt & rollover_to_py
    const ptLongBefore = BigInt(await must<string>(s, mBlendLong.pt, "balance", [aAddr(user)]));
    await must(s, factory, "rollover_to_pt", [
      aAddr(user), aAddr(user), aAddr(poolSl), aAddr(mBlendLong.pool), aI128(2_000_000_000n), aI128(1), aU64(matBlendLong),
    ]);
    expect(BigInt(await must<string>(s, mBlendLong.pt, "balance", [aAddr(user)]))).toBeGreaterThan(ptLongBefore);

    const ytLongBefore = BigInt(await must<string>(s, mBlendLong.yt, "balance", [aAddr(user)]));
    await must(s, factory, "rollover_to_py", [
      aAddr(user), aAddr(user), aAddr(poolSl), aAddr(mBlendLong.pool), aI128(2_000_000_000n), aI128(1), aU64(matBlendLong),
    ]);
    expect(BigInt(await must<string>(s, mBlendLong.yt, "balance", [aAddr(user)]))).toBeGreaterThan(ytLongBefore);

    // Zero factory dust invariant across both cross-adapter rollovers
    expect(BigInt(await must<string>(s, mBlend.sy, "balance", [aAddr(factory)]))).toBe(0n);
    expect(BigInt(await must<string>(s, sySl, "balance", [aAddr(factory)]))).toBe(0n);
  });
});
