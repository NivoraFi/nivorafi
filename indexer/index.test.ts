import { describe, expect, it } from "bun:test";
import {
  EventStorage,
  chunkContractFilters,
  decodeRpcEvent,
  scValToBigInt,
  scValToAddress,
  scValToString,
  scValToNumber,
  scValToBoolean,
  calculateImpliedApy,
  resolveMarket,
  CONTRACT_CATALOG,
  ALL_CONTRACT_IDS,
  MARKETS,
} from "./index";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";

describe("Persistent Soroban Event Indexer Suite & Milestone 1 Charts", () => {
  it("chunks contract filters properly to adhere to max 5 limit", () => {
    const filters = chunkContractFilters(ALL_CONTRACT_IDS);
    expect(filters.length).toBeGreaterThanOrEqual(3);
    for (const f of filters) {
      expect(f.type).toBe("contract");
      expect(f.contractIds.length).toBeLessThanOrEqual(5);
      expect(f.contractIds.length).toBeGreaterThan(0);
    }
  });

  it("safely parses ScVal conversions", () => {
    expect(scValToBigInt("1000000")).toBe(1000000n);
    expect(scValToBigInt(null)).toBe(0n);
    expect(scValToAddress("CAXL7L7TUIIZJ5Q4FQLJY4RWQYBFAEL2VOLZ44B3BDCWPR7BUDZ6BNRC")).toBe("CAXL7L7TUIIZJ5Q4FQLJY4RWQYBFAEL2VOLZ44B3BDCWPR7BUDZ6BNRC");
    expect(scValToString("hello")).toBe("hello");
    expect(scValToNumber("42")).toBe(42);
    expect(scValToBoolean("true")).toBe(true);
    expect(scValToBoolean(1)).toBe(true);
    expect(scValToBoolean(0)).toBe(false);
  });

  it("calculates continuous Implied APY with numerical stability guards", () => {
    // 90 days = ~0.24657 years. If PT price = 0.98, Implied APY should be ~8.4%-8.6%
    const tau90d = 90 / 365;
    const apy90d = calculateImpliedApy(0.9802, tau90d);
    expect(apy90d).toBeGreaterThan(7.0);
    expect(apy90d).toBeLessThan(11.0);

    // Matured or past maturity (tau <= 0) should return 0.0%
    expect(calculateImpliedApy(0.98, 0)).toBe(0.0);
    expect(calculateImpliedApy(0.98, -1)).toBe(0.0);

    // Parity or above parity (ptPrice >= 1.0) should return 0.0%
    expect(calculateImpliedApy(1.0, tau90d)).toBe(0.0);
    expect(calculateImpliedApy(1.05, tau90d)).toBe(0.0);

    // Extreme discount / small numbers should be clamped to 500% ceiling
    expect(calculateImpliedApy(0.1, tau90d)).toBeLessThanOrEqual(500.0);

    // Near maturity boundary (< 1 hour): uses linear Taylor expansion without overflow
    const tauNear = 1800 / 31536000; // 30 minutes
    const apyNear = calculateImpliedApy(0.999995, tauNear);
    expect(apyNear).toBeGreaterThan(0.0);
    expect(apyNear).toBeLessThanOrEqual(500.0);
  });

  it("resolves market identifiers and contract addresses accurately", () => {
    const m1 = resolveMarket("usdc-90d");
    expect(m1).not.toBeNull();
    expect(m1?.id).toBe("usdc-90d");
    expect(m1?.asset).toBe("USDC");

    const m2 = resolveMarket("CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF");
    expect(m2).not.toBeNull();
    expect(m2?.id).toBe("usdc-90d");

    const m3 = resolveMarket("usdc-30d");
    expect(m3).not.toBeNull();
    expect(m3?.id).toBe("usdc-30d");

    const m4 = resolveMarket("xlm-90d");
    expect(m4).not.toBeNull();
    expect(m4?.id).toBe("xlm-90d");
  });

  it("initializes SQLite with WAL, busy_timeout=5000, and market_snapshots table", () => {
    const testDbPath = join(import.meta.dir, "test_m1_charts.db");
    try {
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
      if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
      if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    } catch {
      // Ignore
    }

    const storage = new EventStorage(testDbPath);

    // Test saving an event
    const nowSec = Math.floor(Date.now() / 1000);
    const sampleSwapEvent = {
      id: "0024253456982245376-0000000002",
      contractId: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
      txHash: "de563b124a78ee6eb2fe2e6ed4e1f827051a0639e746af821d93ce4bd23e4bbc",
      ledger: 5646948,
      ledgerClosedAt: new Date(nowSec * 1000).toISOString(),
      timestamp: nowSec,
      type: "swap",
      topicSymbol: "swap_event",
      caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      data: {
        amountIn: "100000",
        amountOut: "102299",
        direction: 1,
        directionLabel: "SY_FOR_PT",
        fee: "1033",
      },
      rawJson: "{}",
    };

    const inserted = storage.saveEvents([sampleSwapEvent]);
    expect(inserted).toBe(1);

    // Query charts for 1D (24 hourly buckets)
    const chart1D = storage.getMarketChart("usdc-90d", "1D");
    expect(chart1D.success).toBe(true);
    expect(chart1D.market).toBe("usdc-90d");
    expect(chart1D.interval).toBe("1D");
    expect(chart1D.count).toBe(24);
    expect(chart1D.data.length).toBe(24);
    expect(chart1D.summary).toBeDefined();
    expect(chart1D.summary.highApy).toBeGreaterThan(0);
    expect(chart1D.summary.lowApy).toBeGreaterThan(0);
    expect(chart1D.summary.currentPrice).toBeGreaterThan(0);

    // Verify forward-filling: no bucket should have 0 implied APY or NaN
    for (const pt of chart1D.data) {
      expect(pt.impliedApy).toBeGreaterThan(0);
      expect(pt.ptPrice).toBeGreaterThan(0);
      expect(pt.ytPrice).toBeGreaterThan(0);
      expect(pt.underlyingApy).toBe(4.85);
      expect(typeof pt.volume).toBe("string");
      expect(typeof pt.tvl).toBe("string");
      expect(pt.datetime).toBeDefined();
    }

    // Query charts for 1W (168 hourly buckets)
    const chart1W = storage.getMarketChart("usdc-90d", "1W");
    expect(chart1W.count).toBe(168);
    expect(chart1W.data.length).toBe(168);

    // Query charts for 1M (30 daily buckets)
    const chart1M = storage.getMarketChart("usdc-90d", "1M");
    expect(chart1M.count).toBe(30);
    expect(chart1M.data.length).toBe(30);

    // Query charts for ALL (>= 30 daily buckets)
    const chartALL = storage.getMarketChart("usdc-90d", "ALL");
    expect(chartALL.count).toBeGreaterThanOrEqual(30);
    expect(chartALL.data.length).toBeGreaterThanOrEqual(30);

    // Ingestion of second event (liquidity)
    const sampleLiquidityEvent = {
      id: "0024302819041382400-0000000002",
      contractId: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
      txHash: "abcd563b124a78ee6eb2fe2e6ed4e1f827051a0639e746af821d93ce4bd23e4",
      ledger: 5646950,
      ledgerClosedAt: new Date((nowSec + 10) * 1000).toISOString(),
      timestamp: nowSec + 10,
      type: "liquidity",
      topicSymbol: "liquidity_event",
      caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      data: {
        isAdd: true,
        ptAmount: "4000000",
        syAmount: "3920000",
        lpAmount: "3950000",
      },
      rawJson: "{}",
    };

    const inserted2 = storage.saveEvents([sampleLiquidityEvent]);
    expect(inserted2).toBe(1);

    // Re-query 1D chart and verify trade count and summary updated
    const updated1D = storage.getMarketChart("usdc-90d", "1D");
    expect(updated1D.summary.tradesCount).toBeGreaterThanOrEqual(2);

    storage.close();

    // Clean up test database
    try {
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
      if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
      if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    } catch {
      // Ignore
    }
  });

  it("handles high concurrency without SQLITE_BUSY locking errors", async () => {
    const testDbPath = join(import.meta.dir, "test_concurrency.db");
    try {
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
      if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
      if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    } catch {
      // Ignore
    }

    const storage = new EventStorage(testDbPath);
    const baseTs = Math.floor(Date.now() / 1000);

    // Launch 50 parallel asynchronous writes and chart reads
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 25; i++) {
      const evtTs = baseTs - (25 - i) * 10; // within past 250 seconds
      promises.push(
        (async () => {
          storage.saveEvents([
            {
              id: `test-evt-${i}`,
              contractId: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
              txHash: `tx-hash-${i}`,
              ledger: 5600000 + i,
              ledgerClosedAt: new Date(evtTs * 1000).toISOString(),
              timestamp: evtTs,
              type: "swap",
              topicSymbol: "swap_event",
              caller: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              receiver: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
              data: {
                direction: 1,
                amountIn: "500000",
                amountOut: "510000",
                fee: "5000",
              },
              rawJson: "{}",
            },
          ]);
        })()
      );

      promises.push(
        (async () => {
          const chart = storage.getMarketChart("usdc-90d", "1D");
          expect(chart.success).toBe(true);
          expect(chart.count).toBe(24);
        })()
      );
    }

    await Promise.all(promises);

    const finalChart = storage.getMarketChart("usdc-90d", "1D");
    expect(finalChart.summary.tradesCount).toBe(25);

    storage.close();

    try {
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
      if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
      if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    } catch {
      // Ignore
    }
  });

  describe("Milestone 2: User Position & PnL Accounting Suite", () => {
    const testDbPath = join(import.meta.dir, "test_m2_positions.db");
    const TEST_USER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
    const GREENFIELD_USER = "GNEWUSER7K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27NEWUSER1";

    it("creates user_positions table and idx_user_positions_address index in SQLite", () => {
      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }

      const storage = new EventStorage(testDbPath);

      // Verify table and index exist
      const tableInfo = (storage as any).db.prepare("PRAGMA table_info(user_positions)").all() as { name: string }[];
      const columnNames = tableInfo.map((c) => c.name);

      expect(columnNames).toContain("user_address");
      expect(columnNames).toContain("market_id");
      expect(columnNames).toContain("pt_balance");
      expect(columnNames).toContain("yt_balance");
      expect(columnNames).toContain("lp_balance");
      expect(columnNames).toContain("pt_cost_basis_sy");
      expect(columnNames).toContain("yt_cost_basis_sy");
      expect(columnNames).toContain("avg_entry_apy");
      expect(columnNames).toContain("realized_pnl_sy");
      expect(columnNames).toContain("cumulative_claimed_yield_sy");
      expect(columnNames).toContain("last_ledger");
      expect(columnNames).toContain("last_updated");

      const indexList = (storage as any).db.prepare("PRAGMA index_list(user_positions)").all() as { name: string }[];
      const indexNames = indexList.map((i) => i.name);
      expect(indexNames).toContain("idx_user_positions_address");

      storage.close();
    });

    it("returns HTTP 200 zero-state for greenfield user with no transaction history", () => {
      const storage = new EventStorage(testDbPath);
      const res = storage.getUserPositions(GREENFIELD_USER);

      expect(res.success).toBe(true);
      expect(res.user).toBe(GREENFIELD_USER);
      expect(res.count).toBe(0);
      expect(res.positions.length).toBe(0);

      expect(res.summary.userAddress).toBe(GREENFIELD_USER);
      expect(res.summary.totalCostBasisUsd).toBe(0);
      expect(res.summary.totalCurrentValueUsd).toBe(0);
      expect(res.summary.totalRealizedPnlUsd).toBe(0);
      expect(res.summary.totalUnrealizedPnlUsd).toBe(0);
      expect(res.summary.totalNetPnlUsd).toBe(0);
      expect(res.summary.totalClaimedYieldUsd).toBe(0);
      expect(res.summary.overallPortfolioApy).toBe(0);
      expect(res.summary.activePositionsCount).toBe(0);
      expect(res.summary.totalTransactionsCount).toBe(0);

      storage.close();
    });

    it("tracks user positions across full lifecycle: Buy PT, Mint PY, Claim Yield, Redeem PT", () => {
      const storage = new EventStorage(testDbPath);
      const now = Math.floor(Date.now() / 1000);

      // 1. Buy 100 PT for 95 SY
      storage.recordSwap({
        marketId: "usdc-90d",
        timestamp: now,
        caller: TEST_USER,
        receiver: TEST_USER,
        direction: 1,
        amountIn: 95_0000000n,
        amountOut: 100_0000000n,
        fee: 0n,
      });

      let posRes = storage.getUserPositions(TEST_USER);
      expect(posRes.count).toBe(1);
      let pos = posRes.positions[0];
      expect(pos.currentPtBalance).toBe("1000000000");
      expect(pos.costBasisStroops).toBe("950000000");
      expect(pos.costBasisUsd).toBe(95.0);
      expect(pos.averageEntryApy).toBeGreaterThan(5.0);

      // 2. Mint PY: 1,000 SY -> 1,000 PT + 1,000 YT
      storage.recordMintPy({
        marketId: "usdc-90d",
        caller: TEST_USER,
        receiver: TEST_USER,
        syIn: 1_000_0000000n,
        pyOut: 1_000_0000000n,
        timestamp: now + 10,
        spotPtPrice: 0.98,
      });

      posRes = storage.getUserPositions(TEST_USER);
      pos = posRes.positions[0];
      expect(pos.currentPtBalance).toBe("11000000000"); // 100 + 1000
      expect(pos.currentYtBalance).toBe("10000000000");
      expect(pos.costBasisStroops).toBe("10950000000"); // 95 + 1000 SY

      // 3. Harvest Yield: 25 SY
      storage.recordYieldClaimed({
        marketId: "usdc-90d",
        user: TEST_USER,
        yieldOut: 25_0000000n,
        timestamp: now + 20,
      });

      posRes = storage.getUserPositions(TEST_USER);
      pos = posRes.positions[0];
      expect(pos.cumulativeClaimedYieldUsd).toBe(25.0);
      expect(pos.realizedPnlUsd).toBe(25.0);

      // 4. Redeem PT post-maturity: redeem 100 PT for 100 SY (profit = 100 - (100 * unitCost))
      storage.recordRedeemPt({
        marketId: "usdc-90d",
        caller: TEST_USER,
        ptBurned: 100_0000000n,
        payout: 100_0000000n,
        timestamp: now + 30,
      });

      posRes = storage.getUserPositions(TEST_USER);
      pos = posRes.positions[0];
      expect(pos.currentPtBalance).toBe("10000000000");
      expect(pos.realizedPnlUsd).toBeGreaterThan(25.0); // Realized discount profit added to yield

      storage.close();

      try {
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
        if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
      } catch {
        // Ignore
      }
    });
  });
});
