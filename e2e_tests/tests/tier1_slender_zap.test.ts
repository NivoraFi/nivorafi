// e2e_tests/tests/tier1_slender_zap.test.ts
// Tier 1: Genuine Soroban WASM E2E Happy-Path Tests for R3 Slender (F9) & R4 Zap-In (F10) (10 tests)

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
const INITIAL_ANCHOR = (105n * WAD) / 100n; // 1.05 WAD positive implied yield

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
const aU32 = (value: number): TypedArg => ({ type: "u32", value });
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

async function setupFactoryWithBlendMarket(
  session: SorobanRunnerSession,
  symbol: "USDC" | "native",
  days = 90
) {
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
  const u2 = await session.genAddress("u2");

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

  const asset = await session.createSac(
    symbol,
    symbol === "native" ? undefined : { admin }
  );
  const blend = await session.deployWasm("mock_blend.wasm", { var_name: "blend" });
  await mustInvoke(session, blend, "initialize", [
    aAddr(admin),
    aAddr(asset),
    aI128(SCALAR_9),
  ]);

  const maturity = T0 + days * DAY;
  const meta = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
    aAddr(admin),
    aAddr(asset),
    aAddr(blend),
    aU64(maturity),
    aI128(SCALAR_ROOT),
    aI128(INITIAL_ANCHOR),
  ]);

  // Seed pool with 120B PT + 100B SY (1.2:1 ratio)
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
  await mustInvoke(session, meta.sy, "deposit", [
    aAddr(lp),
    aAddr(lp),
    aI128(lpSeed),
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

  return { admin, guardian, lp, u1, u2, factory, asset, blend, meta, maturity };
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

describe("Tier 1: R3 Slender (F9) & R4 Zap-In (F10) Happy-Path Suite", () => {
  let session: SorobanRunnerSession;

  beforeAll(async () => {
    session = await SorobanRunnerSession.start();
  }, 120_000);

  afterAll(async () => {
    await session?.close();
  });

  // =========================================================================
  // F9: Slender (sUSDC) SY Adapter & Mock (5 tests)
  // =========================================================================
  describe("F9: Slender (sUSDC) SY Adapter & Mock", () => {
    test("F9-T1-1: initializes mock_slender and sy_slender_wrapper with sy-sUSDC metadata and SCALAR_9 rate", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const usdc = await session.createSac("USDC", { admin });
      const { sySlender } = await deploySlenderAndWrapper(session, admin, usdc);

      expect(await mustInvoke<string>(session, sySlender, "symbol")).toBe("sy-sUSDC");
      expect(await mustInvoke<string>(session, sySlender, "name")).toContain("USDC");
      expect(await mustInvoke<string>(session, sySlender, "asset")).toBe(usdc);
      expect(await mustInvoke<string>(session, sySlender, "exchange_rate")).toBe(
        String(SCALAR_9)
      );
      expect(await mustInvoke<number>(session, sySlender, "decimals")).toBe(
        await mustInvoke<number>(session, usdc, "decimals")
      );
    });

    test("F9-T1-2: deposit mints 1:1 sy-sUSDC shares at 1.0 exchange rate and tracks total_shares", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const u1 = await session.genAddress("u1");
      const usdc = await session.createSac("USDC", { admin });
      const { sySlender } = await deploySlenderAndWrapper(session, admin, usdc);

      const amount = 1_000_000_000n;
      await session.sacMint(usdc, u1, amount);
      const minted = await mustInvoke<string>(session, sySlender, "deposit", [
        aAddr(u1),
        aAddr(u1),
        aI128(amount),
      ]);

      expect(minted).toBe(String(amount));
      expect(await mustInvoke<string>(session, sySlender, "balance", [aAddr(u1)])).toBe(
        String(amount)
      );
      expect(await mustInvoke<string>(session, sySlender, "total_shares")).toBe(
        String(amount)
      );
      expect(await mustInvoke<string>(session, sySlender, "total_supply")).toBe(
        String(amount)
      );
      expect(await mustInvoke<string>(session, usdc, "balance", [aAddr(u1)])).toBe("0");
    });

    test("F9-T1-3: Slender yield accrual (1.0 -> 1.15) scales deposit shares and redeem payout accurately", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const u1 = await session.genAddress("u1");
      const u2 = await session.genAddress("u2");
      const usdc = await session.createSac("USDC", { admin });
      const { slender, sySlender } = await deploySlenderAndWrapper(session, admin, usdc);

      await session.sacMint(usdc, u1, 1_000_000_000n);
      await mustInvoke(session, sySlender, "deposit", [
        aAddr(u1),
        aAddr(u1),
        aI128(1_000_000_000n),
      ]);

      await setSlenderRate(session, slender, 1_150_000_000n);
      await session.sacMint(usdc, slender, 150_000_000n);
      expect(await mustInvoke<string>(session, sySlender, "exchange_rate")).toBe(
        "1150000000"
      );

      await session.sacMint(usdc, u2, 1_150_000_000n);
      const u2Shares = await mustInvoke<string>(session, sySlender, "deposit", [
        aAddr(u2),
        aAddr(u2),
        aI128(1_150_000_000n),
      ]);
      expect(u2Shares).toBe("1000000000");

      const u1Redeemed = await mustInvoke<string>(session, sySlender, "redeem", [
        aAddr(u1),
        aAddr(u1),
        aI128(1_000_000_000n),
      ]);
      expect(u1Redeemed).toBe("1150000000");
      expect(await mustInvoke<string>(session, usdc, "balance", [aAddr(u1)])).toBe(
        "1150000000"
      );
      expect(await mustInvoke<string>(session, sySlender, "balance", [aAddr(u1)])).toBe("0");
    });

    test("F9-T1-4: sy_slender_wrapper SEP-41 transfer/approve/transfer_from/burn and redeem_to_btoken conserve supply", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const u1 = await session.genAddress("u1");
      const u2 = await session.genAddress("u2");
      const spender = await session.genAddress("spender");
      const receiver = await session.genAddress("receiver");
      const usdc = await session.createSac("USDC", { admin });
      const { sySlender } = await deploySlenderAndWrapper(session, admin, usdc);

      await session.sacMint(usdc, u1, 1_000_000_000n);
      await mustInvoke(session, sySlender, "deposit", [
        aAddr(u1),
        aAddr(u1),
        aI128(1_000_000_000n),
      ]);

      await mustInvoke(session, sySlender, "transfer", [
        aAddr(u1),
        aAddr(u2),
        aI128(300_000_000n),
      ]);
      await mustInvoke(session, sySlender, "approve", [
        aAddr(u1),
        aAddr(spender),
        aI128(200_000_000n),
        aU32(1100),
      ]);
      await mustInvoke(session, sySlender, "transfer_from", [
        aAddr(spender),
        aAddr(u1),
        aAddr(u2),
        aI128(200_000_000n),
      ]);
      expect(
        await mustInvoke<string>(session, sySlender, "allowance", [
          aAddr(u1),
          aAddr(spender),
        ])
      ).toBe("0");

      await mustInvoke(session, sySlender, "burn", [aAddr(u2), aI128(100_000_000n)]);
      const btokOut = await mustInvoke<string>(session, sySlender, "redeem_to_btoken", [
        aAddr(u1),
        aAddr(receiver),
        aI128(500_000_000n),
      ]);
      expect(btokOut).toBe("500000000");

      expect(await mustInvoke<string>(session, sySlender, "balance", [aAddr(u1)])).toBe("0");
      expect(await mustInvoke<string>(session, sySlender, "balance", [aAddr(u2)])).toBe(
        "400000000"
      );
      expect(await mustInvoke<string>(session, sySlender, "total_shares")).toBe("400000000");
      expect(await mustInvoke<string>(session, sySlender, "total_supply")).toBe("400000000");
    });

    test("F9-T1-5: Blend (sy-bUSDC) and Slender (sy-sUSDC) USDC markets coexist in market_factory with full pool lifecycle", async () => {
      await session.reset({ timestamp: T0, sequence: 100 });
      const admin = await session.genAddress("admin");
      const guardian = await session.genAddress("guardian");
      const lp = await session.genAddress("lp");
      const trader = await session.genAddress("trader");

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
      const mBlend = await mustInvoke<MarketMetadata>(session, factory, "create_market", [
        aAddr(admin),
        aAddr(usdc),
        aAddr(blend),
        aU64(T0 + 90 * DAY),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      // Deploy Slender SY + pool + PT + YT and register second USDC market on distinct maturity
      const { slender, sySlender } = await deploySlenderAndWrapper(session, admin, usdc);
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
        aI128(INITIAL_ANCHOR),
      ]);

      const mSlender = await mustInvoke<MarketMetadata>(session, factory, "register_market", [
        aAddr(admin),
        aAddr(slPool),
        aAddr(sySlender),
        aAddr(slPt),
        aAddr(slYt),
        aAddr(usdc),
        aU64(slMat),
        aI128(SCALAR_ROOT),
        aI128(INITIAL_ANCHOR),
      ]);

      expect(await mustInvoke<number>(session, factory, "market_count")).toBe(2);
      expect(mBlend.sy).not.toBe(mSlender.sy);
      expect(mBlend.asset).toBe(usdc);
      expect(mSlender.asset).toBe(usdc);
      const lookupSl = await mustInvoke<MarketMetadata | null>(
        session,
        factory,
        "get_market_by_pool",
        [aAddr(slPool)]
      );
      expect(lookupSl?.sy).toBe(sySlender);

      // Exercise full Slender pool lifecycle: mint_py, add_liquidity, swap_exact_sy_for_pt, yield claim
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

      await session.sacMint(usdc, trader, 10_000_000_000n);
      await mustInvoke(session, sySlender, "deposit", [
        aAddr(trader),
        aAddr(trader),
        aI128(10_000_000_000n),
      ]);
      const [ptOut] = await mustInvoke<[string, string]>(
        session,
        slPool,
        "swap_exact_sy_for_pt",
        [aAddr(trader), aAddr(trader), aI128(5_000_000_000n), aI128(1), aU64(slMat)]
      );
      expect(BigInt(ptOut)).toBeGreaterThan(0n);

      await setSlenderRate(session, slender, 1_100_000_000n);
      const claimed = BigInt(
        await mustInvoke<string>(session, slPool, "claim_yield", [
          aAddr(lp),
          aAddr(lp),
        ])
      );
      expect(claimed).toBeGreaterThan(0n);
    });
  });

  // =========================================================================
  // F10: Single-Tx Zap-In On-Chain Router (5 tests)
  // =========================================================================
  describe("F10: Single-Tx Zap-In Router (PT / YT / LP)", () => {
    test("F10-T1-1: zap_in_pt converts USDC -> SY -> PT in one call with zero factory dust", async () => {
      const { u1, factory, asset, meta } = await setupFactoryWithBlendMarket(
        session,
        "USDC"
      );
      const amt = 100_000_000n;
      await session.sacMint(asset, u1, amt);

      const ptOut = await mustInvoke<string>(session, factory, "zap_in_pt", [
        aAddr(u1),
        aAddr(u1),
        aAddr(meta.pool),
        aI128(amt),
        aI128(1),
        aU64(T0 + 60),
      ]);

      expect(BigInt(ptOut)).toBeGreaterThanOrEqual(amt);
      expect(await mustInvoke<string>(session, meta.pt, "balance", [aAddr(u1)])).toBe(ptOut);
      expect(await mustInvoke<string>(session, asset, "balance", [aAddr(u1)])).toBe("0");
      await assertFactoryZeroDust(session, factory, [
        asset,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);
    });

    test("F10-T1-2: zap_in_yt converts USDC -> SY -> YT in one call with zero factory dust", async () => {
      const { u1, factory, asset, meta } = await setupFactoryWithBlendMarket(
        session,
        "USDC"
      );
      const amt = 100_000_000n;
      await session.sacMint(asset, u1, amt);

      const ytOut = await mustInvoke<string>(session, factory, "zap_in_yt", [
        aAddr(u1),
        aAddr(u1),
        aAddr(meta.pool),
        aI128(amt),
        aI128(1),
        aU64(T0 + 60),
      ]);

      expect(BigInt(ytOut)).toBeGreaterThan(0n);
      expect(await mustInvoke<string>(session, meta.yt, "balance", [aAddr(u1)])).toBe(ytOut);
      expect(await mustInvoke<string>(session, asset, "balance", [aAddr(u1)])).toBe("0");
      await assertFactoryZeroDust(session, factory, [
        asset,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);
    });

    test("F10-T1-3: zap_in_lp converts USDC -> LP shares in one call with zero factory dust", async () => {
      const { u1, factory, asset, meta } = await setupFactoryWithBlendMarket(
        session,
        "USDC"
      );
      const amt = 100_000_000n;
      await session.sacMint(asset, u1, amt);

      const [lpOut, residual] = await mustInvoke<[string, string]>(
        session,
        factory,
        "zap_in_lp",
        [
          aAddr(u1),
          aAddr(u1),
          aAddr(meta.pool),
          aI128(amt),
          aI128(1),
          aU64(T0 + 60),
        ]
      );

      expect(BigInt(lpOut)).toBeGreaterThanOrEqual(1n);
      expect(BigInt(residual)).toBeGreaterThanOrEqual(0n);
      expect(await mustInvoke<string>(session, meta.pool, "balance", [aAddr(u1)])).toBe(lpOut);
      expect(await mustInvoke<string>(session, asset, "balance", [aAddr(u1)])).toBe("0");
      await assertFactoryZeroDust(session, factory, [
        asset,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);
    });

    test("F10-T1-4: zap_in_pt/yt/lp support native XLM market with distinct receiver and zero dust", async () => {
      const { u1, u2, factory, asset, meta } = await setupFactoryWithBlendMarket(
        session,
        "native"
      );
      const funder = await session.genAccount("xlm_user_funder", "1000000000000");
      const totalXlm = 300_000_000n;
      await mustInvoke(session, asset, "transfer", [
        aAddr(funder),
        aAddr(u1),
        aI128(totalXlm),
      ]);

      const ptOut = await mustInvoke<string>(session, factory, "zap_in_pt", [
        aAddr(u1),
        aAddr(u2),
        aAddr(meta.pool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      const ytOut = await mustInvoke<string>(session, factory, "zap_in_yt", [
        aAddr(u1),
        aAddr(u2),
        aAddr(meta.pool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      const [lpOut] = await mustInvoke<[string, string]>(session, factory, "zap_in_lp", [
        aAddr(u1),
        aAddr(u2),
        aAddr(meta.pool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);

      expect(BigInt(ptOut)).toBeGreaterThan(0n);
      expect(BigInt(ytOut)).toBeGreaterThan(0n);
      expect(BigInt(lpOut)).toBeGreaterThan(0n);
      expect(await mustInvoke<string>(session, asset, "balance", [aAddr(u1)])).toBe("0");
      expect(await mustInvoke<string>(session, meta.pt, "balance", [aAddr(u2)])).toBe(ptOut);
      expect(await mustInvoke<string>(session, meta.yt, "balance", [aAddr(u2)])).toBe(ytOut);
      expect(await mustInvoke<string>(session, meta.pool, "balance", [aAddr(u2)])).toBe(lpOut);
      await assertFactoryZeroDust(session, factory, [
        asset,
        meta.sy,
        meta.pt,
        meta.yt,
        meta.pool,
      ]);
    });

    test("F10-T1-5: zap_in_pt/yt/lp route cleanly through Slender (sy-sUSDC) market with zero dust", async () => {
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
      const { sySlender } = await deploySlenderAndWrapper(session, admin, usdc);
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
        aI128(INITIAL_ANCHOR),
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
        aI128(INITIAL_ANCHOR),
      ]);

      // Seed Slender pool
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

      const sySharesBefore = BigInt(
        await mustInvoke<string>(session, sySlender, "total_shares")
      );
      await session.sacMint(usdc, u1, 300_000_000n);

      const ptOut = await mustInvoke<string>(session, factory, "zap_in_pt", [
        aAddr(u1),
        aAddr(u1),
        aAddr(slPool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      const ytOut = await mustInvoke<string>(session, factory, "zap_in_yt", [
        aAddr(u1),
        aAddr(u1),
        aAddr(slPool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);
      const [lpOut] = await mustInvoke<[string, string]>(session, factory, "zap_in_lp", [
        aAddr(u1),
        aAddr(u1),
        aAddr(slPool),
        aI128(100_000_000n),
        aI128(1),
        aU64(T0 + 60),
      ]);

      expect(BigInt(ptOut)).toBeGreaterThan(0n);
      expect(BigInt(ytOut)).toBeGreaterThan(0n);
      expect(BigInt(lpOut)).toBeGreaterThan(0n);
      const sySharesAfter = BigInt(
        await mustInvoke<string>(session, sySlender, "total_shares")
      );
      expect(sySharesAfter - sySharesBefore).toBe(300_000_000n);
      await assertFactoryZeroDust(session, factory, [
        usdc,
        sySlender,
        slPt,
        slYt,
        slPool,
      ]);
    });
  });
});
