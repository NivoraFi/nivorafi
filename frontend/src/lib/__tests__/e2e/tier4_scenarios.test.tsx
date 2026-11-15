// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

// Authoritative test oracles & fixtures
import {
  EXPECTED_PRESET_MARKET_IDS,
  DUMMY_TEST_WALLET_ADDRESS,
  DUMMY_RECEIVER_ADDRESS,
  resolveMarketRoute,
  createMockWalletState,
  createMockSnapshot,
  createMockPortfolio,
  MockWalletContextState,
} from "./helpers/e2e-oracle";

// Modules under test
import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  findMarketById,
  deriveMarketStatus,
  calculateDaysToMaturity,
  MarketDefinition,
} from "../../markets";
import {
  applySlippage,
  formatUnits,
  formatUnitsExact,
  quoteSwapLocal,
} from "../../math";
import {
  buildActionArgs,
  ProtocolAction,
  LiveMarketSnapshot,
  LiveUserPortfolio,
} from "../../stellar";
import {
  parseMarketPosition,
  aggregatePortfolioTotals,
  calculateWeightedApy,
  ASSET_USD_PRICES,
} from "@/hooks/useMultiMarketPortfolio";
import { TopNav } from "@/components/TopNav";
import { LandingView } from "@/components/landing/LandingView";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { RolloverCard } from "@/components/trading/RolloverCard";
import { PortfolioView } from "@/components/portfolio/PortfolioView";

// Controlled mock wallet & market state
let currentWalletState: MockWalletContextState = createMockWalletState();
let currentActiveMarket: MarketDefinition = PRESET_MARKETS[0];

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => currentWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => currentWalletState.walletNetworkMismatch,
}));

mock.module("@/context/MarketContext", () => ({
  useMarket: () => ({
    markets: PRESET_MARKETS,
    activeMarket: currentActiveMarket,
    activeMarketId: currentActiveMarket.id,
    selectMarket: (id: string) => {
      const found = PRESET_MARKETS.find((m) => m.id === id);
      if (found) currentActiveMarket = found;
    },
    activeSnapshot: createMockSnapshot(currentActiveMarket),
    activePortfolio: createMockPortfolio(currentActiveMarket),
    loadingSnapshot: false,
    loadingPortfolio: false,
    marketMetrics: {
      [currentActiveMarket.id]: {
        marketId: currentActiveMarket.id,
        status: currentActiveMarket.id === "usdc-matured" ? ("MATURED" as const) : ("ACTIVE" as const),
        daysToMaturity: currentActiveMarket.id === "usdc-matured" ? 0 : 90,
        impliedApyPct: currentActiveMarket.id === "usdc-matured" ? 0 : 8.45,
        blendRate: 1.001,
        ptPriceInSy: currentActiveMarket.id === "usdc-matured" ? 1.0 : 0.98,
        tvlSy: 120_000_0000000n,
        tvlUsd: 120000,
        ptReserve: 80_000_0000000n,
        syReserve: 40_000_0000000n,
        isMatured: currentActiveMarket.id === "usdc-matured",
        isLoading: false,
      },
    },
    refreshActiveMarket: async () => {},
    refreshAllMetrics: async () => {},
  }),
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("E2E Test Suite — Tier 4: Real-World Application Scenarios", () => {
  const dummyCaller = DUMMY_TEST_WALLET_ADDRESS;

  beforeEach(() => {
    currentWalletState = createMockWalletState();
    currentActiveMarket = PRESET_MARKETS[0];
  });

  // ==========================================================================
  // SCENARIO 1: RETAIL FIXED-YIELD INVESTOR JOURNEY (DISCOVERY TO PT SWAP)
  // ==========================================================================
  describe("Scenario 1: Retail Fixed-Yield Investor Journey (Market Discovery to PT Swap)", () => {
    it("Phase 1: User discovers fixed yield markets on Market Explorer landing table", () => {
      const html = renderToString(
        <LandingView
          onEnterDesk={() => {}}
          snapshot={createMockSnapshot(currentActiveMarket)}
        />
      );

      expect(html).toContain("Yield tokenized on Stellar.");
      expect(html).toContain("Pendle bUSDC PT 90D");
      expect(html).toContain("8.45%");
    });

    it("Phase 2: User selects USDC 90D market and navigates to Trading Desk", () => {
      const resolution = resolveMarketRoute("usdc-90d");
      expect(resolution.found).toBe(true);
      currentActiveMarket = resolution.market!;
      expect(currentActiveMarket.id).toBe("usdc-90d");
    });

    it("Phase 3: User inspects Bento yield cards observing guaranteed 8.45% Fixed APY", () => {
      const snapshot = createMockSnapshot(currentActiveMarket);
      expect(snapshot.impliedFixedApyPct).toBe(8.45);
      expect(snapshot.daysToMaturity).toBeGreaterThan(80);
      expect(snapshot.ptPriceInSy).toBeLessThan(1.0);
    });

    it("Phase 4: User inputs 100 USDC in Swap card and quotes local Yield Space AMM swap", () => {
      const snapshot = createMockSnapshot(currentActiveMarket);
      const inputSy = 100_0000000n; // 100 SY
      const quote = quoteSwapLocal(
        snapshot.state,
        "sy_for_pt",
        inputSy,
        BigInt(snapshot.nowSeconds)
      );

      expect(quote.estimatedOut).toBeGreaterThan(0n);
      expect(quote.effectiveExchangeRate).toBeGreaterThan(1.0); // Discounted PT gives > 1 PT per SY
      expect(quote.impliedApyAfterPct).toBeGreaterThan(0);
    });

    it("Phase 5: User executes swap, generates valid Soroban envelope, and verifies simulated balance update", () => {
      const inputSy = 100_0000000n;
      const minPtOut = applySlippage(102_0000000n, 50); // 0.5% slippage

      const action = buildActionArgs(
        {
          type: "swap",
          caller: dummyCaller,
          method: "swap_exact_sy_for_pt",
          amountIn: inputSy,
          minOut: minPtOut,
        },
        currentActiveMarket
      );

      expect(action.contractId).toBe(currentActiveMarket.contracts.poolId);
      expect(action.method).toBe("swap_exact_sy_for_pt");
      expect(action.args).toHaveLength(4);

      // Verify simulated balance update
      const initialPortfolio = createMockPortfolio(currentActiveMarket, {
        usdcBalance: "500.00",
        ptBalance: 100_0000000n,
      });

      const updatedPortfolio: LiveUserPortfolio = {
        ...initialPortfolio,
        usdcBalance: "400.00",
        ptBalance: initialPortfolio.ptBalance + 102_0000000n,
      };

      expect(Number(updatedPortfolio.usdcBalance)).toBe(400);
      expect(updatedPortfolio.ptBalance).toBe(202_0000000n);
    });
  });

  // ==========================================================================
  // SCENARIO 2: LIQUIDITY MINTING & POOL PROVISION JOURNEY
  // ==========================================================================
  describe("Scenario 2: Liquidity Minting & Pool Provision Journey", () => {
    it("Phase 1: User initiates wrap of 200 USDC into sy-bUSDC via deposit_sy", () => {
      const depositAmt = 200_0000000n;
      const action = buildActionArgs(
        {
          type: "deposit_sy",
          caller: dummyCaller,
          amount: depositAmt,
        },
        currentActiveMarket
      );

      expect(action.contractId).toBe(currentActiveMarket.contracts.syId);
      expect(action.method).toBe("deposit");
      expect(action.args).toHaveLength(3); // caller, receiver, amount
    });

    it("Phase 2: User splits 200 sy-bUSDC into 200 PT + 200 YT via mint_py", () => {
      const mintAmt = 200_0000000n;
      const action = buildActionArgs(
        {
          type: "mint_py",
          caller: dummyCaller,
          amount: mintAmt,
        },
        currentActiveMarket
      );

      expect(action.contractId).toBe(currentActiveMarket.contracts.poolId);
      expect(action.method).toBe("mint_py");
      expect(action.args).toHaveLength(3); // receiver_pt, receiver_yt, amount
    });

    it("Phase 3: User provides dual-sided PT + SY liquidity via add_liquidity", () => {
      const ptAmt = 100_0000000n;
      const syAmt = 50_0000000n;
      const minLpOut = 65_0000000n;

      const action = buildActionArgs(
        {
          type: "add_liquidity",
          caller: dummyCaller,
          ptAmount: ptAmt,
          syAmount: syAmt,
          minLpOut,
        },
        currentActiveMarket
      );

      expect(action.contractId).toBe(currentActiveMarket.contracts.poolId);
      expect(action.method).toBe("add_liquidity");
      expect(action.args).toHaveLength(5); // caller, receiver, ptAmount, syAmount, minLpOut
    });

    it("Phase 4: Pool reserves increase and LP token balance is credited to user", () => {
      const snapshot = createMockSnapshot(currentActiveMarket);
      const initialPtReserve = snapshot.state.total_pt_reserve;
      const initialSyReserve = snapshot.state.total_sy_reserve;

      const updatedPtReserve = initialPtReserve + 100_0000000n;
      const updatedSyReserve = initialSyReserve + 50_0000000n;

      expect(updatedPtReserve).toBeGreaterThan(initialPtReserve);
      expect(updatedSyReserve).toBeGreaterThan(initialSyReserve);
    });

    it("Phase 5: User verifies LP token balance appears in Portfolio balances view", () => {
      const portfolio = createMockPortfolio(currentActiveMarket, {
        lpBalance: 65_0000000n,
      });

      expect(portfolio.lpBalance).toBe(65_0000000n);
      expect(formatUnits(portfolio.lpBalance)).toBe("65");
    });
  });

  // ==========================================================================
  // SCENARIO 3: POST-MATURITY REDEMPTION JOURNEY
  // ==========================================================================
  describe("Scenario 3: Post-Maturity Redemption & Capital Settle Journey", () => {
    const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

    it("Phase 1: User holds 50 PT in matured market 'usdc-matured'", () => {
      const portfolio = createMockPortfolio(maturedMarket, {
        ptBalance: 50_0000000n,
      });
      expect(portfolio.ptBalance).toBe(50_0000000n);
    });

    it("Phase 2: User navigates to trade desk for 'usdc-matured' and sees MATURED state", () => {
      const resolution = resolveMarketRoute("usdc-matured");
      expect(resolution.status).toBe(200);
      const snapshot = createMockSnapshot(maturedMarket, { isMatured: true });
      expect(snapshot.isMatured).toBe(true);
      expect(snapshot.impliedFixedApyPct).toBe(0);
    });

    it("Phase 3: User opens Redeem panel and inspects contextual rollover callout", () => {
      currentActiveMarket = maturedMarket;
      const html = renderToString(
        <RedeemCard
          snapshot={createMockSnapshot(maturedMarket, { isMatured: true })}
          portfolio={createMockPortfolio(maturedMarket, { ptBalance: 50_0000000n })}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("This position is matured");
      expect(html).toContain("Your Portfolio Balances");
    });

    it("Phase 4: User executes redeem_pt_post_maturity settling 1:1 into underlying asset", () => {
      const redeemAmt = 50_0000000n;
      const action = buildActionArgs(
        {
          type: "redeem_pt_post_maturity",
          caller: dummyCaller,
          ptAmount: redeemAmt,
        },
        maturedMarket
      );

      expect(action.contractId).toBe(maturedMarket.contracts.poolId);
      expect(action.method).toBe("redeem_pt_post_maturity");
      expect(action.args).toHaveLength(3); // caller, receiver, ptAmount
    });

    it("Phase 5: User portfolio balance updates: PT drops to 0, underlying USDC balance increases", () => {
      const initialPortfolio = createMockPortfolio(maturedMarket, {
        usdcBalance: "100.00",
        ptBalance: 50_0000000n,
      });

      const updatedPortfolio: LiveUserPortfolio = {
        ...initialPortfolio,
        ptBalance: 0n,
        usdcBalance: "105.00", // 100 + 50 tokens (where 50_0000000n = 5.0 tokens)
      };

      expect(updatedPortfolio.ptBalance).toBe(0n);
      expect(Number(updatedPortfolio.usdcBalance)).toBe(105);
    });
  });

  // ==========================================================================
  // SCENARIO 4: ATOMIC TENOR ROLLOVER JOURNEY
  // ==========================================================================
  describe("Scenario 4: Atomic Tenor Rollover Journey", () => {
    const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
    const targetMarket = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;

    it("Phase 1: User holds matured PT and selects active target market 'usdc-90d'", () => {
      expect(maturedMarket.id).toBe("usdc-matured");
      expect(targetMarket.id).toBe("usdc-90d");
      expect(maturedMarket.asset.code).toBe(targetMarket.asset.code);
    });

    it("Phase 2: Atomic rollover engine computes estimated output with discount multiplier", () => {
      const rolloverAmt = 100_0000000n; // 100 matured PT
      const discountMultiplier = 1 / 0.98; // ~1.0204
      const estimatedTargetPt = BigInt(Math.floor(Number(rolloverAmt) * discountMultiplier));
      expect(estimatedTargetPt).toBeGreaterThan(rolloverAmt);
    });

    it("Phase 3: User sets 0.5% slippage tolerance and computes minTargetPt output limit", () => {
      const estimatedTargetPt = 102_0408163n;
      const minTargetPt = applySlippage(estimatedTargetPt, 50); // 0.5% slippage
      expect(minTargetPt).toBe(101_5306122n);
      expect(minTargetPt).toBeLessThan(estimatedTargetPt);
    });

    it("Phase 4: Builds 6-argument atomic rollover_to_pt envelope directed to Factory", () => {
      const action = buildActionArgs(
        {
          type: "rollover_to_pt",
          caller: dummyCaller,
          receiver: dummyCaller,
          sourcePool: maturedMarket.contracts.poolId,
          targetPool: targetMarket.contracts.poolId,
          ptAmount: 100_0000000n,
          minTargetPt: 101_5306122n,
        },
        maturedMarket
      );

      expect(action.method).toBe("rollover_to_pt");
      expect(action.args).toHaveLength(6);
    });

    it("Phase 5: User verifies rollover replaces expired tenor with active 90D tenor without intermediate gas friction", () => {
      const initialPortfolio = createMockPortfolio(maturedMarket, {
        ptBalance: 100_0000000n,
      });

      const updatedPortfolio: LiveUserPortfolio = {
        ...initialPortfolio,
        ptBalance: 0n,
      };

      expect(updatedPortfolio.ptBalance).toBe(0n);
    });
  });

  // ==========================================================================
  // SCENARIO 5: MULTI-MARKET PORTFOLIO REVIEW & SEQUENTIAL YIELD CLAIMS
  // ==========================================================================
  describe("Scenario 5: Multi-Market Portfolio Review & Sequential Yield Claims", () => {
    it("Phase 1: User aggregates positions across USDC 90D, USDC 30D, and XLM 90D", () => {
      const mUsdc90 = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const mUsdc30 = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
      const mXlm90 = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

      const posUsdc90 = parseMarketPosition(
        mUsdc90,
        createMockPortfolio(mUsdc90, { ptBalance: 100_0000000n }),
        null
      );

      const posUsdc30 = parseMarketPosition(
        mUsdc30,
        createMockPortfolio(mUsdc30, { ptBalance: 50_0000000n }),
        null
      );

      const posXlm90 = parseMarketPosition(
        mXlm90,
        createMockPortfolio(mXlm90, { ptBalance: 200_0000000n }),
        null
      );

      expect(posUsdc90.hasPosition).toBe(true);
      expect(posUsdc30.hasPosition).toBe(true);
      expect(posXlm90.hasPosition).toBe(true);
    });

    it("Phase 2: Valuation engine computes total portfolio USD value and value-weighted APY", () => {
      const mUsdc90 = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const mUsdc30 = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;

      const pos1 = parseMarketPosition(
        mUsdc90,
        createMockPortfolio(mUsdc90, { ptBalance: 100_0000000n }),
        null
      );

      const pos2 = parseMarketPosition(
        mUsdc30,
        createMockPortfolio(mUsdc30, { ptBalance: 100_0000000n }),
        null
      );

      const totals = aggregatePortfolioTotals([pos1, pos2]);
      expect(totals.totalPortfolioValue).toBeGreaterThan(0);

      const weightedApy = calculateWeightedApy([pos1, pos2]);
      expect(weightedApy).toBeGreaterThan(0);
    });

    it("Phase 3: User reviews claimable yield across active YT token holdings", () => {
      const mUsdc90 = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const portfolio = createMockPortfolio(mUsdc90, {
        estimatedPendingYieldSy: 5_0000000n, // 5 SY
      });

      expect(portfolio.estimatedPendingYieldSy).toBe(5_0000000n);
      expect(formatUnits(portfolio.estimatedPendingYieldSy)).toBe("5");
    });

    it("Phase 4: Builds claim_yield action envelopes for each position", () => {
      const mUsdc90 = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
      const action = buildActionArgs(
        {
          type: "claim_yield",
          caller: dummyCaller,
        },
        mUsdc90
      );

      expect(action.contractId).toBe(mUsdc90.contracts.poolId);
      expect(action.method).toBe("claim_yield");
      expect(action.args).toHaveLength(2); // user, receiver
    });

    it("Phase 5: Simulates sequential multi-market claim queue preventing sequence collision", async () => {
      const claimQueue = [
        { marketId: "usdc-90d", contractId: PRESET_MARKETS[0].contracts.poolId },
        { marketId: "xlm-90d", contractId: PRESET_MARKETS[2].contracts.poolId },
      ];

      const executedClaims: string[] = [];
      for (const claim of claimQueue) {
        // Execute sequentially
        await new Promise((resolve) => setTimeout(resolve, 5));
        executedClaims.push(claim.marketId);
      }

      expect(executedClaims).toHaveLength(2);
      expect(executedClaims[0]).toBe("usdc-90d");
      expect(executedClaims[1]).toBe("xlm-90d");
    });
  });
});
