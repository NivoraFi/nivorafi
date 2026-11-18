import { describe, expect, it } from "bun:test";
import {
  EventStorage,
  PersistentIndexer,
  chunkContractFilters,
  decodeRpcEvent,
  scValToBigInt,
  scValToAddress,
  scValToString,
  scValToNumber,
  scValToBoolean,
  calculateImpliedApy,
  resolveMarket,
  resolveHttpPort,
  startHttpServer,
  HTTP_PORT,
  CONTRACT_CATALOG,
  ALL_CONTRACT_IDS,
  MARKETS,
} from "./index";
import { unlinkSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
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
    expect(m4?.factoryId).toBe(3);
    expect(m4?.poolId).toBe("CAQ24DFWIZ4GHS6ES6DX236R5EYMMS3DF3BBZE63NKEDGRGO4B7IRTZ4");
    expect(m4?.maturity).toBe(1801909056);
    expect(m4?.assetPriceUsd).toBe(0.12);
    expect(m4?.underlyingApy).toBe(3.2);

    const m5 = resolveMarket("CAQ24DFWIZ4GHS6ES6DX236R5EYMMS3DF3BBZE63NKEDGRGO4B7IRTZ4");
    expect(m5?.id).toBe("xlm-90d");

    const m6 = resolveMarket("usdc-matured");
    expect(m6).not.toBeNull();
    expect(m6?.id).toBe("usdc-matured");
    expect(m6?.factoryId).toBe(4);
    expect(m6?.poolId).toBe("CASJWZ7LPCGL2QRVOQNXLH4NYX556XW5GB5BX73K6VC7M2L354DQOMH5");
    expect(m6?.maturity).toBe(1794455723);
    expect(m6?.tenor).toBe("MATURED");

    const m7 = resolveMarket("CASJWZ7LPCGL2QRVOQNXLH4NYX556XW5GB5BX73K6VC7M2L354DQOMH5");
    expect(m7?.id).toBe("usdc-matured");

    const m8 = resolveMarket("usdc-slender-90d");
    expect(m8).not.toBeNull();
    expect(m8?.id).toBe("usdc-slender-90d");
    expect(m8?.factoryId).toBe(5);
    expect(m8?.poolId).toBe("CACPNCMRPCYXT2IFNAIYY7DVTZARI2HFKIFMX2LBUTJ3YU6Z6QVBQDC5");
    expect(m8?.syId).toBe("CA5Q7BXAPRO3XULUEDTFVFZU2ZU2N7Z6CLZNQW7WDDKVJV6776DGHPCJ");
    expect(m8?.maturity).toBe(1801909057);
    expect(m8?.assetPriceUsd).toBe(1.0);

    const m9 = resolveMarket("CACPNCMRPCYXT2IFNAIYY7DVTZARI2HFKIFMX2LBUTJ3YU6Z6QVBQDC5");
    expect(m9?.id).toBe("usdc-slender-90d");

    expect(HTTP_PORT).toBeGreaterThan(0);
    expect(resolveHttpPort(undefined)).toBe(8765);
    expect(resolveHttpPort("9001")).toBe(9001);
    expect(resolveHttpPort("invalid")).toBe(8765);
    expect(resolveHttpPort("0")).toBe(8765);
  });

  it("returns honest empty chart data when a market has zero indexed events", () => {
    const emptyDbPath = join(import.meta.dir, "test_empty_charts.db");
    try {
      if (existsSync(emptyDbPath)) unlinkSync(emptyDbPath);
      if (existsSync(`${emptyDbPath}-wal`)) unlinkSync(`${emptyDbPath}-wal`);
      if (existsSync(`${emptyDbPath}-shm`)) unlinkSync(`${emptyDbPath}-shm`);
    } catch {
      // Ignore
    }

    const storage = new EventStorage(emptyDbPath);
    for (const marketId of ["usdc-90d", "usdc-30d", "xlm-90d", "usdc-matured", "usdc-slender-90d"]) {
      const emptyChart = storage.getMarketChart(marketId, "1D");
      expect(emptyChart.success).toBe(true);
      expect(emptyChart.market).toBe(marketId);
      expect(emptyChart.count).toBe(0);
      expect(emptyChart.data).toEqual([]);
      expect(emptyChart.summary.currentApy).toBe(0);
      expect(emptyChart.summary.currentPrice).toBe(0);
      expect(emptyChart.summary.currentTvl).toBe("0");
      expect(emptyChart.summary.tradesCount).toBe(0);
    }
    storage.close();

    try {
      if (existsSync(emptyDbPath)) unlinkSync(emptyDbPath);
      if (existsSync(`${emptyDbPath}-wal`)) unlinkSync(`${emptyDbPath}-wal`);
      if (existsSync(`${emptyDbPath}-shm`)) unlinkSync(`${emptyDbPath}-shm`);
    } catch {
      // Ignore
    }
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

    // Test saving an event (anchored mid-hour to avoid UTC :59:50 -> :00:00 bucket boundary flake)
    const nowSec = Math.floor(Date.now() / 3600000) * 3600 + 1800;
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
      expect(pos).toBeDefined();
      if (!pos) throw new Error("Expected position after swap");
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
      expect(pos).toBeDefined();
      if (!pos) throw new Error("Expected position after mint_py");
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
      expect(pos).toBeDefined();
      if (!pos) throw new Error("Expected position after yield_claimed");
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
      expect(pos).toBeDefined();
      if (!pos) throw new Error("Expected position after redeem_pt");
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

    it("scales swap prices by PyIndex and prevents pre-swap non-swap events from writing open_price=0", () => {
      const m5DbPath = join(import.meta.dir, "test_m5_pyindex.db");
      try {
        if (existsSync(m5DbPath)) unlinkSync(m5DbPath);
        if (existsSync(`${m5DbPath}-wal`)) unlinkSync(`${m5DbPath}-wal`);
        if (existsSync(`${m5DbPath}-shm`)) unlinkSync(`${m5DbPath}-shm`);
      } catch {
        // Ignore
      }

      const storage = new EventStorage(m5DbPath);
      const now = Math.floor(Date.now() / 1000);
      const slenderPool = "CACPNCMRPCYXT2IFNAIYY7DVTZARI2HFKIFMX2LBUTJ3YU6Z6QVBQDC5";
      const slenderSy = "CA5Q7BXAPRO3XULUEDTFVFZU2ZU2N7Z6CLZNQW7WDDKVJV6776DGHPCJ";

      // 1. Pre-swap deposit must NOT poison open_price / low_price with 0
      storage.saveEvents([
        {
          id: "pre-swap-deposit-1",
          contractId: slenderSy,
          txHash: "tx-pre-deposit",
          ledger: 1001,
          ledgerClosedAt: new Date(now * 1000).toISOString(),
          timestamp: now,
          type: "deposit",
          topicSymbol: "deposit_event",
          caller: TEST_USER,
          receiver: TEST_USER,
          data: { underlyingAmount: "100000000", sharesMinted: "80000000" },
          rawJson: "{}",
        },
      ]);
      expect(storage.getMarketChart("usdc-slender-90d", "1D").count).toBe(0);

      // 2. Rate update to PyIndex = 1.25e9 followed by swap in the same bucket:
      // 0.8 SY in (= 1.0 asset at 1.25) buys 1.04 PT -> ptPrice = 1.0 / 1.04 ~= 0.9615
      storage.saveEvents([
        {
          id: "rate-update-1",
          contractId: slenderSy,
          txHash: "tx-rate",
          ledger: 1002,
          ledgerClosedAt: new Date((now + 1) * 1000).toISOString(),
          timestamp: now + 1,
          type: "rate_updated",
          topicSymbol: "rate_updated_event",
          caller: TEST_USER,
          receiver: TEST_USER,
          data: { newRate: "1250000000" },
          rawJson: "{}",
        },
        {
          id: "swap-pyindex-1",
          contractId: slenderPool,
          txHash: "tx-swap-pyidx",
          ledger: 1003,
          ledgerClosedAt: new Date((now + 2) * 1000).toISOString(),
          timestamp: now + 2,
          type: "swap",
          topicSymbol: "swap_event",
          caller: TEST_USER,
          receiver: TEST_USER,
          data: {
            direction: 1,
            amountIn: "8000000",
            amountOut: "10400000",
            fee: "0",
          },
          rawJson: "{}",
        },
      ]);

      const chart = storage.getMarketChart("usdc-slender-90d", "1D");
      expect(chart.count).toBe(24);
      const latest = chart.data[chart.data.length - 1]!;
      expect(latest.open).toBeGreaterThan(0.95);
      expect(latest.low).toBeGreaterThan(0.95);
      expect(latest.ptPrice).toBeCloseTo(1 / 1.04, 3);
      expect(chart.summary.currentPrice).toBeCloseTo(1 / 1.04, 3);

      storage.close();
      try {
        if (existsSync(m5DbPath)) unlinkSync(m5DbPath);
        if (existsSync(`${m5DbPath}-wal`)) unlinkSync(`${m5DbPath}-wal`);
        if (existsSync(`${m5DbPath}-shm`)) unlinkSync(`${m5DbPath}-shm`);
      } catch {
        // Ignore
      }
    });

    it("persists pyIndex across DB reopen on non-empty snapshots and fetches get_py_index via RPC", async () => {
      const reopenDbPath = join(import.meta.dir, "test_m5_reopen_pyindex.db");
      try {
        if (existsSync(reopenDbPath)) unlinkSync(reopenDbPath);
        if (existsSync(`${reopenDbPath}-wal`)) unlinkSync(`${reopenDbPath}-wal`);
        if (existsSync(`${reopenDbPath}-shm`)) unlinkSync(`${reopenDbPath}-shm`);
      } catch {
        // Ignore
      }

      const m = MARKETS["usdc-slender-90d"]!;
      const ts = Math.floor(Date.now() / 1000 / 3600) * 3600;
      const s1 = new EventStorage(reopenDbPath);
      s1.saveEvents([
        {
          id: "r1",
          contractId: m.blendPoolId,
          txHash: "txr",
          ledger: 1,
          ledgerClosedAt: new Date(ts * 1000).toISOString(),
          timestamp: ts,
          type: "rate_updated",
          topicSymbol: "rate_updated_event",
          caller: "",
          receiver: "",
          data: { newRate: "1250000000" },
          rawJson: "{}",
        },
      ]);
      s1.recordSwap({
        eventId: "sw1",
        marketId: "usdc-slender-90d",
        timestamp: ts + 10,
        caller: TEST_USER,
        receiver: TEST_USER,
        direction: 1,
        amountIn: 760_0000000n,
        amountOut: 980_0000000n,
        fee: 20_0000000n,
      });
      s1.close();

      const s2 = new EventStorage(reopenDbPath);
      expect(s2.getMarketPyIndex("usdc-slender-90d")).toBe(1_250_000_000n);

      const { nativeToScVal } = await import("@stellar/stellar-sdk");
      const mockRpcServer = Bun.serve({
        port: 0,
        fetch: async (req) => {
          const body = (await req.json()) as { id: number; method: string };
          if (body.method === "simulateTransaction") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                latestLedger: 999,
                minResourceFee: "100",
                transactionData: "",
                events: [],
                results: [
                  {
                    xdr: nativeToScVal(1_310_000_000n, { type: "i128" }).toXDR("base64"),
                    auth: [],
                  },
                ],
              },
            });
          }
          return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
        },
      });

      try {
        const idx = new PersistentIndexer(s2, `http://127.0.0.1:${mockRpcServer.port}`);
        await idx.syncMarketPyIndices();
        expect(s2.getMarketPyIndex("usdc-slender-90d")).toBe(1_310_000_000n);
      } finally {
        mockRpcServer.stop(true);
      }
      s2.close();

      const s3 = new EventStorage(reopenDbPath);
      expect(s3.getMarketPyIndex("usdc-slender-90d")).toBe(1_310_000_000n);
      s3.close();

      try {
        if (existsSync(reopenDbPath)) unlinkSync(reopenDbPath);
        if (existsSync(`${reopenDbPath}-wal`)) unlinkSync(`${reopenDbPath}-wal`);
        if (existsSync(`${reopenDbPath}-shm`)) unlinkSync(`${reopenDbPath}-shm`);
      } catch {
        // Ignore
      }
    });

    it("does not double-count volumeTotal or tradesCount when zap_in and inner swap arrive in either order", () => {
      const orders = [
        ["swap_first", ["swap", "zap"]],
        ["zap_first", ["zap", "swap"]],
      ] as const;

      const factoryId = "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL";
      const m = MARKETS["usdc-slender-90d"]!;
      const ts = Math.floor(Date.now() / 1000 / 3600) * 3600;

      for (const [label, order] of orders) {
        const dbPath = join(import.meta.dir, `test_m5_zap_dedup_${label}.db`);
        try {
          if (existsSync(dbPath)) unlinkSync(dbPath);
          if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
          if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
        } catch {
          // Ignore
        }

        const storage = new EventStorage(dbPath);
        const swapEvt = {
          id: `swap-${label}`,
          contractId: m.poolId,
          txHash: `tx-zap-${label}`,
          ledger: 2001,
          ledgerClosedAt: new Date(ts * 1000).toISOString(),
          timestamp: ts,
          type: "swap",
          topicSymbol: "swap_event",
          caller: TEST_USER,
          receiver: TEST_USER,
          data: {
            direction: 1,
            amountIn: "100000000",
            amountOut: "104000000",
            fee: "500000",
          },
          rawJson: "{}",
        };
        const zapEvt = {
          id: `zap-${label}`,
          contractId: factoryId,
          txHash: `tx-zap-${label}`,
          ledger: 2001,
          ledgerClosedAt: new Date(ts * 1000).toISOString(),
          timestamp: ts,
          type: "zap_in",
          topicSymbol: "zap_in_event",
          caller: TEST_USER,
          receiver: TEST_USER,
          data: {
            pool: m.poolId,
            mode: 0,
            underlyingAmount: "100000000",
            syAmount: "100000000",
            outAmount: "104000000",
            residualSy: "0",
          },
          rawJson: "{}",
        };

        const batch = order[0] === "swap" ? [swapEvt, zapEvt] : [zapEvt, swapEvt];
        const inserted = storage.saveEvents(batch);
        expect(inserted).toBe(2);

        const chart = storage.getMarketChart("usdc-slender-90d", "1D");
        expect(chart.summary.volumeTotal).toBe("100000000");
        expect(chart.summary.tradesCount).toBe(1);
        expect(chart.summary.currentTvl).toBe("0");

        storage.close();
        try {
          if (existsSync(dbPath)) unlinkSync(dbPath);
          if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
          if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
        } catch {
          // Ignore
        }
      }
    });
  });

  describe("Tier 5 — Suite A: Indexer Adversarial Hardening", () => {
    const tempDirs: string[] = [];

    function createTempDbPath(): string {
      const dir = mkdtempSync(join(tmpdir(), "idx-t5-"));
      tempDirs.push(dir);
      return join(dir, "events.db");
    }

    function cleanupTempDirs(): void {
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()!;
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("rejects NaN query params with 400 and clamps negative limit/offset on /events and /analytics/sparkline without 500", async () => {
      // Arrange
      const dbPath = createTempDbPath();
      const storage = new EventStorage(dbPath);
      const indexer = new PersistentIndexer(storage, "http://127.0.0.1:1");
      const prevPort = process.env.INDEXER_PORT;
      const prevSecret = process.env.INDEXER_API_SECRET;
      process.env.INDEXER_PORT = "0";
      const server = startHttpServer(storage, indexer, 0);
      const baseUrl = `http://127.0.0.1:${server.port}`;

      try {
        // Act
        const resNanEvents = await fetch(`${baseUrl}/events?limit=abc&offset=xyz`);
        const resNegEvents = await fetch(`${baseUrl}/events?limit=-1&offset=-5`);
        const resNanSpark = await fetch(`${baseUrl}/analytics/sparkline?limit=abc`);
        const resNegSpark = await fetch(`${baseUrl}/analytics/sparkline?limit=-1`);

        // Assert
        expect(resNanEvents.status).toBe(400);
        expect(resNanSpark.status).toBe(400);
        expect(resNegEvents.status).toBe(200);
        expect(resNegSpark.status).toBe(200);

        const negEventsBody = (await resNegEvents.json()) as { limit: number; offset: number };
        expect(negEventsBody.limit).toBeGreaterThanOrEqual(1);
        expect(negEventsBody.offset).toBeGreaterThanOrEqual(0);
      } finally {
        if (prevPort === undefined) delete process.env.INDEXER_PORT;
        else process.env.INDEXER_PORT = prevPort;
        if (prevSecret === undefined) delete process.env.INDEXER_API_SECRET;
        else process.env.INDEXER_API_SECRET = prevSecret;
        server.stop(true);
        storage.close();
        cleanupTempDirs();
      }
    });

    it("attributes Zap-In swap PT position to user receiver rather than market_factory caller without double-counting", () => {
      // Arrange
      const storage = new EventStorage(createTempDbPath());
      const user = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      const factory = "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL";
      const usdcPool = MARKETS["usdc-90d"]!.poolId;
      const now = Math.floor(Date.now() / 1000);

      try {
        // Act
        storage.saveEvents([
          {
            id: "t5-zap-1",
            type: "zap_in",
            topicSymbol: "zap_in_event",
            contractId: factory,
            caller: user,
            receiver: user,
            ledger: 1001,
            ledgerClosedAt: new Date(now * 1000).toISOString(),
            timestamp: now,
            txHash: "tx-zap-1",
            data: { pool: usdcPool, mode: 0, underlyingAmount: "100000000", outAmount: "105000000" },
            rawJson: "{}",
          },
          {
            id: "t5-zap-swap-1",
            type: "swap",
            topicSymbol: "swap_event",
            contractId: usdcPool,
            caller: factory,
            receiver: user,
            ledger: 1001,
            ledgerClosedAt: new Date(now * 1000).toISOString(),
            timestamp: now,
            txHash: "tx-zap-1",
            data: { direction: 1, amountIn: "100000000", amountOut: "105000000", fee: "0" },
            rawJson: "{}",
          },
        ]);

        const userSummary = storage.getUserPositions(user);
        const factorySummary = storage.getUserPositions(factory);

        // Assert
        expect(userSummary.positions.length).toBe(1);
        expect(BigInt(userSummary.positions[0]!.currentPtBalance)).toBe(105_000_000n);
        expect(factorySummary.positions.length).toBe(0);
      } finally {
        storage.close();
        cleanupTempDirs();
      }
    });

    it("decodes rollover_py_executed_event under rollover type with pyMinted fields", async () => {
      // Arrange
      const { nativeToScVal, Address, xdr } = await import("@stellar/stellar-sdk");
      const user = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      const srcPool = MARKETS["usdc-matured"]!.poolId;
      const dstPool = MARKETS["usdc-90d"]!.poolId;
      const factory = "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL";

      // Act
      const decoded = decodeRpcEvent({
        id: "t5-rollover-py-1",
        contractId: factory,
        txHash: "tx-roll-py-1",
        ledger: 3001,
        ledgerClosedAt: new Date().toISOString(),
        topic: [
          nativeToScVal("rollover_py_executed_event", { type: "symbol" }),
          Address.fromString(user).toScVal(),
          Address.fromString(srcPool).toScVal(),
          Address.fromString(dstPool).toScVal(),
        ],
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("pt_burned"), val: nativeToScVal(500_000_000n, { type: "i128" }) }),
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("py_minted"), val: nativeToScVal(495_000_000n, { type: "i128" }) }),
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("sy_received"), val: nativeToScVal(500_000_000n, { type: "i128" }) }),
        ]),
      } as never);

      // Assert
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe("rollover");
      expect(decoded!.caller).toBe(user);
      expect(decoded!.receiver).toBe("");
      expect(decoded!.data.sourcePool).toBe(srcPool);
      expect(decoded!.data.targetPool).toBe(dstPool);
      expect(decoded!.data.ptBurned).toBe("500000000");
      expect(decoded!.data.syReceived).toBe("500000000");
      expect(decoded!.data.pyMinted).toBe("495000000");
    });

    it("preserves TVL continuity across EventStorage reopen and isolates shared sy-bUSDC DepositEvent/RedeemEvent", () => {
      // Arrange
      const dbPath = createTempDbPath();
      const now = Math.floor(Date.now() / 1000);
      const pool = MARKETS["usdc-90d"]!.poolId;
      const sharedSy = MARKETS["usdc-90d"]!.syId;
      const user = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

      const s1 = new EventStorage(dbPath);
      s1.saveEvents([
        {
          id: "t5-liq-1",
          type: "liquidity",
          topicSymbol: "liquidity_event",
          contractId: pool,
          caller: user,
          receiver: user,
          ledger: 2001,
          ledgerClosedAt: new Date((now - 3600) * 1000).toISOString(),
          timestamp: now - 3600,
          txHash: "tx-liq-1",
          data: { isAdd: true, ptAmount: "100000000000", syAmount: "100000000000", lpAmount: "100000000000" },
          rawJson: "{}",
        },
        {
          id: "t5-shared-sy-deposit",
          type: "deposit",
          topicSymbol: "deposit_event",
          contractId: sharedSy,
          caller: user,
          receiver: user,
          ledger: 2001,
          ledgerClosedAt: new Date((now - 3500) * 1000).toISOString(),
          timestamp: now - 3500,
          txHash: "tx-liq-1",
          data: { underlyingAmount: "50000000000", sharesMinted: "50000000000" },
          rawJson: "{}",
        },
      ]);
      expect(s1.getMarketChart("usdc-90d", "1D").summary.currentTvl).toBe("200000000000");
      s1.close();

      // Act
      const s2 = new EventStorage(dbPath);
      try {
        s2.saveEvents([
          {
            id: "t5-liq-2",
            type: "liquidity",
            topicSymbol: "liquidity_event",
            contractId: pool,
            caller: user,
            receiver: user,
            ledger: 2002,
            ledgerClosedAt: new Date(now * 1000).toISOString(),
            timestamp: now,
            txHash: "tx-liq-2",
            data: { isAdd: true, ptAmount: "10000000000", syAmount: "10000000000", lpAmount: "10000000000" },
            rawJson: "{}",
          },
        ]);

        const chart = s2.getMarketChart("usdc-90d", "1D");
        // Assert: 200B persisted across reopen + 20B added = 220B (and shared sy-bUSDC deposit did not inflate TVL)
        expect(BigInt(chart.summary.currentTvl)).toBe(220_000_000_000n);
      } finally {
        s2.close();
        cleanupTempDirs();
      }
    });

    it("sets PRAGMA busy_timeout >= 5000 before WAL and survives rapid reopen and concurrent child-process access without SQLITE_BUSY", async () => {
      const dbPath = createTempDbPath();
      const indexModulePath = join(import.meta.dir, "index.ts");
      const nowSec = Math.floor(Date.now() / 3600000) * 3600 + 1800;
      const poolId = MARKETS["usdc-90d"]!.poolId;
      const user = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

      const storage = new EventStorage(dbPath);
      try {
        const timeoutRow = (storage as unknown as { db: { query: (sql: string) => { get: () => unknown } } }).db
          .query("PRAGMA busy_timeout;")
          .get() as { timeout?: number } | null;
        const journalRow = (storage as unknown as { db: { query: (sql: string) => { get: () => unknown } } }).db
          .query("PRAGMA journal_mode;")
          .get() as { journal_mode?: string } | null;

        expect(timeoutRow?.timeout).toBeGreaterThanOrEqual(5000);
        expect(journalRow?.journal_mode?.toLowerCase()).toBe("wal");
      } finally {
        storage.close();
      }

      try {
        // Rapidly reopen and spawn concurrent child processes accessing the exact same WAL SQLite DB
        const childScript = `
          import { EventStorage } from ${JSON.stringify(indexModulePath)};
          const dbPath = process.env.TEST_DB_PATH!;
          const workerId = process.env.TEST_WORKER_ID!;
          const poolId = process.env.TEST_POOL_ID!;
          const user = process.env.TEST_USER!;
          const ts = Number(process.env.TEST_TS!);
          const s = new EventStorage(dbPath);
          try {
            const timeoutRow = s["db"].query("PRAGMA busy_timeout;").get();
            if (!timeoutRow || Number(timeoutRow.timeout) < 5000) {
              throw new Error("Expected busy_timeout >= 5000, got " + JSON.stringify(timeoutRow));
            }
            s.saveEvents([{
              id: "child-evt-" + workerId,
              type: "swap",
              topicSymbol: "swap_event",
              contractId: poolId,
              caller: user,
              receiver: user,
              ledger: 4000 + Number(workerId),
              ledgerClosedAt: new Date(ts * 1000).toISOString(),
              timestamp: ts,
              txHash: "tx-child-" + workerId,
              data: { direction: 1, amountIn: "10000000", amountOut: "10400000", fee: "100000" },
              rawJson: "{}",
            }]);
          } finally {
            s.close();
          }
        `;

        // Parent initializes, immediately closes, and spawns 4 parallel child processes racing startup + writes
        for (let round = 0; round < 2; round++) {
          const parent = new EventStorage(dbPath);
          parent.saveEvents([
            {
              id: `parent-evt-${round}`,
              type: "swap",
              topicSymbol: "swap_event",
              contractId: poolId,
              caller: user,
              receiver: user,
              ledger: 3900 + round,
              ledgerClosedAt: new Date(nowSec * 1000).toISOString(),
              timestamp: nowSec,
              txHash: `tx-parent-${round}`,
              data: { direction: 1, amountIn: "10000000", amountOut: "10400000", fee: "100000" },
              rawJson: "{}",
            },
          ]);
          parent.close();

          const procs = [0, 1, 2, 3].map((idx) => {
            const workerId = round * 4 + idx;
            return Bun.spawn(
              [process.execPath, "-e", childScript],
              {
                env: {
                  ...process.env,
                  TEST_DB_PATH: dbPath,
                  TEST_WORKER_ID: String(workerId),
                  TEST_POOL_ID: poolId,
                  TEST_USER: user,
                  TEST_TS: String(nowSec),
                },
                stdout: "pipe",
                stderr: "pipe",
              }
            );
          });

          const results = await Promise.all(
            procs.map(async (p) => {
              const code = await p.exited;
              const stderr = await new Response(p.stderr).text();
              return { code, stderr };
            })
          );

          for (const res of results) {
            expect(res.stderr).not.toContain("SQLITE_BUSY");
            expect(res.stderr).toBe("");
            expect(res.code).toBe(0);
          }
        }

        const verify = new EventStorage(dbPath);
        try {
          const stats = verify.getStats();
          expect(stats.totalEvents).toBe(10); // 2 parent + 8 child events
        } finally {
          verify.close();
        }
      } finally {
        cleanupTempDirs();
      }
    });

    it("binds ephemeral port 0 via startHttpServer override even when 8765 is occupied", async () => {
      // Arrange
      let blocker: ReturnType<typeof Bun.serve> | null = null;
      try {
        blocker = Bun.serve({ hostname: "0.0.0.0", port: 8765, fetch: () => new Response("ok") });
      } catch {
        // Port 8765 is already occupied externally, which equally exercises collision avoidance
        blocker = null;
      }
      const dbPath = createTempDbPath();
      const storage = new EventStorage(dbPath);
      const indexer = new PersistentIndexer(storage, "http://127.0.0.1:1");

      try {
        // Act
        const server = startHttpServer(storage, indexer, 0);
        try {
          // Assert
          expect(server.port).toBeGreaterThan(0);
          expect(server.port).not.toBe(8765);
          const healthRes = await fetch(`http://127.0.0.1:${server.port}/health`);
          expect(healthRes.status).toBe(200);
          const healthBody = (await healthRes.json()) as { status: string };
          expect(healthBody.status).toBe("healthy");
        } finally {
          server.stop(true);
        }
      } finally {
        storage.close();
        blocker?.stop(true);
        cleanupTempDirs();
      }
    });

    it("preserves mint_py-only and redeem_py market TVL across DB reopen even when another market already has snapshots", () => {
      // Arrange
      const dbPath = createTempDbPath();
      const now = Math.floor(Date.now() / 1000);
      const usdcPool = MARKETS["usdc-90d"]!.poolId;
      const xlmPool = MARKETS["xlm-90d"]!.poolId;
      const usdc30Pool = MARKETS["usdc-30d"]!.poolId;
      const user = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

      const s1 = new EventStorage(dbPath);
      s1.saveEvents([
        {
          id: "c3-usdc-liq-1",
          type: "liquidity",
          topicSymbol: "liquidity_event",
          contractId: usdcPool,
          caller: user,
          receiver: user,
          ledger: 5001,
          ledgerClosedAt: new Date((now - 3600) * 1000).toISOString(),
          timestamp: now - 3600,
          txHash: "tx-c3-1",
          data: { isAdd: true, ptAmount: "50000000", syAmount: "50000000", lpAmount: "50000000" },
          rawJson: "{}",
        },
        {
          id: "c3-xlm-mint-1",
          type: "mint_py",
          topicSymbol: "mint_py_event",
          contractId: xlmPool,
          caller: user,
          receiver: user,
          ledger: 5002,
          ledgerClosedAt: new Date((now - 1800) * 1000).toISOString(),
          timestamp: now - 1800,
          txHash: "tx-c3-2",
          data: { syIn: "200000000", pyOut: "200000000" },
          rawJson: "{}",
        },
        {
          id: "c3-u30-mint-1",
          type: "mint_py",
          topicSymbol: "mint_py_event",
          contractId: usdc30Pool,
          caller: user,
          receiver: user,
          ledger: 5003,
          ledgerClosedAt: new Date((now - 1700) * 1000).toISOString(),
          timestamp: now - 1700,
          txHash: "tx-c3-3",
          data: { syIn: "200000000", pyOut: "200000000" },
          rawJson: "{}",
        },
        {
          id: "c3-u30-redeem-1",
          type: "redeem_py",
          topicSymbol: "redeem_py_event",
          contractId: usdc30Pool,
          caller: user,
          receiver: user,
          ledger: 5004,
          ledgerClosedAt: new Date((now - 1600) * 1000).toISOString(),
          timestamp: now - 1600,
          txHash: "tx-c3-4",
          data: { pyBurned: "50000000", syOut: "50000000" },
          rawJson: "{}",
        },
      ]);
      s1.close();

      // Act
      const s2 = new EventStorage(dbPath);
      try {
        s2.saveEvents([
          {
            id: "c3-xlm-liq-1",
            type: "liquidity",
            topicSymbol: "liquidity_event",
            contractId: xlmPool,
            caller: user,
            receiver: user,
            ledger: 5005,
            ledgerClosedAt: new Date(now * 1000).toISOString(),
            timestamp: now,
            txHash: "tx-c3-5",
            data: { isAdd: true, ptAmount: "100000000", syAmount: "100000000", lpAmount: "100000000" },
            rawJson: "{}",
          },
          {
            id: "c3-u30-liq-1",
            type: "liquidity",
            topicSymbol: "liquidity_event",
            contractId: usdc30Pool,
            caller: user,
            receiver: user,
            ledger: 5006,
            ledgerClosedAt: new Date(now * 1000).toISOString(),
            timestamp: now,
            txHash: "tx-c3-6",
            data: { isAdd: true, ptAmount: "100000000", syAmount: "100000000", lpAmount: "100000000" },
            rawJson: "{}",
          },
        ]);

        // Assert
        expect(s2.getMarketChart("xlm-90d", "1D").summary.currentTvl).toBe("400000000");
        expect(s2.getMarketChart("usdc-30d", "1D").summary.currentTvl).toBe("350000000");
      } finally {
        s2.close();
        cleanupTempDirs();
      }
    });

    it("attributes cross-recipient G... -> G... swap, mint_py, and liquidity positions to receiver on acquisitions and caller on burns", () => {
      // Arrange
      const storage = new EventStorage(createTempDbPath());
      const userA = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
      const userB = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";
      const pool = MARKETS["usdc-90d"]!.poolId;
      const now = Math.floor(Date.now() / 1000);

      try {
        // Act: userA initiates token-acquiring operations for receiver userB
        storage.saveEvents([
          {
            id: "c4-swap-buy-pt",
            type: "swap",
            topicSymbol: "swap_event",
            contractId: pool,
            caller: userA,
            receiver: userB,
            ledger: 6001,
            ledgerClosedAt: new Date(now * 1000).toISOString(),
            timestamp: now,
            txHash: "tx-c4-1",
            data: { direction: 1, amountIn: "100000000", amountOut: "105000000", fee: "0" },
            rawJson: "{}",
          },
          {
            id: "c4-swap-buy-yt",
            type: "swap",
            topicSymbol: "swap_event",
            contractId: pool,
            caller: userA,
            receiver: userB,
            ledger: 6002,
            ledgerClosedAt: new Date((now + 1) * 1000).toISOString(),
            timestamp: now + 1,
            txHash: "tx-c4-2",
            data: { direction: 2, amountIn: "50000000", amountOut: "200000000", fee: "0" },
            rawJson: "{}",
          },
          {
            id: "c4-mint-py",
            type: "mint_py",
            topicSymbol: "mint_py_event",
            contractId: pool,
            caller: userA,
            receiver: userB,
            ledger: 6003,
            ledgerClosedAt: new Date((now + 2) * 1000).toISOString(),
            timestamp: now + 2,
            txHash: "tx-c4-3",
            data: { syIn: "100000000", pyOut: "100000000", spotPtPrice: 0.95 },
            rawJson: "{}",
          },
          {
            id: "c4-add-liq",
            type: "liquidity",
            topicSymbol: "liquidity_event",
            contractId: pool,
            caller: userA,
            receiver: userB,
            ledger: 6004,
            ledgerClosedAt: new Date((now + 3) * 1000).toISOString(),
            timestamp: now + 3,
            txHash: "tx-c4-4",
            data: { isAdd: true, ptAmount: "75000000", syAmount: "75000000", lpAmount: "75000000" },
            rawJson: "{}",
          },
        ]);

        // Assert acquisitions attributed strictly to userB (receiver)
        let posA = storage.getUserPositions(userA);
        let posB = storage.getUserPositions(userB);
        expect(posA.positions.length).toBe(0);
        expect(posB.positions.length).toBe(1);
        expect(posB.positions[0]!.currentPtBalance).toBe("205000000");
        expect(posB.positions[0]!.currentYtBalance).toBe("300000000");
        expect(posB.positions[0]!.currentLpBalance).toBe("75000000");

        // Act 2: userB sells/burns PT, YT, LP while routing proceeds to userA (receiver)
        storage.saveEvents([
          {
            id: "c4-swap-sell-pt",
            type: "swap",
            topicSymbol: "swap_event",
            contractId: pool,
            caller: userB,
            receiver: userA,
            ledger: 6005,
            ledgerClosedAt: new Date((now + 4) * 1000).toISOString(),
            timestamp: now + 4,
            txHash: "tx-c4-5",
            data: { direction: 0, amountIn: "5000000", amountOut: "4900000", fee: "0" },
            rawJson: "{}",
          },
          {
            id: "c4-swap-sell-yt",
            type: "swap",
            topicSymbol: "swap_event",
            contractId: pool,
            caller: userB,
            receiver: userA,
            ledger: 6006,
            ledgerClosedAt: new Date((now + 5) * 1000).toISOString(),
            timestamp: now + 5,
            txHash: "tx-c4-6",
            data: { direction: 3, amountIn: "10000000", amountOut: "1000000", fee: "0" },
            rawJson: "{}",
          },
          {
            id: "c4-rem-liq",
            type: "liquidity",
            topicSymbol: "liquidity_event",
            contractId: pool,
            caller: userB,
            receiver: userA,
            ledger: 6007,
            ledgerClosedAt: new Date((now + 6) * 1000).toISOString(),
            timestamp: now + 6,
            txHash: "tx-c4-7",
            data: { isAdd: false, ptAmount: "25000000", syAmount: "25000000", lpAmount: "25000000" },
            rawJson: "{}",
          },
        ]);

        // Assert burns attributed strictly to userB (caller) and userA remains untouched
        posA = storage.getUserPositions(userA);
        posB = storage.getUserPositions(userB);
        expect(posA.positions.length).toBe(0);
        expect(posB.positions[0]!.currentPtBalance).toBe("200000000");
        expect(posB.positions[0]!.currentYtBalance).toBe("290000000");
        expect(posB.positions[0]!.currentLpBalance).toBe("50000000");
      } finally {
        storage.close();
        cleanupTempDirs();
      }
    });
  });
});
