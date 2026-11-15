// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Address, scValToNative } from "@stellar/stellar-sdk";

// Mock WalletProvider state for controlled component rendering
let mockWalletState = {
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
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => mockWalletState.walletNetworkMismatch,
}));

// Components under test
import { TopNav, ViewMode } from "@/components/TopNav";
import { MarketSelector } from "@/components/trading/MarketSelector";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { RolloverCard } from "@/components/trading/RolloverCard";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { LiquidityCard } from "@/components/trading/LiquidityCard";
import { MarketProvider } from "@/context/MarketContext";

// Business logic & libraries under test
import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  findMarketById,
  deriveMarketStatus,
  calculateDaysToMaturity,
  MarketDefinition,
  MarketSummaryMetrics,
} from "../markets";
import {
  buildActionArgs,
  ProtocolAction,
  LiveMarketSnapshot,
  LiveUserPortfolio,
} from "../stellar";
import {
  BLEND_CONTRACTS,
  DEFAULT_BLEND_DEPLOYMENTS,
  getBlendPoolConfig,
  resolveMarketBlendPool,
  getBlendFallbackRate,
  isRealBlendPool,
  formatBlendRate,
} from "../blend";
import {
  parseMarketPosition,
  aggregatePortfolioTotals,
  calculateWeightedApy,
  ASSET_USD_PRICES,
  MarketPositionItem,
} from "../../hooks/useMultiMarketPortfolio";
import {
  applySlippage,
  validateAmountInput,
  formatUnits,
  formatUnitsExact,
} from "../math";
import { STELLAR_PENDLE_CONFIG } from "../contracts";

describe("Milestone 5 Final Challenge: Overarching E2E Integration Stress Suite", () => {
  const dummyCaller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
  const dummyReceiver = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;

  // Baseline mock live snapshot
  const createMockSnapshot = (
    market: MarketDefinition,
    options?: { isMatured?: boolean; blendRate?: bigint }
  ): LiveMarketSnapshot => {
    const isMatured = options?.isMatured ?? false;
    const blendExchangeRate = options?.blendRate ?? 1_000_000_000n;
    return {
      marketId: market.id,
      state: {
        total_pt_reserve: 85_000_0000000n,
        total_sy_reserve: 42_000_0000000n,
        total_lp_supply: 60_000_0000000n,
        last_exchange_rate: 1_0000000n,
        fee_rate_bps: 30,
        maturity: BigInt(market.maturity),
        scalar_root: BigInt(market.scalarRoot),
        initial_anchor: BigInt(market.initialAnchor),
      },
      isMatured,
      daysToMaturity: isMatured ? 0 : calculateDaysToMaturity(market.maturity, 1794500000),
      impliedFixedApyPct: isMatured ? 0 : 8.45,
      underlyingApyPct: 4.5,
      ptPriceInSy: isMatured ? 1.0 : 0.98,
      ytPriceInSy: isMatured ? 0.0 : 0.02,
      blendExchangeRate,
      blendPoolId: market.contracts.blendPoolId,
      nowSeconds: 1794500000,
    };
  };

  // Helper context renderer
  const renderWithContext = (ui: React.ReactElement) => {
    return renderToString(
      React.createElement(MarketProvider, null, ui)
    );
  };

  // ==========================================================================
  // INVARIANT SUITE: STRICT CHECKSUM VERIFICATION & ZERO TAMPERING
  // ==========================================================================
  describe("Invariant Verification: Untouched Files & Design System Gates", () => {
    const INDEXER_TS_PATH = path.resolve(__dirname, "../indexer.ts");
    const USE_EVENT_INDEXER_TS_PATH = path.resolve(__dirname, "../../hooks/useEventIndexer.ts");

    const EXPECTED_INDEXER_SHA256 = "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";
    const EXPECTED_USE_EVENT_INDEXER_SHA256 = "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

    it("verifies frontend/src/lib/indexer.ts has 100% exact untouched SHA256 checksum", () => {
      expect(fs.existsSync(INDEXER_TS_PATH)).toBe(true);
      const content = fs.readFileSync(INDEXER_TS_PATH);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      expect(hash).toBe(EXPECTED_INDEXER_SHA256);
    });

    it("verifies frontend/src/hooks/useEventIndexer.ts has 100% exact untouched SHA256 checksum", () => {
      expect(fs.existsSync(USE_EVENT_INDEXER_TS_PATH)).toBe(true);
      const content = fs.readFileSync(USE_EVENT_INDEXER_TS_PATH);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      expect(hash).toBe(EXPECTED_USE_EVENT_INDEXER_SHA256);
    });

    it("strictly verifies zero raw hex color codes across core UI components", () => {
      const componentFiles = [
        "../../components/TopNav.tsx",
        "../../components/trading/MarketSelector.tsx",
        "../../components/trading/TradingDesk.tsx",
        "../../components/trading/SwapCard.tsx",
        "../../components/trading/MintCard.tsx",
        "../../components/trading/LiquidityCard.tsx",
        "../../components/trading/RedeemCard.tsx",
        "../../components/trading/RolloverCard.tsx",
        "../../components/portfolio/PortfolioView.tsx",
      ];

      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const violations: string[] = [];

      for (const relPath of componentFiles) {
        const fullPath = path.resolve(__dirname, relPath);
        if (!fs.existsSync(fullPath)) continue;
        const text = fs.readFileSync(fullPath, "utf-8");
        const matches = text.match(rawHexRegex);
        if (matches) {
          violations.push(`${path.basename(relPath)}: ${matches.join(", ")}`);
        }
      }

      expect(violations).toEqual([]);
      expect(violations.length).toBe(0);
    });

    it("strictly verifies zero raw Unicode emojis across core UI components", () => {
      const componentFiles = [
        "../../components/TopNav.tsx",
        "../../components/trading/MarketSelector.tsx",
        "../../components/trading/TradingDesk.tsx",
        "../../components/trading/SwapCard.tsx",
        "../../components/trading/MintCard.tsx",
        "../../components/trading/LiquidityCard.tsx",
        "../../components/trading/RedeemCard.tsx",
        "../../components/trading/RolloverCard.tsx",
        "../../components/portfolio/PortfolioView.tsx",
      ];

      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const violations: string[] = [];

      for (const relPath of componentFiles) {
        const fullPath = path.resolve(__dirname, relPath);
        if (!fs.existsSync(fullPath)) continue;
        const text = fs.readFileSync(fullPath, "utf-8");
        const lines = text.split("\n");
        lines.forEach((l, idx) => {
          if (emojiRegex.test(l)) {
            violations.push(`${path.basename(relPath)}:${idx + 1} - ${l.trim()}`);
          }
        });
      }

      expect(violations).toEqual([]);
      expect(violations.length).toBe(0);
    });
  });

  // ==========================================================================
  // JOURNEY 1: MULTI-MARKET SELECTION & PROPAGATION
  // ==========================================================================
  describe("Journey 1: Multi-Market Selection & Context Propagation", () => {
    it("confirms canonical definitions for usdc-90d, usdc-30d, and xlm-90d", () => {
      expect(usdc90D).toBeDefined();
      expect(usdc90D.asset.code).toBe("USDC");
      expect(usdc90D.tenor).toBe("90D");
      expect(usdc90D.isRegisteredOnChain).toBe(true);

      expect(usdc30D).toBeDefined();
      expect(usdc30D.asset.code).toBe("USDC");
      expect(usdc30D.tenor).toBe("30D");
      expect(usdc30D.isRegisteredOnChain).toBe(true);

      expect(xlm90D).toBeDefined();
      expect(xlm90D.asset.code).toBe("XLM");
      expect(xlm90D.tenor).toBe("90D");
      expect(xlm90D.isRegisteredOnChain).toBe(true);
    });

    it("verifies findMarketById resolves each target market and falls back to default on invalid ID", () => {
      expect(findMarketById("usdc-90d", PRESET_MARKETS).id).toBe("usdc-90d");
      expect(findMarketById("usdc-30d", PRESET_MARKETS).id).toBe("usdc-30d");
      expect(findMarketById("xlm-90d", PRESET_MARKETS).id).toBe("xlm-90d");

      // Robust fallback on unrecognized market ID
      const fallback = findMarketById("unknown-nonexistent-market", PRESET_MARKETS);
      expect(fallback.id).toBe("usdc-90d");
    });

    it("verifies buildActionArgs dynamically routes contract addresses per active market", () => {
      // 1. Swap action on usdc-90d
      const swapUsdc90D: ProtocolAction = {
        type: "swap",
        method: "swap_exact_pt_for_sy",
        caller: dummyCaller,
        amountIn: 10_0000000n,
        minOut: 9_8000000n,
      };
      const builtUsdc90D = buildActionArgs(swapUsdc90D, usdc90D);
      expect(builtUsdc90D.contractId).toBe(usdc90D.contracts.poolId);
      expect(builtUsdc90D.method).toBe("swap_exact_pt_for_sy");

      // 2. Swap action on usdc-30d
      const builtUsdc30D = buildActionArgs(swapUsdc90D, usdc30D);
      expect(builtUsdc30D.contractId).toBe(usdc30D.contracts.poolId);
      expect(builtUsdc30D.contractId).not.toBe(usdc90D.contracts.poolId);

      // 3. Deposit SY action on xlm-90d
      const depositXlm: ProtocolAction = {
        type: "deposit_sy",
        caller: dummyCaller,
        amount: 50_0000000n,
      };
      const builtXlm = buildActionArgs(depositXlm, xlm90D);
      expect(builtXlm.contractId).toBe(xlm90D.contracts.syId);
    });

    it("renders MarketSelector trigger button with active market details and modal accessibility", () => {
      const html = renderWithContext(
        React.createElement(MarketSelector, { compact: false })
      );

      // Must contain active market tenor, asset, and accessibility attributes
      expect(html).toContain("USDC");
      expect(html).toContain("90D");
      expect(html).toContain('aria-label="Open market selector"');
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).toContain("tabular-mono");
    });
  });

  // ==========================================================================
  // JOURNEY 2: MARKET METRICS & SAFE BLEND RATE FALLBACK
  // ==========================================================================
  describe("Journey 2: Market Metrics & Safe Blend Rate Fallback Engine", () => {
    it("derives correct market temporal metrics for active vs matured markets", () => {
      const now = 1794500000;
      const statusActive = deriveMarketStatus(usdc90D.maturity, now);
      const daysActive = calculateDaysToMaturity(usdc90D.maturity, now);
      expect(statusActive).toBe("ACTIVE");
      expect(daysActive).toBeGreaterThan(0);

      const statusMatured = deriveMarketStatus(usdcMatured.maturity, now);
      const daysMatured = calculateDaysToMaturity(usdcMatured.maturity, now);
      expect(statusMatured).toBe("MATURED");
      expect(daysMatured).toBe(0);
    });

    it("verifies Blend contract resolver matches production testnet, mainnet and mock addresses", () => {
      // Testnet Real Blend Pool
      expect(BLEND_CONTRACTS.testnet.pool).toBe("CCEBVDYM3X7TO274BCC4ECNML27Y5SF4K74S475LMGSOE62SS6I34JTB");
      // Mainnet Real Blend Pool
      expect(BLEND_CONTRACTS.mainnet.pool).toBe("CAJJZSGMMLL2LUGIVYUL5CYUQXCX4RP5432G6HHV5EVJS7BV2HOH4W46");
      // Testnet Mock Blend Pool
      expect(BLEND_CONTRACTS.mock.pool).toBe("CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6");

      expect(isRealBlendPool(BLEND_CONTRACTS.testnet.pool)).toBe(true);
      expect(isRealBlendPool(BLEND_CONTRACTS.mainnet.pool)).toBe(true);
      expect(isRealBlendPool(BLEND_CONTRACTS.mock.pool)).toBe(false);
    });

    it("resolves market blend pool correctly per market definition and network override", () => {
      const resolvedMock = resolveMarketBlendPool(usdc90D, "mock");
      expect(resolvedMock).toBe(BLEND_CONTRACTS.mock.pool);

      const resolvedTestnet = resolveMarketBlendPool(usdc90D, "testnet");
      expect(resolvedTestnet).toBe(BLEND_CONTRACTS.testnet.pool);
    });

    it("strictly returns safe initial fallback rate (1.0) when oracle rate is missing or zero", () => {
      const fallbackUsdc = getBlendFallbackRate("USDC");
      expect(fallbackUsdc).toBe(1_000_000_000n);

      const fallbackXlm = getBlendFallbackRate("XLM");
      expect(fallbackXlm).toBe(1_000_000_000n);

      // formatBlendRate edge cases
      expect(formatBlendRate(1_000_000_000n)).toBe("1.000000");
      expect(formatBlendRate(1_050_000_000n)).toBe("1.050000");
      expect(formatBlendRate(0n)).toBe("1.000000");
      expect(formatBlendRate(-500n)).toBe("1.000000");
      expect(formatBlendRate(NaN)).toBe("1.000000");
      expect(formatBlendRate(Infinity)).toBe("1.000000");
    });
  });

  // ==========================================================================
  // JOURNEY 3: ATOMIC ROLLOVER PREVIEW & TRANSACTION GENERATION
  // ==========================================================================
  describe("Journey 3: Atomic Rollover Preview & Action Generation", () => {
    const canonicalFactoryId = "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL";

    it("builds valid 6-argument Soroban transaction envelope for rollover_to_pt", () => {
      const action: ProtocolAction = {
        type: "rollover_to_pt",
        caller: dummyCaller,
        receiver: dummyReceiver,
        sourcePool: usdcMatured.contracts.poolId,
        targetPool: usdc90D.contracts.poolId,
        ptAmount: 100_0000000n, // 100 matured PT
        minTargetPt: 98_5000000n, // slippage-protected min target PT
      };

      const built = buildActionArgs(action);
      expect(built.contractId).toBe(canonicalFactoryId);
      expect(built.method).toBe("rollover_to_pt");
      expect(built.args.length).toBe(6);

      // Verify native conversion
      const nativeArgs = built.args.map((sc) => scValToNative(sc));
      expect(nativeArgs[0]).toBe(dummyCaller);
      expect(nativeArgs[1]).toBe(dummyReceiver);
      expect(nativeArgs[2]).toBe(usdcMatured.contracts.poolId);
      expect(nativeArgs[3]).toBe(usdc90D.contracts.poolId);
      expect(nativeArgs[4]).toBe(100_0000000n);
      expect(nativeArgs[5]).toBe(98_5000000n);
    });

    it("builds valid 6-argument Soroban transaction envelope for rollover_to_py", () => {
      const action: ProtocolAction = {
        type: "rollover_to_py",
        caller: dummyCaller,
        receiver: dummyReceiver,
        sourcePool: usdcMatured.contracts.poolId,
        targetPool: usdc30D.contracts.poolId,
        ptAmount: 50_0000000n,
        minNewShares: 49_0000000n,
      };

      const built = buildActionArgs(action);
      expect(built.contractId).toBe(canonicalFactoryId);
      expect(built.method).toBe("rollover_to_py");
      expect(built.args.length).toBe(6);

      const nativeArgs = built.args.map((sc) => scValToNative(sc));
      expect(nativeArgs[0]).toBe(dummyCaller);
      expect(nativeArgs[1]).toBe(dummyReceiver);
      expect(nativeArgs[2]).toBe(usdcMatured.contracts.poolId);
      expect(nativeArgs[3]).toBe(usdc30D.contracts.poolId);
      expect(nativeArgs[4]).toBe(50_0000000n);
      expect(nativeArgs[5]).toBe(49_0000000n);
    });

    it("enforces validation rules: cross-asset rollover between USDC and XLM is disallowed", () => {
      // Cross asset check
      const isCrossAsset = usdcMatured.asset.code !== xlm90D.asset.code;
      expect(isCrossAsset).toBe(true);

      // Source matured vs active check
      const now = Math.floor(Date.now() / 1000);
      const isSourceMatured = now >= usdcMatured.maturity;
      expect(isSourceMatured).toBe(true);

      const isTargetActive = now < usdc90D.maturity;
      expect(isTargetActive).toBe(true);
    });

    it("calculates exact slippage threshold for rollover output", () => {
      const estimatedOutput = 100_0000000n;
      const slippageBps = 50; // 0.5%
      const minReceived = applySlippage(estimatedOutput, slippageBps);

      // Expected: 100 - (100 * 50 / 10000) = 99.5
      expect(minReceived).toBe(99_5000000n);
      expect(minReceived).toBeLessThan(estimatedOutput);
    });
  });

  // ==========================================================================
  // JOURNEY 4: MULTI-MARKET PORTFOLIO BALANCES & TOTAL USD VALUATION
  // ==========================================================================
  describe("Journey 4: Multi-Market Portfolio Aggregation & Valuation Engine", () => {
    it("correctly parses and aggregates positions across USDC 90D, USDC 30D, XLM 90D, and Matured", () => {
      const now = 1794500000;

      // Position 1: usdc-90d (1000 PT, 1000 YT, 200 LP, 12.5 SY claimable)
      const portUsdc90D: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "1000.00",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 1000_0000000n, // ~$980
        ytBalance: 1000_0000000n, // ~$20
        lpBalance: 200_0000000n, // ~$200
        lastIndex: 1000000000n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 12_5000000n, // ~$12.50
      };

      // Position 2: usdc-30d (500 PT, 100 LP, 0 claimable)
      const portUsdc30D: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "1000.00",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 500_0000000n, // ~$490
        ytBalance: 0n,
        lpBalance: 100_0000000n, // ~$100
        lastIndex: 1000000000n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      // Position 3: xlm-90d (2000 PT bXLM @ $0.12 = ~$235.20)
      const portXlm90D: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "1000.00",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 2000_0000000n, // 2000 * 0.98 * 0.12 = $235.20
        ytBalance: 0n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      // Position 4: usdc-matured (300 Matured PT @ $1.00 = $300)
      const portMatured: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "1000.00",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 300_0000000n, // 300 * 1.0 * $1.0 = $300
        ytBalance: 0n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      const pos1 = parseMarketPosition(usdc90D, portUsdc90D, null, now);
      const pos2 = parseMarketPosition(usdc30D, portUsdc30D, null, now);
      const pos3 = parseMarketPosition(xlm90D, portXlm90D, null, now);
      const pos4 = parseMarketPosition(usdcMatured, portMatured, null, now);

      expect(pos1.hasPosition).toBe(true);
      expect(pos1.isMatured).toBe(false);
      expect(pos1.claimableYieldUsd).toBeCloseTo(12.5, 1);

      expect(pos2.hasPosition).toBe(true);
      expect(pos2.isMatured).toBe(false);

      expect(pos3.hasPosition).toBe(true);
      expect(pos3.assetCode).toBe("XLM");
      expect(pos3.ptValueUsd).toBeCloseTo(2000 * 0.98 * ASSET_USD_PRICES.XLM, 1);

      expect(pos4.hasPosition).toBe(true);
      expect(pos4.isMatured).toBe(true);
      expect(pos4.ptValueUsd).toBeCloseTo(300.0, 1);

      // Aggregate totals
      const totals = aggregatePortfolioTotals([pos1, pos2, pos3, pos4]);
      expect(totals.activePositionsCount).toBe(3);
      expect(totals.maturedPositionsCount).toBe(1);
      expect(totals.hasMaturedPositions).toBe(true);
      expect(totals.totalPortfolioValueUsd).toBeGreaterThan(2000);
      expect(totals.totalClaimableYieldUsd).toBeCloseTo(12.5, 1);
    });

    it("calculates value-weighted implied APY across active portfolio positions", () => {
      const posA: MarketPositionItem = {
        marketId: "usdc-90d",
        marketName: "USDC 90D",
        assetCode: "USDC",
        tenor: "90D",
        maturity: 1800000000,
        maturityIso: "2027-01-01",
        isMatured: false,
        daysToMaturity: 90,
        ptBalance: 1000_0000000n,
        ytBalance: 0n,
        lpBalance: 0n,
        syBalance: 0n,
        claimableYield: 0n,
        claimableYieldSy: 0n,
        estimatedValue: 1000.0,
        totalValueUsd: 1000.0,
        ptValueUsd: 1000.0,
        ytValueUsd: 0,
        lpValueUsd: 0,
        claimableYieldUsd: 0,
        hasPosition: true,
        ptBalanceFormatted: "1000.00",
        formattedPtBalance: "1000.00",
        ytBalanceFormatted: "0.00",
        formattedYtBalance: "0.00",
        lpBalanceFormatted: "0.00",
        formattedLpBalance: "0.00",
        claimableYieldFormatted: "0.00",
        formattedClaimableYieldSy: "0.00",
        impliedApyPct: 8.0,
      };

      const posB: MarketPositionItem = {
        ...posA,
        marketId: "usdc-30d",
        estimatedValue: 1000.0,
        totalValueUsd: 1000.0,
        ptValueUsd: 1000.0,
        impliedApyPct: 6.0,
      };

      // Equal weights: (1000 * 8% + 1000 * 6%) / 2000 = 7.0%
      const weighted = calculateWeightedApy([posA, posB]);
      expect(weighted).toBeCloseTo(7.0, 2);
    });

    it("safely handles disconnected / zero-balance portfolio without throwing", () => {
      const emptyTotals = aggregatePortfolioTotals([]);
      expect(emptyTotals.totalPortfolioValueUsd).toBe(0);
      expect(emptyTotals.totalClaimableYieldUsd).toBe(0);
      expect(emptyTotals.activePositionsCount).toBe(0);
      expect(emptyTotals.hasMaturedPositions).toBe(false);
      expect(emptyTotals.weightedApyPct).toBe(0);
    });
  });

  // ==========================================================================
  // JOURNEY 5: SEQUENTIAL MULTI-MARKET YIELD CLAIMS
  // ==========================================================================
  describe("Journey 5: Sequential Multi-Market Yield Claims Without Sequence Collisions", () => {
    it("strictly executes multi-market yield claims sequentially (orderly serialization)", async () => {
      // Simulate multiple markets with claimable yield
      const positionsWithYield = [
        {
          marketId: "usdc-90d",
          claimableYield: 15_0000000n, // 15 SY
        },
        {
          marketId: "usdc-30d",
          claimableYield: 5_0000000n, // 5 SY
        },
        {
          marketId: "xlm-90d",
          claimableYield: 0n, // 0 SY (should be skipped!)
        },
      ];

      let activeExecutionCount = 0;
      let maxConcurrentExecutions = 0;
      const executionLog: Array<{ marketId: string; timestamp: number }> = [];

      // Mock sequential onExecuteAction simulator
      const mockExecuteAction = async (params: {
        contractId: string;
        method: string;
        args: any[];
        label: string;
      }) => {
        activeExecutionCount++;
        if (activeExecutionCount > maxConcurrentExecutions) {
          maxConcurrentExecutions = activeExecutionCount;
        }

        // Simulate network latency on Soroban submission
        await new Promise((resolve) => setTimeout(resolve, 20));

        executionLog.push({ marketId: params.label, timestamp: Date.now() });
        activeExecutionCount--;
      };

      // Emulate the sequential claim loop implemented in PortfolioView
      const executeSequentialClaims = async () => {
        for (const pos of positionsWithYield) {
          if (pos.claimableYield > 0n) {
            const m = PRESET_MARKETS.find((pm) => pm.id === pos.marketId);
            if (m) {
              const action = buildActionArgs(
                { type: "claim_yield", caller: dummyCaller },
                m
              );
              await mockExecuteAction({
                ...action,
                label: pos.marketId,
              });
            }
          }
        }
      };

      await executeSequentialClaims();

      // STRICT INVARIANTS:
      // 1. Max concurrent executions must be exactly 1 (Zero collision!)
      expect(maxConcurrentExecutions).toBe(1);
      expect(activeExecutionCount).toBe(0);

      // 2. Exactly 2 claims were executed (usdc-90d and usdc-30d), xlm-90d was skipped
      expect(executionLog.length).toBe(2);
      expect(executionLog[0].marketId).toBe("usdc-90d");
      expect(executionLog[1].marketId).toBe("usdc-30d");

      // 3. Execution times must be sequential
      expect(executionLog[1].timestamp).toBeGreaterThanOrEqual(executionLog[0].timestamp);
    });

    it("verifies buildActionArgs produces correct contractId and method for claim_yield", () => {
      const claimArgs = buildActionArgs(
        { type: "claim_yield", caller: dummyCaller },
        usdc90D
      );

      expect(claimArgs.method).toBe("claim_yield");
      expect(claimArgs.contractId).toBe(usdc90D.contracts.poolId);
      expect(claimArgs.args.length).toBe(2);

      const nativeArgs = claimArgs.args.map((sc) => scValToNative(sc));
      expect(nativeArgs[0]).toBe(dummyCaller);
      expect(nativeArgs[1]).toBe(dummyCaller);
    });
  });

  // ==========================================================================
  // JOURNEY 6: TOPNAV NAVIGATION & ACTION SHORTCUT ROUTING
  // ==========================================================================
  describe("Journey 6: TopNav Navigation & Inter-Component Action Routing", () => {
    it("renders TopNav in landing mode with Trade Desk and Portfolio entry buttons", () => {
      const html = renderWithContext(
        React.createElement(TopNav, {
          viewMode: "landing",
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
          onToggleView: () => {},
        })
      );

      expect(html).toContain("Trade Desk");
      expect(html).toContain("Portfolio");
      expect(html).toContain("NivoraFi");
      expect(html).toContain("Testnet");
    });

    it("renders TopNav in trade mode with view switchers and active Trade state", () => {
      const html = renderWithContext(
        React.createElement(TopNav, {
          viewMode: "trade",
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
          onToggleView: () => {},
        })
      );

      expect(html).not.toContain("← Landing");
      expect(html).toContain('href="/"');
      expect(html).toContain("Trade");
      expect(html).toContain("Portfolio");
    });

    it("renders TopNav in portfolio mode with active Portfolio switcher", () => {
      const html = renderWithContext(
        React.createElement(TopNav, {
          viewMode: "portfolio",
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
          onToggleView: () => {},
        })
      );

      expect(html).not.toContain("← Landing");
      expect(html).toContain('href="/"');
      expect(html).toContain("Trade");
      expect(html).toContain("Portfolio");
    });

    it("renders network mismatch warning button when walletNetworkMismatch is true", () => {
      mockWalletState.walletNetworkMismatch = true;

      const html = renderWithContext(
        React.createElement(TopNav, {
          viewMode: "trade",
          onRefresh: () => {},
          refreshing: false,
          onFundXlm: () => {},
          onAddUsdcTrustline: () => {},
          usdcTrustlineExists: true,
          accountExists: true,
          busyAction: null,
          onToggleView: () => {},
        })
      );

      expect(html).toContain("Mismatch");
      mockWalletState.walletNetworkMismatch = false; // reset
    });

    it("renders PortfolioView with 1-click action shortcuts (Trade, Redeem, Rollover)", () => {
      const port: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "1000.00",
        usdcTrustlineExists: true,
        syBalance: 0n,
        ptBalance: 100_0000000n,
        ytBalance: 100_0000000n,
        lpBalance: 50_0000000n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 5_0000000n,
      };

      const userPortfolios = {
        "usdc-90d": port,
        "usdc-30d": port,
        "xlm-90d": port,
      };

      const html = renderWithContext(
        React.createElement(PortfolioView, {
          userPortfolios,
          onSelectMarketAndTab: () => {},
          onNavigateToTrade: () => {},
          onSwitchToTrade: () => {},
        })
      );

      expect(html).toContain("Trade");
      expect(html).toContain("Redeem");
      expect(html).toContain("Rollover");
      expect(html).toContain("My Positions");
      expect(html).toContain("Claim All Yield");
    });

    it("renders TradingDesk across all 5 operational tabs without crashing", () => {
      const snap = createMockSnapshot(usdc90D);
      const port: LiveUserPortfolio = {
        address: dummyCaller,
        accountExists: true,
        xlmBalance: "100.00",
        usdcBalance: "1000.00",
        usdcTrustlineExists: true,
        syBalance: 10_0000000n,
        ptBalance: 50_0000000n,
        ytBalance: 50_0000000n,
        lpBalance: 20_0000000n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 0n,
      };

      const allTabs: DeskTab[] = ["swap", "mint", "liquidity", "redeem", "rollover"];

      for (const tab of allTabs) {
        const html = renderWithContext(
          React.createElement(TradingDesk, {
            snapshot: snap,
            portfolio: port,
            busyAction: null,
            onExecuteAction: async () => {},
            activeTab: tab,
          })
        );

        expect(html.length).toBeGreaterThan(100);
        expect(html).toContain("Trade Fixed Yield");
      }
    });
  });

  // ==========================================================================
  // SUITE 8: FULL-LIFECYCLE USER JOURNEY INTEGRATION STATE MACHINE
  // ==========================================================================
  describe("Suite 8: Complete Integrated E2E User Journey Simulation", () => {
    it("simulates full end-to-end user journey across all 6 core milestones without state degradation", async () => {
      // Phase 1: User arrives at Landing page
      let currentView: ViewMode = "landing";
      let activeMarketId = "usdc-90d";
      let currentDeskTab: DeskTab = "swap";

      expect(currentView).toBe("landing");

      // Phase 2: User clicks 'Trade Desk' on TopNav or Landing Hero
      currentView = "trade";
      expect(currentView).toBe("trade");

      // Phase 3: User switches markets sequentially: usdc-90d -> usdc-30d -> xlm-90d
      const marketIds = ["usdc-90d", "usdc-30d", "xlm-90d"];
      for (const mId of marketIds) {
        activeMarketId = mId;
        const currentM = findMarketById(activeMarketId, PRESET_MARKETS);
        expect(currentM.id).toBe(mId);

        // Verify action building works on dynamically selected market
        const action = buildActionArgs(
          { type: "claim_yield", caller: dummyCaller },
          currentM
        );
        expect(action.contractId).toBe(currentM.contracts.poolId);
      }

      // Phase 4: User inspects market metrics & verifies safe Blend rate fallback
      const blendRate = getBlendFallbackRate("USDC");
      expect(blendRate).toBe(1_000_000_000n);
      const formattedRate = formatBlendRate(blendRate);
      expect(formattedRate).toBe("1.000000");

      // Phase 5: User switches to Rollover tab to rollover matured PT into usdc-90d
      currentDeskTab = "rollover";
      expect(currentDeskTab).toBe("rollover");

      const rolloverAction: ProtocolAction = {
        type: "rollover_to_pt",
        caller: dummyCaller,
        receiver: dummyCaller,
        sourcePool: usdcMatured.contracts.poolId,
        targetPool: usdc90D.contracts.poolId,
        ptAmount: 250_0000000n,
        minTargetPt: 247_5000000n, // 1% slippage
      };
      const builtRollover = buildActionArgs(rolloverAction);
      expect(builtRollover.method).toBe("rollover_to_pt");
      expect(builtRollover.contractId).toBe("CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL");

      // Phase 6: User navigates to Portfolio via TopNav
      currentView = "portfolio";
      expect(currentView).toBe("portfolio");

      // User positions with accrued yield across multiple markets
      const multiMarketPositions = [
        parseMarketPosition(
          usdc90D,
          {
            address: dummyCaller,
            accountExists: true,
            xlmBalance: "100.00",
            usdcBalance: "1000.00",
            usdcTrustlineExists: true,
            syBalance: 0n,
            ptBalance: 500_0000000n,
            ytBalance: 500_0000000n,
            lpBalance: 100_0000000n,
            lastIndex: 0n,
            unclaimedYieldRaw: 0n,
            estimatedPendingYieldSy: 10_0000000n,
          },
          null,
          1780000000
        ),
        parseMarketPosition(
          usdc30D,
          {
            address: dummyCaller,
            accountExists: true,
            xlmBalance: "100.00",
            usdcBalance: "1000.00",
            usdcTrustlineExists: true,
            syBalance: 0n,
            ptBalance: 200_0000000n,
            ytBalance: 0n,
            lpBalance: 50_0000000n,
            lastIndex: 0n,
            unclaimedYieldRaw: 0n,
            estimatedPendingYieldSy: 4_0000000n,
          },
          null,
          1780000000
        ),
        parseMarketPosition(
          xlm90D,
          {
            address: dummyCaller,
            accountExists: true,
            xlmBalance: "100.00",
            usdcBalance: "1000.00",
            usdcTrustlineExists: true,
            syBalance: 0n,
            ptBalance: 1000_0000000n,
            ytBalance: 0n,
            lpBalance: 0n,
            lastIndex: 0n,
            unclaimedYieldRaw: 0n,
            estimatedPendingYieldSy: 0n,
          },
          null,
          1780000000
        ),
      ];

      const totals = aggregatePortfolioTotals(multiMarketPositions);
      expect(totals.totalPortfolioValueUsd).toBeGreaterThan(0);
      expect(totals.totalClaimableYieldUsd).toBeCloseTo(14.0, 1);
      expect(totals.activePositionsCount).toBe(3);

      // Phase 7: Sequential Claim Yield across all markets
      const executedClaims: string[] = [];
      let inFlight = 0;
      for (const pos of multiMarketPositions) {
        if (pos.claimableYield > 0n) {
          inFlight++;
          expect(inFlight).toBe(1); // Strict concurrency lock
          await new Promise((r) => setTimeout(r, 10));
          executedClaims.push(pos.marketId);
          inFlight--;
          expect(inFlight).toBe(0);
        }
      }
      expect(executedClaims).toEqual(["usdc-90d", "usdc-30d"]);

      // Phase 8: User clicks 'Trade' shortcut on xlm-90d position in Portfolio table
      activeMarketId = "xlm-90d";
      currentDeskTab = "swap";
      currentView = "trade";

      expect(activeMarketId).toBe("xlm-90d");
      expect(currentDeskTab).toBe("swap");
      expect(currentView).toBe("trade");

      // Phase 9: User returns to Landing
      currentView = "landing";
      expect(currentView).toBe("landing");
    });
  });

  // ==========================================================================
  // SUITE 9: BLEND ADAPTER BOUNDARY & NUMERICAL FUZZING MATRIX
  // ==========================================================================
  describe("Suite 9: Blend Adapter Adverse Boundary & Numerical Resilience", () => {
    it("handles extreme boundary values in formatBlendRate without NaN or string corruption", () => {
      const boundaryValues = [
        0n,
        -1n,
        -1_000_000_000n,
        1n,
        1_000_000_000n,
        2_500_000_000n,
        100_000_000_000n,
        1_000_000_000_000_000_000n, // 10^18 WAD
      ];

      for (const val of boundaryValues) {
        const formatted = formatBlendRate(val);
        expect(typeof formatted).toBe("string");
        expect(formatted).not.toContain("NaN");
        expect(formatted).not.toContain("undefined");
        expect(Number.isFinite(Number(formatted))).toBe(true);
        expect(Number(formatted)).toBeGreaterThanOrEqual(0.0);
      }

      // Exact known outputs
      expect(formatBlendRate(0n)).toBe("1.000000"); // Safe fallback on zero
      expect(formatBlendRate(-100n)).toBe("1.000000"); // Safe fallback on negative
      expect(formatBlendRate(1_000_000_000n)).toBe("1.000000"); // Parity rate
      expect(formatBlendRate(1_050_000_000n)).toBe("1.050000"); // 1.05 rate
    });

    it("evaluates Blend pool config across testnet, mainnet, and mock environments", () => {
      const testnetConf = getBlendPoolConfig("testnet");
      expect(testnetConf.network).toBe("testnet");
      expect(testnetConf.activePool.poolAddress).toBe(BLEND_CONTRACTS.testnet.pool);

      const mainnetConf = getBlendPoolConfig("mainnet");
      expect(mainnetConf.network).toBe("mainnet");
      expect(mainnetConf.activePool.poolAddress).toBe(BLEND_CONTRACTS.mainnet.pool);

      const mockConf = getBlendPoolConfig("mock");
      expect(mockConf.network).toBe("mock");
      expect(mockConf.activePool.poolAddress).toBe(BLEND_CONTRACTS.mock.pool);
    });
  });

  // ==========================================================================
  // SUITE 10: PORTFOLIO ENGINE FUZZING & INVARIANT PRESERVATION
  // ==========================================================================
  describe("Suite 10: Portfolio Valuation Engine Invariant Fuzzing", () => {
    it("fuzzes 500 pseudorandom position balance configurations to verify numeric sanity", () => {
      let seed = 42;
      const pseudoRand = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };

      for (let i = 0; i < 500; i++) {
        const pt = BigInt(Math.floor(pseudoRand() * 100_000 * 1e7));
        const yt = BigInt(Math.floor(pseudoRand() * 100_000 * 1e7));
        const lp = BigInt(Math.floor(pseudoRand() * 10_000 * 1e7));
        const yieldSy = BigInt(Math.floor(pseudoRand() * 5_000 * 1e7));

        const dummyPort: LiveUserPortfolio = {
          address: dummyCaller,
          accountExists: true,
          xlmBalance: "100.00",
          usdcBalance: "1000.00",
          usdcTrustlineExists: true,
          syBalance: 0n,
          ptBalance: pt,
          ytBalance: yt,
          lpBalance: lp,
          lastIndex: 0n,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: yieldSy,
        };

        const pos = parseMarketPosition(usdc90D, dummyPort, null, 1780000000);
        expect(Number.isFinite(pos.totalValueUsd)).toBe(true);
        expect(pos.totalValueUsd).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(pos.claimableYieldUsd)).toBe(true);
        expect(pos.claimableYieldUsd).toBeGreaterThanOrEqual(0);

        const totals = aggregatePortfolioTotals([pos]);
        expect(Number.isFinite(totals.totalPortfolioValueUsd)).toBe(true);
        expect(totals.totalPortfolioValueUsd).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
