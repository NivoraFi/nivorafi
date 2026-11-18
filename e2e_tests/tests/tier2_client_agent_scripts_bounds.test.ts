// e2e_tests/tests/tier2_client_agent_scripts_bounds.test.ts
// Tier 2: Boundary & Corner Cases for F11 (Deadline Defaults/Zero, Zap-In Validation, Scripts Dry-Run/Sandbox, Busy Key Isolation & sUSDC Routing)

import { describe, it, expect } from "bun:test";
import { StrKey } from "@stellar/stellar-sdk";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_USDC_MATURED,
  CANONICAL_XLM_90D,
  DEPLOYED_CONTRACTS_PATH,
  REPO_ROOT,
  React,
  act,
  computeFileSha256,
  inspectScValArgs,
  mountFrontendDom,
  renderFrontendHtml,
} from "../src/harness/index.ts";
import {
  PRESET_MARKETS,
  filterAndSortMarkets,
  getMarketDefinition,
  type MarketDefinition,
} from "@/lib/markets";
import { validateAmountInput } from "@/lib/math";
import {
  buildActionArgs,
  resolveScopedBusyAction,
  type LiveMarketSnapshot,
  type LiveUserPortfolio,
  type ProtocolAction,
} from "@/lib/stellar";
import { WalletProvider } from "@/context/WalletProvider";
import { MarketProvider } from "@/context/MarketContext";
import { SwapCard } from "@/components/trading/SwapCard";
import { MarketExplorerTable } from "@/components/markets/MarketExplorerTable";
import { buildRegisteredMarkets } from "../../scripts/register_markets.ts";

const TEST_CALLER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const TEST_RECEIVER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));

type BuildActionArgsCompat = (
  action: Record<string, unknown>,
  targetMarket?: MarketDefinition,
  deadline?: bigint
) => ReturnType<typeof buildActionArgs>;

const buildActionArgsCompat = buildActionArgs as unknown as BuildActionArgsCompat;

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

function makeActiveSnapshot(): LiveMarketSnapshot {
  const nowSec = Math.floor(Date.now() / 1000);
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
      maturity: BigInt(nowSec + 90 * 86_400),
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

describe("Tier 2: Client, Agent & Scripts Boundary Cases (F11)", () => {
  it("T2-F11.1: buildActionArgs defaults omitted deadline to future u64 and preserves explicit 0n without coercion", () => {
    const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
    const xlm90d = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
    const nowBig = BigInt(Math.floor(Date.now() / 1000));

    // Omitted deadline cases -> trailing arg must be scvU64 > nowBig
    const omittedCases = [
      buildActionArgsCompat({ type: "mint_py", caller: TEST_CALLER, amount: 10_000_000n }, usdc90d),
      buildActionArgsCompat(
        {
          type: "swap",
          caller: TEST_CALLER,
          method: "swap_exact_sy_for_pt",
          amountIn: 10_000_000n,
          minOut: 9_500_000n,
        },
        usdc90d
      ),
      buildActionArgsCompat(
        {
          type: "rollover_to_pt",
          caller: TEST_CALLER,
          receiver: TEST_RECEIVER,
          sourcePool: usdc90d.contracts.poolId,
          targetPool: xlm90d.contracts.poolId,
          ptAmount: 10_000_000n,
          minTargetPt: 9_000_000n,
        },
        usdc90d
      ),
    ];

    expect(omittedCases[0]!.args.length).toBe(4);
    expect(omittedCases[1]!.args.length).toBe(5);
    expect(omittedCases[2]!.args.length).toBe(7);

    for (const res of omittedCases) {
      const last = inspectScValArgs(res.args).at(-1)!;
      expect(last.xdrType).toBe("scvU64");
      expect(typeof last.native).toBe("bigint");
      expect((last.native as bigint) > nowBig).toBe(true);
    }

    // Explicit deadline = 0n must NOT be coerced via `||` to a future timestamp
    const zeroCases = [
      buildActionArgsCompat(
        { type: "mint_py", caller: TEST_CALLER, amount: 10_000_000n, deadline: 0n },
        usdc90d,
        0n
      ),
      buildActionArgsCompat(
        {
          type: "swap",
          caller: TEST_CALLER,
          method: "swap_exact_sy_for_pt",
          amountIn: 10_000_000n,
          minOut: 9_500_000n,
          deadline: 0n,
        },
        usdc90d,
        0n
      ),
      buildActionArgsCompat(
        {
          type: "rollover_to_pt",
          caller: TEST_CALLER,
          receiver: TEST_RECEIVER,
          sourcePool: usdc90d.contracts.poolId,
          targetPool: xlm90d.contracts.poolId,
          ptAmount: 10_000_000n,
          minTargetPt: 9_000_000n,
          deadline: 0n,
        },
        usdc90d,
        0n
      ),
    ];

    expect(zeroCases[0]!.args.length).toBe(4);
    expect(zeroCases[1]!.args.length).toBe(5);
    expect(zeroCases[2]!.args.length).toBe(7);

    for (const res of zeroCases) {
      const last = inspectScValArgs(res.args).at(-1)!;
      expect(last.xdrType).toBe("scvU64");
      expect(last.native).toBe(0n);
    }
  });

  it("T2-F11.2: Zap-In encodes valid min_out=0n cleanly while rejecting invalid addresses and non-positive amounts", () => {
    const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
    const validDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    // 1. Positive control: valid zap_in_pt with min_out = 0n encodes cleanly as 6 args
    const validZap = buildActionArgsCompat(
      {
        type: "zap_in_pt",
        caller: TEST_CALLER,
        receiver: TEST_CALLER,
        pool: usdc90d.contracts.poolId,
        poolId: usdc90d.contracts.poolId,
        underlyingAmount: 10_000_000n,
        amount: 10_000_000n,
        amountIn: 10_000_000n,
        minOut: 0n,
        minPtOut: 0n,
        deadline: validDeadline,
      },
      usdc90d,
      validDeadline
    );
    expect(validZap).toBeDefined();
    expect(validZap.args.length).toBe(6);
    const decodedValid = inspectScValArgs(validZap.args);
    expect(decodedValid[3]).toMatchObject({ xdrType: "scvI128", native: 10_000_000n });
    expect(decodedValid[4]).toMatchObject({ xdrType: "scvI128", native: 0n });
    expect(decodedValid[5]).toMatchObject({ xdrType: "scvU64", native: validDeadline });

    // 2. UI amount validation boundary
    expect(validateAmountInput("0", 7).valid).toBe(false);
    expect(validateAmountInput("-5", 7).valid).toBe(false);
    expect(validateAmountInput("", 7).valid).toBe(false);

    // 3. Invalid caller / receiver / pool addresses must throw
    for (const badAddr of ["BAD_ADDR", ""]) {
      expect(() =>
        buildActionArgsCompat(
          {
            type: "zap_in_pt",
            caller: badAddr,
            receiver: TEST_CALLER,
            pool: usdc90d.contracts.poolId,
            poolId: usdc90d.contracts.poolId,
            underlyingAmount: 10_000_000n,
            amount: 10_000_000n,
            minOut: 0n,
            minPtOut: 0n,
            deadline: validDeadline,
          },
          usdc90d,
          validDeadline
        )
      ).toThrow();

      expect(() =>
        buildActionArgsCompat(
          {
            type: "zap_in_pt",
            caller: TEST_CALLER,
            receiver: TEST_CALLER,
            pool: badAddr,
            poolId: badAddr,
            underlyingAmount: 10_000_000n,
            amount: 10_000_000n,
            minOut: 0n,
            minPtOut: 0n,
            deadline: validDeadline,
          },
          {
            ...usdc90d,
            contracts: { ...usdc90d.contracts, poolId: badAddr },
          },
          validDeadline
        )
      ).toThrow();
    }

    // 4. Non-positive underlyingAmount must throw
    for (const badAmt of [0n, -10_000_000n]) {
      expect(() =>
        buildActionArgsCompat(
          {
            type: "zap_in_pt",
            caller: TEST_CALLER,
            receiver: TEST_CALLER,
            pool: usdc90d.contracts.poolId,
            poolId: usdc90d.contracts.poolId,
            underlyingAmount: badAmt,
            amount: badAmt,
            amountIn: badAmt,
            minOut: 0n,
            minPtOut: 0n,
            deadline: validDeadline,
          },
          usdc90d,
          validDeadline
        )
      ).toThrow();
    }
  });

  it("T2-F11.3: register_markets.ts --dry-run is non-mutating and syncFrontendEnv preserves indexer vars in isolated sandbox", async () => {
    const deployedShaBefore = await computeFileSha256("deployed_contracts.json");
    const envProdShaBefore = await computeFileSha256("frontend/.env.production");
    const envLocalShaBefore = await computeFileSha256("frontend/.env.local");

    const dryRun = Bun.spawnSync(
      [process.execPath, "run", "scripts/register_markets.ts", "--dry-run"],
      {
        cwd: REPO_ROOT,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(dryRun.exitCode).toBe(0);

    expect(await computeFileSha256("deployed_contracts.json")).toBe(deployedShaBefore);
    expect(await computeFileSha256("frontend/.env.production")).toBe(envProdShaBefore);
    expect(await computeFileSha256("frontend/.env.local")).toBe(envLocalShaBefore);

    // Check buildRegisteredMarkets() alignment
    const markets = buildRegisteredMarkets();
    const xlm90d = markets.find((m) => m.id === "xlm-90d");
    expect(xlm90d).toBeDefined();
    expect(xlm90d!.factoryId).toBe(CANONICAL_XLM_90D.factoryId);
    expect(xlm90d!.contracts.pool).toBe(CANONICAL_XLM_90D.poolId);

    const matured = markets.find((m) => m.id === "usdc-matured");
    expect(matured).toBeDefined();
    expect(matured!.factoryId).toBe(CANONICAL_USDC_MATURED.factoryId);
    expect(matured!.contracts.pool).toBe(CANONICAL_USDC_MATURED.poolId);

    const susdc = markets.find(
      (m) => /susdc|slender/i.test(m.id) || /susdc|slender/i.test(m.name)
    );
    expect(susdc).toBeDefined();

    // Isolated mkdtempSync sandbox for syncFrontendEnv() — never touches repo .env*
    const sandbox = mkdtempSync(join(tmpdir(), "nivora-e2e-reg-sandbox-"));
    try {
      mkdirSync(join(sandbox, "scripts"), { recursive: true });
      mkdirSync(join(sandbox, "frontend"), { recursive: true });
      copyFileSync(
        join(REPO_ROOT, "scripts", "register_markets.ts"),
        join(sandbox, "scripts", "register_markets.ts")
      );
      copyFileSync(DEPLOYED_CONTRACTS_PATH, join(sandbox, "deployed_contracts.json"));
      copyFileSync(
        join(REPO_ROOT, "frontend", ".env.production"),
        join(sandbox, "frontend", ".env.production")
      );
      copyFileSync(
        join(REPO_ROOT, "frontend", ".env.local"),
        join(sandbox, "frontend", ".env.local")
      );

      const sandboxProc = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import { loadDeployedContracts, syncFrontendEnv } from "./scripts/register_markets.ts"; syncFrontendEnv(loadDeployedContracts());',
        ],
        {
          cwd: sandbox,
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(sandboxProc.exitCode).toBe(0);

      for (const envName of [".env.production", ".env.local"]) {
        const out = readFileSync(join(sandbox, "frontend", envName), "utf8");
        expect(out).toContain('NEXT_PUBLIC_INDEXER_API_URL="/api/indexer"');
        expect(out).toContain('INDEXER_INTERNAL_URL="http://127.0.0.1:8765"');
        expect(out).toContain('INDEXER_API_SECRET="replace_with_32_byte_hex_secret"');
        expect(out).not.toContain("trycloudflare.com");
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("T2-F11.4: SwapCard busy key isolates xlm-90d from usdc-90d while locking usdc-90d on its own swap_exact_* key", async () => {
    const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
    const xlm90d = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
    const snapshot = makeActiveSnapshot();
    const portfolio = makeActivePortfolio();

    expect(
      resolveScopedBusyAction(
        { [`${xlm90d.contracts.poolId}:swap_exact_sy_for_pt`]: "Swapping XLM..." },
        null,
        usdc90d.contracts.poolId,
        ["swap_exact_sy_for_pt"]
      )
    ).toBeNull();
    expect(
      resolveScopedBusyAction(
        { [`${usdc90d.contracts.poolId}:swap_exact_sy_for_pt`]: "Confirming..." },
        null,
        usdc90d.contracts.poolId,
        ["swap_exact_sy_for_pt"]
      )
    ).toBe("Confirming...");

    // 1. Cross-market isolation: xlm-90d busy must NOT disable usdc-90d's valid Swap button
    const mIsolated = await mountFrontendDom(
      React.createElement(
        WithSeededWallet,
        { address: TEST_CALLER },
        React.createElement(MarketProvider, {
          initialMarketId: "usdc-90d",
          children: React.createElement(SwapCard, {
            snapshot,
            portfolio,
            busyAction: null,
            busyActions: {
              [`${xlm90d.contracts.poolId}:swap_exact_sy_for_pt`]: "Swapping XLM...",
            },
            onExecuteAction: async () => {},
          }),
        })
      )
    );
    try {
      // Click "25%" preset button so SwapCard has a valid quoted amount and CTA becomes enabled
      const pct25 = [...mIsolated.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "25%"
      );
      expect(pct25).toBeDefined();
      await act(async () => {
        pct25!.click();
      });

      const cta = [...mIsolated.container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("Execute Swap")
      );
      expect(cta).toBeDefined();
      expect(cta!.textContent?.trim()).toBe("Execute Swap");
      expect(cta!.disabled).toBe(false);
    } finally {
      mIsolated.window.localStorage.removeItem("stellar_pendle_wallet_session");
      await mIsolated.unmount();
    }

    // 2. Positive lock: usdc-90d's own swap_exact_sy_for_pt busy key MUST lock usdc-90d's Swap button
    const mOwn = await mountFrontendDom(
      React.createElement(
        WithSeededWallet,
        { address: TEST_CALLER },
        React.createElement(MarketProvider, {
          initialMarketId: "usdc-90d",
          children: React.createElement(SwapCard, {
            snapshot,
            portfolio,
            busyAction: null,
            busyActions: {
              [`${usdc90d.contracts.poolId}:swap_exact_sy_for_pt`]: "Confirming...",
            },
            onExecuteAction: async () => {},
          }),
        })
      )
    );
    try {
      const pct25 = [...mOwn.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "25%"
      );
      expect(pct25).toBeDefined();
      await act(async () => {
        pct25!.click();
      });

      const cta = [...mOwn.container.querySelectorAll("button")].find(
        (b) =>
          (b.textContent ?? "").includes("Confirming...") ||
          (b.textContent ?? "").includes("Execute Swap")
      );
      expect(cta).toBeDefined();
      expect(cta!.textContent?.trim()).toBe("Confirming...");
      expect(cta!.disabled).toBe(true);
    } finally {
      mOwn.window.localStorage.removeItem("stellar_pendle_wallet_session");
      await mOwn.unmount();
    }
  });

  it("T2-F11.5: sUSDC routes case-insensitively, filters under Stables, avoids Blend collision, and renders in MarketExplorerTable", () => {
    const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
    const sUsdc = PRESET_MARKETS.find(
      (m) =>
        m.sySymbol === "sy-sUSDC" ||
        /susdc|slender/i.test(m.id) ||
        /susdc|slender/i.test(m.name)
    );
    expect(sUsdc).toBeDefined();

    const resolved = getMarketDefinition(`  ${sUsdc!.id.toUpperCase()}  `);
    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe(sUsdc!.id);
    expect(sUsdc!.contracts.poolId).not.toBe(usdc90d.contracts.poolId);
    expect(sUsdc!.contracts.syId).not.toBe(usdc90d.contracts.syId);

    const bySyId = filterAndSortMarkets(
      PRESET_MARKETS,
      "Stables",
      sUsdc!.contracts.syId
    );
    expect(bySyId.some((m) => m.id === sUsdc!.id)).toBe(true);
    expect(bySyId.some((m) => m.id === usdc90d.id)).toBe(false);

    const byLabel = filterAndSortMarkets(PRESET_MARKETS, "Stables", "sUSDC");
    expect(byLabel.some((m) => m.id === sUsdc!.id)).toBe(true);

    const html = renderFrontendHtml(
      React.createElement(
        WalletProvider,
        null,
        React.createElement(
          MarketProvider,
          null,
          React.createElement(MarketExplorerTable)
        )
      )
    );
    expect(html).toContain(usdc90d.ptSymbol);
    expect(html).toContain(sUsdc!.ptSymbol);
  });
});
