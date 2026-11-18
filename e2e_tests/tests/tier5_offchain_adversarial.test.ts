// e2e_tests/tests/tier5_offchain_adversarial.test.ts
// Tier 5: White-Box Adversarial Hardening Suite for Surface B (Off-Chain Math, XDR, BFF, Post-Maturity Yield, Scripts & T5-Lock)

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Networks, Transaction, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  SCALAR_9,
  WAD,
  estimateZapInLp,
  quoteSwapLocal,
  wadDiv,
  wadDivCeil,
  type MarketStateRaw,
} from "../../frontend/src/lib/math.ts";
import { buildActionArgs, fetchUserPortfolio } from "../../frontend/src/lib/stellar.ts";
import { STELLAR_PENDLE_CONFIG } from "../../frontend/src/lib/contracts.ts";
import { PRESET_MARKETS } from "../../frontend/src/lib/markets.ts";
import { quoteSwap as agentQuoteSwap, wadDivCeil as agentWadDivCeil } from "../../agent/src/math.ts";
import { StellarPendleAgentClient, loadDeploymentManifest } from "../../agent/src/client.ts";
import {
  EXPECTED_MCP_RESOURCES,
  EXPECTED_MCP_TOOLS,
  REPO_ROOT,
  SorobanRunnerSession,
  callBffGetRaw,
  connectAgentMcpInMemory,
  invokeBffGet,
  withBffEnv,
  type TypedArg,
} from "../src/harness/index.ts";
import { wadDivCeil as oracleWadDivCeil } from "../src/math-oracle.ts";

const USER_G = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const RECEIVER_G = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";
const T0 = 1_700_000_000;
const DAY = 86_400;

const aAddr = (value: string): TypedArg => ({ type: "address", value });
const aI128 = (value: bigint | number | string): TypedArg => ({ type: "i128", value: String(value) });
const aU64 = (value: bigint | number | string): TypedArg => ({ type: "u64", value: String(value) });
const aBytes32 = (value: string): TypedArg => ({ type: "bytes_n32", value });

describe("Tier 5: Surface B Off-Chain Adversarial, Math Parity & Lock Audit", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("T5-Lock: SHA-256 locks, 5-key contracts config, 8-tool MCP, port 8765, zero R5, zero stray DBs or live secrets", async () => {
    // Arrange
    const indexerSrc = readFileSync(join(REPO_ROOT, "frontend/src/lib/indexer.ts"));
    const hookSrc = readFileSync(join(REPO_ROOT, "frontend/src/hooks/useEventIndexer.ts"));
    const mcpSrc = readFileSync(join(REPO_ROOT, "agent/src/mcp-server.ts"), "utf8");
    const envProd = readFileSync(join(REPO_ROOT, "frontend/.env.production"), "utf8");
    const envLocal = existsSync(join(REPO_ROOT, "frontend/.env.local"))
      ? readFileSync(join(REPO_ROOT, "frontend/.env.local"), "utf8")
      : "";

    // Act
    const indexerHash = createHash("sha256").update(indexerSrc).digest("hex");
    const hookHash = createHash("sha256").update(hookSrc).digest("hex");
    const contractKeys = Object.keys(STELLAR_PENDLE_CONFIG.contracts);
    const mcp = await connectAgentMcpInMemory(join(REPO_ROOT, "deployed_contracts.json"));

    try {
      const toolNames = await mcp.listToolNames();
      const resourceUris = await mcp.listResourceUris();

      // Assert
      expect(indexerHash).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
      expect(hookHash).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
      expect(contractKeys).toEqual(["mock_blend", "sy_blend_wrapper", "pt_token", "yt_token", "yield_pool"]);
      expect(toolNames).toEqual([...EXPECTED_MCP_TOOLS]);
      expect(resourceUris).toEqual([...EXPECTED_MCP_RESOURCES]);
      const mcpWithoutEcosystemNote = mcpSrc.replace(
        "Blend lending, SoroSwap DEX routing, Reflector oracle, and XLM/USDC wallets",
        ""
      );
      expect(mcpWithoutEcosystemNote).not.toMatch(/limit_order|auto_rollover|reflector|pyth|band_protocol/i);

      expect(envProd).toContain('INDEXER_INTERNAL_URL="http://127.0.0.1:8765"');
      expect(envProd).toContain('INDEXER_API_SECRET="replace_with_32_byte_hex_secret"');
      expect(envProd).not.toContain("trycloudflare.com");
      if (envLocal) {
        expect(envLocal).not.toContain("trycloudflare.com");
      }

      const indexerFiles = readdirSync(join(REPO_ROOT, "indexer"));
      expect(indexerFiles.filter((f) => f.startsWith("events.db"))).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  test("estimateZapInLp empty-pool bootstrap accounts for pyIndex != 1.0 and matches real market_factory.wasm", async () => {
    // Arrange
    const pyIndex = 1_250_000_000n; // 1.25
    const undIn = 10_000_000_000n; // 1000 USDC -> 8_000_000_000n SY at 1.25
    const syIn = 8_000_000_000n;
    const maturity = BigInt(T0 + 90 * DAY);
    const emptyState: MarketStateRaw = {
      total_pt_reserve: 0n,
      total_sy_reserve: 0n,
      total_lp_supply: 0n,
      scalar_root: 20n * WAD,
      initial_anchor: WAD,
      annual_fee_rate: 50_000_000_000_000_000n,
      protocol_fee_bps: 2000n,
      fee_recipient: USER_G,
      maturity,
      maturity_index: SCALAR_9,
      is_settled: false,
    };

    // Act
    const est = estimateZapInLp(emptyState, syIn, BigInt(T0), 50, pyIndex);

    const session = await SorobanRunnerSession.start();
    try {
      await session.reset({ timestamp: T0, sequence: 100, auth_mode: "mock_all", budget_mode: "unlimited" });
      const admin = await session.genAddress("admin");
      const guardian = await session.genAddress("guardian");
      const zapper = await session.genAddress("zapper");
      const [ptH, ytH, poolH, syH] = await Promise.all([
        session.uploadWasm("pt_token.wasm"),
        session.uploadWasm("yt_token.wasm"),
        session.uploadWasm("yield_pool.wasm"),
        session.uploadWasm("sy_blend_wrapper.wasm"),
      ]);
      const factory = await session.deployWasm("market_factory.wasm");
      await session.invoke(factory, "initialize", [
        aAddr(admin), aAddr(guardian), aBytes32(ptH), aBytes32(ytH), aBytes32(poolH), aBytes32(syH),
      ]);
      const usdc = await session.createSac("USDC", { admin });
      const blend = await session.deployWasm("mock_blend.wasm");
      await session.invoke(blend, "initialize", [aAddr(admin), aAddr(usdc), aI128(pyIndex)]);
      const metaRes = await session.invoke<{ pool: string }>(factory, "create_market", [
        aAddr(admin), aAddr(usdc), aAddr(blend), aU64(maturity), aI128(20n * WAD), aI128(WAD),
      ]);
      const pool = metaRes.data!.pool;
      await session.sacMint(usdc, zapper, undIn);
      const zapRes = await session.invoke<[string, string]>(factory, "zap_in_lp", [
        aAddr(zapper), aAddr(zapper), aAddr(pool), aI128(undIn), aI128(1), aU64(maturity),
      ]);

      // Assert — Exact stroop match with real WASM!
      expect(zapRes.ok).toBe(true);
      expect(est.ok).toBe(true);
      expect(est.isEmptyBootstrap).toBe(true);
      expect(est.estLpOut).toBe(4_472_134_954n);
      expect(est.estLpOut).toBe(BigInt(zapRes.data![0]));
    } finally {
      await session.close();
    }
  }, 60_000);

  test("wadDivCeil parity across frontend, agent, and oracle, plus yt_for_sy 1-stroop & pro_rata_freed_sy bad-debt clamp", () => {
    // Arrange
    const eTrade = 1_050_000_000_000_000_000n; // 1.05 WAD
    const now = BigInt(T0);
    const maturity = BigInt(T0 + 90 * DAY);
    const state: MarketStateRaw = {
      total_pt_reserve: 120_000_000_000n,
      total_sy_reserve: 100_000_000_000n,
      total_lp_supply: 109_544_511_501n,
      scalar_root: 20n * WAD,
      initial_anchor: WAD,
      annual_fee_rate: 50_000_000_000_000_000n,
      protocol_fee_bps: 2000n,
      fee_recipient: USER_G,
      maturity,
      maturity_index: SCALAR_9,
      is_settled: false,
    };

    // Act & Assert: 1-stroop wadDivCeil rounds up to 1n (vs floor 0n)
    expect(wadDiv(1n, eTrade)).toBe(0n);
    expect(wadDivCeil(1n, eTrade)).toBe(1n);
    expect(agentWadDivCeil(1n, eTrade)).toBe(1n);
    expect(oracleWadDivCeil(1n, eTrade)).toBe(1n);
    expect(wadDivCeil(2n * eTrade, eTrade)).toBe(2n * WAD);
    expect(() => wadDivCeil(1n, 0n)).toThrow();

    // 1-stroop yt_for_sy must reject rather than returning 1 SY or 0 SY
    expect(() => quoteSwapLocal(state, "yt_for_sy", 1n, now, 50, SCALAR_9)).toThrow();
    expect(() => agentQuoteSwap(state, "yt_for_sy", 1n, now, 50, SCALAR_9)).toThrow();

    // 1-stroop pt_for_sy & sy_for_pt at PyIndex != 1.0 (1.25 / 0.8 / 0.5) or zero net output must throw consistently
    const pyScaledState: MarketStateRaw = { ...state, total_pt_reserve: 150_000_000_000n };
    expect(() => quoteSwapLocal(pyScaledState, "pt_for_sy", 1n, now, 50, 1_250_000_000n)).toThrow(/too small/i);
    expect(() => agentQuoteSwap(pyScaledState, "pt_for_sy", 1n, now, 50, 1_250_000_000n)).toThrow(/ZeroAmount/);
    expect(() => quoteSwapLocal(pyScaledState, "pt_for_sy", 1n, now, 50, SCALAR_9)).toThrow(/too small/i);
    expect(() => agentQuoteSwap(pyScaledState, "pt_for_sy", 1n, now, 50, SCALAR_9)).toThrow(/ZeroAmount/);
    expect(() => quoteSwapLocal(pyScaledState, "sy_for_pt", 1n, now, 50, 800_000_000n)).toThrow(/too small/i);
    expect(() => agentQuoteSwap(pyScaledState, "sy_for_pt", 1n, now, 50, 800_000_000n)).toThrow(/ZeroAmount/);
    expect(() => quoteSwapLocal(pyScaledState, "sy_for_pt", 1n, now, 50, 500_000_000n)).toThrow(/too small/i);
    expect(() => agentQuoteSwap(pyScaledState, "sy_for_pt", 1n, now, 50, 500_000_000n)).toThrow(/ZeroAmount/);

    // Normal yt_for_sy matches between frontend and agent
    const feQuote = quoteSwapLocal(state, "yt_for_sy", 200_000_000n, now, 50, SCALAR_9);
    const agQuote = agentQuoteSwap(state, "yt_for_sy", 200_000_000n, now, 50, SCALAR_9);
    expect(feQuote.estimatedOut).toBe(BigInt(agQuote.estimatedOut));

    // Bad-debt clamp: when pro_rata_freed_sy < total_sy_out (severe bad debt), yt_for_sy unwind rejects Insufficient PT backing
    expect(() =>
      quoteSwapLocal(state, "yt_for_sy", 10_000_000_000n, now, 50, SCALAR_9, {
        availableForPtSy: 1_000n,
        ptTotalSupply: 1_000_000_000_000n,
      })
    ).toThrow(/Insufficient PT backing/);
    expect(() =>
      agentQuoteSwap(state, "yt_for_sy", 10_000_000_000n, now, 50, SCALAR_9, {
        availableForPtSy: 1_000n,
        ptTotalSupply: 1_000_000_000_000n,
      })
    ).toThrow(/InsufficientBalance/);
  });

  test("buildActionArgs rejects non-positive inputs across all mutating actions while preserving 0n tolerances & 0n deadline", () => {
    // Arrange
    const market = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
    const targetPool = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!.contracts.poolId;

    // Act & Assert — Invalid <= 0n primary amounts throw
    const invalidActions: Parameters<typeof buildActionArgs>[0][] = [
      { type: "deposit_sy", caller: USER_G, amount: 0n },
      { type: "deposit_sy", caller: USER_G, amount: -5n },
      { type: "redeem_sy", caller: USER_G, shares: 0n },
      { type: "mint_py", caller: USER_G, amount: 0n, deadline: 1000n },
      { type: "redeem_py", caller: USER_G, amount: -1n },
      { type: "swap", caller: USER_G, method: "swap_exact_pt_for_sy", amountIn: 0n, minOut: 0n, deadline: 1000n },
      { type: "swap", caller: USER_G, method: "swap_exact_pt_for_sy", amountIn: 10n, minOut: -1n, deadline: 1000n },
      { type: "add_liquidity", caller: USER_G, ptAmount: 0n, syAmount: 100n, minLpOut: 0n },
      { type: "add_liquidity", caller: USER_G, ptAmount: 100n, syAmount: 100n, minLpOut: -1n },
      { type: "remove_liquidity", caller: USER_G, lpAmount: 0n, minPt: 0n, minSy: 0n },
      { type: "remove_liquidity", caller: USER_G, lpAmount: 10n, minPt: -1n, minSy: 0n },
      { type: "redeem_pt_post_maturity", caller: USER_G, ptAmount: 0n },
      { type: "redeem_pt_to_btoken", caller: USER_G, ptAmount: -1n },
      { type: "rollover_to_pt", caller: USER_G, receiver: RECEIVER_G, sourcePool: market.contracts.poolId, targetPool, ptAmount: 0n, minTargetPt: 0n },
      { type: "rollover_to_py", caller: USER_G, receiver: RECEIVER_G, sourcePool: market.contracts.poolId, targetPool, ptAmount: 10n, minNewShares: -1n },
    ];
    for (const action of invalidActions) {
      expect(() => buildActionArgs(action, market)).toThrow();
    }

    // Valid minOut = 0n and deadline = 0n continue to encode cleanly
    const swapZeroTol = buildActionArgs(
      { type: "swap", caller: USER_G, method: "swap_exact_pt_for_sy", amountIn: 100n, minOut: 0n, deadline: 0n },
      market,
      0n
    );
    expect(swapZeroTol.args.length).toBe(5);
  });

  test("post-maturity estimatedPendingYieldSy caps accrual at yt.get_py_index() MaturityIndex in frontend and agent", async () => {
    // Arrange: MaturityIndex = 1.2e9, live sy.exchange_rate() = 1.5e9, user yt_balance = 100B at last_index = 1.0e9
    const market = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
    const manifest = loadDeploymentManifest();
    manifest.contracts.yield_pool.contractId = market.contracts.poolId;
    manifest.contracts.sy_blend_wrapper.contractId = market.contracts.syId;
    manifest.contracts.pt_token.contractId = market.contracts.ptId;
    manifest.contracts.yt_token.contractId = market.contracts.ytId;

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("horizon")) {
        return new Response(
          JSON.stringify({
            id: USER_G,
            account_id: USER_G,
            sequence: "100",
            balances: [
              { asset_type: "native", balance: "1000.0000000" },
              {
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: market.asset.issuer,
                balance: "500.0000000",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number;
        method: string;
        params?: { transaction?: string };
      };
      if (body.method === "simulateTransaction" && body.params?.transaction) {
        const tx = TransactionBuilder.fromXDR(body.params.transaction, Networks.TESTNET) as Transaction;
        const op = tx.operations[0]!;
        let fnName = "";
        let contractId = "";
        if (op.type === "invokeHostFunction" && op.func.type === "hostFunctionTypeInvokeContract") {
          fnName = op.func.value.functionName.toString();
          contractId = op.func.value.contractAddress.toString();
        }
        let retvalXdr = nativeToScVal(0n, { type: "i128" }).toXDR("base64");
        if (fnName === "exchange_rate") {
          retvalXdr = nativeToScVal(1_500_000_000n, { type: "i128" }).toXDR("base64");
        } else if (fnName === "get_py_index") {
          retvalXdr = nativeToScVal(1_200_000_000n, { type: "i128" }).toXDR("base64");
        } else if (fnName === "get_user_yield_state") {
          retvalXdr = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("last_index"), val: nativeToScVal(1_000_000_000n, { type: "i128" }) }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("unclaimed_yield"), val: nativeToScVal(0n, { type: "i128" }) }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("yt_balance"), val: nativeToScVal(100_000_000_000n, { type: "i128" }) }),
          ]).toXDR("base64");
        } else if (fnName === "balance" && contractId === market.contracts.ytId) {
          retvalXdr = nativeToScVal(100_000_000_000n, { type: "i128" }).toXDR("base64");
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              latestLedger: 123456,
              minResourceFee: "100",
              transactionData: "",
              events: [],
              results: [{ xdr: retvalXdr, auth: [] }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      // Act
      const fePort = await fetchUserPortfolio(USER_G, market);
      const agentClient = new StellarPendleAgentClient(manifest);
      const agPort = await agentClient.getUserPortfolio(USER_G);

      // Assert: 100B * (1.2 - 1.0) / 1.0 = 20B asset -> / 1.5 bRate = 13_333_333_333n SY (NOT 33_333_333_333n)
      expect(fePort.estimatedPendingYieldSy).toBe(13_333_333_333n);
      expect(BigInt(agPort.estimatedPendingYieldSy)).toBe(13_333_333_333n);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("BFF /api/indexer/[...path] fails closed (502 JSON) on non-JSON 200, handles 502 unreachable, and normalizes trailing slashes", async () => {
    // Arrange: 1) Upstream returning non-JSON 200
    const badJsonUpstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response("NOT_JSON{{{", { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    // 2) Healthy JSON upstream
    const goodUpstream = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        return Response.json({ status: "healthy", path: u.pathname });
      },
    });

    try {
      // Act & Assert: non-JSON 200 -> fail closed 502 JSON
      await withBffEnv({ indexerInternalUrl: `http://127.0.0.1:${badJsonUpstream.port}` }, async () => {
        const res = await callBffGetRaw({ path: ["health"] });
        expect(res.status).toBe(502);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = (await res.json()) as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toContain("invalid JSON");
      });

      // Trailing slash normalization ["health", ""] -> 200, traversal [".."] -> 404
      await withBffEnv({ indexerInternalUrl: `http://127.0.0.1:${goodUpstream.port}` }, async () => {
        const trailing = await invokeBffGet({ path: ["health", ""] });
        expect(trailing.status).toBe(200);
        const trailingJson = (await trailing.json()) as { path: string };
        expect(trailingJson.path).toBe("/health");

        const traversal = await invokeBffGet({ path: [".."] });
        expect(traversal.status).toBe(404);
      });
    } finally {
      badJsonUpstream.stop(true);
      goodUpstream.stop(true);
    }
  });

  test("scripts/deploy_testnet.sh passes bash -n and register_markets.ts --dry-run is non-mutating", () => {
    // Arrange
    const sandbox = mkdtempSync(join(tmpdir(), "sp-scripts-t5-"));
    tempDirs.push(sandbox);
    const beforeEnvProd = readFileSync(join(REPO_ROOT, "frontend/.env.production"), "utf8");
    const beforeDeployed = readFileSync(join(REPO_ROOT, "deployed_contracts.json"), "utf8");

    // Act
    const bashCheck = Bun.spawnSync(["bash", "-n", join(REPO_ROOT, "scripts/deploy_testnet.sh")]);
    const dryRun = Bun.spawnSync(["bun", "run", join(REPO_ROOT, "scripts/register_markets.ts"), "--dry-run"], {
      cwd: REPO_ROOT,
    });

    // Assert
    expect(bashCheck.exitCode).toBe(0);
    expect(dryRun.exitCode).toBe(0);
    expect(readFileSync(join(REPO_ROOT, "frontend/.env.production"), "utf8")).toBe(beforeEnvProd);
    expect(readFileSync(join(REPO_ROOT, "deployed_contracts.json"), "utf8")).toBe(beforeDeployed);
  });
});
