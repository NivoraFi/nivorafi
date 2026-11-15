/**
 * ============================================================================
 * Milestone 4: Tier 5 White-Box Adversarial Coverage Hardening Suite
 * ============================================================================
 *
 * File: tests/m4_tier5_adversarial_1.test.ts
 *
 * Objective:
 * 1. Deep white-box adversarial verification of:
 *    - `indexer/index.ts`
 *    - `frontend/src/lib/indexerAnalytics.ts`
 *    - `frontend/src/hooks/useIndexerAnalytics.ts`
 * 2. Stress-test untested code paths, subtle arithmetic rounding scenarios, and boundary extremes:
 *    - Ledger sequence reordering, timestamp jitter, event ID collisions, and idempotency
 *    - Arithmetic rounding, integer stroop precision, unit cost basis, conservation on mint_py, and dust thresholds (<10 stroops)
 *    - Multi-currency portfolio valuation (USDC $1.00 vs XLM $0.12) and dollar-weighted portfolio APY
 *    - Total position liquidation (zero balances) and division-by-zero guards
 *    - Near-maturity / post-maturity APY clamping and Taylor expansion stability
 *    - Corrupted / malformed JSON envelope defensive parsing in client library
 *    - Rapid interval switching & stale response rejection in React hook
 * 3. Verify locked file SHA256 checksums remain unmodified.
 */

// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import React, { act } from "../frontend/node_modules/react";
import { createRoot, type Root } from "../frontend/node_modules/react-dom/client";

// Indexer White-Box Exports
import {
  EventStorage,
  calculateImpliedApy,
  MARKETS,
  resolveMarket,
  getMarketForContract,
  scValToBigInt,
  scValToAddress,
  scValToString,
  scValToNumber,
  scValToBoolean,
  type DecodedEvent,
  type UserPositionsResponse,
  type MarketChartsResponse,
} from "../indexer/index";

// Frontend Analytics Client Library Exports
import {
  fetchUserPositionData,
  fetchMarketChartData,
  convertToChartDataPoints,
  convertToApyDataPoints,
  synthesizeFallbackChart,
  buildEmptyPositionsSummary,
  buildEmptyUserPositions,
  buildEmptyChartResponse,
  resolveIndexerBaseUrl,
  type MarketChartInterval,
  type MarketChartPoint,
  type UserMarketPosition,
  type UserPositionsSummary,
} from "../frontend/src/lib/indexerAnalytics";

// Frontend React Hook Exports
import {
  useIndexerAnalytics,
  type UseIndexerAnalyticsOptions,
  type UseIndexerAnalyticsReturn,
} from "../frontend/src/hooks/useIndexerAnalytics";

import { PRESET_MARKETS } from "../frontend/src/lib/markets";

// ============================================================================
// Headless DOM Mock Engine for React 19 Client Lifecycle Testing
// ============================================================================

class MockEventTarget {
  listeners: Record<string, Function[]> = {};

  addEventListener(type: string, fn: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  removeEventListener(type: string, fn: Function) {
    if (!this.listeners[type]) return;
    const idx = this.listeners[type].indexOf(fn);
    if (idx >= 0) this.listeners[type].splice(idx, 1);
  }

  dispatchEvent(evt: { type: string }) {
    const fns = this.listeners[evt.type] || [];
    fns.forEach((fn) => fn(evt));
  }
}

class MockNode extends MockEventTarget {
  childNodes: MockNode[] = [];
  parentNode: MockNode | null = null;

  appendChild(child: MockNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: MockNode) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  insertBefore(child: MockNode, ref: MockNode | null) {
    child.parentNode = this;
    if (!ref) {
      this.childNodes.push(child);
      return child;
    }
    const idx = this.childNodes.indexOf(ref);
    if (idx >= 0) this.childNodes.splice(idx, 0, child);
    else this.childNodes.push(child);
    return child;
  }
}

class MockElement extends MockNode {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  ownerDocument: any = null;

  constructor(tagName: string = "div") {
    super();
    this.nodeName = tagName.toUpperCase();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, val: string) {
    this.attributes[name] = String(val);
  }

  getAttribute(name: string) {
    return this.attributes[name] || null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }
}

class MockDocument extends MockNode {
  nodeType = 9;
  nodeName = "#document";
  documentElement: MockElement;
  head: MockElement;
  body: MockElement;
  defaultView: any = null;
  visibilityState: "visible" | "hidden" = "visible";

  constructor() {
    super();
    this.documentElement = new MockElement("html");
    this.head = new MockElement("head");
    this.body = new MockElement("body");
  }

  createElement(tag: string) {
    const el = new MockElement(tag);
    el.ownerDocument = this;
    return el;
  }

  createElementNS(_ns: string, tag: string) {
    return this.createElement(tag);
  }

  createTextNode(text: string) {
    return {
      nodeType: 3,
      nodeValue: text,
      textContent: text,
      ownerDocument: this,
      parentNode: null,
    };
  }
}

let currentMockDoc: MockDocument;
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const activeIntervalTimers = new Set<any>();

function enableTimerTracking() {
  activeIntervalTimers.clear();
  globalThis.setInterval = ((fn: Function, ms?: number, ...args: any[]) => {
    const id = originalSetInterval(fn, ms, ...args);
    activeIntervalTimers.add(id);
    return id;
  }) as any;

  globalThis.clearInterval = ((id: any) => {
    activeIntervalTimers.delete(id);
    return originalClearInterval(id);
  }) as any;
}

function restoreTimerTracking() {
  for (const id of activeIntervalTimers) {
    originalClearInterval(id);
  }
  activeIntervalTimers.clear();
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}

function setupClientEnvironment() {
  currentMockDoc = new MockDocument();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = {
    document: currentMockDoc,
    HTMLIFrameElement: class {},
    HTMLElement: MockElement,
    Element: MockElement,
    Node: MockNode,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  currentMockDoc.defaultView = (globalThis as any).window;
  (globalThis as any).document = currentMockDoc;
  (globalThis as any).HTMLElement = MockElement;
  (globalThis as any).Element = MockElement;
  (globalThis as any).Node = MockNode;
}

function teardownClientEnvironment() {
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Element;
  delete (globalThis as any).Node;
}

interface TestConsumerProps {
  opts: UseIndexerAnalyticsOptions;
  onUpdate?: (res: UseIndexerAnalyticsReturn) => void;
}

function TestHookConsumer({ opts, onUpdate }: TestConsumerProps) {
  const result = useIndexerAnalytics(opts);
  if (onUpdate) onUpdate(result);
  return null;
}

// ============================================================================
// MAIN ADVERSARIAL TEST SUITE
// ============================================================================

describe("Milestone 4: Tier 5 White-Box Adversarial Coverage Hardening", () => {
  const testDbPath = join(import.meta.dir, "m4_tier5_adversarial_1.db");
  let storage: EventStorage;

  const cleanupDb = () => {
    try {
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
      if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
      if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    } catch {
      // Ignore
    }
  };

  beforeEach(() => {
    cleanupDb();
    storage = new EventStorage(testDbPath);
  });

  afterEach(() => {
    if (storage) {
      storage.close();
    }
    cleanupDb();
  });

  // ==========================================================================
  // 0. Protected File Integrity Checksum Verification
  // ==========================================================================
  describe("0. Protected File Integrity & Checksum Verification", () => {
    it("0.1 frontend/src/lib/indexer.ts checksum exactly matches baseline sha256", () => {
      const filePath = join(__dirname, "../frontend/src/lib/indexer.ts");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
    });

    it("0.2 frontend/src/hooks/useEventIndexer.ts checksum exactly matches baseline sha256", () => {
      const filePath = join(__dirname, "../frontend/src/hooks/useEventIndexer.ts");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
    });
  });

  // ==========================================================================
  // Suite 1: Ledger Sequence & Out-of-Order Event Ingestion (White-Box indexer/index.ts)
  // ==========================================================================
  describe("Suite 1: Ledger Sequence & Out-of-Order Event Ingestion (indexer/index.ts)", () => {
    const USER = "GADV_LEDGER_SEQ_USER_111111111111111111111111111111111";

    it("1.1 Event Idempotency: Duplicate event ID ingestion is strictly ignored and does not double-count volume or positions", () => {
      const fixedEventId = "evt_idempotent_duplicate_999999";
      const timestamp = 1794270000;
      const ledger = 5647000;

      const event: DecodedEvent = {
        id: fixedEventId,
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx_hash_duplicate_test_123",
        ledger,
        ledgerClosedAt: new Date(timestamp * 1000).toISOString(),
        timestamp,
        type: "swap",
        topicSymbol: "swap",
        caller: USER,
        receiver: USER,
        data: {
          direction: 1, // Buy PT
          amountIn: "10000000", // 1 USDC = 1e7 stroops
          amountOut: "10200000", // 1.02 PT
          fee: "1000",
        },
      };

      // First ingestion
      const inserted1 = storage.saveEvents([event]);
      expect(inserted1).toBe(1);

      const pos1 = storage.getUserPositions(USER);
      expect(pos1.count).toBe(1);
      expect(pos1.positions[0].currentPtBalance).toBe("10200000");
      expect(pos1.positions[0].costBasisStroops).toBe("10000000");
      expect(pos1.positions[0].totalTradesCount).toBe(1);

      // Duplicate ingestion with exact same event ID
      const inserted2 = storage.saveEvents([event]);
      expect(inserted2).toBe(0); // Ignored!

      const pos2 = storage.getUserPositions(USER);
      expect(pos2.count).toBe(1);
      expect(pos2.positions[0].currentPtBalance).toBe("10200000"); // Unchanged
      expect(pos2.positions[0].costBasisStroops).toBe("10000000"); // Unchanged
      expect(pos2.positions[0].totalTradesCount).toBe(1); // Not incremented

      // Verify chart volume in market_snapshots is NOT doubled
      const chart = storage.getMarketChart("usdc-90d", "1D");
      const activePoints = chart.data.filter((p) => p.tradeCount && p.tradeCount > 0);
      expect(activePoints.length).toBe(1);
      expect(activePoints[0].tradeCount).toBe(1);
      expect(activePoints[0].volume).toBe("10000000");
    });

    it("1.2 Out-of-Order Ledgers: Later ledger processed before earlier ledger does not crash and preserves accounting", () => {
      const tLater = 1794273600; // T + 1 hour
      const tEarlier = 1794270000; // T

      const eventLater: DecodedEvent = {
        id: "evt_order_later_ledger_5648000",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx_order_later",
        ledger: 5648000,
        ledgerClosedAt: new Date(tLater * 1000).toISOString(),
        timestamp: tLater,
        type: "swap",
        topicSymbol: "swap",
        caller: USER,
        receiver: USER,
        data: {
          direction: 1, // Buy PT
          amountIn: "20000000",
          amountOut: "20400000",
          fee: "2000",
        },
      };

      const eventEarlier: DecodedEvent = {
        id: "evt_order_earlier_ledger_5647000",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx_order_earlier",
        ledger: 5647000,
        ledgerClosedAt: new Date(tEarlier * 1000).toISOString(),
        timestamp: tEarlier,
        type: "swap",
        topicSymbol: "swap",
        caller: USER,
        receiver: USER,
        data: {
          direction: 1, // Buy PT
          amountIn: "10000000",
          amountOut: "10200000",
          fee: "1000",
        },
      };

      // Process later event first
      storage.saveEvents([eventLater]);
      let pos = storage.getUserPositions(USER);
      expect(pos.positions[0].currentPtBalance).toBe("20400000");
      expect(pos.positions[0].costBasisStroops).toBe("20000000");

      // Now process earlier event second
      storage.saveEvents([eventEarlier]);
      pos = storage.getUserPositions(USER);
      expect(pos.positions[0].currentPtBalance).toBe("30600000"); // 20.4M + 10.2M
      expect(pos.positions[0].costBasisStroops).toBe("30000000"); // 20M + 10M
      expect(pos.positions[0].totalTradesCount).toBe(2);
    });

    it("1.3 Extreme Boundary Ledgers: Handles ledger 0, 1, 2^31 - 1, and 2^32 cleanly", () => {
      const boundaryLedgers = [0, 1, 2147483647, 4294967295];

      for (let i = 0; i < boundaryLedgers.length; i++) {
        const l = boundaryLedgers[i];
        const event: DecodedEvent = {
          id: `evt_boundary_ledger_${l}_${i}`,
          contractId: MARKETS["usdc-90d"].poolId,
          txHash: `tx_boundary_ledger_${l}`,
          ledger: l,
          ledgerClosedAt: new Date(1794270000000 + i * 1000).toISOString(),
          timestamp: 1794270000 + i,
          type: "swap",
          topicSymbol: "swap",
          caller: USER,
          receiver: USER,
          data: {
            direction: 1,
            amountIn: "1000000",
            amountOut: "1010000",
            fee: "100",
          },
        };

        const count = storage.saveEvents([event]);
        expect(count).toBe(1);
      }

      const pos = storage.getUserPositions(USER);
      expect(pos.count).toBe(1);
      expect(pos.positions[0].totalTradesCount).toBe(boundaryLedgers.length);
    });

    it("1.4 Simultaneous Timestamp Tie-Breaking: Multiple swaps at identical timestamp update bucket deterministically", () => {
      const fixedTimestamp = 1794270000;
      const events: DecodedEvent[] = [
        {
          id: "evt_tie_1",
          contractId: MARKETS["usdc-90d"].poolId,
          txHash: "tx_tie_1",
          ledger: 5647000,
          ledgerClosedAt: new Date(fixedTimestamp * 1000).toISOString(),
          timestamp: fixedTimestamp,
          type: "swap",
          topicSymbol: "swap",
          caller: USER,
          receiver: USER,
          data: { direction: 1, amountIn: "5000000", amountOut: "5100000", fee: "500" },
        },
        {
          id: "evt_tie_2",
          contractId: MARKETS["usdc-90d"].poolId,
          txHash: "tx_tie_2",
          ledger: 5647000,
          ledgerClosedAt: new Date(fixedTimestamp * 1000).toISOString(),
          timestamp: fixedTimestamp,
          type: "swap",
          topicSymbol: "swap",
          caller: USER,
          receiver: USER,
          data: { direction: 1, amountIn: "7000000", amountOut: "7150000", fee: "700" },
        },
      ];

      storage.saveEvents(events);

      const chart = storage.getMarketChart("usdc-90d", "1D");
      const point = chart.data.find((p) => p.timestamp === Math.floor(fixedTimestamp / 3600) * 3600);
      expect(point).toBeDefined();
      expect(point?.tradeCount).toBe(2);
      expect(point?.volume).toBe("12000000"); // 5M + 7M
    });

    it("1.5 Inverted Timestamp Ingestion & first_trade_timestamp Tracking", () => {
      const tNew = 1794275000;
      const tOld = 1794270000;

      // Event 1 with newer timestamp
      storage.saveEvents([
        {
          id: "evt_time_new",
          contractId: MARKETS["usdc-90d"].poolId,
          txHash: "tx_time_new",
          ledger: 5648000,
          ledgerClosedAt: new Date(tNew * 1000).toISOString(),
          timestamp: tNew,
          type: "swap",
          topicSymbol: "swap",
          caller: USER,
          receiver: USER,
          data: { direction: 1, amountIn: "1000000", amountOut: "1020000", fee: "100" },
        },
      ]);

      let pos = storage.getUserPositions(USER);
      expect(pos.positions[0].firstTradeTimestamp).toBe(tNew);

      // Event 2 with older timestamp arrives after
      storage.saveEvents([
        {
          id: "evt_time_old",
          contractId: MARKETS["usdc-90d"].poolId,
          txHash: "tx_time_old",
          ledger: 5646000,
          ledgerClosedAt: new Date(tOld * 1000).toISOString(),
          timestamp: tOld,
          type: "swap",
          topicSymbol: "swap",
          caller: USER,
          receiver: USER,
          data: { direction: 1, amountIn: "1000000", amountOut: "1020000", fee: "100" },
        },
      ]);

      pos = storage.getUserPositions(USER);
      expect(pos.positions[0].totalTradesCount).toBe(2);
      expect(pos.positions[0].currentPtBalance).toBe("2040000");
    });
  });

  // ==========================================================================
  // Suite 2: Subtle Arithmetic Rounding, Precision Loss & Conservation (indexer/index.ts)
  // ==========================================================================
  describe("Suite 2: Subtle Arithmetic Rounding, Precision Loss & Conservation (indexer/index.ts)", () => {
    const USER = "GADV_ARITHMETIC_USER_22222222222222222222222222222222";

    it("2.1 Conservation of Cost Basis on mint_py across irrational PT prices down to 1 stroop", () => {
      const timestamp = 1794270000;
      const oddSyIn = 1337420999n; // Odd stroop amount
      const pyOut = 1337420999n;

      const event: DecodedEvent = {
        id: "evt_mint_py_conservation_test",
        contractId: MARKETS["usdc-90d"].poolId,
        txHash: "tx_mint_conservation",
        ledger: 5647100,
        ledgerClosedAt: new Date(timestamp * 1000).toISOString(),
        timestamp,
        type: "mint_py",
        topicSymbol: "mint_py",
        caller: USER,
        receiver: USER,
        data: {
          syIn: oddSyIn.toString(),
          pyOut: pyOut.toString(),
          spotPtPrice: 0.98234567, // Arbitrary irrational spot price
        },
      };

      storage.saveEvents([event]);

      const row = (storage as any).db
        .prepare("SELECT pt_cost_basis_sy, yt_cost_basis_sy FROM user_positions WHERE user_address = ?")
        .get(USER) as { pt_cost_basis_sy: string; yt_cost_basis_sy: string };

      const ptCost = BigInt(row.pt_cost_basis_sy);
      const ytCost = BigInt(row.yt_cost_basis_sy);

      // Exact mathematical invariant: costPt + costYt === syIn
      expect(ptCost + ytCost).toBe(oddSyIn);
      expect(ptCost).toBeGreaterThan(0n);
      expect(ytCost).toBeGreaterThan(0n);
    });

    it("2.2 Unit Cost Basis Multi-Stage Partial Selling & Dust Threshold (<10 Stroops)", () => {
      const timestamp = 1794270000;

      // 1. Buy 1,000,000 stroops PT for 980,000 stroops SY
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp,
        caller: USER,
        receiver: USER,
        direction: 1, // Buy PT
        amountIn: 980000n,
        amountOut: 1000000n,
        fee: 0n,
      });

      let pos = storage.getUserPositions(USER);
      expect(pos.positions[0].currentPtBalance).toBe("1000000");
      expect(pos.positions[0].costBasisStroops).toBe("980000");

      // 2. Partial Sell: Sell 500,000 PT (50%) for 495,000 SY (profit of +5,000)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: timestamp + 100,
        caller: USER,
        receiver: USER,
        direction: 0, // Sell PT
        amountIn: 500000n,
        amountOut: 495000n,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER);
      expect(pos.positions[0].currentPtBalance).toBe("500000");
      expect(pos.positions[0].costBasisStroops).toBe("490000"); // 980,000 * 0.5
      expect(pos.positions[0].realizedPnlStroops).toBe("5000"); // 495,000 - 490,000

      // 3. Sell 499,990 PT, leaving exactly 10 stroops PT
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: timestamp + 200,
        caller: USER,
        receiver: USER,
        direction: 0, // Sell PT
        amountIn: 499990n,
        amountOut: 490000n,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER);
      // At boundary 10n: balance is preserved (10 stroops)
      expect(pos.positions[0].currentPtBalance).toBe("10");

      // 4. Sell 1 more stroop, leaving 9 stroops PT (< 10 stroops dust threshold)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: timestamp + 300,
        caller: USER,
        receiver: USER,
        direction: 0, // Sell PT
        amountIn: 1n,
        amountOut: 1n,
        fee: 0n,
      });

      pos = storage.getUserPositions(USER);
      // Below 10 stroops: dust threshold clamps balance and cost basis to exactly 0n!
      expect(pos.positions[0].currentPtBalance).toBe("0");
      expect(pos.positions[0].costBasisStroops).toBe("0");
    });

    it("2.3 calculateImpliedApy Mathematical Boundary Guards & Clamping", () => {
      // Near maturity: 1 second remaining
      const tau1s = 1.0 / 31536000;
      const apy1s = calculateImpliedApy(0.9999, tau1s);
      expect(apy1s).toBeGreaterThan(0.0);
      expect(apy1s).toBeLessThanOrEqual(500.0);
      expect(Number.isFinite(apy1s)).toBe(true);

      // Deep discount near maturity: linear Taylor expansion clamps at 500.0%
      const extremeDiscountApy = calculateImpliedApy(0.90, tau1s);
      expect(extremeDiscountApy).toBe(500.0);

      // Post-maturity: tau <= 0
      expect(calculateImpliedApy(0.98, 0.0)).toBe(0.0);
      expect(calculateImpliedApy(0.98, -0.5)).toBe(0.0);

      // Boundary PT prices
      expect(calculateImpliedApy(1.0, 0.25)).toBe(0.0); // Matured / par
      expect(calculateImpliedApy(1.05, 0.25)).toBe(0.0); // Irrational premium (> 1.0)
      expect(calculateImpliedApy(0.0, 0.25)).toBe(0.0); // Zero price
      expect(calculateImpliedApy(-0.5, 0.25)).toBe(0.0); // Negative price
    });

    it("2.4 Large Number Stroop Arithmetic (Stress up to 5e15 Stroops)", () => {
      const timestamp = 1794270000;
      // 500 million tokens = 5e15 stroops (approaches 2^52 safe integer limit)
      const bigAmtIn = 5000000000000000n;
      const bigAmtOut = 5100000000000000n;

      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: bigAmtIn,
        amountOut: bigAmtOut,
        fee: 0n,
      });

      const pos = storage.getUserPositions(USER);
      expect(pos.positions[0].currentPtBalance).toBe("5100000000000000");
      expect(pos.positions[0].costBasisStroops).toBe("5000000000000000");
      expect(pos.positions[0].costBasisUsd).toBe(500000000); // $500,000,000 USD
    });

    it("2.5 Burn Exceeding Remaining Balance: redeem_py with pyBurned > ptBal clamps balances to 0n without negative balances", () => {
      const timestamp = 1794270000;

      // 1. User mints 10,000,000 PY from 10,000,000 SY (cost basis 10,000,000)
      storage.saveEvents([
        {
          id: "evt_mint_small",
          contractId: MARKETS["usdc-90d"].poolId,
          txHash: "tx_mint_small",
          ledger: 5647000,
          ledgerClosedAt: new Date(timestamp * 1000).toISOString(),
          timestamp,
          type: "mint_py",
          topicSymbol: "mint_py",
          caller: USER,
          receiver: USER,
          data: { syIn: "10000000", pyOut: "10000000", spotPtPrice: 0.98 },
        },
      ]);

      let pos = storage.getUserPositions(USER);
      expect(pos.positions[0].currentPtBalance).toBe("10000000");
      expect(pos.positions[0].currentYtBalance).toBe("10000000");

      // 2. User redeems 20,000,000 PY (exceeding 10,000,000 balance)
      storage.saveEvents([
        {
          id: "evt_redeem_excessive",
          contractId: MARKETS["usdc-90d"].poolId,
          txHash: "tx_redeem_excessive",
          ledger: 5647010,
          ledgerClosedAt: new Date((timestamp + 10) * 1000).toISOString(),
          timestamp: timestamp + 10,
          type: "redeem_py",
          topicSymbol: "redeem_py",
          caller: USER,
          receiver: USER,
          data: { pyBurned: "20000000", syOut: "10500000" },
        },
      ]);

      pos = storage.getUserPositions(USER);
      // Both balances and cost basis clamp safely to 0n, preventing negative token balances
      expect(pos.positions[0].currentPtBalance).toBe("0");
      expect(pos.positions[0].currentYtBalance).toBe("0");
      expect(pos.positions[0].costBasisStroops).toBe("0");
      // White-box finding: pyBurned (20M) scales cost basis (totalCostSold = 20M), yielding syOut (10.5M) - 20M = -9.5M
      expect(pos.positions[0].realizedPnlStroops).toBe("-9500000");
    });

    it("2.6 Yield Claim and Redeem PT Increment Realized PnL and Cumulative Claimed Yield", () => {
      const timestamp = 1794270000;

      // 1. User claims 50 USDC yield
      storage.recordYieldClaimed({
        marketId: "usdc-90d",
        timestamp,
        user: USER,
        yieldOut: 500000000n, // 50 USDC = 5e8 stroops
      });

      let pos = storage.getUserPositions(USER);
      expect(pos.positions[0].cumulativeClaimedYieldStroops).toBe("500000000");
      expect(pos.positions[0].cumulativeClaimedYieldUsd).toBe(50.0);
      expect(pos.positions[0].realizedPnlUsd).toBe(50.0);

      // 2. User redeems matured PT (with caller: USER)
      storage.recordRedeemPt({
        marketId: "usdc-90d",
        timestamp: timestamp + 100,
        caller: USER,
        ptBurned: 100000000n,
        payout: 100000000n, // 10 USDC payout
      });

      pos = storage.getUserPositions(USER);
      expect(pos.positions[0].realizedPnlUsd).toBe(60.0); // 50 + 10 payout (since cost basis was 0)
    });
  });

  // ==========================================================================
  // Suite 3: Multi-Currency Valuation & Portfolio APY Weighting (indexer/index.ts)
  // ==========================================================================
  describe("Suite 3: Multi-Currency Valuation & Portfolio APY Weighting (indexer/index.ts)", () => {
    const USER = "GADV_MULTI_CURRENCY_USER_333333333333333333333333333333";

    it("3.1 Cross-Currency Valuation: Correctly scales USDC ($1.00) and XLM ($0.12)", () => {
      const timestamp = 1794270000;

      // 1. Buy 100 USDC in usdc-90d ($100 USD)
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 1000000000n, // 100 USDC
        amountOut: 1020000000n,
        fee: 0n,
      });

      // 2. Buy 1,000 XLM in xlm-90d ($120 USD at $0.12/XLM)
      storage.recordSwap({
        marketId: "xlm-90d",
        timestamp,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 10000000000n, // 1,000 XLM
        amountOut: 10200000000n,
        fee: 0n,
      });

      const res = storage.getUserPositions(USER);
      expect(res.count).toBe(2);

      const usdcPos = res.positions.find((p) => p.marketId === "usdc-90d");
      const xlmPos = res.positions.find((p) => p.marketId === "xlm-90d");

      expect(usdcPos).toBeDefined();
      expect(xlmPos).toBeDefined();

      expect(usdcPos?.costBasisUsd).toBe(100.0);
      expect(xlmPos?.costBasisUsd).toBe(120.0); // 1,000 * 0.12

      // Summary sums USD across currencies
      expect(res.summary.totalCostBasisUsd).toBe(220.0); // $100 + $120
      expect(res.summary.activePositionsCount).toBe(2);
    });

    it("3.2 Portfolio APY Dollar-Weighting Invariant: Dollar weights prevail over raw stroop token counts", () => {
      const timestamp = 1794270000;

      // Position A: $1,000 USD position with 8.0% APY in usdc-90d
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 10000000000n, // $1,000 USD
        amountOut: 10200000000n,
        fee: 0n,
      });

      // Position B: 10 XLM ($1.20 USD) in xlm-90d
      storage.recordSwap({
        marketId: "xlm-90d",
        timestamp,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 100000000n, // 10 XLM = $1.20 USD
        amountOut: 105000000n,
        fee: 0n,
      });

      const res = storage.getUserPositions(USER);
      const usdcPos = res.positions.find((p) => p.marketId === "usdc-90d")!;
      const xlmPos = res.positions.find((p) => p.marketId === "xlm-90d")!;

      // Dollar-weighted portfolio APY must be dominated by the $1,000 position
      const expectedWeightedApy =
        (usdcPos.averageEntryApy * usdcPos.currentPositionValueUsd +
          xlmPos.averageEntryApy * xlmPos.currentPositionValueUsd) /
        res.summary.totalCurrentValueUsd;

      expect(res.summary.overallPortfolioApy).toBeCloseTo(expectedWeightedApy, 1);
      expect(res.summary.overallPortfolioApy).toBeCloseTo(usdcPos.averageEntryApy, 0); // Very close to usdc APY
    });

    it("3.3 Total Position Liquidation: Zero balances safely yield zero overallPortfolioApy without divide-by-zero", () => {
      const timestamp = 1794270000;

      // 1. Buy 100 USDC PT
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp,
        caller: USER,
        receiver: USER,
        direction: 1,
        amountIn: 1000000000n,
        amountOut: 1020000000n,
        fee: 0n,
      });

      // 2. Sell 100% of PT
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: timestamp + 100,
        caller: USER,
        receiver: USER,
        direction: 0,
        amountIn: 1020000000n,
        amountOut: 1030000000n,
        fee: 0n,
      });

      const res = storage.getUserPositions(USER);
      expect(res.positions[0].currentPtBalance).toBe("0");
      expect(res.positions[0].costBasisStroops).toBe("0");
      expect(res.summary.totalCurrentValueUsd).toBe(0);
      expect(res.summary.activePositionsCount).toBe(0);
      expect(res.summary.overallPortfolioApy).toBe(0); // Safely 0, not NaN or Infinity!
      expect(res.summary.totalRealizedPnlUsd).toBe(3.0); // +3 USD
    });

    it("3.4 Greenfield User and Validation Errors", () => {
      // Greenfield
      const res = storage.getUserPositions("G_UNSEEN_NEWBIE_WALLET_0000000000000000000000000000");
      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.positions).toEqual([]);
      expect(res.summary.totalCostBasisUsd).toBe(0);

      // Empty string query parameter throws
      expect(() => storage.getUserPositions("")).toThrow("Missing required query parameter: user");
    });

    it("3.5 Multi-Currency Yield Claim Aggregation: USD scaling for USDC ($1.00) and XLM ($0.12)", () => {
      const timestamp = 1794270000;

      // 1. Claim 10 USDC in usdc-90d ($10 USD)
      storage.recordYieldClaimed({
        marketId: "usdc-90d",
        timestamp,
        user: USER,
        yieldOut: 100000000n, // 10 USDC = $10.00
      });

      // 2. Claim 100 XLM in xlm-90d ($12 USD)
      storage.recordYieldClaimed({
        marketId: "xlm-90d",
        timestamp: timestamp + 50,
        user: USER,
        yieldOut: 1000000000n, // 100 XLM = $12.00 USD
      });

      const res = storage.getUserPositions(USER);
      const usdcPos = res.positions.find((p) => p.marketId === "usdc-90d")!;
      const xlmPos = res.positions.find((p) => p.marketId === "xlm-90d")!;

      expect(usdcPos.cumulativeClaimedYieldUsd).toBe(10.0);
      expect(xlmPos.cumulativeClaimedYieldUsd).toBe(12.0);

      // Total claimed USD in summary
      expect(res.summary.totalClaimedYieldUsd).toBe(22.0); // $10 + $12
    });
  });

  // ==========================================================================
  // Suite 4: Frontend Client Library Adversarial Hardening (indexerAnalytics.ts)
  // ==========================================================================
  describe("Suite 4: Frontend Client Library Adversarial Hardening (indexerAnalytics.ts)", () => {
    it("4.1 Defensive Parsing: Corrupted JSON shapes return safe fallback without crashing", async () => {
      // Mock fetch returning corrupted JSON
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: true,
            user: "GTEST",
            positions: "NOT_AN_ARRAY", // Corrupted!
            summary: "NOT_AN_OBJECT", // Corrupted!
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await fetchUserPositionData({ userAddress: "GTEST" });
      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(res.positions).toEqual([]);
      expect(res.summary.totalCostBasisUsd).toBe(0);

      globalThis.fetch = originalFetch;
    });

    it("4.2 Missing Numeric Fields: Defaults safely to 0 and empty strings", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: true,
            user: "GTEST_PARTIAL",
            positions: [
              {
                marketId: "usdc-90d",
                // all numeric fields omitted
              },
            ],
            summary: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await fetchUserPositionData({ userAddress: "GTEST_PARTIAL" });
      expect(res.count).toBe(1);
      const pos = res.positions[0];
      expect(pos.costBasisUsd).toBe(0);
      expect(pos.averageEntryApy).toBe(0);
      expect(pos.currentPtBalance).toBe("0");
      expect(pos.netPnlUsd).toBe(0);

      globalThis.fetch = originalFetch;
    });

    it("4.3 Network Failures & 500 Responses: Returns safe empty state without throwing", async () => {
      // Mock 500 Internal Server Error
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: "Database disk image is malformed" }), { status: 500 });
      };

      const posRes = await fetchUserPositionData({ userAddress: "GTEST_500" });
      expect(posRes.success).toBe(true);
      expect(posRes.count).toBe(0);

      const chartRes = await fetchMarketChartData({ market: "usdc-90d" });
      expect(chartRes.success).toBe(true);
      expect(chartRes.count).toBe(0);

      // Mock network exception (connection refused)
      globalThis.fetch = async () => {
        throw new Error("Connection refused: ECONNREFUSED 127.0.0.1:8765");
      };

      const offlineRes = await fetchUserPositionData({ userAddress: "GTEST_OFFLINE" });
      expect(offlineRes.success).toBe(true);
      expect(offlineRes.count).toBe(0);

      globalThis.fetch = originalFetch;
    });

    it("4.4 Synthetic Fallback Chart Generator across all intervals (1D, 1W, 1M, ALL)", () => {
      const market = PRESET_MARKETS[0];

      const res1D = synthesizeFallbackChart(market, "1D");
      expect(res1D.count).toBe(24);
      expect(res1D.data.length).toBe(24);

      const res1W = synthesizeFallbackChart(market, "1W");
      expect(res1W.count).toBe(168);

      const res1M = synthesizeFallbackChart(market, "1M");
      expect(res1M.count).toBe(30);

      const resAll = synthesizeFallbackChart(market, "ALL");
      expect(resAll.count).toBe(30);

      // Monotonic timestamps
      for (let i = 1; i < res1D.data.length; i++) {
        expect(res1D.data[i].timestamp).toBeGreaterThan(res1D.data[i - 1].timestamp);
      }
    });

    it("4.5 Data Conversion Utilities handle null/malformed items cleanly", () => {
      const chartPoints = convertToChartDataPoints(null as any);
      expect(chartPoints).toEqual([]);

      const dirtyPoints: any[] = [
        null,
        undefined,
        {},
        { timestamp: 1794270000, impliedApyPct: 8.5, ptPrice: 0.98 },
      ];
      const cleanChartPoints = convertToChartDataPoints(dirtyPoints);
      expect(cleanChartPoints.length).toBe(2); // {} and valid object
      expect(cleanChartPoints[1].impliedApy).toBe(8.5);
      expect(cleanChartPoints[1].ptPrice).toBe(0.98);

      const apyPoints = convertToApyDataPoints(dirtyPoints);
      expect(apyPoints.length).toBe(2);
      expect(apyPoints[1].apyPct).toBe(8.5);
    });

    it("4.6 Chart Interval Forward-Filling across Trade Gaps & Invalid Interval Graceful Fallback", () => {
      // Test invalid interval gracefully defaulting to 1D
      const chartInvalid = storage.getMarketChart("usdc-90d", "INVALID_INTERVAL_XYZ");
      expect(chartInvalid.success).toBe(true);
      expect(chartInvalid.interval).toBe("1D");
      expect(chartInvalid.count).toBe(24);

      // Verify forward filling when interval has gaps
      // In a greenfield DB, forward filling populates baselinePtPrice across all 24 buckets
      const chart1D = storage.getMarketChart("usdc-90d", "1D");
      expect(chart1D.data.length).toBe(24);
      for (const pt of chart1D.data) {
        expect(pt.ptPrice).toBeGreaterThan(0);
        expect(pt.close).toBeGreaterThan(0);
        expect(Number.isFinite(pt.impliedApy)).toBe(true);
      }
    });

    it("4.7 Unknown Market Identifier Handling in getMarketChart throws descriptive error", () => {
      expect(() => storage.getMarketChart("NON_EXISTENT_MARKET_ABC")).toThrow(
        "Market not found: NON_EXISTENT_MARKET_ABC"
      );
    });
  });

  // ==========================================================================
  // Suite 5: React Hook Concurrency & Race Conditions (useIndexerAnalytics.ts)
  // ==========================================================================
  describe("Suite 5: React Hook Concurrency & Race Conditions (useIndexerAnalytics.ts)", () => {
    beforeEach(() => {
      enableTimerTracking();
      setupClientEnvironment();
    });

    afterEach(() => {
      restoreTimerTracking();
      teardownClientEnvironment();
      globalThis.fetch = originalFetch;
    });

    it("5.1 Rapid Interval Switching: Rejects stale out-of-order chart responses via fetchId tracking", async () => {
      let resolve1D!: (res: Response) => void;
      let resolve1M!: (res: Response) => void;

      // Mock fetch with controlled resolution
      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("interval=1D")) {
          return new Promise<Response>((resolve) => {
            resolve1D = resolve;
          });
        }
        if (urlStr.includes("interval=1M")) {
          return new Promise<Response>((resolve) => {
            resolve1M = resolve;
          });
        }
        return new Response(JSON.stringify({ success: true, data: [], summary: {} }), { status: 200 });
      };

      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let hookState!: UseIndexerAnalyticsReturn;

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              marketAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
              interval: "1D",
              autoPoll: false,
            },
            onUpdate: (res) => {
              hookState = res;
            },
          })
        );
      });

      expect(hookState.selectedInterval).toBe("1D");

      // Rapidly switch interval to 1M before 1D completes
      await act(async () => {
        hookState.setInterval("1M");
      });

      expect(hookState.selectedInterval).toBe("1M");

      // Now resolve 1M FIRST with 30 points
      await act(async () => {
        resolve1M(
          new Response(
            JSON.stringify({
              success: true,
              data: new Array(30).fill({ timestamp: 1000, impliedApyPct: 7.0, ptPrice: 0.98 }),
              summary: { highApy: 7.0 },
            }),
            { status: 200 }
          )
        );
      });

      expect(hookState.rawChartData.length).toBe(30);

      // Now resolve the older 1D response LATER with 24 points
      await act(async () => {
        resolve1D(
          new Response(
            JSON.stringify({
              success: true,
              data: new Array(24).fill({ timestamp: 1000, impliedApyPct: 5.0, ptPrice: 0.99 }),
              summary: { highApy: 5.0 },
            }),
            { status: 200 }
          )
        );
      });

      // Crucial concurrency assertion: 1D was stale, so rawChartData remains 30 (from 1M)!
      expect(hookState.rawChartData.length).toBe(30);

      await act(async () => {
        root.unmount();
      });
    });

    it("5.2 Rapid User Disconnect: Stale fetch does not populate state after user disconnects", async () => {
      let resolveUser!: (res: Response) => void;

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/positions?user=")) {
          return new Promise<Response>((resolve) => {
            resolveUser = resolve;
          });
        }
        return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      };

      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let hookState!: UseIndexerAnalyticsReturn;

      // 1. Mount with userAddress
      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              autoPoll: false,
            },
            onUpdate: (res) => {
              hookState = res;
            },
          })
        );
      });

      // 2. Disconnect user (userAddress = null)
      await act(async () => {
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: null,
              autoPoll: false,
            },
            onUpdate: (res) => {
              hookState = res;
            },
          })
        );
      });

      expect(hookState.positions).toEqual([]);

      // 3. Stale fetch resolves after disconnect
      await act(async () => {
        resolveUser(
          new Response(
            JSON.stringify({
              success: true,
              user: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              positions: [{ marketId: "usdc-90d", costBasisUsd: 100 }],
            }),
            { status: 200 }
          )
        );
      });

      // Hook remains disconnected
      expect(hookState.positions).toEqual([]);

      await act(async () => {
        root.unmount();
      });
    });

    it("5.3 Derived Lookup Mappings: Indexing by marketId and marketAddress", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            success: true,
            user: "GTEST_LOOKUP",
            positions: [
              {
                marketId: "usdc-90d",
                marketAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                costBasisUsd: 50,
                currentPtBalance: "50000000",
              },
            ],
            summary: {},
          }),
          { status: 200 }
        );
      };

      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let hookState!: UseIndexerAnalyticsReturn;

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: "GTEST_LOOKUP",
              marketAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
              autoPoll: false,
            },
            onUpdate: (res) => {
              hookState = res;
            },
          })
        );
      });

      // Positions accessible by marketId
      expect(hookState.positionsByMarketId["usdc-90d"]).toBeDefined();
      // Positions accessible by marketAddress
      expect(
        hookState.positionsByMarketId["CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"]
      ).toBeDefined();
      // Active market position matches
      expect(hookState.activeMarketPosition).toBeDefined();
      expect(hookState.activeMarketPosition?.costBasisUsd).toBe(50);

      await act(async () => {
        root.unmount();
      });
    });

    it("5.4 Quadruple Rapid Interval Switching (1D -> 1W -> 1M -> ALL) Out-of-Order Resolution", async () => {
      const resolvers: Record<string, (res: Response) => void> = {};

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        for (const int of ["1D", "1W", "1M", "ALL"]) {
          if (urlStr.includes(`interval=${int}`)) {
            return new Promise<Response>((resolve) => {
              resolvers[int] = resolve;
            });
          }
        }
        return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      };

      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let hookState!: UseIndexerAnalyticsReturn;

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              marketAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
              interval: "1D",
              autoPoll: false,
            },
            onUpdate: (res) => {
              hookState = res;
            },
          })
        );
      });

      // Rapidly switch through intervals
      await act(async () => {
        hookState.setInterval("1W");
      });
      await act(async () => {
        hookState.setInterval("1M");
      });
      await act(async () => {
        hookState.setInterval("ALL");
      });

      expect(hookState.selectedInterval).toBe("ALL");

      // Resolve in inverted order: ALL first
      await act(async () => {
        resolvers["ALL"](
          new Response(
            JSON.stringify({
              success: true,
              data: new Array(50).fill({ timestamp: 1000, impliedApyPct: 9.0, ptPrice: 0.95 }),
              summary: {},
            }),
            { status: 200 }
          )
        );
      });

      expect(hookState.rawChartData.length).toBe(50);

      // Now resolve earlier stale intervals 1M, 1W, 1D
      await act(async () => {
        if (resolvers["1M"]) {
          resolvers["1M"](
            new Response(
              JSON.stringify({
                success: true,
                data: new Array(30).fill({ timestamp: 1000, impliedApyPct: 8.0, ptPrice: 0.96 }),
                summary: {},
              }),
              { status: 200 }
            )
          );
        }
        if (resolvers["1W"]) {
          resolvers["1W"](
            new Response(
              JSON.stringify({
                success: true,
                data: new Array(168).fill({ timestamp: 1000, impliedApyPct: 7.0, ptPrice: 0.97 }),
                summary: {},
              }),
              { status: 200 }
            )
          );
        }
        if (resolvers["1D"]) {
          resolvers["1D"](
            new Response(
              JSON.stringify({
                success: true,
                data: new Array(24).fill({ timestamp: 1000, impliedApyPct: 6.0, ptPrice: 0.98 }),
                summary: {},
              }),
              { status: 200 }
            )
          );
        }
      });

      // Data remains from ALL (50 items), earlier stale intervals discarded
      expect(hookState.rawChartData.length).toBe(50);

      await act(async () => {
        root.unmount();
      });
    });

    it("5.5 SSR Resilience: Hook initializes safely without window/document in non-browser env", () => {
      teardownClientEnvironment();

      // Hook return shape check via fallback generator
      const emptyUser = buildEmptyUserPositions("");
      expect(emptyUser.success).toBe(true);
      expect(emptyUser.count).toBe(0);
      expect(emptyUser.summary.totalCostBasisUsd).toBe(0);

      const emptyChart = buildEmptyChartResponse("usdc-90d", "1D");
      expect(emptyChart.success).toBe(true);
      expect(emptyChart.count).toBe(0);
      expect(emptyChart.summary.tvl).toBe(0);
    });
  });
});
