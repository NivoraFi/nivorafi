// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import {
  deriveImpliedApyHistory,
  deriveTvlMetrics,
  deriveUserTransactionHistory,
  deriveVolumeMetrics,
  extractSwapApy,
  generateApySparkline,
  SparklinePoint,
} from "../analytics";
import { ProtocolEvent, SwapEventParsed } from "../indexer";

// Local mirror of SvgSparkline coordinate projection engine for headless testing
function computeSparklineCoordinates(
  data: Array<{ timestamp: number; value: number }>,
  width = 400,
  height = 96,
  paddingFraction = 0.12
) {
  if (!data || data.length === 0) {
    return { pathD: "", areaD: "", points: [], minVal: 0, maxVal: 0, avgVal: 0 };
  }

  if (data.length === 1) {
    const v = data[0].value;
    const y = height / 2;
    return {
      pathD: `M 0,${y.toFixed(2)} L ${width},${y.toFixed(2)}`,
      areaD: `M 0,${y.toFixed(2)} L ${width},${y.toFixed(2)} L ${width},${height} L 0,${height} Z`,
      points: [{ x: width / 2, y, val: v, timestamp: data[0].timestamp }],
      minVal: v,
      maxVal: v,
      avgVal: v,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const d of data) {
    if (d.value < min) min = d.value;
    if (d.value > max) max = d.value;
    sum += d.value;
  }
  const avg = sum / data.length;

  const diff = max - min;
  const range = diff > 1e-6 ? diff : 0.01;
  const bLow = min - range * paddingFraction;
  const bHigh = max + range * paddingFraction;
  const bRange = bHigh - bLow;

  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((d.value - bLow) / bRange) * height;
    return { x, y, val: d.value, timestamp: d.timestamp };
  });

  let dStr = `M ${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    dStr += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }

  const aStr = `${dStr} L ${width},${height} L 0,${height} Z`;

  return { pathD: dStr, areaD: aStr, points: pts, minVal: min, maxVal: max, avgVal: avg };
}

describe("Challenger M4.2 Adversarial Suite: Analytics Math & SvgSparkline", () => {
  const SECONDS_PER_YEAR = 31536000;

  // ==========================================================================
  // 1. Implied APY Math Boundaries & Stress Matrix
  // ==========================================================================
  describe("1. Implied APY Math Boundaries & Stress Matrix", () => {
    it("strictly returns 0.0% APY when at exact maturity (tau = 0)", () => {
      const maturity = 1000000;
      const res = extractSwapApy(1, 9500000n, 10000000n, 0n, maturity, maturity);
      expect(res.tauYears).toBe(0);
      expect(res.impliedApyPct).toBe(0.0);
    });

    it("strictly returns 0.0% APY when post-maturity (tau < 0)", () => {
      const maturity = 1000000;
      const res = extractSwapApy(1, 9500000n, 10000000n, 0n, maturity + 500, maturity);
      expect(res.tauYears).toBe(0);
      expect(res.impliedApyPct).toBe(0.0);
    });

    it("handles tau -> 0 (1 second remaining) via linear APR fallback without blow-up", () => {
      const now = 1000000;
      const maturity = now + 1; // 1 second to maturity
      const res = extractSwapApy(1, 9999900n, 10000000n, 0n, now, maturity);

      expect(res.tauYears).toBe(1 / SECONDS_PER_YEAR);
      expect(isFinite(res.impliedApyPct)).toBe(true);
      expect(isNaN(res.impliedApyPct)).toBe(false);
      expect(res.impliedApyPct).toBeGreaterThan(0);
      expect(res.impliedApyPct).toBeLessThanOrEqual(500.0);
    });

    it("tests transition across the 1-hour linear fallback boundary (tau = 3600s)", () => {
      const now = 1000000;
      // Exactly 3599s (< 1 hour -> linear fallback)
      const resLinear = extractSwapApy(1, 9900000n, 10000000n, 0n, now, now + 3599);
      // Exactly 3601s (> 1 hour -> compounded APY clamped to 500)
      const resCompounded = extractSwapApy(1, 9900000n, 10000000n, 0n, now, now + 3601);

      expect(isFinite(resLinear.impliedApyPct)).toBe(true);
      expect(isFinite(resCompounded.impliedApyPct)).toBe(true);
      expect(resLinear.impliedApyPct).toBeLessThanOrEqual(500.0);
      expect(resCompounded.impliedApyPct).toBeLessThanOrEqual(500.0);
    });

    it("clamps negative discounts (P_PT >= 1.0) strictly to 0.0% APY", () => {
      const now = 1000000;
      const maturity = now + 7776000;

      // Exactly par (P_PT = 1.0)
      const par = extractSwapApy(1, 10000000n, 10000000n, 0n, now, maturity);
      expect(par.ptPriceInSy).toBe(1.0);
      expect(par.impliedApyPct).toBe(0.0);

      // Above par / negative discount (P_PT = 1.05)
      const abovePar = extractSwapApy(1, 10500000n, 10000000n, 0n, now, maturity);
      expect(abovePar.ptPriceInSy).toBe(1.05);
      expect(abovePar.impliedApyPct).toBe(0.0);

      // Extreme inverted price (P_PT = 10.0)
      const extremeInversion = extractSwapApy(1, 100000000n, 10000000n, 0n, now, maturity);
      expect(extremeInversion.ptPriceInSy).toBe(10.0);
      expect(extremeInversion.impliedApyPct).toBe(0.0);
    });

    it("clamps massive slippage spikes to the 500% ceiling without numerical NaN or Infinity", () => {
      const now = 1000000;
      const maturity = now + 7776000;

      // P_PT = 0.01 (99% discount spike)
      const res1 = extractSwapApy(1, 100000n, 10000000n, 0n, now, maturity);
      expect(res1.impliedApyPct).toBe(500.0);

      // Direction 2: YT price spike > 1.0 (Flash buy YT slippage)
      // 150 SY in for 100 YT out -> P_YT = 1.5 -> P_PT clamped to 0.0001
      const resYtSpike = extractSwapApy(2, 150000000n, 100000000n, 0n, now, maturity);
      expect(resYtSpike.ptPriceInSy).toBe(0.0001);
      expect(resYtSpike.impliedApyPct).toBe(500.0);

      // Direction 3: YT sell where YT price is high
      const resYtSell = extractSwapApy(3, 100000000n, 150000000n, 0n, now, maturity);
      expect(resYtSell.ptPriceInSy).toBe(0.0001);
      expect(resYtSell.impliedApyPct).toBe(500.0);
    });

    it("fuzzes 1,000 pseudorandom swap math combinations to verify total numerical sanity", () => {
      const now = 1000000;
      for (let i = 0; i < 1000; i++) {
        const dir = i % 4;
        const inAmt = BigInt(Math.floor(Math.random() * 1e9) + 1);
        const outAmt = BigInt(Math.floor(Math.random() * 1e9) + 1);
        const fee = BigInt(Math.floor(Math.random() * 1e5));
        const remSecs = Math.floor(Math.random() * 31536000 * 2);

        const res = extractSwapApy(dir, inAmt, outAmt, fee, now, now + remSecs);

        expect(isFinite(res.ptPriceInSy)).toBe(true);
        expect(isNaN(res.ptPriceInSy)).toBe(false);
        expect(res.ptPriceInSy).toBeGreaterThan(0);

        expect(isFinite(res.impliedApyPct)).toBe(true);
        expect(isNaN(res.impliedApyPct)).toBe(false);
        expect(res.impliedApyPct).toBeGreaterThanOrEqual(0);
        expect(res.impliedApyPct).toBeLessThanOrEqual(500.0);
      }
    });
  });

  // ==========================================================================
  // 2. Rolling 24h Volume Boundary Conditions & Negative Volume Auditing
  // ==========================================================================
  describe("2. Rolling 24h Volume Boundary Conditions & Auditing", () => {
    it("handles empty event stream cleanly with all zero counters", () => {
      const res = deriveVolumeMetrics([]);
      expect(res.totalVolumeStroops).toBe(0n);
      expect(res.volume24hStroops).toBe(0n);
      expect(res.volumePrev24hStroops).toBe(0n);
      expect(res.change24hPct).toBe(0);
      expect(res.totalSwapCount).toBe(0);
      expect(res.totalMintCount).toBe(0);
      expect(res.uniqueTradersCount).toBe(0);
    });

    it("verifies exact temporal boundaries for 24h and prev24h windows", () => {
      const now = 1000000;
      const tAtNow = now; // currentTimestamp
      const tAt24hBoundary = now - 86400; // exact 24h boundary
      const tJustBefore24h = now - 86401; // 1s before 24h boundary (in prev24h)
      const tAt48hBoundary = now - 172800; // exact 48h boundary (start of prev24h)
      const tJustBefore48h = now - 172801; // older than 48h (excluded from 24h & prev24h)

      const makeSwap = (id: string, timestamp: number, amount: bigint): ProtocolEvent => ({
        id,
        contractId: "C1",
        txHash: `tx_${id}`,
        ledger: 100,
        ledgerClosedAt: "",
        timestamp,
        type: "swap",
        topicSymbol: "swap",
        caller: "G1",
        receiver: "G1",
        direction: 1,
        directionLabel: "SY_FOR_PT",
        amountIn: amount,
        amountOut: amount,
        fee: 0n,
      });

      const events: ProtocolEvent[] = [
        makeSwap("now", tAtNow, 100n),
        makeSwap("boundary24h", tAt24hBoundary, 200n),
        makeSwap("justBefore24h", tJustBefore24h, 300n),
        makeSwap("boundary48h", tAt48hBoundary, 400n),
        makeSwap("justBefore48h", tJustBefore48h, 500n),
      ];

      const metrics = deriveVolumeMetrics(events, now);

      // 24h window [now - 86400, now]: includes tAtNow (100) + tAt24hBoundary (200) = 300n
      expect(metrics.volume24hStroops).toBe(300n);

      // Prev 24h window [now - 172800, now - 86400): includes tJustBefore24h (300) + tAt48hBoundary (400) = 700n
      expect(metrics.volumePrev24hStroops).toBe(700n);

      // Total volume includes all 5 events: 100 + 200 + 300 + 400 + 500 = 1500n
      expect(metrics.totalVolumeStroops).toBe(1500n);

      // Change % = ((300 - 700) / 700) * 100 = -57.14%
      expect(metrics.change24hPct).toBe(-57.14);
    });

    it("audits negative volume input behavior: reveals lack of negative volume filter", () => {
      const now = 1000000;
      const negSwap: ProtocolEvent = {
        id: "neg1",
        contractId: "C1",
        txHash: "tx_neg",
        ledger: 100,
        ledgerClosedAt: "",
        timestamp: now - 100,
        type: "swap",
        topicSymbol: "swap",
        caller: "G1",
        receiver: "G1",
        direction: 1,
        directionLabel: "SY_FOR_PT",
        amountIn: -500n, // negative amount!
        amountOut: 100n,
        fee: 0n,
      };

      const metrics = deriveVolumeMetrics([negSwap], now);

      // EMPIRICAL FINDING: deriveVolumeMetrics does NOT reject negative volume!
      // It naively adds -500n to totalVolume and volume24h
      expect(metrics.volume24hStroops).toBe(-500n);
      expect(metrics.totalVolumeStroops).toBe(-500n);
      // This is a documented vulnerability / challenge finding.
    });
  });

  // ==========================================================================
  // 3. SVG Sparkline Coordinate Math & Projections
  // ==========================================================================
  describe("3. SVG Sparkline Coordinate Math & Projections", () => {
    it("handles empty data array without throwing and returns empty path", () => {
      const res = computeSparklineCoordinates([]);
      expect(res.pathD).toBe("");
      expect(res.areaD).toBe("");
      expect(res.points).toEqual([]);
      expect(res.minVal).toBe(0);
      expect(res.maxVal).toBe(0);
      expect(res.avgVal).toBe(0);
    });

    it("handles single data point gracefully with horizontal centered midline", () => {
      const data: SparklinePoint[] = [{ timestamp: 1000, value: 5.42 }];
      const res = computeSparklineCoordinates(data, 400, 96);

      expect(res.points.length).toBe(1);
      expect(res.points[0].x).toBe(200);
      expect(res.points[0].y).toBe(48); // height / 2
      expect(res.minVal).toBe(5.42);
      expect(res.maxVal).toBe(5.42);
      expect(res.avgVal).toBe(5.42);
      expect(res.pathD).toBe("M 0,48.00 L 400,48.00");
      expect(res.areaD).toBe("M 0,48.00 L 400,48.00 L 400,96 L 0,96 Z");
    });

    it("handles identical constant values (flat line) without division-by-zero or NaN", () => {
      const data: SparklinePoint[] = [
        { timestamp: 100, value: 12.5 },
        { timestamp: 200, value: 12.5 },
        { timestamp: 300, value: 12.5 },
      ];
      const res = computeSparklineCoordinates(data, 400, 96);

      expect(res.points.length).toBe(3);
      expect(res.pathD).not.toContain("NaN");
      expect(res.pathD).not.toContain("Infinity");
      expect(res.areaD).not.toContain("NaN");

      // All points should have y = 48 (center of height 96)
      for (const p of res.points) {
        expect(p.y).toBeCloseTo(48, 2);
      }
    });

    it("projects monotonic values into strictly descending Y coordinates (SVG top-down)", () => {
      const data: SparklinePoint[] = [
        { timestamp: 100, value: 2.0 },
        { timestamp: 200, value: 5.0 },
        { timestamp: 300, value: 10.0 },
      ];
      const res = computeSparklineCoordinates(data, 400, 96);

      expect(res.points[0].y).toBeGreaterThan(res.points[1].y);
      expect(res.points[1].y).toBeGreaterThan(res.points[2].y);
      expect(res.points[0].x).toBe(0);
      expect(res.points[2].x).toBe(400);
    });

    it("audits non-monotonic timestamps in SvgSparkline: demonstrates index-based projection", () => {
      const data: SparklinePoint[] = [
        { timestamp: 500, value: 10.0 },
        { timestamp: 100, value: 20.0 },
        { timestamp: 300, value: 15.0 },
      ];

      const res = computeSparklineCoordinates(data, 400, 96);

      // EMPIRICAL FINDING: SvgSparkline projects based on array index i, NOT timestamp!
      // Points[0] has x=0, timestamp=500
      // Points[1] has x=200, timestamp=100 (time reversed!)
      // Points[2] has x=400, timestamp=300
      expect(res.points[0].x).toBe(0);
      expect(res.points[0].timestamp).toBe(500);
      expect(res.points[1].x).toBe(200);
      expect(res.points[1].timestamp).toBe(100);
      expect(res.points[2].x).toBe(400);
      expect(res.points[2].timestamp).toBe(300);
      // Tooltip scrub on unsorted data will jump back and forth in time.
    });

    it("verifies two-point edge case generates valid cubic Catmull-Rom path", () => {
      const data: SparklinePoint[] = [
        { timestamp: 100, value: 4.0 },
        { timestamp: 200, value: 8.0 },
      ];
      const res = computeSparklineCoordinates(data, 400, 96);

      expect(res.points.length).toBe(2);
      expect(res.points[0].x).toBe(0);
      expect(res.points[1].x).toBe(400);
      expect(res.pathD).toStartWith("M 0.00,");
      expect(res.pathD).toContain(" C ");
      expect(res.pathD).not.toContain("NaN");
    });
  });

  // ==========================================================================
  // 4. Sparkline Generator Historical Fallback Auditing
  // ==========================================================================
  describe("4. Sparkline Time Series Generator (generateApySparkline)", () => {
    it("audits generateApySparkline fallback behavior on historical events outside 24h", () => {
      const now = 1000000;
      const maturity = now + 7776000;

      // Event 1: 30 days ago (t = now - 30 * 86400)
      // Event 2: 2 days ago (t = now - 2 * 86400)
      const events: ProtocolEvent[] = [
        {
          id: "1",
          contractId: "C1",
          txHash: "tx1",
          ledger: 10,
          ledgerClosedAt: "",
          timestamp: now - 30 * 86400,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: 9800000n, // ~2% APY
          amountOut: 10000000n,
          fee: 0n,
        },
        {
          id: "2",
          contractId: "C1",
          txHash: "tx2",
          ledger: 20,
          ledgerClosedAt: "",
          timestamp: now - 2 * 86400,
          type: "swap",
          topicSymbol: "swap",
          caller: "G1",
          receiver: "G1",
          direction: 1,
          directionLabel: "SY_FOR_PT",
          amountIn: 8500000n, // ~17% APY
          amountOut: 10000000n,
          fee: 0n,
        },
      ];

      const sparkline = generateApySparkline(events, maturity, 24, now);
      expect(sparkline.length).toBe(24);

      // EMPIRICAL FINDING: Because generateApySparkline uses apyPoints[0]
      // instead of the latest historical event prior to the 24h window,
      // it picks the 30-day-old event value instead of the 2-day-old event value!
      const oldestPointApy = deriveImpliedApyHistory(events, maturity)[0].impliedApyPct;
      expect(sparkline[0].value).toBe(oldestPointApy);
    });
  });
});
