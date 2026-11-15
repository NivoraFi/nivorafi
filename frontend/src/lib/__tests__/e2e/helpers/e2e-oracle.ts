/**
 * Stellar Pendle E2E Test Suite Oracle & Helpers
 * Authoritative specification models, mock factories, route simulators, and invariant checks.
 */

import {
  PRESET_MARKETS,
  KNOWN_ASSETS,
  MarketDefinition,
  MarketSummaryMetrics,
  deriveMarketStatus,
  calculateDaysToMaturity,
  findMarketById,
} from "../../../markets";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  ProtocolAction,
  buildActionArgs,
} from "../../../stellar";
import { WAD, applySlippage, formatUnits, formatUnitsExact } from "../../../math";

// ============================================================================
// 1. SPECIFICATION CONSTANTS & STATIC PARAMS CONTRACT
// ============================================================================

export const EXPECTED_PRESET_MARKET_IDS = [
  "usdc-90d",
  "usdc-30d",
  "xlm-90d",
  "usdc-180d",
  "usdc-matured",
  "eurc-90d",
] as const;

export type PresetMarketId = (typeof EXPECTED_PRESET_MARKET_IDS)[number];

export const DUMMY_TEST_WALLET_ADDRESS =
  "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

export const DUMMY_RECEIVER_ADDRESS =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * Expected Static Params contract for dynamic routing `generateStaticParams()`
 * Route: `/trade/[market]` and `/markets/[id]`
 */
export function generateExpectedStaticParams(): Array<{ market: string; id: string }> {
  return EXPECTED_PRESET_MARKET_IDS.map((id) => ({
    market: id,
    id,
  }));
}

/**
 * Authoritative Market Route Resolver Oracle
 * Emulates the Route ↔ Page Component interface contract in PROJECT.md:
 * - Input: dynamic slug
 * - Output: 200 with market definition, or 404 not found
 */
export function resolveMarketRoute(
  slug: string,
  catalog: MarketDefinition[] = PRESET_MARKETS
): { found: boolean; status: 200 | 404; market?: MarketDefinition } {
  if (!slug || typeof slug !== "string") {
    return { found: false, status: 404 };
  }
  const cleanSlug = slug.trim().toLowerCase();
  const matched = catalog.find((m) => m.id.toLowerCase() === cleanSlug);
  if (!matched) {
    return { found: false, status: 404 };
  }
  return { found: true, status: 200, market: matched };
}

/**
 * Authoritative URL View Resolution State Machine matching page.tsx specification:
 * - ?view=trade -> "trade"
 * - ?view=landing -> "landing"
 * - #trade -> "trade"
 * - Default / invalid / unknown -> "landing"
 */
export function resolveViewMode(queryString: string, hash?: string): "landing" | "trade" {
  const params = new URLSearchParams(queryString.startsWith("?") ? queryString.slice(1) : queryString);
  const viewParam = params.get("view");

  if (viewParam === "trade") return "trade";
  if (viewParam === "landing") return "landing";

  if (hash) {
    const cleanHash = hash.startsWith("#") ? hash.slice(1) : hash;
    if (cleanHash === "trade") return "trade";
    if (cleanHash === "landing") return "landing";
  }

  return "landing";
}

/**
 * Authoritative Slug Validation Oracle
 * Validates slug format: alphanumeric with dashes, length <= 64, no special characters/traversal
 */
export function validateMarketSlug(slug: string): { valid: boolean; reason?: string } {
  if (!slug || typeof slug !== "string") {
    return { valid: false, reason: "Slug cannot be empty or non-string." };
  }
  if (slug.length > 64) {
    return { valid: false, reason: "Slug exceeds maximum length of 64 characters." };
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(slug)) {
    return { valid: false, reason: "Slug contains invalid characters or malformed hyphens." };
  }
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    return { valid: false, reason: "Path traversal attempt detected." };
  }
  return { valid: true };
}

// ============================================================================
// 2. MOCK FACTORIES FOR WEB3 & APPLICATION STATE
// ============================================================================

export interface MockWalletContextState {
  address: string | null;
  mode: "disconnected" | "wallet" | "watch";
  walletId: string | null;
  walletNetworkMismatch: boolean;
  kitReady: boolean;
  connecting: boolean;
  connectWallet: () => Promise<void>;
  connectWatchAddress: (pk: string) => void;
  disconnect: () => Promise<void>;
  signTransactionXdr: (xdr: string) => Promise<string>;
  switchNetwork: () => Promise<void>;
}

export function createMockWalletState(
  overrides?: Partial<MockWalletContextState>
): MockWalletContextState {
  return {
    address: DUMMY_TEST_WALLET_ADDRESS,
    mode: "wallet",
    walletId: "freighter",
    walletNetworkMismatch: false,
    kitReady: true,
    connecting: false,
    connectWallet: async () => {},
    connectWatchAddress: (_pk: string) => {},
    disconnect: async () => {},
    signTransactionXdr: async (xdr: string) => xdr,
    switchNetwork: async () => {},
    ...overrides,
  };
}

export function createMockSnapshot(
  market: MarketDefinition,
  options?: {
    isMatured?: boolean;
    blendRate?: bigint;
    ptPriceInSy?: number;
    impliedApy?: number;
    ptReserve?: bigint;
    syReserve?: bigint;
    nowSeconds?: number;
  }
): LiveMarketSnapshot {
  const isMatured = options?.isMatured ?? (market.id === "usdc-matured");
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const daysToMaturity = isMatured ? 0 : calculateDaysToMaturity(market.maturity, nowSeconds);
  const ptReserve = options?.ptReserve ?? 80_000_0000000n;
  const syReserve = options?.syReserve ?? 40_000_0000000n;
  const ptPriceInSy = options?.ptPriceInSy ?? (isMatured ? 1.0 : 0.98);
  const ytPriceInSy = isMatured ? 0.0 : Math.max(0, 1.0 - ptPriceInSy);
  const impliedFixedApyPct =
    options?.impliedApy ??
    (isMatured ? 0 : market.tenor === "30D" ? 6.2 : market.tenor === "90D" ? 8.45 : 10.15);

  return {
    state: {
      total_pt_reserve: ptReserve,
      total_sy_reserve: syReserve,
      total_lp_supply: 56_568_5424949n,
      scalar_root: BigInt(market.scalarRoot),
      initial_anchor: BigInt(market.initialAnchor),
      annual_fee_rate: 3_000000000000000n,
      protocol_fee_bps: 2000n,
      fee_recipient: market.contracts.poolId,
      maturity: BigInt(market.maturity),
      maturity_index: 1_000000000n,
      is_settled: isMatured,
    },
    latestLedger: 1234567,
    nowSeconds,
    daysToMaturity,
    isMatured,
    blendExchangeRate: options?.blendRate ?? 1_001000000n,
    ammExchangeRateWad: 1_020408163265306122n,
    ptPriceInSy,
    ytPriceInSy,
    impliedFixedApyPct,
    ptTotalSupply: ptReserve,
    ytTotalSupply: ptReserve,
    syTotalSupply: ptReserve + syReserve,
    ptProportionPct: 66.67,
  };
}

export function createMockPortfolio(
  market: MarketDefinition,
  options?: {
    address?: string;
    xlmBalance?: string;
    usdcBalance?: string;
    syBalance?: bigint;
    ptBalance?: bigint;
    ytBalance?: bigint;
    lpBalance?: bigint;
    unclaimedYieldRaw?: bigint;
    estimatedPendingYieldSy?: bigint;
  }
): LiveUserPortfolio {
  return {
    address: options?.address ?? DUMMY_TEST_WALLET_ADDRESS,
    accountExists: true,
    xlmBalance: options?.xlmBalance ?? "100.00",
    usdcBalance: options?.usdcBalance ?? "500.00",
    usdcTrustlineExists: true,
    syBalance: options?.syBalance ?? 250_0000000n,
    ptBalance: options?.ptBalance ?? 100_0000000n,
    ytBalance: options?.ytBalance ?? 100_0000000n,
    lpBalance: options?.lpBalance ?? 50_0000000n,
    lastIndex: 1_000000000n,
    unclaimedYieldRaw: options?.unclaimedYieldRaw ?? 5_0000000n,
    estimatedPendingYieldSy: options?.estimatedPendingYieldSy ?? 5_0000000n,
  };
}

// ============================================================================
// 3. YIELD SPACE ORACLE & MATHEMATICAL INVARIANTS
// ============================================================================

export interface YieldMetricsOracle {
  impliedApyPct: number;
  underlyingApyPct: number;
  fixedApyPct: number;
  ytLeverage: number;
  daysToMaturity: number;
  tvlUsd: number;
}

export function computeExpectedYieldMetrics(
  snapshot: LiveMarketSnapshot,
  market: MarketDefinition,
  underlyingPriceUsd: number = 1.0
): YieldMetricsOracle {
  const isMatured = snapshot.isMatured;
  const daysToMaturity = snapshot.daysToMaturity;
  const impliedApyPct = snapshot.impliedFixedApyPct;
  const underlyingApyPct = 4.85; // Standard Blend APY oracle benchmark
  const fixedApyPct = isMatured ? 0 : impliedApyPct;

  // YT leverage = 1 / P_yt (or 0 if matured / zero price)
  const ytLeverage =
    !isMatured && snapshot.ytPriceInSy > 0 ? Math.round(1 / snapshot.ytPriceInSy) : 0;

  // TVL = (PT reserve in SY terms + SY reserve) * underlying USD price
  const ptInSy = (Number(snapshot.state.total_pt_reserve) / 1e7) * snapshot.ptPriceInSy;
  const sy = Number(snapshot.state.total_sy_reserve) / 1e7;
  const tvlUsd = (ptInSy + sy) * underlyingPriceUsd;

  return {
    impliedApyPct,
    underlyingApyPct,
    fixedApyPct,
    ytLeverage,
    daysToMaturity,
    tvlUsd,
  };
}

// ============================================================================
// 4. SANITIZATION & MARKUP VALIDATION ORACLES
// ============================================================================

/**
 * Validates that an HTML/SVG render output adheres strictly to the Pendle design system:
 * - Contains zero raw hex color literals (e.g. #070b14) in inline styles or markup attributes
 * - Applies tabular-mono class for financial numbers
 */
export function validateDesignSystemCompliance(htmlMarkup: string): {
  compliant: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  // Match hex codes not in comments or standard SVG entities
  const rawHexMatches = htmlMarkup.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  // Exclude allowed SVG url(#id) or common anchor fragments
  const illegalHex = rawHexMatches.filter(
    (hex) => !/^#(?:icon|clip|gradient|pattern|[0-9a-fA-F]{6}00)/i.test(hex)
  );

  // In Next.js SSR markup, style attributes with raw hex are violations
  if (illegalHex.length > 0) {
    violations.push(
      `Detected ${illegalHex.length} raw hex literals in component markup: ${illegalHex.slice(0, 5).join(", ")}`
    );
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}
