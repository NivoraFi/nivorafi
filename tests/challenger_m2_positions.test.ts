/**
 * ============================================================================
 * EMPIRICAL CHALLENGER TEST SUITE: MILESTONE 2 USER POSITIONS & PNL ENGINE
 * ============================================================================
 *
 * Target: http://127.0.0.1:8765
 * Objective: Empirically stress-test GET /positions under rapid concurrency,
 * zero-state conditions, adversarial fuzzing, and SQLite locking invariance.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const INDEXER_URL = process.env.INDEXER_API_URL || "http://127.0.0.1:8765";
const ACTIVE_USER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

interface UserMarketPosition {
  marketId: string;
  marketAddress: string;
  assetCode: string;
  costBasisStroops: string;
  costBasisUsd: number;
  averageEntryApy: number;
  currentPtBalance: string;
  currentYtBalance: string;
  currentLpBalance: string;
  currentPositionValueUsd: number;
  realizedPnlStroops: string;
  realizedPnlUsd: number;
  unrealizedPnlStroops: string;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
  cumulativeClaimedYieldStroops: string;
  cumulativeClaimedYieldUsd: number;
  firstTradeTimestamp: number;
  lastActivityTimestamp: number;
  totalTradesCount: number;
}

interface UserPositionsSummary {
  userAddress: string;
  totalCostBasisUsd: number;
  totalCurrentValueUsd: number;
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  totalNetPnlUsd: number;
  totalClaimedYieldUsd: number;
  overallPortfolioApy: number;
  activePositionsCount: number;
  totalTransactionsCount: number;
}

interface UserPositionsResponse {
  success: boolean;
  user: string;
  count: number;
  positions: UserMarketPosition[];
  summary: UserPositionsSummary;
}

describe("Milestone 2 Empirical Challenge: GET /positions", () => {
  beforeAll(async () => {
    // 1. Verify remote indexer connectivity & health
    const res = await fetch(`${INDEXER_URL}/health`);
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(health.status).toBe("healthy");
    expect(health.isPolling).toBe(true);
    expect(health.totalEvents).toBeGreaterThan(0);
    expect(health.dbSizeBytes).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Dimension 1: Protected Core Files Integrity
  // --------------------------------------------------------------------------
  it("Dimension 1: Verifies SHA256 integrity of locked frontend indexer files", () => {
    const root = join(__dirname, "..");
    const indexerPath = join(root, "frontend/src/lib/indexer.ts");
    const hookPath = join(root, "frontend/src/hooks/useEventIndexer.ts");

    expect(existsSync(indexerPath)).toBe(true);
    expect(existsSync(hookPath)).toBe(true);

    const indexerHash = createHash("sha256").update(readFileSync(indexerPath)).digest("hex");
    const hookHash = createHash("sha256").update(readFileSync(hookPath)).digest("hex");

    expect(indexerHash).toBe("db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c");
    expect(hookHash).toBe("b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c");
  });

  // --------------------------------------------------------------------------
  // Dimension 2: Active User Position Tracking & DeFi Accounting
  // --------------------------------------------------------------------------
  it("Dimension 2: Correctly tracks active trader positions, PnL, and weighted APY", async () => {
    const res = await fetch(`${INDEXER_URL}/positions?user=${ACTIVE_USER}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const data: UserPositionsResponse = await res.json();
    expect(data.success).toBe(true);
    expect(data.user).toBe(ACTIVE_USER);
    expect(data.count).toBe(2);
    expect(Array.isArray(data.positions)).toBe(true);
    expect(data.positions.length).toBe(2);

    // Verify individual positions
    const marketIds = data.positions.map((p) => p.marketId).sort();
    expect(marketIds).toEqual(["usdc-30d", "usdc-90d"]);

    let expectedTotalCostUsd = 0;
    let expectedTotalCurrentValUsd = 0;
    let expectedTotalRealizedUsd = 0;
    let expectedTotalUnrealizedUsd = 0;
    let expectedTotalClaimedUsd = 0;
    let expectedTotalTxCount = 0;

    for (const pos of data.positions) {
      expect(["usdc-30d", "usdc-90d"]).toContain(pos.marketId);
      expect(pos.marketAddress.length).toBe(56);
      expect(pos.marketAddress.startsWith("C")).toBe(true);
      expect(pos.assetCode).toBe("USDC");

      // Balance parsing
      const ptBal = BigInt(pos.currentPtBalance);
      const ytBal = BigInt(pos.currentYtBalance);
      const lpBal = BigInt(pos.currentLpBalance);
      expect(ptBal).toBeGreaterThan(0n);
      expect(ytBal).toBeGreaterThan(0n);
      expect(lpBal).toBeGreaterThanOrEqual(0n);

      // Stroop string integers
      expect(typeof pos.costBasisStroops).toBe("string");
      expect(BigInt(pos.costBasisStroops)).toBeGreaterThan(0n);

      // Financial conversions & APY bounds
      expect(pos.costBasisUsd).toBeGreaterThan(0);
      expect(pos.currentPositionValueUsd).toBeGreaterThan(0);
      expect(pos.averageEntryApy).toBeGreaterThan(0);
      expect(pos.averageEntryApy).toBeLessThan(100); // Realistic APY range (<100%)
      expect(Number.isFinite(pos.averageEntryApy)).toBe(true);

      // PnL invariants
      expect(pos.netPnlUsd).toBe(Number((pos.realizedPnlUsd + pos.unrealizedPnlUsd).toFixed(2)));

      // Timestamps & activity
      expect(pos.firstTradeTimestamp).toBeGreaterThan(1700000000);
      expect(pos.lastActivityTimestamp).toBeGreaterThanOrEqual(pos.firstTradeTimestamp);
      expect(pos.totalTradesCount).toBeGreaterThanOrEqual(1);

      expectedTotalCostUsd += pos.costBasisUsd;
      expectedTotalCurrentValUsd += pos.currentPositionValueUsd;
      expectedTotalRealizedUsd += pos.realizedPnlUsd;
      expectedTotalUnrealizedUsd += pos.unrealizedPnlUsd;
      expectedTotalClaimedUsd += pos.cumulativeClaimedYieldUsd;
      expectedTotalTxCount += pos.totalTradesCount;
    }

    // Verify summary roll-up
    const summary = data.summary;
    expect(summary.userAddress).toBe(ACTIVE_USER);
    expect(summary.totalCostBasisUsd).toBe(Number(expectedTotalCostUsd.toFixed(2)));
    expect(summary.totalCurrentValueUsd).toBe(Number(expectedTotalCurrentValUsd.toFixed(2)));
    expect(summary.totalRealizedPnlUsd).toBe(Number(expectedTotalRealizedUsd.toFixed(2)));
    expect(summary.totalUnrealizedPnlUsd).toBe(Number(expectedTotalUnrealizedUsd.toFixed(2)));
    expect(summary.totalNetPnlUsd).toBe(Number((summary.totalRealizedPnlUsd + summary.totalUnrealizedPnlUsd).toFixed(2)));
    expect(summary.totalClaimedYieldUsd).toBe(Number(expectedTotalClaimedUsd.toFixed(2)));
    expect(summary.activePositionsCount).toBe(2);
    expect(summary.totalTransactionsCount).toBe(expectedTotalTxCount);
    expect(summary.overallPortfolioApy).toBeGreaterThan(0);
    expect(Number.isFinite(summary.overallPortfolioApy)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Dimension 3: Greenfield Empty Wallet Zero-State (Critical Requirement)
  // --------------------------------------------------------------------------
  it("Dimension 3: Querying empty wallet returns HTTP 200 with structured zero-state JSON (NEVER 404 or 500)", async () => {
    const emptyWallets = [
      "GNEWUSER7K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27NEWUSER1",
      "GDZERO11111111111111111111111111111111111111111111111111",
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF",
      "GEMPTYWALLETWITHOUTHISTORY1234567890ABCDEF1234567890ABCDEF",
      "GDFR3WNL43DYBVBH7X664DST2REG74MNVLBIVIOWMRFU6Q7R3PEND33X", // fee caller wallet without DeFi trade events
      "GAGVZMODPYFTULIVSY3RGFADIC5LF4LLSN37N4MFWGNZ57TYBXL2LQQX",
      "GBDCULE53LUPK4XHUCXBI35MAZFQHENMZ3JRKAJS2PPYBV646M6XKVHG",
      "GATTOG4PHWPVUUBTIAACY2RY24IVCTEMLSG4OTBCETFK4YXNEL2YSBYH",
      "GC4567890EMPTYWALLETTESTING1234567890TESTING12345678901234",
    ];

    for (const wallet of emptyWallets) {
      const res = await fetch(`${INDEXER_URL}/positions?user=${wallet}`);
      expect(res.status).toBe(200);

      const json: UserPositionsResponse = await res.json();
      expect(json.success).toBe(true);
      expect(json.user).toBe(wallet);
      expect(json.count).toBe(0);
      expect(Array.isArray(json.positions)).toBe(true);
      expect(json.positions.length).toBe(0);

      // Verify strict zero-state summary schema
      expect(json.summary).toEqual({
        userAddress: wallet,
        totalCostBasisUsd: 0,
        totalCurrentValueUsd: 0,
        totalRealizedPnlUsd: 0,
        totalUnrealizedPnlUsd: 0,
        totalNetPnlUsd: 0,
        totalClaimedYieldUsd: 0,
        overallPortfolioApy: 0,
        activePositionsCount: 0,
        totalTransactionsCount: 0,
      });
    }
  });

  // --------------------------------------------------------------------------
  // Dimension 4: Parameter Validation & Adversarial Fuzzing
  // --------------------------------------------------------------------------
  it("Dimension 4: Parameter validation rejects missing or empty parameters with 400 Bad Request", async () => {
    // Missing user parameter entirely
    const resNoParam = await fetch(`${INDEXER_URL}/positions`);
    expect(resNoParam.status).toBe(400);
    const jsonNoParam = await resNoParam.json();
    expect(jsonNoParam.success).toBe(false);
    expect(jsonNoParam.error).toContain("Missing required query parameter: user");

    // Empty user parameter
    const resEmptyParam = await fetch(`${INDEXER_URL}/positions?user=`);
    expect(resEmptyParam.status).toBe(400);
    const jsonEmptyParam = await resEmptyParam.json();
    expect(jsonEmptyParam.success).toBe(false);
  });

  it("Dimension 4b: Adversarial fuzzing inputs return graceful responses without crashing or 500", async () => {
    const fuzzInputs = [
      "not-a-valid-stellar-address",
      "123456789",
      "CCITOO7WPWXHNWQIF62CD7UEW6I3TKXCMPTW4BRTV4UCKBXXEZMZDSFD", // Contract ID instead of account
      "%20%20%20",
      "user with spaces in string",
      "G" + "A".repeat(2000), // Very long string
      "' OR '1'='1", // SQL injection attempt
      "'; DROP TABLE user_positions; --", // SQL injection drop attempt
      "' UNION SELECT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 --", // SQL injection union attempt
      "<script>alert(1)</script>", // XSS attempt
      "🚀💥👾💎🔥", // Unicode emojis in URL
      "\\x00\\x01\\x02", // Null bytes & control characters
      "../../etc/passwd", // Path traversal attempt
      "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27".toLowerCase(), // Lowercase address
      "null",
      "undefined",
      "NaN",
    ];

    for (const input of fuzzInputs) {
      const res = await fetch(`${INDEXER_URL}/positions?user=${encodeURIComponent(input)}`);
      // It must NEVER return 500 Internal Server Error
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.count).toBe(0);
      expect(json.positions.length).toBe(0);
      expect(json.summary.activePositionsCount).toBe(0);
    }
  });

  // --------------------------------------------------------------------------
  // Dimension 5: High-Concurrency Burst & SQLite Locking Stress
  // --------------------------------------------------------------------------
  it("Dimension 5: Handles 200 rapid concurrent queries without any SQLITE_BUSY or locking errors", async () => {
    const CONCURRENT_REQUESTS = 200;
    const testCases = [
      { url: `${INDEXER_URL}/positions?user=${ACTIVE_USER}`, expectedStatus: 200 },
      { url: `${INDEXER_URL}/positions?user=GNEWUSER7K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27NEWUSER1`, expectedStatus: 200 },
      { url: `${INDEXER_URL}/positions?user=GDZERO11111111111111111111111111111111111111111111111111`, expectedStatus: 200 },
      { url: `${INDEXER_URL}/positions`, expectedStatus: 400 },
      { url: `${INDEXER_URL}/positions?user=fuzz-address-concurrent`, expectedStatus: 200 },
      { url: `${INDEXER_URL}/positions?user=' OR '1'='1`, expectedStatus: 200 },
      { url: `${INDEXER_URL}/positions?user=`, expectedStatus: 400 },
      { url: `${INDEXER_URL}/positions?user=GATTOG4PHWPVUUBTIAACY2RY24IVCTEMLSG4OTBCETFK4YXNEL2YSBYH`, expectedStatus: 200 },
    ];

    const startTime = performance.now();
    const promises = Array.from({ length: CONCURRENT_REQUESTS }, async (_, idx) => {
      const tc = testCases[idx % testCases.length];
      const reqStart = performance.now();
      const res = await fetch(tc.url);
      const reqEnd = performance.now();
      const bodyText = await res.text();
      return {
        idx,
        url: tc.url,
        status: res.status,
        expectedStatus: tc.expectedStatus,
        durationMs: reqEnd - reqStart,
        bodyText,
      };
    });

    const results = await Promise.all(promises);
    const totalDurationMs = performance.now() - startTime;

    // Check every single request
    let failureCount = 0;
    let sqliteBusyCount = 0;
    const latencies: number[] = [];

    for (const r of results) {
      latencies.push(r.durationMs);
      if (r.status !== r.expectedStatus) {
        failureCount++;
      }
      if (
        r.bodyText.toLowerCase().includes("sqlite_busy") ||
        r.bodyText.toLowerCase().includes("database is locked") ||
        r.bodyText.toLowerCase().includes("busy")
      ) {
        sqliteBusyCount++;
      }
    }

    latencies.sort((a, b) => a - b);
    const minLatency = latencies[0];
    const maxLatency = latencies[latencies.length - 1];
    const medianLatency = latencies[Math.floor(latencies.length / 2)];
    const p95Latency = latencies[Math.floor(latencies.length * 0.95)];
    const p99Latency = latencies[Math.floor(latencies.length * 0.99)];
    const throughputRps = (CONCURRENT_REQUESTS / (totalDurationMs / 1000)).toFixed(1);

    console.log(`[CONCURRENCY STRESS RESULTS]`);
    console.log(`  Total Requests: ${CONCURRENT_REQUESTS}`);
    console.log(`  Total Time: ${totalDurationMs.toFixed(2)} ms`);
    console.log(`  Throughput: ${throughputRps} req/sec`);
    console.log(`  Min Latency: ${minLatency.toFixed(2)} ms`);
    console.log(`  Median Latency: ${medianLatency.toFixed(2)} ms`);
    console.log(`  P95 Latency: ${p95Latency.toFixed(2)} ms`);
    console.log(`  P99 Latency: ${p99Latency.toFixed(2)} ms`);
    console.log(`  Max Latency: ${maxLatency.toFixed(2)} ms`);
    console.log(`  Failures: ${failureCount}`);
    console.log(`  SQLITE_BUSY count: ${sqliteBusyCount}`);

    expect(failureCount).toBe(0);
    expect(sqliteBusyCount).toBe(0);
  });

  it("Dimension 5b: High-load burst of 500 parallel queries maintains zero locking errors", async () => {
    const BURST_COUNT = 500;
    const targets = [
      `${INDEXER_URL}/positions?user=${ACTIVE_USER}`,
      `${INDEXER_URL}/positions?user=GNEWUSER7K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27NEWUSER1`,
      `${INDEXER_URL}/positions?user=GDZERO11111111111111111111111111111111111111111111111111`,
      `${INDEXER_URL}/positions?user=fuzz-${Math.random()}`,
    ];

    const startTime = performance.now();
    const promises = Array.from({ length: BURST_COUNT }, async (_, i) => {
      const url = targets[i % targets.length];
      const res = await fetch(url);
      const text = await res.text();
      return {
        status: res.status,
        isLockError: text.toLowerCase().includes("sqlite_busy") || text.toLowerCase().includes("locked"),
      };
    });

    const results = await Promise.all(promises);
    const durationMs = performance.now() - startTime;

    const failed = results.filter((r) => r.status !== 200).length;
    const locked = results.filter((r) => r.isLockError).length;

    console.log(`[BURST 500 RESULTS]`);
    console.log(`  Requests: ${BURST_COUNT}`);
    console.log(`  Duration: ${durationMs.toFixed(2)} ms`);
    console.log(`  Throughput: ${(BURST_COUNT / (durationMs / 1000)).toFixed(1)} req/sec`);
    console.log(`  Failed (non-200): ${failed}`);
    console.log(`  Locked (SQLITE_BUSY): ${locked}`);

    expect(failed).toBe(0);
    expect(locked).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Dimension 6: Idempotency and State Invariance
  // --------------------------------------------------------------------------
  it("Dimension 6: Multiple reads are strictly idempotent and do not mutate database state", async () => {
    const res1 = await fetch(`${INDEXER_URL}/positions?user=${ACTIVE_USER}`);
    const data1 = await res1.json();

    // Query 20 times in sequence
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${INDEXER_URL}/positions?user=${ACTIVE_USER}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(data1.count);
      expect(data.summary.totalCostBasisUsd).toBe(data1.summary.totalCostBasisUsd);
      expect(data.summary.totalCurrentValueUsd).toBe(data1.summary.totalCurrentValueUsd);
      expect(data.summary.totalTransactionsCount).toBe(data1.summary.totalTransactionsCount);
      expect(data.positions[0].costBasisStroops).toBe(data1.positions[0].costBasisStroops);
      expect(data.positions[0].currentPtBalance).toBe(data1.positions[0].currentPtBalance);
    }
  });

  // --------------------------------------------------------------------------
  // Dimension 7: Database Integrity Verification Post-Stress
  // --------------------------------------------------------------------------
  it("Dimension 7: Verifies indexer database remains healthy and uncorrupted after adversarial stress", async () => {
    const res = await fetch(`${INDEXER_URL}/health`);
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(health.status).toBe("healthy");
    expect(health.lastError).toBeNull();
    expect(health.isPolling).toBe(true);

    // Verify positions still intact
    const posRes = await fetch(`${INDEXER_URL}/positions?user=${ACTIVE_USER}`);
    expect(posRes.status).toBe(200);
    const posData = await posRes.json();
    expect(posData.count).toBe(2);
  });
});
