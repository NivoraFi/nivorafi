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
import { Address, rpc, xdr } from "@stellar/stellar-sdk";

describe("Soroban RPC Event Indexer Engine Suite", () => {
  describe("1. Safe ScVal Decoding Primitives", () => {
    describe("scValToBigInt", () => {
      it("decodes native bigints correctly", () => {
        expect(scValToBigInt(100n)).toBe(100n);
        expect(scValToBigInt(1000000000000000000n)).toBe(1000000000000000000n);
        expect(scValToBigInt(0n)).toBe(0n);
        expect(scValToBigInt(-50n)).toBe(-50n);
      });

      it("decodes JavaScript numbers safely", () => {
        expect(scValToBigInt(42)).toBe(42n);
        expect(scValToBigInt(100.9)).toBe(100n);
        expect(scValToBigInt(0)).toBe(0n);
        expect(scValToBigInt(NaN)).toBe(0n);
        expect(scValToBigInt(Infinity)).toBe(0n);
      });

      it("decodes string numbers safely and handles malformed strings", () => {
        expect(scValToBigInt("5000000")).toBe(5000000n);
        expect(scValToBigInt(" 12345 ")).toBe(12345n);
        expect(scValToBigInt("0")).toBe(0n);
        expect(scValToBigInt("")).toBe(0n);
        expect(scValToBigInt("not_a_number")).toBe(0n);
        expect(scValToBigInt("NaN")).toBe(0n);
        expect(scValToBigInt("Infinity")).toBe(0n);
      });

      it("handles null and undefined gracefully", () => {
        expect(scValToBigInt(null)).toBe(0n);
        expect(scValToBigInt(undefined)).toBe(0n);
      });

      it("decodes authentic xdr.ScVal i128 and u64 correctly", () => {
        const i128Val = xdr.ScVal.scvI128(
          new xdr.Int128Parts({ hi: xdr.Int64(0n), lo: xdr.Uint64(10000000n) })
        );
        expect(scValToBigInt(i128Val)).toBe(10000000n);
        const u64Val = xdr.ScVal.scvU64(xdr.Uint64(12345678n));
        expect(scValToBigInt(u64Val)).toBe(12345678n);
      });
    });

    describe("scValToAddress", () => {
      it("returns valid address strings unmodified", () => {
        const addr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
        expect(scValToAddress(addr)).toBe(addr);
      });

      it("handles null, undefined, and non-string inputs safely", () => {
        expect(scValToAddress(null)).toBe("");
        expect(scValToAddress(undefined)).toBe("");
        expect(scValToAddress(123)).toBe("123");
      });

      it("handles objects with custom toString()", () => {
        const custom = {
          toString: () => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        };
        expect(scValToAddress(custom)).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
      });

      it("decodes authentic xdr.ScVal address correctly", () => {
        const addrStr = "GBFU7J36ZSY5K6JOXAELY6FDX4MRYH5WSBSEGE6Q2LRO4VZJJ343BQS3";
        const scvAddr = Address.fromString(addrStr).toScVal();
        expect(scValToAddress(scvAddr)).toBe(addrStr);
      });
    });

    describe("scValToString", () => {
      it("returns plain strings unmodified", () => {
        expect(scValToString("swap_event")).toBe("swap_event");
        expect(scValToString("")).toBe("");
      });

      it("handles null and undefined safely", () => {
        expect(scValToString(null)).toBe("");
        expect(scValToString(undefined)).toBe("");
      });

      it("decodes numbers to strings safely", () => {
        expect(scValToString(123)).toBe("123");
      });

      it("decodes authentic xdr.ScVal symbols and byte buffers to string", () => {
        const sym = xdr.ScVal.scvSymbol("swap");
        expect(scValToString(sym)).toBe("swap");
        const buf = new Uint8Array([116, 101, 115, 116]);
        expect(scValToString(buf)).toBe("test");
      });
    });

    describe("scValToNumber", () => {
      it("decodes numbers, bigints, and strings correctly", () => {
        expect(scValToNumber(42)).toBe(42);
        expect(scValToNumber(100n)).toBe(100);
        expect(scValToNumber("25.5")).toBe(25.5);
        expect(scValToNumber("invalid")).toBe(0);
        expect(scValToNumber(null)).toBe(0);
        expect(scValToNumber(undefined)).toBe(0);
        expect(scValToNumber(NaN)).toBe(0);
      });

      it("decodes authentic xdr.ScVal u32 and i32 correctly", () => {
        const u32 = xdr.ScVal.scvU32(42);
        expect(scValToNumber(u32)).toBe(42);
        const i32 = xdr.ScVal.scvI32(-10);
        expect(scValToNumber(i32)).toBe(-10);
      });
    });

    describe("scValToBoolean", () => {
      it("decodes booleans, numbers, and strings correctly", () => {
        expect(scValToBoolean(true)).toBe(true);
        expect(scValToBoolean(false)).toBe(false);
        expect(scValToBoolean(1)).toBe(true);
        expect(scValToBoolean(0)).toBe(false);
        expect(scValToBoolean("true")).toBe(true);
        expect(scValToBoolean("1")).toBe(true);
        expect(scValToBoolean("false")).toBe(false);
        expect(scValToBoolean(null)).toBe(false);
        expect(scValToBoolean(undefined)).toBe(false);
      });

      it("decodes authentic xdr.ScVal bool and bigints correctly", () => {
        const boolTrue = xdr.ScVal.scvBool(true);
        const boolFalse = xdr.ScVal.scvBool(false);
        expect(scValToBoolean(boolTrue)).toBe(true);
        expect(scValToBoolean(boolFalse)).toBe(false);
        expect(scValToBoolean(1n)).toBe(true);
        expect(scValToBoolean(0n)).toBe(false);
      });
    });
  });

  describe("2. Event Parsing Fidelity (parseEventResponse)", () => {
    it("parses SwapEvent with authentic xdr.ScVal topics and scvMap value", () => {
      const symTopic = xdr.ScVal.scvSymbol("swap");
      const caller = "GBFU7J36ZSY5K6JOXAELY6FDX4MRYH5WSBSEGE6Q2LRO4VZJJ343BQS3";
      const receiver = "GBIUH7VL7OTHARIZ4K3YQYEMYZXVE2JDFPP7QWBYDH6O3LA6MXCO3ZEX";
      const callerTopic = Address.fromString(caller).toScVal();
      const receiverTopic = Address.fromString(receiver).toScVal();

      const mapVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("direction"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("amount_in"),
          val: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64(0n), lo: xdr.Uint64(10000000n) })),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("amount_out"),
          val: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64(0n), lo: xdr.Uint64(9850000n) })),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee"),
          val: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64(0n), lo: xdr.Uint64(15000n) })),
        }),
      ]);

      const mockEvt: rpc.Api.EventResponse = {
        id: "0000000100-0000000001",
        type: "contract",
        ledger: 124800,
        ledgerClosedAt: "2026-11-08T22:30:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        contractId: "C_POOL_1" as any,
        topic: [symTopic, callerTopic, receiverTopic] as any,
        value: mapVal as any,
      };

      const parsed = parseEventResponse(mockEvt);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("swap");
      const swap = parsed as SwapEventParsed;
      expect(swap.caller).toBe(caller);
      expect(swap.receiver).toBe(receiver);
      expect(swap.direction).toBe(0);
      expect(swap.directionLabel).toBe("PT_FOR_SY");
      expect(swap.amountIn).toBe(10000000n);
      expect(swap.amountOut).toBe(9850000n);
      expect(swap.fee).toBe(15000n);
    });

    it("parses SwapEvent (direction 0: PT_FOR_SY)", () => {
      const mockEvt: rpc.Api.EventResponse = {
        id: "0000000100-0000000001",
        type: "contract",
        ledger: 124800,
        ledgerClosedAt: "2026-11-08T22:30:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        contractId: { contractId: () => "C_POOL_1" } as any,
        topic: ["swap_event", "G_CALLER_1", "G_RECEIVER_1"] as any,
        value: {
          direction: 0,
          amount_in: 10000000n,
          amount_out: 9850000n,
          fee: 15000n,
        } as any,
      };

      const parsed = parseEventResponse(mockEvt);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("swap");
      const swap = parsed as SwapEventParsed;
      expect(swap.caller).toBe("G_CALLER_1");
      expect(swap.receiver).toBe("G_RECEIVER_1");
      expect(swap.direction).toBe(0);
      expect(swap.directionLabel).toBe("PT_FOR_SY");
      expect(swap.amountIn).toBe(10000000n);
      expect(swap.amountOut).toBe(9850000n);
      expect(swap.fee).toBe(15000n);
      expect(swap.contractId).toBe("C_POOL_1");
      expect(swap.ledger).toBe(124800);
      expect(swap.timestamp).toBe(Math.floor(new Date("2026-11-08T22:30:00Z").getTime() / 1000));
    });

    it("parses SwapEvent (direction 1: SY_FOR_PT)", () => {
      const mockEvt: rpc.Api.EventResponse = {
        id: "0000000100-0000000002",
        type: "contract",
        ledger: 124801,
        ledgerClosedAt: "2026-11-08T22:30:05Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_swap_sy_pt",
        contractId: "C_POOL_1" as any,
        topic: ["swap_event", "G_CALLER_1", "G_RECEIVER_1"] as any,
        value: {
          direction: 1,
          amount_in: 5000000n,
          amount_out: 5080000n,
          fee: 8000n,
        } as any,
      };

      const parsed = parseEventResponse(mockEvt);
      expect(parsed?.type).toBe("swap");
      const swap = parsed as SwapEventParsed;
      expect(swap.direction).toBe(1);
      expect(swap.directionLabel).toBe("SY_FOR_PT");
      expect(swap.amountIn).toBe(5000000n);
      expect(swap.amountOut).toBe(5080000n);
    });

    it("parses LiquidityEvent (add and remove)", () => {
      const addEvt: rpc.Api.EventResponse = {
        id: "0000000101-0000000001",
        type: "contract",
        ledger: 124802,
        ledgerClosedAt: "2026-11-08T22:31:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_add_liq",
        topic: ["liquidity_event", "G_USER", "G_USER"] as any,
        value: {
          is_add: true,
          pt_amount: 80000000n,
          sy_amount: 40000000n,
          lp_amount: 56567000n,
        } as any,
      };

      const parsedAdd = parseEventResponse(addEvt);
      expect(parsedAdd?.type).toBe("liquidity");
      if (parsedAdd?.type === "liquidity") {
        expect(parsedAdd.isAdd).toBe(true);
        expect(parsedAdd.ptAmount).toBe(80000000n);
        expect(parsedAdd.syAmount).toBe(40000000n);
        expect(parsedAdd.lpAmount).toBe(56567000n);
      }

      const removeEvt: rpc.Api.EventResponse = {
        ...addEvt,
        id: "0000000101-0000000002",
        value: {
          is_add: false,
          pt_amount: 40000000n,
          sy_amount: 20000000n,
          lp_amount: 28283500n,
        } as any,
      };
      const parsedRemove = parseEventResponse(removeEvt);
      if (parsedRemove?.type === "liquidity") {
        expect(parsedRemove.isAdd).toBe(false);
        expect(parsedRemove.lpAmount).toBe(28283500n);
      }
    });

    it("parses MintPyEvent and RedeemPyEvent", () => {
      const mintEvt: rpc.Api.EventResponse = {
        id: "0000000102-0000000001",
        type: "contract",
        ledger: 124803,
        ledgerClosedAt: "2026-11-08T22:32:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_mint_py",
        topic: ["mint_py_event", "G_USER", "G_USER"] as any,
        value: {
          sy_in: 90000000n,
          py_out: 90000000n,
        } as any,
      };

      const parsedMint = parseEventResponse(mintEvt);
      expect(parsedMint?.type).toBe("mint_py");
      if (parsedMint?.type === "mint_py") {
        expect(parsedMint.syIn).toBe(90000000n);
        expect(parsedMint.pyOut).toBe(90000000n);
      }

      const redeemEvt: rpc.Api.EventResponse = {
        id: "0000000102-0000000002",
        type: "contract",
        ledger: 124804,
        ledgerClosedAt: "2026-11-08T22:33:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_redeem_py",
        topic: ["redeem_py_event", "G_USER", "G_USER"] as any,
        value: {
          py_burned: 45000000n,
          sy_out: 45000000n,
        } as any,
      };

      const parsedRedeem = parseEventResponse(redeemEvt);
      expect(parsedRedeem?.type).toBe("redeem_py");
      if (parsedRedeem?.type === "redeem_py") {
        expect(parsedRedeem.pyBurned).toBe(45000000n);
        expect(parsedRedeem.syOut).toBe(45000000n);
      }
    });

    it("parses RedeemPtEvent (post-maturity settlement)", () => {
      const settleEvt: rpc.Api.EventResponse = {
        id: "0000000103-0000000001",
        type: "contract",
        ledger: 124805,
        ledgerClosedAt: "2026-11-08T22:34:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_settle_pt",
        topic: ["redeem_pt_event", "G_USER", "G_USER"] as any,
        value: {
          pt_burned: 10000000n,
          payout: 10000000n,
          is_btoken: false,
        } as any,
      };

      const parsed = parseEventResponse(settleEvt);
      expect(parsed?.type).toBe("redeem_pt");
      if (parsed?.type === "redeem_pt") {
        expect(parsed.ptBurned).toBe(10000000n);
        expect(parsed.payout).toBe(10000000n);
        expect(parsed.isBtoken).toBe(false);
      }
    });

    it("parses DepositEvent and RedeemEvent (SY wrapper)", () => {
      const depEvt: rpc.Api.EventResponse = {
        id: "0000000104-0000000001",
        type: "contract",
        ledger: 124806,
        ledgerClosedAt: "2026-11-08T22:35:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_dep_sy",
        topic: ["deposit_event", "G_USER", "G_USER"] as any,
        value: {
          underlying_amount: 130000000n,
          shares_minted: 130000000n,
        } as any,
      };

      const parsedDep = parseEventResponse(depEvt);
      expect(parsedDep?.type).toBe("deposit");
      if (parsedDep?.type === "deposit") {
        expect(parsedDep.underlyingAmount).toBe(130000000n);
        expect(parsedDep.sharesMinted).toBe(130000000n);
      }
    });

    it("parses RolloverExecutedEvent", () => {
      const rollEvt: rpc.Api.EventResponse = {
        id: "0000000105-0000000001",
        type: "contract",
        ledger: 124807,
        ledgerClosedAt: "2026-11-08T22:36:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_rollover",
        topic: ["rollover_executed_event", "G_USER", "C_SRC_POOL", "C_TGT_POOL"] as any,
        value: {
          pt_burned: 10000000n,
          sy_received: 10000000n,
          target_pt_minted: 10450000n,
        } as any,
      };

      const parsed = parseEventResponse(rollEvt);
      expect(parsed?.type).toBe("rollover");
      if (parsed?.type === "rollover") {
        expect(parsed.user).toBe("G_USER");
        expect(parsed.sourcePool).toBe("C_SRC_POOL");
        expect(parsed.targetPool).toBe("C_TGT_POOL");
        expect(parsed.ptBurned).toBe(10000000n);
        expect(parsed.targetPtMinted).toBe(10450000n);
      }
    });

    it("parses MarketCreatedEvent", () => {
      const mktEvt: rpc.Api.EventResponse = {
        id: "0000000106-0000000001",
        type: "contract",
        ledger: 124808,
        ledgerClosedAt: "2026-11-08T22:37:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_mkt_create",
        topic: ["market_created_event", 1, "C_POOL", "C_USDC"] as any,
        value: {
          sy: "C_SY",
          pt: "C_PT",
          yt: "C_YT",
          maturity: 1801909055,
          scalar_root: 8000000000000000000n,
          initial_anchor: 1000000000000000000n,
        } as any,
      };

      const parsed = parseEventResponse(mktEvt);
      expect(parsed?.type).toBe("market_created");
      if (parsed?.type === "market_created") {
        expect(parsed.marketId).toBe(1);
        expect(parsed.pool).toBe("C_POOL");
        expect(parsed.sy).toBe("C_SY");
        expect(parsed.maturity).toBe(1801909055);
      }
    });

    it("gracefully falls back to unknown on unexpected topic symbols", () => {
      const unkEvt: rpc.Api.EventResponse = {
        id: "0000000107-0000000001",
        type: "contract",
        ledger: 124809,
        ledgerClosedAt: "2026-11-08T22:38:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        txHash: "tx_unknown",
        topic: ["custom_protocol_hook_event", "topic_1"] as any,
        value: { foo: "bar" } as any,
      };

      const parsed = parseEventResponse(unkEvt);
      expect(parsed?.type).toBe("unknown");
    });
  });

  describe("3. Local Storage Caching & BigInt Serialization", () => {
    it("losslessly serializes and deserializes BigInt fields in ProtocolEvents", () => {
      const sampleEvents: ProtocolEvent[] = [
        {
          id: "001",
          contractId: "C1",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1762560000,
          type: "swap",
          topicSymbol: "swap_event",
          caller: "G1",
          receiver: "G2",
          direction: 0,
          directionLabel: "PT_FOR_SY",
          amountIn: 123456789012345678901234567890n,
          amountOut: 987654321098765432109876543210n,
          fee: 50000000000000000n,
        },
      ];

      const serialized = serializeEventsJson(sampleEvents);
      expect(serialized).toContain("__bigint__:123456789012345678901234567890");

      const deserialized = deserializeEventsJson(serialized);
      expect(deserialized.length).toBe(1);
      const swap = deserialized[0] as SwapEventParsed;
      expect(typeof swap.amountIn).toBe("bigint");
      expect(swap.amountIn).toBe(123456789012345678901234567890n);
      expect(swap.amountOut).toBe(987654321098765432109876543210n);
      expect(swap.fee).toBe(50000000000000000n);
    });

    it("recovers gracefully from malformed JSON in deserialization", () => {
      const result = deserializeEventsJson("invalid json syntax");
      expect(result).toEqual([]);
    });
  });

  describe("4. SorobanEventIndexer Class Logic", () => {
    it("initializes cleanly and generates deterministic composite deduplication keys", () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_POOL"],
      });

      const evt: ProtocolEvent = {
        id: "evt_001",
        contractId: "C_POOL",
        txHash: "0xdeadbeef",
        ledger: 500,
        ledgerClosedAt: "2026-11-08T00:00:00Z",
        timestamp: 1762560000,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "G1",
        receiver: "G2",
        direction: 0,
        directionLabel: "PT_FOR_SY",
        amountIn: 100n,
        amountOut: 95n,
        fee: 1n,
      };

      const key = indexer.getEventKey(evt);
      expect(key).toBe("500-0xdeadbeef-evt_001");
    });

    it("deduplicates identical events added manually", () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_POOL"],
        maxCacheSize: 50,
      });

      const evt: ProtocolEvent = {
        id: "dup_001",
        contractId: "C_POOL",
        txHash: "0xhash1",
        ledger: 100,
        ledgerClosedAt: "2026-11-08T00:00:00Z",
        timestamp: 1762560000,
        type: "deposit",
        topicSymbol: "deposit_event",
        caller: "G1",
        receiver: "G1",
        underlyingAmount: 1000n,
        sharesMinted: 1000n,
      };

      const addedFirst = indexer.addManualEvent(evt);
      expect(addedFirst).toBe(true);
      expect(indexer.getEvents().length).toBe(1);

      // Duplicate addition must be ignored
      const addedSecond = indexer.addManualEvent(evt);
      expect(addedSecond).toBe(false);
      expect(indexer.getEvents().length).toBe(1);
    });

    it("notifies listeners on state change and allows clean unsubscription", () => {
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_POOL"],
      });

      let callCount = 0;
      let lastReceivedEvents: ProtocolEvent[] = [];

      const unsubscribe = indexer.subscribe((events) => {
        callCount++;
        lastReceivedEvents = events;
      });

      // Initial subscription immediately fires once
      expect(callCount).toBe(1);

      indexer.addManualEvent({
        id: "evt_sub",
        contractId: "C_POOL",
        txHash: "0xhash2",
        ledger: 101,
        ledgerClosedAt: "2026-11-08T00:00:00Z",
        timestamp: 1762560000,
        type: "mint_py",
        topicSymbol: "mint_py_event",
        caller: "G1",
        receiver: "G1",
        syIn: 500n,
        pyOut: 500n,
      });

      expect(callCount).toBe(2);
      expect(lastReceivedEvents.length).toBe(1);

      // Unsubscribe
      unsubscribe();

      indexer.addManualEvent({
        id: "evt_sub_2",
        contractId: "C_POOL",
        txHash: "0xhash3",
        ledger: 102,
        ledgerClosedAt: "2026-11-08T00:00:00Z",
        timestamp: 1762560000,
        type: "swap",
        topicSymbol: "swap_event",
        caller: "G1",
        receiver: "G1",
        direction: 1,
        directionLabel: "SY_FOR_PT",
        amountIn: 200n,
        amountOut: 205n,
        fee: 2n,
      });

      // Listener not called after unsubscription
      expect(callCount).toBe(2);
      expect(indexer.getEvents().length).toBe(2);
    });

    it("prunes cache when event count exceeds maxCacheSize", () => {
      const maxCache = 5;
      const indexer = new SorobanEventIndexer({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIds: ["C_POOL"],
        maxCacheSize: maxCache,
      });

      for (let i = 0; i < 10; i++) {
        indexer.addManualEvent({
          id: `id_${i}`,
          contractId: "C_POOL",
          txHash: `tx_${i}`,
          ledger: 100 + i,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1762560000 + i,
          type: "deposit",
          topicSymbol: "deposit_event",
          caller: "G1",
          receiver: "G1",
          underlyingAmount: BigInt(i),
          sharesMinted: BigInt(i),
        });
      }

      // Check maxCacheSize constraint: genuine truncation
      expect(indexer.getEvents().length).toBe(maxCache);
      const events = indexer.getEvents();
      expect(events[0].id).toBe("id_5");
      expect(events[4].id).toBe("id_9");
      expect(indexer.getLastIndexedLedger()).toBe(109);
    });

    describe("5. RPC Wire-Level & Dual-Cursor Pagination", () => {
      it("standalone pollOnce triggers rpcServer.getEvents and increments event count", async () => {
        const indexer = new SorobanEventIndexer({
          rpcUrl: "https://soroban-testnet.stellar.org",
          contractIds: ["C_POOL"],
        });

        let getEventsCalled = false;
        (indexer as any).rpcServer = {
          getEvents: async () => {
            getEventsCalled = true;
            return {
              events: [
                {
                  id: "evt_101",
                  type: "contract",
                  ledger: 200,
                  ledgerClosedAt: "2026-11-08T00:00:00Z",
                  txHash: "0xtx1",
                  contractId: "C_POOL",
                  topic: [xdr.ScVal.scvSymbol("deposit")],
                  value: { underlying_amount: 500n, shares_minted: 500n },
                },
              ],
              cursor: "cur_page_1",
            };
          },
          getLatestLedger: async () => ({ sequence: 1000 }),
        };

        const count = await indexer.pollOnce();
        expect(getEventsCalled).toBe(true);
        expect(count).toBe(1);
        expect(indexer.getEvents().length).toBe(1);
        expect(indexer.getCursor()).toBe("cur_page_1");
      });

      it("enforces dual-cursor wire contract: page 1 uses startLedger without cursor, page 2 uses cursor without startLedger", async () => {
        const indexer = new SorobanEventIndexer({
          rpcUrl: "https://soroban-testnet.stellar.org",
          contractIds: ["C_POOL"],
          pageSize: 2,
        });

        const capturedRequests: rpc.Api.GetEventsRequest[] = [];
        let callCount = 0;

        (indexer as any).rpcServer = {
          getEvents: async (req: rpc.Api.GetEventsRequest) => {
            capturedRequests.push(req);
            callCount++;
            if (callCount === 1) {
              // Return full page (pageSize = 2) with cursor to trigger second page
              return {
                events: [
                  {
                    id: "evt_p1_1",
                    type: "contract",
                    ledger: 300,
                    ledgerClosedAt: "2026-11-08T00:00:00Z",
                    txHash: "0xtx_p1_1",
                    contractId: "C_POOL",
                    topic: [xdr.ScVal.scvSymbol("deposit")],
                    value: { underlying_amount: 100n, shares_minted: 100n },
                  },
                  {
                    id: "evt_p1_2",
                    type: "contract",
                    ledger: 301,
                    ledgerClosedAt: "2026-11-08T00:00:00Z",
                    txHash: "0xtx_p1_2",
                    contractId: "C_POOL",
                    topic: [xdr.ScVal.scvSymbol("deposit")],
                    value: { underlying_amount: 200n, shares_minted: 200n },
                  },
                ],
                cursor: "cursor_p1_end",
              };
            } else {
              // Page 2: partial page ends loop
              return {
                events: [
                  {
                    id: "evt_p2_1",
                    type: "contract",
                    ledger: 302,
                    ledgerClosedAt: "2026-11-08T00:00:00Z",
                    txHash: "0xtx_p2_1",
                    contractId: "C_POOL",
                    topic: [xdr.ScVal.scvSymbol("deposit")],
                    value: { underlying_amount: 300n, shares_minted: 300n },
                  },
                ],
                cursor: "cursor_p2_end",
              };
            }
          },
          getLatestLedger: async () => ({ sequence: 1000 }),
        };

        const count = await indexer.pollOnce();
        expect(count).toBe(3);
        expect(capturedRequests.length).toBe(2);

        // Page 1 wire assertion: startLedger present, cursor absent
        expect(capturedRequests[0].startLedger).toBeDefined();
        expect(capturedRequests[0].cursor).toBeUndefined();

        // Page 2 wire assertion: cursor present, startLedger absent
        expect(capturedRequests[1].cursor).toBe("cursor_p1_end");
        expect(capturedRequests[1].startLedger).toBeUndefined();
      });

      it("recovers from -32602 stale cursor error by resetting cursor and falling back to ledger range", async () => {
        const indexer = new SorobanEventIndexer({
          rpcUrl: "https://soroban-testnet.stellar.org",
          contractIds: ["C_POOL"],
        });

        (indexer as any).cursor = "expired_cursor_123";

        const requests: rpc.Api.GetEventsRequest[] = [];
        let attempts = 0;

        (indexer as any).rpcServer = {
          getEvents: async (req: rpc.Api.GetEventsRequest) => {
            requests.push(req);
            attempts++;
            if (attempts === 1) {
              throw new Error("RPC error -32602: cursor is invalid or expired");
            }
            return { events: [], cursor: "fresh_cursor_456" };
          },
          getLatestLedger: async () => ({ sequence: 5000 }),
        };

        const count = await indexer.pollOnce();
        expect(count).toBe(0);
        expect(requests.length).toBe(2);
        // Attempt 1 sent the stale cursor
        expect(requests[0].cursor).toBe("expired_cursor_123");
        // Attempt 2 had cursor reset and used startLedger
        expect(requests[1].cursor).toBeUndefined();
        expect(requests[1].startLedger).toBeDefined();
      });

      it("handles oldestLedger retention window error by advancing startLedger", async () => {
        const indexer = new SorobanEventIndexer({
          rpcUrl: "https://soroban-testnet.stellar.org",
          contractIds: ["C_POOL"],
          startLedger: 100,
        });

        let attempts = 0;
        const requestedStartLedgers: number[] = [];

        (indexer as any).rpcServer = {
          getEvents: async (req: rpc.Api.GetEventsRequest) => {
            attempts++;
            if (req.startLedger) requestedStartLedgers.push(req.startLedger);
            if (attempts === 1) {
              throw new Error("startLedger is older than oldestLedger (retention window exceeded)");
            }
            return { events: [], cursor: "new_cursor" };
          },
          getLatestLedger: async () => ({ sequence: 50000 }),
        };

        const count = await indexer.pollOnce();
        expect(count).toBe(0);
        expect(attempts).toBe(2);
        expect(requestedStartLedgers.length).toBe(2);
        expect(requestedStartLedgers[1]).toBeGreaterThan(requestedStartLedgers[0]);
      });

      it("aborts pagination when stop() sets abortRequested", async () => {
        const indexer = new SorobanEventIndexer({
          rpcUrl: "https://soroban-testnet.stellar.org",
          contractIds: ["C_POOL"],
          pageSize: 2,
        });

        let pagesQueried = 0;
        (indexer as any).rpcServer = {
          getEvents: async () => {
            pagesQueried++;
            indexer.stop();
            return {
              events: [
                {
                  id: "e1",
                  type: "contract",
                  ledger: 100,
                  ledgerClosedAt: "2026-11-08T00:00:00Z",
                  txHash: "0x1",
                  contractId: "C_POOL",
                  topic: [xdr.ScVal.scvSymbol("deposit")],
                  value: { underlying_amount: 10n, shares_minted: 10n },
                },
                {
                  id: "e2",
                  type: "contract",
                  ledger: 101,
                  ledgerClosedAt: "2026-11-08T00:00:00Z",
                  txHash: "0x2",
                  contractId: "C_POOL",
                  topic: [xdr.ScVal.scvSymbol("deposit")],
                  value: { underlying_amount: 20n, shares_minted: 20n },
                },
              ],
              cursor: "next_cur",
            };
          },
          getLatestLedger: async () => ({ sequence: 1000 }),
        };

        await indexer.pollOnce();
        expect(pagesQueried).toBe(1);
      });
    });
  });
});
