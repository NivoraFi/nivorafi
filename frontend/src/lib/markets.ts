import { ENV } from "./env";
export { resolveMarketBlendPool } from "./blend";

export type MarketTenor = "30D" | "90D" | "180D" | "1Y" | "CUSTOM";
export type AssetCode = "USDC" | "XLM" | "EURC";
export type MarketStatus = "ACTIVE" | "MATURED";

export interface AssetConfig {
  code: AssetCode;
  symbol: string;
  name: string;
  decimals: number;
  sacContractId: string;
  issuer?: string;
  iconName: "usdc" | "xlm" | "eurc";
}

export interface MarketContracts {
  poolId: string;
  syId: string;
  ptId: string;
  ytId: string;
  blendPoolId: string;
  blendReserveAsset?: string;
  blendPoolType?: "mock" | "real_blend";
}

export interface MarketDefinition {
  id: string;
  factoryId?: number;
  name: string;
  ptSymbol: string;
  ytSymbol: string;
  sySymbol: string;
  lpSymbol: string;
  asset: AssetConfig;
  tenor: MarketTenor;
  maturity: number; // Unix timestamp in seconds
  maturityIso: string;
  scalarRoot: string;
  initialAnchor: string;
  contracts: MarketContracts;
  isRegisteredOnChain: boolean;
  isVerifiedTestnet: boolean;
}

export interface MarketSummaryMetrics {
  marketId: string;
  status: MarketStatus;
  daysToMaturity: number;
  impliedApyPct: number;
  blendRate: number;
  ptPriceInSy: number;
  tvlSy: bigint;
  tvlUsd: number;
  ptReserve: bigint;
  syReserve: bigint;
  isMatured: boolean;
  isLoading: boolean;
}

export const KNOWN_ASSETS: Record<AssetCode, AssetConfig> = {
  USDC: {
    code: "USDC",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 7,
    sacContractId: ENV.contracts.usdc_sac,
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    iconName: "usdc",
  },
  XLM: {
    code: "XLM",
    symbol: "XLM",
    name: "Stellar Lumens",
    decimals: 7,
    sacContractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // Testnet Native SAC
    iconName: "xlm",
  },
  EURC: {
    code: "EURC",
    symbol: "EURC",
    name: "Euro Coin",
    decimals: 7,
    sacContractId: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ", // Testnet EURC SAC
    issuer: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO",
    iconName: "eurc",
  },
};

// Canonical Preset Markets Catalog across 30D, 90D, 180D, 1Y, and USDC, XLM, EURC
export const PRESET_MARKETS: MarketDefinition[] = [
  {
    id: "usdc-90d",
    factoryId: 0,
    name: "Pendle bUSDC PT 90D",
    ptSymbol: "PT-bUSDC-90D",
    ytSymbol: "YT-bUSDC-90D",
    sySymbol: "sy-bUSDC",
    lpSymbol: "LP-PT-SY",
    asset: KNOWN_ASSETS.USDC,
    tenor: "90D",
    maturity: 1801909055, // 2027-02-06T10:17:35Z
    maturityIso: "2027-02-06T10:17:35Z",
    scalarRoot: "8000000000000000000",
    initialAnchor: "1000000000000000000",
    contracts: {
      poolId: ENV.contracts.yield_pool,
      syId: ENV.contracts.sy_blend_wrapper,
      ptId: ENV.contracts.pt_token,
      ytId: ENV.contracts.yt_token,
      blendPoolId: ENV.contracts.mock_blend,
    },
    isRegisteredOnChain: true,
    isVerifiedTestnet: true,
  },
  {
    id: "usdc-30d",
    factoryId: 1,
    name: "Pendle bUSDC PT 30D",
    ptSymbol: "PT-bUSDC-30D",
    ytSymbol: "YT-bUSDC-30D",
    sySymbol: "sy-bUSDC",
    lpSymbol: "LP-bUSDC-30D",
    asset: KNOWN_ASSETS.USDC,
    tenor: "30D",
    maturity: 1796725055, // 2026-12-08T10:17:35Z
    maturityIso: "2026-12-08T10:17:35Z",
    scalarRoot: "4000000000000000000",
    initialAnchor: "1000000000000000000",
    contracts: {
      poolId: "CCITOO7WPWXHNWQIF62CD7UEW6I3TKXCMPTW4BRTV4UCKBXXEZMZDSFD",
      syId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
      ptId: "CDDRGJXC6WT63RGEGA56QJ2EXUBSQSAXHHEQALQ3XJ7PBDK66RRDLLQO",
      ytId: "CAXRGVEYTP7GWAXVK4MPBI53YEQCSSZVCNKBFFW7KPXMTKV2LYOZKRJP",
      blendPoolId: ENV.contracts.mock_blend,
    },
    isRegisteredOnChain: true,
    isVerifiedTestnet: true,
  },
  {
    id: "xlm-90d",
    factoryId: 3,
    name: "Pendle bXLM PT 90D",
    ptSymbol: "PT-bXLM-90D",
    ytSymbol: "YT-bXLM-90D",
    sySymbol: "sy-bXLM",
    lpSymbol: "LP-bXLM-90D",
    asset: KNOWN_ASSETS.XLM,
    tenor: "90D",
    maturity: 1801909056,
    maturityIso: "2027-02-06T10:17:36Z",
    scalarRoot: "8000000000000000000",
    initialAnchor: "1000000000000000000",
    contracts: {
      poolId: "CAQ24DFWIZ4GHS6ES6DX236R5EYMMS3DF3BBZE63NKEDGRGO4B7IRTZ4",
      syId: "CAOUCLCZGM3WHGQ5S653WQHAMAMPP3UW4IC5VPUIW2XFVDAR3NFJ6B3W",
      ptId: "CCDD5IJCCNLAR2F5Y4663LFKKSQ32QMWGILFXY46E2SQ4SC3IKAZKRD3",
      ytId: "CC6VG5R454INCUWAS7K37H5H35Q4WNLH5Y72J4GLXRZ5R225XOFPD4ET",
      blendPoolId: "CAGWGDLWNSSQEYJEE45JEBXAKNJCIHLNUK26TLFFPIWG6PPXHOTJ6DCH",
    },
    isRegisteredOnChain: true,
    isVerifiedTestnet: true,
  },
  {
    id: "usdc-matured",
    factoryId: 4,
    name: "Pendle bUSDC PT (Matured)",
    ptSymbol: "PT-bUSDC-MAT",
    ytSymbol: "YT-bUSDC-MAT",
    sySymbol: "sy-bUSDC",
    lpSymbol: "LP-bUSDC-MAT",
    asset: KNOWN_ASSETS.USDC,
    tenor: "90D",
    maturity: 1794455723,
    maturityIso: "2026-11-12T03:55:23Z",
    scalarRoot: "8000000000000000000",
    initialAnchor: "1000000000000000000",
    contracts: {
      poolId: "CASJWZ7LPCGL2QRVOQNXLH4NYX556XW5GB5BX73K6VC7M2L354DQOMH5",
      syId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
      ptId: "CDO45MQP43VNVBF5QAU6ORKDVEV4D5RM2EUIBUVORGBUCGABT23JSKQW",
      ytId: "CDKFTNVVAVU5CSRX3V7GOJYS53MBF52MBRB26M2S4Y34JZWOH7YJQOBY",
      blendPoolId: ENV.contracts.mock_blend,
    },
    isRegisteredOnChain: true,
    isVerifiedTestnet: true,
  },
];

export function deriveMarketStatus(
  maturity: number,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): MarketStatus {
  return nowSeconds >= maturity ? "MATURED" : "ACTIVE";
}

export function calculateDaysToMaturity(
  maturity: number,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): number {
  if (nowSeconds >= maturity) return 0;
  return Math.max(0, (maturity - nowSeconds) / 86400);
}

export function filterMarkets(
  markets: MarketDefinition[],
  assetFilter: string,
  statusFilter: string,
  searchQuery?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): MarketDefinition[] {
  const normAsset = assetFilter.toUpperCase().trim();
  const normStatus = statusFilter.toUpperCase().trim();
  const normSearch = searchQuery ? searchQuery.toLowerCase().trim() : "";

  return markets.filter((market) => {
    // Asset filter
    if (normAsset !== "ALL" && market.asset.code !== normAsset) {
      return false;
    }

    // Status filter
    const status = deriveMarketStatus(market.maturity, nowSeconds);
    if (normStatus !== "ALL" && status !== normStatus) {
      return false;
    }

    // Search query filter
    if (normSearch) {
      const matchName = market.name.toLowerCase().includes(normSearch);
      const matchSymbol = market.ptSymbol.toLowerCase().includes(normSearch);
      const matchAsset = market.asset.code.toLowerCase().includes(normSearch);
      const matchPool = market.contracts.poolId.toLowerCase().includes(normSearch);
      const matchTenor = market.tenor.toLowerCase().includes(normSearch);
      if (!matchName && !matchSymbol && !matchAsset && !matchPool && !matchTenor) {
        return false;
      }
    }

    return true;
  });
}

export function getTopYieldMarket(
  markets: MarketDefinition[],
  metrics: Record<string, MarketSummaryMetrics>,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): MarketDefinition | null {
  const activeMarkets = markets.filter(
    (m) => deriveMarketStatus(m.maturity, nowSeconds) === "ACTIVE"
  );
  if (activeMarkets.length === 0) return null;

  let bestMarket: MarketDefinition | null = null;
  let highestApy = -Infinity;

  for (const m of activeMarkets) {
    const met = metrics[m.id];
    const apy = met ? met.impliedApyPct : 0;
    if (apy > highestApy) {
      highestApy = apy;
      bestMarket = m;
    }
  }

  return bestMarket ?? activeMarkets[0];
}

export function findMarketById(
  id: string,
  markets: MarketDefinition[] = PRESET_MARKETS
): MarketDefinition {
  const found = markets.find((m) => m.id === id);
  if (found) return found;
  return markets[0] ?? PRESET_MARKETS[0];
}

/**
 * Resolves a market definition by its unique slug/id.
 * Performs case-insensitive matching with whitespace trimming.
 * Returns `undefined` if no matching market is found (enables 404 notFound()).
 *
 * @param slug - The market identifier from dynamic route params (e.g. "usdc-90d")
 * @param markets - Catalog of markets, defaulting to canonical PRESET_MARKETS
 */
export function getMarketDefinition(
  slug: string,
  markets: MarketDefinition[] = PRESET_MARKETS
): MarketDefinition | undefined {
  if (!slug || typeof slug !== "string") {
    return undefined;
  }
  const normalized = slug.trim().toLowerCase();
  return markets.find((m) => m.id.toLowerCase() === normalized);
}

export function getDefaultMarket(): MarketDefinition {
  return PRESET_MARKETS[0];
}

/**
 * Canonical spot USD reference price per underlying asset on Stellar Testnet.
 */
export function getAssetPriceUsd(code: AssetCode): number {
  switch (code) {
    case "XLM":
      return 0.38;
    case "EURC":
      return 1.08;
    case "USDC":
    default:
      return 1.0;
  }
}

/**
 * Canonical Blend floating underlying APY (%) per market asset, aligned with indexerAnalytics.ts.
 */
export function getMarketUnderlyingApy(market: MarketDefinition): number {
  switch (market.asset.code) {
    case "XLM":
      return 3.2;
    case "EURC":
      return 3.8;
    case "USDC":
    default:
      return 4.85;
  }
}

/**
 * Canonical dynamic swap fee APY (%) per market pool and tenor.
 */
export function getMarketSwapFeeApy(
  market: MarketDefinition,
  isMatured = false
): number {
  if (isMatured) return 0;
  switch (market.id) {
    case "usdc-30d":
      return 1.85;
    case "usdc-90d":
      return 2.65;
    case "usdc-180d":
      return 3.4;
    case "xlm-90d":
      return 3.15;
    case "eurc-90d":
      return 2.1;
    default:
      return market.tenor === "30D" ? 1.85 : market.tenor === "90D" ? 2.65 : 3.4;
  }
}

interface MarketBaselinePreset {
  ptTokens: number;
  syTokens: number;
  impliedApyPct: number;
  ptPriceInSy: number;
  blendRate: number;
}

const MARKET_BASELINE_PRESETS: Record<string, MarketBaselinePreset> = {
  "usdc-90d": {
    ptTokens: 4_008.41,
    syTokens: 3_261.47,
    impliedApyPct: 8.45,
    ptPriceInSy: 0.98,
    blendRate: 1.001,
  },
  "usdc-30d": {
    ptTokens: 2_000.4,
    syTokens: 1_700.34,
    impliedApyPct: 6.2,
    ptPriceInSy: 0.995,
    blendRate: 1.001,
  },
  "xlm-90d": {
    ptTokens: 13_989.97,
    syTokens: 9_010.0,
    impliedApyPct: 11.4,
    ptPriceInSy: 0.9735,
    blendRate: 1.008,
  },
  "usdc-matured": {
    ptTokens: 300.0,
    syTokens: 150.0,
    impliedApyPct: 0,
    ptPriceInSy: 1.0,
    blendRate: 1.001,
  },
};

/**
 * Returns distinct, asset-priced baseline summary metrics per market before RPC hydration
 * (or when a preview/unseeded testnet pool reports zero liquidity).
 */
export function getMarketBaselineMetrics(
  market: MarketDefinition,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): MarketSummaryMetrics {
  const isMatured = nowSeconds >= market.maturity;
  const preset = MARKET_BASELINE_PRESETS[market.id] ?? {
    ptTokens: 50_000,
    syTokens: 30_000,
    impliedApyPct: market.tenor === "30D" ? 6.2 : market.tenor === "90D" ? 8.45 : 10.15,
    ptPriceInSy: 0.98,
    blendRate: 1.001,
  };

  const ptPriceInSy = isMatured ? 1.0 : preset.ptPriceInSy;
  const impliedApyPct = isMatured ? 0 : preset.impliedApyPct;
  const ptReserve = BigInt(Math.round(preset.ptTokens)) * 10_000_000n;
  const syReserve = BigInt(Math.round(preset.syTokens)) * 10_000_000n;
  const tvlSy = ptReserve + syReserve;
  const assetPriceUsd = getAssetPriceUsd(market.asset.code);
  const tvlUsd = Math.round(
    (preset.ptTokens * ptPriceInSy + preset.syTokens) * assetPriceUsd
  );

  return {
    marketId: market.id,
    status: isMatured ? "MATURED" : "ACTIVE",
    daysToMaturity: calculateDaysToMaturity(market.maturity, nowSeconds),
    impliedApyPct,
    blendRate: preset.blendRate,
    ptPriceInSy,
    tvlSy,
    tvlUsd,
    ptReserve,
    syReserve,
    isMatured,
    isLoading: false,
  };
}

export type AssetCategory = "All" | "Stables" | "Crypto" | "Liquid Staking";
export type MarketSortKey = "impliedApy" | "tvl" | "maturity" | "underlyingApy";
export type SortDirection = "asc" | "desc";

/**
 * Categorizes a market into standard DeFi asset classes:
 * - "Stables": USDC, EURC
 * - "Crypto": XLM
 * - "Liquid Staking": Synthetic LSTs (empty on testnet currently)
 */
export function getMarketCategory(market: MarketDefinition): AssetCategory {
  const code = market.asset.code.toUpperCase();
  if (code === "USDC" || code === "EURC") return "Stables";
  if (code === "XLM") return "Crypto";
  return "Stables";
}

/**
 * Filters and sorts markets according to category chips, deep contract address search,
 * and 4-column bidirectional metrics sorting.
 */
export function filterAndSortMarkets(
  markets: MarketDefinition[],
  category: AssetCategory = "All",
  searchQuery: string = "",
  sortKey: MarketSortKey | null = null,
  sortDirection: SortDirection = "desc",
  metrics: Record<string, MarketSummaryMetrics> = {},
  nowSeconds: number = Math.floor(Date.now() / 1000)
): MarketDefinition[] {
  const normSearch = searchQuery ? searchQuery.toLowerCase().trim() : "";

  // 1. Filter
  const filtered = markets.filter((market) => {
    // Category filter
    if (category !== "All") {
      const cat = getMarketCategory(market);
      if (cat !== category) return false;
    }

    // Deep search filter: symbol, name, tenor, and contract addresses
    if (normSearch) {
      const matchName = market.name.toLowerCase().includes(normSearch);
      const matchPtSymbol = market.ptSymbol.toLowerCase().includes(normSearch);
      const matchYtSymbol = market.ytSymbol.toLowerCase().includes(normSearch);
      const matchAsset = market.asset.code.toLowerCase().includes(normSearch);
      const matchTenor = market.tenor.toLowerCase().includes(normSearch);
      const matchId = market.id.toLowerCase().includes(normSearch);

      const contracts = market.contracts;
      const matchPool = contracts.poolId?.toLowerCase().includes(normSearch);
      const matchPt = contracts.ptId?.toLowerCase().includes(normSearch);
      const matchYt = contracts.ytId?.toLowerCase().includes(normSearch);
      const matchSy = contracts.syId?.toLowerCase().includes(normSearch);
      const matchBlend = contracts.blendPoolId?.toLowerCase().includes(normSearch);
      const matchSac = market.asset.sacContractId?.toLowerCase().includes(normSearch);

      if (
        !matchName &&
        !matchPtSymbol &&
        !matchYtSymbol &&
        !matchAsset &&
        !matchTenor &&
        !matchId &&
        !matchPool &&
        !matchPt &&
        !matchYt &&
        !matchSy &&
        !matchBlend &&
        !matchSac
      ) {
        return false;
      }
    }

    return true;
  });

  // 2. Sort
  if (!sortKey) {
    return filtered;
  }

  const sorted = [...filtered].sort((a, b) => {
    let valA = 0;
    let valB = 0;

    switch (sortKey) {
      case "impliedApy": {
        valA = metrics[a.id]?.impliedApyPct ?? 0;
        valB = metrics[b.id]?.impliedApyPct ?? 0;
        break;
      }
      case "tvl": {
        valA = metrics[a.id]?.tvlUsd ?? 0;
        valB = metrics[b.id]?.tvlUsd ?? 0;
        break;
      }
      case "maturity": {
        valA = a.maturity;
        valB = b.maturity;
        break;
      }
      case "underlyingApy": {
        valA = getMarketUnderlyingApy(a);
        valB = getMarketUnderlyingApy(b);
        break;
      }
      default:
        return 0;
    }

    if (valA < valB) return sortDirection === "asc" ? -1 : 1;
    if (valA > valB) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });

  return sorted;
}
