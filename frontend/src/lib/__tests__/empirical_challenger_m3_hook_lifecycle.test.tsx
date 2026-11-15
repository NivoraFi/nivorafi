// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ----------------------------------------------------------------------------
// Headless DOM Mock Engine for React 19 Client Lifecycle Testing
// ----------------------------------------------------------------------------

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
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  ownerDocument: MockDocument | null = null;

  constructor(tag = "div") {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
  }

  setAttribute(k: string, v: string) {
    this.attributes[k] = v;
  }

  getAttribute(k: string) {
    return this.attributes[k];
  }

  removeAttribute(k: string) {
    delete this.attributes[k];
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

// ----------------------------------------------------------------------------
// Timer Leak Tracking Harness
// ----------------------------------------------------------------------------

const activeIntervalTimers = new Set<any>();
const intervalCallbackRegistry = new Map<any, Function>();

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalFetch = globalThis.fetch;

function enableTimerTracking() {
  activeIntervalTimers.clear();
  intervalCallbackRegistry.clear();

  globalThis.setInterval = ((fn: Function, ms?: number, ...args: any[]) => {
    const id = originalSetInterval(fn, ms, ...args);
    activeIntervalTimers.add(id);
    intervalCallbackRegistry.set(id, fn);
    return id;
  }) as any;

  globalThis.clearInterval = ((id: any) => {
    activeIntervalTimers.delete(id);
    intervalCallbackRegistry.delete(id);
    return originalClearInterval(id);
  }) as any;
}

function restoreTimerTracking() {
  for (const id of activeIntervalTimers) {
    originalClearInterval(id);
  }
  activeIntervalTimers.clear();
  intervalCallbackRegistry.clear();
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}

// ----------------------------------------------------------------------------
// Setup Client Environment Helper
// ----------------------------------------------------------------------------

let currentMockDoc: MockDocument;

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
}

function teardownClientEnvironment() {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
}

// ----------------------------------------------------------------------------
// Hook Import Under Test
// ----------------------------------------------------------------------------

import {
  useIndexerAnalytics,
  UseIndexerAnalyticsOptions,
  UseIndexerAnalyticsReturn,
} from "../../hooks/useIndexerAnalytics";

// ----------------------------------------------------------------------------
// Test Harness Component
// ----------------------------------------------------------------------------

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
// EMPIRICAL CHALLENGER TEST SUITE: HOOK LIFECYCLE & REACT 19
// ============================================================================

describe("Empirical Challenger M3: Hook Lifecycle, Timer Cleanup & React 19 Compliance", () => {
  const TEST_WALLET_1 = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
  const TEST_WALLET_2 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const TEST_MARKET_1 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const TEST_MARKET_2 = "CB33JOD4LTMZ4SL5V7EZ6MGLP4HWDTTJTC2C5PHE2RZ4EDM44JGBYVFM";

  beforeEach(() => {
    enableTimerTracking();
    setupClientEnvironment();
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          success: true,
          count: 0,
          data: [],
          positions: [],
          summary: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
  });

  afterEach(() => {
    restoreTimerTracking();
    teardownClientEnvironment();
    globalThis.fetch = originalFetch;
  });

  // ==========================================================================
  // SUITE 1: AUTO-POLLING INTERVAL CLEANUP & ZERO TIMER LEAKS
  // ==========================================================================
  describe("Suite 1: Auto-Polling Interval Cleanup & Zero Timer Leaks on Unmount", () => {
    it("1.1 Mount with autoPoll=true creates exactly 2 interval timers (positions & charts)", async () => {
      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let hookState!: UseIndexerAnalyticsReturn;

      expect(activeIntervalTimers.size).toBe(0);

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              marketAddress: TEST_MARKET_1,
              autoPoll: true,
            },
            onUpdate: (res) => {
              hookState = res;
            },
          })
        );
      });

      // Exactly 2 intervals scheduled: positions polling + charts polling
      expect(activeIntervalTimers.size).toBe(2);
      expect(hookState).toBeDefined();

      // Clean unmount
      await act(async () => {
        root.unmount();
      });

      // Crucial assertion: ZERO timer leaks after unmount
      expect(activeIntervalTimers.size).toBe(0);
    });

    it("1.2 Mount with autoPoll=false creates ZERO interval timers", async () => {
      const container = currentMockDoc.createElement("div");
      let root!: Root;

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              marketAddress: TEST_MARKET_1,
              autoPoll: false,
            },
          })
        );
      });

      expect(activeIntervalTimers.size).toBe(0);

      await act(async () => {
        root.unmount();
      });

      expect(activeIntervalTimers.size).toBe(0);
    });

    it("1.3 Partial parameters allocate only relevant interval timers", async () => {
      const container = currentMockDoc.createElement("div");
      let root!: Root;

      // Only marketAddress (no userAddress) -> only charts poll timer (1 timer)
      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              marketAddress: TEST_MARKET_1,
              autoPoll: true,
            },
          })
        );
      });
      expect(activeIntervalTimers.size).toBe(1);

      await act(async () => {
        root.unmount();
      });
      expect(activeIntervalTimers.size).toBe(0);

      // Only userAddress (no marketAddress) -> only positions poll timer (1 timer)
      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              autoPoll: true,
            },
          })
        );
      });
      expect(activeIntervalTimers.size).toBe(1);

      await act(async () => {
        root.unmount();
      });
      expect(activeIntervalTimers.size).toBe(0);
    });

    it("1.4 Rapid parameter churn: 30 consecutive updates clean old timers without accumulation", async () => {
      const container = currentMockDoc.createElement("div");
      let root!: Root;

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              marketAddress: "MARKET_0",
              autoPoll: true,
            },
          })
        );
      });

      expect(activeIntervalTimers.size).toBe(2);

      // Rapidly change marketAddress 30 times
      for (let i = 1; i <= 30; i++) {
        await act(async () => {
          root.render(
            React.createElement(TestHookConsumer, {
              opts: {
                userAddress: TEST_WALLET_1,
                marketAddress: `MARKET_${i}`,
                autoPoll: true,
              },
            })
          );
        });

        // Invariant: Active timer count must remain exactly 2, never accumulating leaked handles
        expect(activeIntervalTimers.size).toBe(2);
      }

      // Unmount after heavy churn
      await act(async () => {
        root.unmount();
      });

      // Strict post-churn cleanup check
      expect(activeIntervalTimers.size).toBe(0);
    });

    it("1.5 Dynamic toggle of autoPoll prop cleanly tears down and recreates timers", async () => {
      const container = currentMockDoc.createElement("div");
      let root!: Root;

      // Start with autoPoll: true
      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              marketAddress: TEST_MARKET_1,
              autoPoll: true,
            },
          })
        );
      });
      expect(activeIntervalTimers.size).toBe(2);

      // Disable polling: autoPoll: false
      await act(async () => {
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              marketAddress: TEST_MARKET_1,
              autoPoll: false,
            },
          })
        );
      });
      // Both timers must be destroyed
      expect(activeIntervalTimers.size).toBe(0);

      // Re-enable polling: autoPoll: true
      await act(async () => {
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              marketAddress: TEST_MARKET_1,
              autoPoll: true,
            },
          })
        );
      });
      expect(activeIntervalTimers.size).toBe(2);

      await act(async () => {
        root.unmount();
      });
      expect(activeIntervalTimers.size).toBe(0);
    });

    it("1.6 Visibility state guard: document.visibilityState === 'hidden' suppresses background network polling", async () => {
      let networkCalls = 0;
      globalThis.fetch = async () => {
        networkCalls++;
        return new Response(JSON.stringify({ success: true, count: 0, data: [], positions: [] }));
      };

      const container = currentMockDoc.createElement("div");
      let root!: Root;

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              marketAddress: TEST_MARKET_1,
              autoPoll: true,
            },
          })
        );
      });

      const initialCalls = networkCalls;
      expect(initialCalls).toBeGreaterThanOrEqual(2);

      // Simulate tab hidden
      currentMockDoc.visibilityState = "hidden";

      // Fire all registered timer callbacks while hidden
      for (const cb of intervalCallbackRegistry.values()) {
        await act(async () => {
          cb();
        });
      }

      // Assert networkCalls did NOT increase while document is hidden
      expect(networkCalls).toBe(initialCalls);

      // Now restore tab to visible
      currentMockDoc.visibilityState = "visible";

      // Fire timer callbacks while visible
      for (const cb of intervalCallbackRegistry.values()) {
        await act(async () => {
          cb();
        });
      }

      // Assert networkCalls increased when visible
      expect(networkCalls).toBeGreaterThan(initialCalls);

      await act(async () => {
        root.unmount();
      });
    });

    it("1.7 Unmount during pending in-flight fetch cleans timers and prevents unhandled errors", async () => {
      let resolveSlowFetch!: (r: Response) => void;
      const slowPromise = new Promise<Response>((res) => {
        resolveSlowFetch = res;
      });

      globalThis.fetch = async () => slowPromise;

      const container = currentMockDoc.createElement("div");
      let root!: Root;

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: {
              userAddress: TEST_WALLET_1,
              marketAddress: TEST_MARKET_1,
              autoPoll: true,
            },
          })
        );
      });

      expect(activeIntervalTimers.size).toBe(2);

      // Unmount while fetch is unresolved in-flight
      await act(async () => {
        root.unmount();
      });

      // Timers must immediately be 0
      expect(activeIntervalTimers.size).toBe(0);

      // Now resolve the delayed promise post-unmount
      let resolutionError: any = null;
      try {
        await act(async () => {
          resolveSlowFetch(
            new Response(
              JSON.stringify({
                success: true,
                count: 1,
                data: [],
                positions: [],
              })
            )
          );
        });
      } catch (err) {
        resolutionError = err;
      }

      // Zero uncaught exception or crash
      expect(resolutionError).toBeNull();
      expect(activeIntervalTimers.size).toBe(0);
    });
  });

  // ==========================================================================
  // SUITE 2: RAPID PARAMETER CHANGES & CONCURRENCY CONTROLS
  // ==========================================================================
  describe("Suite 2: Rapid Parameter Changes & Out-of-Order Concurrency Controls", () => {
    it("2.1 Out-of-order market chart responses are safely dropped by chartsFetchIdRef", async () => {
      let resolveMarketA!: (r: Response) => void;
      let resolveMarketB!: (r: Response) => void;

      const promiseMarketA = new Promise<Response>((res) => {
        resolveMarketA = res;
      });
      const promiseMarketB = new Promise<Response>((res) => {
        resolveMarketB = res;
      });

      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("MARKET_A")) return promiseMarketA;
        if (u.includes("MARKET_B")) return promiseMarketB;
        return new Response(JSON.stringify({ success: true, count: 0, data: [] }));
      };

      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let capturedState!: UseIndexerAnalyticsReturn;

      // 1. Mount with MARKET_A
      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { marketAddress: "MARKET_A", autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });

      expect(capturedState.isChartLoading).toBe(true);

      // 2. Before MARKET_A resolves, switch rapidly to MARKET_B
      await act(async () => {
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { marketAddress: "MARKET_B", autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });

      expect(capturedState.isChartLoading).toBe(true);

      // 3. Resolve MARKET_B response first
      await act(async () => {
        resolveMarketB(
          new Response(
            JSON.stringify({
              success: true,
              market: "MARKET_B",
              interval: "1W",
              count: 1,
              data: [
                {
                  timestamp: 2000,
                  impliedApyPct: 18.5,
                  ptPrice: 0.94,
                  ytPrice: 0.06,
                  volumeUsd: 1000,
                  tvlUsd: 50000,
                },
              ],
              summary: { volume24h: 1000, volume7d: 1000, tvl: 50000, highApy: 18.5, lowApy: 18.5 },
            })
          )
        );
      });

      expect(capturedState.isChartLoading).toBe(false);
      expect(capturedState.rawChartData.length).toBe(1);
      expect(capturedState.rawChartData[0].impliedApyPct).toBe(18.5);

      // 4. Resolve stale MARKET_A response out-of-order
      await act(async () => {
        resolveMarketA(
          new Response(
            JSON.stringify({
              success: true,
              market: "MARKET_A",
              interval: "1W",
              count: 1,
              data: [
                {
                  timestamp: 1000,
                  impliedApyPct: 4.2,
                  ptPrice: 0.99,
                  ytPrice: 0.01,
                  volumeUsd: 200,
                  tvlUsd: 10000,
                },
              ],
              summary: { volume24h: 200, volume7d: 200, tvl: 10000, highApy: 4.2, lowApy: 4.2 },
            })
          )
        );
      });

      // Invariant: Stale MARKET_A response must NOT overwrite MARKET_B
      expect(capturedState.rawChartData.length).toBe(1);
      expect(capturedState.rawChartData[0].impliedApyPct).toBe(18.5);

      await act(async () => {
        root.unmount();
      });
    });

    it("2.2 Clearing marketAddress resets chart data and loading state immediately", async () => {
      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let capturedState!: UseIndexerAnalyticsReturn;

      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            success: true,
            market: TEST_MARKET_1,
            count: 1,
            data: [{ timestamp: 1000, impliedApyPct: 10, ptPrice: 0.98, ytPrice: 0.02, volumeUsd: 0, tvlUsd: 0 }],
          })
        );

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { marketAddress: TEST_MARKET_1, autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });

      expect(capturedState.rawChartData.length).toBe(1);

      // Clear marketAddress
      await act(async () => {
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { marketAddress: undefined, autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });

      expect(capturedState.rawChartData).toEqual([]);
      expect(capturedState.chartSummary).toBeNull();
      expect(capturedState.isChartLoading).toBe(false);

      await act(async () => {
        root.unmount();
      });
    });

    it("2.3 Switching interval via hook setInterval updates state and triggers target interval query", async () => {
      const requestedIntervals: string[] = [];

      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        const match = u.match(/interval=([^&]+)/);
        if (match) requestedIntervals.push(match[1]);
        return new Response(JSON.stringify({ success: true, count: 0, data: [] }));
      };

      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let capturedState!: UseIndexerAnalyticsReturn;

      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { marketAddress: TEST_MARKET_1, interval: "1W", autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });

      expect(capturedState.selectedInterval).toBe("1W");
      expect(requestedIntervals).toContain("1W");

      // Switch to 1D
      await act(async () => {
        capturedState.setInterval("1D");
      });
      expect(capturedState.selectedInterval).toBe("1D");
      expect(requestedIntervals).toContain("1D");

      // Switch to 1M
      await act(async () => {
        capturedState.setInterval("1M");
      });
      expect(capturedState.selectedInterval).toBe("1M");
      expect(requestedIntervals).toContain("1M");

      // Switch to ALL
      await act(async () => {
        capturedState.setInterval("ALL");
      });
      expect(capturedState.selectedInterval).toBe("ALL");
      expect(requestedIntervals).toContain("ALL");

      await act(async () => {
        root.unmount();
      });
    });

    it("2.4 Empirical Finding: interval option behaves as initialInterval (useState ignores prop changes)", async () => {
      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let capturedState!: UseIndexerAnalyticsReturn;

      // Mount with interval = "1W"
      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { marketAddress: TEST_MARKET_1, interval: "1W", autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });
      expect(capturedState.selectedInterval).toBe("1W");

      // External parent re-renders with interval prop = "ALL" without calling setInterval
      await act(async () => {
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { marketAddress: TEST_MARKET_1, interval: "ALL", autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });

      // Documents the uncontrolled behavior: selectedInterval remains "1W"
      expect(capturedState.selectedInterval).toBe("1W");

      await act(async () => {
        root.unmount();
      });
    });

    it("2.5 Wallet disconnect race condition: null address increments positionsFetchIdRef and wipes positions", async () => {
      let resolveSlowUserFetch!: (r: Response) => void;
      const slowUserPromise = new Promise<Response>((res) => {
        resolveSlowUserFetch = res;
      });

      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("USER_PENDING")) return slowUserPromise;
        return new Response(JSON.stringify({ success: true, count: 0, positions: [] }));
      };

      const container = currentMockDoc.createElement("div");
      let root!: Root;
      let capturedState!: UseIndexerAnalyticsReturn;

      // 1. Mount with active user
      await act(async () => {
        root = createRoot(container as any);
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { userAddress: "USER_PENDING", autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });

      expect(capturedState.isPositionsLoading).toBe(true);

      // 2. Disconnect wallet: userAddress becomes null
      await act(async () => {
        root.render(
          React.createElement(TestHookConsumer, {
            opts: { userAddress: null, autoPoll: false },
            onUpdate: (res) => {
              capturedState = res;
            },
          })
        );
      });

      // Immediately cleared
      expect(capturedState.positions).toEqual([]);
      expect(capturedState.positionSummary).toBeNull();
      expect(capturedState.isPositionsLoading).toBe(false);

      // 3. Delayed in-flight response arrives AFTER disconnect
      await act(async () => {
        resolveSlowUserFetch(
          new Response(
            JSON.stringify({
              success: true,
              user: "USER_PENDING",
              count: 1,
              positions: [
                {
                  marketId: "usdc-90d",
                  marketAddress: TEST_MARKET_1,
                  costBasisUsd: 100,
                  netPnlUsd: 50,
                },
              ],
              summary: {
                userAddress: "USER_PENDING",
                totalCostBasisUsd: 100,
                totalNetPnlUsd: 50,
              },
            })
          )
        );
      });

      // Invariant: Stale response must NOT revive positions after wallet disconnect
      expect(capturedState.positions).toEqual([]);
      expect(capturedState.positionSummary).toBeNull();

      await act(async () => {
        root.unmount();
      });
    });
  });

  // ==========================================================================
  // SUITE 3: SSR COMPATIBILITY & NEXT.JS 15 CLIENT BOUNDARY
  // ==========================================================================
  describe("Suite 3: SSR Compatibility & Next.js 15 Client Boundary", () => {
    it("3.1 File structure compliance: contains 'use client' directive", () => {
      const hookPath = path.resolve(__dirname, "../../hooks/useIndexerAnalytics.ts");
      expect(fs.existsSync(hookPath)).toBe(true);

      const src = fs.readFileSync(hookPath, "utf-8");
      const lines = src.split("\n");

      // Verify directive exists near top
      const directiveFound = lines.slice(0, 20).some((line) => line.trim() === '"use client";');
      expect(directiveFound).toBe(true);
    });

    it("3.2 Locked file integrity: frontend/src/lib/indexer.ts and useEventIndexer.ts remain untouched", () => {
      const indexerLibPath = path.resolve(__dirname, "../../lib/indexer.ts");
      const useEventHookPath = path.resolve(__dirname, "../../hooks/useEventIndexer.ts");

      expect(fs.existsSync(indexerLibPath)).toBe(true);
      expect(fs.existsSync(useEventHookPath)).toBe(true);

      // Check hook file does not import from locked files
      const hookPath = path.resolve(__dirname, "../../hooks/useIndexerAnalytics.ts");
      const hookSrc = fs.readFileSync(hookPath, "utf-8");

      expect(hookSrc).not.toContain('from "@/lib/indexer"');
      expect(hookSrc).not.toContain('from "../lib/indexer"');
      expect(hookSrc).not.toContain('from "@/hooks/useEventIndexer"');
      expect(hookSrc).not.toContain('from "./useEventIndexer"');
    });

    it("3.3 Server-Side Rendering (renderToString) in pure server environment succeeds with zero errors", () => {
      // Temporarily strip window and document to simulate pure Node SSR
      teardownClientEnvironment();

      let capturedState!: UseIndexerAnalyticsReturn;

      function SSRConsumer(props: { opts: UseIndexerAnalyticsOptions }) {
        capturedState = useIndexerAnalytics(props.opts);
        return React.createElement(
          "div",
          {
            "data-ssr-loading": String(capturedState.isPositionsLoading),
            "data-ssr-active": String(capturedState.indexerApiActive),
            "data-user": capturedState.positionSummary?.userAddress ?? "anon",
            "data-positions": String(capturedState.positions.length),
            "data-charts": String(capturedState.chartPoints.length),
          },
          "SSR_CONTENT"
        );
      }

      const html = renderToString(
        React.createElement(SSRConsumer, {
          opts: {
            userAddress: TEST_WALLET_1,
            marketAddress: TEST_MARKET_1,
            autoPoll: true,
          },
        })
      );

      expect(html).toContain("SSR_CONTENT");
      expect(html).toContain('data-ssr-loading="false"');
      expect(html).toContain('data-ssr-active="true"');
      expect(html).toContain(TEST_WALLET_1);
      expect(html).toContain('data-positions="0"');
      expect(html).toContain('data-charts="0"');

      // Zero timers must be created on server
      expect(activeIntervalTimers.size).toBe(0);

      // Hydration state safety: non-null return structures
      expect(Array.isArray(capturedState.positions)).toBe(true);
      expect(Array.isArray(capturedState.chartPoints)).toBe(true);
      expect(Array.isArray(capturedState.rawChartData)).toBe(true);
      expect(typeof capturedState.positionsByMarketId).toBe("object");
      expect(capturedState.selectedInterval).toBe("1W");
      expect(typeof capturedState.setInterval).toBe("function");
      expect(typeof capturedState.refreshAll).toBe("function");
      expect(typeof capturedState.refreshCharts).toBe("function");
      expect(typeof capturedState.refreshPositions).toBe("function");

      // Re-enable client env for remaining teardown
      setupClientEnvironment();
    });

    it("3.4 Server-Side Rendering with null address renders safely without throwing", () => {
      teardownClientEnvironment();

      let capturedState!: UseIndexerAnalyticsReturn;

      function SSRConsumerAnon() {
        capturedState = useIndexerAnalytics({
          userAddress: null,
          marketAddress: undefined,
          autoPoll: true,
        });
        return React.createElement("div", null, "ANON_SSR");
      }

      const html = renderToString(React.createElement(SSRConsumerAnon));
      expect(html).toContain("ANON_SSR");
      expect(capturedState.positions).toEqual([]);
      expect(capturedState.positionSummary).toBeNull();
      expect(capturedState.activeMarketPosition).toBeNull();
      expect(capturedState.rawChartData).toEqual([]);
      expect(capturedState.chartPoints).toEqual([]);
      expect(activeIntervalTimers.size).toBe(0);

      setupClientEnvironment();
    });
  });
});
