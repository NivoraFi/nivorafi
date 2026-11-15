// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import {
  deriveImpliedApyHistory,
  deriveTvlMetrics,
  deriveUserTransactionHistory,
  deriveVolumeMetrics,
  extractSwapApy,
  generateApySparkline,
} from "../analytics";
import { ProtocolEvent, SwapEventParsed } from "../indexer";

describe("Historical Analytics & Metrics Derivation Engine Suite", () => {
  const SECONDS_PER_YEAR = 31536000;

  describe("1. Implied APY Derivation (T-APY-01 .. T-APY-07)", () => {
    it("T-APY-01: calculates standard 90D trade APY (P_PT = 0.95, tau = 0.25 years)", () => {
      // 90 days = 7,776,000 seconds
      const now = 1000000;
      const maturity = now + 7776000;
      // Direction 1 (SY -> PT): 95 SY in, 100 PT out (P_PT = 0.95)
      const res = extractSwapApy(1, 95000000n, 100000000n, 0n, now, maturity);
      expect(res.ptPriceInSy).toBeCloseTo(0.95, 2);
      expect(res.tauYears).toBeCloseTo(7776000 / SECONDS_PER_YEAR, 4);
      // Compounded APY: ( (1 / 0.95)^(31536000 / 7776000) - 1 ) * 100 ~ 22.77%
      expect(res.impliedApyPct).toBeGreaterThan(20);
      expect(res.impliedApyPct).toBeLessThan(25);
    });

    it("T-APY-02: maintains price derivation symmetry across Direction 0 (PT->SY) and Direction 1 (SY->PT)", () => {
      const now = 1000000;
      const maturity = now + 15552000; // 180 days

      // Direction 0: 100 PT in, 95 SY out (fee 0) -> P_PT = 95 / 100 = 0.95
      const dir0 = extractSwapApy(0, 100000000n, 95000000n, 0n, now, maturity);
      // Direction 1: 95 SY in, 100 PT out (fee 0) -> P_PT = 95 / 100 = 0.95
      const dir1 = extractSwapApy(1, 95000000n, 100000000n, 0n, now, maturity);

      expect(dir0.ptPriceInSy).toBeCloseTo(dir1.ptPriceInSy, 4);
      expect(dir0.impliedApyPct).toBeCloseTo(dir1.impliedApyPct, 2);
    });

    it("T-APY-03: derives P_PT = 1 - P_YT correctly for Direction 2 (SY->YT)", () => {
      const now = 1000000;
      const maturity = now + 7776000;
      // 5 SY in, 100 YT out -> P_YT = 5 / 100 = 0.05 -> P_PT = 0.95
      const res = extractSwapApy(2, 5000000n, 100000000n, 0n, now, maturity);
      expect(res.ptPriceInSy).toBeCloseTo(0.95, 2);
      expect(res.impliedApyPct).toBeGreaterThan(20);
    });

    it("T-APY-04: strictly returns 0.0% APY post-maturity (t >= T)", () => {
      const maturity = 1000000;
      const now = 1000000; // exact maturity
      const past = 1000050; // post maturity

      const resAtMaturity = extractSwapApy(1, 95000000n, 100000000n, 0n, now, maturity);
      expect(resAtMaturity.impliedApyPct).toBe(0);

      const resPostMaturity = extractSwapApy(1, 95000000n, 100000000n, 0n, past, maturity);
      expect(resPostMaturity.impliedApyPct).toBe(0);
    });

    it("T-APY-05: near-maturity (< 1 hour) switches to linear APR without numerical overflow", () => {
      const now = 1000000;
      const maturity = now + 1800; // 30 minutes remaining
      const res = extractSwapApy(1, 99990000n, 100000000n, 0n, now, maturity);
      expect(res.tauYears).toBeLessThan(3600 / SECONDS_PER_YEAR);
      expect(res.impliedApyPct).toBeGreaterThan(0);
      expect(isFinite(res.impliedApyPct)).toBe(true);
      expect(isNaN(res.impliedApyPct)).toBe(false);
      expect(res.impliedApyPct).toBeLessThanOrEqual(500.0);
    });

    it("T-APY-06: clamps negative yield (P_PT >= 1.0) strictly to 0.0% APY", () => {
      const now = 1000000;
      const maturity = now + 7776000;
      // 105 SY in for 100 PT out -> P_PT = 1.05 > 1.0 (negative yield)
      const res = extractSwapApy(1, 105000000n, 100000000n, 0n, now, maturity);
      expect(res.ptPriceInSy).toBe(1.05);
      expect(res.impliedApyPct).toBe(0.0);
    });

    it("T-APY-07: clamps extreme deep discount (P_PT <= 0.5) to 500% ceiling", () => {
      const now = 1000000;
      const maturity = now + 7776000;
      // 10 SY in for 100 PT out -> P_PT = 0.10 (massive discount)
      const res = extractSwapApy(1, 10000000n, 100000000n, 0n, now, maturity);
      expect(res.impliedApyPct).toBe(500.0);
    });

    it("handles zero amounts gracefully without crashing", () => {
      const res = extractSwapApy(1, 0n, 0n, 0n, 100, 200);
      expect(res.impliedApyPct).toBe(0);
      expect(res.ptPriceInSy).toBe(1.0);
    });

    it("deriveImpliedApyHistory generates sorted chronological series and filters non-swaps", () => {
      const maturity = 1000000;
      const events: ProtocolEvent[] = [
        {
          id: "e2",
          contractId: "C1",
          txHash: "tx2",
          ledger: 200,
          ledgerClosedAt: "",
          timestamp: 850000,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: 9500000n,
          amountOut: 10000000n,
          fee: 0n,
        },
        {
          id: "e1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "",
          timestamp: 800000,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 0,
          directionLabel: "PT_FOR_SY",
          amountIn: 10000000n,
          amountOut: 9600000n,
          fee: 0n,
        },
        {
          id: "e3",
          contractId: "C1",
          txHash: "tx3",
          ledger: 150,
          ledgerClosedAt: "",
          timestamp: 820000,
          type: "deposit",
          topicSymbol: "deposit",
          underlyingAmount: 1000n,
          sharesMinted: 1000n,
        } as ProtocolEvent,
      ];

      const history = deriveImpliedApyHistory(events, maturity);
      expect(history.length).toBe(2);
      expect(history[0].timestamp).toBe(800000);
      expect(history[1].timestamp).toBe(850000);
      expect(history[0].impliedApyPct).toBeGreaterThan(0);
      expect(history[1].impliedApyPct).toBeGreaterThan(0);
    });
  });

  describe("2. Volume Aggregation (T-VOL-01 .. T-VOL-05)", () => {
    it("T-VOL-01: aggregates Direction 0, 1, 2, 3 swap volumes normalized to SY", () => {
      const now = 200000;
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 10,
          ledgerClosedAt: "",
          timestamp: now - 1000,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 0, // PT->SY: volume is out + fee = 100 + 5 = 105
          directionLabel: "PT_FOR_SY",
          amountIn: 110n,
          amountOut: 100n,
          fee: 5n,
        },
        {
          id: "2",
          contractId: "C1",
          txHash: "tx2",
          ledger: 11,
          ledgerClosedAt: "",
          timestamp: now - 500,
          type: "swap",
          topicSymbol: "swap",
          caller: "G2",
          receiver: "G2",
          direction: 1, // SY->PT: volume is in = 200
          directionLabel: "SY_FOR_PT",
          amountIn: 200n,
          amountOut: 210n,
          fee: 2n,
        },
      ];

      const metrics = deriveVolumeMetrics(events, now);
      expect(metrics.totalVolumeStroops).toBe(305n);
      expect(metrics.volume24hStroops).toBe(305n);
      expect(metrics.totalSwapCount).toBe(2);
      expect(metrics.uniqueTradersCount).toBe(2);
    });

    it("T-VOL-02: incorporates mint_py_event volume into total and 24h volume", () => {
      const now = 200000;
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 10,
          ledgerClosedAt: "",
          timestamp: now - 100,
          type: "mint_py",
          topicSymbol: "mint_py",
          caller: "G1",
          receiver: "G1",
          syIn: 50000000n,
          pyOut: 50000000n,
        },
      ];

      const metrics = deriveVolumeMetrics(events, now);
      expect(metrics.totalVolumeStroops).toBe(50000000n);
      expect(metrics.volume24hStroops).toBe(50000000n);
      expect(metrics.totalMintCount).toBe(1);
    });

    it("T-VOL-03: excludes events older than 24h from volume24h but includes them in totalVolume", () => {
      const now = 200000;
      const oldTime = now - 100000; // > 86400s ago
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 5,
          ledgerClosedAt: "",
          timestamp: oldTime,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: 1000n,
          amountOut: 1050n,
          fee: 0n,
        },
        {
          id: "2",
          contractId: "C1",
          txHash: "tx2",
          ledger: 10,
          ledgerClosedAt: "",
          timestamp: now - 3600, // 1h ago
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: 500n,
          amountOut: 520n,
          fee: 0n,
        },
      ];

      const metrics = deriveVolumeMetrics(events, now);
      expect(metrics.totalVolumeStroops).toBe(1500n);
      expect(metrics.volume24hStroops).toBe(500n);
    });

    it("T-VOL-04: handles 24h percentage delta with zero baseline gracefully (+100%)", () => {
      const now = 200000;
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 10,
          ledgerClosedAt: "",
          timestamp: now - 3600,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: 1000n,
          amountOut: 1050n,
          fee: 0n,
        },
      ];

      const metrics = deriveVolumeMetrics(events, now);
      expect(metrics.volumePrev24hStroops).toBe(0n);
      expect(metrics.volume24hStroops).toBe(1000n);
      expect(metrics.change24hPct).toBe(100);
    });

    it("T-VOL-05: returns 0 volume and 0% change on empty event stream", () => {
      const metrics = deriveVolumeMetrics([]);
      expect(metrics.totalVolumeStroops).toBe(0n);
      expect(metrics.volume24hStroops).toBe(0n);
      expect(metrics.change24hPct).toBe(0);
      expect(metrics.totalSwapCount).toBe(0);
    });
  });

  describe("3. TVL Calculation & Conservation (T-TVL-01 .. T-TVL-04)", () => {
    it("T-TVL-01: Deposit (100) -> Redeem (30) computes exact net 70 TVL", () => {
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C_SY",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "",
          timestamp: 1000,
          type: "deposit",
          topicSymbol: "deposit",
          caller: "G1",
          receiver: "G1",
          underlyingAmount: 100n,
          sharesMinted: 100n,
        },
        {
          id: "2",
          contractId: "C_SY",
          txHash: "tx2",
          ledger: 101,
          ledgerClosedAt: "",
          timestamp: 1050,
          type: "redeem",
          topicSymbol: "redeem",
          caller: "G1",
          receiver: "G1",
          sharesBurned: 30n,
          assetsOut: 30n,
        },
      ];

      const tvl = deriveTvlMetrics(events);
      expect(tvl.length).toBe(2);
      expect(tvl[0].protocolTvlStroops).toBe(100n);
      expect(tvl[1].protocolTvlStroops).toBe(70n);
    });

    it("T-TVL-02: Blend exchange rate multiplier scales protocol TVL upwards", () => {
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C_SY",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "",
          timestamp: 1000,
          type: "deposit",
          topicSymbol: "deposit",
          caller: "G1",
          receiver: "G1",
          underlyingAmount: 100n,
          sharesMinted: 100n,
        },
      ];

      // 1.10 exchange rate: 1.10 * 1e18
      const blendRate110 = 1_100_000_000_000_000_000n;
      const tvl = deriveTvlMetrics(events, blendRate110);
      expect(tvl[0].protocolTvlStroops).toBe(110n);
    });

    it("T-TVL-03: Liquidity add/remove updates ammTvlStroops accurately", () => {
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C_POOL",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "",
          timestamp: 1000,
          type: "liquidity",
          topicSymbol: "liquidity",
          caller: "G1",
          receiver: "G1",
          isAdd: true,
          ptAmount: 100n,
          syAmount: 100n,
          lpAmount: 100n,
        },
      ];

      const tvl = deriveTvlMetrics(events);
      expect(tvl.length).toBe(1);
      // SY reserve (100) + PT reserve (100 * default price 1.0) = 200
      expect(tvl[0].ammTvlStroops).toBe(200n);
    });

    it("T-TVL-04: Minting PY does not double count into canonical vault TVL", () => {
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C_SY",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "",
          timestamp: 1000,
          type: "deposit",
          topicSymbol: "deposit",
          caller: "G1",
          receiver: "G1",
          underlyingAmount: 100n,
          sharesMinted: 100n,
        },
        {
          id: "2",
          contractId: "C_POOL",
          txHash: "tx2",
          ledger: 101,
          ledgerClosedAt: "",
          timestamp: 1050,
          type: "mint_py",
          topicSymbol: "mint_py",
          caller: "G1",
          receiver: "G1",
          syIn: 100n,
          pyOut: 100n,
        },
      ];

      const tvl = deriveTvlMetrics(events);
      // Protocol TVL remains 100, not 200
      expect(tvl.length).toBe(1); // mint_py does not modify SY vault shares
      expect(tvl[0].protocolTvlStroops).toBe(100n);
    });
  });

  describe("4. User Transaction History Filtering (T-USR-01 .. T-USR-05)", () => {
    const user = "GAWWVH7D2S4QJMBQHKZPQ4Z2I7E7N6A4QME27";
    const otherUser = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQ";

    it("T-USR-01: filters events where user is caller", () => {
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1000,
          type: "swap",
          topicSymbol: "swap",
          caller: user,
          receiver: otherUser,
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: 10000000n,
          amountOut: 10200000n,
          fee: 5000n,
        },
      ];

      const history = deriveUserTransactionHistory(events, user, 1060);
      expect(history.length).toBe(1);
      expect(history[0].actionType).toBe("SWAP_SY_FOR_PT");
      expect(history[0].badge.label).toBe("Buy PT");
      expect(history[0].badge.variant).toBe("cyan");
      expect(history[0].relativeTime).toBe("1m ago");
    });

    it("T-USR-02: filters events where user is receiver (e.g. third-party recipient)", () => {
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1000,
          type: "deposit",
          topicSymbol: "deposit",
          caller: otherUser,
          receiver: user,
          underlyingAmount: 50000000n,
          sharesMinted: 50000000n,
        },
      ];

      const history = deriveUserTransactionHistory(events, user);
      expect(history.length).toBe(1);
      expect(history[0].actionType).toBe("DEPOSIT_SY");
      expect(history[0].badge.label).toBe("Deposit");
    });

    it("T-USR-03: excludes transactions where user is neither caller nor receiver", () => {
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1000,
          type: "swap",
          topicSymbol: "swap",
          caller: otherUser,
          receiver: otherUser,
          direction: 0,
          directionLabel: "PT_FOR_SY",
          amountIn: 10000000n,
          amountOut: 9800000n,
          fee: 5000n,
        },
      ];

      const history = deriveUserTransactionHistory(events, user);
      expect(history.length).toBe(0);
    });

    it("T-USR-04: formats rollover and yield claim events accurately with explorer links", () => {
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C_FACTORY",
          txHash: "tx_roll",
          ledger: 150,
          ledgerClosedAt: "2026-11-08T00:00:00Z",
          timestamp: 1000,
          type: "rollover",
          topicSymbol: "rollover",
          user: user,
          sourcePool: "C_SRC",
          targetPool: "C_TGT",
          ptBurned: 10000000n,
          syReceived: 10000000n,
          targetPtMinted: 10450000n,
        },
      ];

      const history = deriveUserTransactionHistory(events, user);
      expect(history.length).toBe(1);
      expect(history[0].actionType).toBe("ROLLOVER");
      expect(history[0].badge.label).toBe("Rollover");
      expect(history[0].explorerUrl).toBe("https://stellar.expert/explorer/testnet/tx/tx_roll");
    });

    it("T-USR-05: returns empty array if user address is empty or whitespace", () => {
      expect(deriveUserTransactionHistory([], "")).toEqual([]);
      expect(deriveUserTransactionHistory([], "   ")).toEqual([]);
    });
  });

  describe("5. Sparkline Generation (generateApySparkline)", () => {
    it("generates bucketCount points across the 24h horizon", () => {
      const now = 200000;
      const maturity = now + 7776000;
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 100,
          ledgerClosedAt: "",
          timestamp: now - 3600,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: 9500000n,
          amountOut: 10000000n,
          fee: 0n,
        },
      ];

      const buckets = generateApySparkline(events, maturity, 24, now);
      expect(buckets.length).toBe(24);
      for (const b of buckets) {
        expect(typeof b.timestamp).toBe("number");
        expect(typeof b.value).toBe("number");
        expect(b.value).toBeGreaterThan(0);
      }
    });
  });
});
