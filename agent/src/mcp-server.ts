#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { StellarPendleAgentClient, loadDeploymentManifest, parseUnits, formatUnits } from "./client.js";
import type { SwapDirection } from "./types.js";

function okJson(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Registers an MCP tool cleanly without triggering @modelcontextprotocol/sdk + zod@3.25
 * recursive conditional generic inference stalls in tsc.
 */
function registerSimpleTool<TArgs extends Record<string, unknown>>(
  server: McpServer,
  name: string,
  meta: {
    title: string;
    description: string;
    inputSchema: ZodRawShape;
  },
  handler: (args: TArgs) => Promise<ReturnType<typeof okJson>>
): void {
  (server.registerTool as unknown as (n: string, m: unknown, h: unknown) => void)(
    name,
    meta,
    handler
  );
}

export function createStellarPendleMcpServer(manifestPath?: string): {
  mcpServer: McpServer;
  client: StellarPendleAgentClient;
} {
  const manifest = loadDeploymentManifest(manifestPath);
  const client = new StellarPendleAgentClient(manifest);

  const mcpServer = new McpServer({
    name: "stellar-pendle-mcp",
    version: "0.1.0",
  });

  mcpServer.registerResource(
    "deployment_manifest",
    "stellar-pendle://deployment",
    {
      title: "Stellar Pendle Testnet Deployment Manifest",
      description: "Live Soroban contract IDs, WASM hashes, maturity timestamp, and explorer links.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "stellar-pendle://deployment",
          mimeType: "application/json",
          text: JSON.stringify(manifest, null, 2),
        },
      ],
    })
  );

  mcpServer.registerResource(
    "stellar_agent_ecosystem",
    "stellar-pendle://stellar-agent-ecosystem",
    {
      title: "Stellar AI Agent & MCP Integration Topology",
      description: "Companion Stellar MCP servers (stellar-raven, stellar-devkit-mcp) and x402 / OZ Relayer Channel guidance.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "stellar-pendle://stellar-agent-ecosystem",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              protocol: "Stellar Pendle Yield Tokenization",
              network: manifest.network,
              mpcToolsProvided: [
                "get_market_state",
                "get_portfolio",
                "quote_yield_strategy",
                "build_deposit_sy_xdr",
                "build_mint_py_xdr",
                "build_swap_xdr",
                "build_claim_and_redeem_xdr",
                "build_liquidity_xdr",
              ],
              companionEcosystemInfrastructure: {
                stellarRavenMcp: {
                  url: "https://raven.stellar.buzz/mcp",
                  transport: "http",
                  role: "Live Stellar & Soroban docs and ecosystem intelligence",
                },
                stellarAgentKit: {
                  npm: "stellar-agent-kit",
                  mcp: "stellar-devkit-mcp",
                  role: "Blend lending, SoroSwap DEX routing, Reflector oracle, and XLM/USDC wallets",
                },
                openZeppelinRelayerChannels: {
                  testnetEndpoint: "https://channels.openzeppelin.com/testnet",
                  role: "Optional fee sponsorship for zero-XLM passkey / x402 AI agent wallets",
                },
              },
            },
            null,
            2
          ),
        },
      ],
    })
  );

  registerSimpleTool<Record<string, never>>(
    mcpServer,
    "get_market_state",
    {
      title: "Get Live Stellar Pendle Market State",
      description:
        "Fetches real-time on-chain AMM reserves, Blend bRate exchange index, PT/YT pricing, and Implied Fixed APY from Soroban Testnet.",
      inputSchema: {},
    },
    async () => {
      const snapshot = await client.getMarketSnapshot();
      return okJson({
        ...snapshot,
        formatted: {
          ptReserve: `${formatUnits(snapshot.ptReserve)} PT`,
          syReserve: `${formatUnits(snapshot.syReserve)} SY`,
          totalLpSupply: `${formatUnits(snapshot.totalLpSupply)} LP`,
          ptTotalSupply: `${formatUnits(snapshot.ptTotalSupply)} PT`,
          ytTotalSupply: `${formatUnits(snapshot.ytTotalSupply)} YT`,
          blendIndex9Dec: (Number(snapshot.blendExchangeRate) / 1e9).toFixed(6),
          ammRate: (Number(snapshot.ammExchangeRateWad) / 1e18).toFixed(6),
          impliedFixedApy: `${snapshot.impliedFixedApyPct}%`,
        },
      });
    }
  );

  registerSimpleTool<{ address: string }>(
    mcpServer,
    "get_portfolio",
    {
      title: "Get User or Agent Portfolio",
      description:
        "Reads live XLM, USDC, sy-bUSDC, PT, YT, LP share balances and accrued claimable yield for a Stellar G... address.",
      inputSchema: {
        address: z.string().regex(/^G[A-Z0-9]{55}$/, "Valid Stellar G... public key required"),
      },
    },
    async ({ address }) => {
      const portfolio = await client.getUserPortfolio(address);
      return okJson({
        ...portfolio,
        formatted: {
          xlm: `${portfolio.xlmBalance} XLM`,
          usdc: `${portfolio.usdcBalance} USDC`,
          sy: `${formatUnits(portfolio.syBalance)} sy-bUSDC`,
          pt: `${formatUnits(portfolio.ptBalance)} PT`,
          yt: `${formatUnits(portfolio.ytBalance)} YT`,
          lp: `${formatUnits(portfolio.lpBalance)} LP`,
          estimatedPendingYieldSy: `${formatUnits(portfolio.estimatedPendingYieldSy)} sy-bUSDC`,
        },
      });
    }
  );

  registerSimpleTool<{ direction: SwapDirection; humanAmountIn: string; slippageBps: number }>(
    mcpServer,
    "quote_yield_strategy",
    {
      title: "Quote PT / YT / SY AMM Trade",
      description:
        "Simulates log-normal Yield AMM pricing against current Testnet reserves, computing expected output, slippage floor, fees, and post-trade Implied APY.",
      inputSchema: {
        direction: z.enum(["pt_for_sy", "sy_for_pt", "sy_for_yt", "yt_for_sy"]),
        humanAmountIn: z.string().describe("Human-readable decimal amount (e.g. '1.5' for 1.5000000 tokens)"),
        slippageBps: z.number().int().min(0).max(5000).default(50),
      },
    },
    async ({ direction, humanAmountIn, slippageBps }) => {
      const amountStroops = parseUnits(humanAmountIn, manifest.market.decimals);
      const quote = await client.quoteAction(direction, amountStroops, slippageBps);
      return okJson({
        ...quote,
        formatted: {
          amountIn: formatUnits(quote.amountIn),
          estimatedOut: formatUnits(quote.estimatedOut),
          minOutWithSlippage: formatUnits(quote.minOutWithSlippage),
          feeAmount: formatUnits(quote.feeAmount),
          impliedApyAfter: `${quote.impliedApyAfterPct.toFixed(2)}%`,
        },
      });
    }
  );

  registerSimpleTool<{ sourceAddress: string; humanAmountUsdc: string; receiver?: string }>(
    mcpServer,
    "build_deposit_sy_xdr",
    {
      title: "Build Deposit USDC -> SY Unsigned XDR",
      description:
        "Simulates and builds an unsigned Stellar transaction wrapping underlying Testnet USDC into yield-bearing sy-bUSDC via sy_blend_wrapper.",
      inputSchema: {
        sourceAddress: z.string().regex(/^G[A-Z0-9]{55}$/),
        humanAmountUsdc: z.string(),
        receiver: z.string().regex(/^G[A-Z0-9]{55}$/).optional(),
      },
    },
    async ({ sourceAddress, humanAmountUsdc, receiver }) => {
      const amount = parseUnits(humanAmountUsdc, manifest.market.decimals);
      const tx = await client.buildDepositSyTx(sourceAddress, amount, receiver || sourceAddress);
      return okJson(tx);
    }
  );

  registerSimpleTool<{ sourceAddress: string; humanAmountSy: string; receiver?: string }>(
    mcpServer,
    "build_mint_py_xdr",
    {
      title: "Build Mint PT + YT Unsigned XDR",
      description:
        "Simulates and builds an unsigned Soroban transaction splitting sy-bUSDC into equal 1:1 Principal Tokens (PT) and Yield Tokens (YT).",
      inputSchema: {
        sourceAddress: z.string().regex(/^G[A-Z0-9]{55}$/),
        humanAmountSy: z.string(),
        receiver: z.string().regex(/^G[A-Z0-9]{55}$/).optional(),
      },
    },
    async ({ sourceAddress, humanAmountSy, receiver }) => {
      const amount = parseUnits(humanAmountSy, manifest.market.decimals);
      const tx = await client.buildMintPyTx(sourceAddress, amount, receiver || sourceAddress);
      return okJson(tx);
    }
  );

  registerSimpleTool<{
    sourceAddress: string;
    direction: SwapDirection;
    humanAmountIn: string;
    slippageBps: number;
    receiver?: string;
  }>(
    mcpServer,
    "build_swap_xdr",
    {
      title: "Build Yield AMM Swap Unsigned XDR",
      description:
        "Quotes slippage limits automatically and prepares a simulated unsigned Soroban XDR for PT<->SY or flash YT<->SY swaps.",
      inputSchema: {
        sourceAddress: z.string().regex(/^G[A-Z0-9]{55}$/),
        direction: z.enum(["pt_for_sy", "sy_for_pt", "sy_for_yt", "yt_for_sy"]),
        humanAmountIn: z.string(),
        slippageBps: z.number().int().min(0).max(5000).default(50),
        receiver: z.string().regex(/^G[A-Z0-9]{55}$/).optional(),
      },
    },
    async ({ sourceAddress, direction, humanAmountIn, slippageBps, receiver }) => {
      const amountIn = parseUnits(humanAmountIn, manifest.market.decimals);
      const quote = await client.quoteAction(direction, amountIn, slippageBps);
      const tx = await client.buildSwapTx(
        sourceAddress,
        direction,
        amountIn,
        BigInt(quote.minOutWithSlippage),
        receiver || sourceAddress
      );
      return okJson({ quote, transaction: tx });
    }
  );

  registerSimpleTool<{
    action:
      | "claim_yield"
      | "redeem_sy"
      | "redeem_py"
      | "redeem_pt_post_maturity"
      | "redeem_pt_to_btoken";
    sourceAddress: string;
    humanAmount?: string;
    receiver?: string;
  }>(
    mcpServer,
    "build_claim_and_redeem_xdr",
    {
      title: "Build Yield Claim or Maturity Redemption Unsigned XDR",
      description:
        "Builds simulated unsigned XDR for claim_yield, redeem_sy, redeem_py (pre-maturity unwind), redeem_pt_post_maturity, or emergency redeem_pt_to_btoken.",
      inputSchema: {
        action: z.enum([
          "claim_yield",
          "redeem_sy",
          "redeem_py",
          "redeem_pt_post_maturity",
          "redeem_pt_to_btoken",
        ]),
        sourceAddress: z.string().regex(/^G[A-Z0-9]{55}$/),
        humanAmount: z
          .string()
          .optional()
          .describe("Required for redeem actions; omitted for claim_yield"),
        receiver: z.string().regex(/^G[A-Z0-9]{55}$/).optional(),
      },
    },
    async ({ action, sourceAddress, humanAmount, receiver }) => {
      const rec = receiver || sourceAddress;
      if (action === "claim_yield") {
        return okJson(await client.buildClaimYieldTx(sourceAddress, rec));
      }
      if (!humanAmount) {
        throw new Error(`humanAmount is required for ${action}`);
      }
      const amt = parseUnits(humanAmount, manifest.market.decimals);
      switch (action) {
        case "redeem_sy":
          return okJson(await client.buildRedeemSyTx(sourceAddress, amt, rec));
        case "redeem_py":
          return okJson(await client.buildRedeemPyTx(sourceAddress, amt, rec));
        case "redeem_pt_post_maturity":
          return okJson(await client.buildRedeemPtPostMaturityTx(sourceAddress, amt, rec));
        case "redeem_pt_to_btoken":
          return okJson(await client.buildRedeemPtToBtokenTx(sourceAddress, amt, rec));
      }
    }
  );

  registerSimpleTool<{
    mode: "add" | "remove";
    sourceAddress: string;
    ptOrLpAmount: string;
    syAmount?: string;
    minOut?: string;
    receiver?: string;
  }>(
    mcpServer,
    "build_liquidity_xdr",
    {
      title: "Build AMM Add/Remove Liquidity Unsigned XDR",
      description:
        "Simulates and builds unsigned XDR to add dual-sided PT+SY liquidity or remove LP shares.",
      inputSchema: {
        mode: z.enum(["add", "remove"]),
        sourceAddress: z.string().regex(/^G[A-Z0-9]{55}$/),
        ptOrLpAmount: z.string().describe("PT amount for 'add', or LP shares amount for 'remove'"),
        syAmount: z.string().optional().describe("SY amount required when mode='add'"),
        minOut: z.string().optional(),
        receiver: z.string().regex(/^G[A-Z0-9]{55}$/).optional(),
      },
    },
    async ({ mode, sourceAddress, ptOrLpAmount, syAmount, minOut, receiver }) => {
      const rec = receiver || sourceAddress;
      if (mode === "add") {
        if (!syAmount) throw new Error("syAmount is required when mode='add'");
        const pt = parseUnits(ptOrLpAmount, manifest.market.decimals);
        const sy = parseUnits(syAmount, manifest.market.decimals);
        const minLp = minOut ? parseUnits(minOut, manifest.market.decimals) : 1n;
        return okJson(await client.buildAddLiquidityTx(sourceAddress, pt, sy, minLp, rec));
      }
      const lp = parseUnits(ptOrLpAmount, manifest.market.decimals);
      const minP = minOut ? parseUnits(minOut, manifest.market.decimals) : 1n;
      return okJson(await client.buildRemoveLiquidityTx(sourceAddress, lp, minP, 1n, rec));
    }
  );

  return { mcpServer, client };
}

if (import.meta.main) {
  const { mcpServer } = createStellarPendleMcpServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
