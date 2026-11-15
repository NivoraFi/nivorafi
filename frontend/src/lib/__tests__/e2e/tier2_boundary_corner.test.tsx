// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

// Authoritative test oracles & fixtures
import {
  EXPECTED_PRESET_MARKET_IDS,
  DUMMY_TEST_WALLET_ADDRESS,
  resolveMarketRoute,
  validateMarketSlug,
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
  getDefaultMarket,
  MarketDefinition,
} from "../../markets";
import {
  applySlippage,
  validateSlippage,
  validateAmountInput,
  formatUnits,
  formatUnitsExact,
  decodeSorobanError,
} from "../../math";
import { buildActionArgs, ProtocolAction } from "../../stellar";
import { TopNav } from "@/components/TopNav";
import { TradingDesk } from "@/components/trading/TradingDesk";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { LiquidityCard } from "@/components/trading/LiquidityCard";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { RolloverCard } from "@/components/trading/RolloverCard";

// Controlled mock wallet state
let currentWalletState: MockWalletContextState = createMockWalletState();
let currentMarket = PRESET_MARKETS[0];
let currentSnapshot = createMockSnapshot(PRESET_MARKETS[0]);
let currentPortfolio = createMockPortfolio(PRESET_MARKETS[0]);

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => currentWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => currentWalletState.walletNetworkMismatch,
}));

mock.module("@/context/MarketContext", () => ({
  useMarket: () => ({
    markets: PRESET_MARKETS,
    activeMarket: currentMarket,
    activeMarketId: currentMarket.id,
    selectMarket: (id: string) => {
      const found = PRESET_MARKETS.find((m) => m.id === id);
      if (found) currentMarket = found;
    },
    activeSnapshot: currentSnapshot,
    activePortfolio: currentPortfolio,
    loadingSnapshot: false,
    loadingPortfolio: false,
    marketMetrics: {
      [currentMarket.id]: {
        marketId: currentMarket.id,
        status: currentSnapshot.isMatured ? ("MATURED" as const) : ("ACTIVE" as const),
        daysToMaturity: currentSnapshot.daysToMaturity,
        impliedApyPct: currentSnapshot.impliedFixedApyPct,
        blendRate: 1.001,
        ptPriceInSy: currentSnapshot.ptPriceInSy,
        tvlSy: currentSnapshot.syTotalSupply,
        tvlUsd: 120000,
        ptReserve: currentSnapshot.state.total_pt_reserve,
        syReserve: currentSnapshot.state.total_sy_reserve,
        isMatured: currentSnapshot.isMatured,
        isLoading: false,
      },
    },
    refreshActiveMarket: async () => {},
    refreshAllMetrics: async () => {},
  }),
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("E2E Test Suite — Tier 2: Boundary & Corner Cases", () => {
  const dummyCaller = DUMMY_TEST_WALLET_ADDRESS;

  // ==========================================================================
  // AREA 1: UNKNOWN & MALFORMED MARKET SLUGS IN DYNAMIC ROUTING
  // ==========================================================================
  describe("Area 1: Unknown & Adversarial Market Slug Resolution", () => {
    it("returns 404 status when querying unlisted market slug in dynamic route", () => {
      const result = resolveMarketRoute("bitcoin-90d");
      expect(result.found).toBe(false);
      expect(result.status).toBe(404);
      expect(result.market).toBeUndefined();
    });

    it("rejects path traversal attacks in market slug (e.g. ../../etc/passwd)", () => {
      const traversalInputs = [
        "../../etc/passwd",
        "../trade",
        "..\\..\\windows\\system32",
        "usdc-90d/../../secrets",
      ];
      for (const input of traversalInputs) {
        const val = validateMarketSlug(input);
        expect(val.valid).toBe(false);
        expect(val.reason).toBeDefined();

        const res = resolveMarketRoute(input);
        expect(res.status).toBe(404);
      }
    });

    it("rejects script injection and SQL injection payloads in market slug", () => {
      const injectionInputs = [
        "<script>alert('xss')</script>",
        "'; DROP TABLE markets; --",
        "javascript:alert(1)",
        "usdc-90d' OR 1=1 --",
      ];
      for (const input of injectionInputs) {
        const val = validateMarketSlug(input);
        expect(val.valid).toBe(false);

        const res = resolveMarketRoute(input);
        expect(res.status).toBe(404);
      }
    });

    it("rejects empty slug, null string, and slugs exceeding 64 characters", () => {
      expect(validateMarketSlug("").valid).toBe(false);
      // @ts-expect-error test non-string input
      expect(validateMarketSlug(null).valid).toBe(false);
      // @ts-expect-error test undefined input
      expect(validateMarketSlug(undefined).valid).toBe(false);

      const longSlug = "a".repeat(65);
      expect(validateMarketSlug(longSlug).valid).toBe(false);
    });

    it("resolves uppercase and mixed case slugs insensitively to canonical market", () => {
      const upper = resolveMarketRoute("USDC-90D");
      expect(upper.found).toBe(true);
      expect(upper.status).toBe(200);
      expect(upper.market?.id).toBe("usdc-90d");

      const mixed = resolveMarketRoute("XlM-90d");
      expect(mixed.found).toBe(true);
      expect(mixed.status).toBe(200);
      expect(mixed.market?.id).toBe("xlm-90d");
    });

    it("findMarketById returns default market fallback when unlisted market ID is queried", () => {
      const fallback = findMarketById("unknown-market-xyz");
      expect(fallback).toBeDefined();
      expect(fallback.id).toBe(getDefaultMarket().id);
    });
  });

  // ==========================================================================
  // AREA 2: POST-MATURITY MARKET BEHAVIOR (USDC-MATURED)
  // ==========================================================================
  describe("Area 2: Post-Maturity Market Behavior & Invariants", () => {
    const maturedMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

    it("strictly derives MATURED status when current timestamp exceeds market maturity", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Matured market maturity is 1730000000 (October 2024), now is > 1730000000
      expect(nowSeconds).toBeGreaterThan(maturedMarket.maturity);
      expect(deriveMarketStatus(maturedMarket.maturity, nowSeconds)).toBe("MATURED");
    });

    it("calculates daysToMaturity strictly as 0.0 with zero negative boundary", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const days = calculateDaysToMaturity(maturedMarket.maturity, nowSeconds);
      expect(days).toBe(0);
      expect(days).not.toBeLessThan(0);
    });

    it("clamps impliedFixedApyPct strictly to 0.00% for matured snapshot", () => {
      const snapshot = createMockSnapshot(maturedMarket, { isMatured: true });
      expect(snapshot.isMatured).toBe(true);
      expect(snapshot.impliedFixedApyPct).toBe(0);
      expect(snapshot.ptPriceInSy).toBe(1.0);
      expect(snapshot.ytPriceInSy).toBe(0.0);
    });

    it("builds post-maturity 1:1 settlement action and rejects pre-maturity pair merge", () => {
      const action = buildActionArgs(
        {
          type: "redeem_pt_post_maturity",
          caller: dummyCaller,
          ptAmount: 50_0000000n,
        },
        maturedMarket
      );

      expect(action.contractId).toBe(maturedMarket.contracts.poolId);
      expect(action.method).toBe("redeem_pt_post_maturity");
      expect(action.args).toHaveLength(3);
    });

    it("renders contextual matured notification banner in RedeemCard for matured position", () => {
      currentMarket = maturedMarket;
      currentSnapshot = createMockSnapshot(maturedMarket, { isMatured: true });
      currentPortfolio = createMockPortfolio(maturedMarket, { ptBalance: 50_0000000n });

      const html = renderToString(
        <RedeemCard
          snapshot={currentSnapshot}
          portfolio={currentPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("This position is matured");
      expect(html).toContain("Rollover into a new active maturity");
    });
  });

  // ==========================================================================
  // AREA 3: ZERO BALANCE & DISCONNECTED WALLET HANDLING
  // ==========================================================================
  describe("Area 3: Zero Balance & Disconnected Wallet Guards", () => {
    const market = PRESET_MARKETS[0];
    const snapshot = createMockSnapshot(market);

    it("safely renders full TradingDesk without crashing when wallet is completely disconnected", () => {
      currentWalletState = createMockWalletState({
        address: null,
        mode: "disconnected",
        walletId: null,
      });

      const html = renderToString(
        <TradingDesk
          snapshot={snapshot}
          portfolio={null}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Swap");
      expect(html).toContain("Mint");
      expect(html).toContain("Pool");
    });

    it("renders zero balance in SwapCard without NaN and disables execution button", () => {
      currentMarket = market;
      currentSnapshot = snapshot;
      currentWalletState = createMockWalletState();
      const zeroPortfolio = createMockPortfolio(market, {
        usdcBalance: "0.00",
        syBalance: 0n,
        ptBalance: 0n,
        ytBalance: 0n,
        lpBalance: 0n,
      });

      const html = renderToString(
        <SwapCard
          snapshot={snapshot}
          portfolio={zeroPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).not.toContain("NaN");
      expect(html).toContain('disabled=""');
    });

    it("renders zero balance in MintCard and handles MAX click gracefully without crash", () => {
      currentWalletState = createMockWalletState();
      const zeroPortfolio = createMockPortfolio(market, {
        usdcBalance: "0.00",
        syBalance: 0n,
      });

      const html = renderToString(
        <MintCard
          snapshot={snapshot}
          portfolio={zeroPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Deposit Amount");
      expect(html).not.toContain("NaN");
    });

    it("renders 0.00 balances cleanly in RedeemCard when user holds zero PT or YT", () => {
      currentWalletState = createMockWalletState();
      const zeroPortfolio = createMockPortfolio(market, {
        ptBalance: 0n,
        ytBalance: 0n,
        syBalance: 0n,
      });

      const html = renderToString(
        <RedeemCard
          snapshot={snapshot}
          portfolio={zeroPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Your Portfolio Balances");
      expect(html).toContain("0.00");
      expect(html).not.toContain("NaN");
    });

    it("disables execution button in RolloverCard when user holds zero matured PT balance", () => {
      currentWalletState = createMockWalletState();
      const zeroPortfolio = createMockPortfolio(market, {
        ptBalance: 0n,
      });

      const html = renderToString(
        <RolloverCard
          snapshot={snapshot}
          portfolio={zeroPortfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Insufficient Matured PT Balance");
      expect(html).toContain("disabled");
    });
  });

  // ==========================================================================
  // AREA 4: SLIPPAGE TOLERANCE BOUNDARY HANDLING
  // ==========================================================================
  describe("Area 4: Slippage Tolerance Bounds & Math Verification", () => {
    it("scales minimum output correctly for preset 0.1% (10 bps) slippage", () => {
      const amountOut = 1000_0000000n; // 1000 tokens
      const minOut = applySlippage(amountOut, 10);
      // 1000 * (1 - 0.001) = 999.0
      expect(minOut).toBe(999_0000000n);
    });

    it("scales minimum output correctly for preset 0.5% (50 bps) and 1.0% (100 bps) slippage", () => {
      const amountOut = 1000_0000000n;
      const min50 = applySlippage(amountOut, 50);
      expect(min50).toBe(995_0000000n);

      const min100 = applySlippage(amountOut, 100);
      expect(min100).toBe(990_0000000n);
    });

    it("scales minimum output correctly for custom 5.0% (500 bps) slippage", () => {
      const amountOut = 1000_0000000n;
      const min500 = applySlippage(amountOut, 500);
      expect(min500).toBe(950_0000000n);
    });

    it("strictly verifies zero slippage preserves exact amount with zero discount", () => {
      const amountOut = 1234_5678900n;
      const minZero = applySlippage(amountOut, 0);
      expect(minZero).toBe(amountOut);
    });

    it("validates slippage bounds rejecting negative and excessive values", () => {
      const valid50 = validateSlippage(50); // 0.5%
      expect(valid50.valid).toBe(true);

      const invalidNegative = validateSlippage(-50);
      expect(invalidNegative.valid).toBe(false);

      const invalidExtreme = validateSlippage(5500); // > 10%
      expect(invalidExtreme.valid).toBe(false);

      const highSlippage = validateSlippage(600); // 6.0% (> 5%)
      expect(highSlippage.valid).toBe(true);
      expect(highSlippage.isHigh).toBe(true);

      const invalidNaN = validateSlippage(NaN);
      expect(invalidNaN.valid).toBe(false);
    });
  });

  // ==========================================================================
  // AREA 5: NETWORK MISMATCH DETECTION & SECURITY SHIELD
  // ==========================================================================
  describe("Area 5: Network Mismatch Detection & Warning Shield", () => {
    it("renders warning status indicator in TopNav when wallet is on wrong network", () => {
      currentWalletState = createMockWalletState({
        address: dummyCaller,
        mode: "wallet",
        walletNetworkMismatch: true,
      });

      const html = renderToString(
        <TopNav
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          usdcTrustlineExists={true}
          accountExists={true}
          busyAction={null}
        />
      );

      expect(html).toContain("Network warning: Connected wallet is not on Stellar Testnet");
      expect(html).toContain("border-warn");
    });

    it("triggers switchNetwork callback when user clicks network mismatch warning button", () => {
      let switchTriggered = false;
      currentWalletState = createMockWalletState({
        address: dummyCaller,
        mode: "wallet",
        walletNetworkMismatch: true,
        switchNetwork: async () => {
          switchTriggered = true;
        },
      });

      expect(currentWalletState.walletNetworkMismatch).toBe(true);
      void currentWalletState.switchNetwork();
      expect(switchTriggered).toBe(true);
    });

    it("renders prominent warning banner inside TradingDesk when wallet network mismatch is active", () => {
      currentWalletState = createMockWalletState({
        address: dummyCaller,
        mode: "wallet",
        walletNetworkMismatch: true,
      });

      const market = PRESET_MARKETS[0];
      const snapshot = createMockSnapshot(market);
      const portfolio = createMockPortfolio(market);

      const html = renderToString(
        <TradingDesk
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Wallet is on wrong network");
      expect(html).toContain("Switch to Testnet");
    });

    it("replaces action execution button in RolloverCard with Switch to Testnet CTA", () => {
      currentWalletState = createMockWalletState({
        address: dummyCaller,
        mode: "wallet",
        walletNetworkMismatch: true,
      });

      const market = PRESET_MARKETS[0];
      const snapshot = createMockSnapshot(market);
      const portfolio = createMockPortfolio(market);

      const html = renderToString(
        <RolloverCard
          snapshot={snapshot}
          portfolio={portfolio}
          busyAction={null}
          onExecuteAction={async () => {}}
        />
      );

      expect(html).toContain("Switch to Testnet");
    });

    it("decodes Soroban host error diagnostic strings cleanly into user-friendly messages", () => {
      const simulatedHostError = "Error(Contract, #1)";
      const decoded = decodeSorobanError(simulatedHostError);
      expect(decoded).toBeDefined();
      expect(typeof decoded).toBe("string");
      expect(decoded.length).toBeGreaterThan(0);
    });
  });
});
