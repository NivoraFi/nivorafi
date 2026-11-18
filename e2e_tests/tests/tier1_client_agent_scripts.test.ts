// e2e_tests/tests/tier1_client_agent_scripts.test.ts
// Tier 1: Opaque-Box Feature Coverage for F11 (Client, UI, Agent SDK, Registry) & R5 (Out-of-Scope Exclusions)

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Keypair, SorobanDataBuilder, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import {
  AGENT_DIR,
  CONTRACTS_DIR,
  DEPLOYED_CONTRACTS_PATH,
  EXPECTED_MCP_RESOURCES,
  EXPECTED_MCP_TOOLS,
  FRONTEND_DIR,
  INDEXER_DIR,
  React,
  SCRIPTS_DIR,
  act,
  connectAgentMcpInMemory,
  connectAgentMcpStdio,
  decodeUnsignedInvokeContractXdr,
  inspectScValArgs,
  invokeBffGet,
  mountFrontendDom,
  scanR5OutOfScopeSymbols,
  verifyContractsConfigLock,
  verifyLockedSha256,
} from "../src/harness/index.ts";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import { PRESET_MARKETS, type MarketDefinition } from "@/lib/markets";
import {
  buildActionArgs,
  getFriendlyActionName,
  type LiveMarketSnapshot,
  type LiveUserPortfolio,
  type ProtocolAction,
} from "@/lib/stellar";
import { WalletProvider } from "@/context/WalletProvider";
import { MarketProvider } from "@/context/MarketContext";
import { TradingDesk } from "@/components/trading/TradingDesk";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { LiquidityCard } from "@/components/trading/LiquidityCard";
import { CONTRACT_CATALOG, MARKETS } from "../../indexer/index.ts";
import { StellarPendleAgentClient } from "../../agent/src/client.ts";
import type { DeploymentManifest, SwapDirection } from "../../agent/src/types.ts";

const TEST_CALLER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const TEST_RECEIVER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const EXPLICIT_DEADLINE = 1_900_000_000n;
const C_ADDR_RE = /^C[A-Z2-7]{55}$/;

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
  const futureMaturity = BigInt(nowSec + 90 * 86_400);
  return {
    state: {
      total_pt_reserve: 80_000_0000000n,
      total_sy_reserve: 40_000_0000000n,
      total_lp_supply: 56_568_5424949n,
      scalar_root: 8_000_000_000_000_000_000n,
      initial_anchor: 1_000_000_000_000_000_000n,
      annual_fee_rate: 50_000_000_000_000_000n,
      protocol_fee_bps: 2000n,
      fee_recipient: TEST_CALLER,
      maturity: futureMaturity,
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
    address: TEST_CALLER,
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
            id: "sim-e2e-1",
            latestLedger: 100,
            minResourceFee: "50000",
            transactionData: new SorobanDataBuilder().build().toXDR("base64"),
            results: [
              {
                auth: [],
                xdr: xdr.ScVal.scvVoid().toXDR("base64"),
              },
            ],
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

function walkSourceFiles(root: string): string[] {
  const results: string[] = [];
  if (!existsSync(root)) return results;
  const skipDirs = new Set(["node_modules", ".next", "target", "dist", "__tests__", "e2e"]);
  const exts = new Set([".rs", ".ts", ".tsx", ".js", ".mjs"]);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        if (/\.test\.[jt]sx?$/.test(entry) || /\.spec\.[jt]sx?$/.test(entry)) continue;
        const dot = entry.lastIndexOf(".");
        if (dot >= 0 && exts.has(entry.slice(dot))) {
          results.push(full);
        }
      }
    }
  }
  return results;
}

describe("Tier 1: Client, Agent, Scripts Integration (F11) & R5 Scope Exclusions", () => {
  describe("F11: Client, Agent & Script ABI / Registry Integration", () => {
    it("T1-F11.1: stellar.ts buildActionArgs encodes u64 deadline on mint_py, all 4 swap_exact_*, and rollover_*", () => {
      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const xlm90d = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

      const mintRes = buildActionArgsCompat(
        {
          type: "mint_py",
          caller: TEST_CALLER,
          amount: 10_000_000n,
          deadline: EXPLICIT_DEADLINE,
        },
        usdc90d,
        EXPLICIT_DEADLINE
      );
      expect(mintRes.method).toBe("mint_py");
      expect(mintRes.args.length).toBe(4);
      const mintDecoded = inspectScValArgs(mintRes.args);
      expect(mintDecoded[3]).toMatchObject({ xdrType: "scvU64", native: EXPLICIT_DEADLINE });

      const swapMethods = [
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_pt",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
      ] as const;

      const swapLabels = new Set<string>();
      for (const method of swapMethods) {
        const swapRes = buildActionArgsCompat(
          {
            type: "swap",
            caller: TEST_CALLER,
            method,
            amountIn: 10_000_000n,
            minOut: 9_500_000n,
            deadline: EXPLICIT_DEADLINE,
          },
          usdc90d,
          EXPLICIT_DEADLINE
        );
        expect(swapRes.method).toBe(method);
        expect(swapRes.args.length).toBe(5);
        const decoded = inspectScValArgs(swapRes.args);
        expect(decoded[4]).toMatchObject({ xdrType: "scvU64", native: EXPLICIT_DEADLINE });
        expect(swapRes.label).not.toBe("Swap");
        swapLabels.add(swapRes.label);
        expect(getFriendlyActionName(method)).toBe("Swap");
      }
      expect(swapLabels.size).toBe(4);

      const rolloverPtRes = buildActionArgsCompat(
        {
          type: "rollover_to_pt",
          caller: TEST_CALLER,
          receiver: TEST_RECEIVER,
          sourcePool: usdc90d.contracts.poolId,
          targetPool: xlm90d.contracts.poolId,
          ptAmount: 10_000_000n,
          minTargetPt: 9_000_000n,
          deadline: EXPLICIT_DEADLINE,
        },
        usdc90d,
        EXPLICIT_DEADLINE
      );
      expect(rolloverPtRes.args.length).toBe(7);
      expect(inspectScValArgs(rolloverPtRes.args)[6]).toMatchObject({
        xdrType: "scvU64",
        native: EXPLICIT_DEADLINE,
      });

      const rolloverPyRes = buildActionArgsCompat(
        {
          type: "rollover_to_py",
          caller: TEST_CALLER,
          receiver: TEST_RECEIVER,
          sourcePool: usdc90d.contracts.poolId,
          targetPool: xlm90d.contracts.poolId,
          ptAmount: 10_000_000n,
          minNewShares: 9_000_000n,
          deadline: EXPLICIT_DEADLINE,
        },
        usdc90d,
        EXPLICIT_DEADLINE
      );
      expect(rolloverPyRes.args.length).toBe(7);
      expect(inspectScValArgs(rolloverPyRes.args)[6]).toMatchObject({
        xdrType: "scvU64",
        native: EXPLICIT_DEADLINE,
      });
    });

    it("T1-F11.2: stellar.ts buildActionArgs encodes zap_in_pt, zap_in_yt, zap_in_lp and TradingDesk exposes Zap-In UI", async () => {
      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const xlm90d = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
      const amount = 25_000_000n;
      const minOut = 20_000_000n;

      for (const market of [usdc90d, xlm90d]) {
        for (const method of ["zap_in_pt", "zap_in_yt", "zap_in_lp"] as const) {
          const encoded = buildActionArgsCompat(
            {
              type: method,
              caller: TEST_CALLER,
              receiver: TEST_CALLER,
              pool: market.contracts.poolId,
              poolId: market.contracts.poolId,
              underlyingAmount: amount,
              amount,
              amountIn: amount,
              minOut,
              minPtOut: minOut,
              minYtOut: minOut,
              minLpOut: minOut,
              deadline: EXPLICIT_DEADLINE,
            },
            market,
            EXPLICIT_DEADLINE
          );

          expect(encoded).toBeDefined();
          expect(encoded.contractId).toBe(STELLAR_PENDLE_CONFIG.market_factory.contractId);
          expect(encoded.method).toBe(method);
          expect(encoded.args.length).toBe(6);

          const decoded = inspectScValArgs(encoded.args);
          expect(decoded[0]).toMatchObject({ xdrType: "scvAddress", native: TEST_CALLER });
          expect(decoded[1]).toMatchObject({ xdrType: "scvAddress", native: TEST_CALLER });
          expect(decoded[2]).toMatchObject({
            xdrType: "scvAddress",
            native: market.contracts.poolId,
          });
          expect(decoded[3]).toMatchObject({ xdrType: "scvI128", native: amount });
          expect(decoded[4]).toMatchObject({ xdrType: "scvI128", native: minOut });
          expect(decoded[5]).toMatchObject({ xdrType: "scvU64", native: EXPLICIT_DEADLINE });
        }
      }

      // Probe real TradingDesk UI for Zap-In controls
      const mounted = await mountFrontendDom(
        React.createElement(
          WithSeededWallet,
          { address: TEST_CALLER },
          React.createElement(MarketProvider, {
            initialMarketId: "usdc-90d",
            children: React.createElement(TradingDesk, {
              snapshot: makeActiveSnapshot(usdc90d),
              portfolio: makeActivePortfolio(),
              busyAction: null,
              onExecuteAction: async () => {},
            }),
          })
        )
      );
      try {
        const buttons = [...mounted.container.querySelectorAll("button")];
        const zapBtn = buttons.find((b) => /zap/i.test(b.textContent ?? ""));
        if (zapBtn) {
          await act(async () => {
            zapBtn.click();
          });
        }
        const text = mounted.container.textContent ?? "";
        expect(/zap/i.test(text)).toBe(true);
      } finally {
        mounted.window.localStorage.removeItem("stellar_pendle_wallet_session");
        await mounted.unmount();
      }
    });

    it("T1-F11.3: SwapCard locks CTA button on swap_exact_* busyActions key while MintCard and LiquidityCard stay unlocked", async () => {
      const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const snapshot = makeActiveSnapshot(usdc90d);
      const portfolio = makeActivePortfolio();
      const busyActions = {
        [`${usdc90d.contracts.poolId}:swap_exact_sy_for_pt`]: "Confirming Swap...",
      };

      const mounted = await mountFrontendDom(
        React.createElement(
          WithSeededWallet,
          { address: TEST_CALLER },
          React.createElement(MarketProvider, {
            initialMarketId: "usdc-90d",
            children: React.createElement(
              "div",
              null,
              React.createElement(
                "div",
                { "data-testid": "swap-panel" },
                React.createElement(SwapCard, {
                  snapshot,
                  portfolio,
                  busyAction: null,
                  busyActions,
                  onExecuteAction: async () => {},
                })
              ),
              React.createElement(
                "div",
                { "data-testid": "mint-panel" },
                React.createElement(MintCard, {
                  snapshot,
                  portfolio,
                  busyAction: null,
                  busyActions,
                  onExecuteAction: async () => {},
                })
              ),
              React.createElement(
                "div",
                { "data-testid": "liq-panel" },
                React.createElement(LiquidityCard, {
                  snapshot,
                  portfolio,
                  busyAction: null,
                  busyActions,
                  onExecuteAction: async () => {},
                })
              )
            ),
          })
        )
      );

      try {
        const swapPanel = mounted.container.querySelector('[data-testid="swap-panel"]')!;
        const swapButtons = [...swapPanel.querySelectorAll("button")];
        const swapCta = swapButtons.find(
          (b) =>
            (b.textContent ?? "").includes("Confirming Swap...") ||
            (b.textContent ?? "").includes("Execute Swap")
        );
        expect(swapCta).toBeDefined();
        expect(swapCta!.textContent?.trim()).toBe("Confirming Swap...");
        expect(swapCta!.disabled).toBe(true);

        const mintPanel = mounted.container.querySelector('[data-testid="mint-panel"]')!;
        expect(mintPanel.textContent).not.toContain("Confirming Swap...");

        const liqPanel = mounted.container.querySelector('[data-testid="liq-panel"]')!;
        expect(liqPanel.textContent).not.toContain("Confirming Swap...");
      } finally {
        mounted.window.localStorage.removeItem("stellar_pendle_wallet_session");
        await mounted.unmount();
      }
    });

    it("T1-F11.4: sUSDC Slender market is wired across manifest/frontend/indexer while SHA-256 and 5-key locks stay intact", async () => {
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

      const frontendSusdc = PRESET_MARKETS.find(
        (m) =>
          m.sySymbol === "sy-sUSDC" ||
          /susdc|slender/i.test(m.id) ||
          /susdc|slender/i.test(m.name)
      );
      expect(frontendSusdc).toBeDefined();
      expect(frontendSusdc!.sySymbol).toBe("sy-sUSDC");
      expect(frontendSusdc!.contracts.poolId).toMatch(C_ADDR_RE);
      expect(frontendSusdc!.contracts.syId).toMatch(C_ADDR_RE);
      expect(frontendSusdc!.contracts.ptId).toMatch(C_ADDR_RE);
      expect(frontendSusdc!.contracts.ytId).toMatch(C_ADDR_RE);

      const indexerSusdc = MARKETS[frontendSusdc!.id];
      expect(indexerSusdc).toBeDefined();
      expect(indexerSusdc!.poolId).toBe(frontendSusdc!.contracts.poolId);
      expect(indexerSusdc!.syId).toBe(frontendSusdc!.contracts.syId);
      expect(indexerSusdc!.ptId).toBe(frontendSusdc!.contracts.ptId);
      expect(indexerSusdc!.ytId).toBe(frontendSusdc!.contracts.ytId);

      const catalogIds = new Set(CONTRACT_CATALOG.map((c) => c.id));
      expect(catalogIds.has(frontendSusdc!.contracts.poolId)).toBe(true);
      expect(catalogIds.has(frontendSusdc!.contracts.syId)).toBe(true);

      const deployed = JSON.parse(readFileSync(DEPLOYED_CONTRACTS_PATH, "utf8")) as {
        markets: Array<{
          id: string;
          contracts: { pool: string; sy: string; pt: string; yt: string };
        }>;
      };
      const deployedSusdc = deployed.markets.find((m) => m.id === frontendSusdc!.id);
      expect(deployedSusdc).toBeDefined();
      expect(deployedSusdc!.contracts.pool).toBe(frontendSusdc!.contracts.poolId);
      expect(deployedSusdc!.contracts.sy).toBe(frontendSusdc!.contracts.syId);
    });

    it("T1-F11.5: StellarPendleAgentClient encodes u64 deadline in XDR while MCP exposes exact 8 tools & 2 resources", async () => {
      const mcp = await connectAgentMcpInMemory(DEPLOYED_CONTRACTS_PATH);
      try {
        expect(await mcp.listToolNames()).toEqual([...EXPECTED_MCP_TOOLS]);
        expect(await mcp.listResourceUris()).toEqual([...EXPECTED_MCP_RESOURCES]);
      } finally {
        await mcp.close();
      }

      const manifest = JSON.parse(
        readFileSync(DEPLOYED_CONTRACTS_PATH, "utf8")
      ) as DeploymentManifest;
      const rpcServer = startLocalSorobanRpcServer(TEST_CALLER);
      try {
        const localUrl = `http://127.0.0.1:${rpcServer.port}`;
        const client = new StellarPendleAgentClient({
          ...manifest,
          rpcUrl: "https://soroban-testnet.stellar.org",
        });
        (client as unknown as { rpcServer: rpc.Server }).rpcServer = new rpc.Server(localUrl, {
          allowHttp: true,
        });

        const mintPrepared = await (
          client.buildMintPyTx as unknown as BuildMintPyCompat
        ).call(client, TEST_CALLER, 10_000_000n, TEST_CALLER, EXPLICIT_DEADLINE);

        const decodedMint = decodeUnsignedInvokeContractXdr(
          mintPrepared.unsignedXdr,
          manifest.networkPassphrase
        );
        expect(decodedMint.functionName).toBe("mint_py");
        expect(decodedMint.args.length).toBe(4);
        expect(decodedMint.args[3]).toMatchObject({
          xdrType: "scvU64",
          native: EXPLICIT_DEADLINE,
        });

        for (const direction of ["pt_for_sy", "sy_for_pt", "sy_for_yt", "yt_for_sy"] as const) {
          const swapPrepared = await (
            client.buildSwapTx as unknown as BuildSwapCompat
          ).call(
            client,
            TEST_CALLER,
            direction,
            10_000_000n,
            9_500_000n,
            TEST_CALLER,
            EXPLICIT_DEADLINE
          );
          const decodedSwap = decodeUnsignedInvokeContractXdr(
            swapPrepared.unsignedXdr,
            manifest.networkPassphrase
          );
          expect(decodedSwap.args.length).toBe(5);
          expect(decodedSwap.args[4]).toMatchObject({
            xdrType: "scvU64",
            native: EXPLICIT_DEADLINE,
          });
        }
      } finally {
        rpcServer.stop(true);
      }
    });
  });

  describe("R5: Out-of-Scope Exclusion Adversarial Checks", () => {
    it(
      "R5-1: MCP stdio server exposes strictly the 8 canonical tools and 2 resources",
      async () => {
        const session = await connectAgentMcpStdio({ manifestPath: DEPLOYED_CONTRACTS_PATH });
        try {
          const tools = await session.listToolNames();
          const resources = await session.listResourceUris();
          expect(tools.length).toBe(8);
          expect(tools).toEqual([...EXPECTED_MCP_TOOLS]);
          expect(resources).toEqual([...EXPECTED_MCP_RESOURCES]);

          for (const t of tools) {
            expect(t).not.toMatch(/limit_order|auto_rollover|oracle|zap_in/);
          }
        } finally {
          await session.close();
        }
      },
      20_000
    );

    it("R5-2: zero limit-order, auto-rollover, or external-oracle implementations exist across repo source", () => {
      const scan = scanR5OutOfScopeSymbols();
      expect(scan.filesScanned).toBeGreaterThan(0);
      expect(scan.matches).toEqual([]);

      const camelPatterns = [
        "orderbook",
        "limitOrder",
        "autoRollover",
        "enableAutoRollover",
        "placeLimitOrder",
        "cancelLimitOrder",
      ];
      const roots = [
        CONTRACTS_DIR,
        join(FRONTEND_DIR, "src"),
        INDEXER_DIR,
        join(AGENT_DIR, "src"),
        SCRIPTS_DIR,
      ];
      const camelMatches: Array<{ file: string; pattern: string; line: number }> = [];
      for (const root of roots) {
        for (const file of walkSourceFiles(root)) {
          const lines = readFileSync(file, "utf8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i]!;
            for (const pat of camelPatterns) {
              if (lineText.includes(pat)) {
                camelMatches.push({ file, pattern: pat, line: i + 1 });
              }
            }
          }
        }
      }
      expect(camelMatches).toEqual([]);
    });

    it("R5-3: BFF path whitelist rejects out-of-scope routes with HTTP 404", async () => {
      for (const path of [
        ["orders"],
        ["limit-orders"],
        ["oracle"],
        ["rollover-jobs"],
        ["auto-rollover"],
      ]) {
        const res = await invokeBffGet({ path });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { success: boolean; error: string };
        expect(body).toEqual({ success: false, error: "Not Found" });
      }
    });
  });
});
