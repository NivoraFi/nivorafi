import { Database } from "bun:sqlite";
import { Account, Address, BASE_FEE, Contract, Networks, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { statSync, existsSync } from "fs";
import { join } from "path";
import { timingSafeEqual } from "crypto";

// ============================================================================
// 1. Network & Contract Configuration
// ============================================================================

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const DB_PATH = join(import.meta.dir, "events.db");

export function resolveHttpPort(rawPort: string | undefined = process.env.INDEXER_PORT || process.env.PORT): number {
  if (!rawPort) return 8765;
  const trimmed = rawPort.trim();
  if (!/^\d+$/.test(trimmed)) return 8765;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8765;
}

export const HTTP_PORT = resolveHttpPort();
export const HTTP_HOST = "0.0.0.0";
export const POLL_INTERVAL_MS = 4000;
export const INITIAL_START_LEDGER = 5646000;
export const INDEXER_API_SECRET = (process.env.INDEXER_API_SECRET || "").trim();

export const CONTRACT_CATALOG: { id: string; label: string; role: string }[] = [
  // Global Infrastructure
  { id: "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL", label: "Market Factory & Rollover Router", role: "market_factory" },
  { id: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6", label: "Mock Blend Pool (bUSDC)", role: "mock_blend" },
  { id: "CAGWGDLWNSSQEYJEE45JEBXAKNJCIHLNUK26TLFFPIWG6PPXHOTJ6DCH", label: "Mock Blend Pool (bXLM)", role: "mock_blend" },

  // Market 0: Pendle bUSDC PT 90D
  { id: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF", label: "Yield Pool AMM (usdc-90d)", role: "yield_pool" },
  { id: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5", label: "SY Blend Wrapper (sy-bUSDC)", role: "sy_wrapper" },
  { id: "CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A", label: "Principal Token (PT-bUSDC-90D)", role: "pt_token" },
  { id: "CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73", label: "Yield Token (YT-bUSDC-90D)", role: "yt_token" },

  // Market 1: Pendle bUSDC PT 30D
  { id: "CCITOO7WPWXHNWQIF62CD7UEW6I3TKXCMPTW4BRTV4UCKBXXEZMZDSFD", label: "Yield Pool AMM (usdc-30d)", role: "yield_pool" },
  { id: "CDDRGJXC6WT63RGEGA56QJ2EXUBSQSAXHHEQALQ3XJ7PBDK66RRDLLQO", label: "Principal Token (PT-bUSDC-30D)", role: "pt_token" },
  { id: "CAXRGVEYTP7GWAXVK4MPBI53YEQCSSZVCNKBFFW7KPXMTKV2LYOZKRJP", label: "Yield Token (YT-bUSDC-30D)", role: "yt_token" },

  // Market 3: Pendle bXLM PT 90D (authoritative deployed_contracts.json factoryId 3)
  { id: "CAQ24DFWIZ4GHS6ES6DX236R5EYMMS3DF3BBZE63NKEDGRGO4B7IRTZ4", label: "Yield Pool AMM (xlm-90d)", role: "yield_pool" },
  { id: "CAOUCLCZGM3WHGQ5S653WQHAMAMPP3UW4IC5VPUIW2XFVDAR3NFJ6B3W", label: "SY Wrapper (sy-bXLM)", role: "sy_wrapper" },
  { id: "CCDD5IJCCNLAR2F5Y4663LFKKSQ32QMWGILFXY46E2SQ4SC3IKAZKRD3", label: "Principal Token (PT-bXLM-90D)", role: "pt_token" },
  { id: "CC6VG5R454INCUWAS7K37H5H35Q4WNLH5Y72J4GLXRZ5R225XOFPD4ET", label: "Yield Token (YT-bXLM-90D)", role: "yt_token" },

  // Market 4: Pendle bUSDC PT Matured (authoritative deployed_contracts.json factoryId 4)
  { id: "CASJWZ7LPCGL2QRVOQNXLH4NYX556XW5GB5BX73K6VC7M2L354DQOMH5", label: "Yield Pool AMM (usdc-matured)", role: "yield_pool" },
  { id: "CDO45MQP43VNVBF5QAU6ORKDVEV4D5RM2EUIBUVORGBUCGABT23JSKQW", label: "Principal Token (PT-bUSDC-MAT)", role: "pt_token" },
  { id: "CDKFTNVVAVU5CSRX3V7GOJYS53MBF52MBRB26M2S4Y34JZWOH7YJQOBY", label: "Yield Token (YT-bUSDC-MAT)", role: "yt_token" },

  // Market 5: Pendle sUSDC PT 90D (Slender sUSDC SY Adapter)
  { id: "CBZAIQZCWK6AWE3UHLC7EZUSDPBOS767LA5TAASK4SSLZRNAYHKPBYRS", label: "Mock Slender Pool (sUSDC)", role: "mock_slender" },
  { id: "CACPNCMRPCYXT2IFNAIYY7DVTZARI2HFKIFMX2LBUTJ3YU6Z6QVBQDC5", label: "Yield Pool AMM (usdc-slender-90d)", role: "yield_pool" },
  { id: "CA5Q7BXAPRO3XULUEDTFVFZU2ZU2N7Z6CLZNQW7WDDKVJV6776DGHPCJ", label: "SY Slender Wrapper (sy-sUSDC)", role: "sy_wrapper" },
  { id: "CBNRSIS3ACCYL7ORHU6XP3YGMEBLZAJN3HOWSJIFAYBH7I7VIZUGSIK5", label: "Principal Token (PT-sUSDC-90D)", role: "pt_token" },
  { id: "CCKMWQO2HNOP3L6CZU73KNEZLN3XVZ7EWAMCA77CAYY5FW3XZWO6DPCA", label: "Yield Token (YT-sUSDC-90D)", role: "yt_token" },

  // Underlying SACs
  { id: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", label: "USDC SAC", role: "underlying_sac" },
  { id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", label: "Native XLM SAC", role: "underlying_sac" },
  { id: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ", label: "EURC SAC", role: "underlying_sac" },
];

export const ALL_CONTRACT_IDS = CONTRACT_CATALOG.map((c) => c.id);

// Split into batches of at most 5 contracts per filter (Soroban RPC requirement)
export function chunkContractFilters(contractIds: string[]): { type: "contract"; contractIds: string[] }[] {
  const filters: { type: "contract"; contractIds: string[] }[] = [];
  const chunkSize = 5;
  for (let i = 0; i < contractIds.length; i += chunkSize) {
    filters.push({
      type: "contract",
      contractIds: contractIds.slice(i, i + chunkSize),
    });
  }
  return filters;
}

// ============================================================================
// 2. Market Metadata & Mathematical Pricing Models
// ============================================================================

export interface MarketMetadata {
  id: string; // Canonical identifier e.g. "usdc-90d"
  factoryId: number;
  name: string;
  poolId: string;
  syId: string;
  ptId: string;
  ytId: string;
  blendPoolId: string;
  asset: string;
  assetPriceUsd: number;
  tenor: string;
  maturity: number; // Unix timestamp in seconds
  scalarRoot: number;
  initialAnchor: number;
  underlyingApy: number; // Percentage e.g. 4.85
}

export const DEFAULT_MARKET: MarketMetadata = {
  id: "usdc-90d",
  factoryId: 0,
  name: "Pendle bUSDC PT 90D",
  poolId: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
  syId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
  ptId: "CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A",
  ytId: "CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73",
  blendPoolId: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
  asset: "USDC",
  assetPriceUsd: 1.0,
  tenor: "90D",
  maturity: 1801909055, // 2027-02-06T10:17:35Z
  scalarRoot: 8.0,
  initialAnchor: 1.0,
  underlyingApy: 4.85,
};

export const MARKETS: Record<string, MarketMetadata> = {
  "usdc-90d": DEFAULT_MARKET,
  "usdc-30d": {
    id: "usdc-30d",
    factoryId: 1,
    name: "Pendle bUSDC PT 30D",
    poolId: "CCITOO7WPWXHNWQIF62CD7UEW6I3TKXCMPTW4BRTV4UCKBXXEZMZDSFD",
    syId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
    ptId: "CDDRGJXC6WT63RGEGA56QJ2EXUBSQSAXHHEQALQ3XJ7PBDK66RRDLLQO",
    ytId: "CAXRGVEYTP7GWAXVK4MPBI53YEQCSSZVCNKBFFW7KPXMTKV2LYOZKRJP",
    blendPoolId: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
    asset: "USDC",
    assetPriceUsd: 1.0,
    tenor: "30D",
    maturity: 1796725055, // 2026-12-08T10:17:35Z
    scalarRoot: 4.0,
    initialAnchor: 1.0,
    underlyingApy: 4.85,
  },
  "xlm-90d": {
    id: "xlm-90d",
    factoryId: 3,
    name: "Pendle bXLM PT 90D",
    poolId: "CAQ24DFWIZ4GHS6ES6DX236R5EYMMS3DF3BBZE63NKEDGRGO4B7IRTZ4",
    syId: "CAOUCLCZGM3WHGQ5S653WQHAMAMPP3UW4IC5VPUIW2XFVDAR3NFJ6B3W",
    ptId: "CCDD5IJCCNLAR2F5Y4663LFKKSQ32QMWGILFXY46E2SQ4SC3IKAZKRD3",
    ytId: "CC6VG5R454INCUWAS7K37H5H35Q4WNLH5Y72J4GLXRZ5R225XOFPD4ET",
    blendPoolId: "CAGWGDLWNSSQEYJEE45JEBXAKNJCIHLNUK26TLFFPIWG6PPXHOTJ6DCH",
    asset: "XLM",
    assetPriceUsd: 0.12,
    tenor: "90D",
    maturity: 1801909056, // 2027-02-06T10:17:36Z
    scalarRoot: 8.0,
    initialAnchor: 1.0,
    underlyingApy: 3.2,
  },
  "usdc-matured": {
    id: "usdc-matured",
    factoryId: 4,
    name: "Pendle bUSDC PT Matured",
    poolId: "CASJWZ7LPCGL2QRVOQNXLH4NYX556XW5GB5BX73K6VC7M2L354DQOMH5",
    syId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
    ptId: "CDO45MQP43VNVBF5QAU6ORKDVEV4D5RM2EUIBUVORGBUCGABT23JSKQW",
    ytId: "CDKFTNVVAVU5CSRX3V7GOJYS53MBF52MBRB26M2S4Y34JZWOH7YJQOBY",
    blendPoolId: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
    asset: "USDC",
    assetPriceUsd: 1.0,
    tenor: "MATURED",
    maturity: 1794455723, // 2026-11-12T03:55:23Z
    scalarRoot: 8.0,
    initialAnchor: 1.0,
    underlyingApy: 4.85,
  },
  "usdc-slender-90d": {
    id: "usdc-slender-90d",
    factoryId: 5,
    name: "Pendle sUSDC PT 90D (Slender)",
    poolId: "CACPNCMRPCYXT2IFNAIYY7DVTZARI2HFKIFMX2LBUTJ3YU6Z6QVBQDC5",
    syId: "CA5Q7BXAPRO3XULUEDTFVFZU2ZU2N7Z6CLZNQW7WDDKVJV6776DGHPCJ",
    ptId: "CBNRSIS3ACCYL7ORHU6XP3YGMEBLZAJN3HOWSJIFAYBH7I7VIZUGSIK5",
    ytId: "CCKMWQO2HNOP3L6CZU73KNEZLN3XVZ7EWAMCA77CAYY5FW3XZWO6DPCA",
    blendPoolId: "CBZAIQZCWK6AWE3UHLC7EZUSDPBOS767LA5TAASK4SSLZRNAYHKPBYRS",
    asset: "USDC",
    assetPriceUsd: 1.0,
    tenor: "90D",
    maturity: 1801909057, // 2027-02-06T10:17:37Z
    scalarRoot: 8.0,
    initialAnchor: 1.0,
    underlyingApy: 4.85,
  },
};

export const SCALAR_9_BIG = 1_000_000_000n;

export function syToAssetBigInt(pyIndex: bigint, syAmount: bigint): bigint {
  const idx = pyIndex > 0n ? pyIndex : SCALAR_9_BIG;
  return (syAmount * idx) / SCALAR_9_BIG;
}

export function resolveMarket(identifier: string): MarketMetadata | null {
  if (!identifier) return DEFAULT_MARKET;
  const trimmed = identifier.trim();
  const lower = trimmed.toLowerCase();
  if (MARKETS[lower]) return MARKETS[lower]!;

  for (const m of Object.values(MARKETS)) {
    if (m.poolId === trimmed || m.ptId === trimmed || m.ytId === trimmed) {
      return m;
    }
  }
  for (const m of Object.values(MARKETS)) {
    if (m.poolId.toLowerCase() === lower || m.id.toLowerCase() === lower) {
      return m;
    }
  }
  return null;
}

export function getMarketForContract(contractId: string): MarketMetadata | null {
  for (const m of Object.values(MARKETS)) {
    if (m.poolId === contractId || m.ptId === contractId || m.ytId === contractId) {
      return m;
    }
  }
  for (const m of Object.values(MARKETS)) {
    if (m.syId === contractId) {
      return m;
    }
  }
  return null;
}

/**
 * Calculates continuous annualized Implied APY from PT spot price and time to maturity.
 * Uses numerical stability guards: linear Taylor expansion when close to maturity,
 * and clamping to avoid overflow or nonsensical values.
 */
export function calculateImpliedApy(ptPrice: number, tauYears: number): number {
  if (tauYears <= 0 || ptPrice >= 1.0 || ptPrice <= 0) return 0.0;
  // If less than 1 hour to maturity, use linear Taylor expansion to prevent exponent overflow
  if (tauYears < 3600 / 31536000) {
    const aprLinear = ((1.0 - ptPrice) / (ptPrice * tauYears)) * 100;
    return Math.min(500.0, Math.max(0.0, Math.round(aprLinear * 10000) / 10000));
  }
  const expTerm = 1.0 / tauYears;
  const apy = (Math.pow(1.0 / ptPrice, expTerm) - 1.0) * 100;
  if (isNaN(apy) || !isFinite(apy) || apy < 0) return 0.0;
  return Math.min(500.0, Math.round(apy * 10000) / 10000);
}

// Chart Schema Types
export interface MarketChartPoint {
  timestamp: number;
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  impliedApy: number;
  underlyingApy: number;
  ptPrice: number;
  ytPrice: number;
  volume: string;
  tvl: string;
  tradeCount?: number;
}

export interface MarketChartSummary {
  marketId: string;
  interval: string;
  highApy: number;
  lowApy: number;
  currentApy: number;
  highPrice: number;
  lowPrice: number;
  currentPrice: number;
  volumeTotal: string;
  currentTvl: string;
  tradesCount: number;
}

export interface MarketChartsResponse {
  success: boolean;
  market: string;
  interval: string;
  count: number;
  data: MarketChartPoint[];
  summary: MarketChartSummary;
}

// ============================================================================
// Milestone 2: User Position & PnL Tracking Interfaces (Madde 2)
// ============================================================================

export interface UserMarketPosition {
  marketId: string;
  marketAddress: string;
  assetCode: string;
  costBasisStroops: string;
  costBasisUsd: number;
  averageEntryApy: number;
  currentPtBalance: string;
  currentYtBalance: string;
  currentLpBalance: string;
  currentPositionValueUsd: number;
  realizedPnlStroops: string;
  realizedPnlUsd: number;
  unrealizedPnlStroops: string;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
  cumulativeClaimedYieldStroops: string;
  cumulativeClaimedYieldUsd: number;
  firstTradeTimestamp: number;
  lastActivityTimestamp: number;
  totalTradesCount: number;
}

export interface UserPositionsSummary {
  userAddress: string;
  totalCostBasisUsd: number;
  totalCurrentValueUsd: number;
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  totalNetPnlUsd: number;
  totalClaimedYieldUsd: number;
  overallPortfolioApy: number;
  activePositionsCount: number;
  totalTransactionsCount: number;
}

export interface UserPositionsResponse {
  success: boolean;
  user: string;
  count: number;
  positions: UserMarketPosition[];
  summary: UserPositionsSummary;
}

interface SnapshotDbRow {
  market_id?: string;
  interval?: string;
  bucket_timestamp: number;
  bucket_iso?: string;
  open_price: number;
  high_price: number;
  low_price: number;
  close_price: number;
  implied_apy: number;
  underlying_apy: number;
  pt_price: number;
  yt_price: number;
  volume_sy: string;
  tvl_sy: string;
  trade_count: number;
}

// ============================================================================
// 3. Safe ScVal and Event Decoding
// ============================================================================

export function scValToBigInt(val: unknown): bigint {
  if (val === undefined || val === null) return 0n;
  if (typeof val === "bigint") return val;
  if (typeof val === "number") {
    if (isNaN(val) || !isFinite(val)) return 0n;
    return BigInt(Math.trunc(val));
  }
  if (typeof val === "string") {
    try {
      const trimmed = val.trim();
      if (!trimmed || trimmed === "NaN" || trimmed === "Infinity" || trimmed === "-Infinity") return 0n;
      return BigInt(trimmed);
    } catch {
      return 0n;
    }
  }
  if (typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;
    if ("i128" in obj) return scValToBigInt(obj.i128);
    if ("u64" in obj) return scValToBigInt(obj.u64);
    if ("i64" in obj) return scValToBigInt(obj.i64);
    if ("u32" in obj) return scValToBigInt(obj.u32);
    if ("i32" in obj) return scValToBigInt(obj.i32);
    if ("value" in obj) return scValToBigInt(obj.value);
    try {
      const native = scValToNative(val as unknown as xdr.ScVal);
      return scValToBigInt(native);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function scValToAddress(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && val !== null) {
    try {
      const native = scValToNative(val as unknown as xdr.ScVal);
      if (typeof native === "string") return native;
    } catch {
      // Fallback
    }
    const anyVal = val as {
      switch?: () => { name?: string };
      address?: () => xdr.ScAddress;
      toString?: () => string;
    };
    if (typeof anyVal.switch === "function" && anyVal.switch()?.name === "scvAddress" && typeof anyVal.address === "function") {
      try {
        return Address.fromScAddress(anyVal.address()!).toString();
      } catch {
        // Fallback
      }
    }
    if (typeof anyVal.toString === "function") {
      const str = anyVal.toString();
      if (str && str !== "[object Object]") return str;
    }
    return "";
  }
  return String(val ?? "");
}

export function scValToString(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "string") return val;
  if (val instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(val))) {
    return new TextDecoder().decode(val);
  }
  if (typeof val === "object" && val !== null) {
    try {
      const native = scValToNative(val as unknown as xdr.ScVal);
      if (typeof native === "string") return native;
      if (native instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(native))) {
        return new TextDecoder().decode(native);
      }
      if (native !== undefined && native !== null) return String(native);
    } catch {
      return "";
    }
  }
  return String(val);
}

export function scValToNumber(val: unknown): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "string") {
    const num = parseFloat(val);
    return isNaN(num) ? 0 : num;
  }
  if (typeof val === "object" && val !== null) {
    try {
      const native = scValToNative(val as unknown as xdr.ScVal);
      return scValToNumber(native);
    } catch {
      return 0;
    }
  }
  return 0;
}

export function scValToBoolean(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "number" || typeof val === "bigint") return val !== 0 && val !== 0n;
  if (typeof val === "string") return val.toLowerCase() === "true" || val === "1";
  if (typeof val === "object" && val !== null) {
    try {
      const native = scValToNative(val as unknown as xdr.ScVal);
      return scValToBoolean(native);
    } catch {
      return false;
    }
  }
  return false;
}

export interface DecodedEvent {
  id: string;
  contractId: string;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  timestamp: number;
  type: string;
  topicSymbol: string;
  caller: string;
  receiver: string;
  data: Record<string, unknown>;
  rawJson: string;
}

export function decodeRpcEvent(rawEvt: rpc.Api.EventResponse | rpc.Api.RawEventResponse): DecodedEvent | null {
  try {
    const contractId = rawEvt.contractId?.toString() || "";
    const txHash = rawEvt.txHash || "";
    const ledger = rawEvt.ledger || 0;
    const ledgerClosedAt = rawEvt.ledgerClosedAt || "";
    const timestamp = ledgerClosedAt ? Math.floor(new Date(ledgerClosedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);

    let topic0 = "";
    if (rawEvt.topic && rawEvt.topic.length > 0) {
      topic0 = scValToString(rawEvt.topic[0]);
    }

    let type = topic0.toLowerCase().replace(/_event$/, "");
    let caller = "";
    let receiver = "";
    const parsedData: Record<string, unknown> = {};

    let nativeValue: unknown = null;
    try {
      nativeValue = rawEvt.value ? scValToNative(rawEvt.value as unknown as xdr.ScVal) : null;
    } catch {
      nativeValue = rawEvt.value;
    }

    const data: Record<string, unknown> = (typeof nativeValue === "object" && nativeValue !== null)
      ? (nativeValue as Record<string, unknown>)
      : {};

    switch (type) {
      case "swap": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        const dir = scValToNumber(data.direction);
        parsedData.direction = dir;
        parsedData.directionLabel = dir === 0 ? "PT_FOR_SY" : dir === 1 ? "SY_FOR_PT" : dir === 2 ? "SY_FOR_YT" : "YT_FOR_SY";
        parsedData.amountIn = scValToBigInt(data.amount_in).toString();
        parsedData.amountOut = scValToBigInt(data.amount_out).toString();
        parsedData.fee = scValToBigInt(data.fee).toString();
        break;
      }

      case "liquidity": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.isAdd = scValToBoolean(data.is_add);
        parsedData.ptAmount = scValToBigInt(data.pt_amount).toString();
        parsedData.syAmount = scValToBigInt(data.sy_amount).toString();
        parsedData.lpAmount = scValToBigInt(data.lp_amount).toString();
        break;
      }

      case "mint_py": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.syIn = scValToBigInt(data.sy_in).toString();
        parsedData.pyOut = scValToBigInt(data.py_out).toString();
        break;
      }

      case "redeem_py": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.pyBurned = scValToBigInt(data.py_burned).toString();
        parsedData.syOut = scValToBigInt(data.sy_out).toString();
        break;
      }

      case "redeem_pt": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.ptBurned = scValToBigInt(data.pt_burned).toString();
        parsedData.payout = scValToBigInt(data.payout).toString();
        parsedData.isBtoken = scValToBoolean(data.is_btoken);
        break;
      }

      case "deposit": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.underlyingAmount = scValToBigInt(data.underlying_amount).toString();
        parsedData.sharesMinted = scValToBigInt(data.shares_minted).toString();
        break;
      }

      case "redeem": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.sharesBurned = scValToBigInt(data.shares_burned).toString();
        parsedData.assetsOut = scValToBigInt(data.assets_out).toString();
        break;
      }

      case "yield_claimed": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.yieldOut = scValToBigInt(data.yield_out).toString();
        break;
      }

      case "transfer": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        const rawAmt = data.amount ?? (data as Record<string, unknown>).i128 ?? rawEvt.value;
        parsedData.amount = scValToBigInt(rawAmt).toString();
        break;
      }

      case "mint": {
        receiver = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const rawAmt = data.amount ?? (data as Record<string, unknown>).i128 ?? rawEvt.value;
        parsedData.amount = scValToBigInt(rawAmt).toString();
        break;
      }

      case "burn": {
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const rawAmt = data.amount ?? (data as Record<string, unknown>).i128 ?? rawEvt.value;
        parsedData.amount = scValToBigInt(rawAmt).toString();
        break;
      }

      case "market_created": {
        parsedData.marketId = rawEvt.topic?.[1] ? scValToNumber(rawEvt.topic[1]) : 0;
        parsedData.pool = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.asset = rawEvt.topic?.[3] ? scValToAddress(rawEvt.topic[3]) : "";
        parsedData.sy = scValToAddress(data.sy);
        parsedData.pt = scValToAddress(data.pt);
        parsedData.yt = scValToAddress(data.yt);
        parsedData.maturity = scValToNumber(data.maturity);
        parsedData.scalarRoot = scValToBigInt(data.scalar_root).toString();
        parsedData.initialAnchor = scValToBigInt(data.initial_anchor).toString();
        break;
      }

      case "rollover_executed":
      case "rollover_py_executed":
      case "rollover": {
        const isPyRollover = type === "rollover_py_executed" || data.py_minted !== undefined;
        type = "rollover";
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        parsedData.sourcePool = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.targetPool = rawEvt.topic?.[3] ? scValToAddress(rawEvt.topic[3]) : "";
        parsedData.ptBurned = scValToBigInt(data.pt_burned).toString();
        parsedData.syReceived = scValToBigInt(data.sy_received).toString();
        if (isPyRollover) {
          parsedData.pyMinted = scValToBigInt(data.py_minted).toString();
        } else {
          parsedData.targetPtMinted = scValToBigInt(data.target_pt_minted).toString();
        }
        break;
      }

      case "zap_in": {
        type = "zap_in";
        caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        parsedData.pool = rawEvt.topic?.[3] ? scValToAddress(rawEvt.topic[3]) : "";
        parsedData.mode = scValToNumber(data.mode);
        parsedData.underlyingAmount = scValToBigInt(data.underlying_amount).toString();
        parsedData.syAmount = scValToBigInt(data.sy_amount).toString();
        parsedData.outAmount = scValToBigInt(data.out_amount).toString();
        parsedData.residualSy = scValToBigInt(data.residual_sy).toString();
        break;
      }

      case "rate_updated": {
        type = "rate_updated";
        parsedData.newRate = scValToBigInt(data.new_rate).toString();
        break;
      }

      default: {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "bigint") parsedData[k] = v.toString();
          else parsedData[k] = v;
        }
        if (rawEvt.topic && rawEvt.topic.length > 1) {
          caller = scValToAddress(rawEvt.topic[1]);
          if (rawEvt.topic.length > 2) receiver = scValToAddress(rawEvt.topic[2]);
        }
        break;
      }
    }

    return {
      id: rawEvt.id,
      contractId,
      txHash,
      ledger,
      ledgerClosedAt,
      timestamp,
      type,
      topicSymbol: topic0,
      caller,
      receiver,
      data: parsedData,
      rawJson: JSON.stringify(rawEvt),
    };
  } catch (err) {
    console.warn(`[Indexer] Failed to decode raw event ${rawEvt.id}:`, err);
    return null;
  }
}

// ============================================================================
// 4. Database Manager (`bun:sqlite`)
// ============================================================================

export class EventStorage {
  private db: Database;
  private currentTvlByMarket: Map<string, bigint> = new Map();
  private pyIndexByMarket: Map<string, bigint> = new Map();

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath, { create: true });
    this.init();
    this.hydratePyIndices();
    this.backfillMarketSnapshots();
    this.hydrateCurrentTvl();
    this.backfillUserPositions();
  }

  private hydrateCurrentTvl(): void {
    try {
      const stateRows = this.db.prepare(
        "SELECT key, value FROM indexer_state WHERE key LIKE 'market_tvl:%'"
      ).all() as { key: string; value: string }[];

      for (const row of stateRows) {
        const marketId = row.key.slice("market_tvl:".length);
        const rawVal = (row.value || "").trim();
        if (!marketId || !/^\d+$/.test(rawVal)) continue;
        this.currentTvlByMarket.set(marketId, BigInt(rawVal));
      }

      const rows = this.db.prepare(`
        SELECT market_id, tvl_sy
        FROM market_snapshots
        ORDER BY bucket_timestamp DESC,
                 CASE interval WHEN '1D' THEN 0 WHEN '1W' THEN 1 WHEN '1M' THEN 2 ELSE 3 END ASC
      `).all() as { market_id: string; tvl_sy: string }[];

      for (const row of rows) {
        if (!row.market_id || this.currentTvlByMarket.has(row.market_id)) continue;
        const tvl = scValToBigInt(row.tvl_sy);
        if (tvl >= 0n) {
          this.currentTvlByMarket.set(row.market_id, tvl);
        }
      }

      // Fallback for legacy DBs where another market had snapshots so backfillMarketSnapshots()
      // skipped, leaving un-snapshotted mint_py/redeem_py/liquidity TVL only in raw events.
      const fallbackRows = this.db.prepare(`
        SELECT contract_id, type, data_json
        FROM events
        WHERE type IN ('liquidity', 'mint_py', 'redeem_py')
        ORDER BY timestamp ASC, ledger ASC, id ASC
      `).all() as { contract_id: string; type: string; data_json: string }[];

      const hydratedFromLedger = new Set<string>(this.currentTvlByMarket.keys());
      for (const row of fallbackRows) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(row.data_json);
        } catch {
          continue;
        }
        const poolHint = typeof parsed?.pool === "string" ? parsed.pool : "";
        const market = (parsed?.marketId ? resolveMarket(String(parsed.marketId)) : null)
          ?? (poolHint ? resolveMarket(poolHint) : null)
          ?? getMarketForContract(row.contract_id);
        if (!market || hydratedFromLedger.has(market.id)) continue;

        const cur = this.currentTvlByMarket.get(market.id) ?? 0n;
        if (row.type === "liquidity") {
          const syAmt = scValToBigInt(parsed.syAmount ?? parsed.sy_amount);
          const isAdd = scValToBoolean(parsed.isAdd ?? parsed.is_add);
          const delta = isAdd ? syAmt * 2n : -(syAmt * 2n);
          this.currentTvlByMarket.set(market.id, cur + delta > 0n ? cur + delta : 0n);
        } else if (row.type === "mint_py") {
          const syIn = scValToBigInt(parsed.syIn ?? parsed.sy_in);
          this.currentTvlByMarket.set(market.id, cur + syIn);
        } else if (row.type === "redeem_py") {
          const syOut = scValToBigInt(parsed.syOut ?? parsed.sy_out ?? parsed.assetsOut);
          this.currentTvlByMarket.set(market.id, cur > syOut ? cur - syOut : 0n);
        }
      }
    } catch (err) {
      console.warn("[Indexer] Failed to hydrate current TVL state:", err);
    }
  }

  public setMarketPyIndex(marketId: string, pyIndex: bigint, persist: boolean = true): void {
    if (pyIndex > 0n) {
      const prev = this.pyIndexByMarket.get(marketId) ?? SCALAR_9_BIG;
      const next = pyIndex > prev ? pyIndex : prev;
      this.pyIndexByMarket.set(marketId, next);
      if (persist && next > prev) {
        this.setState(`market_py_index:${marketId}`, next.toString());
      }
    }
  }

  public getMarketPyIndex(marketId: string): bigint {
    return this.pyIndexByMarket.get(marketId) ?? SCALAR_9_BIG;
  }

  private hydratePyIndices(): void {
    try {
      const stateRows = this.db.prepare(
        "SELECT key, value FROM indexer_state WHERE key LIKE 'market_py_index:%'"
      ).all() as { key: string; value: string }[];
      for (const row of stateRows) {
        const marketId = row.key.slice("market_py_index:".length);
        if (!marketId) continue;
        const val = scValToBigInt(row.value);
        if (val > 0n) {
          this.setMarketPyIndex(marketId, val, false);
        }
      }

      const rateRows = this.db.prepare(`
        SELECT contract_id, data_json
        FROM events
        WHERE type = 'rate_updated'
        ORDER BY timestamp ASC, ledger ASC, id ASC
      `).all() as { contract_id: string; data_json: string }[];

      for (const row of rateRows) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(row.data_json);
        } catch {
          continue;
        }
        const newRate = scValToBigInt(parsed?.newRate ?? parsed?.new_rate);
        if (newRate > 0n) {
          for (const m of Object.values(MARKETS)) {
            if (m.blendPoolId === row.contract_id || m.syId === row.contract_id) {
              this.setMarketPyIndex(m.id, newRate, true);
            }
          }
        }
      }
    } catch (err) {
      console.warn("[Indexer] Failed to hydrate PyIndex state:", err);
    }
  }

  private init(): void {
    // Concurrency Hardening: Configure 5-second busy timeout FIRST before any lock-acquiring PRAGMA or DDL
    this.db.exec("PRAGMA busy_timeout = 5000;");
    const journalRow = this.db.query("PRAGMA journal_mode;").get() as { journal_mode?: string } | null;
    if (journalRow?.journal_mode?.toLowerCase() !== "wal") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA synchronous = NORMAL;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        ledger INTEGER NOT NULL,
        ledger_closed_at TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        topic_symbol TEXT NOT NULL,
        caller TEXT,
        receiver TEXT,
        data_json TEXT NOT NULL,
        raw_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger);
      CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_contract_type_ledger ON events(contract_id, type, ledger DESC);
      CREATE INDEX IF NOT EXISTS idx_events_caller_type ON events(caller, type);
      CREATE INDEX IF NOT EXISTS idx_events_receiver_type ON events(receiver, type);

      CREATE TABLE IF NOT EXISTS indexer_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        market_id TEXT NOT NULL,
        interval TEXT NOT NULL,
        bucket_timestamp INTEGER NOT NULL,
        bucket_iso TEXT NOT NULL,
        open_price REAL NOT NULL,
        high_price REAL NOT NULL,
        low_price REAL NOT NULL,
        close_price REAL NOT NULL,
        implied_apy REAL NOT NULL,
        underlying_apy REAL NOT NULL,
        pt_price REAL NOT NULL,
        yt_price REAL NOT NULL,
        volume_sy TEXT NOT NULL,
        tvl_sy TEXT NOT NULL,
        trade_count INTEGER NOT NULL,
        PRIMARY KEY (market_id, interval, bucket_timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_market_snapshots_lookup ON market_snapshots(market_id, interval, bucket_timestamp ASC);

      CREATE TABLE IF NOT EXISTS user_positions (
        user_address TEXT NOT NULL,
        market_id TEXT NOT NULL,
        pt_balance TEXT NOT NULL DEFAULT '0',
        yt_balance TEXT NOT NULL DEFAULT '0',
        lp_balance TEXT NOT NULL DEFAULT '0',
        pt_cost_basis_sy TEXT NOT NULL DEFAULT '0',
        yt_cost_basis_sy TEXT NOT NULL DEFAULT '0',
        avg_entry_apy REAL NOT NULL DEFAULT 0.0,
        realized_pnl_sy TEXT NOT NULL DEFAULT '0',
        cumulative_claimed_yield_sy TEXT NOT NULL DEFAULT '0',
        last_ledger INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL DEFAULT 0,
        first_trade_timestamp INTEGER NOT NULL DEFAULT 0,
        total_trades_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_address, market_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_positions_address ON user_positions(user_address);
    `);
  }

  /**
   * Continuous Snapshot Recording: Records or updates snapshot buckets across
   * intervals ('1D', '1W', '1M', 'ALL') from incoming DeFi events.
   */
  public recordEventSnapshots(event: DecodedEvent): void {
    if (event.type === "rate_updated") {
      const newRate = scValToBigInt(event.data?.newRate ?? event.data?.new_rate);
      if (newRate > 0n) {
        for (const m of Object.values(MARKETS)) {
          if (m.blendPoolId === event.contractId || m.syId === event.contractId) {
            this.setMarketPyIndex(m.id, newRate);
          }
        }
      }
      return;
    }

    const poolHint = typeof event.data?.pool === "string" ? event.data.pool : "";
    const market = (event.data?.marketId ? resolveMarket(String(event.data.marketId)) : null)
      ?? (poolHint ? resolveMarket(poolHint) : null)
      ?? getMarketForContract(event.contractId);
    if (!market) return;

    const rawEventPyIdx = event.data?.pyIndex ?? event.data?.py_index;
    const pyIndex = rawEventPyIdx !== undefined && rawEventPyIdx !== null
      ? scValToBigInt(rawEventPyIdx)
      : this.getMarketPyIndex(market.id);
    if (pyIndex > SCALAR_9_BIG) {
      this.setMarketPyIndex(market.id, pyIndex);
    }

    let ptPrice: number | null = null;
    let volumeSy = 0n;
    const currentTvl = this.currentTvlByMarket.get(market.id) ?? 0n;

    if (event.type === "swap") {
      const amtIn = BigInt((event.data.amountIn as string) || "0");
      const amtOut = BigInt((event.data.amountOut as string) || "0");
      const fee = BigInt((event.data.fee as string) || "0");
      const dir = Number(event.data.direction ?? 0);

      if (dir === 0) {
        // PT -> SY (Sell PT): 1 PT = 1 Underlying, scale grossSy -> grossAsset
        const grossSy = amtOut + fee;
        const grossAsset = syToAssetBigInt(pyIndex, grossSy);
        volumeSy = grossSy;
        if (amtIn > 0n) ptPrice = Number(grossAsset) / Number(amtIn);
      } else if (dir === 1) {
        // SY -> PT (Buy PT): scale syIn -> assetIn
        const grossPt = amtOut + fee;
        const assetIn = syToAssetBigInt(pyIndex, amtIn);
        volumeSy = amtIn;
        if (grossPt > 0n) ptPrice = Number(assetIn) / Number(grossPt);
      } else if (dir === 2) {
        // SY -> YT (Buy YT): scale syIn -> assetIn
        const assetIn = syToAssetBigInt(pyIndex, amtIn);
        volumeSy = amtIn;
        if (amtOut > 0n) {
          const ytPrice = Number(assetIn) / Number(amtOut);
          ptPrice = Math.max(0.0001, 1.0 - ytPrice);
        }
      } else if (dir === 3) {
        // YT -> SY (Sell YT): scale grossSy -> grossAsset
        const grossSy = amtOut + fee;
        const grossAsset = syToAssetBigInt(pyIndex, grossSy);
        volumeSy = grossSy;
        if (amtIn > 0n) {
          const ytPrice = Number(grossAsset) / Number(amtIn);
          ptPrice = Math.max(0.0001, 1.0 - ytPrice);
        }
      }
      if (ptPrice !== null) {
        ptPrice = Math.min(0.9999, Math.max(0.0001, ptPrice));
      }
    } else if (event.type === "liquidity") {
      const ptAmt = BigInt((event.data.ptAmount as string) || "0");
      const syAmt = BigInt((event.data.syAmount as string) || "0");
      const isAdd = scValToBoolean(event.data?.isAdd ?? event.data?.is_add);
      if (ptAmt > 0n && syAmt > 0n) {
        const assetAmt = syToAssetBigInt(pyIndex, syAmt);
        ptPrice = Math.min(0.9999, Math.max(0.0001, Number(assetAmt) / Number(ptAmt)));
      }
      volumeSy = syAmt;
      const tvlDelta = isAdd ? syAmt * 2n : -(syAmt * 2n);
      const nextTvl = currentTvl + tvlDelta > 0n ? currentTvl + tvlDelta : 0n;
      this.currentTvlByMarket.set(market.id, nextTvl);
      this.setState(`market_tvl:${market.id}`, nextTvl.toString());
    } else if (event.type === "mint_py") {
      const syIn = BigInt((event.data.syIn as string) || "0");
      volumeSy = syIn;
      const nextTvl = currentTvl + syIn;
      this.currentTvlByMarket.set(market.id, nextTvl);
      this.setState(`market_tvl:${market.id}`, nextTvl.toString());
    } else if (event.type === "redeem_py") {
      const syOut = BigInt((event.data.syOut as string) || (event.data.assetsOut as string) || "0");
      volumeSy = syOut;
      const nextTvl = currentTvl > syOut ? currentTvl - syOut : 0n;
      this.currentTvlByMarket.set(market.id, nextTvl);
      this.setState(`market_tvl:${market.id}`, nextTvl.toString());
    } else if (event.type === "deposit" || event.type === "redeem" || event.type === "zap_in") {
      // SY-wrapper deposit/redeem events (e.g. shared sy-bUSDC across markets or inside zap_in)
      // and top-level zap_in wrappers must not inflate pool-specific TVL or double-count volume.
      return;
    }

    if (ptPrice === null) {
      const spotFromEvent =
        typeof event.data?.spotPtPrice === "number" &&
        Number.isFinite(event.data.spotPtPrice) &&
        event.data.spotPtPrice > 0
          ? event.data.spotPtPrice
          : 0;
      if (spotFromEvent > 0) {
        ptPrice = spotFromEvent;
      } else {
        const latestPt = this.getLatestMarketPtPrice(market.id);
        ptPrice = latestPt > 0 ? latestPt : (event.timestamp >= market.maturity ? 1.0 : 0);
      }
    }

    if (ptPrice <= 0) {
      return;
    }

    const tau = Math.max(0, market.maturity - event.timestamp) / 31536000;
    const impliedApy = ptPrice > 0 ? calculateImpliedApy(ptPrice, tau) : 0;
    const underlyingApy = market.underlyingApy;
    const updatedTvl = this.currentTvlByMarket.get(market.id) ?? currentTvl;

    const hourlyBucket = Math.floor(event.timestamp / 3600) * 3600;
    const dailyBucket = Math.floor(event.timestamp / 86400) * 86400;

    // Record into hourly intervals (1D, 1W)
    this.recordSnapshot(market.id, "1D", hourlyBucket, ptPrice, impliedApy, underlyingApy, volumeSy, updatedTvl);
    this.recordSnapshot(market.id, "1W", hourlyBucket, ptPrice, impliedApy, underlyingApy, volumeSy, updatedTvl);

    // Record into daily intervals (1M, ALL)
    this.recordSnapshot(market.id, "1M", dailyBucket, ptPrice, impliedApy, underlyingApy, volumeSy, updatedTvl);
    this.recordSnapshot(market.id, "ALL", dailyBucket, ptPrice, impliedApy, underlyingApy, volumeSy, updatedTvl);
  }

  private recordSnapshot(
    marketId: string,
    interval: "1D" | "1W" | "1M" | "ALL",
    bucketTimestamp: number,
    price: number,
    impliedApy: number,
    underlyingApy: number,
    volumeSy: bigint,
    tvlSy: bigint
  ): void {
    const existing = this.db.prepare(`
      SELECT open_price, high_price, low_price, close_price, volume_sy, trade_count
      FROM market_snapshots
      WHERE market_id = ? AND interval = ? AND bucket_timestamp = ?
    `).get(marketId, interval, bucketTimestamp) as SnapshotDbRow | undefined;

    if (existing) {
      const newOpen = existing.open_price <= 0 && price > 0 ? price : existing.open_price;
      const newHigh = Math.max(existing.high_price, price);
      const newLow = existing.low_price <= 0 && price > 0 ? price : Math.min(existing.low_price, price);
      const newClose = price;
      let totalVolume = volumeSy;
      try {
        totalVolume += BigInt(existing.volume_sy || "0");
      } catch {
        // Fallback
      }
      const newCount = (existing.trade_count || 0) + 1;

      this.db.prepare(`
        UPDATE market_snapshots SET
          open_price = ?,
          high_price = ?,
          low_price = ?,
          close_price = ?,
          implied_apy = ?,
          underlying_apy = ?,
          pt_price = ?,
          yt_price = ?,
          volume_sy = ?,
          tvl_sy = ?,
          trade_count = ?
        WHERE market_id = ? AND interval = ? AND bucket_timestamp = ?
      `).run(
        newOpen,
        newHigh,
        newLow,
        newClose,
        impliedApy,
        underlyingApy,
        price,
        price > 0 ? Math.max(0.0, 1.0 - price) : 0.0,
        totalVolume.toString(),
        tvlSy.toString(),
        newCount,
        marketId,
        interval,
        bucketTimestamp
      );
    } else {
      const bucketIso = new Date(bucketTimestamp * 1000).toISOString();
      this.db.prepare(`
        INSERT INTO market_snapshots (
          market_id, interval, bucket_timestamp, bucket_iso,
          open_price, high_price, low_price, close_price,
          implied_apy, underlying_apy, pt_price, yt_price,
          volume_sy, tvl_sy, trade_count
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?
        )
      `).run(
        marketId,
        interval,
        bucketTimestamp,
        bucketIso,
        price,
        price,
        price,
        price,
        impliedApy,
        underlyingApy,
        price,
        price > 0 ? Math.max(0.0, 1.0 - price) : 0.0,
        volumeSy.toString(),
        tvlSy.toString(),
        1
      );
    }
  }

  /**
   * Backfills market snapshots from historical events if snapshots table is empty.
   */
  public backfillMarketSnapshots(): number {
    try {
      const countRow = this.db.prepare("SELECT COUNT(*) as count FROM market_snapshots").get() as { count: number } | undefined;
      if (countRow && countRow.count > 0) {
        return 0;
      }

      const rows = this.db.prepare(`
        SELECT id, contract_id as contractId, tx_hash as txHash, ledger,
               ledger_closed_at as ledgerClosedAt, timestamp, type, topic_symbol as topicSymbol,
               caller, receiver, data_json, raw_json as rawJson
        FROM events
        WHERE type IN ('swap', 'liquidity', 'mint_py', 'redeem_py', 'redeem', 'deposit', 'rate_updated')
        ORDER BY timestamp ASC, id ASC
      `).all() as (Omit<DecodedEvent, "data"> & { data_json: string })[];

      if (!rows || rows.length === 0) return 0;

      console.log(`[Indexer] Backfilling market snapshots from ${rows.length} historical events...`);
      let processed = 0;

      const tx = this.db.transaction(() => {
        for (const r of rows) {
          let parsedData: Record<string, unknown> = {};
          try {
            parsedData = JSON.parse(r.data_json);
          } catch {
            // Fallback
          }
          const event: DecodedEvent = {
            id: r.id,
            contractId: r.contractId,
            txHash: r.txHash,
            ledger: r.ledger,
            ledgerClosedAt: r.ledgerClosedAt,
            timestamp: r.timestamp,
            type: r.type,
            topicSymbol: r.topicSymbol,
            caller: r.caller || "",
            receiver: r.receiver || "",
            data: parsedData,
            rawJson: r.rawJson || "",
          };
          this.recordEventSnapshots(event);
          processed++;
        }
      });

      tx();
      console.log(`[Indexer] Backfill complete: processed ${processed} events into market_snapshots.`);
      return processed;
    } catch (err) {
      console.warn("[Indexer] Market snapshot backfill warning:", err);
      return 0;
    }
  }

  /**
   * Backfills user positions from historical events if user_positions table is empty.
   */
  public backfillUserPositions(): number {
    try {
      const countRow = this.db.prepare("SELECT COUNT(*) as count FROM user_positions").get() as { count: number } | undefined;
      if (countRow && countRow.count > 0) {
        return 0;
      }

      const rows = this.db.prepare(`
        SELECT id, contract_id as contractId, tx_hash as txHash, ledger,
               ledger_closed_at as ledgerClosedAt, timestamp, type, topic_symbol as topicSymbol,
               caller, receiver, data_json, raw_json as rawJson
        FROM events
        WHERE type IN ('swap', 'liquidity', 'mint_py', 'redeem_py', 'redeem_pt', 'yield_claimed')
        ORDER BY timestamp ASC, ledger ASC, id ASC
      `).all() as (Omit<DecodedEvent, "data"> & { data_json: string })[];

      if (!rows || rows.length === 0) return 0;

      console.log(`[Indexer] Backfilling user positions from ${rows.length} historical events...`);
      let processed = 0;

      const tx = this.db.transaction(() => {
        for (const r of rows) {
          let parsedData: Record<string, unknown> = {};
          try {
            parsedData = JSON.parse(r.data_json);
          } catch {
            // Fallback
          }
          const event: DecodedEvent = {
            id: r.id,
            contractId: r.contractId,
            txHash: r.txHash,
            ledger: r.ledger,
            ledgerClosedAt: r.ledgerClosedAt,
            timestamp: r.timestamp,
            type: r.type,
            topicSymbol: r.topicSymbol,
            caller: r.caller || "",
            receiver: r.receiver || "",
            data: parsedData,
            rawJson: r.rawJson || "",
          };
          this.recordEventUserPositions(event);
          processed++;
        }
      });

      tx();
      console.log(`[Indexer] User positions backfill complete: processed ${processed} events.`);
      return processed;
    } catch (err) {
      console.warn("[Indexer] User positions backfill warning:", err);
      return 0;
    }
  }

  /**
   * Returns prevailing spot PT price for given market from recent snapshots.
   */
  public getLatestMarketPtPrice(marketId: string): number {
    const row = this.db.prepare(`
      SELECT close_price FROM market_snapshots WHERE market_id = ? ORDER BY bucket_timestamp DESC LIMIT 1
    `).get(marketId) as { close_price: number } | undefined;
    if (row && row.close_price > 0) return row.close_price;
    return 0;
  }

  /**
   * Continuous User Position & PnL Accounting: Records or updates user position,
   * cost basis, average entry APY, and realized PnL across active markets.
   */
  public recordEventUserPositions(event: DecodedEvent): void {
    if (event.type === "zap_in") return;

    const explicitUser = typeof event.data?.user === "string" ? event.data.user.trim() : "";
    const caller = (event.caller || "").trim();
    const receiver = (event.receiver || "").trim();

    const dir = event.type === "swap" ? Number(event.data?.direction ?? 0) : -1;
    const isLiquidityAdd =
      event.type === "liquidity" &&
      scValToBoolean(event.data?.isAdd ?? event.data?.is_add);
    const preferReceiver =
      event.type === "mint_py" ||
      isLiquidityAdd ||
      (event.type === "swap" && (dir === 1 || dir === 2));

    let user = "";
    if (explicitUser && !explicitUser.startsWith("C")) {
      user = explicitUser;
    } else if (preferReceiver) {
      if (receiver && !receiver.startsWith("C")) {
        user = receiver;
      } else if (caller && !caller.startsWith("C")) {
        user = caller;
      } else {
        return;
      }
    } else if (caller && !caller.startsWith("C")) {
      user = caller;
    } else if (receiver && !receiver.startsWith("C")) {
      user = receiver;
    } else {
      return;
    }
    if (!user || user.startsWith("C")) return;

    const market: MarketMetadata = (event.data?.marketId ? resolveMarket(event.data.marketId as string) : null)
      || getMarketForContract(event.contractId)
      || DEFAULT_MARKET;

    const timestamp = event.timestamp || Math.floor(Date.now() / 1000);
    const ledger = event.ledger || 0;

    const existing = this.db.prepare(`
      SELECT * FROM user_positions WHERE user_address = ? AND market_id = ?
    `).get(user, market.id) as any;

    let ptBal = existing ? BigInt(existing.pt_balance || "0") : 0n;
    let ytBal = existing ? BigInt(existing.yt_balance || "0") : 0n;
    let lpBal = existing ? BigInt(existing.lp_balance || "0") : 0n;
    let ptCostBasis = existing ? BigInt(existing.pt_cost_basis_sy || "0") : 0n;
    let ytCostBasis = existing ? BigInt(existing.yt_cost_basis_sy || "0") : 0n;
    let avgEntryApy = existing ? existing.avg_entry_apy || 0.0 : 0.0;
    let realizedPnl = existing ? BigInt(existing.realized_pnl_sy || "0") : 0n;
    let claimedYield = existing ? BigInt(existing.cumulative_claimed_yield_sy || "0") : 0n;
    let firstTradeTs = existing && existing.first_trade_timestamp > 0 ? existing.first_trade_timestamp : timestamp;
    let totalTrades = existing ? (existing.total_trades_count || 0) + 1 : 1;

    if (event.type === "swap") {
      const amtIn = scValToBigInt(event.data?.amountIn ?? event.data?.amount_in);
      const amtOut = scValToBigInt(event.data?.amountOut ?? event.data?.amount_out);
      const fee = scValToBigInt(event.data?.fee);
      const dir = Number(event.data?.direction ?? 0);

      if (dir === 1) {
        // Buy PT (SY -> PT)
        const newTokens = amtOut;
        const totalTokens = ptBal + newTokens;
        const newCostBasis = ptCostBasis + amtIn;

        const grossPtOut = amtOut + fee;
        const rawEventPyIdx = event.data?.pyIndex ?? event.data?.py_index;
        const pyIndex = rawEventPyIdx !== undefined && rawEventPyIdx !== null
          ? scValToBigInt(rawEventPyIdx)
          : this.getMarketPyIndex(market.id);
        const assetIn = syToAssetBigInt(pyIndex, amtIn);
        const spotPt = grossPtOut > 0n ? Number(assetIn) / Number(grossPtOut) : this.getLatestMarketPtPrice(market.id);
        const tau = Math.max(0, market.maturity - timestamp) / 31536000;
        const tradeApy = spotPt > 0 ? calculateImpliedApy(spotPt, tau) : 0;

        if (totalTokens > 0n) {
          const weightedNumerator = avgEntryApy * Number(ptBal) + tradeApy * Number(newTokens);
          avgEntryApy = Number((weightedNumerator / Number(totalTokens)).toFixed(2));
        } else {
          avgEntryApy = tradeApy;
        }

        ptBal = totalTokens;
        ptCostBasis = newCostBasis;
      } else if (dir === 0) {
        // Sell PT (PT -> SY)
        const ptSold = amtIn;
        if (ptBal > 0n) {
          const unitCost = Number(ptCostBasis) / Number(ptBal);
          const costSold = BigInt(Math.floor(Number(ptSold) * unitCost));
          const pnlDelta = amtOut - costSold;

          realizedPnl += pnlDelta;
          ptCostBasis = ptCostBasis > costSold ? ptCostBasis - costSold : 0n;
          ptBal = ptBal > ptSold ? ptBal - ptSold : 0n;

          if (ptBal < 10n) {
            ptBal = 0n;
            ptCostBasis = 0n;
          }
        }
      } else if (dir === 2) {
        // Buy YT (SY -> YT)
        ytBal += amtOut;
        ytCostBasis += amtIn;
      } else if (dir === 3) {
        // Sell YT (YT -> SY)
        const ytSold = amtIn;
        if (ytBal > 0n) {
          const unitCost = Number(ytCostBasis) / Number(ytBal);
          const costSold = BigInt(Math.floor(Number(ytSold) * unitCost));
          const pnlDelta = amtOut - costSold;

          realizedPnl += pnlDelta;
          ytCostBasis = ytCostBasis > costSold ? ytCostBasis - costSold : 0n;
          ytBal = ytBal > ytSold ? ytBal - ytSold : 0n;

          if (ytBal < 10n) {
            ytBal = 0n;
            ytCostBasis = 0n;
          }
        }
      }
    } else if (event.type === "mint_py") {
      const ptPrice = event.data?.spotPtPrice !== undefined
        ? Number(event.data.spotPtPrice)
        : this.getLatestMarketPtPrice(market.id);
      const syIn = scValToBigInt(event.data?.syIn ?? event.data?.sy_in);
      const pyOut = scValToBigInt(event.data?.pyOut ?? event.data?.py_out);

      const costPt = BigInt(Math.floor(Number(syIn) * ptPrice));
      const costYt = syIn - costPt; // Conservation of cost basis

      ptBal += pyOut;
      ytBal += pyOut;
      ptCostBasis += costPt;
      ytCostBasis += costYt;

      if (avgEntryApy === 0 && ptBal > 0n) {
        const tau = Math.max(0, market.maturity - timestamp) / 31536000;
        avgEntryApy = calculateImpliedApy(ptPrice, tau);
      }
    } else if (event.type === "redeem_py") {
      const pyBurned = scValToBigInt(event.data?.pyBurned ?? event.data?.py_burned ?? event.data?.amount);
      const syOut = scValToBigInt(event.data?.syOut ?? event.data?.sy_out);

      let costSoldPt = 0n;
      let costSoldYt = 0n;
      if (ptBal > 0n) {
        costSoldPt = BigInt(Math.floor(Number(pyBurned) * (Number(ptCostBasis) / Number(ptBal))));
      }
      if (ytBal > 0n) {
        costSoldYt = BigInt(Math.floor(Number(pyBurned) * (Number(ytCostBasis) / Number(ytBal))));
      }

      const totalCostSold = costSoldPt + costSoldYt;
      const pnlDelta = syOut - totalCostSold;
      realizedPnl += pnlDelta;

      ptBal = ptBal > pyBurned ? ptBal - pyBurned : 0n;
      ytBal = ytBal > pyBurned ? ytBal - pyBurned : 0n;
      ptCostBasis = ptCostBasis > costSoldPt ? ptCostBasis - costSoldPt : 0n;
      ytCostBasis = ytCostBasis > costSoldYt ? ytCostBasis - costSoldYt : 0n;

      if (ptBal < 10n) { ptBal = 0n; ptCostBasis = 0n; }
      if (ytBal < 10n) { ytBal = 0n; ytCostBasis = 0n; }
    } else if (event.type === "redeem_pt") {
      const ptBurned = scValToBigInt(event.data?.ptBurned ?? event.data?.pt_burned ?? event.data?.amount);
      const payout = scValToBigInt(event.data?.payout ?? event.data?.amountOut ?? event.data?.amount_out);

      let costSoldPt = 0n;
      if (ptBal > 0n) {
        costSoldPt = BigInt(Math.floor(Number(ptBurned) * (Number(ptCostBasis) / Number(ptBal))));
      }
      const pnlDelta = payout - costSoldPt;
      realizedPnl += pnlDelta;

      ptBal = ptBal > ptBurned ? ptBal - ptBurned : 0n;
      ptCostBasis = ptCostBasis > costSoldPt ? ptCostBasis - costSoldPt : 0n;

      if (ptBal < 10n) { ptBal = 0n; ptCostBasis = 0n; }
    } else if (event.type === "liquidity") {
      const lpAmt = scValToBigInt(event.data?.lpAmount ?? event.data?.lp_amount);
      const isAdd = scValToBoolean(event.data?.isAdd ?? event.data?.is_add);
      if (isAdd) {
        lpBal += lpAmt;
      } else {
        lpBal = lpBal > lpAmt ? lpBal - lpAmt : 0n;
      }
    } else if (event.type === "yield_claimed") {
      const yieldOut = scValToBigInt(event.data?.yieldOut ?? event.data?.yield_out);
      claimedYield += yieldOut;
      realizedPnl += yieldOut;
    }

    this.db.prepare(`
      INSERT INTO user_positions (
        user_address, market_id, pt_balance, yt_balance, lp_balance,
        pt_cost_basis_sy, yt_cost_basis_sy, avg_entry_apy, realized_pnl_sy,
        cumulative_claimed_yield_sy, last_ledger, last_updated,
        first_trade_timestamp, total_trades_count
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(user_address, market_id) DO UPDATE SET
        pt_balance = excluded.pt_balance,
        yt_balance = excluded.yt_balance,
        lp_balance = excluded.lp_balance,
        pt_cost_basis_sy = excluded.pt_cost_basis_sy,
        yt_cost_basis_sy = excluded.yt_cost_basis_sy,
        avg_entry_apy = excluded.avg_entry_apy,
        realized_pnl_sy = excluded.realized_pnl_sy,
        cumulative_claimed_yield_sy = excluded.cumulative_claimed_yield_sy,
        last_ledger = excluded.last_ledger,
        last_updated = excluded.last_updated,
        first_trade_timestamp = excluded.first_trade_timestamp,
        total_trades_count = excluded.total_trades_count
    `).run(
      user,
      market.id,
      ptBal.toString(),
      ytBal.toString(),
      lpBal.toString(),
      ptCostBasis.toString(),
      ytCostBasis.toString(),
      avgEntryApy,
      realizedPnl.toString(),
      claimedYield.toString(),
      ledger,
      timestamp,
      firstTradeTs,
      totalTrades
    );
  }

  /**
   * Helper method to record a swap event and update snapshots and positions.
   */
  public recordSwap(params: {
    eventId?: string;
    marketId: string;
    timestamp: number;
    caller: string;
    receiver: string;
    direction: number;
    amountIn: bigint;
    amountOut: bigint;
    fee: bigint;
    pyIndex?: bigint;
    reservesSy?: bigint;
    reservesPt?: bigint;
    ledger?: number;
  }): void {
    const market: MarketMetadata = resolveMarket(params.marketId) || DEFAULT_MARKET;
    if (params.pyIndex && params.pyIndex > 0n) {
      this.setMarketPyIndex(market.id, params.pyIndex);
    }
    const event: DecodedEvent = {
      id: params.eventId || `swap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      contractId: market.poolId,
      txHash: `tx_${params.timestamp}`,
      ledger: params.ledger || 100000,
      ledgerClosedAt: new Date(params.timestamp * 1000).toISOString(),
      timestamp: params.timestamp,
      type: "swap",
      topicSymbol: "swap",
      caller: params.caller,
      receiver: params.receiver,
      data: {
        direction: params.direction,
        amountIn: params.amountIn.toString(),
        amountOut: params.amountOut.toString(),
        fee: params.fee.toString(),
        pyIndex: params.pyIndex ? params.pyIndex.toString() : undefined,
        marketId: market.id,
      },
      rawJson: "",
    };
    this.recordEventSnapshots(event);
    this.recordEventUserPositions(event);
  }

  /**
   * Helper method to record a mint_py event and update snapshots and positions.
   */
  public recordMintPy(params: {
    eventId?: string;
    marketId: string;
    caller: string;
    receiver: string;
    syIn: bigint;
    pyOut: bigint;
    timestamp: number;
    spotPtPrice?: number;
    pyIndex?: bigint;
    ledger?: number;
  }): void {
    const market: MarketMetadata = resolveMarket(params.marketId) || DEFAULT_MARKET;
    if (params.pyIndex && params.pyIndex > 0n) {
      this.setMarketPyIndex(market.id, params.pyIndex);
    }
    const event: DecodedEvent = {
      id: params.eventId || `mint_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      contractId: market.poolId,
      txHash: `tx_${params.timestamp}`,
      ledger: params.ledger || 100000,
      ledgerClosedAt: new Date(params.timestamp * 1000).toISOString(),
      timestamp: params.timestamp,
      type: "mint_py",
      topicSymbol: "mint_py",
      caller: params.caller,
      receiver: params.receiver,
      data: {
        syIn: params.syIn.toString(),
        pyOut: params.pyOut.toString(),
        spotPtPrice: params.spotPtPrice,
        pyIndex: params.pyIndex ? params.pyIndex.toString() : undefined,
        marketId: market.id,
      },
      rawJson: "",
    };
    this.recordEventSnapshots(event);
    this.recordEventUserPositions(event);
  }

  /**
   * Helper method to record a redeem_pt event and update positions.
   */
  public recordRedeemPt(params: {
    eventId?: string;
    marketId: string;
    caller: string;
    ptBurned: bigint;
    payout: bigint;
    timestamp: number;
    ledger?: number;
  }): void {
    const market: MarketMetadata = resolveMarket(params.marketId) || DEFAULT_MARKET;
    const event: DecodedEvent = {
      id: params.eventId || `redeem_pt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      contractId: market.poolId,
      txHash: `tx_${params.timestamp}`,
      ledger: params.ledger || 100000,
      ledgerClosedAt: new Date(params.timestamp * 1000).toISOString(),
      timestamp: params.timestamp,
      type: "redeem_pt",
      topicSymbol: "redeem_pt",
      caller: params.caller,
      receiver: params.caller,
      data: {
        ptBurned: params.ptBurned.toString(),
        payout: params.payout.toString(),
        marketId: market.id,
      },
      rawJson: "",
    };
    this.recordEventUserPositions(event);
  }

  /**
   * Helper method to record a yield_claimed event and update positions.
   */
  public recordYieldClaimed(params: {
    eventId?: string;
    marketId: string;
    user: string;
    yieldOut: bigint;
    timestamp: number;
    ledger?: number;
  }): void {
    const market: MarketMetadata = resolveMarket(params.marketId) || DEFAULT_MARKET;
    const event: DecodedEvent = {
      id: params.eventId || `yield_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      contractId: market.ytId,
      txHash: `tx_${params.timestamp}`,
      ledger: params.ledger || 100000,
      ledgerClosedAt: new Date(params.timestamp * 1000).toISOString(),
      timestamp: params.timestamp,
      type: "yield_claimed",
      topicSymbol: "yield_claimed",
      caller: params.user,
      receiver: params.user,
      data: {
        yieldOut: params.yieldOut.toString(),
        user: params.user,
        marketId: market.id,
      },
      rawJson: "",
    };
    this.recordEventUserPositions(event);
  }

  /**
   * Retrieves user positions and portfolio summary metrics across markets.
   * Handles empty history by returning HTTP 200 compliant zero-state.
   */
  public getUserPositions(userAddress: string): UserPositionsResponse {
    if (!userAddress) {
      throw new Error("Missing required query parameter: user");
    }

    const rows = this.db.prepare(
      "SELECT * FROM user_positions WHERE user_address = ? ORDER BY market_id ASC"
    ).all(userAddress) as any[];

    if (!rows || rows.length === 0) {
      const emptySummary: UserPositionsSummary = {
        userAddress,
        totalCostBasisUsd: 0,
        totalCurrentValueUsd: 0,
        totalRealizedPnlUsd: 0,
        totalUnrealizedPnlUsd: 0,
        totalNetPnlUsd: 0,
        totalClaimedYieldUsd: 0,
        overallPortfolioApy: 0,
        activePositionsCount: 0,
        totalTransactionsCount: 0,
      };

      return {
        success: true,
        user: userAddress,
        count: 0,
        positions: [],
        summary: emptySummary,
      };
    }

    const positions: UserMarketPosition[] = [];
    let totalCostUsd = 0;
    let totalCurrentValUsd = 0;
    let totalRealizedUsd = 0;
    let totalUnrealizedUsd = 0;
    let totalClaimedUsd = 0;
    let weightedApySum = 0;
    let totalTxCount = 0;

    const now = Math.floor(Date.now() / 1000);

    for (const row of rows) {
      const market: MarketMetadata = MARKETS[row.market_id] || resolveMarket(row.market_id) || DEFAULT_MARKET;
      const ptBal = BigInt(row.pt_balance || "0");
      const ytBal = BigInt(row.yt_balance || "0");
      const lpBal = BigInt(row.lp_balance || "0");
      const costBasisPt = BigInt(row.pt_cost_basis_sy || "0");
      const costBasisYt = BigInt(row.yt_cost_basis_sy || "0");
      const realizedPnlStroops = BigInt(row.realized_pnl_sy || "0");
      const claimedYieldStroops = BigInt(row.cumulative_claimed_yield_sy || "0");

      const totalCostStroops = costBasisPt + costBasisYt;
      const assetPrice = market.assetPriceUsd ?? (market.asset === "XLM" ? 0.12 : 1.0);
      const costBasisUsd = (Number(totalCostStroops) / 1e7) * assetPrice;

      // Mark-to-market valuation
      const latestSnapshot = this.db.prepare(
        "SELECT close_price, yt_price FROM market_snapshots WHERE market_id = ? ORDER BY bucket_timestamp DESC LIMIT 1"
      ).get(row.market_id) as { close_price: number; yt_price: number } | undefined;

      const isMatured = now >= market.maturity;
      const spotPt = isMatured ? 1.0 : (latestSnapshot ? latestSnapshot.close_price : 0);
      const spotYt = isMatured
        ? 0.0
        : (latestSnapshot ? latestSnapshot.yt_price : (spotPt > 0 ? Math.max(0.0001, 1.0 - spotPt) : 0));

      const ptValStroops = BigInt(Math.floor(Number(ptBal) * spotPt));
      const ytValStroops = BigInt(Math.floor(Number(ytBal) * spotYt));
      const currentPositionStroops = ptValStroops + ytValStroops;

      const currentPositionValueUsd = (Number(currentPositionStroops) / 1e7) * assetPrice;
      const unrealizedPnlStroops = currentPositionStroops - totalCostStroops;
      const unrealizedPnlUsd = (Number(unrealizedPnlStroops) / 1e7) * assetPrice;
      const realizedPnlUsd = (Number(realizedPnlStroops) / 1e7) * assetPrice;
      const claimedYieldUsd = (Number(claimedYieldStroops) / 1e7) * assetPrice;

      positions.push({
        marketId: row.market_id,
        marketAddress: market.poolId,
        assetCode: market.asset,
        costBasisStroops: totalCostStroops.toString(),
        costBasisUsd: Number(costBasisUsd.toFixed(2)),
        averageEntryApy: Number((row.avg_entry_apy || 0.0).toFixed(2)),
        currentPtBalance: ptBal.toString(),
        currentYtBalance: ytBal.toString(),
        currentLpBalance: lpBal.toString(),
        currentPositionValueUsd: Number(currentPositionValueUsd.toFixed(2)),
        realizedPnlStroops: realizedPnlStroops.toString(),
        realizedPnlUsd: Number(realizedPnlUsd.toFixed(2)),
        unrealizedPnlStroops: unrealizedPnlStroops.toString(),
        unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(2)),
        netPnlUsd: Number((realizedPnlUsd + unrealizedPnlUsd).toFixed(2)),
        cumulativeClaimedYieldStroops: claimedYieldStroops.toString(),
        cumulativeClaimedYieldUsd: Number(claimedYieldUsd.toFixed(2)),
        firstTradeTimestamp: row.first_trade_timestamp || row.last_updated,
        lastActivityTimestamp: row.last_updated,
        totalTradesCount: row.total_trades_count || 1,
      });

      totalCostUsd += costBasisUsd;
      totalCurrentValUsd += currentPositionValueUsd;
      totalRealizedUsd += realizedPnlUsd;
      totalUnrealizedUsd += unrealizedPnlUsd;
      totalClaimedUsd += claimedYieldUsd;
      weightedApySum += (row.avg_entry_apy || 0.0) * currentPositionValueUsd;
      totalTxCount += row.total_trades_count || 1;
    }

    const overallApy = totalCurrentValUsd > 0
      ? Number((weightedApySum / totalCurrentValUsd).toFixed(2))
      : 0;

    const activeCount = positions.filter((p) => p.currentPtBalance !== "0" || p.currentYtBalance !== "0" || p.currentLpBalance !== "0").length;

    const summary: UserPositionsSummary = {
      userAddress,
      totalCostBasisUsd: Number(totalCostUsd.toFixed(2)),
      totalCurrentValueUsd: Number(totalCurrentValUsd.toFixed(2)),
      totalRealizedPnlUsd: Number(totalRealizedUsd.toFixed(2)),
      totalUnrealizedPnlUsd: Number(totalUnrealizedUsd.toFixed(2)),
      totalNetPnlUsd: Number((totalRealizedUsd + totalUnrealizedUsd).toFixed(2)),
      totalClaimedYieldUsd: Number(totalClaimedUsd.toFixed(2)),
      overallPortfolioApy: overallApy,
      activePositionsCount: activeCount,
      totalTransactionsCount: totalTxCount,
    };

    return {
      success: true,
      user: userAddress,
      count: positions.length,
      positions,
      summary,
    };
  }

  /**
   * Retrieves bucketed time-series charts with forward-filling for sparse intervals.
   * Intervals supported:
   * - 1D: 24 hourly buckets
   * - 1W: 168 hourly buckets
   * - 1M: 30 daily buckets
   * - ALL: Daily buckets from inception to now
   */
  public getMarketChart(marketParam: string, intervalParam: string = "1D"): MarketChartsResponse {
    const market = resolveMarket(marketParam);
    if (!market) {
      throw new Error(`Market not found: ${marketParam}. Supported markets: usdc-90d, usdc-30d, xlm-90d, usdc-matured, usdc-slender-90d or contract address.`);
    }

    const intervalUpper = intervalParam.toUpperCase();
    const interval = ["1D", "1W", "1M", "ALL"].includes(intervalUpper) ? intervalUpper : "1D";

    const now = Math.floor(Date.now() / 1000);
    let bucketSec = 3600;
    let bucketCount = 24;
    let currentBucket = Math.floor(now / 3600) * 3600;
    let startBucket = currentBucket - 23 * 3600;

    if (interval === "1D") {
      bucketSec = 3600;
      bucketCount = 24;
      currentBucket = Math.floor(now / 3600) * 3600;
      startBucket = currentBucket - 23 * 3600;
    } else if (interval === "1W") {
      bucketSec = 3600;
      bucketCount = 168;
      currentBucket = Math.floor(now / 3600) * 3600;
      startBucket = currentBucket - 167 * 3600;
    } else if (interval === "1M") {
      bucketSec = 86400;
      bucketCount = 30;
      currentBucket = Math.floor(now / 86400) * 86400;
      startBucket = currentBucket - 29 * 86400;
    } else if (interval === "ALL") {
      bucketSec = 86400;
      currentBucket = Math.floor(now / 86400) * 86400;

      const minRow = this.db.prepare(`
        SELECT MIN(bucket_timestamp) as minTs
        FROM market_snapshots
        WHERE market_id = ? AND interval = 'ALL'
      `).get(market.id) as { minTs: number | null } | undefined;

      if (minRow && minRow.minTs && minRow.minTs < currentBucket) {
        startBucket = Math.min(minRow.minTs, currentBucket - 30 * 86400);
      } else {
        startBucket = currentBucket - 30 * 86400;
      }
      bucketCount = Math.max(30, Math.floor((currentBucket - startBucket) / 86400) + 1);
    }

    // Query existing snapshots in range
    const rows = this.db.prepare(`
      SELECT bucket_timestamp, bucket_iso, open_price, high_price, low_price, close_price,
             implied_apy, underlying_apy, pt_price, yt_price, volume_sy, tvl_sy, trade_count
      FROM market_snapshots
      WHERE market_id = ? AND interval = ? AND bucket_timestamp >= ? AND bucket_timestamp <= ?
      ORDER BY bucket_timestamp ASC
    `).all(market.id, interval, startBucket, currentBucket) as SnapshotDbRow[];

    const rowMap = new Map<number, SnapshotDbRow>();
    for (const r of rows) {
      rowMap.set(r.bucket_timestamp, r);
    }

    // Prior state for carry-forward forward filling
    const prevRow = this.db.prepare(`
      SELECT close_price, implied_apy, underlying_apy, pt_price, yt_price, tvl_sy
      FROM market_snapshots
      WHERE market_id = ? AND interval = ? AND bucket_timestamp < ?
      ORDER BY bucket_timestamp DESC
      LIMIT 1
    `).get(market.id, interval, startBucket) as SnapshotDbRow | undefined;

    if (rows.length === 0 && !prevRow) {
      return {
        success: true,
        market: market.id,
        interval,
        count: 0,
        data: [],
        summary: {
          marketId: market.id,
          interval,
          highApy: 0,
          lowApy: 0,
          currentApy: 0,
          highPrice: 0,
          lowPrice: 0,
          currentPrice: 0,
          volumeTotal: "0",
          currentTvl: "0",
          tradesCount: 0,
        },
      };
    }

    const seedRow = prevRow ?? rows[0]!;
    let carryPrice = seedRow.close_price;
    let carryTvl = seedRow.tvl_sy;
    let carryUnderlyingApy = seedRow.underlying_apy;

    const data: MarketChartPoint[] = [];

    for (let i = 0; i < bucketCount; i++) {
      const bucketTs = startBucket + i * bucketSec;
      const row = rowMap.get(bucketTs);

      if (row) {
        carryPrice = row.close_price;
        carryTvl = row.tvl_sy;
        carryUnderlyingApy = row.underlying_apy;

        data.push({
          timestamp: bucketTs,
          datetime: row.bucket_iso || new Date(bucketTs * 1000).toISOString(),
          open: row.open_price,
          high: row.high_price,
          low: row.low_price,
          close: row.close_price,
          impliedApy: row.implied_apy,
          underlyingApy: row.underlying_apy,
          ptPrice: row.pt_price,
          ytPrice: row.yt_price,
          volume: row.volume_sy || "0",
          tvl: row.tvl_sy || carryTvl,
          tradeCount: row.trade_count || 0,
        });
      } else {
        // Forward fill from previous state
        const tau = Math.max(0, market.maturity - bucketTs) / 31536000;
        const filledImpliedApy = carryPrice > 0 ? calculateImpliedApy(carryPrice, tau) : 0;
        const ytPrice = carryPrice > 0 ? Math.max(0.0, 1.0 - carryPrice) : 0;

        data.push({
          timestamp: bucketTs,
          datetime: new Date(bucketTs * 1000).toISOString(),
          open: carryPrice,
          high: carryPrice,
          low: carryPrice,
          close: carryPrice,
          impliedApy: filledImpliedApy,
          underlyingApy: carryUnderlyingApy,
          ptPrice: carryPrice,
          ytPrice: ytPrice,
          volume: "0",
          tvl: carryTvl,
          tradeCount: 0,
        });
      }
    }

    // Compute summary metrics
    let highApy = data[0]?.impliedApy ?? 0;
    let lowApy = data[0]?.impliedApy ?? 0;
    let highPrice = data[0]?.high ?? 0;
    let lowPrice = data[0]?.low ?? 0;
    let volumeSum = 0n;
    let tradesSum = 0;

    for (const pt of data) {
      if (pt.impliedApy > highApy) highApy = pt.impliedApy;
      if (pt.impliedApy < lowApy) lowApy = pt.impliedApy;
      if (pt.high > highPrice) highPrice = pt.high;
      if (pt.low < lowPrice) lowPrice = pt.low;
      try {
        volumeSum += BigInt(pt.volume || "0");
      } catch {
        // Fallback
      }
      tradesSum += pt.tradeCount || 0;
    }

    const lastPt = data[data.length - 1];

    const summary: MarketChartSummary = {
      marketId: market.id,
      interval,
      highApy: Math.round(highApy * 10000) / 10000,
      lowApy: Math.round(lowApy * 10000) / 10000,
      currentApy: lastPt ? lastPt.impliedApy : 0,
      highPrice: Math.round(highPrice * 10000) / 10000,
      lowPrice: Math.round(lowPrice * 10000) / 10000,
      currentPrice: lastPt ? lastPt.close : carryPrice,
      volumeTotal: volumeSum.toString(),
      currentTvl: lastPt ? lastPt.tvl : carryTvl,
      tradesCount: tradesSum,
    };

    return {
      success: true,
      market: market.id,
      interval,
      count: data.length,
      data,
      summary,
    };
  }

  public saveEvents(events: DecodedEvent[]): number {
    if (events.length === 0) return 0;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        id, contract_id, tx_hash, ledger, ledger_closed_at,
        timestamp, type, topic_symbol, caller, receiver,
        data_json, raw_json
      ) VALUES (
        $id, $contract_id, $tx_hash, $ledger, $ledger_closed_at,
        $timestamp, $type, $topic_symbol, $caller, $receiver,
        $data_json, $raw_json
      );
    `);

    let inserted = 0;
    const tx = this.db.transaction((evts: DecodedEvent[]) => {
      for (const e of evts) {
        const res = insert.run({
          $id: e.id,
          $contract_id: e.contractId,
          $tx_hash: e.txHash,
          $ledger: e.ledger,
          $ledger_closed_at: e.ledgerClosedAt,
          $timestamp: e.timestamp,
          $type: e.type,
          $topic_symbol: e.topicSymbol,
          $caller: e.caller,
          $receiver: e.receiver,
          $data_json: JSON.stringify(e.data),
          $raw_json: e.rawJson,
        });
        if (res.changes > 0) {
          inserted++;
          if (["swap", "liquidity", "mint_py", "redeem_py", "redeem", "deposit", "rate_updated"].includes(e.type)) {
            this.recordEventSnapshots(e);
          }
          if (["swap", "liquidity", "mint_py", "redeem_py", "redeem_pt", "yield_claimed"].includes(e.type)) {
            this.recordEventUserPositions(e);
          }
        }
      }
    });

    tx(events);
    return inserted;
  }

  public getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM indexer_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  public setState(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO indexer_state (key, value) VALUES (?, ?)").run(key, value);
  }

  public getEvents(options: {
    limit?: number;
    offset?: number;
    type?: string;
    contractId?: string;
    order?: "ASC" | "DESC";
  }): { total: number; limit: number; offset: number; events: DecodedEvent[] } {
    const rawLimit = options.limit;
    const safeLimit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50;
    const limit = Math.min(Math.max(safeLimit, 1), 500);
    const rawOffset = options.offset;
    const safeOffset = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0;
    const offset = Math.max(safeOffset, 0);
    const order = options.order === "ASC" ? "ASC" : "DESC";

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.type) {
      whereClauses.push("type = ?");
      params.push(options.type);
    }
    if (options.contractId) {
      whereClauses.push("contract_id = ?");
      params.push(options.contractId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const totalRow = this.db.prepare(`SELECT COUNT(*) as count FROM events ${whereSql}`).get(...params) as { count: number };
    const total = totalRow?.count ?? 0;

    const query = `
      SELECT id, contract_id as contractId, tx_hash as txHash, ledger,
             ledger_closed_at as ledgerClosedAt, timestamp, type, topic_symbol as topicSymbol,
             caller, receiver, data_json, raw_json as rawJson
      FROM events
      ${whereSql}
      ORDER BY ledger ${order}, id ${order}
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(query).all(...params, limit, offset) as (Omit<DecodedEvent, "data"> & { data_json: string })[];

    const events: DecodedEvent[] = rows.map((r) => {
      let parsedData: Record<string, unknown> = {};
      try {
        parsedData = JSON.parse(r.data_json);
      } catch {
        // Fallback
      }
      return {
        id: r.id,
        contractId: r.contractId,
        txHash: r.txHash,
        ledger: r.ledger,
        ledgerClosedAt: r.ledgerClosedAt,
        timestamp: r.timestamp,
        type: r.type,
        topicSymbol: r.topicSymbol,
        caller: r.caller || "",
        receiver: r.receiver || "",
        data: parsedData,
        rawJson: r.rawJson || "",
      };
    });

    return { total, limit, offset, events };
  }

  public getStats(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    eventsByContract: Record<string, number>;
    firstEventLedger: number | null;
    lastEventLedger: number | null;
    firstEventTime: string | null;
    lastEventTime: string | null;
    swapCount: number;
    liquidityCount: number;
    mintPyCount: number;
  } {
    const totalRow = this.db.prepare("SELECT COUNT(*) as count, MIN(ledger) as minLedger, MAX(ledger) as maxLedger, MIN(ledger_closed_at) as minTime, MAX(ledger_closed_at) as maxTime FROM events").get() as {
      count: number;
      minLedger: number | null;
      maxLedger: number | null;
      minTime: string | null;
      maxTime: string | null;
    };

    const typeRows = this.db.prepare("SELECT type, COUNT(*) as count FROM events GROUP BY type").all() as { type: string; count: number }[];
    const contractRows = this.db.prepare("SELECT contract_id, COUNT(*) as count FROM events GROUP BY contract_id").all() as { contract_id: string; count: number }[];

    const eventsByType: Record<string, number> = {};
    for (const r of typeRows) eventsByType[r.type] = r.count;

    const eventsByContract: Record<string, number> = {};
    for (const r of contractRows) eventsByContract[r.contract_id] = r.count;

    return {
      totalEvents: totalRow.count ?? 0,
      eventsByType,
      eventsByContract,
      firstEventLedger: totalRow.minLedger,
      lastEventLedger: totalRow.maxLedger,
      firstEventTime: totalRow.minTime,
      lastEventTime: totalRow.maxTime,
      swapCount: eventsByType["swap"] ?? 0,
      liquidityCount: eventsByType["liquidity"] ?? 0,
      mintPyCount: eventsByType["mint_py"] ?? 0,
    };
  }

  public getSparkline(limit: number = 24): { bucket: string; count: number }[] {
    const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : 24;
    const clampedLimit = Math.min(Math.max(safeLimit, 1), 168);
    const rows = this.db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:00:00Z', datetime(timestamp, 'unixepoch')) as bucket,
             COUNT(*) as count
      FROM events
      GROUP BY bucket
      ORDER BY bucket DESC
      LIMIT ?
    `).all(clampedLimit) as { bucket: string; count: number }[];

    return rows.reverse();
  }

  public close(): void {
    this.db.close(true);
  }
}

// ============================================================================
// 5. Indexer Polling Engine
// ============================================================================

export class PersistentIndexer {
  private rpcServer: rpc.Server;
  private storage: EventStorage;
  private isRunning: boolean = false;
  private abortRequested: boolean = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private cursor: string | null = null;
  private lastIndexedLedger: number = 0;
  private latestRpcLedger: number = 0;
  private oldestRpcLedger: number = 0;
  private startTime: number = Date.now();
  private lastPollAt: string = "";
  private lastError: string | null = null;

  constructor(storage: EventStorage, rpcUrl: string = RPC_URL) {
    this.storage = storage;
    this.rpcServer = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

    // Restore state from database
    const savedCursor = this.storage.getState("last_cursor");
    const savedLedger = this.storage.getState("last_indexed_ledger");
    if (savedCursor) this.cursor = savedCursor;
    if (savedLedger) this.lastIndexedLedger = parseInt(savedLedger, 10) || 0;
  }

  public async fetchMarketPyIndex(ytContractId: string): Promise<bigint> {
    try {
      const account = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
      const contract = new Contract(ytContractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
      })
        .addOperation(contract.call("get_py_index"))
        .setTimeout(30)
        .build();

      const sim = await this.rpcServer.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        return 0n;
      }
      let nativeRet: unknown = sim.result.retval;
      try {
        nativeRet = scValToNative(sim.result.retval);
      } catch {
        // Fallback if mocked retval is already native
      }
      const val = scValToBigInt(nativeRet);
      return val > 0n ? val : 0n;
    } catch {
      return 0n;
    }
  }

  public async syncMarketPyIndices(): Promise<void> {
    await Promise.all(
      Object.values(MARKETS).map(async (m) => {
        const pyIdx = await this.fetchMarketPyIndex(m.ytId);
        if (pyIdx > 0n) {
          this.storage.setMarketPyIndex(m.id, pyIdx);
        }
      })
    );
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortRequested = false;
    console.log(`[Indexer] Starting Soroban persistent indexer for ${CONTRACT_CATALOG.length} contracts...`);
    console.log(`[Indexer] Initial state: lastIndexedLedger=${this.lastIndexedLedger}, cursor=${this.cursor ? "SAVED" : "NONE"}`);
    void this.pollLoop();
  }

  public stop(): void {
    this.isRunning = false;
    this.abortRequested = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log("[Indexer] Polling engine stopped.");
  }

  private async pollLoop(): Promise<void> {
    if (!this.isRunning) return;
    try {
      await this.pollOnce();
    } catch (err) {
      this.lastError = String(err);
      console.error("[Indexer] Error in poll iteration:", err);
    } finally {
      if (this.isRunning) {
        this.pollTimer = setTimeout(() => void this.pollLoop(), POLL_INTERVAL_MS);
      }
    }
  }

  public async pollOnce(): Promise<number> {
    this.lastPollAt = new Date().toISOString();
    let newEventsIngested = 0;

    // Fetch latest and oldest ledger to stay within retention window
    try {
      const latestResp = await this.rpcServer.getLatestLedger();
      this.latestRpcLedger = latestResp.sequence;
      this.oldestRpcLedger = Math.max(1, latestResp.sequence - 120000);
    } catch (err) {
      console.warn("[Indexer] Failed to query getLatestLedger:", err);
    }

    // Refresh PyIndex per market via yt_token.get_py_index() RPC simulation
    await this.syncMarketPyIndices();

    const filterChunks = chunkContractFilters(ALL_CONTRACT_IDS);
    let hasMorePages = true;
    let pageCount = 0;
    const maxPages = 25;

    while (hasMorePages && !this.abortRequested && pageCount < maxPages) {
      pageCount++;

      let req: rpc.Api.GetEventsRequest;
      if (this.cursor) {
        // CURSOR MODE: must omit startLedger
        req = {
          filters: filterChunks,
          cursor: this.cursor,
          limit: 100,
        };
      } else {
        // LEDGER RANGE MODE: must omit cursor
        let startLedger = this.lastIndexedLedger > 0
          ? this.lastIndexedLedger + 1
          : INITIAL_START_LEDGER;

        if (this.oldestRpcLedger > 0) {
          startLedger = Math.max(startLedger, this.oldestRpcLedger);
        }

        req = {
          filters: filterChunks,
          startLedger,
          limit: 100,
        };
      }

      let res: rpc.Api.GetEventsResponse;
      try {
        res = await this.rpcServer.getEvents(req);
        this.lastError = null;
      } catch (err: unknown) {
        const errMsg = String(err);
        if (this.cursor && (errMsg.includes("cursor") || errMsg.includes("-32602"))) {
          console.warn("[Indexer] Cursor rejected by RPC, resetting cursor:", errMsg);
          this.cursor = null;
          this.storage.setState("last_cursor", "");
          continue;
        }
        if (errMsg.includes("oldestLedger") || errMsg.includes("retention") || errMsg.includes("-32600")) {
          console.warn("[Indexer] startLedger below retention window, advancing to latestLedger - 1000:", errMsg);
          this.lastIndexedLedger = Math.max(this.lastIndexedLedger, this.latestRpcLedger - 1000);
          this.cursor = null;
          this.storage.setState("last_cursor", "");
          continue;
        }
        throw err;
      }

      const rawEvents = res.events || [];
      const decodedEvents: DecodedEvent[] = [];

      for (const rawEvt of rawEvents) {
        const decoded = decodeRpcEvent(rawEvt);
        if (decoded) {
          decodedEvents.push(decoded);
          if (decoded.ledger > this.lastIndexedLedger) {
            this.lastIndexedLedger = decoded.ledger;
          }
        }
      }

      if (decodedEvents.length > 0) {
        const inserted = this.storage.saveEvents(decodedEvents);
        newEventsIngested += inserted;
        console.log(`[Indexer] Ledger ${this.lastIndexedLedger}: Ingested ${inserted} new events (total raw: ${rawEvents.length})`);
      }

      if (res.cursor) {
        this.cursor = res.cursor;
        this.storage.setState("last_cursor", this.cursor);
      }
      this.storage.setState("last_indexed_ledger", this.lastIndexedLedger.toString());
      this.storage.setState("updated_at", new Date().toISOString());

      if (rawEvents.length >= 100 && res.cursor) {
        hasMorePages = true;
      } else {
        hasMorePages = false;
      }
    }

    return newEventsIngested;
  }

  public getStatus() {
    const stats = this.storage.getStats();
    let dbSizeBytes = 0;
    let walSizeBytes = 0;

    try {
      if (existsSync(DB_PATH)) dbSizeBytes = statSync(DB_PATH).size;
      const walPath = `${DB_PATH}-wal`;
      if (existsSync(walPath)) walSizeBytes = statSync(walPath).size;
    } catch {
      // Ignore
    }

    return {
      status: "healthy",
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      rpcUrl: RPC_URL,
      latestRpcLedger: this.latestRpcLedger,
      oldestRpcLedger: this.oldestRpcLedger,
      lastIndexedLedger: this.lastIndexedLedger,
      hasCursor: !!this.cursor,
      isPolling: this.isRunning,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      catalogedContracts: CONTRACT_CATALOG.length,
      totalEvents: stats.totalEvents,
      dbSizeBytes,
      walSizeBytes,
      eventsByType: stats.eventsByType,
    };
  }
}

// ============================================================================
// 6. HTTP REST API (`Bun.serve`)
// ============================================================================

function parseQueryIntParam(raw: string | null, defaultValue: number): number | null {
  if (raw === null || raw.trim() === "") return defaultValue;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function startHttpServer(
  storage: EventStorage,
  indexer: PersistentIndexer,
  port: number = resolveHttpPort()
) {
  const corsHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(INDEXER_API_SECRET.length === 0
      ? {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
      : {}),
  };

  const server = Bun.serve({
    hostname: HTTP_HOST,
    port,
    fetch(req) {
      const url = new URL(req.url);

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      // Origin Isolation / Constant-Time Secret Verification
      if (INDEXER_API_SECRET.length > 0) {
        const provided = (req.headers.get("x-indexer-secret") || "").trim();
        const providedBuf = Buffer.from(provided);
        const secretBuf = Buffer.from(INDEXER_API_SECRET);

        const isAuthorized =
          providedBuf.byteLength === secretBuf.byteLength &&
          timingSafeEqual(providedBuf, secretBuf);

        if (!isAuthorized) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // GET /health
      if (url.pathname === "/health") {
        const status = indexer.getStatus();
        return new Response(JSON.stringify(status, null, 2), {
          status: 200,
          headers: corsHeaders,
        });
      }

      // GET /stats
      if (url.pathname === "/stats") {
        const stats = storage.getStats();
        return new Response(
          JSON.stringify(
            {
              success: true,
              data: {
                ...stats,
                catalogedContracts: CONTRACT_CATALOG,
              },
            },
            null,
            2
          ),
          { status: 200, headers: corsHeaders }
        );
      }

      // GET /analytics/sparkline
      if (url.pathname === "/analytics/sparkline") {
        const parsedLimit = parseQueryIntParam(url.searchParams.get("limit"), 24);
        if (parsedLimit === null) {
          return new Response(
            JSON.stringify({ success: false, error: "Invalid integer parameter: limit" }),
            { status: 400, headers: corsHeaders }
          );
        }
        const limitParam = Math.min(Math.max(parsedLimit, 1), 168);
        const sparkline = storage.getSparkline(limitParam);
        return new Response(
          JSON.stringify(
            {
              success: true,
              data: sparkline,
            },
            null,
            2
          ),
          { status: 200, headers: corsHeaders }
        );
      }

      // GET /events
      if (url.pathname === "/events") {
        const parsedLimit = parseQueryIntParam(url.searchParams.get("limit"), 50);
        const parsedOffset = parseQueryIntParam(url.searchParams.get("offset"), 0);
        if (parsedLimit === null || parsedOffset === null) {
          return new Response(
            JSON.stringify({ success: false, error: "Invalid integer parameter: limit/offset" }),
            { status: 400, headers: corsHeaders }
          );
        }
        const limit = Math.min(Math.max(parsedLimit, 1), 500);
        const offset = Math.max(parsedOffset, 0);
        const type = url.searchParams.get("type") || undefined;
        const contractId = url.searchParams.get("contractId") || undefined;
        const order = url.searchParams.get("order")?.toUpperCase() === "ASC" ? "ASC" : "DESC";

        const result = storage.getEvents({ limit, offset, type, contractId, order });

        return new Response(
          JSON.stringify(
            {
              success: true,
              count: result.events.length,
              total: result.total,
              limit: result.limit,
              offset: result.offset,
              events: result.events,
            },
            null,
            2
          ),
          { status: 200, headers: corsHeaders }
        );
      }

      // GET /charts or GET /timeseries (Milestone 1)
      if (url.pathname === "/charts" || url.pathname === "/timeseries") {
        const marketParam = url.searchParams.get("market") || "usdc-90d";
        const intervalParam = (url.searchParams.get("interval") || "1D").toUpperCase();

        try {
          const chartData = storage.getMarketChart(marketParam, intervalParam);
          return new Response(JSON.stringify(chartData, null, 2), {
            status: 200,
            headers: corsHeaders,
          });
        } catch (err) {
          return new Response(
            JSON.stringify(
              {
                success: false,
                error: (err as Error).message || "Failed to fetch market charts",
              },
              null,
              2
            ),
            { status: 400, headers: corsHeaders }
          );
        }
      }

      // GET /positions (Milestone 2)
      if (url.pathname === "/positions") {
        const user = url.searchParams.get("user");
        if (!user) {
          return new Response(
            JSON.stringify({ success: false, error: "Missing required query parameter: user" }),
            { status: 400, headers: corsHeaders }
          );
        }

        try {
          const positionData = storage.getUserPositions(user);
          return new Response(JSON.stringify(positionData, null, 2), {
            status: 200,
            headers: corsHeaders,
          });
        } catch (err) {
          return new Response(
            JSON.stringify(
              {
                success: false,
                error: (err as Error).message || "Failed to fetch user positions",
              },
              null,
              2
            ),
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Fallback 404
      return new Response(
        JSON.stringify({
          error: "Not Found",
          availableEndpoints: ["/health", "/events", "/stats", "/analytics/sparkline", "/charts", "/timeseries", "/positions"],
        }),
        { status: 404, headers: corsHeaders }
      );
    },
  });

  console.log(`[HTTP] Soroban Indexer API listening at http://${HTTP_HOST}:${server.port}`);
  return server;
}

// ============================================================================
// 7. Main Process Entrypoint
// ============================================================================

async function main() {
  console.log("=================================================");
  console.log("🚀 Starting Persistent Soroban Event Indexer");
  console.log("=================================================");

  const storage = new EventStorage();
  const indexer = new PersistentIndexer(storage);

  // Start HTTP API
  const server = startHttpServer(storage, indexer);

  // Start background polling
  await indexer.start();

  // Clean shutdown handlers
  const cleanup = () => {
    console.log("[Process] Shutting down indexer gracefully...");
    indexer.stop();
    server.stop();
    storage.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

if (import.meta.main) {
  void main();
}
