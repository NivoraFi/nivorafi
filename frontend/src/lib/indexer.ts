import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

// ============================================================================
// 1. Safe ScVal Decoding Helpers
// ============================================================================

/**
 * Safely decodes an ScVal or native value into JavaScript BigInt.
 * Handles i128, u64, i64, numbers, strings, and null/undefined without throwing.
 */
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
      if (!trimmed || trimmed === "NaN" || trimmed === "Infinity" || trimmed === "-Infinity") {
        return 0n;
      }
      return BigInt(trimmed);
    } catch {
      return 0n;
    }
  }
  if (typeof val === "object" && val !== null) {
    try {
      const native = scValToNative(val as unknown as xdr.ScVal);
      return scValToBigInt(native);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Safely decodes an ScVal or address string into a standard Stellar address string (G... or C...).
 */
export function scValToAddress(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && val !== null) {
    try {
      const native = scValToNative(val as unknown as xdr.ScVal);
      if (typeof native === "string") return native;
    } catch {
      // Fallback below
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
    // Handle Address object directly if passed
    if (typeof anyVal.toString === "function") {
      const str = anyVal.toString();
      if (str && str !== "[object Object]") return str;
    }
    return "";
  }
  return String(val ?? "");
}

/**
 * Safely decodes an ScVal or value into a string.
 * Decodes symbols, strings, and byte buffers cleanly.
 */
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
      if (native !== undefined && native !== null) {
        return String(native);
      }
    } catch {
      return "";
    }
  }
  return String(val);
}

/**
 * Safely decodes an ScVal or value into a standard JavaScript number.
 */
export function scValToNumber(val: unknown): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "string") {
    const num = Number(val);
    return isNaN(num) ? 0 : num;
  }
  if (typeof val === "object" && val !== null) {
    try {
      return scValToNumber(scValToNative(val as unknown as xdr.ScVal));
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Safely decodes an ScVal or value into a boolean.
 */
export function scValToBoolean(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "bigint") return val !== 0n;
  if (typeof val === "string") return val === "true" || val === "1";
  if (typeof val === "object" && val !== null) {
    try {
      return Boolean(scValToNative(val as unknown as xdr.ScVal));
    } catch {
      return false;
    }
  }
  return false;
}

// ============================================================================
// 2. Parsed Protocol Event Types
// ============================================================================

export type ProtocolEventType =
  | "swap"
  | "deposit"
  | "redeem"
  | "mint_py"
  | "redeem_py"
  | "redeem_pt"
  | "liquidity"
  | "yield_claimed"
  | "maturity_settled"
  | "rollover"
  | "rollover_py"
  | "market_created"
  | "transfer"
  | "unknown";

export interface BaseProtocolEvent {
  id: string; // RPC unique event ID (e.g. "0000000123-0000000001")
  contractId: string;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  timestamp: number; // Unix timestamp in seconds
  type: ProtocolEventType;
  topicSymbol: string;
  caller?: string;
  receiver?: string;
}

export interface SwapEventParsed extends BaseProtocolEvent {
  type: "swap";
  caller: string;
  receiver: string;
  direction: number; // 0=PT->SY, 1=SY->PT, 2=SY->YT, 3=YT->SY
  directionLabel: "PT_FOR_SY" | "SY_FOR_PT" | "SY_FOR_YT" | "YT_FOR_SY";
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
}

export interface LiquidityEventParsed extends BaseProtocolEvent {
  type: "liquidity";
  caller: string;
  receiver: string;
  isAdd: boolean;
  ptAmount: bigint;
  syAmount: bigint;
  lpAmount: bigint;
}

export interface MintPyEventParsed extends BaseProtocolEvent {
  type: "mint_py";
  caller: string;
  receiver: string;
  syIn: bigint;
  pyOut: bigint;
}

export interface RedeemPyEventParsed extends BaseProtocolEvent {
  type: "redeem_py";
  caller: string;
  receiver: string;
  pyBurned: bigint;
  syOut: bigint;
}

export interface RedeemPtEventParsed extends BaseProtocolEvent {
  type: "redeem_pt";
  caller: string;
  receiver: string;
  ptBurned: bigint;
  payout: bigint;
  isBtoken: boolean;
}

export interface DepositEventParsed extends BaseProtocolEvent {
  type: "deposit";
  caller: string;
  receiver: string;
  underlyingAmount: bigint;
  sharesMinted: bigint;
}

export interface RedeemEventParsed extends BaseProtocolEvent {
  type: "redeem";
  caller: string;
  receiver: string;
  sharesBurned: bigint;
  assetsOut: bigint;
}

export interface YieldClaimedEventParsed extends BaseProtocolEvent {
  type: "yield_claimed";
  user: string;
  receiver: string;
  yieldOut: bigint;
}

export interface RolloverEventParsed extends BaseProtocolEvent {
  type: "rollover";
  user: string;
  sourcePool: string;
  targetPool: string;
  ptBurned: bigint;
  syReceived: bigint;
  targetPtMinted: bigint;
}

export interface RolloverPyEventParsed extends BaseProtocolEvent {
  type: "rollover_py";
  user: string;
  sourcePool: string;
  targetPool: string;
  ptBurned: bigint;
  syReceived: bigint;
  pyMinted: bigint;
}

export interface MaturitySettledEventParsed extends BaseProtocolEvent {
  type: "maturity_settled";
  maturity: number;
  settledIndex: bigint;
}

export interface MarketCreatedEventParsed extends BaseProtocolEvent {
  type: "market_created";
  marketId: number;
  pool: string;
  asset: string;
  sy: string;
  pt: string;
  yt: string;
  maturity: number;
  scalarRoot: bigint;
  initialAnchor: bigint;
}

export interface GenericProtocolEvent extends BaseProtocolEvent {
  type: "transfer" | "unknown";
  rawTopics: string[];
  rawData: Record<string, unknown> | null;
}

export type ProtocolEvent =
  | SwapEventParsed
  | LiquidityEventParsed
  | MintPyEventParsed
  | RedeemPyEventParsed
  | RedeemPtEventParsed
  | DepositEventParsed
  | RedeemEventParsed
  | YieldClaimedEventParsed
  | RolloverEventParsed
  | RolloverPyEventParsed
  | MaturitySettledEventParsed
  | MarketCreatedEventParsed
  | GenericProtocolEvent;

// ============================================================================
// 3. Raw Event Parsing Logic
// ============================================================================

/**
 * Extracts normalized contract ID string from EventResponse.contractId.
 */
function extractContractId(contractIdVal: unknown): string {
  if (!contractIdVal) return "";
  if (typeof contractIdVal === "string") return contractIdVal;
  if (typeof contractIdVal === "object" && contractIdVal !== null) {
    if ("contractId" in contractIdVal && typeof (contractIdVal as { contractId: () => string }).contractId === "function") {
      return (contractIdVal as { contractId: () => string }).contractId();
    }
    if ("toString" in contractIdVal) {
      return String(contractIdVal);
    }
  }
  return String(contractIdVal);
}

/**
 * Parses a raw Soroban RPC EventResponse into a typed ProtocolEvent.
 */
export function parseEventResponse(rawEvt: rpc.Api.EventResponse): ProtocolEvent | null {
  try {
    const topic0 = rawEvt.topic?.[0] ? scValToString(rawEvt.topic[0]) : "";
    const contractId = extractContractId(rawEvt.contractId);
    const txHash = rawEvt.txHash || "";
    const ledger = rawEvt.ledger;
    const ledgerClosedAt = rawEvt.ledgerClosedAt || new Date().toISOString();
    const parsedTs = Math.floor(new Date(ledgerClosedAt).getTime() / 1000);
    const timestamp = Number.isNaN(parsedTs) ? Math.floor(Date.now() / 1000) : parsedTs;

    const base: BaseProtocolEvent = {
      id: rawEvt.id,
      contractId,
      txHash,
      ledger,
      ledgerClosedAt,
      timestamp,
      topicSymbol: topic0,
      type: "unknown",
    };

    let nativeData: Record<string, unknown> | null = null;
    if (rawEvt.value) {
      try {
        const decoded = scValToNative(rawEvt.value as unknown as xdr.ScVal);
        if (decoded && typeof decoded === "object") {
          nativeData = decoded as Record<string, unknown>;
        }
      } catch {
        // Fallback below
      }
      if (!nativeData && typeof rawEvt.value === "object" && rawEvt.value !== null) {
        nativeData = rawEvt.value as unknown as Record<string, unknown>;
      }
    }
    const data = nativeData && typeof nativeData === "object" ? nativeData : {};

    const normSymbol = topic0.toLowerCase().replace(/_event$/, "");

    switch (normSymbol) {
      case "swap": {
        const caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        const direction = scValToNumber(data.direction);
        const directionLabels: SwapEventParsed["directionLabel"][] = [
          "PT_FOR_SY",
          "SY_FOR_PT",
          "SY_FOR_YT",
          "YT_FOR_SY",
        ];
        return {
          ...base,
          type: "swap",
          caller,
          receiver,
          direction,
          directionLabel: directionLabels[direction] || "PT_FOR_SY",
          amountIn: scValToBigInt(data.amount_in),
          amountOut: scValToBigInt(data.amount_out),
          fee: scValToBigInt(data.fee),
        };
      }

      case "liquidity": {
        const caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        return {
          ...base,
          type: "liquidity",
          caller,
          receiver,
          isAdd: scValToBoolean(data.is_add),
          ptAmount: scValToBigInt(data.pt_amount),
          syAmount: scValToBigInt(data.sy_amount),
          lpAmount: scValToBigInt(data.lp_amount),
        };
      }

      case "mint_py": {
        const caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        return {
          ...base,
          type: "mint_py",
          caller,
          receiver,
          syIn: scValToBigInt(data.sy_in),
          pyOut: scValToBigInt(data.py_out),
        };
      }

      case "redeem_py": {
        const caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        return {
          ...base,
          type: "redeem_py",
          caller,
          receiver,
          pyBurned: scValToBigInt(data.py_burned),
          syOut: scValToBigInt(data.sy_out),
        };
      }

      case "redeem_pt": {
        const caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        return {
          ...base,
          type: "redeem_pt",
          caller,
          receiver,
          ptBurned: scValToBigInt(data.pt_burned),
          payout: scValToBigInt(data.payout),
          isBtoken: scValToBoolean(data.is_btoken),
        };
      }

      case "deposit": {
        const caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        return {
          ...base,
          type: "deposit",
          caller,
          receiver,
          underlyingAmount: scValToBigInt(data.underlying_amount),
          sharesMinted: scValToBigInt(data.shares_minted),
        };
      }

      case "redeem": {
        const caller = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        return {
          ...base,
          type: "redeem",
          caller,
          receiver,
          sharesBurned: scValToBigInt(data.shares_burned),
          assetsOut: scValToBigInt(data.assets_out),
        };
      }

      case "yield_claimed": {
        const user = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const receiver = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        return {
          ...base,
          type: "yield_claimed",
          caller: user,
          user,
          receiver,
          yieldOut: scValToBigInt(data.yield_out),
        };
      }

      case "rollover_executed":
      case "rollover": {
        const user = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const sourcePool = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        const targetPool = rawEvt.topic?.[3] ? scValToAddress(rawEvt.topic[3]) : "";
        return {
          ...base,
          type: "rollover",
          caller: user,
          user,
          sourcePool,
          targetPool,
          ptBurned: scValToBigInt(data.pt_burned),
          syReceived: scValToBigInt(data.sy_received),
          targetPtMinted: scValToBigInt(data.target_pt_minted),
        };
      }

      case "rollover_py_executed":
      case "rollover_py": {
        const user = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const sourcePool = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        const targetPool = rawEvt.topic?.[3] ? scValToAddress(rawEvt.topic[3]) : "";
        return {
          ...base,
          type: "rollover_py",
          caller: user,
          user,
          sourcePool,
          targetPool,
          ptBurned: scValToBigInt(data.pt_burned),
          syReceived: scValToBigInt(data.sy_received),
          pyMinted: scValToBigInt(data.py_minted),
        };
      }

      case "maturity_settled": {
        return {
          ...base,
          type: "maturity_settled",
          maturity: scValToNumber(data.maturity),
          settledIndex: scValToBigInt(data.settled_index),
        };
      }

      case "market_created": {
        const marketId = rawEvt.topic?.[1] ? scValToNumber(rawEvt.topic[1]) : 0;
        const pool = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        const asset = rawEvt.topic?.[3] ? scValToAddress(rawEvt.topic[3]) : "";
        return {
          ...base,
          type: "market_created",
          marketId,
          pool,
          asset,
          sy: scValToAddress(data.sy),
          pt: scValToAddress(data.pt),
          yt: scValToAddress(data.yt),
          maturity: scValToNumber(data.maturity),
          scalarRoot: scValToBigInt(data.scalar_root),
          initialAnchor: scValToBigInt(data.initial_anchor),
        };
      }

      case "transfer": {
        const from = rawEvt.topic?.[1] ? scValToAddress(rawEvt.topic[1]) : "";
        const to = rawEvt.topic?.[2] ? scValToAddress(rawEvt.topic[2]) : "";
        return {
          ...base,
          type: "transfer",
          caller: from,
          receiver: to,
          rawTopics: rawEvt.topic ? rawEvt.topic.map((t) => scValToString(t)) : [],
          rawData: data,
        };
      }

      default:
        return {
          ...base,
          type: "unknown",
          rawTopics: rawEvt.topic ? rawEvt.topic.map((t) => scValToString(t)) : [],
          rawData: data,
        };
    }
  } catch (err) {
    console.warn("[Indexer] Failed to parse event:", err, rawEvt);
    return null;
  }
}

/**
 * Parses an event returned from the persistent Windows Indexer REST API (http://192.168.0.29:8765/events).
 * Handles stringified BigInts, nested data payloads, and maps them to standard typed ProtocolEvent instances.
 */
export function parseIndexerApiEvent(rawEvt: any): ProtocolEvent | null {
  if (!rawEvt || typeof rawEvt !== "object") return null;

  try {
    const id = String(rawEvt.id || "");
    const contractId = String(rawEvt.contractId || "");
    const txHash = String(rawEvt.txHash || "");
    const ledger = Number(rawEvt.ledger || 0);
    const ledgerClosedAt = String(rawEvt.ledgerClosedAt || new Date().toISOString());
    const parsedTs = Math.floor(new Date(ledgerClosedAt).getTime() / 1000);
    const timestamp = Number(rawEvt.timestamp) || (Number.isNaN(parsedTs) ? Math.floor(Date.now() / 1000) : parsedTs);
    const topicSymbol = String(rawEvt.topicSymbol || "");
    const caller = String(rawEvt.caller || "");
    const receiver = String(rawEvt.receiver || "");
    const data = (rawEvt.data && typeof rawEvt.data === "object") ? rawEvt.data : {};

    const base: BaseProtocolEvent = {
      id,
      contractId,
      txHash,
      ledger,
      ledgerClosedAt,
      timestamp,
      topicSymbol,
      type: "unknown",
      caller,
      receiver,
    };

    const normType = String(rawEvt.type || topicSymbol || "unknown").toLowerCase().replace(/_event$/, "");

    switch (normType) {
      case "swap": {
        const direction = scValToNumber(data.direction);
        const directionLabels: SwapEventParsed["directionLabel"][] = [
          "PT_FOR_SY",
          "SY_FOR_PT",
          "SY_FOR_YT",
          "YT_FOR_SY",
        ];
        return {
          ...base,
          type: "swap",
          caller,
          receiver,
          direction,
          directionLabel: directionLabels[direction] || "PT_FOR_SY",
          amountIn: scValToBigInt(data.amountIn ?? data.amount_in),
          amountOut: scValToBigInt(data.amountOut ?? data.amount_out),
          fee: scValToBigInt(data.fee),
        };
      }

      case "liquidity": {
        return {
          ...base,
          type: "liquidity",
          caller,
          receiver,
          isAdd: scValToBoolean(data.isAdd ?? data.is_add),
          ptAmount: scValToBigInt(data.ptAmount ?? data.pt_amount),
          syAmount: scValToBigInt(data.syAmount ?? data.sy_amount),
          lpAmount: scValToBigInt(data.lpAmount ?? data.lp_amount),
        };
      }

      case "mint_py": {
        return {
          ...base,
          type: "mint_py",
          caller,
          receiver,
          syIn: scValToBigInt(data.syIn ?? data.sy_in),
          pyOut: scValToBigInt(data.pyOut ?? data.py_out),
        };
      }

      case "redeem_py": {
        return {
          ...base,
          type: "redeem_py",
          caller,
          receiver,
          pyBurned: scValToBigInt(data.pyBurned ?? data.py_burned),
          syOut: scValToBigInt(data.syOut ?? data.sy_out),
        };
      }

      case "redeem_pt": {
        return {
          ...base,
          type: "redeem_pt",
          caller,
          receiver,
          ptBurned: scValToBigInt(data.ptBurned ?? data.pt_burned),
          payout: scValToBigInt(data.payout),
          isBtoken: scValToBoolean(data.isBtoken ?? data.is_btoken),
        };
      }

      case "deposit": {
        return {
          ...base,
          type: "deposit",
          caller,
          receiver,
          underlyingAmount: scValToBigInt(data.underlyingAmount ?? data.underlying_amount),
          sharesMinted: scValToBigInt(data.sharesMinted ?? data.shares_minted),
        };
      }

      case "redeem": {
        return {
          ...base,
          type: "redeem",
          caller,
          receiver,
          sharesBurned: scValToBigInt(data.sharesBurned ?? data.shares_burned),
          assetsOut: scValToBigInt(data.assetsOut ?? data.assets_out),
        };
      }

      case "yield_claimed": {
        const u = caller || data.user || "";
        return {
          ...base,
          type: "yield_claimed",
          caller: u,
          user: u,
          receiver,
          yieldOut: scValToBigInt(data.yieldOut ?? data.yield_out),
        };
      }

      case "rollover_executed":
      case "rollover": {
        const u = caller || data.user || "";
        return {
          ...base,
          type: "rollover",
          caller: u,
          user: u,
          sourcePool: String(data.sourcePool || data.source_pool || ""),
          targetPool: String(data.targetPool || data.target_pool || ""),
          ptBurned: scValToBigInt(data.ptBurned ?? data.pt_burned),
          syReceived: scValToBigInt(data.syReceived ?? data.sy_received),
          targetPtMinted: scValToBigInt(data.targetPtMinted ?? data.target_pt_minted),
        };
      }

      case "rollover_py_executed":
      case "rollover_py": {
        const u = caller || data.user || "";
        return {
          ...base,
          type: "rollover_py",
          caller: u,
          user: u,
          sourcePool: String(data.sourcePool || data.source_pool || ""),
          targetPool: String(data.targetPool || data.target_pool || ""),
          ptBurned: scValToBigInt(data.ptBurned ?? data.pt_burned),
          syReceived: scValToBigInt(data.syReceived ?? data.sy_received),
          pyMinted: scValToBigInt(data.pyMinted ?? data.py_minted),
        };
      }

      case "market_created": {
        return {
          ...base,
          type: "market_created",
          marketId: scValToNumber(data.marketId ?? data.market_id),
          pool: String(data.pool || ""),
          asset: String(data.asset || ""),
          sy: String(data.sy || ""),
          pt: String(data.pt || ""),
          yt: String(data.yt || ""),
          maturity: scValToNumber(data.maturity),
          scalarRoot: scValToBigInt(data.scalarRoot ?? data.scalar_root),
          initialAnchor: scValToBigInt(data.initialAnchor ?? data.initial_anchor),
        };
      }

      case "transfer": {
        return {
          ...base,
          type: "transfer",
          caller,
          receiver,
          rawTopics: [topicSymbol],
          rawData: data,
        };
      }

      default:
        return {
          ...base,
          type: "unknown",
          rawTopics: [topicSymbol],
          rawData: data,
        };
    }
  } catch (err) {
    console.warn("[Indexer] Failed to parse indexer API event:", err, rawEvt);
    return null;
  }
}

// ============================================================================
// 4. Local Storage Caching & BigInt Serialization
// ============================================================================

export function serializeEventsJson(events: ProtocolEvent[]): string {
  return JSON.stringify(events, (_key, value) => {
    if (typeof value === "bigint") {
      return `__bigint__:${value.toString()}`;
    }
    return value;
  });
}

export function deserializeEventsJson(rawJson: string): ProtocolEvent[] {
  try {
    const parsed = JSON.parse(rawJson, (_key, value) => {
      if (typeof value === "string" && value.startsWith("__bigint__:")) {
        return BigInt(value.slice(11));
      }
      return value;
    });
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ============================================================================
// 5. Soroban Event Indexer Class
// ============================================================================

export interface IndexerConfig {
  rpcUrl: string;
  contractIds: string[];
  indexerApiUrl?: string;  // Windows Indexer API (e.g. http://192.168.0.29:8765)
  pollIntervalMs?: number; // default: 5000ms
  startLedger?: number;    // fallback start ledger
  maxCacheSize?: number;   // default: 1000 events
  storageKey?: string;     // localStorage cache key
  pageSize?: number;       // default: 100 events per query
}

export type EventListener = (events: ProtocolEvent[]) => void;

export class SorobanEventIndexer {
  private rpcServer: rpc.Server;
  private config: Required<IndexerConfig>;
  private events: ProtocolEvent[] = [];
  private eventIds: Set<string> = new Set();
  private cursor: string | null = null;
  private lastIndexedLedger: number = 0;
  private isPolling: boolean = false;
  private abortRequested: boolean = false;
  private isIndexerApiActive: boolean = false;
  private lastApiSyncTime: number = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<EventListener> = new Set();

  constructor(config: IndexerConfig) {
    this.config = {
      rpcUrl: config.rpcUrl,
      contractIds: config.contractIds,
      indexerApiUrl: config.indexerApiUrl ?? "",
      pollIntervalMs: config.pollIntervalMs ?? 5000,
      startLedger: config.startLedger ?? 0,
      maxCacheSize: config.maxCacheSize ?? 1000,
      storageKey: config.storageKey ?? "stellar_pendle_events_cache",
      pageSize: config.pageSize ?? 100,
    };

    this.rpcServer = new rpc.Server(this.config.rpcUrl);
    this.loadCachedEvents();
  }

  /**
   * Loads cached events from localStorage (if in browser).
   */
  private loadCachedEvents(): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(this.config.storageKey);
      if (raw) {
        const cached = deserializeEventsJson(raw);
        for (const evt of cached) {
          const key = this.getEventKey(evt);
          if (!this.eventIds.has(key)) {
            this.eventIds.add(key);
            this.events.push(evt);
            if (evt.ledger > this.lastIndexedLedger) {
              this.lastIndexedLedger = evt.ledger;
            }
          }
        }
      }
      const savedCursor = window.localStorage.getItem(`${this.config.storageKey}_cursor`);
      if (savedCursor) {
        this.cursor = savedCursor;
      }
    } catch (e) {
      console.warn("[Indexer] Failed to load cached events:", e);
    }
  }

  /**
   * Persists events to localStorage.
   */
  private saveEventsToCache(): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      // Keep only up to maxCacheSize in cache
      const slice = this.events.slice(-this.config.maxCacheSize);
      window.localStorage.setItem(this.config.storageKey, serializeEventsJson(slice));
      if (this.cursor) {
        window.localStorage.setItem(`${this.config.storageKey}_cursor`, this.cursor);
      }
    } catch (e) {
      console.warn("[Indexer] Failed to save events to cache:", e);
    }
  }

  /**
   * Generates a unique deduplication key for an event.
   */
  public getEventKey(evt: ProtocolEvent): string {
    return `${evt.ledger}-${evt.txHash}-${evt.id}`;
  }

  /**
   * Subscribes a listener to receive new indexed events.
   * Returns an unsubscribe function.
   */
  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    // Immediately emit current events
    listener([...this.events]);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const snapshot = [...this.events];
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[Indexer] Listener error:", err);
      }
    }
  }

  /**
   * Starts periodic polling.
   */
  public start(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.abortRequested = false;
    void this.pollLoop();
  }

  /**
   * Stops polling.
   */
  public stop(): void {
    this.isPolling = false;
    this.abortRequested = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollLoop(): Promise<void> {
    if (!this.isPolling) return;
    try {
      await this.pollOnce();
    } catch (err) {
      console.warn("[Indexer] Poll loop iteration error:", err);
    } finally {
      if (this.isPolling) {
        this.pollTimer = setTimeout(() => {
          void this.pollLoop();
        }, this.config.pollIntervalMs);
      }
    }
  }

  public isApiActive(): boolean {
    return this.isIndexerApiActive;
  }

  public getLastApiSyncTime(): number {
    return this.lastApiSyncTime;
  }

  public getIndexerApiUrl(): string {
    return this.config.indexerApiUrl;
  }

  /**
   * Fetches pre-indexed hourly bucketed event counts from the Windows Indexer API (/analytics/sparkline).
   * Gracefully returns null if the API is offline or returns error.
   */
  public async fetchSparklineFromApi(limit: number = 24): Promise<{ bucket: string; count: number }[] | null> {
    const apiUrl = this.config.indexerApiUrl?.replace(/\/+$/, "");
    if (!apiUrl) return null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${apiUrl}/analytics/sparkline?limit=${limit}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = await res.json();
      if (json && json.success && Array.isArray(json.data)) {
        return json.data;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fast event synchronization from the persistent Windows Indexer API (GET /events).
   * Ingests contract-specific events and general events, deduplicating them.
   */
  public async fetchFromIndexerApi(): Promise<number> {
    const apiUrl = this.config.indexerApiUrl?.replace(/\/+$/, "");
    if (!apiUrl) return 0;

    const timeoutMs = 4000;
    const fetchWithTimeout = async (url: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return await res.json();
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    };

    // 1. Verify health
    const health = await fetchWithTimeout(`${apiUrl}/health`);
    if (!health || health.status !== "healthy") {
      throw new Error(`Indexer API unhealthy status: ${health?.status}`);
    }

    // 2. Query events per contract to capture protocol activity without SAC spam
    const queries: string[] = [];
    if (this.config.contractIds.length > 0) {
      for (const cid of this.config.contractIds) {
        queries.push(`${apiUrl}/events?contractId=${encodeURIComponent(cid)}&limit=100`);
      }
    } else {
      queries.push(`${apiUrl}/events?limit=100`);
    }

    const responses = await Promise.all(queries.map((q) => fetchWithTimeout(q)));

    const rawList: any[] = [];
    for (const r of responses) {
      if (r && r.success && Array.isArray(r.events)) {
        rawList.push(...r.events);
      }
    }

    let newEventsCount = 0;
    for (const rawEvt of rawList) {
      const parsed = parseIndexerApiEvent(rawEvt);
      if (parsed) {
        const key = this.getEventKey(parsed);
        if (!this.eventIds.has(key)) {
          this.eventIds.add(key);
          this.events.push(parsed);
          newEventsCount++;
          if (parsed.ledger > this.lastIndexedLedger) {
            this.lastIndexedLedger = parsed.ledger;
          }
        }
      }
    }

    if (newEventsCount > 0) {
      this.events.sort((a, b) => a.ledger - b.ledger || a.timestamp - b.timestamp);
      if (this.events.length > this.config.maxCacheSize) {
        const excess = this.events.length - this.config.maxCacheSize;
        const removed = this.events.splice(0, excess);
        for (const rem of removed) {
          this.eventIds.delete(this.getEventKey(rem));
        }
      }
      this.saveEventsToCache();
      this.notifyListeners();
    }

    this.isIndexerApiActive = true;
    this.lastApiSyncTime = Date.now();
    return newEventsCount;
  }

  /**
   * Executes a single poll query with fast Windows API sync and graceful direct Soroban RPC fallback.
   */
  public async pollOnce(): Promise<number> {
    if (this.config.contractIds.length === 0) return 0;

    // 1. Attempt fast synchronization from Windows Indexer API if configured
    if (this.config.indexerApiUrl) {
      try {
        const apiEventsCount = await this.fetchFromIndexerApi();
        this.isIndexerApiActive = true;
        return apiEventsCount;
      } catch (apiErr) {
        // Log graceful warning and seamlessly fall back to direct RPC
        console.warn("[Indexer] Windows Indexer API unavailable, seamlessly falling back to direct Soroban RPC:", apiErr);
        this.isIndexerApiActive = false;
      }
    }

    // 2. Direct Soroban Testnet RPC polling (standard fallback)
    return await this.pollDirectRpc();
  }

  /**
   * Executes direct Soroban RPC query with paging, retention window calculation, and error recovery.
   */
  public async pollDirectRpc(): Promise<number> {
    if (this.config.contractIds.length === 0) return 0;

    let hasMorePages = true;
    let newEventsCount = 0;
    let pageCount = 0;
    const maxPagesPerPoll = 25;

    while (hasMorePages && !this.abortRequested && pageCount < maxPagesPerPoll) {
      pageCount++;
      let req: rpc.Api.GetEventsRequest;

      // Filter definition: all topic segments for specified contract IDs
      const filter: rpc.Api.EventFilter = {
        type: "contract",
        contractIds: this.config.contractIds,
      };

      if (this.cursor) {
        // CURSOR VARIANT: never include startLedger
        req = {
          filters: [filter],
          cursor: this.cursor,
          limit: this.config.pageSize,
        };
      } else {
        // LEDGER RANGE VARIANT: never include cursor
        // Check latest ledger from RPC to clamp retention window
        let startLedger = this.lastIndexedLedger > 0
          ? this.lastIndexedLedger + 1
          : this.config.startLedger;

        try {
          const latestLedgerResp = await this.rpcServer.getLatestLedger();
          // Standard Soroban retention window is ~17,280 ledgers (24h)
          // Oldest ledger is approximately latestLedger - 17,280
          const estimatedOldest = Math.max(1, latestLedgerResp.sequence - 17280);
          startLedger = Math.max(startLedger, estimatedOldest);
        } catch {
          // Fallback if getLatestLedger fails
          startLedger = Math.max(1, startLedger);
        }

        req = {
          filters: [filter],
          startLedger,
          limit: this.config.pageSize,
        };
      }

      let res: rpc.Api.GetEventsResponse;
      try {
        res = await this.rpcServer.getEvents(req);
      } catch (err: unknown) {
        const errMsg = String(err);
        // If cursor is stale or invalid, reset cursor and retry from ledger sequence
        if (this.cursor && (errMsg.includes("cursor") || errMsg.includes("-32602"))) {
          console.warn("[Indexer] Cursor stale, resetting and falling back to ledger range:", err);
          this.cursor = null;
          continue;
        }
        // If startLedger < oldestLedger
        if (errMsg.includes("oldestLedger") || errMsg.includes("retention")) {
          console.warn("[Indexer] startLedger below retention window, advancing startLedger:", err);
          try {
            const latest = await this.rpcServer.getLatestLedger();
            this.lastIndexedLedger = latest.sequence - 1000;
            this.cursor = null;
            continue;
          } catch {
            // Ignore
          }
        }
        throw err;
      }

      const rawEvents = res.events || [];
      for (const rawEvt of rawEvents) {
        const parsed = parseEventResponse(rawEvt);
        if (parsed) {
          const key = this.getEventKey(parsed);
          if (!this.eventIds.has(key)) {
            this.eventIds.add(key);
            this.events.push(parsed);
            newEventsCount++;
            if (parsed.ledger > this.lastIndexedLedger) {
              this.lastIndexedLedger = parsed.ledger;
            }
          }
        }
      }

      // Update cursor
      if (res.cursor) {
        this.cursor = res.cursor;
      }

      // Check if more events exist on the cursor page
      if (rawEvents.length === this.config.pageSize && res.cursor) {
        hasMorePages = true;
      } else {
        hasMorePages = false;
      }
    }

    if (newEventsCount > 0) {
      // Sort chronologically
      this.events.sort((a, b) => a.ledger - b.ledger || a.timestamp - b.timestamp);
      // Prune if exceeds maxCacheSize
      if (this.events.length > this.config.maxCacheSize) {
        const excess = this.events.length - this.config.maxCacheSize;
        const removed = this.events.splice(0, excess);
        for (const rem of removed) {
          this.eventIds.delete(this.getEventKey(rem));
        }
      }
      this.saveEventsToCache();
      this.notifyListeners();
    }

    return newEventsCount;
  }

  /**
   * Manually adds a synthetic or verified event to the indexer store.
   * Useful for seeding confirmed local transactions.
   */
  public addManualEvent(event: ProtocolEvent): boolean {
    const key = this.getEventKey(event);
    if (this.eventIds.has(key)) return false;

    this.eventIds.add(key);
    this.events.push(event);
    if (event.ledger > this.lastIndexedLedger) {
      this.lastIndexedLedger = event.ledger;
    }
    this.events.sort((a, b) => a.ledger - b.ledger || a.timestamp - b.timestamp);
    if (this.events.length > this.config.maxCacheSize) {
      const excess = this.events.length - this.config.maxCacheSize;
      const removed = this.events.splice(0, excess);
      for (const rem of removed) {
        this.eventIds.delete(this.getEventKey(rem));
      }
    }
    this.saveEventsToCache();
    this.notifyListeners();
    return true;
  }

  public getEvents(): ProtocolEvent[] {
    return [...this.events];
  }

  public getLastIndexedLedger(): number {
    return this.lastIndexedLedger;
  }

  public getCursor(): string | null {
    return this.cursor;
  }

  public clearCache(): void {
    this.events = [];
    this.eventIds.clear();
    this.cursor = null;
    this.lastIndexedLedger = 0;
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.removeItem(this.config.storageKey);
      window.localStorage.removeItem(`${this.config.storageKey}_cursor`);
    }
    this.notifyListeners();
  }
}
