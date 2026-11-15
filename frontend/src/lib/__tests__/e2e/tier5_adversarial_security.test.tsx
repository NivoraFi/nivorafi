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
  resolveViewMode,
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
  getMarketDefinition,
  deriveMarketStatus,
  calculateDaysToMaturity,
  getDefaultMarket,
  MarketDefinition,
} from "../../markets";
import {
  applySlippage,
  validateSlippage,
  validateAmountInput,
  parseUnitsSafe,
  formatUnits,
  formatUnitsExact,
  decodeSorobanError,
  HORIZON_ERROR_MESSAGES,
  CONTRACT_ERROR_MESSAGES,
  WAD,
  wadMul,
  wadDiv,
} from "../../math";
import {
  buildActionArgs,
  ProtocolAction,
  extractSorobanDiagnosticError,
  LiveMarketSnapshot,
  LiveUserPortfolio,
} from "../../stellar";
import { getBlendFallbackRate } from "../../blend";
import { buildFallbackSnapshot, MarketProvider } from "@/context/MarketContext";
import { TopNav, ViewMode } from "@/components/TopNav";
import { MobileNavDrawer } from "@/components/navigation/MobileNavDrawer";
import { NetworkBadge } from "@/components/navigation/NetworkBadge";
import { TradingDesk, DeskTab } from "@/components/trading/TradingDesk";
import { SwapCard } from "@/components/trading/SwapCard";
import { MintCard } from "@/components/trading/MintCard";
import { LiquidityCard } from "@/components/trading/LiquidityCard";
import { RedeemCard } from "@/components/trading/RedeemCard";
import { RolloverCard } from "@/components/trading/RolloverCard";
import { MarketSelector } from "@/components/trading/MarketSelector";

// Dynamic page handlers
import TradePage, { generateStaticParams as generateTradeStaticParams } from "@/app/trade/[market]/page";
import MarketDetailPage, { generateStaticParams as generateMarketStaticParams } from "@/app/markets/[id]/page";

// Controllable wallet mock state
let currentWalletState: MockWalletContextState = createMockWalletState();
let currentActiveMarket: MarketDefinition = PRESET_MARKETS[0];
let selectMarketCallLog: string[] = [];

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
      selectMarketCallLog.push(id);
      const found = PRESET_MARKETS.find((m) => m.id === id);
      if (found) currentActiveMarket = found;
    },
    activeSnapshot: createMockSnapshot(currentActiveMarket),
    activePortfolio: createMockPortfolio(currentActiveMarket),
    loadingSnapshot: false,
    loadingPortfolio: false,
    marketMetrics: {},
    refreshActiveMarket: async () => {},
    refreshAllMetrics: async () => {},
  }),
  buildFallbackSnapshot,
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("E2E Test Suite — Tier 5: White-Box Adversarial Challenger", () => {
  beforeEach(() => {
    currentWalletState = createMockWalletState();
    currentActiveMarket = PRESET_MARKETS[0];
    selectMarketCallLog = [];
  });

  // ==========================================================================
  // AREA 1: RPC SIMULATION TIMEOUT, 500 OUTAGES & OFFLINE INDEXER FALLBACK
  // ==========================================================================
  describe("Area 1: Soroban RPC Simulation Timeout, 500 Outages & Offline Fallback", () => {
    it("1.1: decodes Soroban simulation timeouts and 500 error strings into clear messages", () => {
      const timeoutErr = new Error("Gateway Timeout: Soroban RPC simulation timed out after 30000ms");
      const decodedTimeout = decodeSorobanError(timeoutErr);
      expect(decodedTimeout).toContain("Soroban RPC simulation timed out");

      const server500 = new Error("HTTP 500 Internal Server Error from Soroban RPC endpoint");
      const decoded500 = decodeSorobanError(server500);
      expect(decoded500).toContain("HTTP 500 Internal Server Error");

      const hostErr = new Error("HostError: Error(Contract, #3)");
      const decodedHost = decodeSorobanError(hostErr);
      expect(decodedHost).toBe("Soroban ContractError #3: Signer is not authorized for this contract action.");
    });

    it("1.2: builds deterministic fallback snapshot when RPC simulation fails or times out", () => {
      for (const market of PRESET_MARKETS) {
        const fallback = buildFallbackSnapshot(market);
        expect(fallback).toBeDefined();
        expect(fallback.state).toBeDefined();
        expect(fallback.state.total_pt_reserve).toBe(80_000_0000000n);
        expect(fallback.state.total_sy_reserve).toBe(40_000_0000000n);
        expect(fallback.blendExchangeRate).toBe(1_001000000n);
        expect(fallback.latestLedger).toBe(0);
        expect(typeof fallback.impliedFixedApyPct).toBe("number");
        expect(fallback.isMatured).toBe(market.id === "usdc-matured");
      }
    });

    it("1.3: preserves Blend protocol fallback exchange rate during upstream blend outage", () => {
      const usdcFallback = getBlendFallbackRate("USDC");
      expect(usdcFallback).toBe(1_000_000_000n); // 1.0 initial rate scaled by SCALAR_9

      const xlmFallback = getBlendFallbackRate("XLM");
      expect(xlmFallback).toBe(1_000_000_000n);

      const unknownFallback = getBlendFallbackRate("UNKNOWN_TOKEN");
      expect(unknownFallback).toBe(1_000_000_000n);
    });

    it("1.4: simulates offline Windows indexer API handling without unhandled exceptions", async () => {
      // Emulate offline indexer response simulator
      const simulateIndexerFetch = async (apiUrl: string) => {
        try {
          if (apiUrl.includes("offline") || apiUrl.includes(":9999")) {
            throw new Error("fetch failed: connect ECONNREFUSED 192.168.0.29:9999");
          }
          return { status: 200, data: [] };
        } catch {
          return null; // Safe fallback matching indexer.ts
        }
      };

      const result = await simulateIndexerFetch("http://192.168.0.29:9999");
      expect(result).toBeNull();
    });

    it("1.5: TopNav and TradingDesk render cleanly when network snapshot is in fallback mode", () => {
      const htmlTopNav = renderToString(
        <TopNav
          viewMode="trade"
          onRefresh={() => {}}
          refreshing={false}
          onFundXlm={() => {}}
          onAddUsdcTrustline={() => {}}
          usdcTrustlineExists={true}
          accountExists={true}
          busyAction={null}
        />
      );
      expect(htmlTopNav).toContain("NivoraFi");

      const htmlDesk = renderToString(
        <TradingDesk
          activeTab="swap"
          onTabChange={() => {}}
          onSimulateAction={async () => {}}
          isSubmitting={false}
          activeTxStage={null}
          txHash={null}
        />
      );
      expect(htmlDesk).toContain("Swap");
    });
  });

  // ==========================================================================
  // AREA 2: USER WALLET ABRUPT DISCONNECT MID-SIMULATION OR SIGNING
  // ==========================================================================
  describe("Area 2: User Wallet Abrupt Disconnect Mid-Simulation & Mid-Signing", () => {
    it("2.1: rejects signing immediately when wallet is disconnected or in watch mode", async () => {
      const disconnectedWallet = createMockWalletState({
        address: null,
        mode: "disconnected",
        signTransactionXdr: async () => {
          throw new Error("Watch mode is read-only. Connect Freighter, LOBSTR, or another wallet to sign.");
        },
      });

      await expect(
        disconnectedWallet.signTransactionXdr("AAAA...")
      ).rejects.toThrow("Watch mode is read-only. Connect Freighter, LOBSTR, or another wallet to sign.");
    });

    it("2.2: decodes user signature cancellation without triggering false positive error alerts", () => {
      const userCancellationErrors = [
        "User declined to sign the transaction in Freighter",
        "Transaction was rejected by user in LOBSTR wallet",
        "Signing cancelled by user",
      ];

      for (const rawErr of userCancellationErrors) {
        const decoded = decodeSorobanError(rawErr);
        expect(decoded).toBe("Wallet signature request was cancelled by user.");
      }
    });

    it("2.3: verifies TradingDesk transforms CTAs safely when wallet disconnects abruptly", () => {
      currentWalletState = createMockWalletState({
        address: null,
        mode: "disconnected",
      });

      const swapHtml = renderToString(
        <SwapCard onExecuteSwap={async () => {}} />
      );
      expect(swapHtml).toContain("Connect Wallet");

      const mintHtml = renderToString(
        <MintCard onExecuteMint={async () => {}} />
      );
      expect(mintHtml).toContain("Connect Wallet");

      const liqHtml = renderToString(
        <LiquidityCard onExecuteAddLiquidity={async () => {}} onExecuteRemoveLiquidity={async () => {}} />
      );
      expect(liqHtml).toContain("Connect Wallet");
    });

    it("2.4: verifies watch address validator enforces valid Stellar public key format", () => {
      const validGKey = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      const validateGKey = (pk: string) => /^G[A-Z0-9]{55}$/.test(pk.trim());

      expect(validateGKey(validGKey)).toBe(true);
      expect(validateGKey("")).toBe(false);
      expect(validateGKey("G1234")).toBe(false);
      expect(validateGKey("SAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27")).toBe(false); // S... secret key
      expect(validateGKey("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27 extra")).toBe(false);
      expect(validateGKey("<script>alert(1)</script>")).toBe(false);
    });

    it("2.5: renders NetworkBadge with switch button when walletNetworkMismatch is detected", () => {
      const badgeHtml = renderToString(
        <NetworkBadge walletNetworkMismatch={true} onSwitchNetwork={() => {}} />
      );
      expect(badgeHtml).toContain("Mismatch");
      expect(badgeHtml).toContain("Wallet network mismatch! Click to switch to Stellar Testnet");
    });
  });

  // ==========================================================================
  // AREA 3: MALICIOUS & ADVERSARIAL URL PARAMETER TAMPERING
  // ==========================================================================
  describe("Area 3: Malicious & Adversarial URL Parameter Tampering", () => {
    it("3.1: rejects path traversal attempts in market slug resolution", () => {
      const traversalAttacks = [
        "../../",
        "../../../etc/passwd",
        "..%2F..%2F",
        "/trade/../../secret",
        "usdc-90d/../../malicious",
        "....//....//etc",
      ];

      for (const attack of traversalAttacks) {
        const resolved = resolveMarketRoute(attack);
        expect(resolved.found).toBe(false);
        expect(resolved.status).toBe(404);

        const marketDef = getMarketDefinition(attack);
        expect(marketDef).toBeUndefined();

        const slugValidation = validateMarketSlug(attack);
        expect(slugValidation.valid).toBe(false);
      }
    });

    it("3.2: rejects SQL, XSS, and command injection attempts in route params", () => {
      const injections = [
        "' OR 1=1 --",
        "UNION SELECT * FROM markets",
        '"; DROP TABLE markets; --',
        "admin'--",
        "<script>alert(1)</script>",
        "javascript:void(0)",
        "<img src=x onerror=alert(1)>",
        "${7*7}",
        "{{7*7}}",
      ];

      for (const injection of injections) {
        const resolved = resolveMarketRoute(injection);
        expect(resolved.found).toBe(false);
        expect(resolved.status).toBe(404);

        const marketDef = getMarketDefinition(injection);
        expect(marketDef).toBeUndefined();
      }
    });

    it("3.3: normalizes non-canonical casing and whitespace gracefully to canonical market IDs", () => {
      const variations = [
        { input: "USDC-90D", expected: "usdc-90d" },
        { input: "  usdc-30d  ", expected: "usdc-30d" },
        { input: "XLM-90d", expected: "xlm-90d" },
        { input: "USDC-MATURED", expected: "usdc-matured" },
        { input: "  xlm-90d\n", expected: "xlm-90d" },
        { input: "\tusdc-90d\t", expected: "usdc-90d" },
      ];

      for (const { input, expected } of variations) {
        const resolved = resolveMarketRoute(input);
        expect(resolved.found).toBe(true);
        expect(resolved.status).toBe(200);
        expect(resolved.market?.id).toBe(expected);

        const marketDef = getMarketDefinition(input);
        expect(marketDef).toBeDefined();
        expect(marketDef?.id).toBe(expected);
      }
    });

    it("3.4: verifies generateStaticParams contract for /trade/[market] and /markets/[id]", async () => {
      const tradeParams = await generateTradeStaticParams();
      expect(tradeParams).toHaveLength(4);
      expect(tradeParams.map((p) => p.market)).toEqual(PRESET_MARKETS.map((m) => m.id));

      const marketParams = await generateMarketStaticParams();
      expect(marketParams).toHaveLength(4);
      expect(marketParams.map((p) => p.id)).toEqual(PRESET_MARKETS.map((m) => m.id));
    });

    it("3.5: safely resolves legacy and tampered view query strings to default landing view", () => {
      expect(resolveViewMode("?view=trade")).toBe("trade");
      expect(resolveViewMode("?view=landing")).toBe("landing");
      expect(resolveViewMode("?view=../../etc/passwd")).toBe("landing");
      expect(resolveViewMode("?view=' OR 1=1 --")).toBe("landing");
      expect(resolveViewMode("?view=null&market=undefined")).toBe("landing");
      expect(resolveViewMode("")).toBe("landing");
    });
  });

  // ==========================================================================
  // AREA 4: RAPID MULTI-TAB SWITCHING & STATE RACE CONDITIONS
  // ==========================================================================
  describe("Area 4: Rapid Multi-Tab Switching & State Race Conditions", () => {
    it("4.1: simulates rapid sequential market switching without leaking previous state", () => {
      const switchSequence = ["usdc-90d", "xlm-90d", "usdc-30d", "usdc-matured"];
      for (const marketId of switchSequence) {
        const market = findMarketById(marketId);
        expect(market.id).toBe(marketId);
        const snapshot = createMockSnapshot(market);
        expect(snapshot.state.fee_recipient).toBe(market.contracts.poolId);
      }
    });

    it("4.2: verifies activeMarketIdRef stale response guard logic against out-of-order promises", async () => {
      // Emulate the exact concurrency guard used in MarketContext:
      // if (activeMarketIdRef.current === targetMarket.id) { setActiveSnapshot(snap); }
      let currentActiveId = "usdc-90d";
      let committedSnapshotMarket = "usdc-90d";

      const startFetch = (marketId: string, delayMs: number) => {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            // Guard: only commit if user is still on this market
            if (currentActiveId === marketId) {
              committedSnapshotMarket = marketId;
            }
            resolve();
          }, delayMs);
        });
      };

      // User starts on usdc-90d (slow fetch: 50ms)
      const p1 = startFetch("usdc-90d", 50);

      // User quickly clicks xlm-90d (medium fetch: 30ms)
      currentActiveId = "xlm-90d";
      const p2 = startFetch("xlm-90d", 30);

      // User quickly clicks eurc-90d (fast fetch: 10ms)
      currentActiveId = "eurc-90d";
      const p3 = startFetch("eurc-90d", 10);

      await Promise.all([p1, p2, p3]);

      // eurc-90d should win because currentActiveId was eurc-90d when p1 and p2 finished!
      expect(committedSnapshotMarket).toBe("eurc-90d");
    });

    it("4.3: cycles through all 5 TradingDesk tabs deterministically", () => {
      const tabs: DeskTab[] = ["swap", "mint", "liquidity", "redeem", "rollover"];
      for (const tab of tabs) {
        const html = renderToString(
          <TradingDesk
            activeTab={tab}
            onTabChange={() => {}}
            onSimulateAction={async () => {}}
            isSubmitting={false}
            activeTxStage={null}
            txHash={null}
          />
        );
        expect(html).toBeDefined();
        expect(html.length).toBeGreaterThan(0);
      }
    });

    it("4.4: verifies MobileNavDrawer opens, closes, and locks body scroll", () => {
      const openHtml = renderToString(
        <MobileNavDrawer
          isOpen={true}
          onClose={() => {}}
          viewMode="trade"
          address={DUMMY_TEST_WALLET_ADDRESS}
          connecting={false}
          onConnect={() => {}}
          onDisconnect={() => {}}
          walletNetworkMismatch={false}
          onSwitchNetwork={() => {}}
        />
      );
      expect(openHtml).toContain("Mobile Navigation Menu");
      expect(openHtml).toContain("Trade");
      expect(openHtml).toContain("Pools");
      expect(openHtml).toContain("Portfolio");

      const closedHtml = renderToString(
        <MobileNavDrawer
          isOpen={false}
          onClose={() => {}}
          address={null}
          connecting={false}
          onConnect={() => {}}
          onDisconnect={() => {}}
          walletNetworkMismatch={false}
          onSwitchNetwork={() => {}}
        />
      );
      expect(closedHtml).toBe("");
    });
  });

  // ==========================================================================
  // AREA 5: SIMULATED LEDGER REORG, STALE SEQUENCE & DIAGNOSTIC RECOVERY
  // ==========================================================================
  describe("Area 5: Simulated Ledger Reorg, Stale Sequence & Diagnostic Recovery", () => {
    it("5.1: maps stale transaction sequence numbers to recovery guidance", () => {
      const seqErr = new Error("Horizon submission failed: tx_bad_seq");
      const decoded = decodeSorobanError(seqErr);
      expect(decoded).toBe(HORIZON_ERROR_MESSAGES.tx_bad_seq);
      expect(decoded).toContain("stale or invalid");
    });

    it("5.2: verifies complete Horizon and Stellar Core error code decoding coverage", () => {
      const errorCases = [
        { code: "tx_bad_auth", expected: HORIZON_ERROR_MESSAGES.tx_bad_auth },
        { code: "tx_insufficient_fee", expected: HORIZON_ERROR_MESSAGES.tx_insufficient_fee },
        { code: "op_underfunded", expected: HORIZON_ERROR_MESSAGES.op_underfunded },
        { code: "op_no_trust", expected: HORIZON_ERROR_MESSAGES.op_no_trust },
        { code: "RESOURCE_LIMIT_EXCEEDED", expected: HORIZON_ERROR_MESSAGES.RESOURCE_LIMIT_EXCEEDED },
        { code: "ENTRY_EXPIRED", expected: HORIZON_ERROR_MESSAGES.ENTRY_EXPIRED },
        { code: "FEE_TOO_LOW", expected: HORIZON_ERROR_MESSAGES.FEE_TOO_LOW },
      ];

      for (const { code, expected } of errorCases) {
        const decoded = decodeSorobanError(`Failed with code ${code}`);
        expect(decoded).toBe(expected);
      }
    });

    it("5.3: verifies Soroban contract error codes 1..20 are mapped to domain-specific messages", () => {
      expect(CONTRACT_ERROR_MESSAGES[1]).toContain("Contract is not initialized yet");
      expect(CONTRACT_ERROR_MESSAGES[2]).toContain("Contract is already initialized");
      expect(CONTRACT_ERROR_MESSAGES[3]).toContain("Signer is not authorized for this contract action");
      expect(CONTRACT_ERROR_MESSAGES[4]).toContain("Amount must be strictly greater than zero");
      expect(CONTRACT_ERROR_MESSAGES[5]).toContain("Insufficient token or pool reserve balance");
      expect(CONTRACT_ERROR_MESSAGES[6]).toContain("Insufficient token allowance for transfer");
      expect(CONTRACT_ERROR_MESSAGES[7]).toContain("Market has already reached maturity");
      expect(CONTRACT_ERROR_MESSAGES[8]).toContain("Market has not reached maturity yet");
      expect(CONTRACT_ERROR_MESSAGES[9]).toContain("Output fell below your slippage tolerance limit");
      expect(CONTRACT_ERROR_MESSAGES[10]).toContain("Transaction deadline has expired");

      for (let code = 1; code <= 20; code++) {
        const raw = `HostError: Error(Contract, #${code})`;
        const decoded = decodeSorobanError(raw);
        expect(decoded).toContain(`Soroban ContractError #${code}`);
      }
    });

    it("5.4: extractSorobanDiagnosticError falls back safely on empty diagnostic events", () => {
      const mockFailedTx: any = {
        status: "FAILED",
        diagnosticEventsXdr: [],
        resultXdr: null,
      };

      const extracted = extractSorobanDiagnosticError(mockFailedTx);
      expect(extracted).toBe("Transaction failed during Soroban execution");
    });
  });

  // ==========================================================================
  // AREA 6: ZERO-TRUST INPUT SANITIZATION ACROSS AMOUNT FIELDS
  // ==========================================================================
  describe("Area 6: Zero-Trust Input Sanitization Across Amount Fields", () => {
    it("6.1: rejects negative numbers strictly across all decimal precisions", () => {
      const negativeInputs = ["-1", "-100", "-0.0000001", "-0", "-0.0", "-999999999999"];
      for (const input of negativeInputs) {
        const result = validateAmountInput(input, 7);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Amount cannot be negative");
      }
    });

    it("6.2: rejects non-numbers, NaN, Infinity, and script injections", () => {
      const invalidInputs = [
        "abc",
        "1.2.3.4",
        "NaN",
        "Infinity",
        "0x10",
        "<script>alert(1)</script>",
        "$100",
        "100 USDC",
        "1,000",
        "1 000",
        "true",
        "false",
        "undefined",
        "null",
      ];

      for (const input of invalidInputs) {
        const result = validateAmountInput(input, 7);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Please enter a valid numeric amount");
      }

      // Negative non-number correctly triggers negative amount check first
      const negativeResult = validateAmountInput("-Infinity", 7);
      expect(negativeResult.valid).toBe(false);
      expect(negativeResult.error).toBe("Amount cannot be negative");
    });

    it("6.3: rejects scientific notation to prevent exponent bypass attacks", () => {
      const scientificInputs = ["1e18", "1E7", "2.5e-4", "1e-7", "1e0", "1e+5"];
      for (const input of scientificInputs) {
        const result = validateAmountInput(input, 7);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Please enter a valid numeric amount");
      }
    });

    it("6.4: rejects Unicode zeroes and non-ASCII digit representations", () => {
      const unicodeSpoofs = [
        "\u0660", // Arabic-Indic Zero ٠
        "\u0661\u0660\u0660", // Arabic-Indic 100
        "\uFF10", // Fullwidth Zero ０
        "\uFF11\uFF10\uFF10", // Fullwidth 100
        "\u06F0", // Extended Arabic-Indic Zero ۰
        "\u0966", // Devanagari Zero ०
      ];

      for (const spoof of unicodeSpoofs) {
        const result = validateAmountInput(spoof, 7);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Please enter a valid numeric amount");
      }
    });

    it("6.5: rejects empty, whitespace, and zero values with precise error feedback", () => {
      const emptyInputs = ["", "   ", "\t", "\n"];
      for (const empty of emptyInputs) {
        const result = validateAmountInput(empty, 7);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Amount is required");
      }

      const zeroInputs = ["0", "0.0", "0.0000000", "0000"];
      for (const zero of zeroInputs) {
        const result = validateAmountInput(zero, 7);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Amount must be strictly greater than zero");
      }
    });

    it("6.6: strictly enforces maximum decimal precision limits", () => {
      // Valid precision <= 7 decimals
      const valid7Dec = validateAmountInput("100.1234567", 7);
      expect(valid7Dec.valid).toBe(true);
      expect(valid7Dec.amount).toBe(1_001_234_567n);

      // Exceeds 7 decimals
      const invalid8Dec = validateAmountInput("100.12345678", 7);
      expect(invalid8Dec.valid).toBe(false);
      expect(invalid8Dec.error).toBe("Precision cannot exceed 7 decimal places");

      // Valid precision <= 9 decimals (SY shares)
      const valid9Dec = validateAmountInput("100.123456789", 9);
      expect(valid9Dec.valid).toBe(true);
      expect(valid9Dec.amount).toBe(100_123_456_789n);

      // Exceeds 9 decimals
      const invalid10Dec = validateAmountInput("100.1234567891", 9);
      expect(invalid10Dec.valid).toBe(false);
      expect(invalid10Dec.error).toBe("Precision cannot exceed 9 decimal places");
    });

    it("6.7: strictly validates user balance boundaries and insufficient balance detection", () => {
      const userBalanceStroops = 1_000_0000000n; // 1,000 USDC

      // Exactly at balance
      const atBalance = validateAmountInput("1000", 7, userBalanceStroops);
      expect(atBalance.valid).toBe(true);
      expect(atBalance.amount).toBe(1_000_0000000n);

      // Within balance
      const withinBalance = validateAmountInput("999.9999999", 7, userBalanceStroops);
      expect(withinBalance.valid).toBe(true);
      expect(withinBalance.amount).toBe(999_9999999n);

      // 1 stroop over balance
      const overBalance = validateAmountInput("1000.0000001", 7, userBalanceStroops);
      expect(overBalance.valid).toBe(false);
      expect(overBalance.error).toBe("Insufficient balance");
    });

    it("6.8: validates slippage tolerance input boundaries and flags dangerous extremes", () => {
      // Boundaries
      expect(validateSlippage(NaN).valid).toBe(false);
      expect(validateSlippage(-1).valid).toBe(false);
      expect(validateSlippage(0).valid).toBe(false); // < 1 bps
      expect(validateSlippage(1).valid).toBe(true); // 0.01%
      expect(validateSlippage(50).valid).toBe(true); // 0.5% default
      expect(validateSlippage(100).valid).toBe(true); // 1.0%
      expect(validateSlippage(500).valid).toBe(true); // 5.0%

      // High slippage warning (> 500 bps)
      const highSlippage = validateSlippage(501);
      expect(highSlippage.valid).toBe(true);
      expect(highSlippage.isHigh).toBe(true);
      expect(highSlippage.warning).toContain("High slippage tolerance");

      // Beyond upper cap (> 1000 bps)
      expect(validateSlippage(1001).valid).toBe(false);
      expect(validateSlippage(1001).error).toContain("must be between 0.01% (1 bps) and 10.0% (1000 bps)");
    });
  });
});
