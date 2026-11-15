// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { ENV } from "../env";
import { STELLAR_PENDLE_CONFIG } from "../contracts";
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
} from "../indexer";
import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET } from "../../app/api/indexer/[...path]/route";

describe("Windows Indexer API Integration & Graceful Fallback Suite", () => {
  describe("1. Environment & Configuration Wiring", () => {
    it("supports NEXT_PUBLIC_INDEXER_API_URL in ENV defaulting to /api/indexer and never contains trycloudflare.com", () => {
      expect(ENV.indexerApiUrl).toBeDefined();
      expect(typeof ENV.indexerApiUrl).toBe("string");
      expect(ENV.indexerApiUrl).toBe("/api/indexer");
      expect(ENV.indexerApiUrl).not.toContain("trycloudflare.com");

      // Verify tracked env.ts defaults to /api/indexer and contains zero trycloudflare references
      const envSource = readFileSync(join(process.cwd(), "src/lib/env.ts"), "utf-8");
      expect(envSource).not.toContain("trycloudflare.com");
      expect(envSource).toContain('"/api/indexer"');
    });

    it("exposes indexerApiUrl in STELLAR_PENDLE_CONFIG matching ENV", () => {
      expect(STELLAR_PENDLE_CONFIG.indexerApiUrl).toBe(ENV.indexerApiUrl);
      expect(STELLAR_PENDLE_CONFIG.indexerApiUrl).not.toContain("trycloudflare.com");
    });

    it("verifies .env.example declares NEXT_PUBLIC_INDEXER_API_URL=/api/indexer, INDEXER_INTERNAL_URL, and INDEXER_API_SECRET without trycloudflare", () => {
      const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf-8");
      expect(envExample).toContain('NEXT_PUBLIC_INDEXER_API_URL="/api/indexer"');
      expect(envExample).toContain('INDEXER_INTERNAL_URL="http://127.0.0.1:3001"');
      expect(envExample).toContain('INDEXER_API_SECRET="replace_with_32_byte_hex_secret"');
      expect(envExample).not.toContain("trycloudflare.com");
    });
  });

  describe("2. parseIndexerApiEvent Schema Transformations", () => {
    it("correctly parses swap event from Windows Indexer with BigInt conversion", () => {
      const rawSwap = {
        id: "evt_swap_001",
        contractId: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
        txHash: "0xdeadbeef1",
        ledger: 5646948,
        ledgerClosedAt: "2026-11-09T21:06:22Z",
        timestamp: 1794258382,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
        receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
        data: {
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: "10000000",
          amountOut: "10229900",
          fee: "10330",
        },
      };

      const parsed = parseIndexerApiEvent(rawSwap) as SwapEventParsed;
      expect(parsed).not.toBeNull();
      expect(parsed.type).toBe("swap");
      expect(parsed.id).toBe("evt_swap_001");
      expect(parsed.direction).toBe(1);
      expect(parsed.directionLabel).toBe("SY_FOR_PT");
      expect(parsed.amountIn).toBe(10000000n);
      expect(parsed.amountOut).toBe(10229900n);
      expect(parsed.fee).toBe(10330n);
      expect(parsed.caller).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(parsed.ledger).toBe(5646948);
    });

    it("correctly parses liquidity event with BigInt and boolean fields", () => {
      const rawLiq = {
        id: "evt_liq_001",
        contractId: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
        txHash: "0xdeadbeef2",
        ledger: 5646950,
        ledgerClosedAt: "2026-11-09T21:07:00Z",
        timestamp: 1794258420,
        type: "liquidity",
        topicSymbol: "liquidity_event",
        caller: "GUSER123",
        receiver: "GUSER123",
        data: {
          isAdd: true,
          ptAmount: "80000000",
          syAmount: "40000000",
          lpAmount: "56567000",
        },
      };

      const parsed = parseIndexerApiEvent(rawLiq) as LiquidityEventParsed;
      expect(parsed).not.toBeNull();
      expect(parsed.type).toBe("liquidity");
      expect(parsed.isAdd).toBe(true);
      expect(parsed.ptAmount).toBe(80000000n);
      expect(parsed.syAmount).toBe(40000000n);
      expect(parsed.lpAmount).toBe(56567000n);
    });

    it("correctly parses mint_py and redeem_py events", () => {
      const rawMint = {
        id: "evt_mint_py_001",
        contractId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
        txHash: "0xmint1",
        ledger: 5646960,
        type: "mint_py",
        caller: "GMINTER",
        receiver: "GMINTER",
        data: { syIn: "90000000", pyOut: "90000000" },
      };

      const parsedMint = parseIndexerApiEvent(rawMint) as MintPyEventParsed;
      expect(parsedMint.type).toBe("mint_py");
      expect(parsedMint.syIn).toBe(90000000n);
      expect(parsedMint.pyOut).toBe(90000000n);

      const rawRedeem = {
        id: "evt_redeem_py_001",
        contractId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
        txHash: "0xredeem1",
        ledger: 5646965,
        type: "redeem_py",
        caller: "GMINTER",
        data: { pyBurned: "20000000", syOut: "20000000" },
      };

      const parsedRedeem = parseIndexerApiEvent(rawRedeem) as RedeemPyEventParsed;
      expect(parsedRedeem.type).toBe("redeem_py");
      expect(parsedRedeem.pyBurned).toBe(20000000n);
      expect(parsedRedeem.syOut).toBe(20000000n);
    });

    it("correctly parses deposit, redeem, and yield_claimed events", () => {
      const rawDeposit = {
        id: "evt_dep_1",
        type: "deposit",
        contractId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
        data: { underlyingAmount: "130000000", sharesMinted: "130000000" },
      };
      const parsedDep = parseIndexerApiEvent(rawDeposit) as DepositEventParsed;
      expect(parsedDep.type).toBe("deposit");
      expect(parsedDep.underlyingAmount).toBe(130000000n);
      expect(parsedDep.sharesMinted).toBe(130000000n);

      const rawYield = {
        id: "evt_yield_1",
        type: "yield_claimed",
        data: { user: "GUSER", yieldOut: "95000" },
      };
      const parsedYield = parseIndexerApiEvent(rawYield) as YieldClaimedEventParsed;
      expect(parsedYield.type).toBe("yield_claimed");
      expect(parsedYield.yieldOut).toBe(95000n);
      expect(parsedYield.user).toBe("GUSER");
    });

    it("correctly parses rollover and rollover_py events", () => {
      const rawRollover = {
        id: "evt_rollover_1",
        type: "rollover",
        caller: "GUSER",
        data: {
          sourcePool: "C_POOL_OLD",
          targetPool: "C_POOL_NEW",
          ptBurned: "5000000",
          syReceived: "4800000",
          targetPtMinted: "4900000",
        },
      };
      const parsedRollover = parseIndexerApiEvent(rawRollover) as RolloverEventParsed;
      expect(parsedRollover.type).toBe("rollover");
      expect(parsedRollover.sourcePool).toBe("C_POOL_OLD");
      expect(parsedRollover.targetPool).toBe("C_POOL_NEW");
      expect(parsedRollover.ptBurned).toBe(5000000n);
      expect(parsedRollover.targetPtMinted).toBe(4900000n);
    });

    it("handles null, malformed objects, or unknown event types safely", () => {
      expect(parseIndexerApiEvent(null)).toBeNull();
      expect(parseIndexerApiEvent(undefined)).toBeNull();
      expect(parseIndexerApiEvent("not_an_object")).toBeNull();

      const unknown = parseIndexerApiEvent({ id: "unk_1", type: "custom_type" });
      expect(unknown).not.toBeNull();
      expect(unknown?.type).toBe("unknown");
    });
  });

  describe("3. Fast Indexer Sync & Graceful RPC Fallback Behavior", () => {
    it("successfully fast-syncs events from mock healthy Windows Indexer API", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        indexerApiUrl: "http://mock-indexer:8765",
        contractIds: ["CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF"],
      });

      // Mock global fetch for Windows Indexer API
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          if (urlStr.includes("/health")) {
            return new Response(JSON.stringify({ status: "healthy", totalEvents: 100 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (urlStr.includes("/events")) {
            return new Response(
              JSON.stringify({
                success: true,
                count: 1,
                events: [
                  {
                    id: "evt_live_1",
                    contractId: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
                    txHash: "0xtx1",
                    ledger: 5646948,
                    ledgerClosedAt: "2026-11-09T21:06:22Z",
                    timestamp: 1794258382,
                    type: "swap",
                    topicSymbol: "swap_event",
                    caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
                    receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
                    data: {
                      direction: 1,
                      directionLabel: "SY_FOR_PT",
                      amountIn: "100000",
                      amountOut: "102299",
                      fee: "1033",
                    },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          throw new Error("Unhandled URL in mock: " + urlStr);
        }) as typeof fetch;

        const count = await indexer.pollOnce();
        expect(count).toBe(1);
        expect(indexer.isApiActive()).toBe(true);
        expect(indexer.getEvents().length).toBe(1);
        expect(indexer.getEvents()[0].id).toBe("evt_live_1");
        expect(indexer.getLastIndexedLedger()).toBe(5646948);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("gracefully falls back to direct Soroban RPC when Windows Indexer API is offline or returns 500", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        indexerApiUrl: "http://offline-indexer-api:8765",
        contractIds: ["C_FALLBACK_POOL"],
      });

      let directRpcCalled = false;
      // Mock rpcServer to verify fallback
      (indexer as any).rpcServer = {
        getEvents: async () => {
          directRpcCalled = true;
          return {
            events: [
              {
                id: "rpc_fallback_evt_1",
                type: "contract",
                ledger: 100,
                ledgerClosedAt: "2026-11-08T00:00:00Z",
                txHash: "0xfallback1",
                contractId: "C_FALLBACK_POOL",
                topic: [],
                value: {},
              },
            ],
            cursor: "cur_fallback",
          };
        },
        getLatestLedger: async () => ({ sequence: 1000 }),
      };

      // Mock fetch that rejects (simulating connection refused / offline)
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          throw new Error("TypeError: Failed to fetch (ECONNREFUSED 192.168.0.29:8765)");
        }) as typeof fetch;

        // Must not throw uncaught error!
        const count = await indexer.pollOnce();
        expect(indexer.isApiActive()).toBe(false);
        expect(directRpcCalled).toBe(true);
        expect(count).toBe(1);
        expect(indexer.getEvents()[0].id).toBe("rpc_fallback_evt_1");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("fetches pre-indexed sparkline points from Windows Indexer API (/analytics/sparkline)", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        indexerApiUrl: "http://mock-indexer:8765",
        contractIds: ["C_POOL"],
      });

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          if (String(url).includes("/analytics/sparkline")) {
            return new Response(
              JSON.stringify({
                success: true,
                data: [
                  { bucket: "2026-11-09T19:00:00Z", count: 3294 },
                  { bucket: "2026-11-09T20:00:00Z", count: 18246 },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          throw new Error("Unexpected URL");
        }) as typeof fetch;

        const sparkline = await indexer.fetchSparklineFromApi(24);
        expect(sparkline).not.toBeNull();
        expect(sparkline?.length).toBe(2);
        expect(sparkline?.[0].bucket).toBe("2026-11-09T19:00:00Z");
        expect(sparkline?.[0].count).toBe(3294);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("gracefully returns null for sparkline when Windows Indexer API is offline", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        indexerApiUrl: "http://offline-indexer:8765",
        contractIds: ["C_POOL"],
      });

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          throw new Error("Network unreachable");
        }) as typeof fetch;

        const sparkline = await indexer.fetchSparklineFromApi(24);
        expect(sparkline).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("4. Design System Compliance & SvgSparkline Flicker Protection", () => {
    it("verifies zero raw hex color codes in SvgSparkline, AnalyticsCard, ActivityPanel", () => {
      const paths = [
        join(process.cwd(), "src/components/trading/SvgSparkline.tsx"),
        join(process.cwd(), "src/components/trading/AnalyticsCard.tsx"),
        join(process.cwd(), "src/components/trading/ActivityPanel.tsx"),
      ];

      for (const p of paths) {
        const content = readFileSync(p, "utf-8");
        const hexMatches = content.match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g) || [];
        expect(hexMatches.length).toBe(0);
      }
    });

    it("preserves SvgSparkline continuous mount fix from Milestone 1 (data.length === 0)", () => {
      const sparklineSource = readFileSync(
        join(process.cwd(), "src/components/trading/SvgSparkline.tsx"),
        "utf-8"
      );
      expect(sparklineSource).toContain("if (data.length === 0)");
      expect(sparklineSource).not.toContain("if (loading || data.length === 0)");
    });
  });

  describe("5. Live Network Integration against Local Indexer API (http://127.0.0.1:8765)", () => {
    it("connects to local Indexer API and queries /health, /events, and /analytics/sparkline (or gracefully skips if offline)", async () => {
      const isReachable = await fetch("http://127.0.0.1:8765/health", { signal: AbortSignal.timeout(250) })
        .then((r) => r.ok)
        .catch(() => false);

      if (!isReachable) {
        console.warn("[Live Test] http://127.0.0.1:8765 offline or unreachable, skipping live probe");
        return;
      }

      const indexer = new SorobanEventIndexer({
        rpcUrl: STELLAR_PENDLE_CONFIG.rpcUrl,
        indexerApiUrl: "http://127.0.0.1:8765",
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

      const events = indexer.getEvents();
      expect(events.length).toBeGreaterThan(0);

      // Verify at least one protocol event is decoded with full fidelity
      const hasValidProtocolEvent = events.some(
        (e) => e.type === "swap" || e.type === "deposit" || e.type === "mint_py" || e.type === "liquidity"
      );
      expect(hasValidProtocolEvent).toBe(true);

      const sparkline = await indexer.fetchSparklineFromApi(24);
      expect(sparkline).not.toBeNull();
      expect(Array.isArray(sparkline)).toBe(true);
      expect(sparkline!.length).toBeGreaterThan(0);
    });
  });

  describe("6. Next.js Server-Side BFF Proxy (/api/indexer/[...path])", () => {
    it("returns 404 for disallowed path", async () => {
      const req = new NextRequest("http://localhost:3000/api/indexer/admin/config");
      const res = await GET(req, { params: Promise.resolve({ path: ["admin", "config"] }) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Not Found");
    });

    it("forwards allowed path to INDEXER_INTERNAL_URL with x-indexer-secret header and returns 200", async () => {
      const origInternalUrl = process.env.INDEXER_INTERNAL_URL;
      const origSecret = process.env.INDEXER_API_SECRET;
      process.env.INDEXER_INTERNAL_URL = "http://internal-indexer:3001";
      process.env.INDEXER_API_SECRET = "secure-secret-token";

      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          capturedUrl = String(url);
          capturedHeaders = (init?.headers as Record<string, string>) || {};
          return new Response(JSON.stringify({ status: "healthy", totalEvents: 100 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch;

        const req = new NextRequest("http://localhost:3000/api/indexer/health");
        const res = await GET(req, { params: Promise.resolve({ path: ["health"] }) });
        expect(res.status).toBe(200);
        expect(capturedUrl).toBe("http://internal-indexer:3001/health");
        expect(capturedHeaders["x-indexer-secret"]).toBe("secure-secret-token");
        expect(capturedHeaders["Accept"]).toBe("application/json");

        const body = await res.json();
        expect(body.status).toBe("healthy");
        expect(body.totalEvents).toBe(100);
      } finally {
        globalThis.fetch = originalFetch;
        process.env.INDEXER_INTERNAL_URL = origInternalUrl;
        process.env.INDEXER_API_SECRET = origSecret;
      }
    });

    it("handles upstream failure with 502 JSON without leaking INDEXER_INTERNAL_URL", async () => {
      const origInternalUrl = process.env.INDEXER_INTERNAL_URL;
      process.env.INDEXER_INTERNAL_URL = "http://private-upstream-secret.network:3001";

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          throw new Error("Failed to connect to private-upstream-secret.network:3001");
        }) as typeof fetch;

        const req = new NextRequest("http://localhost:3000/api/indexer/health");
        const res = await GET(req, { params: Promise.resolve({ path: ["health"] }) });
        expect(res.status).toBe(502);

        const rawText = await res.text();
        expect(rawText).not.toContain("private-upstream-secret.network");
        expect(rawText).not.toContain("3001");

        const data = JSON.parse(rawText);
        expect(data.success).toBe(false);
        expect(data.status).toBe("offline");
        expect(data.error).toBe("Indexer upstream unavailable");
      } finally {
        globalThis.fetch = originalFetch;
        process.env.INDEXER_INTERNAL_URL = origInternalUrl;
      }
    });
  });
});
