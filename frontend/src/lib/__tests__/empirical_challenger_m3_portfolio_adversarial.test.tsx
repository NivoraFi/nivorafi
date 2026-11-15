// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

// ----------------------------------------------------------------------------
// MOCK WALLET CONTEXT FOR CONTROLLED HOOK & SSR EVALUATION
// ----------------------------------------------------------------------------
let currentMockWallet = {
  address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27" as string | null,
  mode: "wallet" as "disconnected" | "wallet" | "watch",
  walletId: "freighter" as string | null,
  walletNetworkMismatch: false,
  kitReady: true,
  connecting: false,
  connectWallet: async () => {},
  connectWatchAddress: (_pk: string) => {},
  disconnect: async () => {},
  signTransactionXdr: async (xdr: string) => xdr,
  switchNetwork: async () => {},
};

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => currentMockWallet,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => currentMockWallet.walletNetworkMismatch,
}));

import { PRESET_MARKETS, MarketDefinition, MarketSummaryMetrics } from "../markets";
import { LiveUserPortfolio } from "../stellar";
import {
  parseMarketPosition,
  aggregatePortfolioTotals,
  calculateWeightedApy,
  ASSET_USD_PRICES,
  MarketPositionItem,
} from "../../hooks/useMultiMarketPortfolio";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { MarketProvider } from "@/context/MarketContext";
import { decodeSorobanError } from "../math";

describe("Empirical Challenger M3: Adversarial Portfolio Aggregation, Math & RPC Resilience", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

  const createEmptyPortfolio = (address = dummyCaller): LiveUserPortfolio => ({
    address,
    accountExists: true,
    xlmBalance: "100.00",
    usdcBalance: "0.00",
    usdcTrustlineExists: true,
    syBalance: 0n,
    ptBalance: 0n,
    ytBalance: 0n,
    lpBalance: 0n,
    lastIndex: 0n,
    unclaimedYieldRaw: 0n,
    estimatedPendingYieldSy: 0n,
  });

  // ==========================================================================
  // SUITE 1: EMPTY WALLET (0 BALANCES ACROSS ALL 3 MARKETS)
  // ==========================================================================
  describe("Suite 1: Empty Wallet Matrix (0 Balances Across All 3 Markets)", () => {
    it("1.1 parses 0 balances across all 3 markets with hasPosition=false and zero valuation", () => {
      const verifiedMarkets = [usdc90D, usdc30D, xlm90D];
      const emptyPort = createEmptyPortfolio();

      const positions = verifiedMarkets.map((m) => parseMarketPosition(m, emptyPort));

      expect(positions).toHaveLength(3);
      for (const pos of positions) {
        expect(pos.hasPosition).toBe(false);
        expect(pos.ptBalance).toBe(0n);
        expect(pos.ytBalance).toBe(0n);
        expect(pos.lpBalance).toBe(0n);
        expect(pos.syBalance).toBe(0n);
        expect(pos.claimableYield).toBe(0n);
        expect(pos.estimatedValue).toBe(0.0);
        expect(pos.totalValueUsd).toBe(0.0);
        expect(pos.ptValueUsd).toBe(0.0);
        expect(pos.ytValueUsd).toBe(0.0);
        expect(pos.lpValueUsd).toBe(0.0);
        expect(pos.claimableYieldUsd).toBe(0.0);
        expect(pos.formattedPtBalance).toBe("0");
        expect(pos.formattedYtBalance).toBe("0");
        expect(pos.formattedLpBalance).toBe("0");
        expect(pos.formattedClaimableYieldSy).toBe("0");
      }
    });

    it("1.2 aggregatePortfolioTotals produces zero net worth and clamps weighted APY without NaN", () => {
      const verifiedMarkets = [usdc90D, usdc30D, xlm90D];
      const emptyPort = createEmptyPortfolio();
      const positions = verifiedMarkets.map((m) => parseMarketPosition(m, emptyPort));

      const totals = aggregatePortfolioTotals(positions);

      expect(totals.totalPortfolioValue).toBe(0.0);
      expect(totals.totalPortfolioValueUsd).toBe(0.0);
      expect(totals.totalClaimableYield).toBe(0n);
      expect(totals.totalClaimableYieldUsd).toBe(0.0);
      expect(totals.activePositionsCount).toBe(0);
      expect(totals.maturedPositionsCount).toBe(0);
      expect(totals.hasMaturedPositions).toBe(false);
      // Zero division guard check: weightedApyPct must strictly equal 0.0, NOT NaN
      expect(totals.weightedApyPct).toBe(0.0);
      expect(Number.isNaN(totals.weightedApyPct)).toBe(false);
    });

    it("1.3 PortfolioView renders clean zero-balance state with 'Explore Markets' CTA and $0.00 KPIs", () => {
      const emptyPortfolios: Record<string, LiveUserPortfolio> = {
        "usdc-90d": createEmptyPortfolio(),
        "usdc-30d": createEmptyPortfolio(),
        "xlm-90d": createEmptyPortfolio(),
      };

      const html = renderToString(
        <MarketProvider>
          <PortfolioView userPortfolios={emptyPortfolios} />
        </MarketProvider>
      );

      // Verify zero runtime crash
      expect(html).toBeTruthy();
      // Zero-balance banner verification
      expect(html).toContain("No Active Positions");
      expect(html).toContain("Explore Markets");
      // KPI verification
      const cleanHtml = html.replace(/<!-- -->/g, "");
      expect(cleanHtml).toContain("$0.00");
      expect(cleanHtml).not.toContain("NaN");
      expect(cleanHtml).not.toContain("undefined");
      expect(cleanHtml).not.toContain("null");
    });
  });

  // ==========================================================================
  // SUITE 2: MIXED BALANCES MATRIX
  // (PT in market 1, LP in market 2, zero in market 3)
  // ==========================================================================
  describe("Suite 2: Mixed Balances Matrix (PT in M1, LP in M2, 0 in M3)", () => {
    const market1Port: LiveUserPortfolio = {
      address: dummyCaller,
      accountExists: true,
      xlmBalance: "100.00",
      usdcBalance: "1000.00",
      usdcTrustlineExists: true,
      syBalance: 0n,
      ptBalance: 2500_0000000n, // 2,500 PT
      ytBalance: 0n,
      lpBalance: 0n,
      lastIndex: 0n,
      unclaimedYieldRaw: 0n,
      estimatedPendingYieldSy: 0n,
    };

    const market2Port: LiveUserPortfolio = {
      address: dummyCaller,
      accountExists: true,
      xlmBalance: "100.00",
      usdcBalance: "1000.00",
      usdcTrustlineExists: true,
      syBalance: 0n,
      ptBalance: 0n,
      ytBalance: 0n,
      lpBalance: 1200_0000000n, // 1,200 LP
      lastIndex: 0n,
      unclaimedYieldRaw: 0n,
      estimatedPendingYieldSy: 0n,
    };

    const market3Port: LiveUserPortfolio = createEmptyPortfolio(); // 0 in Market 3

    it("2.1 parses individual positions correctly with accurate hasPosition flags", () => {
      const pos1 = parseMarketPosition(usdc90D, market1Port);
      const pos2 = parseMarketPosition(usdc30D, market2Port);
      const pos3 = parseMarketPosition(xlm90D, market3Port);

      // Market 1: PT only
      expect(pos1.hasPosition).toBe(true);
      expect(pos1.ptBalance).toBe(2500_0000000n);
      expect(pos1.lpBalance).toBe(0n);
      expect(pos1.formattedPtBalance).toBe("2500");
      expect(pos1.formattedLpBalance).toBe("0");
      // 2500 PT * 0.98 price in SY * 1.0 blend * $1.00 USDC = $2450.00
      expect(pos1.estimatedValue).toBeCloseTo(2450.0, 1);

      // Market 2: LP only
      expect(pos2.hasPosition).toBe(true);
      expect(pos2.ptBalance).toBe(0n);
      expect(pos2.lpBalance).toBe(1200_0000000n);
      expect(pos2.formattedPtBalance).toBe("0");
      expect(pos2.formattedLpBalance).toBe("1200");
      // 1200 LP * 1.0 parity * 1.0 blend * $1.00 USDC = $1200.00
      expect(pos2.estimatedValue).toBeCloseTo(1200.0, 1);

      // Market 3: Zero balances
      expect(pos3.hasPosition).toBe(false);
      expect(pos3.ptBalance).toBe(0n);
      expect(pos3.lpBalance).toBe(0n);
      expect(pos3.estimatedValue).toBe(0.0);
    });

    it("2.2 aggregates mixed positions: activePositionsCount=2, excluding zero market from count & APY dilution", () => {
      const pos1 = parseMarketPosition(usdc90D, market1Port, {
        marketId: "usdc-90d",
        status: "ACTIVE",
        daysToMaturity: 90,
        impliedApyPct: 10.0,
        blendRate: 1.0,
        ptPriceInSy: 0.98,
        tvlSy: 10000_0000000n,
        tvlUsd: 10000,
        ptReserve: 5000_0000000n,
        syReserve: 5000_0000000n,
        isMatured: false,
        isLoading: false,
      });

      const pos2 = parseMarketPosition(usdc30D, market2Port, {
        marketId: "usdc-30d",
        status: "ACTIVE",
        daysToMaturity: 30,
        impliedApyPct: 6.0,
        blendRate: 1.0,
        ptPriceInSy: 0.99,
        tvlSy: 10000_0000000n,
        tvlUsd: 10000,
        ptReserve: 5000_0000000n,
        syReserve: 5000_0000000n,
        isMatured: false,
        isLoading: false,
      });

      const pos3 = parseMarketPosition(xlm90D, market3Port, {
        marketId: "xlm-90d",
        status: "ACTIVE",
        daysToMaturity: 90,
        impliedApyPct: 15.0, // High APY on market 3 with 0 balance
        blendRate: 1.0,
        ptPriceInSy: 0.98,
        tvlSy: 10000_0000000n,
        tvlUsd: 1200,
        ptReserve: 5000_0000000n,
        syReserve: 5000_0000000n,
        isMatured: false,
        isLoading: false,
      });

      const totals = aggregatePortfolioTotals([pos1, pos2, pos3]);

      // Active count must be strictly 2 (Market 1 and 2), Market 3 has zero balance so NOT counted
      expect(totals.activePositionsCount).toBe(2);
      expect(totals.maturedPositionsCount).toBe(0);

      // Total portfolio value = pos1 ($2450) + pos2 ($1200) + pos3 ($0) = $3650
      expect(totals.totalPortfolioValue).toBeCloseTo(3650.0, 1);

      // Weighted APY must be: (2450 * 10% + 1200 * 6%) / (2450 + 1200) = (24500 + 7200) / 3650 = 8.6849%
      // Market 3's 15% APY must NOT dilute or skew the result because its value is 0!
      const expectedWeightedApy = (2450 * 10.0 + 1200 * 6.0) / 3650.0;
      expect(totals.weightedApyPct).toBeCloseTo(expectedWeightedApy, 3);
    });

    it("2.3 PortfolioView renders mixed portfolio breakdown table and omits 'No Active Positions' banner", () => {
      const mixedPortfolios: Record<string, LiveUserPortfolio> = {
        "usdc-90d": market1Port,
        "usdc-30d": market2Port,
        "xlm-90d": market3Port,
      };

      const html = renderToString(
        <MarketProvider>
          <PortfolioView userPortfolios={mixedPortfolios} />
        </MarketProvider>
      );

      const cleanHtml = html.replace(/<!-- -->/g, "");
      // Must NOT render empty state banner
      expect(cleanHtml).not.toContain("No Active Positions");
      // Must render market breakdown table
      expect(cleanHtml).toContain("Market Positions Breakdown");
      expect(cleanHtml).toContain("4 Markets Tracked");
      // Must show PT for Market 1
      expect(cleanHtml).toContain("2500");
      // Must show LP for Market 2
      expect(cleanHtml).toContain("1200");
      // Must contain Trade, Redeem, Rollover action buttons
      expect(cleanHtml).toContain("Trade");
      expect(cleanHtml).toContain("Redeem");
      expect(cleanHtml).toContain("Rollover");
      // Must not have NaN
      expect(cleanHtml).not.toContain("NaN");
    });
  });

  // ==========================================================================
  // SUITE 3: PRECISION, YIELD ACCRUAL & NUMERICAL FUZZING
  // ==========================================================================
  describe("Suite 3: Yield Accrual, Valuation Precision & Numerical Fuzzing", () => {
    it("3.1 verifies yield accrual logic under zero divisors and index shifts", () => {
      // In stellar.ts yield formula:
      // if (lastIndex > 0n && bRate > lastIndex && ytBalanceState > 0n) {
      //   accruedRaw += (ytBalanceState * (bRate - lastIndex)) / lastIndex;
      // }
      // const estimatedPendingYieldSy = bRate > 0n ? (accruedRaw * SCALAR_9) / bRate : 0n;

      const SCALAR_9 = 1_000_000_000n;

      // Case A: lastIndex = 0n (initial state before index snapshot) -> division by zero protected
      const ytBal = 1000_0000000n;
      const bRate = 1_100000000n; // 1.10
      let lastIndex = 0n;
      let unclaimed = 0n;

      let accrued = unclaimed;
      if (lastIndex > 0n && bRate > lastIndex && ytBal > 0n) {
        accrued += (ytBal * (bRate - lastIndex)) / lastIndex;
      }
      let pendingYield = bRate > 0n ? (accrued * SCALAR_9) / bRate : 0n;
      expect(pendingYield).toBe(0n); // Protected from divide-by-zero

      // Case B: bRate <= lastIndex (rebase down or unchanged) -> no negative accrued
      lastIndex = 1_200000000n;
      const lowerBRate = 1_150000000n;
      accrued = unclaimed;
      if (lastIndex > 0n && lowerBRate > lastIndex && ytBal > 0n) {
        accrued += (ytBal * (lowerBRate - lastIndex)) / lastIndex;
      }
      pendingYield = lowerBRate > 0n ? (accrued * SCALAR_9) / lowerBRate : 0n;
      expect(pendingYield).toBe(0n);

      // Case C: bRate > lastIndex (normal yield accrual)
      lastIndex = 1_000000000n; // 1.00
      const currentRate = 1_050000000n; // 1.05
      accrued = unclaimed;
      if (lastIndex > 0n && currentRate > lastIndex && ytBal > 0n) {
        accrued += (ytBal * (currentRate - lastIndex)) / lastIndex;
      }
      // accrued = 1000_0000000 * 50_000_000 / 1_000_000_000 = 50_0000000 (50 stroops)
      expect(accrued).toBe(50_0000000n);
      pendingYield = currentRate > 0n ? (accrued * SCALAR_9) / currentRate : 0n;
      // pendingYield = 50_0000000 * 1e9 / 1.05e9 = 47.6190476 SY
      expect(pendingYield).toBeGreaterThan(0n);
    });

    it("3.2 maintains precision on extreme 128-bit BigInt balances and 1 stroop micro-amounts", () => {
      // 1 billion tokens whale balance (1e16 stroops)
      const whalePortfolio: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "1000000000.00",
        usdcTrustlineExists: true,
        syBalance: 1_000_000_000_0000000n,
        ptBalance: 1_000_000_000_0000000n,
        ytBalance: 1_000_000_000_0000000n,
        lpBalance: 1_000_000_000_0000000n,
        lastIndex: 1_000000000n,
        unclaimedYieldRaw: 50_000_000_0000000n,
        estimatedPendingYieldSy: 50_000_000_0000000n,
      };

      const whalePos = parseMarketPosition(usdc90D, whalePortfolio);
      expect(Number.isFinite(whalePos.estimatedValue)).toBe(true);
      expect(Number.isNaN(whalePos.estimatedValue)).toBe(false);
      expect(whalePos.estimatedValue).toBeGreaterThan(3_000_000_000);

      // Micro balance: exactly 1 stroop (0.0000001 tokens)
      const microPortfolio: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "0.0000001",
        usdcTrustlineExists: true,
        syBalance: 1n,
        ptBalance: 1n,
        ytBalance: 1n,
        lpBalance: 1n,
        lastIndex: 1_000000000n,
        unclaimedYieldRaw: 1n,
        estimatedPendingYieldSy: 1n,
      };

      const microPos = parseMarketPosition(usdc90D, microPortfolio);
      expect(microPos.hasPosition).toBe(true);
      expect(Number.isFinite(microPos.estimatedValue)).toBe(true);
      expect(Number.isNaN(microPos.estimatedValue)).toBe(false);
      expect(microPos.estimatedValue).toBeGreaterThan(0);
      expect(microPos.formattedPtBalance).toBe("0"); // formatUnits with 4 decimal clamp strips trailing zeros
    });

    it("3.3 stress-tests portfolio math with 500 randomized parameter vectors (Fuzzing)", () => {
      const verifiedMarkets = [usdc90D, usdc30D, xlm90D];

      for (let i = 0; i < 500; i++) {
        // Generate pseudo-random stroop amounts up to 100 million
        const randPt = BigInt(Math.floor(Math.random() * 100_000_000)) * 10000000n;
        const randYt = BigInt(Math.floor(Math.random() * 100_000_000)) * 10000000n;
        const randLp = BigInt(Math.floor(Math.random() * 100_000_000)) * 10000000n;
        const randSy = BigInt(Math.floor(Math.random() * 100_000_000)) * 10000000n;
        const randYield = BigInt(Math.floor(Math.random() * 10_000_000)) * 10000000n;

        const fuzzPort: LiveUserPortfolio = {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100.00",
          usdcBalance: "1000.00",
          usdcTrustlineExists: true,
          syBalance: randSy,
          ptBalance: randPt,
          ytBalance: randYt,
          lpBalance: randLp,
          lastIndex: 1000000000n,
          unclaimedYieldRaw: randYield,
          estimatedPendingYieldSy: randYield,
        };

        const randMetric: MarketSummaryMetrics = {
          marketId: "usdc-90d",
          status: "ACTIVE",
          daysToMaturity: Math.floor(Math.random() * 180) + 1,
          impliedApyPct: Math.random() * 30.0,
          blendRate: 0.8 + Math.random() * 0.5,
          ptPriceInSy: 0.8 + Math.random() * 0.2,
          tvlSy: 100000_0000000n,
          tvlUsd: 100000,
          ptReserve: 50000_0000000n,
          syReserve: 50000_0000000n,
          isMatured: false,
          isLoading: false,
        };

        const targetMarket = verifiedMarkets[i % verifiedMarkets.length];
        const pos = parseMarketPosition(targetMarket, fuzzPort, randMetric);

        // Invariants
        expect(Number.isFinite(pos.estimatedValue)).toBe(true);
        expect(Number.isNaN(pos.estimatedValue)).toBe(false);
        expect(pos.estimatedValue).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(pos.ptValueUsd)).toBe(true);
        expect(Number.isFinite(pos.lpValueUsd)).toBe(true);
        expect(Number.isFinite(pos.claimableYieldUsd)).toBe(true);

        const totals = aggregatePortfolioTotals([pos]);
        expect(Number.isFinite(totals.totalPortfolioValue)).toBe(true);
        expect(Number.isNaN(totals.totalPortfolioValue)).toBe(false);
        expect(Number.isFinite(totals.weightedApyPct)).toBe(true);
        expect(Number.isNaN(totals.weightedApyPct)).toBe(false);
      }
    });
  });

  // ==========================================================================
  // SUITE 4: RPC QUERY FAILURE & PROMISE.ALL DEGRADATION ANALYSIS
  // ==========================================================================
  describe("Suite 4: RPC Failure & Degradation Under Promise.all", () => {
    it("4.1 empirically verifies hook error handling behavior when one RPC query rejects in Promise.all", async () => {
      // Replicate the exact concurrency logic from useMultiMarketPortfolio:
      // targetMarkets.map(async (m) => { ... }) with Promise.all
      const targetMarkets = [usdc90D, usdc30D, xlm90D];
      let caughtError: string | null = null;
      let isLoading = true;

      const fetchBalancesSim = async () => {
        try {
          await Promise.all(
            targetMarkets.map(async (m) => {
              if (m.id === "usdc-30d") {
                // Simulate Soroban RPC network timeout / Gateway error on Market 2
                throw new Error("Soroban RPC 504 Gateway Timeout: Endpoint unresponsive");
              }
              return { marketId: m.id, port: createEmptyPortfolio() };
            })
          );
        } catch (err: unknown) {
          caughtError = decodeSorobanError(err);
        } finally {
          isLoading = false;
        }
      };

      await fetchBalancesSim();

      // Observations:
      // 1. Error is caught without uncaught exception
      expect(caughtError).toContain("504 Gateway Timeout");
      // 2. isLoading is safely reset to false
      expect(isLoading).toBe(false);
    });

    it("4.2 documents and demonstrates Promise.all vs Promise.allSettled architectural behavior", async () => {
      const targetMarkets = [usdc90D, usdc30D, xlm90D];

      // With Promise.all:
      let allFailed = false;
      try {
        await Promise.all(
          targetMarkets.map(async (m) => {
            if (m.id === "usdc-30d") throw new Error("RPC failure");
            return { marketId: m.id, port: createEmptyPortfolio() };
          })
        );
      } catch {
        allFailed = true;
      }
      // Confirmed: 1 market failure causes all markets to be dropped in the current batch
      expect(allFailed).toBe(true);

      // Contrast with Promise.allSettled:
      const settledResults = await Promise.allSettled(
        targetMarkets.map(async (m) => {
          if (m.id === "usdc-30d") throw new Error("RPC failure");
          return { marketId: m.id, port: createEmptyPortfolio() };
        })
      );

      const successfulMarkets = settledResults.filter(
        (r): r is PromiseFulfilledResult<{ marketId: string; port: LiveUserPortfolio }> =>
          r.status === "fulfilled"
      );
      const failedMarkets = settledResults.filter((r) => r.status === "rejected");

      // With allSettled: 2 markets succeed, 1 market fails gracefully
      expect(successfulMarkets).toHaveLength(2);
      expect(failedMarkets).toHaveLength(1);
    });

    it("4.3 PortfolioView renders without crashing even when error state is active", () => {
      // Render PortfolioView when wallet is connected but no balances loaded (simulating RPC failure fallback)
      const html = renderToString(
        <MarketProvider>
          <PortfolioView userPortfolios={{}} />
        </MarketProvider>
      );

      // Verify zero runtime crash
      expect(html).toBeTruthy();
      expect(html).toContain("No Active Positions");
      expect(html).not.toContain("NaN");
    });
  });

  // ==========================================================================
  // SUITE 5: SSR ROBUSTNESS & EDGE CASE IMMUNITY
  // ==========================================================================
  describe("Suite 5: SSR Robustness & Edge Case Immunity", () => {
    it("5.1 renders PortfolioView cleanly when userPortfolios is null or undefined", () => {
      const htmlNull = renderToString(
        <MarketProvider>
          <PortfolioView userPortfolios={null} />
        </MarketProvider>
      );
      expect(htmlNull).toBeTruthy();
      expect(htmlNull).not.toContain("NaN");

      const htmlUndefined = renderToString(
        <MarketProvider>
          <PortfolioView userPortfolios={undefined} />
        </MarketProvider>
      );
      expect(htmlUndefined).toBeTruthy();
      expect(htmlUndefined).not.toContain("NaN");
    });

    it("5.2 safely ignores unrecognized or malformed market entries in userPortfolios", () => {
      const roguePortfolios: Record<string, LiveUserPortfolio> = {
        "fake-market-xyz": createEmptyPortfolio(),
        "invalid-id": createEmptyPortfolio(),
      };

      const html = renderToString(
        <MarketProvider>
          <PortfolioView userPortfolios={roguePortfolios} />
        </MarketProvider>
      );

      expect(html).toBeTruthy();
      expect(html).not.toContain("NaN");
    });
  });
});
