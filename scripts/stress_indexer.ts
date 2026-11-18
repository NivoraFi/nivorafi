/**
 * Empirical Concurrency Benchmark for Windows Soroban Event Indexer
 * Tests HTTP latency, 200 OK rate, SQLite WAL contention, and p99 metrics.
 */

interface RequestMetric {
  endpoint: string;
  status: number;
  durationMs: number;
  ok: boolean;
  hasSqliteError: boolean;
  error?: string;
  bodySnippet?: string;
}

interface PhaseResult {
  name: string;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  sqliteErrorCount: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  successRate: number;
  allUnder100ms: boolean;
  metrics: RequestMetric[];
}

const TARGET_HOST = process.env.INDEXER_HOST || "127.0.0.1";
const TARGET_PORT = process.env.INDEXER_PORT || process.env.PORT || "8765";
const BASE_URL = `http://${TARGET_HOST}:${TARGET_PORT}`;

async function measureRequest(endpoint: string): Promise<RequestMetric> {
  const url = `${BASE_URL}${endpoint}`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const durationMs = performance.now() - start;
    const text = await res.text();
    const hasSqliteError =
      text.toLowerCase().includes("sqlite_busy") ||
      text.toLowerCase().includes("database is locked") ||
      text.toLowerCase().includes("busy");

    return {
      endpoint,
      status: res.status,
      durationMs,
      ok: res.ok && !hasSqliteError,
      hasSqliteError,
      bodySnippet: text.slice(0, 150),
    };
  } catch (err: any) {
    const durationMs = performance.now() - start;
    return {
      endpoint,
      status: 0,
      durationMs,
      ok: false,
      hasSqliteError: false,
      error: err.message || String(err),
    };
  }
}

function calculatePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function runPhase(name: string, endpoints: string[]): Promise<PhaseResult> {
  console.log(`\n==================================================`);
  console.log(`▶ Starting Phase: ${name} (${endpoints.length} concurrent requests)`);
  console.log(`==================================================`);

  const promises = endpoints.map((ep) => measureRequest(ep));
  const metrics = await Promise.all(promises);

  const durations = metrics.map((m) => m.durationMs).sort((a, b) => a - b);
  const successCount = metrics.filter((m) => m.ok && m.status === 200).length;
  const sqliteErrorCount = metrics.filter((m) => m.hasSqliteError).length;
  const failureCount = metrics.length - successCount;
  const sumMs = durations.reduce((acc, v) => acc + v, 0);

  const minMs = durations[0] || 0;
  const maxMs = durations[durations.length - 1] || 0;
  const avgMs = durations.length > 0 ? sumMs / durations.length : 0;
  const p50Ms = calculatePercentile(durations, 50);
  const p90Ms = calculatePercentile(durations, 90);
  const p95Ms = calculatePercentile(durations, 95);
  const p99Ms = calculatePercentile(durations, 99);
  const successRate = (successCount / metrics.length) * 100;
  const allUnder100ms = p99Ms < 100;

  console.log(`Results for ${name}:`);
  console.log(`  Total: ${metrics.length} | Success (200 OK): ${successCount} (${successRate.toFixed(1)}%) | Failures: ${failureCount}`);
  console.log(`  SQLite Lock Errors: ${sqliteErrorCount}`);
  console.log(`  Latency: min=${minMs.toFixed(2)}ms, avg=${avgMs.toFixed(2)}ms, p50=${p50Ms.toFixed(2)}ms, p90=${p90Ms.toFixed(2)}ms, p99=${p99Ms.toFixed(2)}ms, max=${maxMs.toFixed(2)}ms`);
  console.log(`  p99 < 100ms Gate: ${p99Ms < 100 ? "PASS" : "FAIL"} (${p99Ms.toFixed(2)}ms)`);

  if (failureCount > 0) {
    console.warn(`  ⚠️ Failed requests:`);
    for (const m of metrics.filter((m) => !m.ok)) {
      console.warn(`    [${m.endpoint}] Status: ${m.status}, Err: ${m.error || "Non-200 / SQLite error"}`);
    }
  }

  return {
    name,
    totalRequests: metrics.length,
    successCount,
    failureCount,
    sqliteErrorCount,
    minMs,
    maxMs,
    avgMs,
    p50Ms,
    p90Ms,
    p95Ms,
    p99Ms,
    successRate,
    allUnder100ms,
    metrics,
  };
}

async function main() {
  console.log(`Benchmarking Windows Indexer at ${BASE_URL}...`);

  // Baseline ping
  const baseline = await measureRequest("/health");
  if (!baseline.ok) {
    console.error(`FATAL: Base /health check failed: status=${baseline.status}, error=${baseline.error}`);
    process.exit(1);
  }
  console.log(`Baseline /health check: OK in ${baseline.durationMs.toFixed(2)}ms\n`);

  const results: PhaseResult[] = [];

  // Phase 1: Mandatory Requirement: 30 concurrent requests across /health and /events
  const phase1Endpoints: string[] = [];
  for (let i = 0; i < 15; i++) phase1Endpoints.push("/health");
  for (let i = 0; i < 15; i++) phase1Endpoints.push("/events?limit=20");
  results.push(await runPhase("Phase 1: 30 Concurrent Requests (/health + /events)", phase1Endpoints));

  // Phase 2: 50 Concurrent Requests (DISPATCH.md requirement)
  const phase2Endpoints: string[] = [];
  for (let i = 0; i < 25; i++) phase2Endpoints.push("/health");
  for (let i = 0; i < 25; i++) phase2Endpoints.push("/events?limit=50");
  results.push(await runPhase("Phase 2: 50 Concurrent Requests (/health + /events?limit=50)", phase2Endpoints));

  // Phase 3: Adversarial Mixed Concurrency (100 Concurrent Requests)
  const phase3Endpoints: string[] = [];
  for (let i = 0; i < 25; i++) phase3Endpoints.push("/health");
  for (let i = 0; i < 25; i++) phase3Endpoints.push("/events?limit=50");
  for (let i = 0; i < 25; i++) phase3Endpoints.push("/events?limit=20&type=fee");
  for (let i = 0; i < 25; i++) phase3Endpoints.push("/analytics/sparkline");
  results.push(await runPhase("Phase 3: 100 Concurrent Mixed Heavy Requests", phase3Endpoints));

  // Phase 4: Sustained Burst (3 x 30 concurrent waves with 500ms delay)
  console.log(`\n==================================================`);
  console.log(`▶ Starting Phase 4: Sustained Burst (3 waves of 30 concurrent requests)`);
  console.log(`==================================================`);
  const burstMetrics: RequestMetric[] = [];
  for (let wave = 1; wave <= 3; wave++) {
    const waveEndpoints: string[] = [];
    for (let i = 0; i < 15; i++) waveEndpoints.push("/health");
    for (let i = 0; i < 15; i++) waveEndpoints.push("/events?limit=20");
    const waveRes = await Promise.all(waveEndpoints.map((ep) => measureRequest(ep)));
    burstMetrics.push(...waveRes);
    await new Promise((r) => setTimeout(r, 500));
  }
  const burstDurations = burstMetrics.map((m) => m.durationMs).sort((a, b) => a - b);
  const burstSuccess = burstMetrics.filter((m) => m.ok && m.status === 200).length;
  const burstSqliteErr = burstMetrics.filter((m) => m.hasSqliteError).length;
  const p99Burst = calculatePercentile(burstDurations, 99);
  const avgBurst = burstDurations.reduce((a, b) => a + b, 0) / burstDurations.length;
  results.push({
    name: "Phase 4: Sustained Burst (90 requests total in 3 waves)",
    totalRequests: burstMetrics.length,
    successCount: burstSuccess,
    failureCount: burstMetrics.length - burstSuccess,
    sqliteErrorCount: burstSqliteErr,
    minMs: burstDurations[0] || 0,
    maxMs: burstDurations[burstDurations.length - 1] || 0,
    avgMs: avgBurst,
    p50Ms: calculatePercentile(burstDurations, 50),
    p90Ms: calculatePercentile(burstDurations, 90),
    p95Ms: calculatePercentile(burstDurations, 95),
    p99Ms: p99Burst,
    successRate: (burstSuccess / burstMetrics.length) * 100,
    allUnder100ms: p99Burst < 100,
    metrics: burstMetrics,
  });

  console.log(`\n==================================================`);
  console.log(`📊 SUMMARY OF EMPIRICAL CHALLENGE RESULTS`);
  console.log(`==================================================`);
  console.table(
    results.map((r) => ({
      Phase: r.name,
      Requests: r.totalRequests,
      "200 OK (%)": `${r.successRate.toFixed(1)}%`,
      "SQLITE_BUSY": r.sqliteErrorCount,
      "Avg (ms)": r.avgMs.toFixed(2),
      "p50 (ms)": r.p50Ms.toFixed(2),
      "p95 (ms)": r.p95Ms.toFixed(2),
      "p99 (ms)": r.p99Ms.toFixed(2),
      "Max (ms)": r.maxMs.toFixed(2),
      Verdict: r.successRate === 100 && r.sqliteErrorCount === 0 && r.p99Ms < 100 ? "CONFIRMED ✅" : "REJECTED ❌",
    }))
  );

  // Output JSON for programmatic parsing
  console.log("\n--- JSON_REPORT_BEGIN ---");
  console.log(JSON.stringify(results.map(({ metrics, ...rest }) => rest), null, 2));
  console.log("--- JSON_REPORT_END ---");
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
