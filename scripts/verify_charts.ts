/**
 * Milestone 1: Automated Verification Script for Time-Series & OHLCV Chart Aggregation
 * Validates REST API /charts and /timeseries endpoints on the Soroban Event Indexer:
 * - Schema compliance ({ success, market, interval, count, data, summary })
 * - Interval bucketing: 1D (24 points), 1W (168 points), 1M (30 points), ALL (>= 30 points)
 * - Forward-filling validation (smooth APY curves, no cliffing to 0)
 * - Multi-market resolution (usdc-90d, usdc-30d, xlm-90d, contract address)
 * - Concurrent stress test (30 concurrent queries with zero SQLITE_BUSY locking errors)
 */

const BASE_URL = process.env.INDEXER_API_URL || "http://127.0.0.1:8765";

interface MarketChartPoint {
  timestamp: number;
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  impliedApy: number;
  underlyingApy: number;
  ptPrice: number;
  ytPrice: number;
  volume: string;
  tvl: string;
  tradeCount?: number;
}

interface MarketChartSummary {
  marketId: string;
  interval: string;
  highApy: number;
  lowApy: number;
  currentApy: number;
  highPrice: number;
  lowPrice: number;
  currentPrice: number;
  volumeTotal: string;
  currentTvl: string;
  tradesCount: number;
}

interface MarketChartsResponse {
  success: boolean;
  market: string;
  interval: string;
  count: number;
  data: MarketChartPoint[];
  summary: MarketChartSummary;
}

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`❌ Assertion Failed: ${msg}`);
    process.exit(1);
  }
}

async function fetchChart(market: string, interval: string, route: string = "/charts"): Promise<MarketChartsResponse> {
  const url = `${BASE_URL}${route}?market=${encodeURIComponent(market)}&interval=${encodeURIComponent(interval)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${await res.text()}`);
  }
  return (await res.json()) as MarketChartsResponse;
}

async function main() {
  console.log("==================================================================");
  console.log(`🔍 Verifying Soroban Event Indexer Charts at: ${BASE_URL}`);
  console.log("==================================================================");

  // 1. Health Check
  console.log("\n[Step 1] Checking Indexer /health endpoint...");
  const healthRes = await fetch(`${BASE_URL}/health`);
  assert(healthRes.ok, `/health failed with status ${healthRes.status}`);
  const health = await healthRes.json();
  console.log(`   ✓ Indexer status: ${health.status}, uptime: ${health.uptimeSeconds}s, totalEvents: ${health.totalEvents}`);
  assert(health.status === "healthy", "Indexer reports unhealthy status");

  // 2. Interval Bucketing Tests on Primary Market (usdc-90d)
  console.log("\n[Step 2] Testing intervals on market usdc-90d...");

  const intervals = [
    { name: "1D", expectedCount: 24 },
    { name: "1W", expectedCount: 168 },
    { name: "1M", expectedCount: 30 },
    { name: "ALL", minCount: 30 },
  ];

  for (const item of intervals) {
    const res = await fetchChart("usdc-90d", item.name);
    assert(res.success === true, `Expected success: true for ${item.name}`);
    assert(res.market === "usdc-90d", `Expected market: usdc-90d, got ${res.market}`);
    assert(res.interval === item.name, `Expected interval: ${item.name}, got ${res.interval}`);

    if (item.expectedCount) {
      assert(res.count === item.expectedCount, `Expected ${item.expectedCount} points for ${item.name}, got ${res.count}`);
      assert(res.data.length === item.expectedCount, `Expected data.length == ${item.expectedCount}`);
    } else if (item.minCount) {
      assert(res.count >= item.minCount, `Expected >= ${item.minCount} points for ALL, got ${res.count}`);
    }

    // Verify Point Structure and Forward-Filling
    for (let i = 0; i < res.data.length; i++) {
      const pt = res.data[i]!;
      assert(typeof pt.timestamp === "number" && pt.timestamp > 0, `Point ${i} has invalid timestamp`);
      assert(typeof pt.datetime === "string" && pt.datetime.length > 0, `Point ${i} has invalid datetime`);
      assert(pt.open > 0, `Point ${i} open price must be > 0`);
      assert(pt.close > 0, `Point ${i} close price must be > 0`);
      assert(pt.high >= pt.low, `Point ${i} high must be >= low`);
      assert(pt.impliedApy > 0, `Point ${i} impliedApy must be > 0 (forward-filled smooth curve)`);
      assert(pt.underlyingApy > 0, `Point ${i} underlyingApy must be > 0`);
      assert(typeof pt.volume === "string", `Point ${i} volume must be string`);
      assert(typeof pt.tvl === "string", `Point ${i} tvl must be string`);
    }

    // Verify Summary
    assert(res.summary.marketId === "usdc-90d", "Summary marketId mismatch");
    assert(res.summary.interval === item.name, "Summary interval mismatch");
    assert(res.summary.highApy >= res.summary.lowApy, "highApy must be >= lowApy");
    assert(res.summary.highPrice >= res.summary.lowPrice, "highPrice must be >= lowPrice");
    assert(res.summary.currentPrice > 0, "currentPrice must be > 0");
    assert(typeof res.summary.volumeTotal === "string", "volumeTotal must be string");
    assert(typeof res.summary.currentTvl === "string", "currentTvl must be string");

    console.log(`   ✓ Interval ${item.name}: ${res.count} points | Implied APY: ${res.summary.currentApy}% | Current Price: ${res.summary.currentPrice} | Volume: ${res.summary.volumeTotal} | TVL: ${res.summary.currentTvl}`);
  }

  // 3. Alternative Route (/timeseries) and Contract ID Parameter
  console.log("\n[Step 3] Testing /timeseries route and contract address lookup...");
  const poolContract = "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF";
  const timeseriesRes = await fetchChart(poolContract, "1D", "/timeseries");
  assert(timeseriesRes.success === true, "Expected success: true on /timeseries");
  assert(timeseriesRes.market === "usdc-90d", "Expected address to resolve to usdc-90d");
  assert(timeseriesRes.count === 24, "Expected 24 points on /timeseries");
  console.log(`   ✓ /timeseries resolved pool ${poolContract.slice(0, 10)}... -> ${timeseriesRes.market} (24 points)`);

  // 4. Multi-Market Verification
  console.log("\n[Step 4] Testing remaining markets (usdc-30d, xlm-90d)...");
  const m30 = await fetchChart("usdc-30d", "1D");
  assert(m30.success === true && m30.count === 24, "usdc-30d 1D failed");
  console.log(`   ✓ Market usdc-30d: 24 points | APY: ${m30.summary.currentApy}% | Price: ${m30.summary.currentPrice}`);

  const mXlm = await fetchChart("xlm-90d", "1D");
  assert(mXlm.success === true && mXlm.count === 24, "xlm-90d 1D failed");
  console.log(`   ✓ Market xlm-90d: 24 points | APY: ${mXlm.summary.currentApy}% | Price: ${mXlm.summary.currentPrice}`);

  // 5. Concurrency & Stress Verification
  console.log("\n[Step 5] Stress testing concurrent reads (30 parallel requests)...");
  const startTs = Date.now();
  const promises = [];
  for (let i = 0; i < 30; i++) {
    const market = i % 3 === 0 ? "usdc-90d" : i % 3 === 1 ? "usdc-30d" : "xlm-90d";
    const interval = i % 4 === 0 ? "1D" : i % 4 === 1 ? "1W" : i % 4 === 2 ? "1M" : "ALL";
    const route = i % 2 === 0 ? "/charts" : "/timeseries";
    promises.push(fetchChart(market, interval, route));
  }

  const results = await Promise.all(promises);
  const durationMs = Date.now() - startTs;
  assert(results.length === 30, "Expected 30 successful responses");
  for (const r of results) {
    assert(r.success === true, "Concurrent response failed");
  }
  console.log(`   ✓ 30 parallel requests completed in ${durationMs}ms (avg: ${(durationMs / 30).toFixed(1)}ms/req)`);
  console.log(`   ✓ 100% success rate, 0 SQLITE_BUSY locking errors!`);

  console.log("\n==================================================================");
  console.log("🎉 ALL MILESTONE 1 VERIFICATION TESTS PASSED SUCCESSFULLY!");
  console.log("==================================================================");
}

main().catch((err) => {
  console.error("FATAL ERROR during verification:", err);
  process.exit(1);
});
