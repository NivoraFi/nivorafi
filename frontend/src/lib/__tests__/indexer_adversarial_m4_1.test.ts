// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import {
  deserializeEventsJson,
  parseEventResponse,
  ProtocolEvent,
  scValToAddress,
  scValToBigInt,
  scValToBoolean,
  scValToNumber,
  scValToString,
  serializeEventsJson,
  SorobanEventIndexer,
  SwapEventParsed,
} from "../indexer";
import { rpc, xdr, scValToNative, Address } from "@stellar/stellar-sdk";

describe("Adversarial Empirical Challenge Suite: M4.1 Soroban Event Indexer Hardening", () => {
  // ==========================================================================
  // Section 1: Malformed RPC Payloads & Type Fuzzing
  // ==========================================================================
  describe("1. Malformed RPC Payloads & Type Fuzzing", () => {
    it("handles completely empty event response without crashing", () => {
      const emptyEvt = {} as unknown as rpc.Api.EventResponse;
      const parsed = parseEventResponse(emptyEvt);
      // Base protocol event defaults
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("unknown");
      expect(parsed?.contractId).toBe("");
      expect(parsed?.txHash).toBe("");
      expect(typeof parsed?.timestamp).toBe("number");
    });

    it("handles null and undefined topic array gracefully", () => {
      const nullTopicEvt = {
        id: "evt_null_topic",
        type: "contract",
        ledger: 100,
        txHash: "0x123",
        topic: null,
        value: null,
      } as unknown as rpc.Api.EventResponse;

      const parsed = parseEventResponse(nullTopicEvt);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("unknown");
      expect(parsed?.topicSymbol).toBe("");
    });

    it("handles topic array with null and undefined elements", () => {
      const sparseTopicEvt = {
        id: "evt_sparse_topic",
        type: "contract",
        ledger: 100,
        txHash: "0x123",
        topic: [null, undefined, null],
        value: null,
      } as unknown as rpc.Api.EventResponse;

      const parsed = parseEventResponse(sparseTopicEvt);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("unknown");
      expect(parsed?.topicSymbol).toBe("");
    });

    it("handles malformed ledgerClosedAt string and safely falls back without NaN timestamp", () => {
      const badDateEvt = {
        id: "evt_bad_date",
        type: "contract",
        ledger: 100,
        txHash: "0x123",
        ledgerClosedAt: "not-a-valid-iso-date",
        topic: ["swap"],
        value: { direction: 0, amount_in: 100n, amount_out: 100n, fee: 0n },
      } as unknown as rpc.Api.EventResponse;

      const parsed = parseEventResponse(badDateEvt);
      expect(parsed).not.toBeNull();
      expect(Number.isNaN(parsed!.timestamp)).toBe(false);
      expect(parsed!.timestamp).toBeGreaterThan(0);
    });

    it("handles swap event with out-of-bounds direction cleanly", () => {
      const badDirEvt = {
        id: "evt_bad_dir",
        type: "contract",
        ledger: 100,
        txHash: "0x123",
        topic: ["swap", "G_CALLER", "G_RECEIVER"],
        value: { direction: 99, amount_in: 1000n, amount_out: 1000n, fee: 10n },
      } as unknown as rpc.Api.EventResponse;

      const parsed = parseEventResponse(badDirEvt) as SwapEventParsed;
      expect(parsed).not.toBeNull();
      expect(parsed.type).toBe("swap");
      expect(parsed.direction).toBe(99);
      // Direction label fallback defaults to PT_FOR_SY
      expect(parsed.directionLabel).toBe("PT_FOR_SY");
    });

    it("handles contractId as Address object, string, or arbitrary object", () => {
      const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
      const addrObj = Address.fromString(validCAddr);

      const evtWithAddrObj = {
        id: "evt_addr_obj",
        type: "contract",
        ledger: 100,
        txHash: "0x123",
        contractId: addrObj,
        topic: ["unknown_topic"],
      } as unknown as rpc.Api.EventResponse;

      const parsed = parseEventResponse(evtWithAddrObj);
      expect(parsed?.contractId).toBe(validCAddr);
    });

    it("REGRESSION: real Soroban RPC xdr.ScVal topics are correctly decoded and classified", () => {
      const symVal = xdr.ScVal.scvSymbol("swap");
      const rpcEvt = {
        id: "evt_real_rpc",
        type: "contract",
        ledger: 124800,
        ledgerClosedAt: "2026-11-08T00:00:00Z",
        contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        topic: [symVal],
        value: { direction: 0, amount_in: 1000n, amount_out: 1000n, fee: 0n },
        txHash: "0xabc",
      } as unknown as rpc.Api.EventResponse;

      const parsed = parseEventResponse(rpcEvt);

      expect(scValToNative(symVal)).toBe("swap");
      expect(scValToString(symVal)).toBe("swap");
      expect(parsed?.type).toBe("swap");
    });

    it("REGRESSION: real Soroban RPC xdr.ScVal value is native-decoded correctly", () => {
      const i128Amount = xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: xdr.Int64(0n), lo: xdr.Uint64(5000000n) })
      );

      expect(scValToNative(i128Amount)).toBe(5000000n);
      expect(scValToBigInt(i128Amount)).toBe(5000000n);
    });

    it("REGRESSION: scValToBoolean returns true for real xdr.ScVal bool and bigint 1n", () => {
      const boolScVal = xdr.ScVal.scvBool(true);

      expect(scValToNative(boolScVal)).toBe(true);
      expect(scValToBoolean(boolScVal)).toBe(true);
      expect(scValToBoolean(1n)).toBe(true);
    });

    it("REGRESSION: scValToNumber returns number for real xdr.ScVal numbers", () => {
      const u32ScVal = xdr.ScVal.scvU32(42);

      expect(scValToNative(u32ScVal)).toBe(42);
      expect(scValToNumber(u32ScVal)).toBe(42);
    });
  });

  // ==========================================================================
  // Section 2: Cursor Pagination & Retention Edge Cases
  // ==========================================================================
  describe("2. Cursor Pagination & Retention Edge Cases", () => {
    it("handles empty getEvents response without infinite loop or state corruption", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_TEST_POOL"],
        pageSize: 10,
      });

      // Mock rpcServer
      (indexer as unknown as { rpcServer: { getEvents: () => Promise<unknown>; getLatestLedger: () => Promise<unknown> } }).rpcServer = {
        getEvents: async () => ({ events: [], cursor: "cursor_empty" }),
        getLatestLedger: async () => ({ sequence: 100000 }),
      };

      // Set isPolling to true for execution
      (indexer as unknown as { isPolling: boolean }).isPolling = true;

      const count = await indexer.pollOnce();
      expect(count).toBe(0);
      expect(indexer.getCursor()).toBe("cursor_empty");
      expect(indexer.getEvents().length).toBe(0);
    });

    it("handles single item response and updates cursor cleanly", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_TEST_POOL"],
        pageSize: 10,
      });

      const singleEvt = {
        id: "evt_single_001",
        type: "contract",
        ledger: 1000,
        ledgerClosedAt: "2026-11-08T00:00:00Z",
        contractId: "C_TEST_POOL",
        topic: ["deposit"],
        value: { underlying_amount: 500n, shares_minted: 500n },
        txHash: "0xhash_single",
      };

      (indexer as unknown as { rpcServer: { getEvents: () => Promise<unknown>; getLatestLedger: () => Promise<unknown> } }).rpcServer = {
        getEvents: async () => ({ events: [singleEvt], cursor: "cursor_page_1" }),
        getLatestLedger: async () => ({ sequence: 100000 }),
      };

      (indexer as unknown as { isPolling: boolean }).isPolling = true;

      const count = await indexer.pollOnce();
      expect(count).toBe(1);
      expect(indexer.getCursor()).toBe("cursor_page_1");
      expect(indexer.getLastIndexedLedger()).toBe(1000);
    });

    it("pages across multiple chunks up to boundary limit", async () => {
      const pageSize = 2;
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_TEST_POOL"],
        pageSize,
      });

      let callCount = 0;
      (indexer as unknown as { rpcServer: { getEvents: (req: unknown) => Promise<unknown>; getLatestLedger: () => Promise<unknown> } }).rpcServer = {
        getEvents: async (req: unknown) => {
          callCount++;
          const r = req as { cursor?: string };
          if (!r.cursor) {
            return {
              events: [
                { id: "e1", type: "contract", ledger: 100, txHash: "h1", topic: ["deposit"], value: {} },
                { id: "e2", type: "contract", ledger: 101, txHash: "h2", topic: ["deposit"], value: {} },
              ],
              cursor: "cursor_p1",
            };
          }
          if (r.cursor === "cursor_p1") {
            return {
              events: [
                { id: "e3", type: "contract", ledger: 102, txHash: "h3", topic: ["deposit"], value: {} },
              ],
              cursor: "cursor_p2",
            };
          }
          return { events: [], cursor: "cursor_p2" };
        },
        getLatestLedger: async () => ({ sequence: 100000 }),
      };

      (indexer as unknown as { isPolling: boolean }).isPolling = true;

      const count = await indexer.pollOnce();
      expect(count).toBe(3);
      expect(callCount).toBe(2);
      expect(indexer.getCursor()).toBe("cursor_p2");
    });

    it("resets stale cursor on -32602 RPC error and retries from ledger sequence", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_TEST_POOL"],
      });

      // Seed an existing cursor
      (indexer as unknown as { cursor: string | null }).cursor = "stale_cursor_999";
      (indexer as unknown as { isPolling: boolean }).isPolling = true;

      let callAttempt = 0;
      (indexer as unknown as { rpcServer: { getEvents: (req: unknown) => Promise<unknown>; getLatestLedger: () => Promise<unknown> } }).rpcServer = {
        getEvents: async (req: unknown) => {
          callAttempt++;
          const r = req as { cursor?: string; startLedger?: number };
          if (r.cursor) {
            throw new Error("RPC error -32602: cursor is invalid or expired");
          }
          return {
            events: [
              { id: "e_recovered", type: "contract", ledger: 200, txHash: "hr", topic: ["deposit"], value: {} },
            ],
            cursor: "fresh_cursor_001",
          };
        },
        getLatestLedger: async () => ({ sequence: 100000 }),
      };

      const count = await indexer.pollOnce();
      expect(callAttempt).toBe(2);
      expect(count).toBe(1);
      expect(indexer.getCursor()).toBe("fresh_cursor_001");
    });

    it("REGRESSION: pollOnce executes standalone without requiring start() to be called", async () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_TEST_POOL"],
      });

      let rpcInvoked = false;
      (indexer as unknown as { rpcServer: { getEvents: () => Promise<unknown>; getLatestLedger: () => Promise<unknown> } }).rpcServer = {
        getEvents: async () => {
          rpcInvoked = true;
          return { events: [], cursor: null };
        },
        getLatestLedger: async () => ({ sequence: 100000 }),
      };

      const count = await indexer.pollOnce();
      expect(count).toBe(0);
      expect(rpcInvoked).toBe(true);
    });
  });

  // ==========================================================================
  // Section 3: BigInt Boundary Values & Serialization Stress
  // ==========================================================================
  describe("3. BigInt Boundary Values & Serialization Stress", () => {
    it("safely decodes zero boundary values", () => {
      expect(scValToBigInt(0n)).toBe(0n);
      expect(scValToBigInt(0)).toBe(0n);
      expect(scValToBigInt(-0)).toBe(0n);
      expect(scValToBigInt("0")).toBe(0n);
      expect(scValToBigInt("00000")).toBe(0n);
      expect(scValToBigInt(" 0 ")).toBe(0n);
    });

    it("safely decodes max signed 128-bit integer (2^127 - 1)", () => {
      const maxI128 = 170141183460469231731687303715884105727n;
      expect(scValToBigInt(maxI128)).toBe(maxI128);
      expect(scValToBigInt(maxI128.toString())).toBe(maxI128);
    });

    it("safely decodes min signed 128-bit integer (-2^127)", () => {
      const minI128 = -170141183460469231731687303715884105728n;
      expect(scValToBigInt(minI128)).toBe(minI128);
      expect(scValToBigInt(minI128.toString())).toBe(minI128);
    });

    it("safely decodes max unsigned 256-bit integer (2^256 - 1)", () => {
      const maxU256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
      expect(scValToBigInt(maxU256)).toBe(maxU256);
      expect(scValToBigInt(maxU256.toString())).toBe(maxU256);
    });

    it("handles decimal string inputs without throwing (returns 0n)", () => {
      // BigInt("123.456") throws in JS; scValToBigInt catches and returns 0n
      expect(scValToBigInt("123.456")).toBe(0n);
      expect(scValToBigInt("-0.5")).toBe(0n);
    });

    it("preserves boundary BigInt values through JSON serialization roundtrip", () => {
      const boundaryEvents: ProtocolEvent[] = [
        {
          id: "evt_bound_0",
          contractId: "C1",
          txHash: "tx0",
          ledger: 10,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1762560000,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G2",
          direction: 0,
          directionLabel: "PT_FOR_SY",
          amountIn: 0n,
          amountOut: 0n,
          fee: 0n,
        },
        {
          id: "evt_bound_max",
          contractId: "C1",
          txHash: "tx1",
          ledger: 11,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1762560001,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G2",
          direction: 0,
          directionLabel: "PT_FOR_SY",
          amountIn: 170141183460469231731687303715884105727n, // 2^127 - 1
          amountOut: 115792089237316195423570985008687907853269984665640564039457584007913129639935n, // 2^256 - 1
          fee: -170141183460469231731687303715884105728n, // -2^127
        },
      ];

      const serialized = serializeEventsJson(boundaryEvents);
      const deserialized = deserializeEventsJson(serialized);

      expect(deserialized.length).toBe(2);
      const e0 = deserialized[0] as SwapEventParsed;
      expect(e0.amountIn).toBe(0n);
      expect(e0.amountOut).toBe(0n);
      expect(e0.fee).toBe(0n);

      const e1 = deserialized[1] as SwapEventParsed;
      expect(e1.amountIn).toBe(170141183460469231731687303715884105727n);
      expect(e1.amountOut).toBe(115792089237316195423570985008687907853269984665640564039457584007913129639935n);
      expect(e1.fee).toBe(-170141183460469231731687303715884105728n);
    });

    it("REGRESSION: deserializeEventsJson('null') returns empty array instead of null", () => {
      const result = deserializeEventsJson("null");
      expect(result).toEqual([]);
    });

    it("REGRESSION: deserializeEventsJson('{}') returns empty array instead of plain object", () => {
      const result = deserializeEventsJson("{}");
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // Section 4: Indexer Store Integrity & Memory Leak Audit
  // ==========================================================================
  describe("4. Indexer Store Integrity & Memory Leak Audit", () => {
    it("deduplicates identical events by composite key ledger-txHash-id", () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C1"],
      });

      const evt: ProtocolEvent = {
        id: "evt_1",
        contractId: "C1",
        txHash: "tx_1",
        ledger: 100,
        ledgerClosedAt: "2026-11-08T00:00:00Z",
        timestamp: 1762560000,
        type: "swap",
        topicSymbol: "swap",
        caller: "G1",
        receiver: "G2",
        direction: 0,
        directionLabel: "PT_FOR_SY",
        amountIn: 100n,
        amountOut: 90n,
        fee: 1n,
      };

      expect(indexer.addManualEvent(evt)).toBe(true);
      expect(indexer.addManualEvent(evt)).toBe(false);
      expect(indexer.getEvents().length).toBe(1);
    });

    it("REGRESSION: addManualEvent enforces maxCacheSize pruning", () => {
      const maxCache = 3;
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C1"],
        maxCacheSize: maxCache,
      });

      for (let i = 0; i < 10; i++) {
        indexer.addManualEvent({
          id: `evt_leak_${i}`,
          contractId: "C1",
          txHash: `tx_${i}`,
          ledger: 100 + i,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1762560000 + i,
          type: "deposit",
          topicSymbol: "deposit",
          caller: "G1",
          receiver: "G1",
          underlyingAmount: BigInt(i),
          sharesMinted: BigInt(i),
        });
      }

      expect(indexer.getEvents().length).toBe(maxCache);
      expect(indexer.getEvents()[0].id).toBe("evt_leak_7");
      expect(indexer.getEvents()[2].id).toBe("evt_leak_9");
    });
  });
});
