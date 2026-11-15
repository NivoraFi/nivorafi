import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  StellarPendleAgentClient,
  WAD,
  calculateImpliedApyPct,
  formatUnits,
  getExchangeRate,
  loadDeploymentManifest,
  parseUnits,
} from "../src/client.js";
import { quoteSwap } from "../src/math.js";
import { createStellarPendleMcpServer } from "../src/mcp-server.js";
import type { MarketStateOnChain } from "../src/types.js";

describe("Stellar Pendle AI Agent SDK & Math", () => {
  it("parses and formats 7-decimal Stellar stroop amounts accurately", () => {
    expect(parseUnits("1.5", 7)).toBe(15_000_000n);
    expect(parseUnits("125", 7)).toBe(1_250_000_000n);
    expect(parseUnits("0.0000001", 7)).toBe(1n);
    expect(formatUnits(15_000_000n, 7)).toBe("1.5");
    expect(formatUnits("10000000", 7)).toBe("1");
    expect(() => parseUnits("1.12345678", 7)).toThrow();
  });

  it("matches deterministic log-normal AMM quote dynamics", () => {
    const now = 1_800_000_000n;
    const state: MarketStateOnChain = {
      total_pt_reserve: 90_000_000n,
      total_sy_reserve: 30_000_000n,
      total_lp_supply: 50_000_000n,
      scalar_root: 8n * WAD,
      initial_anchor: WAD,
      annual_fee_rate: 50_000_000_000_000_000n,
      protocol_fee_bps: 2000n,
      fee_recipient: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      maturity: now + 90n * 86_400n,
      maturity_index: 0n,
      is_settled: false,
    };

    const rate = getExchangeRate(
      state.total_pt_reserve,
      state.total_sy_reserve,
      (90n * 86_400n * WAD) / 31_536_000n,
      state.scalar_root,
      state.initial_anchor
    );
    expect(rate > WAD).toBe(true);
    const apy = calculateImpliedApyPct(rate, (90n * 86_400n * WAD) / 31_536_000n);
    expect(apy).toBeGreaterThan(5);

    const ptToSy = quoteSwap(state, "pt_for_sy", 5_000_000n, now, 50);
    expect(BigInt(ptToSy.estimatedOut)).toBeGreaterThan(0n);
    expect(BigInt(ptToSy.estimatedOut)).toBeLessThan(5_000_000n);
    expect(BigInt(ptToSy.minOutWithSlippage)).toBeLessThanOrEqual(BigInt(ptToSy.estimatedOut));

    const syToPt = quoteSwap(state, "sy_for_pt", 2_000_000n, now, 50);
    expect(BigInt(syToPt.estimatedOut)).toBeGreaterThan(2_000_000n);

    const syToYt = quoteSwap(state, "sy_for_yt", 200_000n, now, 50);
    expect(BigInt(syToYt.estimatedOut)).toBeGreaterThan(200_000n);
  });
});

describe("Stellar Pendle Live Testnet Client & MCP Server", () => {
  it("loads deployed_contracts.json and queries live Testnet contracts", async () => {
    const manifest = loadDeploymentManifest();
    expect(manifest.network).toBe("testnet");
    expect(manifest.contracts.yield_pool.contractId.startsWith("C")).toBe(true);

    const client = new StellarPendleAgentClient(manifest);
    const snapshot = await client.getMarketSnapshot();
    expect(BigInt(snapshot.ptReserve)).toBeGreaterThan(0n);
    expect(BigInt(snapshot.syReserve)).toBeGreaterThan(0n);
    expect(BigInt(snapshot.blendExchangeRate)).toBeGreaterThanOrEqual(1_000_000_000n);
    expect(snapshot.impliedFixedApyPct).toBeGreaterThan(0);

    const portfolio = await client.getUserPortfolio(manifest.deployer);
    expect(portfolio.usdcTrustlineExists).toBe(true);
    expect(BigInt(portfolio.lpBalance)).toBeGreaterThan(0n);

    const prepared = await client.buildDepositSyTx(manifest.deployer, parseUnits("0.1", 7));
    expect(prepared.method).toBe("deposit");
    expect(prepared.unsignedXdr.length).toBeGreaterThan(40);
    expect(BigInt(prepared.minResourceFeeStroops)).toBeGreaterThan(0n);
  }, 30_000);

  it("exposes all 8 MCP tools and 2 resources via Model Context Protocol", async () => {
    const { mcpServer } = createStellarPendleMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const mcpClient = new Client(
      { name: "stellar-pendle-test-client", version: "0.1.0" },
      { capabilities: {} }
    );

    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const toolsRes = await mcpClient.listTools();
      const toolNames = toolsRes.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        "build_claim_and_redeem_xdr",
        "build_deposit_sy_xdr",
        "build_liquidity_xdr",
        "build_mint_py_xdr",
        "build_swap_xdr",
        "get_market_state",
        "get_portfolio",
        "quote_yield_strategy",
      ]);

      const resourcesRes = await mcpClient.listResources();
      expect(resourcesRes.resources.map((r) => r.uri).sort()).toEqual([
        "stellar-pendle://deployment",
        "stellar-pendle://stellar-agent-ecosystem",
      ]);

      const deploymentRes = await mcpClient.readResource({
        uri: "stellar-pendle://deployment",
      });
      const firstContent = deploymentRes.contents[0]!;
      expect("text" in firstContent).toBe(true);
      const parsedDeployment = JSON.parse(
        "text" in firstContent ? firstContent.text : ""
      );
      expect(parsedDeployment.contracts.yield_pool.contractId).toBe(
        "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF"
      );

      const stateTool = await mcpClient.callTool({
        name: "get_market_state",
        arguments: {},
      });
      const stateJson = JSON.parse(
        ((stateTool.content as Array<{ type: string; text: string }>)[0]!).text
      );
      expect(BigInt(stateJson.ammExchangeRateWad)).toBeGreaterThan(WAD);

      const quoteTool = await mcpClient.callTool({
        name: "quote_yield_strategy",
        arguments: { direction: "sy_for_pt", humanAmountIn: "0.25", slippageBps: 50 },
      });
      const quoteJson = JSON.parse(
        ((quoteTool.content as Array<{ type: string; text: string }>)[0]!).text
      );
      expect(Number(quoteJson.formatted.estimatedOut)).toBeGreaterThan(0.25);

      const buildTxTool = await mcpClient.callTool({
        name: "build_deposit_sy_xdr",
        arguments: {
          sourceAddress: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          humanAmountUsdc: "0.1",
        },
      });
      const txJson = JSON.parse(
        ((buildTxTool.content as Array<{ type: string; text: string }>)[0]!).text
      );
      expect(txJson.method).toBe("deposit");
      expect(txJson.unsignedXdr.length).toBeGreaterThan(40);
    } finally {
      await mcpClient.close();
      await mcpServer.close();
    }
  }, 30_000);
});
