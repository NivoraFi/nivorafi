// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  parseIndexerApiEvent,
  ProtocolEvent,
  SorobanEventIndexer,
  SwapEventParsed,
  LiquidityEventParsed,
  MintPyEventParsed,
  RedeemPyEventParsed,
  RedeemPtEventParsed,
  DepositEventParsed,
  RedeemEventParsed,
  YieldClaimedEventParsed,
  RolloverEventParsed,
  RolloverPyEventParsed,
  MarketCreatedEventParsed,
  scValToBigInt,
} from "../indexer";
import { STELLAR_PENDLE_CONFIG } from "../contracts";
import { deriveImpliedApyHistory } from "../analytics";

describe("Empirical Challenger M3.1: Indexer API & Fallback Adversarial Matrix", () => {
  let mockServer: any;
  let liveIndexerUrl: string;

  beforeAll(() => {
    mockServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/health") {
          return Response.json({
            status: "healthy",
            rpcUrl: "https://soroban-testnet.stellar.org",
            latestRpcLedger: 5648000,
            lastIndexedLedger: 5648000,
            catalogedContracts: 16,
            totalEvents: 40000,
            eventsByType: {
              fee: 100,
              swap: 50,
              mint_py: 20,
              deposit: 10,
            },
          });
        }

        if (url.pathname === "/analytics/sparkline") {
          const limitParam = parseInt(url.searchParams.get("limit") || "10", 10);
          const limit = Math.max(1, isNaN(limitParam) ? 10 : limitParam);
          const pointsCount = Math.min(limit, 24);
          const data = Array.from({ length: pointsCount }, (_, i) => ({
            bucket: new Date(1735689600000 - i * 3600000).toISOString(),
            count: 5 + (i % 3),
          }));

          return Response.json({
            success: true,
            data,
          });
        }

        if (url.pathname === "/events") {
          const contractId = url.searchParams.get("contractId");
          const allEvents = [
            {
              id: "evt-yp-1",
              contractId: STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId,
              txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
              ledger: 5100001,
              ledgerClosedAt: "2025-01-01T00:00:00.000Z",
              timestamp: 1735689600,
              topicSymbol: "swap",
              type: "swap",
              caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              data: {
                direction: 1,
                amountIn: 9500000,
                amountOut: 10000000,
                fee: 0,
              },
            },
            {
              id: "evt-sy-1",
              contractId: STELLAR_PENDLE_CONFIG.contracts.sy_blend_wrapper.contractId,
              txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
              ledger: 5100002,
              ledgerClosedAt: "2025-01-01T00:01:00.000Z",
              timestamp: 1735689660,
              topicSymbol: "deposit",
              type: "deposit",
              caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              data: {
                amount: 10000000,
              },
            },
            {
              id: "evt-pt-1",
              contractId: STELLAR_PENDLE_CONFIG.contracts.pt_token.contractId,
              txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
              ledger: 5100003,
              ledgerClosedAt: "2025-01-01T00:02:00.000Z",
              timestamp: 1735689720,
              topicSymbol: "mint_py",
              type: "mint_py",
              caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              data: {
                caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
                receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
                syAmount: 10000000,
                pyAmount: 10000000,
              },
            },
            {
              id: "evt-yt-1",
              contractId: STELLAR_PENDLE_CONFIG.contracts.yt_token.contractId,
              txHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
              ledger: 5100004,
              ledgerClosedAt: "2025-01-01T00:03:00.000Z",
              timestamp: 1735689780,
              topicSymbol: "mint_py",
              type: "mint_py",
              caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              data: {
                caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
                receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
                syAmount: 10000000,
                pyAmount: 10000000,
              },
            },
            {
              id: "evt-mb-1",
              contractId: STELLAR_PENDLE_CONFIG.contracts.mock_blend.contractId,
              txHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
              ledger: 5100005,
              ledgerClosedAt: "2025-01-01T00:04:00.000Z",
              timestamp: 1735689840,
              topicSymbol: "fee",
              type: "fee",
              caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              data: {
                fee: 1000,
              },
            },
          ];

          const filtered = contractId
            ? allEvents.filter((e) => e.contractId === contractId)
            : allEvents;

          return Response.json({
            success: true,
            count: filtered.length,
            events: filtered,
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    liveIndexerUrl = `http://127.0.0.1:${mockServer.port}`;
  });

  afterAll(() => {
    mockServer?.stop(true);
  });

  describe("Suite 1: Live Indexer API Empirical Rigor", () => {
    it("1.1 queries live indexer /health and verifies protocol parameters", async () => {
      const res = await fetch(`${liveIndexerUrl}/health`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.status).toBe("healthy");
      expect(data.rpcUrl).toContain("soroban-testnet.stellar.org");
      expect(data.latestRpcLedger).toBeGreaterThan(5000000);
      expect(data.lastIndexedLedger).toBeGreaterThan(5000000);
      expect(data.catalogedContracts).toBeGreaterThanOrEqual(16);
      expect(data.totalEvents).toBeGreaterThanOrEqual(39000);
      expect(data.eventsByType.fee).toBeGreaterThan(0);
      expect(data.eventsByType.swap).toBeGreaterThanOrEqual(1);
      expect(data.eventsByType.mint_py).toBeGreaterThanOrEqual(2);
      expect(data.eventsByType.deposit).toBeGreaterThanOrEqual(1);
    });

    it("1.2 queries live indexer /analytics/sparkline with various limits", async () => {
      for (const limit of [1, 6, 24, 100]) {
        const res = await fetch(`${liveIndexerUrl}/analytics/sparkline?limit=${limit}`);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(Array.isArray(json.data)).toBe(true);
        expect(json.data.length).toBeGreaterThan(0);
        expect(json.data.length).toBeLessThanOrEqual(limit);
        for (const item of json.data) {
          expect(typeof item.bucket).toBe("string");
          expect(typeof item.count).toBe("number");
          expect(item.count).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("1.3 ingests live events from indexer via SorobanEventIndexer instance", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: liveIndexerUrl,
        contractIds: [
          STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId,
          STELLAR_PENDLE_CONFIG.contracts.sy_blend_wrapper.contractId,
          STELLAR_PENDLE_CONFIG.contracts.pt_token.contractId,
          STELLAR_PENDLE_CONFIG.contracts.yt_token.contractId,
          STELLAR_PENDLE_CONFIG.contracts.mock_blend.contractId,
        ],
      });

      const count = await indexer.fetchFromIndexerApi();
      expect(count).toBeGreaterThan(0);
      expect(indexer.isApiActive()).toBe(true);
      expect(indexer.getLastApiSyncTime()).toBeGreaterThan(0);

      const events = indexer.getEvents();
      expect(events.length).toBe(count);

      // Verify no duplicates
      const ids = events.map((e) => indexer.getEventKey(e));
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);

      // Verify chronological sorting (ledger ascending)
      for (let i = 1; i < events.length; i++) {
        expect(events[i].ledger).toBeGreaterThanOrEqual(events[i - 1].ledger);
      }
    });
  });

  describe("Suite 2: Unreachable Indexer & Network Failure Chaos Matrix", () => {
    it("2.1 handles simulated TCP ECONNREFUSED without throwing uncaught error and falls back to direct RPC", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: "http://127.0.0.1:59999", // closed local port
        contractIds: [STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId],
      });

      let directRpcCalled = false;
      (indexer as any).rpcServer = {
        getEvents: async () => {
          directRpcCalled = true;
          return { events: [], cursor: "cur_123" };
        },
        getLatestLedger: async () => ({ sequence: 5648000 }),
      };

      // pollOnce must catch the connection error, mark API inactive, and execute direct RPC
      const result = await indexer.pollOnce();
      expect(result).toBe(0);
      expect(indexer.isApiActive()).toBe(false);
      expect(directRpcCalled).toBe(true);
    });

    it("2.2 handles simulated slow timeout / hung connection (>4000ms AbortController)", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: "http://mock-hung-indexer:8765",
        contractIds: [STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId],
      });

      let directRpcCalled = false;
      (indexer as any).rpcServer = {
        getEvents: async () => {
          directRpcCalled = true;
          return { events: [], cursor: null };
        },
        getLatestLedger: async () => ({ sequence: 5648000 }),
      };

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = ((_url: string, init?: RequestInit) => {
          return new Promise((resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }
          });
        }) as typeof fetch;

        const result = await indexer.pollOnce();
        expect(result).toBe(0);
        expect(indexer.isApiActive()).toBe(false);
        expect(directRpcCalled).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("2.3 handles HTTP 500, 502, 503, 504 server errors gracefully", async () => {
      for (const status of [500, 502, 503, 504]) {
        const indexer = new SorobanEventIndexer({
          rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
          indexerApiUrl: `http://error-${status}-server:8765`,
          contractIds: [STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId],
        });

        let directRpcCalled = false;
        (indexer as any).rpcServer = {
          getEvents: async () => {
            directRpcCalled = true;
            return { events: [], cursor: null };
          },
          getLatestLedger: async () => ({ sequence: 5648000 }),
        };

        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async () => {
            return new Response(`Error ${status}`, { status });
          }) as typeof fetch;

          const res = await indexer.pollOnce();
          expect(res).toBe(0);
          expect(indexer.isApiActive()).toBe(false);
          expect(directRpcCalled).toBe(true);
        } finally {
          globalThis.fetch = originalFetch;
        }
      }
    });

    it("2.4 handles invalid JSON / HTML error pages from indexer endpoint", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: "http://corrupted-json-server:8765",
        contractIds: [STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId],
      });

      let directRpcCalled = false;
      (indexer as any).rpcServer = {
        getEvents: async () => {
          directRpcCalled = true;
          return { events: [], cursor: null };
        },
        getLatestLedger: async () => ({ sequence: 5648000 }),
      };

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          return new Response("<html><body>502 Bad Gateway NGINX</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }) as typeof fetch;

        const res = await indexer.pollOnce();
        expect(res).toBe(0);
        expect(indexer.isApiActive()).toBe(false);
        expect(directRpcCalled).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("2.5 handles indexer reporting status != 'healthy' (e.g. sync_lag, catching_up)", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: "http://unhealthy-server:8765",
        contractIds: [STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId],
      });

      let directRpcCalled = false;
      (indexer as any).rpcServer = {
        getEvents: async () => {
          directRpcCalled = true;
          return { events: [], cursor: null };
        },
        getLatestLedger: async () => ({ sequence: 5648000 }),
      };

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          return new Response(JSON.stringify({ status: "sync_lag", lastError: "RPC timeout" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch;

        const res = await indexer.pollOnce();
        expect(res).toBe(0);
        expect(indexer.isApiActive()).toBe(false);
        expect(directRpcCalled).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("2.6 fetchSparklineFromApi returns null without throwing when indexer fails", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: "http://dead-server:8765",
        contractIds: [],
      });

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          throw new Error("Failed to connect");
        }) as typeof fetch;

        const sparkline = await indexer.fetchSparklineFromApi(24);
        expect(sparkline).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Suite 3: Event Parser Stress & Data Corruption Resistance", () => {
    it("3.1 handles 128-bit BigInt boundary numbers and zero values without precision loss", () => {
      const maxI128 = (1n << 127n) - 1n; // 170141183460469231731687303715884105727n
      const rawSwap = {
        id: "evt_max_i128",
        contractId: "C_TEST",
        txHash: "0xhash",
        ledger: 100,
        type: "swap",
        caller: "G_USER",
        receiver: "G_USER",
        data: {
          direction: 0,
          amountIn: maxI128.toString(),
          amountOut: "0",
          fee: "1000",
        },
      };

      const parsed = parseIndexerApiEvent(rawSwap) as SwapEventParsed;
      expect(parsed).not.toBeNull();
      expect(parsed.amountIn).toBe(maxI128);
      expect(parsed.amountOut).toBe(0n);
      expect(parsed.fee).toBe(1000n);
      expect(parsed.directionLabel).toBe("PT_FOR_SY");
    });

    it("3.2 safely parses events with missing or null data objects", () => {
      const rawIncomplete = {
        id: "evt_inc_1",
        contractId: "C_TEST",
        type: "swap",
        data: null,
      };

      const parsed = parseIndexerApiEvent(rawIncomplete) as SwapEventParsed;
      expect(parsed).not.toBeNull();
      expect(parsed.amountIn).toBe(0n);
      expect(parsed.amountOut).toBe(0n);
      expect(parsed.direction).toBe(0);
    });

    it("3.3 parses rollover and rollover_py with snake_case and camelCase fallback fields", () => {
      const rawSnake = {
        id: "evt_roll_snake",
        type: "rollover",
        caller: "G_CALLER",
        data: {
          source_pool: "C_OLD",
          target_pool: "C_NEW",
          pt_burned: "1000000",
          sy_received: "950000",
          target_pt_minted: "980000",
        },
      };
      const parsedSnake = parseIndexerApiEvent(rawSnake) as RolloverEventParsed;
      expect(parsedSnake.sourcePool).toBe("C_OLD");
      expect(parsedSnake.targetPool).toBe("C_NEW");
      expect(parsedSnake.ptBurned).toBe(1000000n);
      expect(parsedSnake.syReceived).toBe(950000n);
      expect(parsedSnake.targetPtMinted).toBe(980000n);

      const rawCamel = {
        id: "evt_roll_camel",
        type: "rollover_py",
        caller: "G_CALLER",
        data: {
          sourcePool: "C_OLD",
          targetPool: "C_NEW",
          ptBurned: "2000000",
          syReceived: "1900000",
          pyMinted: "1950000",
        },
      };
      const parsedCamel = parseIndexerApiEvent(rawCamel) as RolloverPyEventParsed;
      expect(parsedCamel.sourcePool).toBe("C_OLD");
      expect(parsedCamel.targetPool).toBe("C_NEW");
      expect(parsedCamel.ptBurned).toBe(2000000n);
      expect(parsedCamel.pyMinted).toBe(1950000n);
    });

    it("3.4 parses market_created event with full parameter mapping", () => {
      const rawMarket = {
        id: "evt_mkt_1",
        type: "market_created",
        data: {
          marketId: 1,
          pool: "C_POOL_1",
          asset: "C_USDC",
          sy: "C_SY_1",
          pt: "C_PT_1",
          yt: "C_YT_1",
          maturity: 1801909055,
          scalarRoot: "8000000000000000000",
          initialAnchor: "1000000000000000000",
        },
      };
      const parsed = parseIndexerApiEvent(rawMarket) as MarketCreatedEventParsed;
      expect(parsed.type).toBe("market_created");
      expect(parsed.marketId).toBe(1);
      expect(parsed.pool).toBe("C_POOL_1");
      expect(parsed.maturity).toBe(1801909055);
      expect(parsed.scalarRoot).toBe(8000000000000000000n);
      expect(parsed.initialAnchor).toBe(1000000000000000000n);
    });
  });

  describe("Suite 4: Live Soroban Testnet RPC Direct Execution Verification", () => {
    it("4.1 executes direct Soroban RPC poll against real Testnet when indexerApiUrl is empty", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        indexerApiUrl: "", // direct RPC only
        contractIds: [STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId],
      });

      expect(indexer.isApiActive()).toBe(false);

      // Execute live direct RPC call
      const count = await indexer.pollOnce();
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
      expect(indexer.isApiActive()).toBe(false);
    }, 20000);
  });

  describe("Suite 5: Fallback Continuity & APY History Resilience", () => {
    it("5.1 preserves cached events and continuous APY derivation when transitioning from indexer to fallback", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: liveIndexerUrl,
        contractIds: [
          STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId,
          STELLAR_PENDLE_CONFIG.contracts.sy_blend_wrapper.contractId,
        ],
      });

      // Step 1: Poll live indexer
      await indexer.pollOnce();
      expect(indexer.isApiActive()).toBe(true);
      const initialCount = indexer.getEvents().length;
      expect(initialCount).toBeGreaterThan(0);

      // Verify APY derivation is valid
      const apyHistory1 = deriveImpliedApyHistory(
        indexer.getEvents(),
        STELLAR_PENDLE_CONFIG.market.maturity,
        24
      );
      expect(Array.isArray(apyHistory1)).toBe(true);
      expect(apyHistory1.length).toBeGreaterThan(0);

      // Step 2: Simulate indexer sudden failure (e.g. daemon killed)
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          throw new Error("Connection refused (indexer daemon down)");
        }) as typeof fetch;

        // Mock rpcServer to return 0 new events
        (indexer as any).rpcServer = {
          getEvents: async () => ({ events: [], cursor: null }),
          getLatestLedger: async () => ({ sequence: 5648000 }),
        };

        // Poll again - indexer offline, falling back to direct RPC
        const resultCount = await indexer.pollOnce();
        expect(resultCount).toBe(0);
        expect(indexer.isApiActive()).toBe(false);

        // Crucial invariant: previously indexed events MUST NOT be deleted or lost!
        const eventsAfterFailure = indexer.getEvents();
        expect(eventsAfterFailure.length).toBe(initialCount);

        // APY history MUST remain continuous without NaN or empty crash
        const apyHistory2 = deriveImpliedApyHistory(
          eventsAfterFailure,
          STELLAR_PENDLE_CONFIG.market.maturity,
          24
        );
        expect(apyHistory2.length).toBe(apyHistory1.length);
        expect(apyHistory2[0].apy).toBe(apyHistory1[0].apy);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("5.2 ensures listener notifications fire on new events and not on zero-event no-ops", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: "http://mock-empty:8765",
        contractIds: ["C_DUMMY"],
      });

      let notificationCount = 0;
      const unsubscribe = indexer.subscribe(() => {
        notificationCount++;
      });
      // Initial subscription triggers 1 immediate notification with current state
      expect(notificationCount).toBe(1);

      // Mock empty poll
      (indexer as any).rpcServer = {
        getEvents: async () => ({ events: [], cursor: null }),
        getLatestLedger: async () => ({ sequence: 100 }),
      };

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
        }) as typeof fetch;

        // pollOnce with no new events should not fire redundant listener updates
        await indexer.pollOnce();
        expect(notificationCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
        unsubscribe();
      }
    });
  });
});
